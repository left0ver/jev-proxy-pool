import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { KeyStore, PoolError } from "../lib/key-store.js";
import { keys } from "./helpers.js";

test("JSONL 导入导出完整保留配置，重复与无效输入不会部分写入", () => {
  const store = new KeyStore();
  store.add([{ key: keys[0], name: "额度不足", enabled: false, disabledReason: "组织可用额度不足" }, { key: keys[1], name: "可用" }]);
  const copy = new KeyStore();
  assert.equal(copy.import(store.export()), 2);
  assert.equal(copy.export(), store.export());
  assert.equal(copy.snapshot().maxRequestsPerSecond, 50);
  const before = copy.export();
  assert.throws(() => copy.add([{ key: keys[1] }]), (error: unknown) => error instanceof PoolError && error.status === 409);
  assert.throws(() => copy.import(`${before}{`), (error: unknown) => error instanceof PoolError && error.status === 400);
  assert.equal(copy.export(), before);
});

test("两个 key 合计接收 100 次，单个 key 接收 50 次，窗口结束后恢复", async () => {
  const store = new KeyStore();
  store.add(keys.slice(0, 2).map((key) => ({ key })));
  const started = performance.now();
  const leases = await Promise.all(Array.from({ length: 100 }, async () => store.acquire()));
  assert.ok(performance.now() - started < 1000, "本轮请求需要在一秒内完成选择");
  assert.equal(leases.filter(({ key }) => key === keys[0]).length, 50);
  assert.equal(leases.filter(({ key }) => key === keys[1]).length, 50);
  assert.deepEqual(leases.slice(0, 4).map(({ key }) => key), [keys[0], keys[1], keys[0], keys[1]]);
  assert.throws(() => store.acquire(), (error: unknown) => error instanceof PoolError && error.status === 429 && Number(error.retryAfterMs) > 0);
  leases.forEach((lease) => lease.release());
  assert.equal(store.snapshot().keys.reduce((sum, entry) => sum + entry.inFlight, 0), 0);
  assert.throws(() => store.acquire(), PoolError);
  await setTimeout(1050);
  const next = store.acquire();
  next.release();
});

test("请求时间窗口跨越整秒时仍然按照连续一秒限制", async () => {
  const store = new KeyStore();
  store.add([{ key: keys[1] }]);
  await setTimeout(1000 - Date.now() % 1000 + 20);
  for (let index = 0; index < 25; index += 1) store.acquire().release();
  await setTimeout(550);
  for (let index = 0; index < 25; index += 1) store.acquire().release();
  assert.throws(() => store.acquire(), PoolError);
  await setTimeout(500);
  for (let index = 0; index < 25; index += 1) store.acquire().release();
  assert.throws(() => store.acquire(), PoolError);
});

test("删除后重新添加同一个 key 保留当前一秒计数", () => {
  const store = new KeyStore();
  store.add([{ key: keys[1] }]);
  for (let index = 0; index < 50; index += 1) store.acquire().release();
  store.remove(store.snapshot().keys[0].id);
  store.add([{ key: keys[1] }]);
  assert.throws(() => store.acquire(), (error: unknown) => error instanceof PoolError && error.status === 429);
});

test("指定 key 的检测共用请求上限，停用后仍然允许检测", () => {
  const store = new KeyStore();
  store.add(keys.slice(0, 2).map((key) => ({ key })));
  const id = store.snapshot().keys[1].id;
  const lease = store.acquireForCheck(id);
  assert.equal(lease.key, keys[1]);
  assert.equal(store.snapshot().keys[0].recentRequests, 0);
  lease.disable("组织可用额度不足");
  lease.release();
  for (let index = 1; index < 50; index += 1) store.acquireForCheck(id).release();
  assert.throws(() => store.acquireForCheck(id), (error: unknown) => error instanceof PoolError && error.status === 429);
  assert.throws(() => store.acquireForCheck("missing"), (error: unknown) => error instanceof PoolError && error.status === 404);
  assert.equal(store.snapshot().keys[1].inFlight, 0);
});

test("停用和冷却会影响选择与容量，已经尝试的冷却 key 仍然返回等待时间", async () => {
  const store = new KeyStore();
  store.add(keys.slice(0, 2).map((key) => ({ key })));
  const first = store.acquire();
  first.disable("组织可用额度不足");
  first.release();
  assert.equal(store.snapshot().available, 1);
  const second = store.acquire();
  second.coolDown(80);
  second.release();
  assert.equal(store.snapshot().maxRequestsPerSecond, 0);
  assert.throws(() => store.acquire(new Set([first.id, second.id])), (error: unknown) => error instanceof PoolError && error.status === 429);
  await setTimeout(90);
  const recovered = store.acquire();
  assert.equal(recovered.key, keys[1]);
  recovered.release();
});
