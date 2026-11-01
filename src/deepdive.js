/**
 * 深探：把一个会话摊开到消息层。
 *
 * 语义（用户定的）：**一次到底**，不是逐级拨开 —— 点会话星就把它名下所有
 * 轮次的消息全部激活亮起来。唯一的限制是"你点了哪颗"。
 *
 * 收起是反向幂等：再点一次，整枝缩回去。
 */
import { fetchShard } from './live.js';

/* 分片缓存（只存内存，重启即失效 —— 符合"深探状态不落盘"的约定） */
const shardCache = new Map();
const MAX_CACHE = 12;

async function loadShard(sid) {
	if (shardCache.has(sid)) {
		/* LRU：命中就挪到末尾 */
		const hit = shardCache.get(sid);
		shardCache.delete(sid);
		shardCache.set(sid, hit);
		return hit;
	}
	const data = await fetchShard(sid);
	const recs = (data && data.records) || [];
	shardCache.set(sid, recs);
	while (shardCache.size > MAX_CACHE) {
		const first = shardCache.keys().next().value;
		shardCache.delete(first);
	}
	return recs;
}

/**
 * 拉一个会话的消息，转成可合并的 points/edges。
 * 边只连「轮次 → 消息」，不连消息之间的顺序链 —— 否则一个 4000 条的会话
 * 会多出 4000 条边，画面立刻糊成一团。
 */
export async function buildSessionAddon(sid) {
	const recs = await loadShard(sid);
	const points = [];
	const edges = [];

	for (const r of recs) {
		const pid = 'R:' + r.id;
		points.push({
			id: pid,
			kind: 'record',
			recordKind: r.kind,          /* user | assistant | tool | compaction */
			sessionId: r.sessionId || sid,
			turnId: r.turnId,
			t: r.t || 0,
			len: r.len || 0,
			toolName: r.toolName || '',
			tokens: r.tokens || [],
			/* 正文预览：详情面板靠它说明"这条到底是什么" */
			text: r.preview || '',
			/* 消息点比轮次小，权重也压低一点，避免盖过层级感 */
			weight: Math.max(0.25, (r.weight || 0.2) * 1.4),
			title: r.kind === 'tool'
				? ('工具 ' + (r.toolName || ''))
				: (r.kind === 'compaction' ? '压缩摘要' : (r.len ? r.len + ' 字' : '(空)')),
			subtitle: (r.cwd || '').split(/[\\/]/).pop() || ''
		});
		edges.push({ a: 'T:' + r.turnId, b: pid, score: 0.85, kind: 'record' });
	}
	return { points, edges, recordCount: recs.length };
}

/** 合并进现有场景（按 id 去重，边按 a>b 去重） */
export function mergeAddon(base, addon) {
	const seenP = new Set(base.points.map((p) => p.id));
	const points = base.points.slice();
	for (const p of addon.points) {
		if (seenP.has(p.id)) continue;
		seenP.add(p.id);
		points.push(p);
	}

	const seenE = new Set(base.edges.map((e) => e.a + '\u0000' + e.b));
	const edges = base.edges.slice();
	for (const e of addon.edges) {
		const k = e.a + '\u0000' + e.b;
		if (seenE.has(k)) continue;
		seenE.add(k);
		edges.push(e);
	}

	return {
		points,
		edges,
		clusters: base.clusters,
		live: base.live,
		meta: base.meta,
		progress: base.progress
	};
}

/** 收起：把这个会话的消息点和相关边全部摘掉 */
export function removeSessionAddon(base, sid) {
	const keep = (p) => !(p.kind === 'record' && p.sessionId === sid);
	const points = base.points.filter(keep);
	const alive = new Set(points.map((p) => p.id));
	const edges = base.edges.filter((e) => alive.has(e.a) && alive.has(e.b));
	return {
		points,
		edges,
		clusters: base.clusters,
		live: base.live,
		meta: base.meta,
		progress: base.progress
	};
}

/**
 * 算出「已展开的轮次 → 父节点」，供布局层让新点从父位置冒出来。
 * 布局层的 pinned 用的是**展开前**的坐标表，spawnFrom 用来决定新点从哪出生。
 */
export function spawnMapFor(addon) {
	const map = new Map();
	for (const e of addon.edges) {
		if (e.kind === 'record') map.set(e.b, e.a);
	}
	return map;
}

/** 当前场景里每个节点的坐标快照（下一次深探时当作 pinned） */
export function snapshotPositions(graph) {
	const map = new Map();
	if (!graph || !graph.nodes) return map;
	for (const n of graph.nodes) {
		map.set(n.id, { x: n.x, y: n.y, z: n.z });
	}
	return map;
}

/** 缓存统计（设置面板显示用） */
export function cacheStats() {
	let bytes = 0;
	let records = 0;
	for (const arr of shardCache.values()) {
		records += arr.length;
		bytes += arr.length * 120;   /* 粗估 */
	}
	return { sessions: shardCache.size, records, mb: +(bytes / 1048576).toFixed(1) };
}

export function clearCache() {
	const n = shardCache.size;
	shardCache.clear();
	return n;
}
