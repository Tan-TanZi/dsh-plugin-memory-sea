# 数据源与连接：调研结论

> 目标：把「示例星海」换成真实数据。这份文档记录**能拿到什么数据**、**怎么拿到**、**怎么映射到星海**。
> 调研来源：`app.asar`（宿主本体）、已装插件源码、社区同类项目。
>
> **先读第四节「定位与边界」。** 下面提到的社区项目**只做参考，不安装、不接入**——它们的核心价值是"把记忆喂给 AI"，而本插件只做"把经历过的事画出来看"。

---

## 一、社区已有同类项目（参考它们的做法，不接入）

> 这一节的价值：看别人怎么**提取**、怎么**建图**、怎么**编码视觉**。它们的 recall / 注入部分与我们无关，见第四节。

### 1. [dsh-memory-tree](https://github.com/qinghuaju/dsh-memory-tree) — DSH 的长期记忆插件（MIT）

**它做什么**：把每个 user/assistant 交互捕获下来，AST 解析成可寻址节点，做 embedding，存进分层的 SQLite，并在每轮前注入一段 `<memory-recall>`。

> ⚠️ **我们不装它。** 它的 SQLite 是给 AI 用的记忆库；我们只关心它「怎么给节点定 importance、怎么分 tier」这套思路。

**数据落在哪**：

```
$DSH_HOME/memory-tree/
├── memory.db            hot   < 30 天      recall 权重 1.00
├── memory-warm.db       warm  30–180 天    0.90
├── memory-cold.db       cold  > 180 天     0.78
├── credentials.json     只有 embedding 的 key
└── config.json          与 patch 同构
```

**Schema 要点**（从 README 推断）：

| 表/实体 | 字段 |
|---|---|
| node | `path`（唯一 AST 路径）、`kind`、`title`、`content` |
| vector | float32，1024 维（可 `dropColdVectors`） |
| similar edge | cos ≥ 0.72 |

**它的打分公式（直接决定我们的视觉编码）**：

```
base = (0.55·cosine + 0.20·lexical + 0.25·rank-agreement) × tier-weight
     + 一跳：parent ×0.55、similar neighbour ×0.55·similarity
     + 先验：0.06·importance + 0.05·recency(45d) + 0.03·usage
```

**关键**：它的 Roadmap **Phase 4 明确写着「3D memory graph」** —— 也就是说，我们现在做的东西正是它缺的那一半。**它可以成为数据源，我们可以成为它的可视化层。**

**工具面**：`mem_recall` / `mem_store` / `mem_stats` / `mem_dream` / `mem_rotate`

---

### 2. [agentcairn-obsidian](https://github.com/ccf/agentcairn-obsidian) — 记忆图谱查看器（Apache-2.0）

**这是「记忆图谱」最成熟的参照**，而且它的定位跟我们完全一致：**只做读和导航，不做语义检索**（检索在 CLI/MCP 那边）。

**它的视觉编码（建议直接借鉴）**：

| 维度 | 编码 |
|---|---|
| 节点 | 一条记忆（`type: memory` 的 note） |
| 颜色 | **project** |
| 大小 | **importance** |
| 变暗 | **currency**（`superseded` / `expired` 变暗并加角标） |
| 边 | `related:` wikilink（由 `cairn link` 写入） |
| **孤立节点** | **停在一边，而不是散落在图里** |
| 分组 | 按 project / harness / tag → 生成 **facet 中枢节点**，相关记忆绕它聚拢 |

**它的 frontmatter 契约**（我们要兼容的字段）：

```yaml
type: memory
title: ...
created: ...
source: memory://session/<id>
importance: 0.0–1.0
tags: [...]
valid_from / valid_until          # 有效期，end-exclusive
superseded_by: <other memory>     # 被谁取代
project: ...                      # 上色用
harness: ...                      # 哪个 harness 产的
```

**currency 四态**：`current` / `superseded` / `expired` / `not_yet_valid`

---

## 二、DSH 自己提供的会话数据（零依赖，一定有）

### 三级读取回退（实证，来自 `dsh-purge/lib/rewind.js`）

