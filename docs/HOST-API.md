# 宿主 API 实证手册

> 全部结论来自本机实测（读 `app.asar` + 运行时探针 + 反复重启）。**不是推测。**
> 踩过的每个坑都记在这里，改代码前先看一遍。

---

## 一、`connection.fetch.register` —— 注册 HTTP API

### 正确的 route 形状（缺一不可）

```js
ctx.get('connection').fetch.register({
	path: '/api/dsh-memory-sea/scene',   // 精确匹配 url.pathname，不是前缀路由
	methods: ['GET'],                    // 数组，不能为空、不能重复
	requestBody: 'buffered',             // ← 必须传！宿主自己的路由都传
	fetch: async (request) => Response   // ← 字段名叫 fetch，不是 handler
})
```

### 三个字段名/存在性坑

| 坑 | 现象 | 原因 |
|---|---|---|
| 写成 `handler` 而不是 `fetch` | 路由注册成功，但请求挂起/404 | `registerFetchRoute` 里 `registered = { methods, requestBody, fetch: route.fetch }`，`handler` 被丢弃 |
| 漏掉 `requestBody` | **HTTP 400** | `requestBodyMode` 返回 `undefined`，下游判非法 |
| `methods` 传 `new Set(...)` | 可用 | `new Set(route.methods)` 两种都吃，但 `assertFetchRoute` 要 `route.methods.length`，**Set 没有 length** → 会抛 |

**所以 `methods` 必须传数组。**

### 返回值

`register` 返回 dispose 函数（`owner.effect(...)`）。挂到 `ctx.on('dispose', off)`，否则热重载时抛 `already registered`。

### 校验规则（`assertFetchRoute`）

```js
endpointFromPath("/api", route.path) !== undefined   // 路径必须挂在 /api 下
route.methods.length !== 0
new Set(route.methods).size === route.methods.length // 不能重复
```

---

## 二、`ctx.get()` 的时序 —— 千万别在 `apply()` 里立即取

**实测**：`apply()` 执行时 `ctx.get('connection')` 是 `undefined`，写盘结果 `{"scene":"no connection.fetch"}`。

而延迟 3–4 秒后同一份代码能拿到。

### 正确写法

```js
ctx.inject(['connection'], (c) => {
	const conn = c.get('connection');
	// 这里保证已就绪
});
```

**外加兜底**（防某些宿主不触发 inject 回调）：

```js
const retry = setInterval(() => { /* 每秒试一次，最多 12 次 */ }, 1000);
```

**索引任务**天然安全，因为它本来就延迟 4 秒启动。

---

## 三、`sessionQuery` —— 读会话数据

### 列会话

```js
const sessions = await sessionQuery.listSessions();   // 无参调用
```

返回 49 个对象，形状：

```json
{
  "header": { "version": 4, "id": "session-<uuid>", "createdAt": 1793442215157,
              "cwd": "C:\\...", "agentPreset": "standard" },
  "live": false,
  "persisted": true
}
```

**`id` 在 `header.id`，不在顶层。** 取字段要做深度搜索（`header` / `session` / `summary` / `meta`…）。

### 读事件 —— 两个大坑

**① 参数是字符串，不是对象**

```js
sessionQuery.listEvents({ sessionId })   // ✗ 报 `session "[object Object]" not found`
sessionQuery.listEvents(sessionId)       // ✓
```

**② `listEvents` 只返回事件壳，没有内容**

```json
{"sessionId":"...","seq":11,"type":"user/message","time":1793442248965,"surface":"shadowed"}
```

`surface: "shadowed"` = 内容被投影掉了。**拿到文本必须用 `observeSession`**：

```js
const obs = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
const events = [...obs.events];   // 这才是带 data 的完整事件
obs.close();
```

**`observeSession` 必须收尾**（`close` / `dispose` / `release`），否则宿主一直持有 observation。

### 完整事件形状（`projectionMode: 'none'`）

```json
{
  "type": "user/message",
  "seq": 11,
  "time": 1793442248965,
  "data": {
    "content": [{ "type": "text", "text": "真实内容" }],
    "source": { "kind": "user", "rpcId": "...", "clientTimeZone": "Asia/Shanghai" },
    "role": "user",
    "id": "f2948620-..."
  },
  "surfaceOp": "append"
}
```

`data.content` 可能是 `string`、`[{type,text}]`、`string[]`——**用递归取文本最稳**（深度 5，先找 `text` 字段，再钻 `content/message/blocks/parts/body/value/delta/data`）。

### 系统注入污染（必须过滤）

宿主把系统提示塞成 `user/message` 事件：

```
<system-reminder> + 整篇 AGENTS.md（几千到上万字）
Current runtime context. This snapshot supersedes...
```

**后果**：词频被带偏、点数虚高、每轮预览变成系统提示。实测过滤前 3 轮里有 2 轮是注入。

**过滤必须放在"分轮"之前**，否则一条注入就会被当成用户发言切出一轮。

常见前缀：`<system-reminder>`、`Current runtime context`、`Instructions from:`、`<workspace`、`<attachment`、`<agent-instructions`、`<environment`、`<context`、`[dsh-`、`AGENTS.md`，另外 > 20000 字的直接丢。

---

## 四、桌面端的传输 —— 页面不在 HTTP 源上

### 页面跑在 `dsh-app://app`

```
location.protocol = "dsh-app:"
location.host     = "app"
```

**不是 `http://127.0.0.1:19387`，也不是 `file://`。**

### 协议 handler 是转发器

```js
protocol.handle('dsh-app', (request) => {
	const url = new URL(request.url);
	if (url.hostname === 'app') {
		if (静态资源路径) return serveWebDocument(...);           // / /index.html /assets/ favicon manifest
		return forwardWebRequest(request, hostUrl, hostCookie);  // 其余一切 → 转发到 host，自动带 cookie
	}
	return 404;
});
```

协议注册时带 `supportFetchAPI: true` + `corsEnabled: true`，所以**页面内 `fetch('/api/...')` 走相对路径就行**——会被转成 `dsh-app://app/api/...`，再由 handler 转发到 host 并注入认证 cookie。

**所以：相对路径是正解；直连 `http://127.0.0.1:19387` 反而会被 CORS 挡。**

### `dshDesktop` 只有界面能力

```js
window.dshDesktop = { protocolVersion, browser, deviceInfo, keyboard, shortcuts, updates }
```

**没有网络请求能力**，别指望用它发 API。

---

## 五、构建/部署流程的坑

### build 失败，deploy 照样"成功"

`esbuild` 因为语法错误退出，但 `deploy.mjs` 只检查 `out/client.js` 存在，于是**静默复制旧产物**并打印 `✓ 插件`。

**后果**：改了源码、重启了、查了半天，跑的一直是旧代码。

**已加硬保护**：`deploy` 会比对 `out/client.js` 与 `src/*.js` 的 mtime，产物旧就拒绝部署。

### 改完必须验证产物里有关键字符串

```powershell
Select-String -LiteralPath client.js -Pattern '/api/dsh-memory-sea' -Quiet
```

---

## 六、排查顺序（省时间）

接口不通时，按这个顺序看，不要跳步：

1. **`store/routes.json`** → 路由注册成功了吗
2. **`curl http://127.0.0.1:19387/api/...`** → 401（路由在，需认证）/ 404（路由不在）/ 400（字段不对）
3. **面板红框** → client 侧的完整错误（含响应体）
4. **`store/meta.json` 的 `probe`** → 自适应参数试错的明细

**别在 host 侧猜，先看 client 报什么。**
