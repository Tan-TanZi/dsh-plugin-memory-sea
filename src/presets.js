/**
 * 风格预设 + 配色主题。
 *
 * 全部来自 galaxy-view（Longwind1984/galaxy-view, MIT）：
 *   · STYLE_PRESETS ← src/render/stylePresets.ts
 *   · THEMES        ← src/render/colorThemes.ts
 * 数值一个没改 —— 这些是作者在真机上眼调出来的，改了就失去区分度。
 *
 * 每个预设同时拉开五个维度：星空开关 / 配色 / 大小 / 力学 / 辉光，
 * 外加盘面取景仰角（frameElevDeg）与两层深空背景强度（space）。
 */
import { rgbOf, DIARY_RGB, RECORD_RGB } from './scene.js';

/* ══ 配色主题 ══════════════════════════════════════════════════════════ */
export const THEMES = [
	{
		id: 'hubble', name: '哈勃深空',
		/* 哈勃假彩色：电离氧青、氢α金、硫离子锈红 */
		colors: ['#46d4dc', '#ffc35c', '#d05a32', '#7fd0a0', '#e8d9a0', '#5a9bd8', '#d87fa8', '#9a7fe0', '#cfd8e8']
	},
	{
		id: 'tiktok', name: '抖音霓虹',
		colors: ['#25f4ee', '#fe2c55', '#ffffff', '#7ae8e2', '#ff7a9c', '#19b8b2', '#c2244a', '#a8f0ec', '#ffd0dc']
	},
	{
		id: 'sunset', name: '落日胶片',
		colors: ['#f58529', '#dd2a7b', '#8134af', '#515bd4', '#feda77', '#e1306c', '#c13584', '#fd8d32', '#405de6']
	},
	{
		id: 'cyber', name: '赛博都市',
		colors: ['#fcee0a', '#00f0ff', '#ff003c', '#9d00ff', '#00ff9f', '#ff6ec7', '#3df5ff', '#ffe600', '#c800ff']
	},
	{
		id: 'matrix', name: '黑客帝国',
		colors: ['#00ff41', '#33ff66', '#00cc34', '#66ff8c', '#00b32d', '#80ffa0', '#1aff4d', '#00e639', '#4dff79']
	},
	{
		id: 'aurora', name: '极光',
		colors: ['#1db954', '#00d4ff', '#7f5fff', '#38f0c0', '#4fa8ff', '#9f7fff', '#22e6a8', '#66c2ff', '#b08fff']
	}
];