```js
async function readSessionLog(ctx, sessionId) {
	// ① 活跃会话（最快，同步）
	const store = ctx.get('sessions');
	const live = store?.get?.(sessionId);
	if (live?.snapshotEvents) {
		return { events: live.snapshotEvents(), header: live.header };
	}

	// ② 会话控制器（冷会话）
	const controller = ctx.get('sessionController');
	if (typeof controller?.inspect === 'function') {
		const inspected = await controller.inspect(sessionId);
		return { events: inspected?.events, header: inspected?.meta || inspected?.header };
	}

	// ③ 查询服务（通用，带 projectionMode）
	const query = ctx.get('sessionQuery');
	if (typeof query?.observeSession === 'function') {
		const observed = await query.observeSession(sessionId, { projectionMode: 'none' });
		try { return { events: observed?.events, header: observed?.header }; }
		finally { disposeObservation(observed); }
	}
	throw new Error('找不到当前会话');
}
```

`projectionMode: 'none'` = 拿原始事件；`observeSession` 返回 `{ header, events, inheritedEventCount }`，`header.cwd` 是工作目录。

### 事件类型全清单（按宿主内出现频次）

| 事件 | 用途 |
|---|---|
| `user/message` | **记忆点**（她/他说的话） |
| `assistant/message` | **记忆点**（回答） |
| `tool/call` / `tool/result` | 事件边（做了什么、调了什么） |
| `turn/start` / `turn/end` | 时间锚，一轮的边界 |
| `step/start` / `step/end` | 更细的边界 |
| `compaction/start` / `compaction/summary` / `compaction/end` | **压缩摘要 = 高价值记忆点**（被压缩掉的精华） |
| `session/created` / `session/title` / `session/update` | 会话元信息 → 簇名 |
| `system/message` | 系统提示，一般跳过 |
| `assistant/attempt` / `assistant/live-chunk` | 流式中间态，跳过 |

### 消息体形状

```js
// user/message / assistant/message
event.data.content  // string | Array<{ type: 'text', text }> | Array<string>
event.data.id
event.data.source   // 用于区分来源（如 agent instructions）
```

解析要兼容三种形态（`dsh-purge/lib/rewind.js` 的 `userTextFromEvent` 就是这么写的）。

---

## 三、连接：host ↔ client（探针实测）

> 由临时探针插件 `dsh-memory-probe` 在本机 desktop profile 上实测得到。**不是推测。**

### 3.1 服务清单：全部可用

```
webServer  connection  sessions  sessionController  sessionQuery
tools  agents  agentPresets  subagents  skills  systemPrompt
```

`ctx` 本身是 Proxy（`Object.keys(ctx)` 只有一个 `fiber`），服务只能 `ctx.get(name)` 拿，属性访问无效。

### 3.2 两套路由，别搞混

| API | 用途 | 参数 | 鉴权 |
|---|---|---|---|
| `webServer.register(...)` | **静态资源**（index / assets） | **1 个**，返回 `dispose` | 不适用 |
| **`connection.fetch.register(route)`** | **API 端点** ← 记忆海要用这个 | 1 个 route 对象 | **必须过 `browserAuth`** |

实证——`webServer.register` 的返回值就是个清理函数，说明它管的是静态路由表：

```js
webServer.register('/api/dsh-memory-probe')
// → () => { table.delete(route.path); }
```

`connection` 的完整面：

```
admit  authenticatedUrl  authorizeIndex  createSharedFetchHandler
register  registerFetchRoute  registerInterceptor  requestRejection
get rpc    → { handle, intercept }
get fetch  → { register: (route) => registerFetchRoute(owner, route) }
```

### 3.3 鉴权：页面内 fetch 自动通过

```js
requestRejection(request) {
	if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;   // Host/Origin 围栏
	return this.browserAuth.isAuthenticated(request) ? void 0 : 401;    // cookie 或 process-token
}
```

- 裸请求（curl / PowerShell）→ **401**，正常（没 cookie）
- **client 在页面内 `fetch('/api/...')`，同源，cookie 自动带上 → 通过** ✓
- 另有 `authenticatedUrl(baseUrl)` 把 launch token 拼进 URL（index 引导阶段用）

