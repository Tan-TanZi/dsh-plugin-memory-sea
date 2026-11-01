/**
 * 验证 d3-force-3d 的 forceLink 会改写 link.source/target，
 * 以及 render.js 的 nodeAt 能兼容改写后的形态。
 *
 * 这是上一版「点开面板什么都没有 / Cannot read properties of undefined (reading 'x')」
 * 的根因回归测试。
 *
 * 用 esbuild 打包后再跑（scene.js 里有 import demo.json，Node 原生 ESM 不支持）：
 *   npx esbuild tools/verify-links.mjs --bundle --platform=node --format=esm --outfile=out/verify.mjs
 *   node out/verify.mjs
 */
import { toGraph } from '../src/scene.js';
import { runLayout } from '../src/layout.js';
import demo from '../src/demo.json';

let failed = 0;
function check(name, ok, extra) {
	console.log((ok ? '✓ ' : '✗ ') + name + (extra ? '  ' + extra : ''));
	if (!ok) failed += 1;
}

/* ── 1. 适配器：悬空边应该被丢掉 ── */
const scene = {
	points: [
		{ id: 'a', text: 'A', kind: 'event', cluster: 'x', weight: 1 },
		{ id: 'b', text: 'B', kind: 'fact', cluster: 'x', weight: 2 },
		{ id: 'c', text: 'C', kind: 'plan', cluster: 'y', weight: 1.5 }
	],
	edges: [
		{ a: 'a', b: 'b', score: 0.5 },
		{ a: 'b', b: 'c', score: 0.4 },
		{ a: 'a', b: 'zzz', score: 0.3 },
		{ a: 'a', b: 'a', score: 0.9 }
	]
};
const g1 = toGraph(scene);
check('悬空边与自环被丢弃', g1.links.length === 2, '得到 ' + g1.links.length + ' / 应为 2');
check('度数正确', g1.degrees[0] === 1 && g1.degrees[1] === 2, 'a=' + g1.degrees[0] + ' b=' + g1.degrees[1]);

/* ── 2. forceLink 确实会改写 source/target ── */
check('布局前 source 是数字', typeof g1.links[0].source === 'number', 'typeof=' + typeof g1.links[0].source);
runLayout(g1, {});
const after = typeof g1.links[0].source;
check('布局后 source 变成节点对象', after === 'object', 'typeof=' + after);

/* ── 3. nodeAt 兼容两种形态（这就是崩溃点） ── */
function nodeAt(nodes, ref) {
	if (typeof ref === 'number') return nodes[ref] || null;
	if (ref && typeof ref.index === 'number') return nodes[ref.index] || null;
	return null;
}
function refIndex(ref) {
	if (typeof ref === 'number') return ref;
	if (ref && typeof ref.index === 'number') return ref.index;
	return -1;
}
const a = nodeAt(g1.nodes, g1.links[0].source);
const b = nodeAt(g1.nodes, g1.links[0].target);
check('nodeAt 能取到端点', !!a && !!b, a && b ? a.id + '→' + b.id : 'null');
check('refIndex 能取回下标', refIndex(g1.links[0].source) >= 0, String(refIndex(g1.links[0].source)));

/* 旧的写法必须失败（证明这确实是根因） */
let oldCrashed = false;
try {
	const bad = g1.nodes[g1.links[0].source];
	/* 这里不抛，只是 undefined；真正崩在下一行读属性 */
	void bad.x;
} catch (e) {
	oldCrashed = true;
}
check('旧写法 nodes[对象] 会炸', oldCrashed, '这正是 Cannot read .x 的来源');

/* ── 4. 真实 24 点场景：坐标必须全为有限数 ── */
const g2 = toGraph(demo);
check('demo 24 点 / 24 边', g2.nodes.length === 24 && g2.links.length === 24,
	g2.nodes.length + ' / ' + g2.links.length);

const radius = runLayout(g2, {});
check('布局返回正半径', radius > 0, radius.toFixed(1));

let bad = 0;
for (const n of g2.nodes) {
	if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) bad += 1;
}
check('全部坐标有限', bad === 0, bad ? bad + ' 个 NaN' : '');

/* 星系形态：应该有扁盘（y 方差明显小于 x/z 方差） */
let sx = 0, sy = 0, sz = 0;
for (const n of g2.nodes) { sx += n.x * n.x; sy += n.y * n.y; sz += n.z * n.z; }
sx = Math.sqrt(sx / g2.nodes.length);
sy = Math.sqrt(sy / g2.nodes.length);
sz = Math.sqrt(sz / g2.nodes.length);
check('压盘生效（y 向更扁）', sy < sx && sy < sz,
	'σx=' + sx.toFixed(1) + ' σy=' + sy.toFixed(1) + ' σz=' + sz.toFixed(1));

/* ── 5. 所有连线端点都能解析（build() 里不会再 undefined） ── */
let unresolved = 0;
for (const l of g2.links) {
	if (!nodeAt(g2.nodes, l.source) || !nodeAt(g2.nodes, l.target)) unresolved += 1;
}
check('连线端点全部可解析', unresolved === 0, unresolved ? unresolved + ' 条悬空' : '');

console.log('');
if (failed) {
	console.log('✗ ' + failed + ' 项失败');
	process.exit(1);
}
console.log('✓ 全部通过');
