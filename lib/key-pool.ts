import { createHash } from "node:crypto";
import JSONLModule from "jsonl-parse-stringify";
import { z } from "zod";

export const RATE_LIMIT = 50;
export const WINDOW_MS = 1000;
export const MAX_KEYS = 10000;
export const JSONL = JSONLModule.default;

export const configSchema = z.object({
  key: z.string().trim().regex(/^apikey_[a-f0-9]+_[a-f0-9]+$/, "API key 格式不正确").max(512),
  name: z.string().trim().max(80).default(""),
  enabled: z.boolean().default(true),
  disabledReason: z.string().max(200).nullable().default(null),
  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
}).strict();

export type KeyConfig = z.infer<typeof configSchema>;
export type KeyCheckResult = {
  status: "valid" | "invalid" | "no_credits" | "rate_limited" | "unconfirmed";
  message: string;
  checkedAt: string;
  upstreamStatus: number | null;
};

export class PoolError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number) {
    super(message);
  }
}

export const keyId = (key: string) => createHash("sha256").update(key).digest("hex");

/** 一次请求占用的名额，结束后必须调用 release。 */
export type Lease = {
  id: string;
  key: string;
  release(): Promise<void>;
  succeed(): Promise<void>;
  disable(reason: string): Promise<void>;
  completeCheck(result: KeyCheckResult): Promise<void>;
  coolDown(delayMs?: number): Promise<void>;
};

export type KeyEntry = {
  id: string;
  config: KeyConfig;
  lastCheck: KeyCheckResult | null;
  cooldownUntil: number;
  recentRequests: number;
  inFlight: number;
};

/** redis：保存在 Redis，多个实例共用；env：来自环境变量，状态只在当前实例内存中。 */
export type Storage = "redis" | "env";

/** 代理接口各状态码的响应次数，since 为第一次记录的时间。 */
export type RequestCounts = { byStatus: Record<string, number>; since: string | null };

// 调用趋势按小时分桶保存 13 周，管理页面按浏览器时区汇总成小时、天和周。
export const HOUR_MS = 3600000;
export const HISTORY_HOURS = 13 * 7 * 24;

/** hour 为这个小时开始的毫秒时间戳，没有请求的小时不返回。 */
export type RequestBucket = { hour: number; byStatus: Record<string, number> };

export function summarizeRequests({ byStatus, since }: RequestCounts) {
  let total = 0;
  let success = 0;
  for (const [status, count] of Object.entries(byStatus)) {
    total += count;
    if (status.startsWith("2")) success += count;
  }
  return { total, success, error: total - success, byStatus, since };
}

export function summarize(storage: Storage, now: number, entries: KeyEntry[], requests: RequestCounts) {
  const keys = entries.map(({ id, config, lastCheck, cooldownUntil, recentRequests, inFlight }) => {
    const cooling = cooldownUntil > now;
    const status = !config.enabled ? "disabled" : cooling ? "cooldown" : recentRequests >= RATE_LIMIT ? "busy" : "available";
    return { ...config, id, status, recentRequests, inFlight, cooldownSeconds: Math.max(0, Math.ceil((cooldownUntil - now) / 1000)), lastCheck };
  });
  const available = keys.filter(({ enabled, status }) => enabled && status !== "cooldown").length;
  return { storage, keys, rateLimit: RATE_LIMIT, available, maxRequestsPerSecond: available * RATE_LIMIT, requests: summarizeRequests(requests) };
}

export type Snapshot = ReturnType<typeof summarize>;

export const exportConfigs = (configs: KeyConfig[]) => configs.length ? `${JSONL.stringify(configs)}\n` : "";

export interface KeyPool {
  add(input: unknown): Promise<number>;
  import(document: string): Promise<number>;
  export(): Promise<string>;
  remove(id: string): Promise<void>;
  /** 删除多个 key，不存在的 id 跳过，返回实际删除的数量。 */
  removeMany(ids: string[]): Promise<number>;
  snapshot(): Promise<Snapshot>;
  acquire(excluded?: Set<string>): Promise<Lease>;
  acquireForCheck(id: string): Promise<Lease>;
  /** 记录一次代理接口的响应状态码。 */
  recordRequest(status: number): Promise<void>;
  /** 最近 hours 个小时（含当前小时）的请求统计，按时间顺序排列。 */
  requestHistory(hours: number): Promise<RequestBucket[]>;
}
