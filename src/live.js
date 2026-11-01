/**
 * 实时数据接入：把 host 索引出来的会话数据，转成渲染层能吃的 { points, edges }。
 *
 * 数据方向单一：host 只读会话 → 这里只做形状转换 → 画布。绝不回流。
 *
 * 第一版只接 LOD 2（会话 + 轮次），已经能验证「全局真实数据」。
 * LOD 3（消息）要靠「深探」按会话拉分片，下一轮再做。
 */

const API = '/api/dsh-memory-sea';

/**
 * 收集候选 base URL。
 *
 * 实测环境：桌面端页面跑在 `dsh-app://app`（自定义协议，不是 http/file）。
 * 宿主的协议 handler：
 *   · 静态资源路径（/、/index.html、/assets/、favicon、manifest）→ 本地文件
 *   · **其余一切**（包括 /api/**）→ `forwardWebRequest(request, hostUrl, hostCookie)`
 *     即转发到 host，并自动带上认证 cookie
 * 所以**相对路径才是正解**。
 *
 * 坑：空字符串是合法候选（表示相对路径），不能因为 falsy 被过滤 ——
 * 之前这里写成 `if (u && ...)`，导致相对路径从未被尝试，只剩跨源的 127.0.0.1。
 */
function candidates() {
	const out = [];
	const push = (u) => {
		if (typeof u !== 'string') return;
		if (out.includes(u)) return;
		out.push(u);          /* 允许空字符串：它就是"相对路径" */
	};

	/* 1) 相对路径：dsh-app://app/api/... → 协议 handler 转发到 host（首选） */
	push('');

	/* 2) Web 模式下 origin 与相对路径等价，留作兜底 */
	try {
		if (/^https?:/.test(location.protocol)) push(location.origin.replace(/\/+$/, ''));
	} catch { /* ignore */ }

	/* 3) boot 信息里若带真实 origin，可直连 */
	try {
		const boot = (typeof window !== 'undefined' && window.__DSH_BOOT__) || null;
		if (boot && typeof boot === 'object') {
			const o = boot.origin || boot.url || boot.baseUrl || boot.serverUrl || boot.streamBaseUrl;
			if (typeof o === 'string' && /^https?:/.test(o)) push(o.replace(/\/+$/, ''));
		}
	} catch { /* ignore */ }

	/* 4) 桌面端固定端口：跨源，通常会被 CORS 挡，放最后 */
	push('http://127.0.0.1:19387');

	return out;
}

let resolvedBase = null;   /* 第一次成功后缓存，后续直接用 */

async function requestJson(path) {
	if (resolvedBase !== null) {
		const res = await fetch(resolvedBase + path, { credentials: 'include' });
		if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + (resolvedBase || '(相对)') + path);
		return res.json();
	}

	const errors = [];
	for (const base of candidates()) {
		const url = base + path;
		try {
			const res = await fetch(url, { credentials: 'include' });
			if (res.ok) {
				resolvedBase = base;
				return res.json();
			}
			/* 非 2xx 时把响应体也读出来 —— 400/500 的原因通常就写在里面 */
			let detail = '';
			try {
				const t = await res.text();
				if (t) detail = '「' + t.slice(0, 160).replace(/\s+/g, ' ') + '」';
			} catch { /* ignore */ }
			errors.push('HTTP ' + res.status + detail + ' @ ' + (base || '(相对)'));
		} catch (e) {
			errors.push(String((e && e.message) || e).slice(0, 80) + ' @ ' + (base || '(相对)'));
		}
	}
	throw new Error('全部失败：' + errors.join(' | '));
}

/** 拉全局场景（会话 + 全部轮次，通常 < 1 MB） */
export async function fetchLiveScene() {
	return requestJson(API + '/scene');
}

/** 拉某个会话的消息分片（深探时用） */
export async function fetchShard(sessionId) {
	return requestJson(API + '/shard?session=' + encodeURIComponent(sessionId));
}

/** 诊断信息：失败时显示在面板上，不用开 DevTools */
export function describeEnv() {
	const bits = [];
	try { bits.push('proto=' + location.protocol); } catch { /* ignore */ }
	try { bits.push('host=' + location.host); } catch { /* ignore */ }
	try { bits.push('boot=' + (typeof window.__DSH_BOOT__)); } catch { /* ignore */ }
	bits.push('base=' + (resolvedBase === null ? '(未定)' : (resolvedBase || '(相对)')));
	return bits.join(' · ');
}

