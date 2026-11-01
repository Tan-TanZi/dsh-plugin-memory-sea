/**
 * 场景数据：把 memory-sea 的 scene（points/edges）适配成 three 渲染层要的形状，
 * 并保留原始 point 引用（渲染时取 kind / text / diary）。
 *
 * 不引入 galaxy-view 的 GraphStore —— 它继承 Obsidian 的 Component、要 App、
 * 读 metadataCache，跟这里没关系。只借它的数据结构形状。
 */
import demoJson from './demo.json';

export const DIARY_RGB = [1.0, 0.804, 0.471];

/** 记忆类型 → 线性 RGB（0..1），three 的顶点色用这个 */
export const KIND_RGB = {
	event: [0.588, 0.745, 1.0],      /* 经历 · 蓝 */
	feeling: [1.0, 0.627, 0.824],    /* 心情 · 粉 */
	fact: [0.510, 0.902, 0.784],     /* 事实 · 青 */
	plan: [1.0, 0.824, 0.549],       /* 约定 · 橙 */
	conclusion: [0.745, 0.647, 1.0], /* 结论 · 紫 */

	/*
	 * 真实数据层级（LOD 0-3）。
	 * 亮度刻意压低：这些值进 HDR 缓冲过 UnrealBloom，太亮会让密集区
	 * 直接过曝成白（1177 个点的真实数据实测就是全白）。
	 */
	session: [0.32, 0.54, 0.95],     /* 会话 · 蓝，恒星 */
	turn: [0.20, 0.38, 0.82],        /* 轮次 · 深蓝，行星 */
	record: [0.16, 0.62, 0.58],      /* 消息 · 青绿，卫星 */
	word: [0.20, 0.85, 0.75]         /* 词突触 · 青，跨簇桥接 */
};

/*
 * 消息层按**角色**再分色。
 *
 * 为什么必须分：深探一个会话会摊出几千条消息点，之前全是同一个青绿、同样大小，
 * 用户点进去只有"1340 字"，根本分不清哪条是提问、哪条是回答、哪条是工具调用
 * —— 观感就是"这么多重复的点，没有意义"。
 *
 * 分工：你偏蓝、她偏青、工具压暗当背景、压缩摘要金色（被蒸馏过的精华）。
 */
export const RECORD_RGB = {
	user: [0.34, 0.60, 1.0],
	assistant: [0.18, 0.88, 0.80],
	tool: [0.40, 0.46, 0.60],
	compaction: [1.0, 0.80, 0.40]
};

/**
 * points/edges → { nodes, links, degrees }
 *   · nodes 用数组下标做 id（three 的 BufferGeometry 按索引 gather 坐标）
 *   · links 的 source/target 是下标，d3-force-3d 直接按下标解析
 *   · degrees 给「hub 沉核」用：度数高的点被核心引力拉得更狠
 */
export function toGraph(scene) {
	const points = (scene && scene.points) || [];
	const edges = (scene && scene.edges) || [];

	const index = new Map();
	const nodes = points.map((p, i) => {
		index.set(p.id, i);
		return {
			index: i,
			id: p.id,
			point: p,
			degree: 0,
			/* 位置与速度由 layout 写入；这里给初值，避免 undefined 参与运算 */
			x: 0, y: 0, z: 0,
			vx: 0, vy: 0, vz: 0
		};
	});

	const links = [];
	for (let i = 0; i < edges.length; i += 1) {
		const e = edges[i];
		const a = index.get(e.a);
		const b = index.get(e.b);
		if (a === undefined || b === undefined || a === b) continue;
		links.push({ source: a, target: b, score: Number(e.score) || 0.3, kind: e.kind });
	}

	const degrees = new Float64Array(nodes.length);
	for (let i = 0; i < links.length; i += 1) {
		degrees[links[i].source] += 1;
		degrees[links[i].target] += 1;
	}
	for (let i = 0; i < nodes.length; i += 1) nodes[i].degree = degrees[i];

	return { nodes, links, degrees, index };
}

/** 示例场景（后续 ② 阶段换成 ctx.conversation 现算） */
export const DEMO = demoJson;

export function rgbOf(point) {
	if (point && point.diary) return DIARY_RGB;
	if (point && point.kind === 'record' && point.recordKind && RECORD_RGB[point.recordKind]) {
		return RECORD_RGB[point.recordKind];
	}
	return KIND_RGB[point && point.kind] || KIND_RGB.event;
}
