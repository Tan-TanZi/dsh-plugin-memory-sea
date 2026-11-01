/**
 * dsh-plugin-memory-sea — 服务端
 *
 * 职责：**只读**地把会话数据索引成星海需要的形状，通过 connection.fetch 暴露给浏览器侧。
 *
 * 铁律（见 docs/DATA-SOURCES.md 第四节）：
 *   · 只调 listSessions / listEvents / readSession 这类**读**方法
 *   · 不注册 tool、不碰 systemPrompt、不写任何会话文件
 *   · 数据单向：宿主 → 本插件 → 画布，**绝不回流**
 *
 * 两个外部不确定性，全部做成"自适应试错"：
 *   ① sessionQuery 的方法签名是 [native code]，拿不到参数形状 → tryVariants 逐个试
 *   ② 桌面端可能没有 connection（file:// + IPC）→ 运行时探测，没有就不注册路由
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-plugin-memory-sea';

/* 不声明 inject：缺服务时 ctx.get 返回 undefined，不会炸掉 fiber */
export const inject = [];

const API = '/api/dsh-memory-sea';
const SCHEMA = 2;   /* 2：record 增加 preview（详情面板要能读出内容） */
/*
 * store 路径。
 *
 * 两个候选：
 *   ① `~/.dsh/plugins/<包名>/store` —— 常规安装的真实位置
 *   ② 本文件所在包根下的 `store` —— 从 profile 的 node_modules 加载时
 *
 * 为什么要两个：host 半侧既可能从 plugins 目录加载，也可能从 profile 的
 * node_modules 镜像加载。如果只按自身位置推导，从镜像加载时会把索引写到
 * 镜像目录里的空 store，和真实数据分裂成两份 —— 界面读一份、host 写另一份。
 * 所以**默认优先 plugins 目录**，只有它不存在时才用自身位置。
 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = path.join(os.homedir(), '.dsh', 'plugins', 'dsh-plugin-memory-sea', 'store');
const STORE = fs.existsSync(PKG_DIR) ? PKG_DIR : path.join(PLUGIN_ROOT, 'store');

/* 索引多少条之后落一次盘（防止频繁 IO，也限制崩溃损失） */
const FLUSH_EVERY = 400;

/* ══════════════════════════════════════
 * 存储
 * ══════════════════════════════════════ */

function ensureStore() {
	try { fs.mkdirSync(path.join(STORE, 'records'), { recursive: true }); } catch { /* ignore */ }
}

function storePath(f) {
	return path.join(STORE, f);
}

function readJson(f, dflt) {
	try { return JSON.parse(fs.readFileSync(storePath(f), 'utf8')); } catch { return dflt; }
}

function writeJson(f, value) {
	ensureStore();
	const p = storePath(f);
	const tmp = p + '.tmp';
	try {
		fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
		fs.renameSync(tmp, p);
	} catch {
		/* rename 在某些 Windows 场景会 EPERM，退化成直接写 */
		try { fs.writeFileSync(p, JSON.stringify(value), 'utf8'); } catch { /* ignore */ }
		try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
	}
}

/* ══════════════════════════════════════
 * 自适应调用：拿不到签名就试
 * ══════════════════════════════════════ */

/**
 * 逐个尝试参数形状，返回第一个"有结果"的。
 * @param fn 已绑定 this 的函数
 * @param variants 返回参数的函数数组：
 *        · undefined  → 无参调用
 *        · 数组       → **多参数展开** fn(...args)（用于 observeSession(id, opts)）
 *        · 其他       → 单参数 fn(arg)
 * @param pick 从返回值里挑出期望的形状；挑不出就当失败继续试
 */