function shortId(id) {
	return String(id || '').replace(/^session-/, '').slice(0, 8);
}

function cwdLabel(cwd) {
	if (!cwd) return '(未知)';
	const parts = String(cwd).split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || String(cwd);
}

/**
 * payload（host 的 scene）→ 渲染用的 points/edges。
 * @returns null 表示没有可用数据（调用方应当退回 DEMO）
 */
export function toLiveScene(payload) {
	const sessions = (payload && payload.sessions) || [];
	const turns = (payload && payload.turns) || [];
	if (!sessions.length) return null;

	/* cwd → 簇索引：18 个项目就是 18 个星系 */
	const cwds = [];
	const cwdIdx = new Map();
	for (const s of sessions) {
		const c = s.cwd || '(未知)';
		if (!cwdIdx.has(c)) {
			cwdIdx.set(c, cwds.length);
			cwds.push({ id: cwds.length, label: cwdLabel(c), cwd: c });
		}
	}

	const points = [];
	const edges = [];
	const sessionIds = new Set();

	/*
	 * 会话级的字数 / 工具次数汇总。
	 *
	 * 索引里 userLen / assistantLen / toolCount 只记在**轮次**上，
	 * 会话的 stats 从来没有这三个字段 —— 于是详情卡永远是"你/她 0/0 字"。
	 * 这里在组装场景时按 sessionId 累加一遍（1345 条，几毫秒），
	 * 数据本来就在，不用重跑索引。
	 */
	const agg = new Map();
	for (const t of turns) {
		let a = agg.get(t.sessionId);
		if (!a) {
			a = { userLen: 0, assistantLen: 0, toolCount: 0, digest: '' };
			agg.set(t.sessionId, a);
		}
		a.userLen += t.userLen || 0;
		a.assistantLen += t.assistantLen || 0;
		a.toolCount += t.toolCount || 0;
		/* 会话的「内容」= 该会话最早一轮的开头（标签写内容时用） */
		if (!a.digest && t.preview) a.digest = t.preview;
	}

	for (const s of sessions) {
		const sid = 'S:' + s.id;
		sessionIds.add(sid);
		points.push({
			id: sid,
			kind: 'session',
			title: s.title || shortId(s.id),
			subtitle: cwdLabel(s.cwd),
			/* 标签层的「内容」模式读它：没有这句，会话标签在名称/内容之间切换毫无变化 */
			digest: (agg.get(s.id) || {}).digest || '',
			cwd: s.cwd,
			cluster: cwdIdx.get(s.cwd || '(未知)'),
			sessionId: s.id,
			/* 点大小：按记录数，开方压缩一下，避免超大会话压成一颗太阳 */
			weight: Math.max(1, Math.sqrt(s.recordCount || 1)),
			stats: {
				turns: s.turnCount || 0,
				records: s.recordCount || 0,
				createdAt: s.createdAt || 0,
				updatedAt: s.updatedAt || 0,
				/* 会话级汇总：详情卡的「你/她」「工具调用」靠它 */
				userLen: agg.has(s.id) ? agg.get(s.id).userLen : 0,
				assistantLen: agg.has(s.id) ? agg.get(s.id).assistantLen : 0,
				toolCount: agg.has(s.id) ? agg.get(s.id).toolCount : 0
			}
		});
	}

	let dropped = 0;
	for (const t of turns) {
		const parent = 'S:' + t.sessionId;
		if (!sessionIds.has(parent)) { dropped += 1; continue; }

		const tid = 'T:' + t.id;
		points.push({
			id: tid,
			kind: 'turn',
			title: '第 ' + ((t.idx || 0) + 1) + ' 轮',
			subtitle: (t.preview || '').slice(0, 60),
			cwd: t.cwd,
			cluster: cwdIdx.get(t.cwd || '(未知)'),
			sessionId: t.sessionId,
			turnId: t.id,
			t: t.startedAt || 0,
			weight: Math.max(0.25, (t.weight || 0.2) * 2.2),
			stats: {
				userLen: t.userLen || 0,
				assistantLen: t.assistantLen || 0,
				toolCount: t.toolCount || 0
			}
		});
		edges.push({ a: parent, b: tid, score: 1, kind: 'turn' });
	}

	return {
		points,
		edges,
		clusters: cwds,
		live: true,
		meta: (payload && payload.meta) || {},
		progress: (payload && payload.progress) || {},
		droppedTurns: dropped
	};
}
// touch
