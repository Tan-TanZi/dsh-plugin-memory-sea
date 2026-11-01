/**
 * 探测：插件通过 ctx.get / service(ctx, name) 取了哪些宿主服务。
 *
 * 目的：搞清楚「数据从哪来」。现有插件（尤其 dsh-purge 的 rewind.js）已经在读
 * 会话事件了，它们的服务名就是官方 API 的实证。
 *
 * 跑法：node tools/probe-services.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const roots = [
	path.join(os.homedir(), '.dsh', 'plugins')
];

const RE_SERVICE = /service\(\s*ctx\s*,\s*['"`]([^'"`]+)['"`]/g;
const RE_GET = /ctx\.get\(\s*['"`]([^'"`]+)['"`]/g;
const RE_INJECT = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/g;
const RE_EVENT_TYPE = /event\.type\s*===?\s*['"`]([^'"`]+)['"`]/g;

const found = new Map();   /* name -> Set(source) */
const events = new Map();
const injects = new Map();

function note(map, key, src) {
	if (!key) return;
	if (!map.has(key)) map.set(key, new Set());
	map.get(key).add(src);
}

function scan(file, plugin) {
	let s;
	try { s = fs.readFileSync(file, 'utf8'); } catch { return; }
	const base = plugin + '/' + path.basename(file);

	for (const m of s.matchAll(RE_SERVICE)) note(found, m[1], base + ' service()');
	for (const m of s.matchAll(RE_GET)) note(found, m[1], base + ' ctx.get()');
	for (const m of s.matchAll(RE_EVENT_TYPE)) note(events, m[1], base);
	for (const m of s.matchAll(RE_INJECT)) {
		for (const piece of m[1].split(',')) {
			const v = piece.trim().replace(/['"`]/g, '');
			if (v) note(injects, v, base);
		}
	}
}

function walk(dir, plugin) {
	let list;
	try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of list) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'node_modules' || e.name === '.git') continue;
			walk(p, plugin);
		} else if (/\.(js|mjs|cjs)$/.test(e.name)) {
			scan(p, plugin);
		}
	}
}

for (const root of roots) {
	let list;
	try { list = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
	for (const e of list) {
		if (e.isDirectory()) walk(path.join(root, e.name), e.name);
	}
}

function dump(title, map) {
	console.log('\n=== ' + title + ' ===');
	if (!map.size) { console.log('  (none)'); return; }
	const keys = [...map.keys()].sort();
	for (const k of keys) {
		const srcs = [...map.get(k)];
		console.log('  ' + k.padEnd(28) + srcs.slice(0, 3).join(', ') + (srcs.length > 3 ? ` … +${srcs.length - 3}` : ''));
	}
}

dump('宿主服务名（ctx.get / service）', found);
dump('inject 声明', injects);
dump('会话事件类型（event.type）', events);