async function tryVariants(fn, variants, pick) {
	let lastErr = null;
	const tried = [];
	for (const make of variants) {
		let args;
		try { args = make(); } catch (e) { lastErr = e; continue; }
		const label = args === undefined ? '(no args)' : JSON.stringify(args).slice(0, 140);
		try {
			const r = args === undefined ? await fn()
				: Array.isArray(args) ? await fn(...args)
				: await fn(args);
			const v = pick ? pick(r) : r;
			tried.push({ args: label, ok: v !== undefined && v !== null });
			if (v !== undefined && v !== null) return { ok: true, value: v, raw: r, args: label, tried };
		} catch (e) {
			lastErr = e;
			tried.push({ args: label, ok: false, error: String(e && e.message || e).slice(0, 200) });
		}
	}
	return { ok: false, error: String(lastErr && lastErr.message || lastErr || 'all variants failed'), tried };
}

/** 释放 observation（observeSession 必须收尾，否则宿主会一直持有） */
function disposeObs(obs) {
	if (!obs) return;
	for (const m of ['close', 'dispose', 'release', 'stop']) {
		try {
			if (typeof obs[m] === 'function') { obs[m](); return; }
		} catch { /* ignore */ }
	}
}

const pickArray = (keys) => (r) => {
	if (Array.isArray(r)) return r;
	if (!r || typeof r !== 'object') return undefined;
	for (const k of keys) {
		if (Array.isArray(r[k])) return r[k];
	}
	return undefined;
};

const pickSessions = pickArray(['sessions', 'items', 'list', 'data']);
const pickEvents = pickArray(['events', 'items', 'list', 'data']);

function sessionVariants() {
	return [
		() => ({}),
		() => ({ limit: 1000 }),
		() => undefined,
		() => ({ includeArchived: true }),
		() => ({ offset: 0, limit: 1000 }),
		() => ({ all: true })
	];
}

/**
 * 读一个会话的事件流。
 *
 * 实证（两次踩坑）：
 *   ① `listEvents({ sessionId })` 报 `session "[object Object]" not found`
 *      → 第一参数是**字符串 id**
 *   ② 但 `listEvents(sid)` 拿回来的只是**事件壳**：
 *      `{ sessionId, seq, type, time, surface: "shadowed" }` —— 没有 data、没有内容
 *      → 内容被投影掉了，要靠 `observeSession(sid, { projectionMode: 'none' })`
 *
 * 所以顺序：observeSession（能拿完整事件） → listEvents（只有壳，至少能数出结构）
 */
async function readEvents(q, sid) {
	if (typeof q.observeSession === 'function') {
		const r = await tryVariants(
			q.observeSession.bind(q),
			[
				() => [sid, { projectionMode: 'none' }],
				() => [sid, { projectionMode: 'none', includeMedia: false }],
				() => sid,
				() => [sid]
			],
			pickEvents
		);
		try { disposeObs(r.raw); } catch { /* ignore */ }
		if (r.ok) return r;
		/* observeSession 全失败才退回 listEvents */
	}

	if (typeof q.listEvents === 'function') {
		const r = await tryVariants(
			q.listEvents.bind(q),
			[
				() => sid,
				() => ({ sessionId: sid }),
				() => [sid, { projectionMode: 'none' }]
			],
			pickEvents
		);
		if (r.ok) return r;
	}

	return { ok: false, error: '没有可用的事件读取方法', tried: [] };
}

/* ══════════════════════════════════════
 * 文本与分词
 * ══════════════════════════════════════ */

const STOP = new Set([
	'的', '了', '是', '在', '和', '就', '不', '也', '都', '而', '及', '与', '或', '但', '着', '过',
	'我', '你', '他', '她', '它', '我们', '你们', '他们', '这', '那', '这个', '那个', '这样', '那样',
	'什么', '怎么', '为什么', '可以', '一个', '一些', '这个', '没有', '就是', '还是', '如果',
	'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'or', 'in', 'on',
	'for', 'with', 'it', 'this', 'that', 'as', 'at', 'by', 'from', 'not', 'but', 'if', 'then',
	'function', 'const', 'return', 'var', 'let', 'import', 'export', 'class', 'new', 'null', 'true', 'false'
]);

let segmenter;
function makeSegmenter() {
	if (segmenter !== undefined) return segmenter;
	try {
		segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
	} catch {
		segmenter = null;
	}
	return segmenter;
}

