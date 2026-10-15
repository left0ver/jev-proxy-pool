import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { adminAuthorized, privateJson } from "./lib/http.js";
import { keyStore, PoolError } from "./lib/key-store.js";
import { checkKey } from "./lib/key-check.js";
import { POST } from "./lib/systemone.js";

const app = new Hono();

app.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  await next();
});

app.use("/api/admin/*", async (context, next) => {
  if (!process.env.ADMIN_PASSWORD) return privateJson({ error: "尚未配置 ADMIN_PASSWORD" }, 503);
  if (!adminAuthorized(context.req.raw)) return privateJson({ error: "管理密码不正确，请重新登录" }, 401);
  await next();
});
app.use("/api/admin/*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: () => privateJson({ error: "文件或请求超过 2 MiB" }, 413) }));

app.get("/api/admin/keys", async () => privateJson(await keyStore.snapshot()));
app.post("/api/admin/keys", async (context) => {
  const body = z.object({ keys: z.array(z.unknown()) }).strict().parse(await context.req.json());
  const added = await keyStore.add(body.keys);
  return privateJson({ added, ...await keyStore.snapshot() }, 201);
});
app.post("/api/admin/keys/import", async (context) => {
  const added = await keyStore.import(await context.req.text());
  return privateJson({ added, ...await keyStore.snapshot() }, 201);
});
app.delete("/api/admin/keys/:id", async (context) => {
  await keyStore.remove(context.req.param("id"));
  return privateJson(await keyStore.snapshot());
});
app.post("/api/admin/keys/:id/check", async (context) => {
  const check = await checkKey(context.req.param("id"), context.req.raw.signal);
  return privateJson({ check, ...await keyStore.snapshot() });
});
app.get("/api/admin/keys/export", async () => new Response(await keyStore.export(), {
  headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": 'attachment; filename="jev-keys.jsonl"', "Cache-Control": "no-store" },
}));

app.post("/v1/systemone", (context) => POST(context.req.raw));
app.post("/api/v1/systemone", (context) => POST(context.req.raw));

app.onError((error) => {
  if (error instanceof PoolError) return privateJson({ error: error.message }, error.status);
  if (error instanceof SyntaxError || error instanceof z.ZodError) return privateJson({ error: "请求数据格式不正确" }, 400);
  console.error(error);
  return privateJson({ error: "服务器处理请求失败" }, 500);
});

export default app;
