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
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fleft0ver%2Fjev-proxy-pool&amp;project-name=jev-proxy-pool&amp;repository-name=jev-proxy-pool&amp;env=ADMIN_PASSWORD,AUTHORIZATION_TOKEN,USE_REDIS,TYPESAFE_API_KEYS&amp;envDefaults=%7B%22USE_REDIS%22%3A%22false%22%7D&amp;envDescription=%E4%BF%9D%E6%8C%81%20USE_REDIS%3Dfalse%EF%BC%8C%E5%9C%A8%20TYPESAFE_API_KEYS%20%E4%B8%AD%E5%A1%AB%E5%86%99%20TypeSafe%20API%20key%EF%BC%8C%E5%A4%9A%E4%B8%AA%20key%20%E7%94%A8%E8%8B%B1%E6%96%87%E9%80%97%E5%8F%B7%E5%88%86%E9%9A%94%E3%80%82&amp;envLink=https%3A%2F%2Fgithub.com%2Fleft0ver%2Fjev-proxy-pool%23running-without-redis"><img src="https://img.shields.io/badge/%E4%B8%8D%E4%BD%BF%E7%94%A8%20Redis%20%E9%83%A8%E7%BD%B2-000000?style=for-the-badge&amp;logo=vercel&amp;logoColor=white" alt="不使用 Redis 部署"></a>
</p>

## 特性

- 顺序轮换可用 key，每个 key 每秒最多 50 次上游调用
- 上游返回 `401` / `402` 时自动停用 key，返回 `429` 时暂停使用并切换到其他 key
- 网页管理 key：添加、检测、搜索、删除，以及 JSONL 导入和导出
- key 和请求计数保存在 Redis（Upstash）中，多个实例共用，重新部署后不丢失
- 可选不使用 Redis，从环境变量读取 key（见[不使用 Redis](#running-without-redis)）
- 支持一键部署到 Vercel

> [!NOTE]
> 每次代理请求大约消耗 3 条 Redis 命令（选择 key、释放名额，成功后重置限流次数），管理页面的列表刷新每次 1 条。请留意 Upstash 套餐的命令额度。

<a id="running-without-redis"></a>

> [!NOTE]
> **不使用 Redis**
>
> 设置 `USE_REDIS=false`，并在 `TYPESAFE_API_KEYS` 中填写 key，就不需要 Upstash 数据库。所有实例读取同一份 key 列表，但其他状态只保存在各实例的内存中：
>
> - 增删 key 需要修改 `TYPESAFE_API_KEYS` 后重新部署，管理页面只能检测和导出。
> - 每秒 50 次的上限由各实例分别计算，Vercel 同时运行多个实例时，单个 key 的总请求数可能超过上限。
> - 因 `401` / `402` 停用的状态、冷却和检测结果在实例重启后恢复，也不会同步到其他实例；管理页面显示的是响应请求的那个实例的状态。

## 快速开始

### 部署到 Vercel

1. 点击上方 **Deploy with Vercel** 按钮，按提示创建仓库。
2. 按提示创建 Upstash Redis 数据库（免费套餐即可），它会自动添加连接用的环境变量。
3. 填写环境变量 `ADMIN_PASSWORD` 和 `AUTHORIZATION_TOKEN`，然后部署。
4. 打开生成的网站，用 `ADMIN_PASSWORD` 登录。
5. 添加 TypeSafe API key，或导入之前导出的 JSONL 文件。

如果不想使用 Redis，可以改用**不使用 Redis 部署**按钮：不会创建数据库，`USE_REDIS` 已预填为 `false`，只需在 `TYPESAFE_API_KEYS` 中填写 key，多个 key 用英文逗号分隔。这种模式的区别见[不使用 Redis](#running-without-redis)。

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
| `USE_REDIS` | 否 | 设为 `false` 时不使用 Redis，从 `TYPESAFE_API_KEYS` 读取 key，默认 `true` |
| `TYPESAFE_API_KEYS` | `USE_REDIS=false` 时必填 | key 列表，每行一个或用逗号分隔，也可以使用管理页面导出的 JSONL |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | 除非 `USE_REDIS=false` | Upstash Redis 的 REST 地址和 token，在 Vercel 上连接数据库后自动添加；也可以使用 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |
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