**所以不需要自己管 token。**

### 3.4 `connection.fetch.register(route)` 的 route 形状

从 `createSharedFetchHandler` 实现反推：

```js
route = {
	path: string,                     // 精确匹配：this.fetchRoutes.get(url.pathname)
	methods: Set<string>,             // route?.methods.has(method)
	handler: (request) => Response,   // 标准 Fetch 语义
	requestBody: 'buffered' | ...     // 可选
}
```

`path` 是**精确匹配**（`get(url.pathname)`），不是前缀路由 —— 路径必须写死。

### 3.5 会话数据 API（`sessionQuery` 实测方法表）

```
读取：  readEvent  readSession  readSurface  readWindow
        listEvents  filterEvents  searchEvents  traceEvent
        listSessions  filterSessions  searchSessions  traceSession
标题：  readTitle  readTitleSnapshot  readTitleSnapshots
订阅：  observeSession  close
```

另有 `sessions`（`get(id)` / `list()` / `fork` / `announce` …）与
`sessionController`（`inspect(id)` / `list(...)` / `prompt` / `cancel` …）。

**实测 `sessions.list()` 在启动瞬间返回空数组**（0 个活跃会话）。列历史会话要用
`sessionQuery.listSessions()`，或等会话建立后再取。

### 3.6 落地写法

**host 侧**：

```js
export const name = 'dsh-memory-sea';
export const inject = [];   // 别写 connection，桌面端缺失会炸；运行时探测更安全

export function apply(ctx) {
	let conn;
	try { conn = ctx.get('connection'); } catch { conn = undefined; }
	if (!conn || !conn.fetch) return;          // 降级：没有就退回 demo 场景

	const off = conn.fetch.register({
		path: '/api/dsh-memory-sea/scene',
		methods: new Set(['GET']),
		handler: async (request) => {
			const q = ctx.get('sessionQuery');
			const sessions = await q.listSessions({});      // 参数待调
			// …读事件、抽记忆点…
			return new Response(JSON.stringify({ points, edges }), {
				headers: { 'content-type': 'application/json' }
			});
		}
	});
	ctx.on('dispose', off);
}
```

**client 侧**：

```js
const res = await fetch('/api/dsh-memory-sea/scene');   // 同源，cookie 自动带
const scene = await res.json();
```

---

## 四、定位与边界（最重要的一节）

**这个插件是「观赏面」，不是「记忆面」。**

| | 做 | 不做 |
|---|---|---|
| 数据方向 | 宿主 → 插件 → 画布，**单向** | 绝不写回会话 |
| 上下文 | **完全不参与** | 不注入 recall、不改 systemPrompt、不注册 tool |
| 落盘 | 可以存快照，**只给插件自己读** | 不产生任何会被 AI 读到的东西 |
| 目的 | 把「她经历过的事」画出来看 | 不让 AI 记住、不跨会话回忆 |

### 明确不做（我上一版方案里错的部分）

| ❌ 不做 | 为什么 |
|---|---|
| `mem_recall` / `mem_store` 这类 tool | 注册 tool 就等于把内容塞进上下文 |
| `<memory-recall>` 注入 | 直接污染对话 |
| 读 `dsh-memory-tree` 的 SQLite | 它是**给 AI 用的记忆库**，我们不装也不接 |
| 读 `agentcairn` 的 vault | 同上，它的价值是语义检索，我们不需要 |
| embedding / 向量相似度 | 不做检索就不需要向量，省掉 1024 维存储和相似度计算 |

**只借鉴它们的「怎么提取、怎么建图、怎么编码视觉」，不借鉴「怎么喂给 AI」。**

---

## 五、从会话事件抽取什么

只读，单向。数据源唯一：`sessionQuery`（见第三节）。

