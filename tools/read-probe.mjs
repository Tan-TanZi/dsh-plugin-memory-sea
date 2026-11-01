/**
 * 读探针结果并给出结论。
 *
 * 前提：已重启 DSH，让 dsh-memory-probe 跑过一轮。
 * 跑法：node tools/read-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.dsh', 'memory-probe-result.json');

if (!fs.existsSync(FILE)) {
	console.log('✗ 没有探针结果：' + FILE);
	console.log('  先重启 DSH，让 dsh-memory-probe 跑一次。');
	process.exit(1);
}

const stat = fs.statSync(FILE);
const ageSec = Math.round((Date.now() - stat.mtimeMs) / 1000);
let r;
try {
	r = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
	console.log('✗ 结果文件不是合法 JSON：' + e.message);
	process.exit(1);
}

console.log('探针结果：' + FILE);
console.log('写入时间：' + r.at + '（' + (ageSec < 120 ? ageSec + ' 秒前' : Math.round(ageSec / 60) + ' 分钟前') + '，phase ' + r.phase + '）');
if (ageSec > 900) console.log('⚠️ 结果超过 15 分钟，可能不是这次重启写的');

/* ── 1. 服务清单 ── */
console.log('\n═══ 1. 宿主服务 ═══');
const services = r.services || {};
const present = [];
const absent = [];
for (const [k, v] of Object.entries(services)) {
	if (v === null || v === undefined) { absent.push(k); continue; }
	if (v.getError) { absent.push(k + '(' + v.getError + ')'); continue; }
	present.push([k, v]);
}
console.log('可用：' + (present.map((p) => p[0]).join(', ') || '(无)'));
console.log('不可用：' + (absent.join(', ') || '(无)'));

/* ── 2. 会话相关方法（最关键）── */
console.log('\n═══ 2. 会话数据接口 ═══');
for (const key of ['sessions', 'sessionQuery', 'sessionController']) {
	const v = services[key];
	if (!v) { console.log(key + ': 不可用'); continue; }
	console.log(key + ' 方法: ' + (v.methods || []).join(', '));
	for (const fn of Object.keys(v)) {
		if (!/_arity$/.test(fn)) continue;
		const base = fn.replace(/_arity$/, '');
		console.log('  ' + base + '() 参数 ' + v[fn] + ' 个   ' + (v[base + '_src'] || '').slice(0, 160));
	}
}

console.log('\n═══ 3. 会话列表实测 ═══');
const probes = r.sessionProbes || {};
if (!Object.keys(probes).length) console.log('(没试出任何读方法)');
for (const [k, v] of Object.entries(probes)) {
	console.log(k + ': ' + JSON.stringify(v).slice(0, 400));
}

/* ── 4. webServer 与鉴权 ── */
console.log('\n═══ 4. webServer ═══');
const ws = services.webServer;
if (!ws) console.log('不可用 —— 需要降级到 connection(IPC)');
else {
	console.log('方法: ' + (ws.methods || []).join(', '));
	for (const fn of Object.keys(ws)) {
		if (!/_arity$/.test(fn)) continue;
		const base = fn.replace(/_arity$/, '');
		console.log('  ' + base + '() 参数 ' + ws[fn] + ' 个   ' + (ws[base + '_src'] || '').slice(0, 200));
	}
}

console.log('\n═══ 5. connection ═══');
const conn = services.connection;
if (!conn) console.log('不可用');
else {
	console.log('方法: ' + (conn.methods || []).join(', '));
	for (const fn of Object.keys(conn)) {
		if (!/_arity$/.test(fn)) continue;
		const base = fn.replace(/_arity$/, '');
		console.log('  ' + base + '() 参数 ' + conn[fn] + ' 个   ' + (conn[base + '_src'] || '').slice(0, 160));
	}
}

/* ── 6. 探针自身记录 ── */
console.log('\n═══ 6. 探针记录 ═══');
for (const n of r.notes || []) console.log('  · ' + n);

/* ── 7. ctx 形状 ── */
console.log('\n═══ 7. ctx ═══');
console.log('keys: ' + ((r.ctx && r.ctx.keys) || []).join(', '));
console.log('methods: ' + ((r.ctx && r.ctx.methods) || []).slice(0, 60).join(', '));

/* ── 8. 结论 ── */
console.log('\n═══ 结论 ═══');
const hasSessions = !!(services.sessions && (services.sessions.methods || []).length);
const hasQuery = !!(services.sessionQuery && (services.sessionQuery.methods || []).length);
const hasWs = !!ws;
console.log('· 会话读取: ' + (hasSessions || hasQuery ? '✓ 可走 ' + [hasSessions ? 'sessions' : '', hasQuery ? 'sessionQuery' : ''].filter(Boolean).join(' / ') : '✗ 无'));
console.log('· webServer: ' + (hasWs ? '✓ 可用（fetch 主通道）' : '✗ 要降级 IPC'));
console.log('· connection: ' + (conn ? '✓ 可用（实时推送）' : '✗ 不可用'));
const listProbe = probes.list || probes.listSessions || probes.all;
console.log('· 列会话: ' + (listProbe && !listProbe.error ? '✓ ' + (listProbe.length !== undefined ? listProbe.length + ' 个' : 'ok') : '✗ 需换方法'));
