/**
 * 验证 8 套预设真的把星系摆成不同形状（而不是挂个名字）。
 *
 * 用 esbuild 打包后跑：
 *   npx esbuild tools/verify-presets.mjs --bundle --platform=node --format=esm --outfile=out/verify-presets.mjs
 *   node out/verify-presets.mjs
 */
import { toGraph } from '../src/scene.js';
import { runLayout } from '../src/layout.js';
import { STYLE_PRESETS, presetPatch, colorFnFor, THEMES } from '../src/presets.js';
import demo from '../src/demo.json';

let failed = 0;
function check(name, ok, extra) {
	console.log((ok ? '✓ ' : '✗ ') + name + (extra ? '  ' + extra : ''));
	if (!ok) failed += 1;
}

check('预设 8 套', STYLE_PRESETS.length === 8, STYLE_PRESETS.map((p) => p.name).join(' / '));
check('配色 6 套', THEMES.length === 6, THEMES.map((t) => t.name).join(' / '));

/* 每套预设都必须有完整字段 */
const REQUIRED = [
	'repel', 'linkDistance', 'linkStrength', 'centerPull', 'flatten', 'coreGravity', 'spiral',
	'bloomStrength', 'bloomRadius', 'bloomThreshold',
	'nodeSize', 'linkOpacity', 'linkCurve', 'twinkle',
	'nebula', 'fieldStars', 'clusterClouds',
	'frameElevDeg', 'theme', 'starfield', 'preset'
];
let missing = 0;
for (const p of STYLE_PRESETS) {
	const patch = presetPatch(p);
	for (const k of REQUIRED) {
		const v = patch[k];
		if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) {
			console.log('   ! ' + p.name + ' 缺 ' + k + ' = ' + v);
			missing += 1;
		}
	}
}
check('全部预设字段完整', missing === 0, missing ? missing + ' 处缺失' : '');

/* 跑布局，看形态 */
const rows = [];
for (const p of STYLE_PRESETS) {
	const g = toGraph(demo);
	const patch = presetPatch(p);
	runLayout(g, patch);
	let sx = 0, sy = 0, sz = 0;
	for (const n of g.nodes) { sx += n.x * n.x; sy += n.y * n.y; sz += n.z * n.z; }
	sx = Math.sqrt(sx / g.nodes.length);
	sy = Math.sqrt(sy / g.nodes.length);
	sz = Math.sqrt(sz / g.nodes.length);
	let bad = 0;
	for (const n of g.nodes) if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) bad += 1;
	rows.push({ name: p.name, sx, sy, sz, flat: sy / (sx || 1), bad, blend: p.physics.blend });
}

console.log('\n预设形态（σ = 各轴标准差，越扁 y/x 越小）：');
console.log('  名称      σx      σy      σz     y/x    NaN');
for (const r of rows) {
	console.log(
		'  ' + r.name.padEnd(6) +
		String(r.sx.toFixed(0)).padStart(6) +
		String(r.sy.toFixed(0)).padStart(8) +
		String(r.sz.toFixed(0)).padStart(8) +
		r.flat.toFixed(2).padStart(8) +
		String(r.bad).padStart(6)
	);
}

check('全部预设坐标有限', rows.every((r) => r.bad === 0));

/* 形态必须真的不同 */
const flats = rows.map((r) => r.flat);
const spread = Math.max(...flats) - Math.min(...flats);
check('扁平度有明显区分度', spread > 0.15, 'y/x 从 ' + Math.min(...flats).toFixed(2) + ' 到 ' + Math.max(...flats).toFixed(2));

const deep = rows.find((r) => r.name === '深空场');
const spiral = rows.find((r) => r.name === '旋臂');
check('「深空场」是球（flatten=0）', deep && deep.flat > 0.5, 'y/x=' + (deep ? deep.flat.toFixed(2) : '?'));
check('「旋臂」是扁盘（flatten=0.75）', spiral && spiral.flat < 0.5, 'y/x=' + (spiral ? spiral.flat.toFixed(2) : '?'));

/* 染色：两种模式都能出颜色且互不相同 */
const kindFn = colorFnFor(demo, { colorBy: 'kind' });
const themeFn = colorFnFor(demo, { colorBy: 'theme', theme: 'cyber' });
const sample = demo.points.find((p) => !p.diary);
const ka = kindFn(sample);
const ta = themeFn(sample);
check('类型上色返回 RGB', Array.isArray(ka) && ka.length === 3, ka.map((v) => v.toFixed(2)).join(','));
check('主题簇上色返回 RGB', Array.isArray(ta) && ta.length === 3, ta.map((v) => v.toFixed(2)).join(','));
check('两种上色结果不同', ka[0] !== ta[0] || ka[1] !== ta[1] || ka[2] !== ta[2]);

/* 日记永远金色，不被主题淹没 */
const diary = demo.points.find((p) => p.diary);
if (diary) {
	const dk = themeFn(diary);
	check('日记保持金色', dk[0] > 0.9 && dk[1] > 0.7 && dk[2] < 0.6, dk.map((v) => v.toFixed(2)).join(','));
}

console.log('');
if (failed) {
	console.log('✗ ' + failed + ' 项失败');
	process.exit(1);
}
console.log('✓ 全部通过');
