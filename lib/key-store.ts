import { createHash, randomUUID } from "node:crypto";
import JSONLModule from "jsonl-parse-stringify";
import { z } from "zod";

export const RATE_LIMIT = 50;
const WINDOW_MS = 1000;
const JSONL = JSONLModule.default;

const configSchema = z.object({
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
type RuntimeState = { starts: number[]; inFlight: number; cooldownUntil: number; rateLimits: number; lastCheck: KeyCheckResult | null };

export class PoolError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number) {
    super(message);
  }
}

export class KeyStore {
  readonly instanceId = randomUUID();
  private document = "";
  private entries: KeyConfig[] = [];
  private states = new Map<string, RuntimeState>();
  private cursor = 0;

  private id(key: string) {
    return createHash("sha256").update(key).digest("hex");
  }

  private save(entries: KeyConfig[]) {
    this.document = JSONL.stringify(entries);
    this.entries = entries;
    this.cursor %= Math.max(entries.length, 1);
  }

  private state(key: string, now = performance.now()) {
    const id = this.id(key);
    let state = this.states.get(id);
    if (!state) {
      state = { starts: [], inFlight: 0, cooldownUntil: 0, rateLimits: 0, lastCheck: null };
      this.states.set(id, state);
    }
    const cutoff = now - WINDOW_MS;
    while (state.starts.length && state.starts[0] <= cutoff) state.starts.shift();
    return state;
  }

  add(input: unknown) {
    const parsed = z.array(configSchema).min(1).max(10000).safeParse(input);
    if (!parsed.success) throw new PoolError("Key 配置格式不正确，请检查 key、名称和状态字段", 400);
    const existing = new Set(this.entries.map(({ key }) => key));
    for (const entry of parsed.data) {
      if (existing.has(entry.key)) throw new PoolError("存在重复 key，本次添加未保存", 409);
      existing.add(entry.key);
    }
    if (this.entries.length + parsed.data.length > 10000) throw new PoolError("最多保存 10,000 个 key", 400);
    this.save([...this.entries, ...parsed.data]);
    return parsed.data.length;
  }

  import(document: string) {
    let entries: unknown;
    try {
      entries = JSONL.parse(document);
    } catch (error) {
      if (error instanceof SyntaxError) throw new PoolError("JSONL 文件包含无效 JSON", 400);
      throw error;
    }
    return this.add(entries);
  }

  export() {
    return this.document ? `${this.document}\n` : "";
  }

  remove(id: string) {
    const index = this.entries.findIndex(({ key }) => this.id(key) === id);
    if (index < 0) throw new PoolError("找不到这个 key", 404);
    if (index < this.cursor) this.cursor -= 1;
    this.save(this.entries.filter((_, position) => position !== index));
    // 保留最近一秒的计数，立即重新添加同一 key 时仍然遵守请求限制。
    this.collectStates();
  }

  private collectStates() {
    const current = new Set(this.entries.map(({ key }) => this.id(key)));
    const cutoff = performance.now() - WINDOW_MS;
    for (const [id, state] of this.states) {
      if (!current.has(id) && state.inFlight === 0 && (state.starts.at(-1) ?? 0) <= cutoff) this.states.delete(id);
    }
  }

  snapshot() {
    this.collectStates();
    const now = performance.now();
    const keys = this.entries.map((entry) => {
      const state = this.state(entry.key, now);
      const cooling = state.cooldownUntil > now;
      const status = !entry.enabled ? "disabled" : cooling ? "cooldown" : state.starts.length >= RATE_LIMIT ? "busy" : "available";
      return { ...entry, id: this.id(entry.key), status, recentRequests: state.starts.length, inFlight: state.inFlight, cooldownSeconds: Math.max(0, Math.ceil((state.cooldownUntil - now) / 1000)), lastCheck: state.lastCheck };
    });
    const available = keys.filter(({ enabled, status }) => enabled && status !== "cooldown").length;
    return { instanceId: this.instanceId, keys, rateLimit: RATE_LIMIT, available, maxRequestsPerSecond: available * RATE_LIMIT };
  }

  acquire(excluded: Set<string> = new Set()) {
    let retryAfterMs = Infinity;
    const now = performance.now();
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const index = (this.cursor + offset) % this.entries.length;
      const entry = this.entries[index];
      const id = this.id(entry.key);
      if (!entry.enabled) continue;
      const state = this.state(entry.key, now);
      const availableAt = Math.max(state.cooldownUntil, state.starts.length >= RATE_LIMIT ? state.starts[0] + WINDOW_MS : 0);
      if (availableAt > now) {
        retryAfterMs = Math.min(retryAfterMs, availableAt - now);
        continue;
      }
      if (excluded.has(id)) continue;
      this.cursor = (index + 1) % this.entries.length;
      return this.reserve(entry, state, now);
    }
    if (Number.isFinite(retryAfterMs)) throw new PoolError("可用 key 已达到请求上限或正在冷却", 429, Math.ceil(retryAfterMs));
    throw new PoolError("没有可用 key，请在管理页面添加或导入", 503);
  }

  acquireForCheck(id: string) {
    const entry = this.entries.find((candidate) => this.id(candidate.key) === id);
    if (!entry) throw new PoolError("找不到这个 key", 404);
    const now = performance.now();
    const state = this.state(entry.key, now);
    const availableAt = Math.max(state.cooldownUntil, state.starts.length >= RATE_LIMIT ? state.starts[0] + WINDOW_MS : 0);
    if (availableAt > now) throw new PoolError("这个 key 已达到请求上限或正在冷却，请稍后检测", 429, Math.ceil(availableAt - now));
    return this.reserve(entry, state, now);
  }

  private reserve(entry: KeyConfig, state: RuntimeState, now: number) {
    // 检测与代理请求共用计数，发起上游请求前同步占用名额。
    state.starts.push(now);
    state.inFlight += 1;
    let released = false;
    return {
      id: this.id(entry.key),
      key: entry.key,
      release: () => {
        if (released) throw new Error("请求名额已经释放");
        released = true;
        state.inFlight -= 1;
      },
      succeed: () => { state.rateLimits = 0; },
      disable: (reason: string) => {
        if (!this.entries.includes(entry)) return;
        entry.enabled = false;
        entry.disabledReason = reason;
        this.save(this.entries);
      },
      completeCheck: (result: KeyCheckResult) => {
        if (!this.entries.includes(entry)) return;
        state.lastCheck = result;
        if (result.status === "valid") {
          entry.enabled = true;
          entry.disabledReason = null;
          state.rateLimits = 0;
          this.save(this.entries);
        } else if (result.status === "invalid" || result.status === "no_credits") {
          entry.enabled = false;
          entry.disabledReason = result.message;
          this.save(this.entries);
        }
      },
      coolDown: (delayMs?: number) => {
        state.rateLimits += 1;
        const delay = delayMs ?? Math.min(60000, 2000 * 2 ** Math.min(state.rateLimits - 1, 5));
        state.cooldownUntil = Math.max(state.cooldownUntil, performance.now() + Math.max(1, delay));
      },
    };
  }
}

export const keyStore = new KeyStore();