/* ══ 风格预设 ══════════════════════════════════════════════════════════ */
export const STYLE_PRESETS = [
	{
		id: 'galaxy', name: '银河', nameEn: 'Galaxy',
		starfield: true, theme: 'hubble', frameElevDeg: 50,
		space: { nebula: 0.35, fieldStars: 0.25, clusterClouds: 0.3 },
		bloom: { strength: 0.35, radius: 0.35, threshold: 0.22 },
		physics: { repel: 170, linkDistance: 55, linkStrength: 1.1, centerPull: 0.05, flatten: 0.55, coreGravity: 0.1, spiral: 0.02 },
		look: { nodeSize: 1, linkOpacity: 0.14, linkCurve: 0.35, twinkle: 0.5 }
	},
	{
		id: 'spiral', name: '旋臂', nameEn: 'Spiral',
		starfield: true, theme: 'aurora', frameElevDeg: 62,
		space: { nebula: 0.4, fieldStars: 0.35, clusterClouds: 0.35 },
		bloom: { strength: 0.5, radius: 0.45, threshold: 0.2 },
		physics: { repel: 150, linkDistance: 62, linkStrength: 1.15, centerPull: 0.06, flatten: 0.75, coreGravity: 0.22, spiral: 0.095 },
		look: { nodeSize: 1, linkOpacity: 0.16, linkCurve: 0.72, twinkle: 0.6 }
	},
	{
		id: 'orbits', name: '轨道', nameEn: 'Orbits',
		starfield: true, theme: 'sunset', frameElevDeg: 35,
		space: { nebula: 0.12, fieldStars: 0.1, clusterClouds: 0 },
		bloom: { strength: 0.42, radius: 0.35, threshold: 0.24 },
		physics: { repel: 200, linkDistance: 95, linkStrength: 0.9, centerPull: 0.09, flatten: 0.5, coreGravity: 0.2, spiral: 0 },
		look: { nodeSize: 1.15, linkOpacity: 0.11, linkCurve: 0.75, twinkle: 0.4 }
	},
	{
		id: 'deepfield', name: '深空场', nameEn: 'Deep Field',
		starfield: true, theme: 'hubble', frameElevDeg: 18,
		space: { nebula: 0.55, fieldStars: 0.65, clusterClouds: 0.25 },
		bloom: { strength: 0.28, radius: 0.4, threshold: 0.3 },
		physics: { repel: 300, linkDistance: 110, linkStrength: 1.5, centerPull: 0.02, flatten: 0, coreGravity: 0, spiral: 0 },
		look: { nodeSize: 0.8, linkOpacity: 0.08, linkCurve: 0, twinkle: 0.3 }
	},
	{
		id: 'nebula', name: '星云', nameEn: 'Nebula',
		starfield: false, theme: 'tiktok', frameElevDeg: 18,
		space: { nebula: 0.8, fieldStars: 0.45, clusterClouds: 0.7 },
		bloom: { strength: 0.6, radius: 0.32, threshold: 0.2 },
		physics: { repel: 150, linkDistance: 70, linkStrength: 0.9, centerPull: 0.03, flatten: 0.15, coreGravity: 0.03, spiral: 0 },
		look: { nodeSize: 1.05, linkOpacity: 0.2, linkCurve: 0.45, twinkle: 0.5 }
	},
	{
		id: 'minimal', name: '极简', nameEn: 'Minimal',
		starfield: false, theme: 'matrix', frameElevDeg: 18,
		space: { nebula: 0, fieldStars: 0, clusterClouds: 0 },
		bloom: { strength: 0, radius: 0.3, threshold: 0.3 },
		physics: { repel: 230, linkDistance: 80, linkStrength: 1, centerPull: 0.04, flatten: 0, coreGravity: 0, spiral: 0 },
		look: { nodeSize: 0.8, linkOpacity: 0.07, linkCurve: 0, twinkle: 0 }
	},
	{
		id: 'fireworks', name: '烟火', nameEn: 'Fireworks',
		starfield: false, theme: 'cyber', frameElevDeg: 18,
		space: { nebula: 0, fieldStars: 0, clusterClouds: 0 },
		bloom: { strength: 1, radius: 0.38, threshold: 0.16 },
		physics: { repel: 150, linkDistance: 58, linkStrength: 1.3, centerPull: 0.05, flatten: 0, coreGravity: 0, spiral: 0 },
		look: { nodeSize: 1.2, linkOpacity: 0.28, linkCurve: 0.2, twinkle: 1.3 }
	},
	{
		id: 'supernova', name: '超新星', nameEn: 'Supernova',
		starfield: false, theme: 'sunset', frameElevDeg: 22,
		space: { nebula: 0.45, fieldStars: 0.2, clusterClouds: 0.4 },
		bloom: { strength: 0.9, radius: 0.4, threshold: 0.18 },
		/* coreGravity 是负的：往外推，做「爆发」 */
		physics: { repel: 260, linkDistance: 62, linkStrength: 1.1, centerPull: 0.03, flatten: 0, coreGravity: -0.08, spiral: 0 },
		look: { nodeSize: 1.3, linkOpacity: 0.24, linkCurve: 0.3, twinkle: 1.5 }
	}
];

export function presetById(id) {
	for (const p of STYLE_PRESETS) if (p.id === id) return p;
	return STYLE_PRESETS[0];
}

