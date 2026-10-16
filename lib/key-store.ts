import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import {
  configSchema,
  exportConfigs,
  JSONL,
  keyId,
  MAX_KEYS,
  PoolError,
  RATE_LIMIT,
  summarize,
  WINDOW_MS,
  type KeyCheckResult,
  type KeyPool,
  type Lease,
} from "./key-pool.js";
import { MemoryKeyStore } from "./memory-key-store.js";

export { PoolError, RATE_LIMIT, type KeyCheckResult, type KeyConfig, type KeyPool, type Lease } from "./key-pool.js";

// 进行中请求的租约有效期，长于单次代理请求的 30 秒期限；实例中途退出时租约到期自动失效。
// 请求计数也按这个时间过期，只用于回收不再使用的 key，窗口外的记录在每次选择时清除。
const LEASE_TTL_MS = 60000;

/*
 * Redis 数据布局（p 为前缀）：
 *   p.ids      zset  按添加顺序排列的 key id
 *   p.cfg      hash  id → KeyConfig JSON
 *   p.check    hash  id → 最近一次检测结果 JSON
 *   p.cool     hash  id → 冷却结束时间（毫秒）
 *   p.fails    hash  id → 连续限流次数
 *   p.cursor   string 轮换位置
 *   p.rl:<id>  zset  最近一秒的请求开始时间，删除 key 后仍保留到过期，重新添加时继续遵守上限
 *   p.fly:<id> zset  进行中请求的租约 → 到期时间
 */

// 计算 key 的可用时间并占用名额，由选择 key 的两个脚本共用。
const LEASE_LUA = `
local p, now, limit, window, ttl, token = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), ARGV[6]
local function available_at(id)
  local at = tonumber(redis.call('HGET', p .. 'cool', id) or '0')
  local rl = p .. 'rl:' .. id
  redis.call('ZREMRANGEBYSCORE', rl, '-inf', now - window)
  if redis.call('ZCARD', rl) >= limit then
    at = math.max(at, tonumber(redis.call('ZRANGE', rl, 0, 0, 'WITHSCORES')[2]) + window)
  end
  return at
end
local function reserve(id, cfg)
  local rl, fly = p .. 'rl:' .. id, p .. 'fly:' .. id
  redis.call('ZADD', rl, now, token)
  redis.call('PEXPIRE', rl, ttl)
  redis.call('ZADD', fly, now + ttl, token)
  redis.call('PEXPIRE', fly, ttl)
  return { 'ok', id, cfg }
end
`;

const ACQUIRE_LUA = `${LEASE_LUA}
local excluded = {}
for i = 7, #ARGV do excluded[ARGV[i]] = true end
local ids = redis.call('ZRANGE', p .. 'ids', 0, -1)
local n = #ids
local cursor = tonumber(redis.call('GET', p .. 'cursor') or '0')
local retry = -1
for offset = 0, n - 1 do
  local index = (cursor + offset) % n
  local id = ids[index + 1]
  local cfg = redis.call('HGET', p .. 'cfg', id)
  if cjson.decode(cfg).enabled then
    local at = available_at(id)
    if at > now then
      if retry < 0 or at - now < retry then retry = at - now end
    elseif not excluded[id] then
      redis.call('SET', p .. 'cursor', (index + 1) % n)
      return reserve(id, cfg)
    end
  end
end
if retry >= 0 then return { 'wait', tostring(retry) } end
return { 'none' }
`;

const ACQUIRE_FOR_CHECK_LUA = `${LEASE_LUA}
local id = ARGV[7]
local cfg = redis.call('HGET', p .. 'cfg', id)
if not cfg then return { 'missing' } end
local at = available_at(id)
if at > now then return { 'wait', tostring(at - now) } end
return reserve(id, cfg)
`;

const ADD_LUA = `
local p, max = ARGV[1], tonumber(ARGV[2])
for i = 3, #ARGV, 2 do
  if redis.call('HEXISTS', p .. 'cfg', ARGV[i]) == 1 then return -1 end
end
local count = (#ARGV - 2) / 2
if redis.call('ZCARD', p .. 'ids') + count > max then return -2 end
for i = 3, #ARGV, 2 do
  redis.call('ZADD', p .. 'ids', redis.call('INCR', p .. 'seq'), ARGV[i])
  redis.call('HSET', p .. 'cfg', ARGV[i], ARGV[i + 1])
end
return count
`;

