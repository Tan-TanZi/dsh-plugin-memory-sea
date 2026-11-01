/**
 * 交互状态机单测。
 *
 * 盯着三条铁律：
 *   1. 点一下星（不移动）→ 必须 onTap，且拿到正确的节点下标
 *   2. 拖一颗星（超过阈值）→ onDragStart/Move/End 全触发，**绝不** onTap
 *   3. 空白处拖动 → 不 onTap
 *
 * 跑法：node tools/test-interact.mjs
 */
import { createPointerMachine } from '../src/interact.js';

let failed = 0;
function check(name, ok, extra) {
	console.log((ok ? '✓ ' : '✗ ') + name + (extra ? '  ' + extra : ''));
	if (!ok) failed += 1;
}

/** 造一个可控的环境：nodes 是「坐标 → 下标」的命中表（半径 10 内都算命中） */
function rig(hitMap) {
	const log = [];
	let clock = 1000;
	const spots = Object.keys(hitMap).map((k) => {
		const p = k.split(',').map(Number);
		return { x: p[0], y: p[1], idx: hitMap[k] };
	});
	const m = createPointerMachine({
		hitTest: (x, y) => {
			for (const s of spots) {
				if (Math.hypot(x - s.x, y - s.y) <= 10) return s.idx;
			}
			return -1;
		},
		now: () => clock,
		onTap: (idx) => log.push('tap:' + idx),
		onDragStart: (idx) => log.push('dragStart:' + idx),
		onDragMove: (idx, x, y) => log.push('dragMove:' + idx),
		onDragEnd: (idx) => log.push('dragEnd:' + idx),
		onHover: (idx) => log.push('hover:' + idx),
		threshold: 3,
		tapTimeout: 420
	});
	return { m, log, tick: (ms) => { clock += ms; }, at: (x, y, buttons) => { m.move(x, y, buttons || 0); } };
}

/* ── 1. 点一下星：必须触发 tap ── */
{
	const r = rig({ '100,100': 5 });
	r.m.down(100, 100);
	r.m.up(100, 100);
	check('点一下星 → onTap(5)', r.log.includes('tap:5'), JSON.stringify(r.log));
	check('点一下星 → 不触发拖动', !r.log.some((s) => s.startsWith('drag')), JSON.stringify(r.log));
}

/* ── 2. 拖一颗星：必须拖动，且不能 tap ── */
{
	const r = rig({ '100,100': 5 });
	r.m.down(100, 100);
	r.at(104, 100, 1);   /* 位移 4 > 3 */
	r.at(120, 110, 1);
	r.at(140, 130, 1);
	const kind = r.m.up(140, 130);
	check('拖星 → 返回 drag', kind === 'drag', kind);
	check('拖星 → dragStart/dragMove/dragEnd 全有',
		r.log.includes('dragStart:5') && r.log.some((s) => s.startsWith('dragMove')) && r.log.includes('dragEnd:5'),
		JSON.stringify(r.log));
	check('拖星 → 绝不 onTap', !r.log.some((s) => s.startsWith('tap')), JSON.stringify(r.log));
}

/* ── 3. 微小抖动仍算点击（手抖 2px 不该变拖动）── */
{
	const r = rig({ '100,100': 5 });
	r.m.down(100, 100);
	r.at(101, 101, 1);   /* 位移 ≈1.4 < 3 */
	const kind = r.m.up(101, 101);
	check('手抖 2px 仍算点击', kind === 'tap' && r.log.includes('tap:5'), kind + ' ' + JSON.stringify(r.log));
}

/* ── 4. 空白处拖动：不 tap ── */
{
	const r = rig({ '100,100': 5 });
	r.m.down(500, 500);          /* 空白 */
	r.at(520, 520, 1);
	const kind = r.m.up(520, 520);
	check('空白处拖动 → 返回 none', kind === 'none', kind);
	check('空白处拖动 → 无 tap', !r.log.some((s) => s.startsWith('tap')), JSON.stringify(r.log));
}

/* ── 5. 空白处单击：tap(-1)，让上层清空选中 ── */
{
	const r = rig({ '100,100': 5 });
	r.m.down(500, 500);
	const kind = r.m.up(500, 500);
	check('空白处单击 → tap(-1)', kind === 'tap' && r.log.includes('tap:-1'), kind + ' ' + JSON.stringify(r.log));
}

/* ── 6. 超过 tapTimeout 的长按不算点击 ── */
{
	const r = rig({ '100,100': 5 });
	r.m.down(100, 100);
	r.tick(500);                  /* 500 > 420 */
	const kind = r.m.up(100, 100);
	check('长按超时 → none', kind === 'none', kind);
	check('长按超时 → 无 tap', !r.log.some((s) => s.startsWith('tap')), JSON.stringify(r.log));
}

/* ── 7. 悬浮：进入/离开各回调一次 ── */
{
	const r = rig({ '100,100': 5 });
	r.at(100, 100);               /* 悬浮到 5 */
	r.at(100, 100);               /* 同点不重复 */
	r.at(300, 300);               /* 离开 */
	const hovers = r.log.filter((s) => s.startsWith('hover'));
	check('悬浮只回调变化', hovers.join(',') === 'hover:5,hover:-1', hovers.join(','));
}

/* ── 8. 连续两轮：点完再点，状态不能残留 ── */
{
	const r = rig({ '100,100': 5, '200,200': 7 });
	r.m.down(100, 100);
	r.m.up(100, 100);
	r.m.down(200, 200);
	r.m.up(200, 200);
	check('连续点击两次都成功', r.log.includes('tap:5') && r.log.includes('tap:7'), JSON.stringify(r.log));
}

/* ── 9. 拖完立刻点击：拖动状态不能污染下一次 ── */
{
	const r = rig({ '100,100': 5 });
	r.m.down(100, 100);
	r.at(130, 130, 1);
	r.m.up(130, 130);
	r.log.length = 0;
	r.m.down(100, 100);
	const kind = r.m.up(100, 100);
	check('拖完再点仍能 tap', kind === 'tap' && r.log.includes('tap:5'), kind + ' ' + JSON.stringify(r.log));
}

console.log('');
if (failed) {
	console.log('✗ ' + failed + ' 项失败');
	process.exit(1);
}
console.log('✓ 交互状态机全部通过');
