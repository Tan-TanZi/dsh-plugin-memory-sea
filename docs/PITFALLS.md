# 踩过的坑

每一条都是真实发生过的：现象 → 根因 → 修法。
对应的自动断言在 `tools/audit-features.mjs` 里，改代码会先撞到它们。

---

## 一、白屏与构建

### 1.1 加了个功能，面板直接打不开

**现象**：面板白屏，控制台之外没有任何提示。

**根因**：`let` 的暂时性死区。

```js
function createRenderer(canvas) {
    const cb = hooks || {};
    labelCanvas = cb.labelCanvas || null;   // ← 这里赋值
    // …800 行之后…
    let labelCanvas = null;                 // ← 声明在这儿
}
```

赋值在声明之前，抛 `ReferenceError: Cannot access 'labelCanvas' before initialization`。
而 `createRenderer` 的调用**没包 try/catch**，异常穿出 `useEffect`，炸掉整棵组件树。

**修法**：声明提到函数第一行；外面再包一层兜底。

```js
let r = null;
try {
    r = createRenderer(canvas, sceneData, hooks);
} catch (e) {
    setFail("渲染器创建失败：" + e.message);   // 面板里显示红字，不是白屏
    return;
}
```

---

### 1.2 改了源码，功能没变化

**现象**：明明改了 `src/`，重启还是老行为。

**根因**：忘了 `node build.mjs`，`deploy.mjs` 把**旧的** `out/client.js` 部署上去了。

**修法**：`deploy.mjs` 检查 mtime —— 任何 `src/*.js` 比 `out/client.js` 新就拒绝部署。

---

### 1.3 PowerShell 把源码读成乱码

**现象**：用 `-replace` + `Set-Content` 改了一个 js 文件，中文全变 `锛?`，文件毁了。

**根因**：PowerShell 默认按 GBK 读 UTF-8 无 BOM 文件。

**修法**：**永远不用** `-replace` / `Set-Content` 改源码。
用编辑器工具，或者脚本里显式 `utf8NoBOM`。

---

## 二、渲染

### 2.1 点和线分离 / 线一直是全长

**现象**：第一阶段只有线，点是后来才冒出来；或者线从头到尾都是最终长度。

**根因**：`syncLinkMorph()` 用了一张 `linkVertBase` 索引表，表一旦和实际段数错位，
整批顶点拿不到起点，`aFrom` 停在最终位置。

**修法**：不查表，直接遍历全部顶点自己算：

```js
const VPL = perLinkSegs * 2;              // 每条边 12 个顶点
for (let v = 0; v < vcount; v += 1) {
    const li = Math.floor(v / VPL);
    const e = linkEnds[li];
    const t = Math.floor(((v - li * VPL) + 1) / 2) / segs;
    fa[v * 3] = ax + (bx - ax) * t;
    la[v] = Math.max(laA, laB);           // undefined → -1
}
```

---

### 2.2 一堆线挤在一起，然后慢慢拉开

**现象**：深探后结构不像预设好的样子，动画过程里还在变形。用户截到了中间态。

**根因**：`toGraph()` 每次新建节点，坐标是 `(0,0,0)`。
深探 rebuild 时 `warmStart` 保住的其实是这堆 0 —— 300 tick 从原点跑不开，
`position` 本身就是个未收敛的中间态。

**修法**：布局**之前**把旧坐标回填：

```js
const built = toGraph(scene_);
if (o.morphFrom && o.morphFrom.size) {
    for (const nd of built.nodes) {
        const p = o.morphFrom.get(nd.id);
        if (p) { nd.x = p.x; nd.y = p.y; nd.z = p.z; }
    }
}
radius = runLayout(built, c, o);          // 然后才布局
```

---

### 2.3 深探的动画"没了"

**现象**：整图重算后老节点瞬移，新节点的生长动画也不见了。

**根因**：给老节点填旧坐标、让它们"滑过去"，结果老树整片在动，
看起来就是结构还在算；同时 `newIds` 分支被 `morphFrom` 分支抢先，新枝不生长。

