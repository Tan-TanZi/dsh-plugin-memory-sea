/**
 * 入口：包在宿主的模块加载器里。
 *
 * 宿主只保证 factory 能 require('react')，three / d3 都得靠 esbuild 内联进来（见 build.mjs）。
 * 所以这个文件的 import 会在 bundle 顶部执行一次（three 的模块初始化不碰 DOM，安全）。
 */
import { setReact, installSlots } from './shell.js';

window.__ModuleLoader__.load({
	id: 'dsh-plugin-memory-sea',
	factory: (require) => {
		const mod = { exports: {} };
		const out = mod.exports;

		let react = null;
		try {
			react = require('react');
		} catch (e) {
			console.error('[dsh-plugin-memory-sea] 拿不到 react：', e);
		}
		if (react) setReact(react);

		const name = 'dsh-plugin-memory-sea';
		const inject = ['slots'];

		function apply(ctx) {
			if (!react) {
				console.error('[dsh-plugin-memory-sea] react 未就绪，跳过注册');
				return;
			}
			installSlots(ctx);
		}

		out.name = name;
		out.inject = inject;
		out.apply = apply;
		return mod.exports;
	}
});
