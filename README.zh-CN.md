<h1 align="center">Jev Proxy Pool</h1>

<p align="center"><a href="README.md">English</a> | <b>简体中文</b></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22.x-339933?logo=node.js&amp;logoColor=white" alt="Node.js"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript"></a>
  <a href="https://hono.dev"><img src="https://img.shields.io/badge/Hono-4-E36002?logo=hono&amp;logoColor=white" alt="Hono"></a>
  <a href="https://github.com/left0ver/jev-proxy-pool"><img src="https://img.shields.io/github/stars/left0ver/jev-proxy-pool?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">通过统一的 HTTP 接口调用 TypeSafe Jev，自动轮换 API key，并在网页中管理 key。</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fleft0ver%2Fjev-proxy-pool&amp;project-name=jev-proxy-pool&amp;repository-name=jev-proxy-pool&amp;env=ADMIN_PASSWORD,AUTHORIZATION_TOKEN&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%5D&amp;envLink=https%3A%2F%2Fgithub.com%2Fleft0ver%2Fjev-proxy-pool%23environment-variables"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
</p>

## 特性

- 顺序轮换可用 key，每个 key 每秒最多 50 次上游调用
- 上游返回 `401` / `402` 时自动停用 key，返回 `429` 时暂停使用并切换到其他 key
- 网页管理 key：添加、检测、搜索、删除，以及 JSONL 导入和导出
- key 和请求计数保存在 Redis（Upstash）中，多个实例共用，重新部署后不丢失
- 支持一键部署到 Vercel

> [!NOTE]
> 每次代理请求大约消耗 3 条 Redis 命令（选择 key、释放名额，成功后重置限流次数），管理页面的列表刷新每次 1 条。请留意 Upstash 套餐的命令额度。

## 快速开始

### 部署到 Vercel

1. 点击上方 **Deploy with Vercel** 按钮，按提示创建仓库。
2. 按提示创建 Upstash Redis 数据库（免费套餐即可），它会自动添加连接用的环境变量。
3. 填写环境变量 `ADMIN_PASSWORD` 和 `AUTHORIZATION_TOKEN`，然后部署。
4. 打开生成的网站，用 `ADMIN_PASSWORD` 登录。
5. 添加 TypeSafe API key，或导入之前导出的 JSONL 文件。

### 本地运行

需要 Node.js 22.9 或更高版本，以及一个 Upstash Redis 数据库（可以在 [Upstash 控制台](https://console.upstash.com) 免费创建）。

```bash
git clone https://github.com/left0ver/jev-proxy-pool.git
cd jev-proxy-pool
npm ci
cp .env.example .env   # 填写 ADMIN_PASSWORD、AUTHORIZATION_TOKEN，以及数据库的 KV_REST_API_URL 和 KV_REST_API_TOKEN
npm run dev
```

打开 `http://127.0.0.1:3000` 登录后添加 key。

<a id="environment-variables"></a>

## 环境变量

| 名称 | 必填 | 用途 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 是 | 管理网页登录密码 |
| `AUTHORIZATION_TOKEN` | 是 | 客户端 API 的 Bearer token |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | 是 | Upstash Redis 的 REST 地址和 token，在 Vercel 上连接数据库后自动添加；也可以使用 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |
| `REDIS_KEY_PREFIX` | 否 | Redis key 前缀，默认 `jev:` |
| `PORT` | 否 | 本地开发端口，默认 `3000` |

`ADMIN_PASSWORD` 和 `AUTHORIZATION_TOKEN` 建议使用不同的随机字符串。

## API 用法

`POST /v1/systemone`（也支持 `/api/v1/systemone`）：

```bash
curl --fail-with-body 'https://your-project.vercel.app/v1/systemone' \
  -H 'Authorization: Bearer YOUR_AUTHORIZATION_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"state":{"text":"Hello"},"questions":{"check":{"type":"noul","instructions":"文本中是否包含 Hello？"}}}'
```

| 请求字段 | 必填 | 说明 |
| --- | --- | --- |
| `state` | 是 | 需要判断的文本或 JSON 数据，不能为 `null` |
| `questions` | 是 | 以问题名称为字段的非空对象，`type` 支持 `noul`、`choice`、`score` |
| `model` | 否 | TypeSafe 模型名称，默认使用 SDK 默认模型 |

成功响应包含 `model`、`answers` 和 `usage`。上例的结果位于 `answers.check.noul`，取值 `0`～`1`，表示回答“是”的概率。

| 状态码 | 含义 |
| --- | --- |
| `400` | 请求参数不正确 |
| `401` | 客户端 token 不正确 |
| `429` | 所有可用 key 都已达到每秒上限或正在冷却，按 `Retry-After` 等待 |
| `502` | TypeSafe 拒绝了上游凭证（`401` / `403`） |
| `503` | 没有可用 key，需要添加或导入 |
| `504` | 超过 30 秒期限，或连不上 TypeSafe |
| `500` | 服务端内部错误，例如连不上 Redis |

其他上游错误会原样返回 TypeSafe 的状态码，响应体中包含 `upstreamStatus` 和 `detail`。

## License

[MIT](LICENSE)
