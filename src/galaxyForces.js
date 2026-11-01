/**
 * 星系力：从 galaxy-view（Longwind1984/galaxy-view, MIT）的
 * `src/layout/galaxyForces.ts` 移植，保持公式与量纲一致。
 *
 * 这两个力是「星系观感」的来源，不是装饰：
 *   · forceRadialCore —— 径向核心引力，线性于柱面半径 r、按度数加权
 *                        ⇒ 度数高的点沉到核里，形成致密亮核 + 径向密度梯度
 *   · forceSpiral     —— 切向力 1/(1+r/R)，内快外慢
 *                        ⇒ 冷却期把盘梳成对数旋臂
 *
 * 不做成 d3 的 Force 对象（避免依赖 d3 的内部协议），
 * 改成「直接读节点数组、直接写 vx/vz」的普通函数，好接任何积分循环。
 */

/** 归一化半径（约星系盘半径量级），把强度缩到合理区间 */
const CORE_R = 200;
const SPIRAL_R = 160;

/**
 * 径向核心引力。
 * @param {number} strength 强度（0 = 关闭）
 * @param {number} alpha 当前温度 0..1
 * @param {Array<{x:number,z:number,vx:number,vz:number}>} nodes
 * @param {Float64Array|number[]} degrees 每点度数（用于 hub 沉核）
 */
export function applyCoreGravity(strength, alpha, nodes, degrees) {
	if (!strength) return;
	let meanDeg = 1;
	if (degrees && degrees.length) {
		let sum = 0;
		for (let i = 0; i < nodes.length; i += 1) sum += degrees[i] || 1;
		meanDeg = sum / nodes.length || 1;
	}
	for (let i = 0; i < nodes.length; i += 1) {
		const n = nodes[i];
		const x = n.x || 0;
		const z = n.z || 0;
		const r = Math.hypot(x, z);
		if (r < 1e-4) continue;
		/* 度权钳在 [0.3, 3]：太弱的压不住、太强的会把核抽爆 */
		const degW = Math.min(Math.max((degrees ? degrees[i] : 1) / meanDeg, 0.3), 3);
		const pull = (strength * degW * alpha * r) / CORE_R;
		n.vx = (n.vx || 0) - (x / r) * pull;
		n.vz = (n.vz || 0) - (z / r) * pull;
	}
}

/**
 * 旋臂切向力。
 * @param {number} strength 强度（0 = 无臂）
 * @param {number} alpha 当前温度 0..1
 */
export function applySpiral(strength, alpha, nodes) {
	if (!strength) return;
	for (let i = 0; i < nodes.length; i += 1) {
		const n = nodes[i];
		const x = n.x || 0;
		const z = n.z || 0;
		const r = Math.hypot(x, z);
		if (r < 1e-3) continue;
		const swirl = 1 / (1 + r / SPIRAL_R);
		const k = strength * alpha * swirl;
		/* 切向 (-z, x)/r，乘 r 抵消 → 稳定的切向线速度推进 */
		n.vx = (n.vx || 0) + (-z / r) * k * r;
		n.vz = (n.vz || 0) + (x / r) * k * r;
	}
}

/*
 * 压盘不在这里实现。
 *
 * galaxy-view 的压盘不是自定义力，而是 `forceY(0).strength(centerPull + flatten)`
 * —— 往 Y=0 平面整体压。自己写一个 vy 累计的版本量纲对不上（试过，压不出盘），
 * 所以 layout.js 直接用 forceY，这里不再提供 applyFlatten。
 */

