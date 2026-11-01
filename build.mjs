/**
 * dsh-plugin-memory-sea 构建：把 three.js 与整份源码打成一个自包含的 client.js。
 *
 * 为什么必须 bundle：宿主的加载器是
 *   window.__ModuleLoader__.load({ id, factory: (require) => … })
 * 而 factory 只保证能 require("react")，拿不到 three。
 * 所以 three 必须内联进产物，否则运行时直接 import 失败。
 *
 * 用法：
 *   npm run build                      # 输出到插件目录
 *   MS_OUT=./out/client.js npm run build   # 输出到别处（调试用）
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 默认输出到本地 out/，再由 deploy 脚本拷进插件目录。
 * 直接让 esbuild 写 ~/.dsh/plugins/... 会被拒（目标文件正被宿主占用 / 路径受限），
 * 而 Copy-Item 覆盖是可行的 —— 所以固定走「构建 → 拷贝」两步。
 */
const OUT_FILE = process.env.MS_OUT || path.resolve(here, 'out/client.js');

const watch = process.argv.includes('--watch');

/*
 * 版本号与仓库地址在构建时注入。
 *
 * 不手写在 shell.js 里 —— 手写迟早和 package.json 对不上，
 * 「关于」里显示的版本就会骗人。
 *
 * 清单来源二选一：工作区有 package.open.json（开源版清单，版本是准的），
 * 发布目录里只有 package.json（它本身就是清单）。两个都试，先到先用。
 */
const MANIFEST_FILE = ['package.open.json', 'package.json']
	.map((f) => path.join(here, f))
	.find((f) => fs.existsSync(f));
if (!MANIFEST_FILE) throw new Error('找不到 package.json / package.open.json');
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
const REPO_URL = 'https://github.com/Tan-TanZi/dsh-plugin-memory-sea';

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: [path.join(here, 'src/entry.js')],
	outfile: OUT_FILE,
	bundle: true,
	format: 'iife',
	target: ['chrome110'],
	define: {
		__MS_VERSION__: JSON.stringify(MANIFEST.version),
		__MS_REPO__: JSON.stringify(REPO_URL)
	},
	// three 体积大，但本地产物、不经网络，按生态先例（wallpaper-engine 4.4 MB）无需压缩到极致；
	// 打开 minify 便于对比体积用 --minify 开关。
	minify: process.argv.includes('--minify'),
	sourcemap: false,
	legalComments: 'eof',
	charset: 'utf8',
	logLevel: 'info',
	banner: {
		js: '/* dsh-plugin-memory-sea · bundled build — three.js (MIT), d3-force-3d (ISC), galaxy forces (MIT, Longwind1984/galaxy-view) */'
	},
	metafile: true
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('[memory-sea-3d] watching…');
} else {
	const result = await esbuild.build(options);
	const bytes = fs.statSync(OUT_FILE).size;
	console.log('[memory-sea-3d] 产物：' + OUT_FILE);
	console.log('[memory-sea-3d] 体积：' + (bytes / 1024 / 1024).toFixed(2) + ' MB');

	/* 按顶层包统计体积占比，方便判断还能不能瘦 */
	const inputs = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs;
	const buckets = new Map();
	for (const [file, info] of Object.entries(inputs)) {
		let key = 'src';
		if (file.includes('node_modules/three/')) key = 'three';
		else if (file.includes('node_modules/')) key = file.split('node_modules/')[1].split('/')[0];
		buckets.set(key, (buckets.get(key) || 0) + info.bytesInOutput);
	}
	console.log('[memory-sea-3d] 构成：');
	for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
		console.log('  ' + k.padEnd(14) + (v / 1024).toFixed(0) + ' KB');
	}
}
