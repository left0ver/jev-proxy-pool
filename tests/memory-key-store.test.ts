import { envKeys } from "./memory-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import app from "../index.js";
import { PoolError } from "../lib/key-pool.js";
import { MemoryKeyStore } from "../lib/memory-key-store.js";

const isPoolError = (status: number) => (error: unknown) => error instanceof PoolError && error.status === status;
const [first, second, third] = ["apikey_aa_01", "apikey_bb_02", "apikey_cc_03"];

function memoryStore(source: string) {
  const clock = { now: Date.now() };
  return { store: new MemoryKeyStore({ source, clock: () => clock.now }), clock };
}

test("环境变量支持换行、逗号和 JSONL，保留名称和停用状态", async () => {
  const jsonl = JSON.stringify({ key: third, name: "备用", enabled: false, disabledReason: "组织可用额度不足" });
  const { store } = memoryStore(`${first}, ${second}\n\n${jsonl}\n`);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.storage, "env");
  assert.deepEqual(snapshot.keys.map(({ key }) => key), [first, second, third]);
  assert.equal(snapshot.keys[2].name, "备用");
  assert.equal(snapshot.keys[2].status, "disabled");
  assert.equal(snapshot.maxRequestsPerSecond, 100);
  const { store: copy } = memoryStore(await store.export());
  assert.equal(await copy.export(), await store.export());
  for (const source of [`${first}\n${first}`, "not-a-key", "{"]) {
    await assert.rejects(memoryStore(source).store.snapshot(), isPoolError(500));
  }
  await assert.rejects(memoryStore("").store.acquire(), isPoolError(503));
});

test("添加、导入和删除返回 403，不修改 key 列表", async () => {
  const { store } = memoryStore(first);
  await assert.rejects(store.add([{ key: second }]), isPoolError(403));
  await assert.rejects(store.import(JSON.stringify({ key: second })), isPoolError(403));
  await assert.rejects(store.remove((await store.snapshot()).keys[0].id), isPoolError(403));
  assert.equal((await store.snapshot()).keys.length, 1);
});

test("轮换使用 key，每个 key 每秒 50 次，窗口结束后恢复", async () => {
  const { store, clock } = memoryStore(`${first}\n${second}`);
  const leases = [];
  for (let index = 0; index < 100; index += 1) leases.push(await store.acquire());
  assert.deepEqual(leases.slice(0, 4).map(({ key }) => key), [first, second, first, second]);
  assert.equal(leases.filter(({ key }) => key === first).length, 50);
  await assert.rejects(store.acquire(), (error: unknown) => isPoolError(429)(error) && Number((error as PoolError).retryAfterMs) > 0);
  assert.equal((await store.snapshot()).keys.reduce((sum, entry) => sum + entry.inFlight, 0), 100);
  await Promise.all(leases.map((lease) => lease.release()));
  await assert.rejects(leases[0].release(), /已经释放/);
  assert.equal((await store.snapshot()).keys.reduce((sum, entry) => sum + entry.inFlight, 0), 0);
  clock.now += 1000;
  await (await store.acquire()).release();
});

test("停用、检测和指数冷却只改变当前实例的状态", async () => {
  const { store, clock } = memoryStore(`${first}\n${second}`);
  const disabled = await store.acquire();
  await disabled.disable("API key 无效");
  await disabled.release();
  assert.equal((await store.snapshot()).available, 1);
  assert.equal((await new MemoryKeyStore({ source: `${first}\n${second}` }).snapshot()).available, 2);
  const check = await store.acquireForCheck(disabled.id);
  const result = { status: "valid" as const, message: "有效", checkedAt: new Date().toISOString(), upstreamStatus: 200 };
  await check.completeCheck(result);
  await check.release();
  const entry = (await store.snapshot()).keys[0];
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.lastCheck, result);
  await assert.rejects(store.acquireForCheck("missing"), isPoolError(404));
  for (const expected of [2, 4, 8]) {
    const lease = await store.acquireForCheck(disabled.id);
    await lease.coolDown();
    await lease.release();
    assert.equal((await store.snapshot()).keys[0].cooldownSeconds, expected);
    clock.now += expected * 1000;
  }
  const cooling = await store.acquireForCheck(disabled.id);
  await cooling.coolDown(80);
  await cooling.release();
  await assert.rejects(store.acquire(new Set([(await store.snapshot()).keys[1].id])), (error: unknown) => isPoolError(429)(error) && (error as PoolError).retryAfterMs === 80);
});

test("USE_REDIS=false 时管理接口读取环境变量中的 key", async () => {
  process.env.ADMIN_PASSWORD = randomBytes(24).toString("hex");
  const headers = { Authorization: `Basic ${Buffer.from(`admin:${process.env.ADMIN_PASSWORD}`).toString("base64")}`, "Content-Type": "application/json" };
  const snapshot = await (await app.request("/api/admin/keys", { headers })).json();
  assert.equal(snapshot.storage, "env");
  assert.deepEqual(snapshot.keys.map(({ key }: { key: string }) => key), envKeys);
  const create = await app.request("/api/admin/keys", { method: "POST", headers, body: JSON.stringify({ keys: [{ key: third }] }) });
  assert.equal(create.status, 403);
  assert.match((await create.json()).error, /TYPESAFE_API_KEYS/);
  assert.equal((await app.request(`/api/admin/keys/${snapshot.keys[0].id}`, { method: "DELETE", headers })).status, 403);
  assert.ok((await (await app.request("/api/admin/keys/export", { headers })).text()).includes(envKeys[1]));
});