/**
 * 系统注入过滤。
 *
 * 实测污染：宿主把系统提示塞成 `user/message` 事件，例如
 *   · `<system-reminder>` + 整篇 AGENTS.md（几千到上万字）
 *   · `Current runtime context. This snapshot supersedes...`（每轮都注入）
 * 这些会：
 *   · 把词频带偏（"工作目录""边界要求"变成高频词）
 *   · 让点数虚高、星海里出现一堆没意义的亮点
 *   · 让"这一轮"的预览变成系统提示
 * 所以必须切掉。宁可漏掉极少数真实消息，也不能让星海全是噪声。
 */
const NOISE_PREFIXES = [
	'<system-reminder>',
	'Current runtime context',
	'Instructions from:',
	'<workspace',
	'<attachment',
	'<agent-instructions',
	'<user-instructions',
	'<environment',
	'<context',
	'[dsh-',
	'AGENTS.md'
];

function isNoise(text) {
	if (!text) return true;
	const head = text.slice(0, 120);
	for (const p of NOISE_PREFIXES) {
		if (head.startsWith(p) || text.startsWith(p)) return true;
	}
	/* 超长注入（整篇 AGENTS.md）—— 真实对话消息极少超过 2 万字 */
	if (text.length > 20000) return true;
	return false;
}

/**
 * 从事件 data 里抠出文本。
 *
 * 实测：`data.content` 不一定存在 —— 上一轮 21257 条记录 len 全是 0，
 * 说明按固定路径取值完全落空。所以改成**递归找**：
 *   · 遇到 `text` 字段直接用
 *   · 否则顺着常见容器（content/message/blocks/parts/body/value/delta/data）往下钻
 *   · 深度限制 5，防止环
 */
const TEXT_KEYS = ['content', 'message', 'blocks', 'parts', 'body', 'value', 'delta', 'text', 'data', 'payload', 'item'];

function deepText(node, depth) {
	const d = depth || 0;
	if (node === null || node === undefined) return '';
	if (typeof node === 'string') return node;
	if (typeof node === 'number' || typeof node === 'boolean') return '';
	if (d > 5) return '';

	if (Array.isArray(node)) {
		let out = '';
		for (const n of node) {
			const t = deepText(n, d + 1);
			if (t) out += t;
		}
		return out;
	}

	if (typeof node === 'object') {
		if (typeof node.text === 'string' && node.text) return node.text;
		for (const k of TEXT_KEYS) {
			const v = node[k];
			if (v === undefined || v === null) continue;
			if (typeof v === 'string') { if (v) return v; continue; }
			if (typeof v === 'object') {
				const t = deepText(v, d + 1);
				if (t) return t;
			}
		}
	}
	return '';
}

function textOf(data) {
	if (!data) return '';
	if (typeof data === 'string') return data;
	return deepText(data, 0);
}

/** 写入时分好词，渲染时零成本。只对够长的文本做，长文本截前 2000 字。 */
function tokenize(text) {
	if (!text || text.length < 20) return [];
	const seg = makeSegmenter();
	if (!seg) return [];
	const head = text.slice(0, 2000).toLowerCase();
	const out = new Set();
	try {
		for (const s of seg.segment(head)) {
			if (!s.isWordLike) continue;
			const w = s.segment.trim();
			if (w.length < 2 || w.length > 20) continue;
			if (STOP.has(w)) continue;
			if (/^\d+$/.test(w)) continue;
			out.add(w);
			if (out.size >= 24) break;
		}
	} catch { /* ignore */ }
	return [...out];
}

/* ══════════════════════════════════════
 * 事件 → 记录
 * ══════════════════════════════════════ */

const norm = (x, max) => Math.min(1, (x || 0) / max);

const KEEP_KINDS = {
	'user/message': 'user',
	'assistant/message': 'assistant',
	'tool/call': 'tool',
	'compaction/summary': 'compaction'
};

/**
 * 把一个会话的事件流抽成 turns + records。
 * @returns {{ turns: [], records: [] }}
 */
