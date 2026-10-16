// 必须在导入 index.js 之前执行：关闭 Redis，key 从环境变量读取。
export const envKeys = ["apikey_aa_01", "apikey_bb_02"];
process.env.USE_REDIS = "false";
process.env.TYPESAFE_API_KEYS = envKeys.join("\n");
