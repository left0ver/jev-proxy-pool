import { testPrefix } from "./env.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after } from "node:test";
import { KeyStore } from "../lib/key-store.js";

const path = process.env.TEST_KEYS_FILE;
if (!path) throw new Error("请通过 TEST_KEYS_FILE 指定真实 key 文件，每行一个 key");
export const keys = readFileSync(path, "utf8").trim().split(/\r?\n/).map((key) => key.trim());
if (keys.length < 2) throw new Error("测试需要至少两个真实 key");

/** 每个测试使用独立数据和可手动推进的时钟，限流测试不受网络延迟影响。 */
export function testStore() {
  const clock = { now: Date.now() };
  const prefix = `${testPrefix}${randomUUID()}:`;
  return { store: new KeyStore({ prefix, clock: () => clock.now }), clock, prefix };
}

after(async () => {
  const redis = new KeyStore().redis;
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(cursor, { match: `${testPrefix}*`, count: 1000 });
    if (found.length) await redis.del(...found);
    cursor = String(next);
  } while (cursor !== "0");
});
