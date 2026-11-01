/**
 * 检查构建产物里注入的常量是否正确。
 *
 * 存在的理由：版本号是 build.mjs 从 package.open.json 注入的（__MS_VERSION__），
 * 一旦注入失效、产物里残留占位符或干脆没有，界面上的「关于」就会显示 0.0.0 ——
 * 而那个错误在浏览器里很难一眼看出。
 *
 * 用法：node tools/verify-inject.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUNDLE = path.join(ROOT, 'out', 'client.js');

if (!fs.existsSync(BUNDLE)) {
	console.error('✗ 没有产物，先跑 node build.mjs');
	process.exit(1);
}

const code = fs.readFileSync(BUNDLE, 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.open.json'), 'utf8'));

const checks = [
	['版本号已注入', code.includes(JSON.stringify(manifest.version)) || code.includes('"' + manifest.version + '"')],
	['仓库地址已注入', code.includes('github.com/Tan-TanZi/dsh-plugin-memory-sea')],
	/* 只查代码形态：注释里提到变量名是正常的，不该算失败 */
	['无未替换的 typeof 引用', !code.includes('typeof __MS_VERSION__') && !code.includes('typeof __MS_REPO__')],
	['兜底值仍在（源码路径也能跑）', code.includes('0.0.0')],
];

let bad = 0;
for (const [name, ok] of checks) {
	console.log((ok ? '✓ ' : '✗ ') + name);
	if (!ok) bad += 1;
}

if (bad) {
	console.log('\n✗ ' + bad + ' 项不合格：define 注入失效，「关于」会显示错误版本');
	process.exit(1);
}
console.log('\n✓ 注入正确  版本 ' + manifest.version);
