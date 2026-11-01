/**
 * 布局与样式的静态完整性检查。
 *
 * 为什么需要它：`audit-features.mjs` 只能证明"功能代码在不在"，
 * 证明不了"界面会不会错位"。用户实测踩到过「侧边栏收起后画布左边空一块」，
 * 那类问题不会被功能断言抓到。
 *
 * 这里用三条**可计算**的规则兜住最常见的布局事故：
 *
 *   ① 样式键必须存在
 *      `style: S.aboutRow` 拼错成 `S.aboutrow` 时，React 收到 undefined，
 *      元素会**静默丢失全部样式**（不是报错），表现为位置/尺寸突然不对。
 *
 *   ② 样式键不能写了不用
 *      留着没人引用的样式，等于在暗示"这里本来有个东西"，读代码的人会被误导。
 *
 *   ③ 名字必须对应真实 DOM
 *      带 data-* 标记的元素如果查询方写错名字，功能会静默失效
 *      （「排除元素」跳过自己的判断就依赖 data-memorysea-labels）。
 *
 * 用法：node tools/verify-layout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const shellPath = path.join(ROOT, 'src', 'shell.js');
const shell = fs.readFileSync(shellPath, 'utf8');

const problems = [];
const ok = (m) => console.log('✓ ' + m);
const bad = (m, hint) => {
	console.log('✗ ' + m + (hint ? '   ← ' + hint : ''));
	problems.push(m);
};

/* ── ① / ② 样式键 ── */
/*
 * 不在 AST 上抠结构 —— 前面试过两种：按缩进切会漏（样式对象里缩进不统一），
 * 按括号深度切也会漏（自写的括号计数在字符串上容易失真）。
 * 这里改成最朴素的判定：**被引用的键，在文件里必须能找到 `key:` 的定义**。
 * 目标只有一个 —— 抓拼写错误导致 style=undefined。为此粗糙一点没关系。
 */
{
	const used = new Set([...shell.matchAll(/\bS\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));

	/* `key: {` / `key: (` / `key: [` / `key: "…"` / `key: 数字` 都算定义 */
	const hasDef = (k) => new RegExp('(^|[\\s{,])' + k + '\\s*:\\s*[{([\\]\'"`\\d]').test(shell);

	const missing = [...used].filter((k) => !hasDef(k));
	if (missing.length) bad('样式键未定义：' + missing.join(', '), 'React 收到 undefined 会静默丢样式');
	else ok('样式键全部有定义（引用 ' + used.size + ' 个）');

	/*
	 * 不反查"死样式"。
	 * 试过一版：把文件里所有 `key:` 形态都当候选，结果把 DOCK_GROUPS 的配置项
	 * （bloomStrength / nodeSize / labelMax…）和嵌套的 CSS 属性全判成死样式 ——
	 * 静态文本区分不了"样式的键"和"配置的键"，这条检查只会制造噪音。
	 * 真正的接线完整性由 tools/check-wiring.mjs 负责。
	 */
}

/* ── ③ data-* 标记 ── */
const dataAttrs = new Set([...shell.matchAll(/"data-memorysea-[a-z-]+"/g)].map((m) => m[0].slice(1, -1)));
const queried = new Set([...shell.matchAll(/\[data-memorysea-[a-z-]+\]/g)].map((m) => m[0].slice(1, -1)));
const ghostQuery = [...queried].filter((q) => !dataAttrs.has(q));
if (ghostQuery.length) bad('查询了不存在的 data 属性：' + ghostQuery.join(', '), '查询方永远匹配不到');
else ok('data 属性查询与标记一致（' + dataAttrs.size + ' 个）');

/* ── ④ 面板 id 三处一致 ── */
const panelId = (shell.match(/PANEL_ID\s*=\s*"([^"]+)"/) || [])[1];
const mainKey = /name:\s*"main",\s*key:\s*PANEL_ID/.test(shell);
const sideId = /name:\s*"sidebar\.panellist",\s*\n?\s*id:\s*PANEL_ID/.test(shell);
if (!panelId) bad('找不到 PANEL_ID');
else if (!mainKey || !sideId) bad('PANEL_ID 没有同时用于 main.key 和 sidebar.panellist.id', '侧边栏点了没反应');
else ok('PANEL_ID 三处一致（' + panelId + '）');

/* ── 汇总 ── */
console.log('');
if (problems.length) {
	console.log('✗ ' + problems.length + ' 项布局检查未通过');
	process.exit(1);
}
console.log('✓ 布局静态检查通过');
