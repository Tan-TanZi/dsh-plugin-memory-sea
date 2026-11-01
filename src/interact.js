/**
 * 指针交互状态机（纯函数，零依赖，可单测）。
 *
 * 为什么单独抽出来：这段逻辑原来直接写在三个事件回调里，
 * 一个 `return` 位置写错就吃掉了整个点击（详情卡 + 相机推进一起消失），
 * 而且没法测 —— WebGL 场景在 Node 里跑不起来。
 *
 * 规则：
 *   down  命中节点 → 只登记候选，**不动**
 *   move  位移 > threshold → 升级为拖动（此后 move 只走拖动分支）
 *   up
 *     ├ 拖动过              → 回调 onDragEnd，返回 'drag'，**不触发点击**
 *     ├ 空白处拖动/超时      → 返回 'none'
 *     └ 其余                → 回调 onTap(hitTest(x,y))，返回 'tap'
 *
 * 关键保证（回归测试盯着这三条）：
 *   1. 按下并松开同一颗星（不移动）必须触发 onTap
 *   2. 拖动过一颗星必须触发 onDragStart/onDragMove/onDragEnd，且**不**触发 onTap
 *   3. 空白处拖动不触发 onTap
 */
export function createPointerMachine(opts) {
	const o = opts || {};
	const hitTest = o.hitTest || (() => -1);
	const threshold = Number.isFinite(o.threshold) ? o.threshold : 3;
	const tapTimeout = Number.isFinite(o.tapTimeout) ? o.tapTimeout : 420;
	const now = o.now || (() => 0);

	let pending = -1;      /* 候选节点（按下时命中） */
	let started = false;   /* 是否已升级为拖动 */
	let sx = 0;
	let sy = 0;
	let blankDrag = false; /* 空白处按住移动过 */
	let downAt = 0;
	let hovered = -1;
	let lastDragIdx = -1;

	return {
		down(x, y) {
			blankDrag = false;
			started = false;
			downAt = now();
			pending = hitTest(x, y);
			if (pending >= 0) { sx = x; sy = y; }
		},

		move(x, y, buttons) {
			if (pending >= 0 && !started) {
				if (Math.hypot(x - sx, y - sy) > threshold) {
					started = true;
					lastDragIdx = pending;
					if (o.onDragStart) o.onDragStart(pending);
				}
			}
			if (started && pending >= 0) {
				if (o.onDragMove) o.onDragMove(pending, x, y);
				return;
			}
			/* 只有「按下时没命中节点」的按住移动才算空白拖动。
			   按下命中了节点、但位移没到阈值的抖动，必须保留点击资格 ——
			   否则手抖 2px 就会把点击吃掉（这条被单测抓过）。 */
			if (buttons) {
				if (pending < 0) blankDrag = true;
				return;
			}
			const idx = hitTest(x, y);
			if (idx === hovered) return;
			hovered = idx;
			if (o.onHover) o.onHover(idx);
		},

		up(x, y) {
			const wasDragging = started;
			const dragIdx = lastDragIdx;
			started = false;
			pending = -1;
			lastDragIdx = -1;

			if (wasDragging) {
				if (o.onDragEnd) o.onDragEnd(dragIdx);
				return 'drag';
			}
			if (blankDrag || now() - downAt > tapTimeout) return 'none';

			const idx = hitTest(x, y);
			if (o.onTap) o.onTap(idx);
			return 'tap';
		},

		/* 供调试/测试观察内部状态 */
		state() {
			return { pending: pending, started: started, blankDrag: blankDrag, hovered: hovered, downAt: downAt };
		}
	};
}
