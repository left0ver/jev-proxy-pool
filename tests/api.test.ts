import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import app from "../index.js";
import { keyStore } from "../lib/key-store.js";
import { keys } from "./helpers.js";

process.env.ADMIN_PASSWORD = `管理密码-${randomBytes(24).toString("hex")}`;
process.env.AUTHORIZATION_TOKEN = randomBytes(24).toString("hex");
const headers = { Authorization: `Basic ${Buffer.from(`admin:${process.env.ADMIN_PASSWORD}`).toString("base64")}`, "Content-Type": "application/json" };

test("管理接口认证、添加、导出、导入和删除", async () => {
  for (const [path, method] of [["/api/admin/keys", "GET"], ["/api/admin/keys", "POST"], ["/api/admin/keys/export", "GET"], ["/api/admin/keys/import", "POST"], ["/api/admin/keys/missing", "DELETE"], ["/api/admin/keys/missing/check", "POST"]]) {
    assert.equal((await app.request(path, { method })).status, 401);
  }
  assert.equal((await app.request("/api/admin/keys", { headers: { Authorization: `Bearer ${process.env.AUTHORIZATION_TOKEN}` } })).status, 401);
  assert.equal((await app.request("/api/admin/keys/missing/check", { method: "POST", headers })).status, 404);
  const create = await app.request("/api/admin/keys", { method: "POST", headers, body: JSON.stringify({ keys: [{ key: keys[1], name: "API 验证" }] }) });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.maxRequestsPerSecond, 50);
  assert.equal(create.headers.get("Cache-Control"), "no-store");
  const exported = await app.request("/api/admin/keys/export", { headers });
  const document = await exported.text();
  assert.match(exported.headers.get("Content-Disposition")!, /jev-keys\.jsonl/);
  assert.ok(document.includes(keys[1]));
  const conflict = await app.request("/api/admin/keys", { method: "POST", headers, body: JSON.stringify({ keys: [{ key: keys[0] }, { key: keys[1] }] }) });
  assert.equal(conflict.status, 409);
  assert.equal(keyStore.snapshot().keys.length, 1);
  const wrongInstance = await app.request(`/api/admin/keys/${created.keys[0].id}`, { method: "DELETE", headers: { ...headers, "X-Jev-Instance": "different-instance" } });
  assert.equal(wrongInstance.status, 409);
  const remove = await app.request(`/api/admin/keys/${created.keys[0].id}`, { method: "DELETE", headers });
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).keys.length, 0);
  assert.equal((await app.request("/api/admin/keys/import", { method: "POST", headers, body: document })).status, 201);
  assert.equal((await app.request("/api/admin/keys/import", { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await app.request("/api/admin/keys", { method: "POST", headers, body: "{" })).status, 400);
});

test("代理认证、参数校验与请求上限响应", async () => {
  const body = JSON.stringify({ state: "Hello", questions: { check: { type: "noul", instructions: "Does the text say Hello?" } } });
  const proxyHeaders = { Authorization: `Bearer ${process.env.AUTHORIZATION_TOKEN}`, "Content-Type": "application/json" };
  assert.equal((await app.request("/v1/systemone", { method: "POST", body })).status, 401);
  assert.equal((await app.request("/v1/systemone", { method: "POST", headers: proxyHeaders, body: "{}" })).status, 400);
  for (let index = 0; index < 50; index += 1) keyStore.acquire().release();
  const check = await app.request(`/api/admin/keys/${keyStore.snapshot().keys[0].id}/check`, { method: "POST", headers });
  assert.equal(check.status, 429);
  const limited = await app.request("/v1/systemone", { method: "POST", headers: proxyHeaders, body });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
  for (const entry of keyStore.snapshot().keys) keyStore.remove(entry.id);
  assert.equal((await app.request("/v1/systemone", { method: "POST", headers: proxyHeaders, body })).status, 503);
});
