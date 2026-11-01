/**
 * 外壳：三个 slot、面板、面板内效果控制台、设置页、配置 store、主题 token。
 *
 * 分工（这一版的产品决策）：
 *   · 「设置 → 记忆海」只放不常动的东西：画布背景、数据状态、恢复默认。
 *   · 所有**效果类**参数搬进面板右侧的悬浮控制台 —— 调一下立刻看得见，
 *     对着效果捏滑杆，不用来回跳设置页。
 *
 * 8 套风格预设与 6 套配色来自 galaxy-view（MIT），数值原样，见 presets.js。
 *
 * 沿用上一版验收过的部分：三个 slot 串联、主题 token（不填 accent 底）、
 * 详情卡锁定（方向锁定 + 1.5px 死区）、「设置」按钮的 DOM 跳转。
 *
 * ★ 2026-11-01 本文件从构建产物反向恢复（PowerShell 写坏了原文件：UTF-8 被按
 *   GBK 读入，中文不可逆丢失）。逻辑与最后一版构建完全一致，丢的是行内注释。
 *   以后改代码用 edit 工具，**不要**用 PowerShell 的 -replace / Set-Content
 *   整文件重写 —— 那会再次踩同一个坑。
 */
import { DEMO } from './scene.js';
import { fetchLiveScene, toLiveScene, describeEnv } from './live.js';
import {
	buildSessionAddon, mergeAddon, removeSessionAddon, spawnMapFor,
	snapshotPositions, cacheStats, clearCache
} from './deepdive.js';
import { createRenderer } from './render.js';
import { STYLE_PRESETS, THEMES, presetById, presetPatch, presetIsDirty } from './presets.js';
import { LAYOUT_DEFAULTS } from './layout.js';

  export var PANEL_ID = "memory-sea";
  var NS = "dsh-plugin-memory-sea";
  /*
   * 构建时由 build.mjs 注入（esbuild define）。
   * 兜底值只为「不经过构建直接读源码」时不出错，正常产物里一定是真实版本。
   */
  var APP_VERSION = typeof __MS_VERSION__ !== "undefined" ? __MS_VERSION__ : "0.0.0";
  var APP_REPO = typeof __MS_REPO__ !== "undefined" ? __MS_REPO__ : "https://github.com/Tan-TanZi/dsh-plugin-memory-sea";
  /*
   * 系统级设置：这些键由「设置 → 记忆海」页负责，画布控制台的「重置系统」不许碰。
   * 两个地方各有各的重置按钮，跨界面清空属于职责越界（用户实测踩到过）。
   */
  export var SYSTEM_KEYS = ["fullBleed", "bgColor", "bgAlpha", "bgBlur", "excludeSelectors"];
  /*
   * 配置存储 key —— **刻意保持旧名**。
   * 它只是 localStorage 的键，跟包名无关；一旦跟着改名，
   * 用户已经调好的预设、配色、过滤全部丢失。改了没有任何收益。
   */
  var CFG_KEY = "dsh-memory-sea:v3";
  var react = null;
  var h = null;
  export function setReact(r) {
    react = r;
    h = r.createElement;
  }
  export var CFG_DEFAULT = {
    /* 预设 */
    preset: "galaxy",
    /* 外观 */
    bloom: true,
    bloomStrength: 0.35,
    bloomRadius: 0.35,
    bloomThreshold: 0.22,
    nodeSize: 1,
    sizeBy: "level",
    /* 默认按层级：工作区 > 会话 > 轮次 > 消息，一眼看出结构 */
    linkOpacity: 0.22,
    linkCurve: 0.35,
    twinkle: 0.5,
    /* 深空 */
    starfield: true,
    nebula: 0.35,
    fieldStars: 0.25,
    clusterClouds: 0.3,
    /* 力学 */
    repel: LAYOUT_DEFAULTS.repel,
    linkDistance: LAYOUT_DEFAULTS.linkDistance,
    linkStrength: LAYOUT_DEFAULTS.linkStrength,
    centerPull: LAYOUT_DEFAULTS.centerPull,
    flatten: LAYOUT_DEFAULTS.flatten,
    coreGravity: LAYOUT_DEFAULTS.coreGravity,
    spiral: LAYOUT_DEFAULTS.spiral,
    /* 分组：每个项目(cwd)一个独立星系 */
    clusterSpread: LAYOUT_DEFAULTS.clusterSpread,
    clusterPull: LAYOUT_DEFAULTS.clusterPull,
    /* 视角 */
    frameElevDeg: 50,
    /* 配色：默认按项目（cwd）分色 —— 18 个项目 18 种色，一眼分得出星系；
       按类型（kind）只是一片深浅不同的蓝，分不出谁是谁 */
    colorBy: "theme",
    theme: "hubble",
    themeSeed: 0,
    /* 交互 */
    drift: true,
    driftSpeed: 1,
    /* 生长动画总时长（ms）：分层显形，一层一层抽枝。
       0.4 秒内全部长完人眼分不出层次，只会看到"一起炸开" */
    growMs: 5e3,
    /* 悬停高亮：自身 + 向下整棵子树；再沿父链向上数这么多「节」。
       3 节 = 消息 → 轮次 → 会话，一眼看清"这条属于哪儿" */
    focusDepth: 3,
    /* Ctrl 拖动整簇的弹簧：刚度越大追得越紧，阻尼越小晃得越久 */
    dragStiffness: 0.22,
    dragDamping: 0.82,
    /* 观赏模式：不响应悬停高亮和点击，鼠标映射保持默认 */
    readOnly: false,
    /* 悬浮详情：鼠标划过星点就弹卡片，移开自动关（不解锁点击、不推镜头） */
    hoverDetail: false,
    /* 筛选：按类型藏点。关掉某类，图里就不显示这类消息（连线一起消失） */
    showUser: true,
    showAssistant: true,
    showTool: true,
    showCompaction: true,
    /* 结构层级：轮次层。关掉 = 只看会话星（概览） */
    showTurn: true,
    /*
     * 会话是根，所以用「选择」而不是开关 —— 一个总开关关掉等于整张图全没。
     * 这里存被**隐藏**的会话 id，空数组 = 全部显示。
     */
    hiddenSessions: [],
    /*
     * 排除元素：用户自己填宿主那边要藏起来的 id / class，一行一个。
     * 通过注入 <style> 临时隐藏，清空即恢复 —— 不改宿主元素的 inline style，
     * 也不会和宿主自己的渲染逻辑打架。
     */
    excludeSelectors: "",
    /* 标签：默认关。按类型挑给谁画，写「名称」还是「内容」也分开选 */
    labels: false,
    labelMax: 40,
    labelChars: 20,
    labelOnSession: true,
    labelOnTurn: true,
    labelOnRecord: false,
    labelField: "content",
    /* 标签重叠：false = 自动避让（干净）；true = 全画（缩小时不丢） */
    labelOverlap: false,
    /* 性能档：auto/high 用满 DPR；low/mobile 把 DPR 钳到 1 */
    perfTier: "auto",
    /* 超采样：以 base×ssaa 渲染再降采样。1 / 1.5 / 2，像素量按平方增长 */
    ssaa: 1,
    /* 画布背景 */
    bgColor: "#05060b",
    bgAlpha: 100,
    bgBlur: 0,
    /* 视图：画布是否铺满到窗口最顶部（标题栏后面）。关掉则只在面板区域内绘制 */
    fullBleed: true
  };
  var cfg = Object.assign({}, CFG_DEFAULT);
  var listeners = /* @__PURE__ */ new Set();
  var HEX6 = /^#?([0-9a-fA-F]{6})$/;
  function panelBg(color, alpha) {
    const m2 = HEX6.exec(String(color == null ? "" : color));
    const hex = m2 ? m2[1] : "05060b";
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const n = Number(alpha);
    const a2 = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 1;
    return "rgba(" + r + "," + g + "," + b + "," + a2 + ")";
  }
  function panelBlur(px) {
    const n = Number(px);
    if (!Number.isFinite(n) || n <= 0) return "none";
    return "blur(" + Math.max(0, Math.min(40, n)) + "px)";
  }
  function loadCfg() {
    try {
      const raw = window.localStorage.getItem(CFG_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p || typeof p !== "object") return;
      for (const k of Object.keys(CFG_DEFAULT)) {
        if (p[k] !== void 0 && typeof p[k] === typeof CFG_DEFAULT[k]) cfg[k] = p[k];
      }
    } catch (e) {
    }
  }
  function saveCfg() {
    try {
      window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    } catch (e) {
    }
  }
  export function setCfg(patch) {
    cfg = Object.assign({}, cfg, patch);
    saveCfg();
    listeners.forEach((fn) => {
      try {
        fn(cfg);
      } catch (e) {
      }
    });
  }
  export function onCfg(fn) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }
  loadCfg();
  function layoutKey(c2) {
    return [c2.repel, c2.linkDistance, c2.linkStrength, c2.centerPull, c2.flatten, c2.coreGravity, c2.spiral, c2.clusterSpread, c2.clusterPull].join("|");
  }
  function colorKey(c2) {
    return c2.colorBy + "|" + c2.theme + "|" + (Number(c2.themeSeed) || 0);
  }
  function sizeKey(c2) {
    return c2.sizeBy || "level";
  }
  function geometryKey(c2) {
    return layoutKey(c2);
  }
  var T = {
    border: "var(--dsw-alias-border-secondary, var(--dsw-alias-border-l2, rgba(128,128,128,.28)))",
    surface: "var(--dsw-alias-bg-secondary, var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)))",
    elevated: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12))",
    link: "var(--dsw-alias-link, var(--dsw-alias-brand-text, #4a86ff))",
    caption: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)))"
  };
  var CARD_W = 340;
  var CARD_H = 300;
  var RECORD_LABEL = {
    user: "消息 · 你",
    assistant: "消息 · 她",
    tool: "消息 · 工具调用",
    compaction: "消息 · 压缩摘要"
  };
  function detailKindLabel(p) {
    if (!p) return "";
    if (p.kind === "session") return "会话";
    if (p.kind === "turn") return "一轮对话";
    if (p.kind === "record") return RECORD_LABEL[p.recordKind] || "消息";
    if (p.diary) return "她的日记 · " + p.diary.date;
    return KIND_LABEL[p.kind] || p.kind;
  }
  function kvRow(k, v) {
    if (v === void 0 || v === null || v === "") return null;
    return h(
      "div",
      { style: { display: "flex", gap: 8, fontSize: 11.5, lineHeight: 1.75 } },
      h("span", { style: { flex: "0 0 auto", width: 48, opacity: 0.45 } }, k),
      h("span", { style: { flex: "1 1 auto", minWidth: 0, wordBreak: "break-word" } }, String(v))
    );
  }
  function placeCard(at, panelW, panelH, flip) {
    const gap = 14;
    const W = panelW > 40 ? panelW : 1200;
    const H = panelH > 40 ? panelH : 800;
    const hasAt = at && Number.isFinite(at.x) && Number.isFinite(at.y);
    if (!hasAt) return { left: Math.max(8, W - CARD_W - gap), top: Math.max(8, H - CARD_H - gap) };
    let left;
    let top;
    const locked = flip && typeof flip.x === "boolean" && typeof flip.y === "boolean";
    if (locked) {
      left = flip.x ? at.x - gap - CARD_W : at.x + gap;
      top = flip.y ? at.y - gap - CARD_H : at.y + gap;
    } else {
      left = at.x + gap;
      top = at.y + gap;
      if (left + CARD_W > W - 8) left = at.x - gap - CARD_W;
      if (top + CARD_H > H - 8) top = at.y - gap - CARD_H;
    }
    left = Math.max(8, Math.min(left, Math.max(8, W - CARD_W - 8)));
    top = Math.max(8, Math.min(top, Math.max(8, H - CARD_H - 8)));
    return { left, top };
  }
  function flipFor(at, panelW, panelH) {
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return { x: false, y: false };
    const W = panelW > 40 ? panelW : 1200;
    const H = panelH > 40 ? panelH : 800;
    return { x: at.x + 14 + CARD_W > W - 8, y: at.y + 14 + CARD_H > H - 8 };
  }
  var S = {
    /*
     * 面板容器：让画布铺到窗口最顶部（含窗口标题栏那条带子）。
     *
     * 宿主（DSH）在 root 上发布 `--dsh-frame-top-clearance`：macOS 48px，
     * Windows 是 caption 高度。它自己的文档写的是「entry pages in the main panel …
     * pad their top by it」—— 说明**内容区本来就从窗口顶部开始**，
     * 宿主用 padding 把内容往下推，由内容自己负责避让。
     *
     * 所以：负 margin 吃掉这段 padding、再补回同等高度，画布就顶到最上面；
     * HUD / 控制台各自把自己的 top 加回 clearance，仍然避开标题栏和窗口按钮。
     * Web 版没有这个变量，兜底 0px，行为不变。
     */
    /*
     * 面板保持宿主给的正常区域（从标题栏下沿开始），不再上移。
     * 画布是独立的 fixed 元素，自己会铺到窗口顶部 —— 面板跟着上移反而会
     * 把 HUD 顶到标题栏里，还要处处补 clearance。现在只有画布动，其他都不动。
     */
    panel: {
      position: "relative",
      width: "100%",
      height: "100%",
      minHeight: 0,
      overflow: "hidden",
      borderRadius: 0
    },
    /*
     * 画布：定位方式由 cfg.fullBleed 决定，全部由 placeCanvas() 在运行时写。
     *   fullBleed = true  → position: fixed，从窗口 y=0 铺到底（穿过标题栏区）
     *   fullBleed = false → position: absolute，只铺满面板
     *
     * 为什么铺满必须 fixed：
     *   .BynINW_frame 有 `padding-top: 48px`（标题栏高度）+ `overflow: hidden`，
     *   main slot 的列都在 padding 之后，任何上溢都被裁掉 —— 在正常流里改负 margin
     *   没用（试过，白调）。
     *   fixed 的包含块是视口，不受祖先 overflow 裁剪（祖先没有 transform）。
     *
     * 窗口按钮是 Electron 原生绘制的，永远在网页之上，不必担心被挡。
     * 横向不给 100vw —— 那会盖住左侧栏；由 placeCanvas() 按 main 区域的 rect 定位。
     */
    canvas: { display: "block", zIndex: 0 },
    hud: {
      position: "absolute",
      background: T.elevated,
      border: "1px solid " + T.border,
      borderRadius: 12,
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      boxShadow: "0 8px 28px rgba(0,0,0,.18)",
      zIndex: 2,
      color: "inherit"
    },
    /* HUD / 控制台把 top 加回 clearance —— 画布可以顶到最上面，但文字不能压到窗口标题栏上 */
    top: { top: 10, left: 10, padding: "10px 14px", maxWidth: 320 },
    title: { margin: "0 0 4px", fontSize: 15, fontWeight: 600, letterSpacing: ".10em", color: T.link },
    sub: { fontSize: 12, opacity: 0.65 },
    stats: { marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, opacity: 0.85 },
    statB: { fontWeight: 600 },
    detail: { width: CARD_W, padding: "12px 14px", maxHeight: "52%", overflow: "auto", zIndex: 4 },
    detailK: { fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", opacity: 0.6 },
    detailText: { margin: "6px 0 10px", fontSize: 14, lineHeight: 1.6, wordBreak: "break-word", whiteSpace: "pre-wrap" },
    detailRow: { display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, opacity: 0.7 },
    tags: { marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 },
    tag: { display: "inline-block", padding: "1px 8px", borderRadius: 999, background: T.surface, border: "1px solid " + T.border, fontSize: 11, opacity: 0.9 },
    tools: { left: 10, bottom: 10, padding: 7, display: "flex", gap: 6, alignItems: "center", zIndex: 2 },
    toolsDivider: { width: 1, height: 16, background: T.border, opacity: 0.55, margin: "0 2px", flexShrink: 0 },
    btn: {
      background: "transparent",
      color: "inherit",
      border: "1px solid " + T.border,
      borderRadius: 8,
      padding: "5px 10px",
      fontSize: 12,
      cursor: "pointer",
      opacity: 0.85
    },
    /* 选中态：不填底，只换边框色 + 加粗 —— 绝不会白底白字 */
    btnOn: { borderColor: T.link, opacity: 1, fontWeight: 600 },
    hint: { position: "absolute", left: "50%", bottom: 12, transform: "translateX(-50%)", fontSize: 12, color: T.caption, zIndex: 2, whiteSpace: "nowrap", pointerEvents: "none" },
    fail: { position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, textAlign: "center", fontSize: 13, lineHeight: 1.8, color: "#ff9a9a", zIndex: 6 },
    /* 控制台 */
    dock: {
      position: "absolute",
      top: 10,
      right: 10,
      width: 268,
      zIndex: 3,
      padding: 10,
      display: "flex",
      flexDirection: "column",
      gap: 8,
      /* 高度封顶 500px；窗口更矮时退让，给左下工具栏和标题留位置。
         内部滚动，不撑破面板。 */
      maxHeight: "min(500px, calc(100% - 92px))",
      overflowY: "auto",
      overflowX: "hidden",
      /* 细一点的滚动条，免得把 268px 的宽度吃掉太多 */
      scrollbarWidth: "thin"
    },
    dockBar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
    dockTitle: { fontSize: 12, letterSpacing: ".08em", opacity: 0.7 },
    presetGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 },
    presetBtn: (on) => ({
      padding: "6px 4px",
      fontSize: 12,
      cursor: "pointer",
      borderRadius: 7,
      border: "1px solid " + (on ? T.link : T.border),
      background: "transparent",
      color: "inherit",
      fontWeight: on ? 600 : 400,
      opacity: on ? 1 : 0.78
    }),
    dockGroup: { borderTop: "1px solid " + T.border, paddingTop: 6 },
    dockHead: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      background: "transparent",
      border: "none",
      color: "inherit",
      padding: "4px 0",
      fontSize: 12,
      cursor: "pointer",
      opacity: 0.85
    },
    caret: { opacity: 0.5, fontSize: 13, lineHeight: 1 },
    dockBody: { display: "flex", flexDirection: "column", gap: 7, paddingBottom: 4 },
    sliderRow: { display: "flex", flexDirection: "column", gap: 2 },
    sliderTop: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
    sliderLabel: { fontSize: 11.5, opacity: 0.8 },
    sliderValue: { fontSize: 11, fontVariantNumeric: "tabular-nums", opacity: 0.6 },
    sliderRange: { display: "flex", justifyContent: "space-between", fontSize: 9.5, opacity: 0.32, marginTop: -1 },
    /* 排除选择器输入框 */
  excludeBox: {
    width: "100%",
    minHeight: 54,
    resize: "vertical",
    boxSizing: "border-box",
    padding: "5px 7px",
    borderRadius: 6,
    border: "1px solid " + T.border,
    background: "rgba(8,12,24,.42)",
    color: "inherit",
    font: "11px ui-monospace, SFMono-Regular, Menlo, monospace",
    lineHeight: 1.5,
    outline: "none"
  },
  /* 会话选择列表（按项目分组的勾选，可滚动） */
  pickList: {
    marginTop: 6,
    padding: "6px 6px 2px",
    borderRadius: 6,
    background: "rgba(8,12,24,.42)",
    border: "1px solid rgba(140,180,255,.16)",
    maxHeight: 190,
    overflowY: "auto"
  },
  dockSrc: { fontSize: 9.5, opacity: 0.4, marginRight: 6 },
  /* 分组内部的小标题（过滤 → 节点筛选 / 标签） */
  subHead: {
    fontSize: 10.5,
    fontWeight: 600,
    opacity: 0.55,
    letterSpacing: "0.04em",
    margin: "10px 0 5px"
  },
    range: { width: "100%", accentColor: T.link, cursor: "pointer", height: 16 },
    wrap: { display: "flex", flexDirection: "column", gap: 18, padding: "4px 0 8px", maxWidth: 640 },
    lead: { fontSize: 12, opacity: 0.7, lineHeight: 1.7 },
    card: { display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", borderRadius: 12, border: "1px solid " + T.border, background: T.surface },
    cardTitle: { fontSize: 13, fontWeight: 600 },
    cardDesc: { fontSize: 12, opacity: 0.7, lineHeight: 1.6 },
    /* 关于：左标签右值，值用等宽字 */
    aboutRow: { display: "flex", alignItems: "baseline", gap: 12, fontSize: 12.5 },
    aboutKey: { flex: "0 0 auto", width: 40, opacity: 0.5 },
    aboutLink: { color: T.link, textDecoration: "none", wordBreak: "break-all", fontSize: 12 },
    row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
    rowText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
    rowLabel: { fontSize: 13 },
    rowHint: { fontSize: 11, opacity: 0.6, lineHeight: 1.5 },
    value: { fontSize: 12, fontVariantNumeric: "tabular-nums", opacity: 0.8, minWidth: 44, textAlign: "right" },
    colorWrap: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
    swatch: { width: 44, height: 26, padding: 0, cursor: "pointer", border: "1px solid " + T.border, borderRadius: 6, background: "transparent" },
    mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, opacity: 0.65, lineHeight: 1.7 },
    primary: { padding: "6px 14px", fontSize: 12, cursor: "pointer", borderRadius: 8, border: "1px solid " + T.border, background: "transparent", color: "inherit" }
  };
  function MemorySeaIcon(props) {
    const size = props && props.size || 20;
    const active = !!(props && props.active);
    const dot = active ? 1.5 : 1.15;
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 20 20",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
        "data-memorysea-icon": "1"
      },
      h("path", { d: "M10 10 L4 5.4 M10 10 L16 5.8 M10 10 L5.8 15 M10 10 L15.4 14.6", opacity: active ? 0.85 : 0.5 }),
      h("circle", { cx: 10, cy: 10, r: dot + 0.35, fill: "currentColor", stroke: "none" }),
      h("circle", { cx: 4, cy: 5.4, r: dot, fill: "currentColor", stroke: "none" }),
      h("circle", { cx: 16, cy: 5.8, r: dot, fill: "currentColor", stroke: "none" }),
      h("circle", { cx: 5.8, cy: 15, r: dot, fill: "currentColor", stroke: "none" }),
      h("circle", { cx: 15.4, cy: 14.6, r: dot, fill: "currentColor", stroke: "none" })
    );
  }
  var SETTINGS_LABEL = "记忆海";
  var settingsBusy = false;
  function mlog() {
    try {
      const args = Array.prototype.slice.call(arguments);
      console.log.apply(console, ["[dsh-plugin-memory-sea]"].concat(args));
    } catch (e) {
    }
  }
  function normText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, "");
  }
  var NAV_SELECTORS = ["nav button", '[role="navigation"] button', '[role="tablist"] button', 'button[role="tab"]'];
  function isHostSidebarNav(nav) {
    try {
      return !!nav.querySelector('[data-memorysea-icon="1"]');
    } catch (e) {
      return false;
    }
  }
  function findSettingsDialog() {
    let dialogs;
    try {
      dialogs = document.body.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    } catch (e) {
      return null;
    }
    for (let i = 0; i < dialogs.length; i += 1) {
      let r = null;
      try {
        r = dialogs[i].getBoundingClientRect();
      } catch (e) {
        r = null;
      }
      if (r && r.width > 240 && r.height > 200) return dialogs[i];
    }
    return null;
  }
  function clickSettingsRow(quiet, scope) {
    const root = scope || findSettingsDialog();
    if (!root) {
      if (!quiet) mlog("没有设置对话框，跳过 nav 行匹配");
      return false;
    }
    const want = normText(SETTINGS_LABEL);
    const all = [];
    for (let i = 0; i < NAV_SELECTORS.length; i += 1) {
      let found = null;
      try {
        found = root.querySelectorAll(NAV_SELECTORS[i]);
      } catch (e) {
        found = null;
      }
      if (!found) continue;
      for (let j = 0; j < found.length; j += 1) if (all.indexOf(found[j]) < 0) all.push(found[j]);
    }
    if (!quiet) mlog("对话框内 nav 候选 " + all.length + " 个");
    let loose = null;
    for (let i = 0; i < all.length; i += 1) {
      const btn = all[i];
      const txt = normText(btn.textContent);
      if (txt === want) {
        try {
          btn.click();
          if (!quiet) mlog("精确命中 nav 行");
          return true;
        } catch (e) {
          return false;
        }
      }
      if (!loose && txt.indexOf(want) >= 0) loose = btn;
    }
    if (loose) {
      try {
        loose.click();
        if (!quiet) mlog("包含命中的 nav 行");
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }
  function findSettingsTrigger(quiet) {
    const re = /(设置|偏好设置|Settings|Preferences)/i;
    const self2 = normText(SETTINGS_LABEL);
    let navBtns = null;
    try {
      navBtns = document.body.querySelectorAll("nav button");
    } catch (e) {
      navBtns = null;
    }
    if (navBtns) {
      for (let i = 0; i < navBtns.length; i += 1) {
        const btn = navBtns[i];
        const txt = (btn.textContent || "").trim();
        if (normText(txt).indexOf(self2) >= 0) continue;
        if (re.test(txt) || re.test(btn.getAttribute("aria-label") || "") || re.test(btn.getAttribute("title") || "")) {
          if (!quiet) mlog("侧栏 nav 命中设置钮");
          return btn;
        }
      }
    }
    let cands = null;
    try {
      cands = document.body.querySelectorAll('[aria-haspopup="dialog"], [aria-haspopup="menu"]');
    } catch (e) {
      cands = null;
    }
    if (cands) {
      for (let i = 0; i < cands.length; i += 1) {
        const el = cands[i];
        const txt = (el.textContent || "").trim();
        if (re.test(txt) || re.test(el.getAttribute("aria-label") || "") || re.test(el.getAttribute("title") || "")) {
          if (!quiet) mlog("aria-haspopup 命中设置钮");
          return el;
        }
      }
    }
    if (!quiet) mlog("设置触发钮未找到（nav " + (navBtns ? navBtns.length : 0) + " / haspopup " + (cands ? cands.length : 0) + "）");
    return null;
  }
  function findMenuTrigger(quiet) {
    let cands = null;
    try {
      cands = document.body.querySelectorAll('[aria-haspopup="menu"], [aria-haspopup="dialog"], [aria-haspopup="true"]');
    } catch (e) {
      return null;
    }
    for (let i = 0; i < cands.length; i += 1) {
      const el = cands[i];
      let r = null;
      try {
        r = el.getBoundingClientRect();
      } catch (e) {
        r = null;
      }
      if (!r || r.width <= 0 || r.height <= 0) continue;
      let n = el.parentElement;
      let inSidebar = false;
      for (let k = 0; k < 6 && n; k += 1) {
        if (n.tagName === "NAV" && isHostSidebarNav(n)) {
          inSidebar = true;
          break;
        }
        n = n.parentElement;
      }
      if (inSidebar) continue;
      if (!quiet) mlog("菜单按钮候选命中");
      return el;
    }
    return null;
  }
  function findSettingsMenuItem(quiet) {
    let items = null;
    try {
      items = document.body.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] a');
    } catch (e) {
      return null;
    }
    const re = /(设置|偏好设置|Settings|Preferences)/i;
    for (let i = 0; i < items.length; i += 1) {
      const el = items[i];
      const txt = (el.textContent || "").trim();
      if (re.test(txt) || re.test(el.getAttribute("aria-label") || "")) {
        if (!quiet) mlog("菜单里命中设置项");
        return el;
      }
    }
    if (!quiet) mlog("菜单里没找到设置项（候选 " + (items ? items.length : 0) + " 个）");
    return null;
  }
  function sendSettingsHotkey() {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(String(navigator.platform || navigator.userAgent || ""));
    const make = () => new KeyboardEvent("keydown", {
      key: ",",
      code: "Comma",
      bubbles: true,
      cancelable: true,
      ctrlKey: !isMac,
      metaKey: isMac
    });
    let ok = false;
    try {
      document.dispatchEvent(make());
      ok = true;
    } catch (e) {
    }
    try {
      window.dispatchEvent(make());
      ok = true;
    } catch (e) {
    }
    mlog("快捷键 " + (isMac ? "Cmd+," : "Ctrl+,") + (ok ? " 已派发" : " 派发失败"));
    return ok;
  }
  function openMemorySeaSettings() {
    if (typeof document === "undefined") {
      mlog("无 document，跳过");
      return;
    }
    if (settingsBusy) {
      mlog("上一轮还没结束，忽略");
      return;
    }
    settingsBusy = true;
    let done = false;
    let hotkeySent = false;
    let triggerClicked = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      settingsBusy = false;
      mlog("结束：" + reason);
      if (reason !== "已打开") {
        try {
          const btn = document.querySelector('[data-memorysea-settings-btn="1"]');
          if (btn) btn.title = "自动打开没成功：按 Ctrl+,（Mac 为 Cmd+,）或点左栏设置入口";
        } catch (e) {
        }
      }
    };
    mlog("开始跳转设置页");
    if (clickSettingsRow()) {
      finish("已打开");
      return;
    }
    const trigger = findSettingsTrigger();
    if (trigger) {
      try {
        trigger.click();
        triggerClicked = true;
      } catch (e) {
        mlog("设置按钮点击异常");
      }
    }
    if (!triggerClicked) {
      const menu = findMenuTrigger();
      if (menu) {
        try {
          menu.click();
        } catch (e) {
          mlog("菜单按钮点击异常");
        }
        setTimeout(() => {
          if (done) return;
          const item = findSettingsMenuItem();
          if (item) {
            try {
              item.click();
            } catch (e) {
            }
          }
        }, 160);
      } else {
        hotkeySent = sendSettingsHotkey();
      }
    }
    const started = Date.now();
    let tries = 0;
    const tick = () => {
      if (done) return;
      tries += 1;
      if (clickSettingsRow(true)) {
        finish("已打开");
        return;
      }
      if (!hotkeySent && (tries === 3 || !triggerClicked)) {
        mlog("对话框仍未出现，改发快捷键");
        hotkeySent = sendSettingsHotkey();
      }
      if (Date.now() - started > 6e3) {
        finish("超时（6s）");
        return;
      }
      setTimeout(tick, 120);
    };
    setTimeout(tick, 60);
  }
  var KIND_LABEL = { event: "经历", feeling: "心情", fact: "事实", plan: "约定", conclusion: "结论" };
  function formatTime(t) {
    const when = new Date(Number(t) || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    return when.getMonth() + 1 + "/" + when.getDate() + " " + pad(when.getHours()) + ":" + pad(when.getMinutes());
  }
  var DOCK_GROUPS = [
    {
      id: "look",
      title: "外观",
      items: [
        { k: "bloomStrength", label: "辉光强度", min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
        { k: "bloomRadius", label: "辉光扩散", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
        { k: "bloomThreshold", label: "辉光阈值", min: 0, max: 0.6, step: 0.01, fmt: (v) => v.toFixed(2) },
        { k: "nodeSize", label: "点大小", min: 0.4, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
        { k: "linkOpacity", label: "连线亮度", min: 0, max: 0.4, step: 5e-3, fmt: (v) => v.toFixed(3) },
        { k: "linkCurve", label: "连线弯曲", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
        { k: "twinkle", label: "闪烁", min: 0, max: 1.6, step: 0.05, fmt: (v) => v.toFixed(2) }
      ]
    },
    {
      id: "spaceLayer",
      title: "深空背景",
      items: [
        { k: "nebula", label: "星云天幕", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
        { k: "fieldStars", label: "空间浮星", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
        { k: "clusterClouds", label: "簇云雾", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) }
      ]
    },
    {
      id: "physics",
      title: "力学（拖完自动重排）",
      items: [
        { k: "repel", label: "斥力", min: 30, max: 400, step: 5, fmt: (v) => String(Math.round(v)) },
        { k: "linkDistance", label: "链接距离", min: 20, max: 160, step: 1, fmt: (v) => String(Math.round(v)) },
        { k: "linkStrength", label: "链接强度", min: 0.3, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
        { k: "centerPull", label: "全局向心", min: 0, max: 0.2, step: 5e-3, fmt: (v) => v.toFixed(3) },
        { k: "flatten", label: "压盘", min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
        /* 分组力：把 18 个项目摊成 18 个独立星系，而不是吸成一个蒲公英 */
        { k: "clusterSpread", label: "项目间距", min: 0.3, max: 2.6, step: 0.05, fmt: (v) => v.toFixed(2) },
        { k: "clusterPull", label: "项目内聚", min: 0, max: 0.5, step: 0.01, fmt: (v) => v.toFixed(2) },
        { k: "coreGravity", label: "核心引力", min: -0.2, max: 0.35, step: 5e-3, fmt: (v) => v.toFixed(3) },
        { k: "spiral", label: "旋臂", min: 0, max: 0.15, step: 5e-3, fmt: (v) => v.toFixed(3) }
      ]
    },
    {
      id: "view",
      title: "视角与配色",
      items: [
        { k: "frameElevDeg", label: "俯仰角", min: 0, max: 90, step: 1, fmt: (v) => Math.round(v) + "°" }
      ]
    },
    {
      id: "nav",
      title: "导航与动效",
      items: [
        { k: "driftSpeed", label: "环绕速度", min: 0.2, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) + "x" },
        /* 生长动画：分层显形，一层一层抽枝。太短就变回"一起炸开" */
        { k: "growMs", label: "生长时长", min: 300, max: 12e3, step: 100, fmt: (v) => (v / 1e3).toFixed(1) + "s" }
      ]
    },
    {
      id: "filter",
      title: "过滤",
      items: []
    },
    {
      id: "interact",
      title: "交互",
      items: [
        /* 悬停高亮：越大越沿父链回溯，尽头就是一路亮到根 */
        { k: "focusDepth", label: "高亮段数", min: 1, max: 12, step: 1, fmt: (v) => Math.round(v) + " 段" },
        /* Ctrl 拖动整簇：刚度越大子孙跟得越紧 */
        { k: "dragStiffness", label: "拖拽刚度", min: 0.02, max: 0.6, step: 0.01, fmt: (v) => v.toFixed(2) },
        /* 阻尼越小越晃，过冲越明显 */
        { k: "dragDamping", label: "拖拽阻尼", min: 0.55, max: 0.985, step: 0.005, fmt: (v) => v.toFixed(3) }
      ]
    },
    { id: "advanced", title: "高级", items: [] }
  ];
  /* 标签滑杆放"过滤 → 标签"小节里，所以单独列一份，不进 DOCK_GROUPS.items */
  var LABEL_SLIDERS = [
    { k: "labelMax", label: "标签数量", min: 4, max: 10000, step: 100, fmt: (v) => Math.round(v) + " 条" },
    { k: "labelChars", label: "标签字数", min: 4, max: 100, step: 1, fmt: (v) => Math.round(v) + " 字" }
  ];
  var PRESET_SUBTITLE = {
    galaxy: "致密核 · 隐约旋臂 · 星海",
    spiral: "社群簇成螺旋 · 极光",
    orbits: "枢纽为核 · 邻居成环 · 落日",
    deepfield: "稀疏远景 · 繁星深海",
    nebula: "弥散光云 · 无背景 · 霓虹",
    minimal: "无辉光 · 无背景 · 克制",
    fireworks: "高辉光迸发 · 赛博",
    supernova: "向外爆发 · 重辉光 · 落日"
  };
  function Slider(props) {
    const item = props.item;
    const v = Number(props.value);
    return h(
      "div",
      { style: S.sliderRow },
      h(
        "div",
        { style: S.sliderTop },
        h("span", { style: S.sliderLabel }, item.label),
        h("span", { style: S.sliderValue }, item.fmt(v))
      ),
      h("input", {
        type: "range",
        min: item.min,
        max: item.max,
        step: item.step,
        value: v,
        style: S.range,
        onChange: (e) => props.onChange(Number(e.target.value))
      }),
      /* 两端刻度（照它面板的排法，让人知道滑杆能拖多远） */
      h(
        "div",
        { style: S.sliderRange },
        h("span", null, item.fmt(item.min)),
        h("span", null, item.fmt(item.max))
      )
    );
  }
  export function SeaPanel() {
    const canvasRef = react.useRef(null);
  /* 标签画布：叠在 WebGL 画布上，只画文字，不吃鼠标事件 */
  const labelRef = react.useRef(null);
    const fullBleedRef = react.useRef(cfg.fullBleed !== false);
    const placeRef = react.useRef(null);
    const panelRef = react.useRef(null);
    const rndRef = react.useRef(null);
    const cardRef = react.useRef(null);
    const flipRef = react.useRef({ x: false, y: false });
    const lastRef = react.useRef({ left: NaN, top: NaN });
    const rebuildRef = react.useRef(0);
    const [detail, setDetail] = react.useState(null);
    const [liveCfg, setLiveCfg] = react.useState(cfg);
    const liveCfgRef = react.useRef(liveCfg);
    liveCfgRef.current = liveCfg;
    const [fail, setFail] = react.useState(null);
    /* 设置面板默认收起：一进来就挡住星图不礼貌 */
    const [dockOpen, setDockOpen] = react.useState(false);
    /* 会话选择列表的展开状态（在「过滤」组里） */
    const [pickerOpen, setPickerOpen] = react.useState(false);
    const [openGroups, setOpenGroups] = react.useState({ look: true, spaceLayer: false, physics: false, view: false, nav: false, filter: true, interact: false });
    const anchorCard = react.useCallback((x2, y2, visible) => {
      const el = cardRef.current;
      if (!el) return;
      const panel = panelRef.current;
      const spot = placeCard({ x: x2, y: y2 }, panel ? panel.clientWidth : 0, panel ? panel.clientHeight : 0, flipRef.current);
      const want = visible ? "1" : "0.35";
      if (el.style.opacity !== want) el.style.opacity = want;
      const last = lastRef.current;
      if (Math.abs(spot.left - last.left) < 1.5 && Math.abs(spot.top - last.top) < 1.5) return;
      lastRef.current = { left: spot.left, top: spot.top };
      el.style.left = spot.left + "px";
      el.style.top = spot.top + "px";
    }, []);
    /*
     * 悬浮详情（左下角按钮激活时用）。
     * 和 handlePick 的唯一区别：**不飞行、不选中**，只开关卡片。
     * 鼠标一移开就关，所以不能复用点击那一套（点击会推镜头）。
     */
    const hoverDetailRef = react.useRef(false);
    const lastHoverRef = react.useRef(null);
    /*
     * 悬浮详情的锁定状态。
     *
     * 语义（用户定的）：
     *   · 只在划过星点时弹卡片，移开就关 —— 不搞"鼠标移到卡片上就不关"
     *   · **再点一下这颗星 = 锁住**，之后卡片不会自己消失，可以慢慢看、点「深探」
     *   · 点空白 / 点另一颗星 = 解锁并切换
     */
    const detailLockedRef = react.useRef(false);

    const handleHoverDetail = react.useCallback((point) => {
      if (!hoverDetailRef.current) return;
      if (detailLockedRef.current) return;   /* 锁住了，hover 不再管 */
      if (!point) {
        if (lastHoverRef.current) {
          lastHoverRef.current = null;
          setDetail(null);
        }
        return;
      }
      if (lastHoverRef.current === point) return;
      lastHoverRef.current = point;
      const panel = panelRef.current;
      const r = rndRef.current;
      let at = null;
      if (r && r.getGraph) {
        const g = r.getGraph();
        const idx = g ? g.nodes.findIndex((n) => n.point === point) : -1;
        if (idx >= 0) at = r.projectScreen(idx);
      }
      flipRef.current = flipFor(at, panel ? panel.clientWidth : 0, panel ? panel.clientHeight : 0);
      lastRef.current = { left: NaN, top: NaN };
      setDetail({ point, at });
    }, []);
    const handlePick = react.useCallback((point) => {
      if (!point) {
        /* 点空白 = 解锁 + 关卡片 */
        detailLockedRef.current = false;
        lastHoverRef.current = null;
        setDetail(null);
        return;
      }
      /*
       * 点了一颗星 = **锁住**卡片。
       * 悬浮详情开着的时候，这就是"看完内容想点深探"的那一下 ——
       * 锁住之后 hover 不再关闭它，可以安心把鼠标移到卡片上。
       */
      detailLockedRef.current = true;
      lastHoverRef.current = point;
      const panel = panelRef.current;
      const r = rndRef.current;
      let at = null;
      if (r && r.getGraph) {
        const g = r.getGraph();
        const idx = g ? g.nodes.findIndex((n) => n.point === point) : -1;
        if (idx >= 0) at = r.projectScreen(idx);
      }
      flipRef.current = flipFor(at, panel ? panel.clientWidth : 0, panel ? panel.clientHeight : 0);
      lastRef.current = { left: NaN, top: NaN };
      setDetail({ point, at });
    }, []);
    const [liveScene, setLiveScene] = react.useState(null);
    const [liveState, setLiveState] = react.useState("loading");
    const [liveError, setLiveError] = react.useState("");
    react.useEffect(() => {
      let alive = true;
      let timer = 0;
      let tries = 0;
      let lastPhase = "";
      /*
       * ★ 索引和前端是赛跑：runIndex 在 apply() 之后 4 秒才跑，
       *   前端却只拉一次 —— 于是拿到半截数据（有些会话只有一个点、没有轮次）。
       *
       * 现在按 host 的 phase 判断：
       *   · phase 不是 ready → 每 1.8 秒重拉，最多 15 次（约 27 秒）
       *   · 先把手上的数据画出来（比空白强），期间在提示条上显示索引进度
       *   · 一旦 phase 变 ready → 平滑换掉：noGrow + keepCamera，
       *     不重播入场动画、不动相机，用户看不出被"重置"了
       */
      const tick = () => {
        if (!alive) return;
        fetchLiveScene().then((payload) => {
          if (!alive) return;
          const scene = toLiveScene(payload);
          const phase = (payload && payload.phase) || "ready";
          const done = phase === "ready" || phase === "error";
          const becameReady = lastPhase !== "" && lastPhase !== "ready" && phase === "ready";
          lastPhase = phase;
          const prog = (payload && payload.progress) || {};

          if (scene && scene.points.length) {
            if (becameReady) {
              /* 索引刚跑完：只换数据，不动镜头、不播动画 */
              buildOptsRef.current = { noGrow: true, keepCamera: true, ticks: 80 };
            }
            setLiveScene(scene);
            setLiveState("live");
            setLiveError(done
              ? ""
              : "正在索引 " + (prog.done || 0) + " / " + (prog.total || 0) + "，数据会自己补齐…");
          } else {
            setLiveState("demo");
            setLiveError("接口通了但没数据（sessions=" + ((payload && payload.sessions && payload.sessions.length) || 0) + "）");
          }

          if (!done && tries < 15) {
            tries += 1;
            timer = setTimeout(tick, 1800);
          }
        }).catch((e) => {
          if (!alive) return;
          setLiveState("demo");
          setLiveError(String(e && e.message || e) + " ｜ " + describeEnv());
        });
      };
      tick();
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, []);
    const sceneData = liveScene || DEMO;
    const buildOptsRef = react.useRef(null);
    const sceneDataRef = react.useRef(sceneData);
    sceneDataRef.current = sceneData;
    const firstBuildRef = react.useRef(true);
    const [expanded, setExpanded] = react.useState(() => /* @__PURE__ */ new Set());
    const [drilling, setDrilling] = react.useState("");
    const deepdive = react.useCallback(async (sid) => {
      if (!sid) return;
      const rr = rndRef.current;
      if (rr && typeof rr.finishGrow === "function") rr.finishGrow();
      const pinned = snapshotPositions(rr ? rr.getGraph() : null);
      if (expanded.has(sid)) {
        const next = removeSessionAddon(sceneData, sid);
        buildOptsRef.current = {
          pinned,
          skipNormalize: true,
          ticks: 8,
          alpha: 0.22,
          keepCamera: true,
          skipReveal: true,
          /* 相机不动、不重播创世 */
          noGrow: true
          /* 收起不播生长动画，直接少一批点 */
        };
        setExpanded((prev) => {
          const s = new Set(prev);
          s.delete(sid);
          return s;
        });
        setLiveScene(next);
        return;
      }
      setDrilling(sid);
      try {
        const addon = await buildSessionAddon(sid);
        const next = mergeAddon(sceneData, addon);
        /*
         * 只有**新增的消息**参与动画。
         *
         * 轮次点早就画在图上了 —— 之前把它们也塞进 newIds，想让"枝干被激活"，
         * 结果是已经正常的点又长了一遍、边又伸了一次，
         * 看起来就是"光点已经有了还在播动画，而且线段忘了移除"。
         * 已经存在的东西不该再被深探一次。
         */
        const grows = new Set(addon.points.map((p) => p.id));
        /*
         * ★ 深探 = 一整条动作：先整图重算结构，再播生长动画。
         *
         * 不用 pinned（那会钉死老节点，结构只到局部最优）。
         * warmStart 让所有节点保留当前位置当起点、整张图一起跑 300 tick；
         * 老节点的新旧位置差用 morphFrom 平滑滑过去，
         * 新消息则从各自的轮次抽出去 —— 两件事在同一段动画里完成。
         */
        buildOptsRef.current = {
          morphFrom: snapshotPositions(rndRef.current ? rndRef.current.getGraph() : null),
          spawnFrom: spawnMapFor(addon),
          skipNormalize: true,
          ticks: 300,
          warmStart: true,
          alpha: 0.9,
          growMs: Math.min(2600, Number(liveCfgRef.current.growMs) || 2600),
          keepCamera: true,
          skipReveal: true,
          newIds: grows
        };
        setExpanded((prev) => new Set(prev).add(sid));
        setLiveScene(next);
        setLiveError("");
      } catch (e) {
        setLiveError("深探失败：" + (e && e.message || e));
      } finally {
        setDrilling("");
      }
    }, [expanded, sceneData]);
    react.useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return void 0;

      /*
       * createRenderer 本身也可能抛（比如 TDZ、着色器编译失败、WebGL 上下文丢失）。
       * 不包起来的话，一个异常会穿出 effect、把整棵组件树炸掉 ——
       * 用户看到的就是"面板打不开 / 白屏"，而且控制台之外没有任何提示。
       * 包起来之后至少能在面板里看到红字原因。
       */
      let r = null;
      try {
        r = createRenderer(canvas, sceneData, {
          onPick: handlePick,
          onAnchor: anchorCard,
          onHoverDetail: handleHoverDetail,
          labelCanvas: labelRef.current
        });
      } catch (e) {
        console.error("[dsh-plugin-memory-sea] 渲染器创建失败：", e);
        setFail("渲染器创建失败：" + (e && e.message ? e.message : String(e)));
        return void 0;
      }
      if (!r) {
        setFail("WebGL 不可用：请确认 DSH 的 GPU 加速已开启（或显卡没被列入黑名单）。");
        return void 0;
      }
      rndRef.current = r;
      try {
        const opts = buildOptsRef.current || void 0;
        buildOptsRef.current = null;
        r.build(sceneData, cfg, opts);
        r.setAutoRotate(cfg.drift);
        r.setAutoRotateSpeed(0.22 * (Number(cfg.driftSpeed) || 1));
        r.start();
      } catch (e) {
        console.error("[dsh-plugin-memory-sea] 渲染初始化失败：", e);
        setFail("渲染初始化失败：" + (e && e.message ? e.message : String(e)));
        try {
          r.destroy();
        } catch (e2) {
        }
        rndRef.current = null;
        return void 0;
      }
      let lastGeom = geometryKey(cfg);
      let lastColor = colorKey(cfg);
      let lastSize = sizeKey(cfg);
      let lastCurve = Number(cfg.linkCurve) || 0;
      let lastElev = cfg.frameElevDeg;
      const off = onCfg((next) => {
        setLiveCfg(next);
        const wantBleed = next.fullBleed !== false;
        if (wantBleed !== fullBleedRef.current) {
          fullBleedRef.current = wantBleed;
          if (placeRef.current) placeRef.current();
          if (rndRef.current && rndRef.current.resize) rndRef.current.resize();
        }
        const rr = rndRef.current;
        if (!rr) return;
        rr.setAutoRotate(next.drift);
        rr.setAutoRotateSpeed(0.22 * (Number(next.driftSpeed) || 1));
        const gk = geometryKey(next);
        if (gk !== lastGeom) {
          lastGeom = gk;
          if (rebuildRef.current) clearTimeout(rebuildRef.current);
          rebuildRef.current = setTimeout(() => {
            const r2 = rndRef.current;
            if (!r2) return;
            try {
              /*
               * 优先走 relayout：**不重建几何**，只重跑布局 + 写 position buffer。
               * 节点数没变时（拖滑杆 / 切预设）这条路快 5-10 倍，
               * 这才是"接近实时"的正解 —— 不是把 tick 数砍到看不清结构。
               *
               * 只有节点数变了（深探 / 收起）才退回 build()。
               */
              if (!r2.relayout(next, 140)) {
                const before = snapshotPositions(r2.getGraph());
                r2.build(sceneDataRef.current, next, {
                  noGrow: true,
                  ticks: 140,
                  morphFrom: before,
                  keepCamera: true
                });
              }
            } catch (e) {
              console.error("[dsh-plugin-memory-sea] 重排失败：", e);
            }
          }, 90);
        }
        rr.applyVisual(next);
        const ck = colorKey(next);
        const sk = sizeKey(next);
        if (ck !== lastColor || sk !== lastSize) {
          lastColor = ck;
          lastSize = sk;
          try {
            rr.applyAttrs(next);
          } catch (e) {
            console.error("[dsh-plugin-memory-sea] 重算配色失败：", e);
          }
        }
        const cv = Number(next.linkCurve) || 0;
        if (cv !== lastCurve) {
          lastCurve = cv;
          try {
            rr.applyCurve(cv);
          } catch (e) {
            console.error("[dsh-plugin-memory-sea] 重采样连线失败：", e);
          }
        }
        if (next.frameElevDeg !== lastElev) {
          lastElev = next.frameElevDeg;
          try {
            rr.setCameraElev(rr.getRadius(), next.frameElevDeg, true);
          } catch (e) {
          }
        }
      });
      return () => {
        off();
        if (rebuildRef.current) clearTimeout(rebuildRef.current);
        r.destroy();
        rndRef.current = null;
      };
    }, [anchorCard, handlePick]);
    react.useEffect(() => {
      const r = rndRef.current;
      if (!r) return;
      if (firstBuildRef.current) {
        firstBuildRef.current = false;
        return;
      }
      const opts = buildOptsRef.current || void 0;
      buildOptsRef.current = null;
      try {
        r.build(sceneData, liveCfgRef.current, opts);
      } catch (e) {
        console.error("[dsh-plugin-memory-sea] 场景重建失败：", e);
      }
    }, [sceneData]);
    react.useEffect(() => {
      const host = panelRef.current;
      const cv = canvasRef.current;
      if (!host || !cv) return void 0;
      const place = () => {
        const r = host.getBoundingClientRect();
        if (r.width < 1) return;
        /*
         * 只在几何真的变了时才写 style。
         * 侧边栏收起 / 展开 / 窗口最大最小化都会改变面板的 left 和 width，
         * 而 ResizeObserver 只盯着**尺寸**：位置变了尺寸没变时它不触发，
         * 画布就会停在旧位置 —— 左边剩一大块空白，右边少一块。
         */
        const key = Math.round(r.left) + "," + Math.round(r.width) + "," + window.innerHeight;
        if (key === lastGeom) return;
        lastGeom = key;
        /* 两块画布同尺寸同位置：WebGL 一块、标签一块 */
        const targets = [cv, labelRef.current].filter(Boolean);
        for (let k = 0; k < targets.length; k += 1) {
          const el = targets[k];
          if (fullBleedRef.current) {
            el.style.position = "fixed";
            el.style.top = "0px";
            el.style.left = r.left + "px";
            el.style.width = r.width + "px";
            el.style.height = "100vh";
          } else {
            el.style.position = "absolute";
            el.style.top = "0px";
            el.style.left = "0px";
            el.style.width = "100%";
            el.style.height = "100%";
          }
        }
      };
      let lastGeom = "";
      placeRef.current = place;
      place();
      const ro = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
      if (ro) ro.observe(host);
      window.addEventListener("resize", place);
      /* 前 20 次密集补位（挂载瞬间布局可能还没稳定） */
      let n = 0;
      const warm = setInterval(() => {
        place();
        n += 1;
        if (n > 20) clearInterval(warm);
      }, 250);
      /* 之后低频长跑：捕捉"位置变、尺寸没变"的情况（侧边栏收起是典型） */
      const watch = setInterval(place, 800);
      return () => {
        if (ro) ro.disconnect();
        window.removeEventListener("resize", place);
        clearInterval(warm);
        clearInterval(watch);
        placeRef.current = null;
      };
    }, []);
    const panelStyle = Object.assign({}, S.panel, {
      background: "transparent",
      backdropFilter: panelBlur(liveCfg.bgBlur),
      WebkitBackdropFilter: panelBlur(liveCfg.bgBlur)
    });
    const panelEl = panelRef.current;
    const first = detail ? placeCard(detail.at, panelEl ? panelEl.clientWidth : 0, panelEl ? panelEl.clientHeight : 0, flipRef.current) : null;
    const cardStyle = detail ? Object.assign({}, S.hud, S.detail, { left: first.left, top: first.top }) : null;
    const stats = sceneData.stats || {};
    const span = stats.span ? Math.max(1, Math.round((stats.span.to - stats.span.from) / 864e5)) : 0;
    /* 悬浮详情开关：渲染层的 onHover 每次都问这个 ref */
    hoverDetailRef.current = liveCfg.hoverDetail === true;

    /*
     * 排除元素：把用户填的 id / class 变成一条注入的 <style>。
     *
     * 为什么用注入样式而不是直接改 el.style：
     *   · 宿主那些元素由宿主自己渲染，改 inline style 可能被它下一次渲染覆盖
     *   · 注入的 <style> 拔掉就 100% 还原，不留痕迹
     *   · 加 !important 才压得住宿主自己的规则
     *
     * 安全阀：如果某个选择器命中了**我们自己**（或我们的祖先），直接跳过 ——
     * 否则用户填错一个 `.panel` 就把自己的星图也藏了，界面会变成空白。
     */
    react.useEffect(() => {
      const raw = String(liveCfg.excludeSelectors || "");
      if (!raw.trim()) return void 0;
      const mine = panelRef.current;
      const sels = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      const safe = [];
      for (const s of sels) {
        if (!/^[#.\w\-\[\]="':() >~+*]+$/.test(s)) continue;   /* 明显不是选择器就跳过 */
        let bad = false;
        try {
          document.querySelectorAll(s).forEach((el) => {
            if (mine && (el === mine || el.contains(mine))) bad = true;
          });
        } catch { bad = true; }                                 /* 语法非法 → 跳过 */
        if (bad) {
          console.warn("[dsh-plugin-memory-sea] 排除选择器会隐藏到面板自己，已跳过：", s);
          continue;
        }
        safe.push(s);
      }
      if (!safe.length) return void 0;
      const styleEl = document.createElement("style");
      styleEl.setAttribute("data-memorysea-exclude", "1");
      styleEl.textContent = safe.map((s) => s + "{display:none !important}").join("\n");
      document.head.appendChild(styleEl);
      return () => {
        styleEl.remove();
      };
    }, [liveCfg.excludeSelectors]);

    const activePreset = presetById(liveCfg.preset);
    /* 预设管得着的参数被改过 → 标题打星号 */
    const presetDirty = presetIsDirty(liveCfg, activePreset);
    /*
     * 观赏模式：兄弟按钮用 visibility 隐藏（不是 display:none）。
     * visibility 保留布局格子，所以「观赏」按钮停在原位、尺寸不变，
     * 退出时摘掉这个属性，整排按钮原样回来 —— 没有任何位移或闪烁。
     */
    const roHideStyle = liveCfg.readOnly ? { visibility: "hidden" } : null;
    const toggleGroup = (id) => setOpenGroups((prev) => {
      const next = Object.assign({}, prev);
      next[id] = !prev[id];
      return next;
    });
    return h(
      "div",
      { ref: panelRef, style: panelStyle },
      h("canvas", { ref: canvasRef, style: S.canvas }),
      /* 标签层：绝对定位盖在上面，pointer-events:none 保证不挡交互 */
      h("canvas", {
        ref: labelRef,
        "data-memorysea-labels": "1",
        style: {
          position: "absolute",
          top: "0px",
          left: "0px",
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 2
        }
      }),
      /* 左上：标题与统计。观赏模式整块不渲染 —— 那是"纯看" */
      liveCfg.readOnly ? null : h(
        "div",
        { style: Object.assign({}, S.hud, S.top) },
        h("h1", { style: S.title }, "记忆海"),
        h("div", { style: S.sub }, liveState === "live" ? "全部会话，每一轮都是一颗星" : "她经历过的每一件事，都是一个点"),
        h(
          "div",
          { style: S.stats },
          h("span", null, "点 ", h("b", { style: S.statB }, String(sceneData.points.length))),
          h("span", null, "线 ", h("b", { style: S.statB }, String(sceneData.edges.length))),
          h("span", null, "簇 ", h("b", { style: S.statB }, String((sceneData.clusters || []).length))),
          span ? h("span", null, "跨度 ", h("b", { style: S.statB }, String(span)), " 天") : null
        ),
        /* 数据没接上时把真实原因摊开，不用开 DevTools */
        liveError ? h("div", {
          style: {
            marginTop: 8,
            padding: "6px 8px",
            borderRadius: 8,
            fontSize: 11,
            lineHeight: 1.5,
            wordBreak: "break-all",
            background: "rgba(255,120,120,.10)",
            border: "1px solid " + T.border,
            color: T.caption,
            maxWidth: 300
          }
        }, "数据未接通：" + liveError) : null
      ),
      /* 右侧：效果控制台（实时看效果）。
         观赏模式下整块不渲染 —— 沿用同一个条件分支，不另造元素。 */
      (dockOpen && !liveCfg.readOnly) ? h(
        "div",
        { style: Object.assign({}, S.hud, S.dock) },
        h(
          "div",
          { style: S.dockBar },
          /*
           * 标题带星号 = 这个预设被你改过了。
           * 星号只统计"预设真的管得着"的字段（presetFields），
           * 所以调节点/标签这类全局设置不会误报。
           */
          h("span", { style: S.dockTitle },
            "风格 " + activePreset.name + (presetDirty ? " *" : ""),
            presetDirty ? h("span", { style: S.dockSrc, title: "改过「" + activePreset.name + "」的配置，点「本预设」可还原" }, "（已改）") : null
          ),
          h(
            "div",
            { style: { display: "flex", gap: 4 } },
            h("button", {
              style: Object.assign({}, S.btn, { padding: "2px 6px", fontSize: 10.5 }),
              title: "把「" + activePreset.name + "」这个预设管得着的参数全部还原",
              onClick: () => setCfg(presetPatch(activePreset))
            }, "重置本预设"),
            h("button", {
              style: Object.assign({}, S.btn, { padding: "2px 6px", fontSize: 10.5 }),
              title: "把画布参数恢复出厂设置（不动「设置 → 记忆海」里的系统项）",
              /*
               * ★ 必须叠上当前预设的 patch。
               *   只 setCfg(CFG_DEFAULT) 的话，cfg 里的预设字段等于 CFG_DEFAULT 的默认值，
               *   而 presetIsDirty 是拿 presetPatch(activePreset) 比的 ——
               *   两者本来就不完全一样（CFG_DEFAULT 是出厂值，预设有自己的数值），
               *   于是"什么都没改、一重置反而打上星号"。
               *
               * ★ 系统级设置要原样保留。
               *   这里是画布控制台，管的是渲染参数；铺满导航栏、画布背景、排除元素
               *   那些是「设置 → 记忆海」页的事，那边有自己的「全部恢复默认」。
               *   一个按钮把两个地方一起清掉，属于职责越界。
               */
              onClick: () => {
                const next = Object.assign(
                  {},
                  CFG_DEFAULT,
                  presetPatch(presetById(CFG_DEFAULT.preset))
                );
                for (const k of SYSTEM_KEYS) {
                  if (k in liveCfg) next[k] = liveCfg[k];
                }
                setCfg(next);
              }
            }, "重置系统"),
            h("button", {
              style: Object.assign({}, S.btn, { padding: "2px 6px", fontSize: 10.5 }),
              onClick: () => setDockOpen(false)
            }, "收起")
          )
        ),
        /* 预设：图标位置放名字 + 副标题（照它面板的排法） */
        h(
          "div",
          { style: S.presetGrid },
          STYLE_PRESETS.map((p) => h(
            "button",
            {
              key: p.id,
              style: Object.assign({}, S.presetBtn(liveCfg.preset === p.id), { textAlign: "left", lineHeight: 1.25 }),
              title: p.nameEn,
              onClick: () => setCfg(presetPatch(p))
            },
            h("div", { style: { fontSize: 12.5, fontWeight: 600 } }, p.name),
            h("div", { style: { fontSize: 10, opacity: 0.55, marginTop: 2 } }, PRESET_SUBTITLE[p.id] || "")
          ))
        ),
        /* 分组滑杆 */
        DOCK_GROUPS.map((g) => h(
          "div",
          { key: g.id, style: S.dockGroup },
          h(
            "button",
            { style: S.dockHead, onClick: () => toggleGroup(g.id) },
            h("span", null, g.title),
            h(
              "span",
              { style: { display: "flex", alignItems: "center" } },
              /* 「由「银河」设定」：只有**预设真的管得着**的组才显示。
                 交互组（高亮段数 / 拖拽刚度 / 阻尼 / 标签）是全局设定，
                 给它挂个预设名字是错的。 */
              (g.id === "look" || g.id === "spaceLayer" || g.id === "physics" || g.id === "view")
                ? h("span", { style: S.dockSrc }, "由「" + activePreset.name + "」") : null,
              h("span", { style: S.caret }, openGroups[g.id] ? "−" : "+")
            )
          ),
          openGroups[g.id] ? h(
            "div",
            { style: S.dockBody },
            g.items.map((it) => h(Slider, {
              key: it.k,
              item: it,
              value: liveCfg[it.k],
              onChange: (v) => setCfg({ [it.k]: v })
            })),
            g.id === "spaceLayer" ? h(
              "div",
              { style: S.sliderRow },
              h(
                "div",
                { style: S.sliderTop },
                h("span", { style: S.sliderLabel }, "星点天幕"),
                h("span", { style: S.sliderValue }, liveCfg.starfield ? "开" : "关")
              ),
              h("button", {
                style: liveCfg.starfield ? Object.assign({}, S.btn, S.btnOn, { width: "100%" }) : Object.assign({}, S.btn, { width: "100%" }),
                onClick: () => setCfg({ starfield: !liveCfg.starfield })
              }, liveCfg.starfield ? "已开启" : "已关闭")
            ) : null,
            /* ── 过滤：两个小节 ──
             *   · 节点筛选：按类型藏点，就地改 aShow，一点就生效
             *   · 标签：给谁画、写什么、几条、几个字
             */
            g.id === "filter" ? h(
              "div",
              null,
              h("div", { style: S.subHead }, "节点筛选"),
              h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                [
                  ["showUser", "你", "用户消息"],
                  ["showAssistant", "她", "助手回复"],
                  ["showTool", "工具", "工具调用"],
                  ["showCompaction", "摘要", "压缩摘要"]
                ].map((it) => {
                  const on = liveCfg[it[0]] !== false;
                  return h("button", {
                    key: it[0],
                    title: it[2] + (on ? "：显示中" : "：已隐藏"),
                    style: on
                      ? Object.assign({}, S.btn, S.btnOn, { flex: "1 1 44%", fontSize: 11 })
                      : Object.assign({}, S.btn, { flex: "1 1 44%", fontSize: 11, opacity: 0.45 }),
                    onClick: () => setCfg({ [it[0]]: liveCfg[it[0]] === false })
                  }, (on ? "● " : "○ ") + it[1]);
                })
              ),
              h("div", { style: { fontSize: 10, opacity: 0.45, marginTop: 6, lineHeight: 1.4 } },
                "关掉哪一类，图里就不显示这类消息，连着的线也一起消失。"),

              /* ── 结构层级 ──
               * 轮次用开关（关掉 = 只看会话星，概览视图）。
               * 会话是根，用**选择**：一个总开关关掉等于整张图全没，
               * 所以改成"勾选要显示哪几个会话"。 */
              h("div", { style: S.subHead }, "结构层级"),
              h("div", { style: { display: "flex", gap: 4 } },
                (() => {
                  const on = liveCfg.showTurn !== false;
                  return h("button", {
                    style: on
                      ? Object.assign({}, S.btn, S.btnOn, { flex: "1 1 50%", fontSize: 11 })
                      : Object.assign({}, S.btn, { flex: "1 1 50%", fontSize: 11, opacity: 0.45 }),
                    title: on ? "显示轮次与消息（关掉只留会话星）" : "当前只显示会话星",
                    onClick: () => setCfg({ showTurn: !on })
                  }, (on ? "● " : "○ ") + "对话");
                })(),
                (() => {
                  const hid = Array.isArray(liveCfg.hiddenSessions) ? liveCfg.hiddenSessions : [];
                  return h("button", {
                    style: hid.length
                      ? Object.assign({}, S.btn, { flex: "1 1 50%", fontSize: 11, opacity: 0.75 })
                      : Object.assign({}, S.btn, S.btnOn, { flex: "1 1 50%", fontSize: 11 }),
                    title: "会话是根：这里选择要显示哪几个",
                    onClick: () => setPickerOpen(!pickerOpen)
                  }, "会话" + (hid.length ? " (藏 " + hid.length + ")" : " (全)") + (pickerOpen ? " ▲" : " ▼"));
                })()
              ),
              pickerOpen ? (() => {
                const hid = Array.isArray(liveCfg.hiddenSessions) ? liveCfg.hiddenSessions : [];
                const hidSet = new Set(hid);
                const all = (sceneData.points || []).filter((p) => p.kind === "session");
                /* 按项目分组，找起来快 */
                const groups = new Map();
                for (const p of all) {
                  const key = p.subtitle || "(未知项目)";
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key).push(p);
                }
                const setHid = (next) => setCfg({ hiddenSessions: next });
                return h(
                  "div",
                  { style: S.pickList },
                  h("div", { style: { display: "flex", gap: 4, marginBottom: 4 } },
                    h("button", {
                      style: Object.assign({}, S.btn, { flex: 1, fontSize: 10.5, padding: "2px 4px" }),
                      onClick: () => setHid([])
                    }, "全部显示"),
                    h("button", {
                      style: Object.assign({}, S.btn, { flex: 1, fontSize: 10.5, padding: "2px 4px" }),
                      onClick: () => setHid(all.map((p) => p.sessionId))
                    }, "全部隐藏")
                  ),
                  Array.from(groups.entries()).map(([label, list]) => h(
                    "div",
                    { key: label, style: { marginBottom: 4 } },
                    h("div", { style: { fontSize: 10, opacity: 0.5, marginBottom: 2 } }, label + " · " + list.length),
                    list.map((p) => {
                      const visible = !hidSet.has(p.sessionId);
                      return h("button", {
                        key: p.sessionId,
                        title: p.title || p.id,
                        style: visible
                          ? Object.assign({}, S.btn, S.btnOn, { width: "100%", fontSize: 10.5, padding: "2px 5px", marginBottom: 2, textAlign: "left", justifyContent: "flex-start" })
                          : Object.assign({}, S.btn, { width: "100%", fontSize: 10.5, padding: "2px 5px", marginBottom: 2, textAlign: "left", justifyContent: "flex-start", opacity: 0.4 }),
                        onClick: () => {
                          const next = visible
                            ? hid.concat([p.sessionId])
                            : hid.filter((x) => x !== p.sessionId);
                          setHid(next);
                        }
                      }, (visible ? "● " : "○ ") + String(p.title || p.sessionId).slice(0, 22));
                    })
                  ))
                );
              })() : null,

              h("div", { style: S.subHead }, "标签"),
              h("button", {
                style: liveCfg.labels
                  ? Object.assign({}, S.btn, S.btnOn, { width: "100%", marginBottom: 6 })
                  : Object.assign({}, S.btn, { width: "100%", marginBottom: 6 }),
                onClick: () => setCfg({ labels: !liveCfg.labels })
              }, liveCfg.labels ? "标签：已开启" : "标签：已关闭"),
              LABEL_SLIDERS.map((it) => h(Slider, {
                key: it.k,
                item: it,
                value: liveCfg[it.k],
                onChange: (v) => setCfg({ [it.k]: v })
              })),
              h("div", { style: S.sliderTop },
                h("span", { style: S.sliderLabel }, "标签给谁画")
              ),
              h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 } },
                [
                  ["labelOnSession", "会话"],
                  ["labelOnTurn", "轮次"],
                  ["labelOnRecord", "消息"]
                ].map((it) => {
                  const on = liveCfg[it[0]] === true;
                  return h("button", {
                    key: it[0],
                    style: on
                      ? Object.assign({}, S.btn, S.btnOn, { flex: "1 1 30%", fontSize: 11 })
                      : Object.assign({}, S.btn, { flex: "1 1 30%", fontSize: 11, opacity: 0.45 }),
                    onClick: () => setCfg({ [it[0]]: !on })
                  }, (on ? "● " : "○ ") + it[1]);
                })
              ),
              h("div", { style: Object.assign({}, S.sliderTop, { marginTop: 8 }) },
                h("span", { style: S.sliderLabel }, "标签写什么")
              ),
              h("div", { style: { display: "flex", gap: 4, marginTop: 4 } },
                h("button", {
                  style: liveCfg.labelField === "name" ? Object.assign({}, S.btn, S.btnOn, { flex: 1 }) : Object.assign({}, S.btn, { flex: 1 }),
                  onClick: () => setCfg({ labelField: "name" })
                }, "名称"),
                h("button", {
                  style: liveCfg.labelField === "content" ? Object.assign({}, S.btn, S.btnOn, { flex: 1 }) : Object.assign({}, S.btn, { flex: 1 }),
                  onClick: () => setCfg({ labelField: "content" })
                }, "内容")
              ),
              h("div", { style: { fontSize: 10, opacity: 0.45, marginTop: 6, lineHeight: 1.4 } },
                "名称 = 会话标题 / 第几轮 / 你·她·工具；内容 = 正文摘要（按「标签字数」截断）。"),

              /*
               * 允许重叠。
               * 默认要避让：重叠的标签叠着看不清。
               * 但视图一缩小，一堆标签挤在同一片区域，避让会把它们几乎全丢掉 ——
               * 于是"缩得越小、标签越少"。这个开关关掉避让，挤一点但都留得住。
               */
              h("div", { style: Object.assign({}, S.sliderTop, { marginTop: 8 }) },
                h("span", { style: S.sliderLabel }, "重叠处理"),
                h("span", { style: S.sliderValue }, liveCfg.labelOverlap ? "允许重叠" : "自动避让")
              ),
              h("div", { style: { display: "flex", gap: 4, marginTop: 4 } },
                h("button", {
                  style: liveCfg.labelOverlap === true
                    ? Object.assign({}, S.btn, { flex: 1 })
                    : Object.assign({}, S.btn, S.btnOn, { flex: 1 }),
                  title: "重叠的标签不画，画面干净，但缩小时会丢掉很多",
                  onClick: () => setCfg({ labelOverlap: false })
                }, "自动避让"),
                h("button", {
                  style: liveCfg.labelOverlap === true
                    ? Object.assign({}, S.btn, S.btnOn, { flex: 1 })
                    : Object.assign({}, S.btn, { flex: 1 }),
                  title: "全部画出来，允许互相压着 —— 缩小时不丢东西",
                  "data-memorysea-labeloverlap-btn": "1",
                  onClick: () => setCfg({ labelOverlap: true })
                }, "允许重叠")
              )
            ) : null,
            g.id === "view" ? h(
              "div",
              null,
              h(
                "div",
                { style: S.sliderTop },
                h("span", { style: S.sliderLabel }, "上色依据"),
                h("span", { style: S.sliderValue }, liveCfg.colorBy === "theme" ? "主题簇" : "记忆类型")
              ),
              h(
                "div",
                { style: { display: "flex", gap: 4, marginTop: 4 } },
                h("button", {
                  style: liveCfg.colorBy === "kind" ? Object.assign({}, S.btn, S.btnOn, { flex: 1 }) : Object.assign({}, S.btn, { flex: 1 }),
                  onClick: () => setCfg({ colorBy: "kind" })
                }, "类型"),
                h("button", {
                  style: liveCfg.colorBy === "theme" ? Object.assign({}, S.btn, S.btnOn, { flex: 1 }) : Object.assign({}, S.btn, { flex: 1 }),
                  onClick: () => setCfg({ colorBy: "theme" })
                }, "主题簇")
              ),
              liveCfg.colorBy === "theme" ? h(
                "div",
                null,
                h(
                  "div",
                  { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 } },
                  THEMES.map((t) => h("button", {
                    key: t.id,
                    style: liveCfg.theme === t.id ? Object.assign({}, S.btn, S.btnOn, { padding: "3px 7px", fontSize: 11 }) : Object.assign({}, S.btn, { padding: "3px 7px", fontSize: 11 }),
                    onClick: () => setCfg({ theme: t.id, themeSeed: 0 })
                  }, t.name))
                ),
                h("button", {
                  style: Object.assign({}, S.btn, { width: "100%", marginTop: 5, padding: "4px 2px", fontSize: 11 }),
                  title: "在当前配色里打乱颜色与簇的对应关系",
                  onClick: () => setCfg({ themeSeed: (Date.now() >>> 0) % 65535 || 1 })
                }, "配色洗牌")
              ) : null
            ) : null,
            g.id === "nav" ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 5, marginTop: 4 } },
              h("button", {
                style: liveCfg.drift ? Object.assign({}, S.btn, S.btnOn) : Object.assign({}, S.btn),
                onClick: () => setCfg({ drift: !liveCfg.drift })
              }, liveCfg.drift ? "环绕：开" : "环绕：关"),
              h("button", {
                style: S.btn,
                title: "按当前生长时长，把整棵树从会话开始重新长一遍（不重排布局）",
                onClick: () => {
                  const rr = rndRef.current;
                  if (!rr) return;
                  if (typeof rr.replayGrow === "function") rr.replayGrow();
                  else if (rr.replayReveal) rr.replayReveal();
                }
              }, "重播生长动画"),
              /*
               * 整图重算：把**所有节点**（含已经深探出来的消息）一起重新跑一遍力导向。
               *
               * 深探是局部收敛（老节点钉住），结构只到局部最优；
               * 这个按钮等价于"刷新一次"——只不过节点不重建、位置是从当前状态
               * 平滑滑到新位置（relayout 里的 warmStart + armMorph），所以看得见过程。
               */
              h("button", {
                style: S.btn,
                title: "整图重算：所有节点一起重新布局（等价刷新一次，但看得见过渡）",
                "data-memorysea-relayout-btn": "1",
                onClick: () => {
                  const rr = rndRef.current;
                  if (!rr) return;
                  if (typeof rr.relayout === "function") rr.relayout(liveCfgRef.current, 300);
                }
              }, "整图重算")
            ) : null,
            g.id === "look" ? h(
              "div",
              null,
              h("div", { style: S.rowHint, marginBottom: 4 }, "点大小依据"),
              h(
                "div",
                { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
                [
                  ["level", "按层级", "工作区 > 会话 > 轮次 > 消息，上游越大"],
                  ["weight", "按重量", "消息越长 / 工具越多 / 压缩摘要，点越大"],
                  ["degree", "按连接", "连得越多越大（枢纽突出）"],
                  ["uniform", "大小一致", "全部同大"]
                ].map(([id, label]) => h("button", {
                  key: id,
                  title: id === "level" ? "工作区 > 会话 > 轮次 > 消息 > 词" : id === "weight" ? "weight = 长度 + 工具数 + 压缩摘要加成" : id === "degree" ? "按图上的连接数" : "全部同大",
                  style: liveCfg.sizeBy === id ? Object.assign({}, S.btn, S.btnOn, { flex: "1 1 45%", padding: "4px 2px", fontSize: 11 }) : Object.assign({}, S.btn, { flex: "1 1 45%", padding: "4px 2px", fontSize: 11 }),
                  onClick: () => setCfg({ sizeBy: id })
                }, label))
              )
            ) : null,
            g.id === "advanced" ? h(
              "div",
              null,
              h(
                "div",
                { style: S.sliderTop },
                h("span", { style: S.sliderLabel }, "性能档"),
                h("span", { style: S.sliderValue }, liveCfg.perfTier)
              ),
              h(
                "div",
                { style: { display: "flex", gap: 4, marginTop: 4 } },
                [["auto", "自动"], ["high", "高"], ["low", "低"], ["mobile", "移动"]].map((pair) => h("button", {
                  key: pair[0],
                  style: liveCfg.perfTier === pair[0] ? Object.assign({}, S.btn, S.btnOn, { flex: 1, padding: "4px 2px", fontSize: 11 }) : Object.assign({}, S.btn, { flex: 1, padding: "4px 2px", fontSize: 11 }),
                  onClick: () => setCfg({ perfTier: pair[0] })
                }, pair[1]))
              ),
              h(
                "div",
                { style: Object.assign({}, S.sliderRange, { marginTop: 5 }) },
                h("span", null, liveCfg.perfTier === "low" || liveCfg.perfTier === "mobile" ? "DPR 钳到 1" : "DPR 最高 2")
              ),
              h(
                "div",
                { style: Object.assign({}, S.sliderTop, { marginTop: 10 }) },
                h("span", { style: S.sliderLabel }, "超采样"),
                h("span", { style: S.sliderValue }, (Number(liveCfg.ssaa) || 1).toFixed(1) + "x")
              ),
              h(
                "div",
                { style: { display: "flex", gap: 4, marginTop: 4 } },
                [[1, "1x"], [1.5, "1.5x"], [2, "2x"]].map((pair) => h("button", {
                  key: String(pair[0]),
                  style: (Number(liveCfg.ssaa) || 1) === pair[0] ? Object.assign({}, S.btn, S.btnOn, { flex: 1, padding: "4px 2px", fontSize: 11 }) : Object.assign({}, S.btn, { flex: 1, padding: "4px 2px", fontSize: 11 }),
                  onClick: () => setCfg({ ssaa: pair[0] })
                }, pair[1]))
              ),
              h(
                "div",
                { style: Object.assign({}, S.sliderRange, { marginTop: 5 }) },
                h("span", null, "越高越锐利，像素量按平方涨")
              )
            ) : null
          ) : null
        ))
      ) : liveCfg.readOnly ? null : h("button", {
        style: Object.assign({}, S.hud, {
          top: 10,
          right: 10,
          padding: "6px 10px",
          fontSize: 12,
          cursor: "pointer"
        }),
        onClick: () => setDockOpen(true)
      }, "风格 · " + activePreset.name),
      /* 左下：工具栏
       *
       * ★ 观赏模式：**只留「观赏」这一个按钮，其余兄弟元素原地隐形**。
       *
       * 做法是 visibility:hidden + 底板透明，不是另外造一个浮动按钮：
       *   · visibility 保持布局，「观赏」还在它原来的位置、原来的样式
       *   · 底板背景/边框一起透明，所以那块半透明底也跟着不见
       *   · 退出时把这些属性摘掉，所有按钮和底板**自然**回来，没有跳变
       */
      h(
        "div",
        {
          style: liveCfg.readOnly
            ? Object.assign({}, S.hud, S.tools, {
              background: "transparent",
              border: "1px solid transparent",
              boxShadow: "none",
              backdropFilter: "none",
              WebkitBackdropFilter: "none"
            })
            : Object.assign({}, S.hud, S.tools)
        },
        h("button", {
          style: Object.assign({}, liveCfg.bloom ? Object.assign({}, S.btn, S.btnOn) : S.btn, roHideStyle),
          title: "泛光开关",
          onClick: () => setCfg({ bloom: !liveCfg.bloom })
        }, "泛光"),
        h("button", {
          style: Object.assign({}, liveCfg.drift ? Object.assign({}, S.btn, S.btnOn) : S.btn, roHideStyle),
          title: "相机自动环绕",
          onClick: () => setCfg({ drift: !liveCfg.drift })
        }, "环绕"),
        /*
         * 标签（图标切换）。
         * 开启后会话和轮次在星点旁显示文字；消息太多，只在悬停时显示。
         */
        h("button", {
          style: Object.assign({}, liveCfg.labels ? Object.assign({}, S.btn, S.btnOn) : S.btn, roHideStyle),
          title: liveCfg.labels
            ? "标签：已开启（会话/轮次显示名称，悬停时显示消息摘要）"
            : "标签：给星点写上名字",
          "data-memorysea-labels-btn": "1",
          onClick: () => setCfg({ labels: !liveCfg.labels })
        }, "㊏ 标签"),
        /*
         * 悬浮详情（图标切换）。
         * 激活后划过星点就弹卡片；再点一下星点就锁住，不会自己关。
         */
        h("button", {
          style: Object.assign({}, liveCfg.hoverDetail ? Object.assign({}, S.btn, S.btnOn) : S.btn, roHideStyle),
          title: liveCfg.hoverDetail
            ? "悬浮详情：已开启（划过星点即弹卡片，点一下锁住）"
            : "悬浮详情：鼠标划过星点就弹出内容，不用点",
          "data-memorysea-hoverdetail-btn": "1",
          onClick: () => setCfg({ hoverDetail: !liveCfg.hoverDetail })
        }, "ⓘ 悬浮详情"),
        /*
         * 观赏模式（👁️ 图标切换）。
         * ★ 这个按钮**永远可见**，观赏模式下屏幕上只剩它。
         *   未激活：灰度 emoji；激活：原色 + 按钮高亮。
         */
        h("button", {
          style: liveCfg.readOnly ? Object.assign({}, S.btn, S.btnOn) : S.btn,
          title: liveCfg.readOnly
            ? "观赏模式：已开启（不响应悬停与点击）"
            : "观赏模式：只看看，不悬停高亮也不点击",
          "data-memorysea-readonly-btn": "1",
          onClick: () => {
            const next = !liveCfg.readOnly;
            setCfg({ readOnly: next });
            if (next) setDetail(null);
          }
        }, h("span", {
          style: {
            fontSize: 13,
            lineHeight: 1,
            filter: liveCfg.readOnly ? "none" : "grayscale(1)",
            opacity: liveCfg.readOnly ? 1 : 0.55,
            transition: "filter .18s ease, opacity .18s ease"
          }
        }, "👁️")),
        /*
         * 分隔线右边全是**单击类**按钮（复位 / 设置），不表示开关状态。
         * 复位原来夹在「环绕」和「标签」中间，一排激活态按钮里出现一个
         * 永远不带高亮的按钮，看着像"当前已复位"，归类是错的。
         */
        h("span", { style: Object.assign({}, S.toolsDivider, roHideStyle) }),
        h("button", {
          style: Object.assign({}, S.btn, roHideStyle),
          title: "视角复位：镜头回到默认机位（不动你的数据）",
          "data-memorysea-reset-btn": "1",
          onClick: () => {
            if (rndRef.current) {
              rndRef.current.resetView();
              setDetail(null);
            }
          }
        }, "复位"),
        h("button", {
          style: Object.assign({}, S.btn, roHideStyle),
          title: "打开记忆海的设置",
          "data-memorysea-settings-btn": "1",
          onClick: openMemorySeaSettings
        }, "设置")
      ),
      fail ? h("div", { style: S.fail }, fail) : null,
      /* 详情卡。观赏模式不显示（连悬浮高亮都关了，弹卡片是自相矛盾的） */
      (detail && !liveCfg.readOnly) ? h(
        "div",
        { ref: cardRef, style: cardStyle },
        /* 头：这是什么类型 */
        h("div", { style: S.detailK }, detailKindLabel(detail.point)),
        /*
         * 字段表。
         * 之前这里只堆了一串没有标签的数字 —— 点开任何一颗消息星都只有
         * "1340 字"，完全看不出这条是什么、属于哪、什么时候。用户的原话：
         * "截图这些展开的到底是什么。是重复的吗。还是没有意义的"。
         */
        /*
         * 字段表：**按节点类型分别组装**。
         *
         * 之前是一串并列的 kvRow 用条件堆出来的，结果是：
         *   · 轮次上出现「项目」—— 轮次没有项目概念，那一行装的其实是首条消息预览，
         *     而且卡片底部正文已经完整显示了，纯属重复
         *   · 轮次上出现「工具 false」—— `kind === "record" && toolName` 整个表达式
         *     求值成 false，被当成内容渲染
         *   · 轮次上出现「规模 0 轮 · 0 条」—— turn 的 stats 里没有 turns/records
         *
         * 现在每种类型只列自己有的字段，不再靠"碰巧不显示"。
         */
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 1, marginTop: 2 } },
          (() => {
            const p = detail.point;
            const rows = [];
            const add = (k, v) => {
              if (v === undefined || v === null || v === "") return;
              rows.push([k, v]);
            };
            if (p.kind === "session") {
              add("项目", p.subtitle);
              if (p.stats) add("规模", (p.stats.turns || 0) + " 轮 · " + (p.stats.records || 0) + " 条");
              if (p.t) add("时间", formatTime(p.t));
              /* 空会话把 id 亮出来 —— 用户想回溯到底是哪一个 */
              if (p.stats && !p.stats.records) add("标识", String(p.sessionId || "").slice(0, 8));
            } else if (p.kind === "turn") {
              if (p.t) add("时间", formatTime(p.t));
              if (p.turnId) add("轮次", String(p.turnId).replace(/^turn-/, "").slice(0, 12));
            } else if (p.kind === "record") {
              if (p.len) add("长度", p.len + " 字");
              if (p.toolName) add("工具", p.toolName);
              if (p.t) add("时间", formatTime(p.t));
              if (p.turnId) add("轮次", String(p.turnId).replace(/^turn-/, "").slice(0, 12));
            } else {
              if (p.subtitle) add("位置", p.subtitle);
            }
            if (p.stats) {
              const u = p.stats.userLen || 0;
              const a = p.stats.assistantLen || 0;
              if (u || a) add("你/她", u + " / " + a + " 字");
              if (p.stats.toolCount) add("工具调用", p.stats.toolCount + " 次");
            }
            return rows.map((r) => h("div", { key: r[0] }, kvRow(r[0], r[1])));
          })()
        ),
        /* 正文：消息点靠它说明"这条到底是什么" */
        (() => {
          const p = detail.point;
          /*
           * 正文优先级按类型分开。
           * ★ 会话原来会退回 title，而 title 为空时是 shortId(id) ——
           *   于是空会话的卡片正文显示一串 "ea7deb01"，看起来像读取失败。
           *   会话优先用 digest（第一轮的开头），没有就什么都不写、改用下面的说明。
           */
          let body = "";
          if (p.full) body = p.full;
          else if (p.text) body = p.text;
          else if (p.kind === "record") body = p.preview || "";
          else if (p.kind === "turn") body = p.subtitle || "";
          else if (p.kind === "session") body = p.digest || "";

          /* 会话一条记录都没有：宿主那边确实没内容，别让人以为是我们的锅 */
          if (!body && p.kind === "session" && p.stats && !p.stats.records) {
            return h("div", {
              style: {
                marginTop: 8, padding: "7px 9px", borderRadius: 6,
                background: "rgba(128,128,128,.10)", fontSize: 11, lineHeight: 1.6, opacity: 0.5
              }
            }, "这个会话在宿主里没有任何对话记录（可能是新建后没聊过，或内容已被清空）。");
          }
          if (!body) return null;
          return h("div", {
            style: {
              marginTop: 8,
              padding: "7px 9px",
              borderRadius: 6,
              background: "rgba(128,128,128,.10)",
              fontSize: 11.5,
              lineHeight: 1.6,
              opacity: 0.86,
              maxHeight: 120,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word"
            }
          }, body);
        })(),
        /* 深探：只有会话可以（一次摊到消息层，按钮随状态切换深探/收起） */
        detail.point.kind === "session" && detail.point.sessionId ? h(
          "div",
          { style: { marginTop: 8, display: "flex", gap: 6 } },
          h("button", {
            style: Object.assign({}, S.btn, { padding: "4px 12px", fontSize: 12 }),
            disabled: drilling === detail.point.sessionId,
            onClick: () => deepdive(detail.point.sessionId)
          }, drilling === detail.point.sessionId ? "读取中…" : expanded.has(detail.point.sessionId) ? "收起" : "深探 →")
        ) : null,
        detail.point.keywords && detail.point.keywords.length ? h("div", { style: S.tags }, detail.point.keywords.map((k, i) => h("span", { key: i, style: S.tag }, k))) : null
      ) : null,
      /*
       * 底部操作提示。
       * 观赏模式下整条不渲染 —— 那是"纯看"模式，屏幕上只留一个观赏按钮。
       */
      liveCfg.readOnly ? null : h("div", { style: S.hint },
        (expanded.size
          ? "已深探 " + expanded.size + " 个会话"
          : "点会话星 → 深探到消息")
        + " · 左键拖旋转 · 滚轮缩放 · 右键平移"
        + " · Ctrl+拖 = 带整簇 · 悬浮看归属")
    );
  }
  export function SettingsPage() {
    const [live, setLive] = react.useState(cfg);
    react.useEffect(() => onCfg(setLive), []);
    /* 排除选择器：编辑中的文本，点「应用」才写进 cfg */
    const [excludeInput, setExcludeInput] = react.useState(String(cfg.excludeSelectors || ""));
    /* 上次「应用」的结果（命中几个），给用户一个明确回执 */
    const [excludeHit, setExcludeHit] = react.useState("");
    const [dataStat, setDataStat] = react.useState(null);
    react.useEffect(() => {
      let alive = true;
      fetchLiveScene().then((p) => {
        if (!alive) return;
        const sessions = p.sessions || [];
        const turns = p.turns || [];
        setDataStat({
          sessions: sessions.length,
          turns: turns.length,
          cwds: new Set(sessions.map((s) => s.cwd)).size,
          phase: p.phase,
          progress: p.progress || {},
          meta: p.meta || {}
        });
      }).catch(() => {
      });
      return () => {
        alive = false;
      };
    }, []);
    const clusterCount = dataStat ? dataStat.cwds : new Set(DEMO.points.map((p) => p.cluster || p.topic)).size;
    const diaryCount = DEMO.points.filter((p) => p.diary).length;
    return h(
      "div",
      { style: S.wrap },
      h(
        "div",
        { style: S.lead },
        "效果类设置（预设、辉光、力学、深空背景）已经搬到记忆海面板右侧的控制台，",
        "拖滑杆就能实时看效果。这里只留需要长期保存、不常改的东西。"
      ),
      /* 视图：结构性开关，放设置页而不是面板控制台（改完要重新布局，不适合边看边拖） */
      h(
        "div",
        { style: S.card },
        h("div", { style: S.cardTitle }, "视图"),
        h(
          "div",
          { style: S.row },
          h(
            "div",
            { style: S.rowText },
            h("div", { style: S.rowLabel }, "铺满顶部导航栏"),
            h(
              "div",
              { style: S.rowHint },
              live.fullBleed !== false ? "开：星海从窗口最顶部铺下来，标题栏后面也能看到它。" : "关：星海只画在面板区域内，和普通面板一样。"
            )
          ),
          h("button", {
            style: live.fullBleed !== false ? Object.assign({}, S.primary, { borderColor: T.link, fontWeight: 600 }) : S.primary,
            onClick: () => setCfg({ fullBleed: live.fullBleed === false })
          }, live.fullBleed !== false ? "已开启" : "已关闭")
        ),
        h(
          "div",
          { style: S.rowHint, marginTop: 6 },
          "实现方式是给画布用 position:fixed —— 它能跳出宿主 main 区域的 overflow:hidden 裁剪。",
          "窗口按钮是原生绘制的，两种模式都不会挡到。"
        )
      ),
      /*
       * 排除元素 —— **系统级设置**，所以放这里而不是画布控制台。
       *
       * 它改的是宿主自己的界面（别的插件面板、悬浮物），不是星海的渲染参数；
       * 而且设一次就长期有效，不需要边调边看。
       * 只有用户自己知道要藏哪一块，所以给一个选择器输入框。
       */
      h(
        "div",
        { style: S.card },
        h("div", { style: S.cardTitle }, "排除元素"),
        h(
          "div",
          { style: S.rowHint, marginBottom: 6 },
          "填宿主那边的真实文档的 class 或 id，命中的元素会被隐藏 —— 用来盖掉挡在星海上面的其它插件浮层。",
          "一行一个例如：#foo 和 .foo"
        ),
        h("textarea", {
          value: excludeInput,
          placeholder: "#foo\n.bar",
          spellCheck: false,
          style: S.excludeBox,
          onChange: (e) => setExcludeInput(e.target.value)
        }),
        h(
          "div",
          { style: { display: "flex", gap: 6, marginTop: 6 } },
          h("button", {
            style: S.primary,
            title: "隐藏匹配到的元素（只改显示，不删不改别的）",
            "data-memorysea-exclude-apply": "1",
            onClick: () => {
              const raw = String(excludeInput || "");
              const sels = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
              /* 和主面板 effect 用同一套判断：会连星海一起藏掉的，跳过 */
              const mc = document.querySelector("[data-memorysea-labels]");
              const isMine = (el) => !!mc && (el === mc || el === mc.parentElement || el.contains(mc));
              let hit = 0;
              let skipped = 0;
              for (const s of sels) {
                let bad = false;
                let n = 0;
                try {
                  const list = document.querySelectorAll(s);
                  n = list.length;
                  list.forEach((el) => { if (isMine(el)) bad = true; });
                } catch { bad = true; }
                if (bad) { skipped += 1; continue; }
                hit += n;
              }
              setCfg({ excludeSelectors: raw });
              setExcludeHit(skipped
                ? "命中 " + hit + " 个元素（" + skipped + " 条会藏到星海自己，已跳过）"
                : "命中 " + hit + " 个元素");
            }
          }, "应用"),
          h("button", {
            style: S.primary,
            title: "全部恢复显示",
            onClick: () => { setExcludeInput(""); setExcludeHit(""); setCfg({ excludeSelectors: "" }); }
          }, "恢复")
        ),
        excludeHit
          ? h("div", { style: Object.assign({}, S.rowHint, { marginTop: 6, opacity: 0.92 }) }, excludeHit)
          : null,
        h(
          "div",
          { style: Object.assign({}, S.rowHint, { marginTop: 6 }) },
          "实现是往页面注入一条 style（display:none !important），清空或点「恢复」立即拔掉，宿主元素本身不受任何改动。",
          "如果某条选择器会连星海面板一起藏掉，它会被自动跳过并在控制台提示。"
        )
      ),
      h(
        "div",
        { style: S.card },
        h("div", { style: S.cardTitle }, "画布背景"),
        h(
          "div",
          { style: S.cardDesc },
          "把面板调成半透明玻璃，后面就能透出宿主界面。不透明度低于 100 时，磨砂才看得出来。"
        ),
        h(
          "div",
          { style: S.row },
          h(
            "div",
            { style: S.rowText },
            h("div", { style: S.rowLabel }, "背景颜色"),
            h("div", { style: S.rowHint }, "默认深海黑 #05060b；浅色主题可换浅色")
          ),
          h(
            "div",
            { style: S.colorWrap },
            h("input", {
              type: "color",
              value: live.bgColor,
              style: S.swatch,
              onChange: (e) => setCfg({ bgColor: e.target.value })
            }),
            h("span", { style: S.value }, live.bgColor)
          )
        ),
        h(
          "div",
          { style: S.row },
          h(
            "div",
            { style: S.rowText },
            h("div", { style: S.rowLabel }, "不透明度"),
            h("div", { style: S.rowHint }, "0 完全透明，100 完全遮住底下")
          ),
          h("span", { style: S.value }, live.bgAlpha + " %")
        ),
        h("input", {
          type: "range",
          min: 0,
          max: 100,
          step: 1,
          value: live.bgAlpha,
          style: S.range,
          onChange: (e) => setCfg({ bgAlpha: Number(e.target.value) })
        }),
        h(
          "div",
          { style: S.row },
          h(
            "div",
            { style: S.rowText },
            h("div", { style: S.rowLabel }, "磨砂模糊"),
            h("div", { style: S.rowHint }, "透出底下内容再糊一层，0 = 不糊")
          ),
          h("span", { style: S.value }, live.bgBlur + " px")
        ),
        h("input", {
          type: "range",
          min: 0,
          max: 40,
          step: 1,
          value: live.bgBlur,
          style: S.range,
          onChange: (e) => setCfg({ bgBlur: Number(e.target.value) })
        }),
        h(
          "div",
          { style: S.row },
          h(
            "div",
            { style: Object.assign({}, S.rowHint, { flex: 1 }) },
            "当前：" + panelBg(live.bgColor, live.bgAlpha) + " / " + panelBlur(live.bgBlur)
          ),
          h("button", {
            style: S.primary,
            onClick: () => setCfg({
              bgColor: CFG_DEFAULT.bgColor,
              bgAlpha: CFG_DEFAULT.bgAlpha,
              bgBlur: CFG_DEFAULT.bgBlur
            })
          }, "背景复位")
        )
      ),
      h(
        "div",
        { style: S.card },
        h("div", { style: S.cardTitle }, "深探"),
        h(
          "div",
          { style: S.rowHint },
          "点会话星 → 一次摊到消息层（不是逐级拨开）。收起是反向幂等。",
          h("br"),
          "展开状态只存内存，**关掉面板或重启就重置**，不落盘。"
        ),
        h(
          "div",
          { style: S.mono },
          (() => {
            const c2 = cacheStats();
            return "分片缓存 " + c2.sessions + " 个会话 · " + c2.records + " 条 · 约 " + c2.mb + " MB（上限 12 个）";
          })()
        ),
        h(
          "div",
          { style: S.row },
          h("div", { style: S.rowHint, flex: 1 }, "深探时新点从父节点冒出，已有节点钉住不动"),
          h("button", {
            style: Object.assign({}, S.btn, { padding: "3px 9px", fontSize: 12 }),
            onClick: () => {
              const n = clearCache();
              setDataStat((prev) => prev ? Object.assign({}, prev) : prev);
              if (window.console) console.info("[dsh-plugin-memory-sea] 已清空分片缓存：" + n + " 个会话");
            }
          }, "清空缓存")
        )
      ),
      h(
        "div",
        { style: S.card },
        h("div", { style: S.cardTitle }, "当前状态"),
        h(
          "div",
          { style: S.mono },
          dataStat ? "会话 " + dataStat.sessions + " · 轮次 " + dataStat.turns + " · 项目 " + dataStat.cwds + (dataStat.phase === "indexing" ? "（索引中 " + dataStat.progress.done + "/" + dataStat.progress.total + "）" : "（已索引）") : "还没读到真实数据 —— 面板会显示示例场景",
          h("br"),
          "预设 " + presetById(live.preset).name + " · 配色 " + (live.colorBy === "theme" ? (THEMES.find((t) => t.id === live.theme) || THEMES[0]).name : "按记忆类型"),
          h("br"),
          "渲染 three.js + UnrealBloom · 布局 d3-force-3d + 星系力",
          h("br"),
          "数据只读：宿主 → 插件 → 画布，不写回任何会话",
          h("br"),
          "配置键 " + CFG_KEY
        ),
        h(
          "div",
          { style: S.row },
          h("div", { style: S.rowHint, flex: 1 }, "改动只落浏览器本地，不写你的记忆数据"),
          h("button", {
            style: S.primary,
            onClick: () => setCfg(Object.assign({}, CFG_DEFAULT))
          }, "全部恢复默认")
        )
      ),
      /*
       * 关于。
       * 版本号由 build.mjs 从 package.open.json 注入（__MS_VERSION__），
       * 不手写 —— 手写迟早和清单对不上，「关于」里显示的版本就会骗人。
       */
      h(
        "div",
        { style: S.card },
        h("div", { style: S.cardTitle }, "关于"),
        h(
          "div",
          { style: S.aboutRow },
          h("span", { style: S.aboutKey }, "版本"),
          h("span", { style: S.mono }, APP_VERSION)
        ),
        h(
          "div",
          { style: S.aboutRow },
          h("span", { style: S.aboutKey }, "开源"),
          h("a", {
            href: APP_REPO,
            target: "_blank",
            rel: "noreferrer noopener",
            style: S.aboutLink,
            "data-memorysea-about": "repo"
          }, APP_REPO)
        ),
        h(
          "div",
          { style: S.aboutRow },
          h("span", { style: S.aboutKey }, "许可"),
          h("span", { style: S.mono }, "MIT")
        ),
        h(
          "div",
          { style: Object.assign({}, S.rowHint, { marginTop: 8 }) },
          "只读的本地可视化：索引落在插件目录，不上传、不写回会话。"
        )
      )
    );
  }
  export function installSlots(ctx) {
    const slots = ctx.slots;
    try {
      slots.inject("main", function* () {
        yield slots.register({ name: "main", key: PANEL_ID }, SeaPanel);
      });
    } catch (e) {
      console.warn("[dsh-plugin-memory-sea] register main failed:", e);
    }
    try {
      slots.inject("sidebar.panellist", () => slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 30,
        label: () => "记忆海"
      }, MemorySeaIcon));
    } catch (e) {
      console.warn("[dsh-plugin-memory-sea] register sidebar failed:", e);
    }
    try {
      slots.inject("settings.section", () => slots.register({
        name: "settings.section",
        id: NS,
        order: 480,
        label: () => "记忆海"
      }, SettingsPage));
    } catch (e) {
      console.warn("[dsh-plugin-memory-sea] register settings failed:", e);
    }
  }
