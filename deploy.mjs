/**
 * 部署：把 out/client.js 拷进插件目录，再同步到 profile 的 node_modules。
 *
 * 为什么不用 esbuild 直接写插件目录：目标在宿主占用下会被拒（Access is denied）。
 * 构建与部署分开，构建永远只写本地 out/，部署只做 Copy-Item 覆盖。
 *
 * 用法：
 *   node deploy.mjs             # 部署
 *   node deploy.mjs --dry       # 只检查不写
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, 'out/client.js');
const HOST_SRC = path.resolve(here, 'host/index.js');
const PLUGIN = process.env.MS_PLUGIN || path.resolve(here, '../../../../.dsh/plugins/dsh-plugin-memory-sea');
const NM = process.env.MS_NM || path.resolve(here, '../../../../.dsh/profiles/desktop/node_modules/dsh-plugin-memory-sea');

const dry = process.argv.includes('--dry');

function kb(p) {
	try { return (fs.statSync(p).size / 1024).toFixed(1) + ' KB'; } catch { return '缺失'; }
}

if (!fs.existsSync(SRC)) {
	console.error('✗ 先构建：out/client.js 不存在');
	process.exit(1);
}
if (!fs.existsSync(path.join(PLUGIN, 'package.json'))) {
	console.error('✗ 插件目录不像插件：' + PLUGIN);
	process.exit(1);
}

const size = kb(SRC);

/*
 * 硬保护：产物必须比所有源码新。
 * 踩过的坑 —— build 因语法错误失败，deploy 照样把**旧产物**复制过去，
 * 还打印"✓ 插件"，于是「改了却没生效」，排查方向全错。
 */
{
	const outTime = fs.statSync(SRC).mtimeMs;
	const stale = [];
	const walk = (dir) => {
		let list;
		try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of list) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) { walk(p); continue; }
			if (!/\.(js|json)$/.test(e.name)) continue;
			try {
				if (fs.statSync(p).mtimeMs > outTime + 1500) stale.push(path.basename(dir) + '/' + e.name);
			} catch { /* ignore */ }
		}
	};
	walk(path.resolve(here, 'src'));

	if (stale.length) {
		console.error('✗ 产物比源码旧 —— 构建大概失败了，拒绝部署');
		for (const s of stale.slice(0, 6)) console.error('    · ' + s);
		console.error('  先跑 node build.mjs，确认 exit 0 且打印「产物」。');
		process.exit(1);
	}
}

console.log('源  : ' + SRC + '  (' + size + ')');

if (dry) {
	console.log('目标: ' + path.join(PLUGIN, 'client.js') + '  (当前 ' + kb(path.join(PLUGIN, 'client.js')) + ')');
	console.log('[dry] 未写入');
	process.exit(0);
}

/* 1) 插件目录 */
fs.copyFileSync(SRC, path.join(PLUGIN, 'client.js'));
console.log('✓ 插件: ' + path.join(PLUGIN, 'client.js') + '  (' + kb(path.join(PLUGIN, 'client.js')) + ')');

/* 1b) host 侧（如果有）：lib/index.js */
const HOST_TARGETS = [
	path.join(PLUGIN, 'lib/index.js'),
	fs.existsSync(NM) ? path.join(NM, 'lib/index.js') : null
].filter(Boolean);

if (fs.existsSync(HOST_SRC)) {
	for (const t of HOST_TARGETS) {
		try {
			fs.mkdirSync(path.dirname(t), { recursive: true });
			fs.copyFileSync(HOST_SRC, t);
			console.log('✓ host: ' + t + '  (' + kb(t) + ')');
		} catch (e) {
			console.log('✗ host 写入失败: ' + t + '  --  ' + e.message);
		}
	}
}

/* 2) profile node_modules（不存在就跳过，不算失败） */
if (fs.existsSync(NM)) {
	fs.copyFileSync(SRC, path.join(NM, 'client.js'));
	console.log('✓ 副本: ' + path.join(NM, 'client.js') + '  (' + kb(path.join(NM, 'client.js')) + ')');
} else {
	console.log('· 跳过副本：node_modules 里没有该插件（未安装到 profile）');
}

/* 3) 校验一致 */
const a = fs.statSync(SRC).size;
const b = fs.statSync(path.join(PLUGIN, 'client.js')).size;
console.log(a === b ? '✓ 大小一致' : '✗ 大小不一致：' + a + ' vs ' + b);