function extract(sessionId, cwd, events, title) {
	const turns = [];
	const records = [];
	let cur = null;
	let seq = 0;

	const openTurn = (at) => {
		cur = {
			id: sessionId + '#' + turns.length,
			sessionId, cwd,
			idx: turns.length,
			startedAt: at || 0,
			endedAt: 0,
			userCount: 0,
			userLen: 0, assistantLen: 0, toolCount: 0,
			preview: '',
			weight: 0
		};
		turns.push(cur);
		return cur;
	};

	/* 时间字段名也不确定：at / time / t / ts / timestamp / createdAt 全都试 */
	const timeOf = (ev) => {
		const v = ev.at !== undefined ? ev.at
			: ev.time !== undefined ? ev.time
			: ev.t !== undefined ? ev.t
			: ev.ts !== undefined ? ev.ts
			: ev.timestamp !== undefined ? ev.timestamp
			: ev.createdAt !== undefined ? ev.createdAt
			: 0;
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	};

	for (const ev of events) {
		if (!ev || typeof ev !== 'object') continue;
		const type = ev.type;
		const at = timeOf(ev);

		/*
		 * 形状采样：记录前几个消息事件的完整 JSON（截 900 字）。
		 * 文本抽取一旦失败，靠它一眼看出真实结构，不用再盲猜。
		 */
		if ((type === 'user/message' || type === 'assistant/message') && state.shapeCount < 4) {
			state.shapeCount += 1;
			state.probe['shape#' + state.shapeCount + ':' + type] = JSON.stringify(ev).slice(0, 900);
		}

		if (type === 'turn/start') { openTurn(at); continue; }
		if (type === 'turn/end') {
			if (cur) { cur.endedAt = at || cur.startedAt; cur = null; }
			continue;
		}

		const kind = KEEP_KINDS[type];
		if (!kind) continue;

		const data = ev.data || {};
		const text = textOf(data);

		/*
		 * 先滤掉系统注入，再决定要不要开新轮 ——
		 * 否则一条 `Current runtime context` 就会被当成"用户发言"切出一轮，
		 * 预览和权重全被它污染（实测前 3 轮里 2 轮是这种）。
		 */
		if (kind === 'user' && isNoise(text)) {
			state.skipped = (state.skipped || 0) + 1;
			continue;
		}

		/*
		 * 分轮策略：优先信 turn/start…turn/end。
		 * 没有 turn 边界时**按"用户消息"切轮**——用计数而不是字数，
		 * 因为一旦文本抽取失败（实测发生过），字数恒为 0，计数仍然可靠。
		 */
		if (kind === 'user') {
			if (cur && cur.userCount > 0) { cur.endedAt = at || cur.startedAt; cur = null; }
		}
		if (!cur) openTurn(at);
		if (kind === 'user') cur.userCount += 1;

		const len = text.length;
		const tok = tokenize(text);

		const rec = {
			id: sessionId + '#' + cur.idx + ':' + seq,
			sessionId,
			turnId: cur.id,
			cwd,
			seq,
			t: at,
			kind,
			role: kind === 'tool' ? 'tool' : kind,
			len,
			/*
			 * 预览：详情面板靠它说明"这一条到底是什么"。
			 * 之前只存了 len，所以点开任何一颗消息星都只有"1340 字"，
			 * 根本看不出是什么内容。只留前 200 字 —— 21000 条全存正文
			 * 会让 records/*.json 从 400KB 涨到几十 MB。
			 */
			preview: text.replace(/\s+/g, ' ').trim().slice(0, 200),
			tokens: tok,
			weight: 0
		};

		if (kind === 'tool') {
			rec.toolName = String(data.name || data.tool || data.toolName || '').slice(0, 40);
			rec.args = String(data.arguments || data.input || '').slice(0, 300);
			cur.toolCount += 1;
		}
		if (kind === 'user') {
			cur.userLen += len;
			if (!cur.preview) cur.preview = text.slice(0, 120);
		}
		if (kind === 'assistant') cur.assistantLen += len;

		rec.weight = 0.5 * norm(len, 3000)
			+ 0.3 * norm(cur.toolCount, 10)
			+ (kind === 'compaction' ? 0.2 : 0);

		records.push(rec);
		seq += 1;
	}

	/* 收尾：补结束时间、算 turn 权重 */
	for (const t of turns) {
		if (!t.endedAt) t.endedAt = t.startedAt;
		t.weight = 0.5 * norm(t.userLen + t.assistantLen, 4000) + 0.5 * norm(t.toolCount, 10);
	}

	return { turns, records, title };
}

