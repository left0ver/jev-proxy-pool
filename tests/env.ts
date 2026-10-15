import { randomUUID } from "node:crypto";

// 必须在导入 lib/key-store.js 之前执行：测试数据写入独立前缀，不影响同一数据库中的正式数据。
export const testPrefix = `jev-test:${randomUUID()}:`;
process.env.REDIS_KEY_PREFIX = testPrefix;
