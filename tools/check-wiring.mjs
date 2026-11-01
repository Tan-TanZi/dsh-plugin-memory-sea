/**
 * 接线自检：每个可调参数必须真的有消费者。
 *
 * 起因：用户报「有些设置调了没用」。根因是 nodeSize / linkCurve 只在 build 时读一次，
 * 而它们不在重建触发条件里 → 拖滑杆毫无反应。这类 bug 靠肉眼看不出来，
 * 所以做成脚本：检查每个 cfg 键在 applyVisual / build / layout / presets / shell 里
 * 至少出现一次。
 *
 * 跑法：node tools/check-wiring.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');

const shell = src('shell.js');
const render = src('render.js');
const layout = src('layout.js');
const presets = src('presets.js');

function slice(code, startMark, endMark) {
	const a = code.indexOf(startMark);
	if (a < 0) return '';
	const b = endMark ? code.indexOf(endMark, a) : -1;
	return b > a ? code.slice(a, b) : code.slice(a);
}

const applyVisual = slice(render, 'function applyVisual', 'function setCameraElev');
/* 过滤：aShow 的写入点。所有 show 系列和 hiddenSessions 都必须在这里被读到 */
const applyFilterFn = slice(render, 'function applyFilter', 'function labelTextOf');
const applyAttrs = slice(render, 'function applyAttrs', 'function applyCurve');
const sizeArrayFn = slice(render, 'function sizeArrayFor', 'function colorArrayFor');
const applyCurveFn = slice(render, 'function applyCurve', 'function replayGrow');
const buildFn = slice(render, 'function build(scene_', 'function planGrow');
const runLayoutFn = slice(layout, 'export function runLayout', 'export function fitDistance');
const colorFn = slice(presets, 'export function colorFnFor');
const shellEffect = slice(shell, 'let lastGeom', 'return () => {');

/**
 * 每个 cfg 键 → 允许的消费者。
 *
 * 注意：2026-11 之后「配色 / 点大小依据 / 连线弯曲」不再走 build 重建，
 * 而是 applyAttrs（重写顶点属性）和 applyCurve（重采样边 buffer）。
 * 这样才是"拖一下就变"，不是"改个设置还要刷新"。
 */
const TARGETS = [
	['bloomStrength', [applyVisual]],
	['bloomRadius', [applyVisual]],
	['bloomThreshold', [applyVisual]],
	['bloom', [applyVisual]],
	['nodeSize', [applyVisual, applyAttrs, buildFn]],  /* 滑杆实时 + 重算 + 重建 */
	['sizeBy', [sizeArrayFn, applyAttrs, shellEffect]],
	['linkOpacity', [applyVisual, buildFn]],
	['linkCurve', [buildFn, applyCurveFn, shellEffect]],
	['twinkle', [applyVisual]],
	['starfield', [applyVisual]],
	['nebula', [applyVisual]],
	['fieldStars', [applyVisual]],
	['clusterClouds', [applyVisual]],
	['repel', [runLayoutFn]],
	['linkDistance', [runLayoutFn]],
	['linkStrength', [runLayoutFn]],
	['centerPull', [runLayoutFn]],
	['flatten', [runLayoutFn]],
	['coreGravity', [runLayoutFn]],
	['spiral', [runLayoutFn]],
	['clusterSpread', [runLayoutFn]],
	['clusterPull', [runLayoutFn]],
	['frameElevDeg', [buildFn, shellEffect]],
	['colorBy', [colorFn, shellEffect]],
	['theme', [colorFn, shellEffect]],
	['themeSeed', [colorFn, shellEffect]],
	['drift', [shellEffect]],
	['driftSpeed', [shellEffect]],
	['growMs', [shellEffect, buildFn]],
	['focusDepth', [applyVisual]],
	['dragStiffness', [applyVisual]],
	['dragDamping', [applyVisual]],
	['readOnly', [applyVisual, shell]],
	['labels', [applyVisual, shell]],
	['labelMax', [applyVisual]],
	['labelChars', [applyVisual]],
	['labelOverlap', [applyVisual, shell]],
	/* 过滤：四个消息类型 + 结构层级 + 会话选择，全部走 applyFilter */
	['showUser', [applyFilterFn, shell]],
	['showAssistant', [applyFilterFn, shell]],
	['showTool', [applyFilterFn, shell]],
	['showCompaction', [applyFilterFn, shell]],
	['showTurn', [applyFilterFn, shell]],
	['hiddenSessions', [applyFilterFn, shell]],
	['perfTier', [applyVisual]],
	['ssaa', [applyVisual]],
	/* 底色现在由 canvas 的 WebGL clearColor 提供（画布 fixed 到面板之外），
	   设置页仍读它做显示，所以两处都算消费者 */
	['bgColor', [applyVisual, shell]],
	['bgAlpha', [applyVisual, shell]],
	['bgBlur', [shell]]
];