/* ══════════════════════════════════════
 * 索引器
 * ══════════════════════════════════════ */

const state = {
	phase: 'idle',        /* idle | listing | indexing | ready | error */
	total: 0,
	done: 0,
	okSessions: 0,
	current: '',
	startedAt: 0,
	error: '',
	probe: {},            /* 记录每次自适应试错的结果，方便排查 */
	variantHits: {},      /* 哪个参数形状成功了 */
	shapeCount: 0         /* 采样了几个事件形状（用于排查文本抽取） */
};

function jsonOk(obj) {
	return new Response(JSON.stringify(obj), {
		headers: { 'content-type': 'application/json; charset=utf-8' }
	});
}

/**
 * 会话对象的字段名不能靠猜 —— 实测 listSessions() 返回的 49 个对象里，
 * 我原先试的 id/sessionId/key/uuid 全是空。所以这里做**深度搜索**：
 * 先看直接字段，再看常见嵌套（session/summary/meta/header…），
 * 最后兜底扫一遍所有字符串字段，挑像会话 id 的那个。
 */
const ID_KEYS = ['id', 'sessionId', 'session_id', 'sessionID', 'sid', 'uuid', 'key', 'name', 'path', 'dir', 'slug'];
const ID_NESTS = ['session', 'summary', 'meta', 'info', 'data', 'header', 'record', 'entry', 'value'];

function looksLikeSessionId(v) {
	if (typeof v !== 'string' || v.length < 6) return false;
	/* session-<uuid> / <uuid> / 带路径的目录名都算 */
	return /^session-/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(v) || v.includes('/') || v.includes('\\');
}

function sessionIdOf(s) {
	if (!s || typeof s !== 'object') return '';
	for (const k of ID_KEYS) {
		const v = s[k];
		if (typeof v === 'string' && v) return v;
	}
	for (const n of ID_NESTS) {
		const o = s[n];
		if (o && typeof o === 'object') {
			for (const k of ID_KEYS) {
				const v = o[k];
				if (typeof v === 'string' && v) return v;
			}
		}
	}
	/* 兜底：扫所有字符串字段，挑最像的 */
	for (const k of Object.keys(s)) {
		if (looksLikeSessionId(s[k])) return s[k];
	}
	return '';
}

function sessionCwdOf(s) {
	if (!s || typeof s !== 'object') return '';
	const direct = s.cwd || s.workspace || s.cwdPath || s.workspacePath;
	if (typeof direct === 'string' && direct) return direct;
	for (const n of ID_NESTS) {
		const o = s[n];
		if (o && typeof o === 'object' && typeof o.cwd === 'string' && o.cwd) return o.cwd;
	}
	return '';
}

function sessionTitleOf(s) {
	if (!s || typeof s !== 'object') return '';
	const direct = s.title || s.name || s.label;
	if (typeof direct === 'string' && direct) return direct;
	for (const n of ID_NESTS) {
		const o = s[n];
		if (o && typeof o === 'object' && typeof o.title === 'string' && o.title) return o.title;
	}
	return '';
}

/** 索引一个会话，返回 { turns, records } */
async function indexOne(q, sess, ordinal) {
	const sid = sessionIdOf(sess);
	const cwd = sessionCwdOf(sess);
	const title = sessionTitleOf(sess);

	if (!sid) {
		/* 拿不到 id 就把对象的真实形状记下来，供下一轮修正 */
		state.probe['noId#' + ordinal] = {
			keys: Object.keys(sess || {}).slice(0, 24),
			sample: JSON.stringify(sess).slice(0, 500)
		};
		return null;
	}

	const r = await readEvents(q, sid);
	if (!r.ok) {
		state.probe['readEvents:' + sid.slice(0, 40)] = { error: r.error, tried: r.tried, cwd };
		return null;
	}
	if (!state.variantHits.readEvents) state.variantHits.readEvents = r.args;
	state.probe['readEvents:' + sid.slice(0, 40)] = { args: r.args, count: r.value.length };

	return extract(sid, cwd, r.value, title);
}

