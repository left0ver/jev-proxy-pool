import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import app from "./index.js";

if (!process.env.ADMIN_PASSWORD) throw new Error("缺少 ADMIN_PASSWORD 环境变量");
if (!process.env.AUTHORIZATION_TOKEN) throw new Error("缺少 AUTHORIZATION_TOKEN 环境变量");
app.get("/*", serveStatic({ root: "./public" }));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.PORT ?? 3000) }, (info) => {
  console.log(`管理页面：http://127.0.0.1:${info.port}`);
});
