import assert from "node:assert/strict";
import test from "node:test";
import { KeyStore, PoolError } from "../lib/key-store.js";
import { keys, testStore } from "./helpers.js";

const isPoolError = (status: number) => (error: unknown) => error instanceof PoolError && error.status === status;

test("JSONL 导入导出完整保留配置，重复与无效输入不会部分写入", async () => {
  const { store } = testStore();
  await store.add([{ key: keys[0], name: "额度不足", enabled: false, disabledReason: "组织可用额度不足" }, { key: keys[1], name: "可用" }]);
  const { store: copy } = testStore();
  assert.equal(await copy.import(await store.export()), 2);
  assert.equal(await copy.export(), await store.export());
  assert.equal((await copy.snapshot()).maxRequestsPerSecond, 50);
  const before = await copy.export();
  await assert.rejects(copy.add([{ key: keys[1] }]), isPoolError(409));
  await assert.rejects(copy.add([{ key: keys[0] }, { key: keys[0] }]), isPoolError(409));
  await assert.rejects(copy.import(`${before}{`), isPoolError(400));
  assert.equal(await copy.export(), before);
});

test("两个 key 合计接收 100 次，单个 key 接收 50 次，窗口结束后恢复", async () => {
  const { store, clock } = testStore();
  await store.add(keys.slice(0, 2).map((key) => ({ key })));
  const first = [];
  for (let index = 0; index < 4; index += 1) first.push(await store.acquire());
  assert.deepEqual(first.map(({ key }) => key), [keys[0], keys[1], keys[0], keys[1]]);
  const leases = [...first, ...await Promise.all(Array.from({ length: 96 }, () => store.acquire()))];
  assert.equal(leases.filter(({ key }) => key === keys[0]).length, 50);
  assert.equal(leases.filter(({ key }) => key === keys[1]).length, 50);
  await assert.rejects(store.acquire(), (error: unknown) => isPoolError(429)(error) && Number((error as PoolError).retryAfterMs) > 0);
  assert.equal((await store.snapshot()).keys.reduce((sum, entry) => sum + entry.inFlight, 0), 100);
  await Promise.all(leases.map((lease) => lease.release()));
  assert.equal((await store.snapshot()).keys.reduce((sum, entry) => sum + entry.inFlight, 0), 0);
  await assert.rejects(store.acquire(), PoolError);
  clock.now += 1000;
  await (await store.acquire()).release();
});

test("多个实例共用同一份 key 列表和请求上限", async () => {
  const { store, clock, prefix } = testStore();
  const other = new KeyStore({ prefix, clock: () => clock.now });
  await store.add(keys.slice(0, 2).map((key) => ({ key })));
  assert.equal((await other.snapshot()).keys.length, 2);
  const results = await Promise.allSettled(Array.from({ length: 120 }, (_, index) => (index % 2 ? store : other).acquire()));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 100);
  assert.ok(results.every((result) => result.status === "fulfilled" || isPoolError(429)(result.reason)));
  assert.equal((await store.snapshot()).keys.reduce((sum, entry) => sum + entry.recentRequests, 0), 100);
  await other.remove((await other.snapshot()).keys[0].id);
  assert.equal((await store.snapshot()).keys.length, 1);
});

test("请求时间窗口跨越整秒时仍然按照连续一秒限制", async () => {
  const { store, clock } = testStore();
  await store.add([{ key: keys[1] }]);
  const burst = async () => Promise.all(Array.from({ length: 25 }, async () => (await store.acquire()).release()));
  clock.now = Math.ceil(clock.now / 1000) * 1000 + 20;
  await burst();
  clock.now += 550;
  await burst();
  await assert.rejects(store.acquire(), PoolError);
  clock.now += 500;
  await burst();
  await assert.rejects(store.acquire(), PoolError);
});

test("删除后重新添加同一个 key 保留当前一秒计数", async () => {
  const { store } = testStore();
  await store.add([{ key: keys[1] }]);
  await Promise.all(Array.from({ length: 50 }, async () => (await store.acquire()).release()));
  await store.remove((await store.snapshot()).keys[0].id);
  await assert.rejects(store.remove("missing"), isPoolError(404));
  await store.add([{ key: keys[1] }]);
  await assert.rejects(store.acquire(), isPoolError(429));
});

test("指定 key 的检测共用请求上限，停用后仍然允许检测", async () => {
  const { store } = testStore();
  await store.add(keys.slice(0, 2).map((key) => ({ key })));
  const id = (await store.snapshot()).keys[1].id;
  const lease = await store.acquireForCheck(id);
  assert.equal(lease.key, keys[1]);
  assert.equal((await store.snapshot()).keys[0].recentRequests, 0);
  await lease.disable("组织可用额度不足");
  await lease.release();
  await assert.rejects(lease.release(), /已经释放/);
  await Promise.all(Array.from({ length: 49 }, async () => (await store.acquireForCheck(id)).release()));
  await assert.rejects(store.acquireForCheck(id), isPoolError(429));
  await assert.rejects(store.acquireForCheck("missing"), isPoolError(404));
  const entry = (await store.snapshot()).keys[1];
  assert.equal(entry.inFlight, 0);
  assert.equal(entry.enabled, false);
  assert.equal(entry.disabledReason, "组织可用额度不足");
});

test("检测结果更新停用状态和最近检测记录", async () => {
  const { store } = testStore();
  await store.add([{ key: keys[0], enabled: false, disabledReason: "API key 无效" }]);
  const id = (await store.snapshot()).keys[0].id;
  const result = { status: "valid" as const, message: "有效", checkedAt: new Date().toISOString(), upstreamStatus: 200 };
  const lease = await store.acquireForCheck(id);
  await lease.completeCheck(result);
  await lease.release();
  const entry = (await store.snapshot()).keys[0];
  assert.equal(entry.enabled, true);
  assert.equal(entry.disabledReason, null);
  assert.deepEqual(entry.lastCheck, result);
  const removed = await store.acquireForCheck(id);
  await store.remove(id);
  await removed.completeCheck({ ...result, status: "invalid" });
  await removed.release();
  assert.equal((await store.snapshot()).keys.length, 0);
});

test("停用和冷却会影响选择与容量，已经尝试的冷却 key 仍然返回等待时间", async () => {
  const { store, clock } = testStore();
  await store.add(keys.slice(0, 2).map((key) => ({ key })));
  const first = await store.acquire();
  await first.disable("组织可用额度不足");
  await first.release();
  assert.equal((await store.snapshot()).available, 1);
  const second = await store.acquire();
  await second.coolDown(80);
  await second.release();
  assert.equal((await store.snapshot()).maxRequestsPerSecond, 0);
  await assert.rejects(store.acquire(new Set([first.id, second.id])), (error: unknown) => isPoolError(429)(error) && (error as PoolError).retryAfterMs === 80);
  clock.now += 90;
  const recovered = await store.acquire();
  assert.equal(recovered.key, keys[1]);
  await recovered.release();
});

test("连续限流时冷却时间按指数增长，成功后重置", async () => {
  const { store, clock } = testStore();
  await store.add([{ key: keys[0] }]);
  const id = (await store.snapshot()).keys[0].id;
  for (const expected of [2, 4, 8]) {
    const lease = await store.acquireForCheck(id);
    await lease.coolDown();
    await lease.release();
    assert.equal((await store.snapshot()).keys[0].cooldownSeconds, expected);
    clock.now += expected * 1000;
  }
  const lease = await store.acquire();
  await lease.succeed();
  await lease.coolDown();
  await lease.release();
  assert.equal((await store.snapshot()).keys[0].cooldownSeconds, 2);
});