/** 主流程：列会话 → 逐个索引 → 落盘 */
async function runIndex(ctx) {
	const q = ctx.get('sessionQuery');
	if (!q || typeof q.listSessions !== 'function') {
		state.phase = 'error';
		state.error = 'sessionQuery 不可用';
		return;
	}

	state.phase = 'listing';
	state.startedAt = Date.now();

	const ls = await tryVariants(q.listSessions.bind(q), sessionVariants(), pickSessions);
	if (!ls.ok) {
		state.phase = 'error';
		state.error = 'listSessions 失败：' + ls.error;
		state.probe.listSessions = { error: ls.error, tried: ls.tried };
		writeJson('meta.json', { schema: SCHEMA, ...state });
		return;
	}
	state.variantHits.listSessions = ls.args;
	state.probe.listSessions = {
		args: ls.args,
		count: ls.value.length,
		firstKeys: Object.keys(ls.value[0] || {}).slice(0, 24),
		firstSample: JSON.stringify(ls.value[0] || {}).slice(0, 600)
	};

	let rawSessions = ls.value;

	/*
	 * 兜底：如果 listSessions 返回的对象里一个像样的 id 都找不到，
	 * 换 sessions.list() 再试。两条路覆盖"会话列表来自哪个服务"的两种可能。
	 */
	if (rawSessions.length && !rawSessions.some((s) => sessionIdOf(s))) {
		let store = null;
		try { store = ctx.get('sessions'); } catch { store = null; }
		if (store && typeof store.list === 'function') {
			try {
				const alt = store.list();
				if (Array.isArray(alt) && alt.length && alt.some((s) => sessionIdOf(s))) {
					rawSessions = alt;
					state.variantHits.listSessions = 'sessions.list()';
					state.probe['fallback:sessions.list'] = {
						count: alt.length,
						firstKeys: Object.keys(alt[0] || {}).slice(0, 24),
						firstSample: JSON.stringify(alt[0] || {}).slice(0, 600)
					};
				} else {
					state.probe['fallback:sessions.list'] = {
						note: '返回了但没有可用 id',
						count: Array.isArray(alt) ? alt.length : -1,
						firstSample: JSON.stringify((Array.isArray(alt) && alt[0]) || {}).slice(0, 400)
					};
				}
			} catch (e) {
				state.probe['fallback:sessions.list'] = { error: String(e && e.message || e) };
			}
		} else {
			state.probe['fallback:sessions.list'] = { note: 'sessions 服务或 list() 不可用' };
		}
	}

	const sessions = rawSessions.slice(0, 200);
	state.total = sessions.length;
	state.phase = 'indexing';

	/* 按更新时间倒序：最近的先索引，用户最可能看 */
	sessions.sort((a, b) => {
		const ta = Number(a.updatedAt || a.updated_at || a.mtime || 0);
		const tb = Number(b.updatedAt || b.updated_at || b.mtime || 0);
		return tb - ta;
	});

	const index = [];
	const allTurns = [];
	const vocab = new Map();

	for (let i = 0; i < sessions.length; i += 1) {
		const s = sessions[i];
		state.current = sessionIdOf(s);
		state.done = i;

		const got = await indexOne(q, s, i);
		if (!got) continue;
		state.okSessions = (state.okSessions || 0) + 1;

		for (const r of got.records) {
			for (const w of r.tokens) {
				const e = vocab.get(w) || { n: 0, sessions: new Set() };
				e.n += 1;
				e.sessions.add(r.sessionId);
				vocab.set(w, e);
			}
		}

		writeJson('records/' + sessionIdOf(s) + '.json', { sessionId: sessionIdOf(s), records: got.records });
		allTurns.push(...got.turns);

		/* 字段都在 header 里（实测：{ header: { id, cwd, createdAt, agentPreset }, live, persisted }） */
		const hdr = (s && s.header) || {};
		const lastTurn = got.turns[got.turns.length - 1];

		index.push({
			id: sessionIdOf(s),
			cwd: sessionCwdOf(s),
			title: got.title || (got.turns[0] && got.turns[0].preview) || '',
			createdAt: Number(hdr.createdAt || s.createdAt || 0),
			updatedAt: Number(hdr.updatedAt || lastTurn && lastTurn.endedAt || s.updatedAt || hdr.createdAt || 0),
			agentPreset: hdr.agentPreset || '',
			live: !!s.live,
			turnCount: got.turns.length,
			recordCount: got.records.length,
			indexed: true
		});

		/* 每 FLUSH_EVERY 条落一次中间态，减少崩溃损失 */
		if (i % 5 === 4) writeJson('turns.json', { turns: allTurns });
	}

	state.done = sessions.length;
	state.current = '';
	state.phase = 'ready';

	/* vocab：只留出现 >= 2 次的词 */
	const vocabOut = {};
	for (const [w, e] of vocab) {
		if (e.n < 2) continue;
		vocabOut[w] = { n: e.n, sessions: e.sessions.size };
	}

	writeJson('index.json', { schema: SCHEMA, sessions: index });
	writeJson('turns.json', { turns: allTurns });
	writeJson('vocab.json', { schema: SCHEMA, words: vocabOut });
	writeJson('meta.json', {
		schema: SCHEMA,
		phase: state.phase,
		total: state.total,
		done: state.done,
		okSessions: state.okSessions || 0,
		skipped: state.skipped || 0,
		sessionCount: index.length,
		turnCount: allTurns.length,
		recordTotal: index.reduce((n, s) => n + s.recordCount, 0),
		wordCount: Object.keys(vocabOut).length,
		indexedAt: Date.now(),
		variantHits: state.variantHits,
		probe: state.probe
	});
}

