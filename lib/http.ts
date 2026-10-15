import { createHash, timingSafeEqual } from "node:crypto";

export const json = (body: unknown, status = 200) => Response.json(body, { status });

/** 客户端要在 Authorization: Bearer 里带上 AUTHORIZATION_TOKEN。 */
export function authorized(request: Request): boolean {
  const token = process.env.AUTHORIZATION_TOKEN;
  return !!token && request.headers.get("Authorization") === `Bearer ${token}`;
}

export function adminAuthorized(request: Request): boolean {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error("缺少 ADMIN_PASSWORD 环境变量");
  const expected = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(request.headers.get("Authorization") ?? ""));
}

export const privateJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
