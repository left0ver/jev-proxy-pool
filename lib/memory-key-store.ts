import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  configSchema,
  exportConfigs,
  keyId,
  MAX_KEYS,
  PoolError,
  RATE_LIMIT,
  summarize,
  WINDOW_MS,
  type KeyCheckResult,
  type KeyConfig,
  type KeyPool,
  type Lease,
} from "./key-pool.js";

export const KEYS_ENV = "TYPESAFE_API_KEYS";

type KeyState = {
  config: KeyConfig;
  lastCheck: KeyCheckResult | null;
  cooldownUntil: number;
  fails: number;
  /** 最近一秒的请求开始时间。 */
  requests: number[];
  inFlight: Set<string>;
};

/**
 * 每行一个 key，也可以用逗号或空格分隔；以 { 开头的行按导出的 JSONL 格式读取，保留名称和停用状态。
 */
export function parseKeys(source: string) {
  const entries: unknown[] = [];
  for (const line of source.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith("{")) {
      try {
        entries.push(JSON.parse(text));
      } catch {
        throw new PoolError(`${KEYS_ENV} 包含无效 JSON`, 500);
      }
    } else {
      entries.push(...text.split(/[\s,]+/).filter(Boolean).map((key) => ({ key })));
    }
  }
  const parsed = z.array(configSchema).max(MAX_KEYS).safeParse(entries);
  if (!parsed.success) throw new PoolError(`${KEYS_ENV} 格式不正确，请检查 key、名称和状态字段`, 500);
  const states = new Map<string, KeyState>();
  for (const config of parsed.data) {
    const id = keyId(config.key);
    if (states.has(id)) throw new PoolError(`${KEYS_ENV} 存在重复 key`, 500);
    states.set(id, { config, lastCheck: null, cooldownUntil: 0, fails: 0, requests: [], inFlight: new Set() });
  }
  return states;
}

export type MemoryKeyStoreOptions = {
  /** key 列表，默认读取环境变量 TYPESAFE_API_KEYS。 */
  source?: string;
  clock?: () => number;
};

/**
 * 不使用 Redis 时的 key 池：key 列表来自环境变量，所有实例相同；
 * 请求计数、冷却、停用和检测结果只保存在当前实例内存中，重新部署或实例回收后恢复为环境变量中的配置。
 */
export class MemoryKeyStore implements KeyPool {
  private readonly source?: string;
  private readonly clock: () => number;
  private states?: Map<string, KeyState>;
  private cursor = 0;

  constructor(options: MemoryKeyStoreOptions = {}) {
    this.source = options.source;
    this.clock = options.clock ?? Date.now;
  }

  /** 首次使用时才解析，配置有误时由请求返回错误，而不是让模块加载失败。 */
  private get pool() {
    this.states ??= parseKeys(this.source ?? process.env[KEYS_ENV] ?? "");
    return this.states;
  }

  private readOnly(): never {
    throw new PoolError(`key 由环境变量 ${KEYS_ENV} 配置，请修改环境变量后重新部署`, 403);
  }

  async add(_input: unknown): Promise<number> {
    return this.readOnly();
  }

  async import(_document: string): Promise<number> {
    return this.readOnly();
  }

  async remove(_id: string): Promise<void> {
    return this.readOnly();
  }

  private entries(now: number) {
    return [...this.pool].map(([id, state]) => ({
      id,
      config: state.config,
      lastCheck: state.lastCheck,
      cooldownUntil: state.cooldownUntil,
      recentRequests: state.requests.filter((at) => at > now - WINDOW_MS).length,
      inFlight: state.inFlight.size,
    }));
  }

  async export() {
    return exportConfigs(this.entries(this.clock()).map(({ config }) => config));
  }

  async snapshot() {
    const now = this.clock();
    return summarize("env", now, this.entries(now));
  }

  private availableAt(state: KeyState, now: number) {
    state.requests = state.requests.filter((at) => at > now - WINDOW_MS);
    if (state.requests.length < RATE_LIMIT) return state.cooldownUntil;
    return Math.max(state.cooldownUntil, Math.min(...state.requests) + WINDOW_MS);
  }

  async acquire(excluded: Set<string> = new Set()) {
    const now = this.clock();
    const ids = [...this.pool.keys()];
    let retry = -1;
    for (let offset = 0; offset < ids.length; offset += 1) {
      const index = (this.cursor + offset) % ids.length;
      const state = this.pool.get(ids[index])!;
      if (!state.config.enabled) continue;
      const at = this.availableAt(state, now);
      if (at > now) {
        if (retry < 0 || at - now < retry) retry = at - now;
      } else if (!excluded.has(ids[index])) {
        this.cursor = (index + 1) % ids.length;
        return this.reserve(ids[index], state, now);
      }
    }
    if (retry >= 0) throw new PoolError("可用 key 已达到请求上限或正在冷却", 429, Math.ceil(retry));
    throw new PoolError(`没有可用 key，请在环境变量 ${KEYS_ENV} 中配置`, 503);
  }

  async acquireForCheck(id: string) {
    const state = this.pool.get(id);
    if (!state) throw new PoolError("找不到这个 key", 404);
    const now = this.clock();
    const at = this.availableAt(state, now);
    if (at > now) throw new PoolError("这个 key 已达到请求上限或正在冷却，请稍后检测", 429, Math.ceil(at - now));
    return this.reserve(id, state, now);
  }

  private reserve(id: string, state: KeyState, now: number): Lease {
    // 检测与代理请求共用计数，返回 key 之前已经占用名额。
    const token = randomUUID();
    state.requests.push(now);
    state.inFlight.add(token);
    let released = false;
    return {
      id,
      key: state.config.key,
      release: async () => {
        if (released) throw new Error("请求名额已经释放");
        released = true;
        state.inFlight.delete(token);
      },
      succeed: async () => { state.fails = 0; },
      disable: async (reason) => { state.config = { ...state.config, enabled: false, disabledReason: reason }; },
      completeCheck: async (result) => {
        state.lastCheck = result;
        if (result.status === "valid") {
          state.config = { ...state.config, enabled: true, disabledReason: null };
          state.fails = 0;
        } else if (result.status === "invalid" || result.status === "no_credits") {
          state.config = { ...state.config, enabled: false, disabledReason: result.message };
        }
      },
      coolDown: async (delayMs) => {
        state.fails += 1;
        const delay = delayMs === undefined || delayMs < 0 ? Math.min(60000, 2000 * 2 ** Math.min(state.fails - 1, 5)) : delayMs;
        state.cooldownUntil = Math.max(state.cooldownUntil, Math.ceil(this.clock() + Math.max(1, delay)));
      },
    };
  }
}
