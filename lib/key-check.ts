import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError, noul, RateLimitError, TypeSafeClient } from "@typesafe-ai/sdk";
import { keyStore, type KeyCheckResult } from "./key-store.js";

export async function checkKey(id: string, signal: AbortSignal): Promise<KeyCheckResult> {
  const lease = keyStore.acquireForCheck(id);
  const complete = (status: KeyCheckResult["status"], message: string, upstreamStatus: number | null) => {
    const result = { status, message, upstreamStatus, checkedAt: new Date().toISOString() };
    lease.completeCheck(result);
    return result;
  };
  try {
    const client = new TypeSafeClient({ apiKey: lease.key, baseURL: "https://api.typesafe.ai", retry: { maxRetries: 0 }, timeout: 10000 });
    const result = await client.systemOne({ state: "Hello", questions: { check: noul("Does the text say Hello?") }, model: "jev-latest" }, { signal });
    const answer = result.answers.check.noul;
    if (!Number.isFinite(answer) || answer < 0 || answer > 1) throw new Error("TypeSafe 检测响应格式不正确");
    return complete("valid", "有效，Jev 请求成功", 200);
  } catch (error) {
    if (error instanceof RateLimitError) {
      lease.coolDown(error.retryAfterMs);
      return complete("rate_limited", "上游限流，请冷却后重新检测", 429);
    }
    if (error instanceof APIError) {
      if (error.status === 401) return complete("invalid", "API key 无效", 401);
      if (error.status === 402) return complete("no_credits", "组织可用额度不足", 402);
      return complete("unconfirmed", `暂时无法确认，上游返回 HTTP ${error.status}`, error.status);
    }
    if (error instanceof APITimeoutError) return complete("unconfirmed", "检测超时，请重新检测", null);
    if (error instanceof APIUserAbortError) return complete("unconfirmed", "检测已取消", null);
    if (error instanceof APIConnectionError) return complete("unconfirmed", "无法连接 TypeSafe，请重新检测", null);
    throw error;
  } finally {
    lease.release();
  }
}