**修法**：深探的 `aFrom` 直接等于 `position` —— **位置不动，只做透明度**。

```js
fromAttr.setXYZ(i, fx, fy, fz);            // aFrom === position
layerAttr.setX(i, -1);                     // 老节点完全不参与
```

---

### 2.4 放大就卡

**根因**：点尺寸上限是 `h * dpr * 0.12`（1080p + dpr2 ≈ 240px）。
放大时每个点都顶到 240px，1200 个点 ≈ 6900 万像素 overdraw，屏幕才 200 万。

**修法**：上限压到 `h * dpr * 0.035`（≈70px），面积降到 1/12。
另外布局期间连线 buffer 有 864KB，改成**隔帧刷**。

---

### 2.5 抗锯齿失效

**根因**：用了 `EffectComposer` 之后，`WebGLRenderer({ antialias: true })` 不再生效 ——
后处理管线绕过了默认的 framebuffer。

**修法**：从 render target 拿 MSAA：

```js
new WebGLRenderTarget(w, h, { samples: 4, type: HalfFloatType })
```

并且 `EffectComposer` 在构造时**抓了一次** `renderer.getPixelRatio()`，
所以 `resize()` 里必须补一句 `composer.setPixelRatio(dpr)`。

---

## 三、交互

### 3.1 看着点在这儿，点不中

**现象**：拖过一次之后越来越严重，有时要转一下视角才能点中。

**根因**：`Raycaster` 读 `position`，GPU 画的是 `mix(aFrom, position, morphT())`。
两者在动画期间完全不同 —— 视觉位置和拾取位置错位。

**修法**：自己写屏幕空间拾取，在 CPU 上重放同一个 `morphAt()`。

---

### 3.2 拖完之后点不中任何东西

**根因**：`setPointerCapture` 之后没释放。`OrbitControls` 在 `enabled === false` 时
`pointerup` 直接 return，残留的捕获让后续事件全被那个元素吃掉。

**修法**：按下和松开时都主动释放：

```js
const onDown = (e) => {
    if (activePointerId >= 0) { try { canvas.releasePointerCapture(activePointerId); } catch {} }
    activePointerId = e.pointerId;
    // …
};
const onUp = (e) => {
    if (activePointerId >= 0) { try { canvas.releasePointerCapture(activePointerId); } catch {} activePointerId = -1; }
    // …
};
```

---

### 3.3 高亮段数拉到 12，还是只亮一跳

**根因**：向上回溯时用 `isHot` 当"已访问"标记，而直接父节点在第一跳就已经被标热了 ——
第二跳一看"它已经热了"就停下。

**修法**：单独用一个 `visit` Set 只防回头路，**不能**拿 `isHot` 判断。

---

### 3.4 静默覆盖了功能

**现象**：悬浮根节点时什么都不亮（原本应该整棵树 + 整条归属链都亮）。

**根因**：为了修 3.3，直接把"向下遍历子树"那段删了 —— 功能静默消失，没人发现。

**修法**：恢复三层高亮（自己 / 整棵子树 / 向上 N 节），并且加一条**正向**断言：

```js
must('高亮包含整棵子树', rend.includes('const down = [idx]'), '删了又没人知道');
```

**教训**：任何删除都要在回复里说出来，不能顺手带走。

---

### 3.5 观赏模式左右键反了

**根因**：进入观赏模式时改写了 `controls.mouseButtons`。

**修法**：**不改** `mouseButtons`，观赏模式靠 `pickAt()` 一进门就返回 `-1` 来屏蔽交互。

---

## 四、数据

### 4.1 有些会话只有一个点，没有轮次

**现象**：某些会话在图上孤零零一颗星，点开显示 `0 轮 · 0 条`，刷新插件又好了。

**根因**：索引器和前端在赛跑。`runIndex` 在 `apply()` 之后 4 秒才启动，
前端只拉一次 `/scene` —— 正好拿到索引跑到一半的数据。

**修法**：按 `phase` 轮询重拉，`ready` 那一次用 `noGrow + keepCamera` 平滑替换。