const REMOVE_LUA = `
local p, id = ARGV[1], ARGV[2]
local rank = redis.call('ZRANK', p .. 'ids', id)
if not rank then return 0 end
redis.call('ZREM', p .. 'ids', id)
redis.call('HDEL', p .. 'cfg', id)
redis.call('HDEL', p .. 'check', id)
redis.call('HDEL', p .. 'cool', id)
redis.call('HDEL', p .. 'fails', id)
local n = redis.call('ZCARD', p .. 'ids')
local cursor = tonumber(redis.call('GET', p .. 'cursor') or '0')
if rank < cursor then cursor = cursor - 1 end
redis.call('SET', p .. 'cursor', cursor % math.max(n, 1))
return 1
`;

const SNAPSHOT_LUA = `
local p, now, window = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local out = {}
for _, id in ipairs(redis.call('ZRANGE', p .. 'ids', 0, -1)) do
  out[#out + 1] = id
  out[#out + 1] = redis.call('HGET', p .. 'cfg', id)
  out[#out + 1] = redis.call('HGET', p .. 'check', id) or ''
  out[#out + 1] = redis.call('HGET', p .. 'cool', id) or '0'
  out[#out + 1] = tostring(redis.call('ZCOUNT', p .. 'rl:' .. id, '(' .. (now - window), '+inf'))
  out[#out + 1] = tostring(redis.call('ZCOUNT', p .. 'fly:' .. id, '(' .. now, '+inf'))
end
return out
`;

// 租约结束后更新 key 状态；key 已被删除时不做任何修改。
const UPDATE_LUA = `
local p, id, mode = ARGV[1], ARGV[2], ARGV[3]
local raw = redis.call('HGET', p .. 'cfg', id)
if not raw then return 0 end
local cfg = cjson.decode(raw)
if mode == 'disable' then
  cfg.enabled = false
  cfg.disabledReason = ARGV[4]
elseif mode == 'check' then
  redis.call('HSET', p .. 'check', id, ARGV[4])
  if ARGV[5] == 'valid' then
    cfg.enabled = true
    cfg.disabledReason = cjson.null
    redis.call('HDEL', p .. 'fails', id)
  elseif ARGV[5] == 'invalid' or ARGV[5] == 'no_credits' then
    cfg.enabled = false
    cfg.disabledReason = ARGV[6]
  else
    return 1
  end
elseif mode == 'cool' then
  local now, delay = tonumber(ARGV[4]), tonumber(ARGV[5])
  local fails = redis.call('HINCRBY', p .. 'fails', id, 1)
  if delay < 0 then delay = math.min(60000, 2000 * 2 ^ math.min(fails - 1, 5)) end
  local current = tonumber(redis.call('HGET', p .. 'cool', id) or '0')
  redis.call('HSET', p .. 'cool', id, tostring(math.max(current, math.ceil(now + math.max(1, delay)))))
  return 1
end
redis.call('HSET', p .. 'cfg', id, cjson.encode(cfg))
return 1
`;

type LeaseReply = ["ok", string, string] | ["wait", string] | ["none"] | ["missing"];

export type KeyStoreOptions = {
  /** Redis key 前缀，多个项目或测试共用同一个数据库时用来隔离数据。 */
  prefix?: string;
  redis?: Redis;
  /** 毫秒时间戳，所有实例需要使用同一时间基准。 */
  clock?: () => number;
};

export class KeyStore implements KeyPool {
  private readonly prefix: string;
  private readonly clock: () => number;
  private client?: Redis;
  private scripts?: ReturnType<KeyStore["createScripts"]>;

  constructor(options: KeyStoreOptions = {}) {
    this.prefix = options.prefix ?? (process.env.REDIS_KEY_PREFIX || "jev:");
    this.clock = options.clock ?? Date.now;
    this.client = options.redis;
  }

  /** 首次访问时才读取环境变量，未配置 Redis 时仍然可以加载模块。 */
  get redis() {
    this.client ??= Redis.fromEnv({ automaticDeserialization: false });
    return this.client;
  }

  private createScripts() {
    return {
      acquire: this.redis.createScript<LeaseReply>(ACQUIRE_LUA),
      acquireForCheck: this.redis.createScript<LeaseReply>(ACQUIRE_FOR_CHECK_LUA),
      add: this.redis.createScript<number>(ADD_LUA),
      remove: this.redis.createScript<number>(REMOVE_LUA),
      snapshot: this.redis.createScript<string[], true>(SNAPSHOT_LUA, { readonly: true }),
      update: this.redis.createScript<number>(UPDATE_LUA),
    };
  }

  private get script() {
    this.scripts ??= this.createScripts();
    return this.scripts;
  }