/* ══════════════════════════════════════
 * 插件入口
 * ══════════════════════════════════════ */

export function apply(ctx) {
	const log = (m) => { try { ctx.logger && ctx.logger.info && ctx.logger.info('[dsh-memory-sea] ' + m); } catch { /* ignore */ } };

	ensureStore();

	/* ── 路由 ── */
	function registerRoutes(c) {
		let conn = null;
		try { conn = c.get('connection'); } catch { conn = null; }

	if (conn && conn.fetch && typeof conn.fetch.register === 'function') {
		/*
		 * 字段名是 `fetch`，不是 `handler`。
		 * 宿主源码：registerFetchRoute 里 `const registered = { methods, requestBody,
		 * fetch: route.fetch }` —— 传 handler 的话 registered.fetch 是 undefined，
		 * 请求进来就不响应（表现成 404/挂起）。
		 */
		try {
			const off = conn.fetch.register({
				path: API + '/scene',
				methods: ['GET'],
				/* 宿主自己的路由都带这个字段（/api/file 用 "buffered"）。
				   漏掉它 → registered.requestBody 是 undefined → requestBodyMode
				   返回 undefined → 下游判非法 → 400。 */
				requestBody: 'buffered',
				fetch: async () => {
					const index = readJson('index.json', { sessions: [] });
					const turns = readJson('turns.json', { turns: [] });
					const meta = readJson('meta.json', {});
					return jsonOk({
						schema: SCHEMA,
						phase: state.phase === 'idle' ? (meta.phase || 'idle') : state.phase,
						progress: { total: state.total || meta.total || 0, done: state.done || meta.done || 0 },
						sessions: index.sessions || [],
						turns: turns.turns || [],
						meta
					});
				}
			});
			state.routeScene = 'ok';
			log('已注册 ' + API + '/scene');
			/* 路由注册返回 dispose，插件卸载时摘掉，避免重复注册抛 "already registered" */
			if (typeof off === 'function') {
				try { ctx.on('dispose', off); } catch { /* ignore */ }
			}
		} catch (e) {
			state.routeScene = 'FAIL: ' + (e && e.message);
			log('注册 scene 路由失败: ' + (e && e.message));
		}

		try {
			const off2 = conn.fetch.register({
				path: API + '/shard',
				methods: ['GET'],
				requestBody: 'buffered',
				fetch: async (req) => {
					let sid = '';
					try { sid = new URL(req.url).searchParams.get('session') || ''; } catch { /* ignore */ }
					if (!sid || !/^[A-Za-z0-9_.-]+$/.test(sid)) return jsonOk({ records: [] });
					return jsonOk(readJson('records/' + sid + '.json', { sessionId: sid, records: [] }));
				}
			});
			state.routeShard = 'ok';
			log('已注册 ' + API + '/shard');
			if (typeof off2 === 'function') {
				try { ctx.on('dispose', off2); } catch { /* ignore */ }
			}
		} catch (e) {
			state.routeShard = 'FAIL: ' + (e && e.message);
			log('注册 shard 路由失败: ' + (e && e.message));
		}

		/* 注册结果写进 meta，重启后能直接从文件看出通没通 */
		writeJson('routes.json', {
			at: Date.now(),
			scene: state.routeScene || 'unknown',
			shard: state.routeShard || 'unknown',
			paths: [API + '/scene', API + '/shard']
		});
	} else {
		state.routeScene = 'no connection.fetch';
		log('connection.fetch 不可用 —— 只做后台索引，不提供服务（client 会退回 demo）');
		writeJson('routes.json', { at: Date.now(), scene: 'no connection.fetch' });
	}
	}   /* ← registerRoutes 结束 */

	/*
	 * 服务比 apply 晚就绪：实测第一次写盘是 `{"scene":"no connection.fetch"}`，
	 * 因为 apply() 执行时 connection 还没挂到 ctx 上（探针延迟 3 秒才拿到，就是这个原因）。
	 *
	 * 所以用 cordis 的 ctx.inject 等依赖就绪，再注册路由。
	 * 同时保留一个延迟兜底，防止某些宿主不触发 inject 回调。
	 */
	let didRegister = false;
	const registerOnce = (c) => {
		if (didRegister) return;
		try {
			let probe = null;
			try { probe = c.get('connection'); } catch { probe = null; }
			if (!probe || !probe.fetch) return;   /* 还没就绪，等下一次 */
			didRegister = true;
			registerRoutes(c);
		} catch (e) {
			log('registerOnce 失败: ' + (e && e.message));
		}
	};

	let injectUsed = false;
	try {
		if (typeof ctx.inject === 'function') {
			ctx.inject(['connection'], (c) => registerOnce(c));
			injectUsed = true;
		}
	} catch (e) {
		log('ctx.inject 不可用: ' + (e && e.message));
	}

	/* 兜底：inject 没触发或宿主不支持时，间隔重试几轮 */
	let tries = 0;
	const retry = setInterval(() => {
		tries += 1;
		if (didRegister) { clearInterval(retry); return; }
		registerOnce(ctx);
		if (tries >= 12) {
			clearInterval(retry);
			if (!didRegister) {
				log('等了 ' + (tries * 1000) + 'ms 仍没有 connection.fetch（injectUsed=' + injectUsed + '）');
				writeJson('routes.json', {
					at: Date.now(),
					scene: 'timeout: connection.fetch 一直没就绪',
					injectUsed,
					tries
				});
			}
		}
	}, 1000);
	if (retry.unref) retry.unref();

	/* ── 后台索引：延迟启动，避免和宿主启动抢资源 ── */
	const timer = setTimeout(() => {
		runIndex(ctx).catch((e) => {
			state.phase = 'error';
			state.error = String(e && e.message || e);
			log('索引失败: ' + state.error);
			writeJson('meta.json', { schema: SCHEMA, phase: 'error', error: state.error, probe: state.probe });
		});
	}, 4000);
	if (timer.unref) timer.unref();
}

const plugin = { name, inject, apply };
export default plugin;
