import { readFileSync } from "node:fs";

const path = process.env.TEST_KEYS_FILE;
if (!path) throw new Error("请通过 TEST_KEYS_FILE 指定真实 key 文件，每行一个 key");
export const keys = readFileSync(path, "utf8").trim().split(/\r?\n/).map((key) => key.trim());
if (keys.length < 2) throw new Error("测试需要至少两个真实 key");