  async add(input: unknown) {
    const parsed = z.array(configSchema).min(1).max(MAX_KEYS).safeParse(input);
    if (!parsed.success) throw new PoolError("Key 配置格式不正确，请检查 key、名称和状态字段", 400);
    const ids = new Set<string>();
    const args = [this.prefix, String(MAX_KEYS)];
    for (const entry of parsed.data) {
      const id = keyId(entry.key);
      if (ids.has(id)) throw new PoolError("存在重复 key，本次添加未保存", 409);
      ids.add(id);
      args.push(id, JSON.stringify(entry));
    }
    const added = await this.script.add.exec([], args);
    if (added === -1) throw new PoolError("存在重复 key，本次添加未保存", 409);
    if (added === -2) throw new PoolError("最多保存 10,000 个 key", 400);
    return added;
  }

  async import(document: string) {
    let entries: unknown;
    try {
      entries = JSONL.parse(document);
    } catch (error) {
      if (error instanceof SyntaxError) throw new PoolError("JSONL 文件包含无效 JSON", 400);
      throw error;
    }
    return this.add(entries);
  }

  async export() {
    const { entries } = await this.read();
    return exportConfigs(entries.map(({ config }) => config));
  }

  async remove(id: string) {
    if (!await this.script.remove.exec([], [this.prefix, id])) throw new PoolError("找不到这个 key", 404);
  }

  private async read() {
    const now = this.clock();
    const reply = await this.script.snapshot.evalRo([], [this.prefix, String(now), String(WINDOW_MS)]);
    const entries = [];
    for (let index = 0; index < reply.length; index += 6) {
      const [id, config, check, cooldownUntil, recentRequests, inFlight] = reply.slice(index, index + 6);
      entries.push({
        id,
        config: configSchema.parse(JSON.parse(config)),
        lastCheck: check ? JSON.parse(check) as KeyCheckResult : null,
        cooldownUntil: Number(cooldownUntil),
        recentRequests: Number(recentRequests),
        inFlight: Number(inFlight),
      });
    }
    return { now, entries };
  }

  async snapshot() {
    const { now, entries } = await this.read();
    return summarize("redis", now, entries);
  }

  private leaseArgs(token: string) {
    return [this.prefix, String(this.clock()), String(RATE_LIMIT), String(WINDOW_MS), String(LEASE_TTL_MS), token];
  }

  async acquire(excluded: Set<string> = new Set()) {
    const token = randomUUID();
    const reply = await this.script.acquire.exec([], [...this.leaseArgs(token), ...excluded]);
    if (reply[0] === "ok") return this.lease(reply[1], reply[2], token);
    if (reply[0] === "wait") throw new PoolError("可用 key 已达到请求上限或正在冷却", 429, Math.ceil(Number(reply[1])));
    throw new PoolError("没有可用 key，请在管理页面添加或导入", 503);
  }

  async acquireForCheck(id: string) {
    const token = randomUUID();
    const reply = await this.script.acquireForCheck.exec([], [...this.leaseArgs(token), id]);
    if (reply[0] === "ok") return this.lease(reply[1], reply[2], token);
    if (reply[0] === "wait") throw new PoolError("这个 key 已达到请求上限或正在冷却，请稍后检测", 429, Math.ceil(Number(reply[1])));
    throw new PoolError("找不到这个 key", 404);
  }

  private lease(id: string, config: string, token: string): Lease {
    // 检测与代理请求共用计数，脚本在返回 key 之前已经占用名额。
    const update = (...args: string[]) => this.script.update.exec([], [this.prefix, id, ...args]);
    let released = false;
    return {
      id,
      key: configSchema.parse(JSON.parse(config)).key,
      release: async () => {
        if (released) throw new Error("请求名额已经释放");
        released = true;
        await this.redis.zrem(`${this.prefix}fly:${id}`, token);
      },
      succeed: async () => { await this.redis.hdel(`${this.prefix}fails`, id); },
      disable: async (reason: string) => { await update("disable", reason); },
      completeCheck: async (result: KeyCheckResult) => { await update("check", JSON.stringify(result), result.status, result.message); },
      coolDown: async (delayMs?: number) => { await update("cool", String(this.clock()), String(delayMs ?? -1)); },
    };
  }
}

/** USE_REDIS=false 时改为从环境变量 TYPESAFE_API_KEYS 读取 key，默认使用 Redis。 */
function useRedis() {
  const value = (process.env.USE_REDIS ?? "").trim().toLowerCase();
  if (value === "" || value === "true") return true;
  if (value === "false") return false;
  throw new Error("USE_REDIS 只能是 true 或 false");
}

export const keyStore: KeyPool = useRedis() ? new KeyStore() : new MemoryKeyStore();