| 事件 | 抽成什么 |
|---|---|
| `user/message` | 一个点（她说的） |
| `assistant/message` | 一个点（回答） |
| `tool/call` → `tool/result` | 一个点 + 一条边（做了什么、结果） |
| `compaction/summary` | **高价值点**（被压缩掉的精华，通常最长） |
| `turn/start` / `turn/end` | 边（同一轮的顺序） |
| `session/created` / `session/title` | 簇名 |
| `system/message` / `assistant/live-chunk` | **丢弃** |

消息体解析要兼容三种形态（见第二节）。

---

## 六、视觉映射（全部来自会话事件，无外部依赖）

| 星海元素 | 映射到 |
|---|---|
| **点** | 一条消息 / 一次工具调用 / 一段压缩摘要 |
| **边** | 同轮顺序、`tool/call`→`tool/result` 配对、时间邻接 |
| **点大小** | 文本长度 + 工具调用数（"重量"） |
| **颜色** | 消息类型（user / assistant / tool / compaction） |
| **变暗** | 时间越久越暗（或非当前会话） |
| **簇** | 会话（多会话叠加时）/ 时间窗口 |
| **半径分层** | 时间：越新越靠外，旧的沉到核心 |

**现有星海已经全支持**：点大小（现在按度数，改成按重量）、颜色（kind / 簇）、变暗（`aDim`）、曲线边、簇、分层。**视觉层不用改，只换数据源。**

---

## 七、实现路径

### 第 ① 步：当前会话 → 星海（只读，单向）

**host 侧**（`lib/index.js`）：

```js
export const name = 'dsh-memory-sea';
export const inject = [];      // 不声明，运行时探测；桌面端缺 connection 也不会炸

export function apply(ctx) {
	let conn;
	try { conn = ctx.get('connection'); } catch { conn = undefined; }
	if (!conn || !conn.fetch) return;        // 降级：client 退回 demo 场景

	const off = conn.fetch.register({
		path: '/api/dsh-memory-sea/scene',
		methods: new Set(['GET']),
		handler: async () => {
			const q = ctx.get('sessionQuery');       // 只读
			// listSessions → 取最近一个 → listEvents → 抽点抽边
			return json({ points, edges, clusters });
		}
	});
	ctx.on('dispose', off);
}
```

**关键约束**：
- 只调 `listSessions` / `listEvents` / `readSession` 这类**读**方法
- 不碰 `prompt` / `cancel` / `control`，不注册 tool，不碰 systemPrompt

**client 侧**：`fetch('/api/dsh-memory-sea/scene')`（同源自动带 cookie）→ `toGraph()` → 现有渲染。

**验收**：星海 = 当前会话的真实消息，点一颗星能看到原文。

### 第 ② 步：落盘快照（只给插件读）

```
~/.dsh/plugins/dsh-memory-sea/store/
├── scene.json        最近一次抽取的图（启动即渲染，不用等扫描）
└── meta.json         哪个会话、抽取时间、点数
```

用途：**下次打开面板时秒出画面**，不必重新扫全部事件。文件只被本插件读写，不进上下文、不进任何 AI 可见的位置。

**验收**：关掉再开面板，画面立刻出现（不闪 demo）。

### 第 ③ 步：多会话叠加（观赏用）

把多个会话的星海叠在一起，按会话分簇、按时间分层。**纯视觉，不做跨会话"回忆"** —— 用户切到哪个会话就高亮哪一簇。

**验收**：能看到"她这一路"的整体形状。

---

## 八、已确认（探针实测，不用再验）

1. ✅ 会话读取：`sessionQuery` 有 30+ 方法，`listEvents` / `readSession` / `observeSession` / `listSessions` 都在
2. ✅ 路由：API 用 `connection.fetch.register({path, methods, handler})`，`path` 精确匹配
3. ✅ 鉴权：页面内同源 `fetch` 自动带 cookie，不用管 token
4. ⚠️ `sessions.list()` 启动瞬间为空 → 列历史用 `sessionQuery.listSessions()`
5. ⚠️ `sessionQuery` 各方法的**参数形状**还没试出来（`toString()` 是 `[native code]`），第 ① 步写的时候要先用宽参数试错

**唯一还没确定的**：`listSessions()` / `listEvents()` 的参数形状。写第 ① 步时先用 `{}` 试，靠错误信息调整。
