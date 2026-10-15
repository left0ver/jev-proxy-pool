import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  RateLimitError,
  type Questions,
  type SystemOneRequest,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import { authorized, json } from "./http.js";
import { keyStore, PoolError } from "./key-store.js";

// box 问题要配图片，JSON 请求体带不了图片，所以只开放这三种
const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 从请求体里只挑出 jev 认的字段，其余一律丢掉。 */
function parseInput(body: unknown): SystemOneRequest<Questions> | string {
  if (!isObject(body)) return "请求体必须是 JSON 对象";

  const { state, questions, model } = body;
  if (state === undefined || state === null) return "缺少 state";
  if (!isObject(questions) || Object.keys(questions).length === 0) {
    return "questions 必须是非空对象";
  }
  for (const [name, q] of Object.entries(questions)) {
    if (!isObject(q) || typeof q.type !== "string" || !QUESTION_TYPES.has(q.type)) {
      return `questions.${name}.type 只能是 noul、choice 或 score`;
    }
  }
  if (model !== undefined && typeof model !== "string") return "model 必须是字符串";

  const picked: Questions = {};
  for (const [name, q] of Object.entries(questions as Record<string, Record<string, unknown>>)) {
    picked[name] = {
      type: q.type,
      ...(q.instructions !== undefined && { instructions: q.instructions }),
      ...(q.criteria !== undefined && { criteria: q.criteria }),
    } as Questions[string];
  }

  return {
    state: state as SystemOneRequest["state"],
    questions: picked,
    ...(model !== undefined && { model }),
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法的 JSON" }, 400);
  }
  const input = parseInput(body);
  if (typeof input === "string") return json({ error: input }, 400);

  try {
    const attempted = new Set<string>();
    const deadline = performance.now() + 30000;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
    while (performance.now() < deadline) {
      signal.throwIfAborted();
      const lease = keyStore.acquire(attempted);
      attempted.add(lease.id);
      try {
        const client = new TypeSafeClient({ apiKey: lease.key, baseURL: "https://api.typesafe.ai", retry: { maxRetries: 0 }, timeout: Math.max(1, Math.min(10000, deadline - performance.now())) });
        const result = await client.systemOne(input, { signal });
        lease.succeed();
        return json({ model: result.model, answers: result.answers, usage: result.usage });
      } catch (error) {
        if (error instanceof APIError && (error.status === 401 || error.status === 402)) {
          lease.disable(error.status === 401 ? "API key 无效" : "组织可用额度不足");
          continue;
        }
        if (error instanceof RateLimitError) {
          lease.coolDown(error.retryAfterMs);
          continue;
        }
        throw error;
      } finally {
        lease.release();
      }
    }
    return json({ error: "请求超过 30 秒期限" }, 504);
  } catch (err) {
    if (err instanceof APIUserAbortError || (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError"))) {
      return json({ error: request.signal.aborted ? "客户端已取消请求" : "请求超过 30 秒期限" }, request.signal.aborted ? 499 : 504);
    }
    if (err instanceof PoolError) {
      return Response.json({ error: err.message }, { status: err.status, headers: err.retryAfterMs ? { "Retry-After": String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))) } : {} });
    }
    if (err instanceof APIError) {
      // 上游 401 是服务端密钥的问题，不让客户端误以为是自己的口令错了
      const status = err.status === 401 || err.status === 403 ? 502 : err.status;
      return json({ error: "TypeSafe 返回错误", upstreamStatus: err.status, detail: err.body }, status);
    }
    if (err instanceof APIConnectionError) {
      return json({ error: "连不上 TypeSafe 或超时" }, 504);
    }
    if (err instanceof TypeSafeError) {
      // SDK 发请求前的参数校验
      return json({ error: err.message }, 400);
    }
    console.error(err);
    return json({ error: "internal error" }, 500);
  }
}