/** 预设 → 扁平 cfg patch（可直接喂 setCfg） */
export function presetPatch(p) {
	return {
		preset: p.id,
		theme: p.theme,
		starfield: p.starfield,
		nebula: p.space.nebula,
		fieldStars: p.space.fieldStars,
		clusterClouds: p.space.clusterClouds,
		bloom: p.bloom.strength > 0,
		bloomStrength: p.bloom.strength,
		bloomRadius: p.bloom.radius,
		bloomThreshold: p.bloom.threshold,
		repel: p.physics.repel,
		linkDistance: p.physics.linkDistance,
		linkStrength: p.physics.linkStrength,
		centerPull: p.physics.centerPull,
		flatten: p.physics.flatten,
		coreGravity: p.physics.coreGravity,
		spiral: p.physics.spiral,
		nodeSize: p.look.nodeSize,
		linkOpacity: p.look.linkOpacity,
		linkCurve: p.look.linkCurve,
		twinkle: p.look.twinkle,
		frameElevDeg: p.frameElevDeg === undefined ? 18 : p.frameElevDeg
	};
}

/**
 * 这个预设"管得着"的字段集合。
 * 用户改了其中任何一个，就说明预设被改过 —— 面板标题要打星号。
 */
export function presetFields() {
	return Object.keys(presetPatch(STYLE_PRESETS[0])).filter((k) => k !== 'preset');
}

/** 当前 cfg 是否已经偏离了这个预设 */
export function presetIsDirty(cfg, p) {
	if (!cfg || !p) return false;
	const patch = presetPatch(p);
	const keys = Object.keys(patch);
	for (let i = 0; i < keys.length; i += 1) {
		const k = keys[i];
		if (k === 'preset') continue;
		if (cfg[k] !== patch[k]) return true;
	}
	return false;
}

/* ══ 染色 ══════════════════════════════════════════════════════════════ */
function hexToRgb(hex) {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
	if (!m) return [1, 1, 1];
	const v = parseInt(m[1], 16);
	return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** 线性同余洗牌：同一个 seed 打出同一个顺序（「配色洗牌」按钮用） */
function seededShuffle(arr, seed) {
	const a = arr.slice();
	let s = (Number(seed) >>> 0) || 1;
	for (let i = a.length - 1; i > 0; i -= 1) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		const j = s % (i + 1);
		const tmp = a[i];
		a[i] = a[j];
		a[j] = tmp;
	}
	return a;
}

/**
 * 造染色函数。
 *   colorBy = 'kind'     → 颜色 = 记忆类型（经历蓝 / 心情粉 / 事实青 / 约定橙 / 结论紫）
 *   colorBy = 'theme'    → 颜色 = 主题簇，按选中配色的 9 色循环
 *   themeSeed            → 非 0 时打乱配色顺序（「配色洗牌」）
 * 日记永远是金色（她的日记自成一类，不该被配色淹掉）。
 */
export function colorFnFor(scene, cfg) {
	const by = cfg && cfg.colorBy;
	if (by !== 'theme') return (p) => rgbOf(p);

	const theme = THEMES.find((t) => t.id === (cfg && cfg.theme)) || THEMES[0];
	const palette = (cfg && cfg.themeSeed) ? seededShuffle(theme.colors, cfg.themeSeed) : theme.colors;
	const order = [];
	const seen = new Set();
	const points = (scene && scene.points) || [];
	for (let i = 0; i < points.length; i += 1) {
		const c = points[i].cluster || points[i].topic || '';
		if (!seen.has(c)) { seen.add(c); order.push(c); }
	}
	const map = new Map();
	for (let i = 0; i < order.length; i += 1) {
		map.set(order[i], hexToRgb(palette[i % palette.length]));
	}
	return (p) => {
		if (p && p.diary) return DIARY_RGB;
		/* 消息层按角色着色，不吃主题色 —— 深探后几千个点全是同一个簇色就看不出结构了 */
		if (p && p.kind === 'record' && p.recordKind && RECORD_RGB[p.recordKind]) {
			return RECORD_RGB[p.recordKind];
		}
		const c = p && (p.cluster || p.topic);
		return map.get(c) || rgbOf(p);
	};
}