```js
if (!done && tries < 15) setTimeout(tick, 1800);
```

**副产物**：那真的空会话（新建没聊过）被误认为是 bug。
现在详情卡会明说「这个会话在宿主里没有任何对话记录」，并把 id 亮出来。

---

### 4.2 会话详情永远显示 `0 / 0 字`

**根因**：索引时 `userLen` / `assistantLen` 只累加到**轮次**上，
会话的 `stats` 里根本没有这两个字段。

**修法**：前端组装场景时按 `sessionId` 汇总一遍（1345 条，几毫秒），不用重跑索引。

```js
const agg = new Map();
for (const t of turns) {
    let a = agg.get(t.sessionId) || { userLen: 0, assistantLen: 0, toolCount: 0 };
    a.userLen += t.userLen || 0;
    agg.set(t.sessionId, a);
}
```

---

## 五、UI

### 5.1 详情卡显示一行 "false"

**根因**：

```js
kvRow("工具", detail.point.kind === "record" && detail.point.toolName)
```

对会话节点，`kind === "record"` 是 `false`，`&&` 短路返回 `false`，
`kvRow` 把它当字符串渲染出来了。

**修法**：按节点类型**分别组装字段**，而不是一堆 `kvRow` 并列 + 条件兜。
并列写法靠"碰巧不显示"，改一个类型必漏。

---

### 5.2 切换「名称 / 内容」没有任何区别

**根因**：`content` 分支写的是 `cut(p.text || p.title)`，
但会话和轮次的 point 上**没有 `text` 字段**，于是退回 `title` —— 和 `name` 一模一样。

**修法**：三层各有各的来源。

| | 名称 | 内容 |
|---|---|---|
| 会话 | 标题 | `digest`（该会话第一轮的开头） |
| 轮次 | 第 N 轮 | `subtitle`（首条消息） |
| 消息 | 你·bash | `preview`（正文） |

---

### 5.3 勾上「消息」标签，什么都没有

**根因**：逻辑写着"消息只在悬停时才出标签"（`focal >= 0`），
不带焦点时一条都不给 —— 用户当然认为开关坏了。

**修法**：两种情形都覆盖，无焦点时**抽样**（上限 2000 个候选，避免两万次投影）。

---

### 5.4 缩得越小，标签越少

**根因**：矩形避让。缩小时几百个标签的屏幕坐标挤在同一片区域，
第一个放下后其余全部重叠 → 全被丢掉。

**修法**：加「允许重叠」开关，跳过避让。默认仍避让（一进来就糊成一片更糟）。

---

### 5.5 `position: fixed` 被关在自己的面板里

**根因**：面板容器上有 `backdrop-filter: blur()`。
`backdrop-filter` / `transform` / `filter` 都会**创建 stacking context** ——
后代元素的 `fixed` 不再相对视口，而是相对这个祖先，`z-index` 也只在容器内竞争。

**现状**：所以画布跳不出面板层，别的插件面板能盖在它上面。
解法是「排除元素」—— 用户自己填要藏掉的 class / id。

### 5.6 侧边栏一收起，画布左边空出一大块

**现象**：截图里左侧 300 多像素完全空白，星图挤在右边。

**根因**：`place()` 里 `left` / `width` 取的是面板的 `getBoundingClientRect()`，
而它只在两个时机重算：

```js
const ro = new ResizeObserver(place);   // 只监听尺寸
const poll = setInterval(place, 250);   // 但 20 次 × 250ms 就 clearInterval
```

侧边栏收起时面板**左移且变宽** —— `ResizeObserver` 理应触发，但收起动画期间
面板的尺寸可能被父容器约束住（宽度不变、只改 left），于是它不触发；
而 5 秒的补位轮询早就结束了。画布就停在旧坐标。

**修法**：加一路**常驻**低频跟随，并且只在几何真的变了时才写样式：

```js
const key = Math.round(r.left) + "," + Math.round(r.width) + "," + window.innerHeight;
if (key === lastGeom) return;
lastGeom = key;
...
const watch = setInterval(place, 800);   // 不 clear，卸载时清
```

