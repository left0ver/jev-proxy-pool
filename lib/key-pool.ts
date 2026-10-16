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

export function summarize(storage: Storage, now: number, entries: KeyEntry[]) {
  const keys = entries.map(({ id, config, lastCheck, cooldownUntil, recentRequests, inFlight }) => {
    const cooling = cooldownUntil > now;
    const status = !config.enabled ? "disabled" : cooling ? "cooldown" : recentRequests >= RATE_LIMIT ? "busy" : "available";
    return { ...config, id, status, recentRequests, inFlight, cooldownSeconds: Math.max(0, Math.ceil((cooldownUntil - now) / 1000)), lastCheck };
  });
  const available = keys.filter(({ enabled, status }) => enabled && status !== "cooldown").length;
  return { storage, keys, rateLimit: RATE_LIMIT, available, maxRequestsPerSecond: available * RATE_LIMIT };
}

export type Snapshot = ReturnType<typeof summarize>;

export const exportConfigs = (configs: KeyConfig[]) => configs.length ? `${JSONL.stringify(configs)}\n` : "";

export interface KeyPool {
  add(input: unknown): Promise<number>;
  import(document: string): Promise<number>;
  export(): Promise<string>;
  remove(id: string): Promise<void>;
  snapshot(): Promise<Snapshot>;
  acquire(excluded?: Set<string>): Promise<Lease>;
  acquireForCheck(id: string): Promise<Lease>;
}