let bad = 0;
console.log('参数接线自检（每个键必须至少有一个消费者）\n');

for (const [key, where] of TARGETS) {
	const found = [];
	for (const chunk of where) {
		if (!chunk) continue;
		if (chunk.includes('c.' + key) || chunk.includes('cfg.' + key) || chunk.includes('next.' + key) || chunk.includes('liveCfg.' + key)) {
			found.push(where.indexOf(chunk));
		}
	}
	const names = found.map((i) => {
		if (where[i] === applyVisual) return 'applyVisual';
		if (where[i] === applyAttrs) return 'applyAttrs';
		if (where[i] === sizeArrayFn) return 'sizeArrayFor';
		if (where[i] === applyCurveFn) return 'applyCurve';
		if (where[i] === buildFn) return 'build';
		if (where[i] === runLayoutFn) return 'layout';
		if (where[i] === colorFn) return 'colorFn';
		if (where[i] === shellEffect) return 'onCfg';
		if (where[i] === shell) return 'shell';
		return '?';
	});
	if (names.length) {
		console.log('✓ ' + key.padEnd(16) + names.join(' + '));
	} else {
		console.log('✗ ' + key.padEnd(16) + '没有任何消费者 ← 调了没用');
		bad += 1;
	}
}

/*
 * 额外：视觉参数必须**有就地应用路径**。
 *
 * 之前这里检查"必须在 geometryKey 里"，那正是"改设置要刷新"的病根 ——
 * 现在改为：要么进 geometryKey（真需要重排），要么有 applyAttrs / applyCurve。
 */
console.log('\n视觉参数必须有就地应用路径（不必重建几何）：');
const gk = slice(shell, 'function geometryKey', '/* ══ 主题 token');
const covered = [
	['linkCurve', gk.includes('linkCurve') || applyCurveFn.includes('curve')],
	['sizeBy', gk.includes('sizeBy') || sizeArrayFn.includes('sizeBy')],
	['colorBy', gk.includes('colorBy') || colorFn.includes('colorBy')]
];
for (const [key, ok] of covered) {
	console.log((ok ? '✓ ' : '✗ ') + key + (ok ? ' 有就地路径' : ' 改了没反应'));
	if (!ok) bad += 1;
}

/* 反向检查：几何键里不该混进纯视觉参数，否则每次都要整图重建 */
console.log('\ngeometryKey 只该含布局参数：');
const gkBody = slice(shell, 'function geometryKey(c)', '}');
for (const key of ['colorBy', 'theme', 'themeSeed', 'sizeBy', 'linkCurve']) {
	const leaked = gkBody.includes(key);
	console.log((leaked ? '✗ ' : '✓ ') + key + (leaked ? ' 混进几何键 ← 改它就得重建' : ' 不在几何键里'));
	if (leaked) bad += 1;
}

console.log('');
if (bad) {
	console.log('✗ ' + bad + ' 项未接线');
	process.exit(1);
}
console.log('✓ 全部接线');
