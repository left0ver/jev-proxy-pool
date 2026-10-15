<h1 align="center">Jev Proxy Pool</h1>

<p align="center"><b>English</b> | <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22.x-339933?logo=node.js&amp;logoColor=white" alt="Node.js"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript"></a>
  <a href="https://hono.dev"><img src="https://img.shields.io/badge/Hono-4-E36002?logo=hono&amp;logoColor=white" alt="Hono"></a>
  <a href="https://github.com/left0ver/jev-proxy-pool"><img src="https://img.shields.io/github/stars/left0ver/jev-proxy-pool?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">Call TypeSafe Jev through a single HTTP endpoint that rotates API keys automatically, and manage the keys from a web page.</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fleft0ver%2Fjev-proxy-pool&amp;project-name=jev-proxy-pool&amp;repository-name=jev-proxy-pool&amp;env=ADMIN_PASSWORD,AUTHORIZATION_TOKEN&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%5D&amp;envLink=https%3A%2F%2Fgithub.com%2Fleft0ver%2Fjev-proxy-pool%23environment-variables"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
</p>

## Features

- Rotates through available keys in order, with at most 50 upstream calls per key per second
- Disables a key automatically when upstream returns `401` / `402`, and pauses it and switches to another key on `429`
- Web admin panel for keys: add, check, search, delete, plus JSONL import and export
- Keys and request counters live in Redis (Upstash), shared by every instance and kept across redeploys
- One-click deployment to Vercel

> [!NOTE]
> Each proxied request uses about 3 Redis commands (pick a key, release the slot, reset the rate-limit streak on success), and each refresh of the admin list uses 1. Keep an eye on the command quota of your Upstash plan.

## Quick start

### Deploy to Vercel

1. Click the **Deploy with Vercel** button above and follow the prompts to create the repository.
2. When prompted, create an Upstash Redis database (the free plan is enough). Its connection environment variables are added automatically.
3. Fill in the `ADMIN_PASSWORD` and `AUTHORIZATION_TOKEN` environment variables, then deploy.
4. Open the deployed site and sign in with `ADMIN_PASSWORD`.
5. Add your TypeSafe API keys, or import a JSONL file you exported earlier.

### Run locally

Requires Node.js 22.9 or later and an Upstash Redis database (create one for free in the [Upstash console](https://console.upstash.com)).

```bash
git clone https://github.com/left0ver/jev-proxy-pool.git
cd jev-proxy-pool
npm ci
cp .env.example .env   # fill in ADMIN_PASSWORD, AUTHORIZATION_TOKEN, and the database's KV_REST_API_URL and KV_REST_API_TOKEN
npm run dev
```

Open `http://127.0.0.1:3000`, sign in, and add your keys.

<a id="environment-variables"></a>

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | Password for the admin panel |
| `AUTHORIZATION_TOKEN` | Yes | Bearer token clients use to call the API |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Yes | Upstash Redis REST URL and token, added automatically when the database is connected on Vercel; `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work |
| `REDIS_KEY_PREFIX` | No | Prefix for Redis keys, defaults to `jev:` |
| `PORT` | No | Local development port, defaults to `3000` |

Use different random strings for `ADMIN_PASSWORD` and `AUTHORIZATION_TOKEN`.

## API usage

`POST /v1/systemone` (also available at `/api/v1/systemone`):

```bash
curl --fail-with-body 'https://your-project.vercel.app/v1/systemone' \
  -H 'Authorization: Bearer YOUR_AUTHORIZATION_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"state":{"text":"Hello"},"questions":{"check":{"type":"noul","instructions":"Does the text contain Hello?"}}}'
```

| Field | Required | Description |
| --- | --- | --- |
| `state` | Yes | Text or JSON data to evaluate; must not be `null` |
| `questions` | Yes | Non-empty object keyed by question name; `type` can be `noul`, `choice` or `score` |
| `model` | No | TypeSafe model name; the SDK default is used when omitted |

A successful response contains `model`, `answers` and `usage`. In the example above, the result is at `answers.check.noul`, a value from `0` to `1` giving the probability that the answer is "yes".

| Status | Meaning |
| --- | --- |
| `400` | Invalid request parameters |
| `401` | Wrong client token |
| `429` | Every available key has hit its per-second limit or is cooling down; wait for `Retry-After` |
| `502` | TypeSafe rejected the upstream credentials (`401` / `403`) |
| `503` | No keys available; add or import some |
| `504` | The 30-second deadline passed, or TypeSafe could not be reached |
| `500` | Internal error, for example Redis being unreachable |

Other upstream errors are passed through with TypeSafe's status code, and the response body includes `upstreamStatus` and `detail`.

Each request has a 30-second overall deadline, each upstream call waits at most 10 seconds, and each key is tried at most once per request.

## License

[MIT](LICENSE)
