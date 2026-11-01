/**
 * 开源前自检。
 *
 * 三件事：
 *   ① package.json 是不是合法 JSON（PowerShell 读 UTF-8 会乱码，不能用来验）
 *   ② README 里引用的文档是否都存在
 *   ③ 有没有把真实路径 / 真实会话名带进仓库
 *
 * 用法：node scripts/prepublish.mjs [目录，默认当前目录]
 */
import fs from 'node:fs';
import path from 'node:path';

/*
 * 目录参数可选，且要能自动纠错。
 * 工作区里习惯写 `publish/dsh-plugin-memory-sea`，但同一份脚本被复制进
 * 发布目录后，那个相对路径就不存在了 —— 这时退回当前目录，
 * 免得 `npm run prepublish:check` 在副本里直接崩。
 */
const argDir = process.argv[2];
let root = path.resolve(argDir || '.');
if (argDir && !fs.existsSync(path.join(root, 'package.json'))) {
	root = path.resolve('.');
}
const problems = [];

/* ── ① package.json ── */
try {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	console.log(`✓ package.json  ${pkg.name}@${pkg.version}  license=${pkg.license}`);
	if (!pkg.name || !pkg.version) problems.push('package.json 缺 name/version');
	if (!pkg.license) problems.push('package.json 缺 license');
	if (pkg.private === true) problems.push('package.json 还是 private:true');
	if (!pkg.dsh) problems.push('package.json 缺 dsh 字段（宿主不认）');
} catch (e) {
	console.log(`✗ package.json  ${e.message}`);
	problems.push('package.json 解析失败');
}

/* ── ② 文档链接与图片 ── */
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const links = new Set([...readme.matchAll(/\]\((docs\/[A-Za-z\-]+\.md)\)/g)].map((m) => m[1]));
let miss = 0;
for (const l of links) {
	if (fs.existsSync(path.join(root, l))) console.log(`✓ ${l}`);
	else { console.log(`✗ ${l}  缺失`); miss += 1; }
}
if (miss) problems.push(`${miss} 个文档链接失效`);
else console.log(`✓ 文档链接全部有效（${links.size} 个）`);

/*
 * 图片引用。
 * 只复制 md、忘了复制 assets/ 的话，README 在 GitHub 上就是两个破图 ——
 * 这种错误静态看代码永远发现不了，必须逐个查文件在不在。
 */
const imgs = new Set();
for (const m of readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) imgs.add(m[1]);
/* img / video 都要查 —— README 里用 <video> 内嵌演示短片 */
for (const m of readme.matchAll(/<(?:img|video|source)[^>]+src=["']([^"']+)/g)) imgs.add(m[1]);
let imgMiss = 0;
let imgSlash = 0;
for (const p of imgs) {
	/* Markdown 里必须用正斜杠，反斜杠在 GitHub 上解析不到 */
	const normalized = p.replace(/\\/g, '/');
	if (p !== normalized) {
		console.log(`✗ ${p}  用了反斜杠，GitHub 上无法解析（应为 ${normalized}）`);
		imgSlash += 1;
	}
	if (fs.existsSync(path.join(root, normalized))) console.log(`✓ ${normalized}`);
	else { console.log(`✗ ${normalized}  缺失`); imgMiss += 1; }
}
if (imgs.size) {
	if (imgMiss) problems.push(`${imgMiss} 张图片缺失`);
	if (imgSlash) problems.push(`${imgSlash} 处图片路径用了反斜杠`);
	if (!imgMiss && !imgSlash) console.log(`✓ 图片全部就位（${imgs.size} 张）`);
} else {
	console.log('· README 未引用图片');
}

/* ── ③ 隐私 ── */
const BAD = [
	/C:\\Users\\/i,
	/\/Users\//,
	/session-\d{3,}/,
	/步进电机/,
	/油猴脚本/,
	/四连杆/,
];
const SKIP_DIR = new Set(['node_modules', '.git', 'store', 'backup', 'out', 'publish']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf']);
let leaks = 0;
let scanned = 0;

function walk(dir) {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (SKIP_DIR.has(ent.name)) continue;
			walk(p);
			continue;
		}
		if (SKIP_EXT.has(path.extname(ent.name).toLowerCase())) continue;
		/* 本文件自己就带着这些关键词（作为检测模式），必须跳过，否则永远自指报错 */
		if (ent.name === 'prepublish.mjs') continue;
		if (ent.size > 4 * 1024 * 1024) continue;
		let text;
		try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
		scanned += 1;
		for (const re of BAD) {
			if (re.test(text)) {
				console.log(`✗ 疑似泄露 ${path.relative(root, p)}  ← ${re}`);
				leaks += 1;
				break;
			}
		}
	}
}
walk(root);
console.log(leaks ? `✗ 隐私扫描发现 ${leaks} 处（扫了 ${scanned} 个文件）` : `✓ 隐私扫描干净（扫了 ${scanned} 个文件）`);
if (leaks) problems.push(`${leaks} 处隐私泄露`);

/* ── 汇总 ── */
console.log('');
if (problems.length) {
	console.log('✗ 不能发布：');
	for (const p of problems) console.log('   · ' + p);
	process.exit(1);
}
console.log('✓ 可以发布');