**教训**：`ResizeObserver` 只保证"尺寸变了叫你"，**不保证"位置变了叫你"**。
任何依赖元素位置的 fixed 定位，都要自己盯着位置。

### 5.7 样式键拼错 → 元素静默丢全部样式

**现象**：某个按钮突然贴到左上角、没有边框没有底色，但控制台一声不响。

**根因**：`style: S.aboutrow` 少写一个大写字母，`S.aboutrow` 是 `undefined`，
React 收到 `style={undefined}` 不会报错，元素就退化成无样式。

**修法**：加 `tools/verify-layout.mjs`，检查每个 `S.xxx` 引用在文件里都有 `key:` 定义。

写这个检查时先后踩了两个坑：

1. **按缩进切分**会漏 —— 样式对象里缩进并不统一（后加的用 2 空格，原有的 4 空格）
2. **按括号深度切分**也会漏 —— 自写的括号计数在 `"rgba(0,0,0,.18)"` 这类字符串上失真
3. **反查死样式**会刷屏 —— 它把 `DOCK_GROUPS` 的配置项（`bloomStrength`、`nodeSize`）
   和嵌套 CSS 属性全判成死样式

最后只保留最朴素的一条：**被引用的键，必须能在文件里找到 `key:` 定义**。
粗糙，但正好覆盖要防的那类事故。

---

## 六、工具链

### 6.1 断言自己被自己骗了

写 `must('排除不在画布控制台', !shell.includes('excludeBox'))`，
结果永远失败 —— 因为**样式表里有个同名的 key** `excludeBox`，`indexOf` 先命中了它。

**修法**：断言要盯**具体用法**而不是名字，比如 `style: S.excludeBox`。

### 6.2 注释里的 `*/` 提前闭合了块注释

```js
/* 所有 show*/hiddenSessions 都必须被读到 */
//          ↑ 这里把注释闭合了，后面全是语法错误
```

**修法**：注释里避免出现 `*/` 这种字符组合。

---

## 七、安装与部署

### 7.1 插件列表显示「异常」，但文件明明都在

**现象**：`plugins\dsh-plugin-memory-sea\` 里 `package.json`、`lib\` 一个不少，
`profile\package.json` 的 `dependencies` 和 `bundles` 也都写了，插件列表却是红色的「异常」。

**根因**：**`node_modules` 里没有这个包。**

宿主的 bundle 解析走的是 Node 的模块解析 —— 它认 `node_modules`，不认
`plugins\` 目录。`file:` 依赖只是告诉包管理器"该从哪里装"，
真正被 `require` 到的是 `node_modules\dsh-plugin-memory-sea\`。

**修法**：三处都要有东西，缺一不可。

| 位置 | 内容 |
|---|---|
| `plugins\dsh-plugin-memory-sea\` | 完整插件（含 store） |
| `profiles\desktop\node_modules\dsh-plugin-memory-sea\` | `package.json` + `cordis.patch.yml` + `lib\` |
| `profiles\desktop\package.json` | `dependencies` 一行 + `bundles` 一项 |

**排查顺序**（由外到内，一分钟能定位）：

1. `plugins` 目录在不在？
2. `node_modules` 目录在不在？← **八成问题在这一步**
3. `package.json` 里两处引用在不在？
4. `lib\client.js` 在不在？（缺它 = 白屏，缺 `lib\index.js` = 没数据）

**教训**：手动安装的说明里，"复制到 plugins" 只是第一步。
不写清 `node_modules` 那一步，用户装完看到「异常」会以为插件本身坏了。

---

## 通用教训

1. **结构先算完，再播动画。** 反过来的话，用户截到的"动画"其实是没算完的结构。
2. **位置不动，只做透明度。** 只要点在动，就永远解释不清"这是动画还是没算完"。
3. **删除必须在回复里说出来。** 静默删功能比留 bug 更糟。
4. **断言要能证明"功能还在"，不能只证明"代码里有这个词"。**
5. **超过三轮修不好，加诊断而不是盲改。** 控制台打印关键状态，让用户能贴回来。
