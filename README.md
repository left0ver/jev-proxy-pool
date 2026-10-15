<h1 align="center">Jev Proxy Pool</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22.x-339933?logo=node.js&amp;logoColor=white" alt="Node.js"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript"></a>
  <a href="https://hono.dev"><img src="https://img.shields.io/badge/Hono-4-E36002?logo=hono&amp;logoColor=white" alt="Hono"></a>
  <a href="https://github.com/left0ver/jev_proxy_pool"><img src="https://img.shields.io/github/stars/left0ver/jev_proxy_pool?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">通过统一的 HTTP 接口调用 TypeSafe Jev，自动轮换 API key，并在网页中管理 key。</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fleft0ver%2Fjev_proxy_pool&amp;project-name=jev-proxy-pool&amp;repository-name=jev_proxy_pool&amp;env=ADMIN_PASSWORD,AUTHORIZATION_TOKEN&amp;envLink=https%3A%2F%2Fgithub.com%2Fleft0ver%2Fjev_proxy_pool%23environment-variables"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
</p>

## 特性

- 顺序轮换可用 key，每个 key 每秒最多 50 次上游调用
- 上游返回 `401` / `402` 时自动停用 key，返回 `429` 时暂停使用并切换到其他 key
- 网页管理 key：添加、检测、搜索、删除，以及 JSONL 导入和导出
- 支持一键部署到 Vercel

> [!WARNING]
> key 只保存在运行实例的内存中。重新部署或实例重启后需要重新导入；Vercel 的多个实例各自维护独立的 key 列表和请求计数。建议用 **导出全部** 定期备份。

## 快速开始

### 部署到 Vercel

1. 点击上方 **Deploy with Vercel** 按钮，按提示创建仓库。
2. 填写环境变量 `ADMIN_PASSWORD` 和 `AUTHORIZATION_TOKEN`，然后部署。
3. 打开生成的网站，用 `ADMIN_PASSWORD` 登录。
4. 添加 TypeSafe API key，或导入之前导出的 JSONL 文件。

### 本地运行

需要 Node.js 22。

```bash
git clone https://github.com/left0ver/jev_proxy_pool.git
cd jev_proxy_pool
npm ci
cp .env.example .env   # 填写 ADMIN_PASSWORD 和 AUTHORIZATION_TOKEN
npm run dev
```

打开 `http://127.0.0.1:3000` 登录后添加 key。

<a id="environment-variables"></a>

## 环境变量

| 名称 | 必填 | 用途 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 是 | 管理网页登录密码 |
| `AUTHORIZATION_TOKEN` | 是 | 客户端 API 的 Bearer token |
| `PORT` | 否 | 本地开发端口，默认 `3000` |

建议两个值使用不同的随机字符串。

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
| `409` | 管理请求到达了其他实例，刷新页面即可 |
| `429` | 所有可用 key 都已达到每秒上限或正在冷却，按 `Retry-After` 等待 |
| `503` | 当前实例没有可用 key，需要添加或导入 |

单次请求总期限 30 秒，每次上游调用最多等待 10 秒，每个 key 在同一次请求中最多尝试一次。

## License

[MIT](LICENSE)
