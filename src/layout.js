/**
 * 布局：d3-force-3d + 三个星系力。
 *
 * ⚠️ 量纲必须与 galaxy-view 的 MainThreadForceLayout 保持一致，
 * 因为 STYLE_PRESETS 里的数值是照着它的量纲眼调的。混用会让「银河」预设
 * 变成「一坨亮核」——coreGravity 差一个量级就完全变形。
 *
 * 它的实现（对照）：
 *   .alphaDecay(1 - 0.001^(1/300))
 *   .velocityDecay(0.4)
 *   .force('charge',  forceManyBody().strength(params.charge).distanceMax(800))
 *   .force('x'/'z',   forceX/forceZ(0).strength(centerPull))
 *   .force('y',       forceY(0).strength(centerPull + flatten))   ← flatten 就是加到 Y 上
 *   .force('core',    forceRadialCore(coreGravity, degrees))
 *   .force('spiral',  forceSpiral(spiral))
 *   链接强度 = min( 1/min(两端度数) × 倍率 , 1 )
 */
import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceX,
	forceY,
	forceZ
} from 'd3-force-3d';
import { applyCoreGravity, applySpiral } from './galaxyForces.js';

/** 取端点下标：forceLink 会把 source/target 从数字改写成节点对象 */
function refIndex(ref) {
	if (typeof ref === 'number') return ref;
	if (ref && typeof ref.index === 'number') return ref.index;
	return -1;
}

/**
 * 压盘：改成「布局后缩放 y」，不再走 forceY 死压。
 *
 * galaxy-view 用的是 `forceY(0).strength(centerPull + flatten)`，但那是**持续模拟**；
 * 我们一次跑 300 ticks 到完全收敛，alpha 累加起来 1 - exp(-0.28 × Σalpha) ≈ 1，
 * flatten 0.55 就把 y 压成 7/126 ≈ 0.06 —— 一张纸，不是盘。
 *
 * 换成缩放后：y/x 直接等于 keep = 1 - flatten × 0.85，梯度线性、厚度可控：
 *   flatten 0    → 1.00（球）
 *   flatten 0.55 → 0.53（有厚度的盘）
 *   flatten 0.75 → 0.36（扁盘）
 *   flatten 1    → 0.15（极薄）
 */
const FLATTEN_KEEP = 0.85;

/** 与预设同量纲的默认值（= galaxy-view 的「银河」档） */
export const LAYOUT_DEFAULTS = {
	repel: 170,          /* 斥力（UI 正值，内部转 -repel） */
	linkDistance: 55,
	linkStrength: 1.1,
	centerPull: 0.05,
	flatten: 0.55,       /* 加到 forceY 上的额外强度 → 压成盘 */
	coreGravity: 0.015,  /* 径向核心引力：真实数据下必须很小，否则全被吸成一个蒲公英 */
	spiral: 0.006,       /* 旋臂切向力 */
	velocityDecay: 0.4,
	ticks: 300,
	/* 按 cluster（cwd / 项目）分组：每个簇有自己的锚点，簇之间拉开 */
	clusterSpread: 1.0,  /* 簇间距倍率 */
	clusterPull: 0.16    /* 簇内聚强度 */
};

/** 节点归属哪个簇（cwd / topic），没有就返回 null */
function clusterKeyOf(node) {
	const p = node && node.point;
	if (!p) return null;
	const c = p.cluster !== undefined ? p.cluster : p.topic;
	if (c === undefined || c === null || c === '') return null;
	return String(c);
}

/**
 * 把 N 个簇按黄金角均匀铺在球面上，作为各自的引力锚点。
 * 18 个项目 = 18 个分离的星系，而不是被一个原点吸成蒲公英。
 */
function clusterAnchors(keys, spread) {
	const map = new Map();
	const n = keys.length;
	if (!n) return map;
	const GOLDEN = 2.399963229728653;
	for (let i = 0; i < n; i += 1) {
		const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
		const r = Math.sqrt(Math.max(0, 1 - y * y));
		const th = i * GOLDEN;
		map.set(keys[i], {
			x: Math.cos(th) * r * spread,
			y: y * spread * 0.55,      /* y 压扁，整体仍是盘状 */
			z: Math.sin(th) * r * spread
		});
	}
	return map;
}

/** 普通函数 → d3 Force 形状 */
function asForce(fn) {
	let nodes = [];
	const force = (alpha) => fn(alpha, nodes);
	force.initialize = (ns) => { nodes = ns; };
	return force;
}

/* FNV-1a：与 galaxy-view 的 seed.ts、旧版 client.js 同一套 */
function hash32(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i += 1) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}
function unit(s) {
	return hash32(s) / 0xffffffff;
}

/** 确定性撒种：同 id 永远落同处 */
function seed(nodes, radius) {
	for (let i = 0; i < nodes.length; i += 1) {
		const n = nodes[i];
		const u = unit(n.id);
		const v = unit(n.id + ':v');
		const w = unit(n.id + ':w');
		const r = radius * Math.cbrt(u);
		const theta = 2 * Math.PI * v;
		const phi = Math.acos(2 * w - 1);
		n.x = r * Math.sin(phi) * Math.cos(theta);
		n.y = r * Math.cos(phi);
		n.z = r * Math.sin(phi) * Math.sin(theta);
		n.vx = 0; n.vy = 0; n.vz = 0;
	}
}

/** d3 默认 1/min(度数)，再乘倍率，钳到 1（枢纽不会被拉爆） */
function linkStrengthFn(mult, degrees) {
	return (link) => {
		const s = refIndex(link.source);
		const t = refIndex(link.target);
		const base = 1 / Math.min((s >= 0 ? degrees[s] : 1) || 1, (t >= 0 ? degrees[t] : 1) || 1);
		return Math.min(base * mult, 1);
	};
}

/** 归一化到统一半径，让不同规模数据的取景一致 */
function normalize(nodes, targetR) {
	let maxR = 0;
	for (let i = 0; i < nodes.length; i += 1) {
		const r = Math.hypot(nodes[i].x, nodes[i].y, nodes[i].z);
		if (r > maxR) maxR = r;
	}
	if (maxR < 1e-3) return targetR;
	const k = targetR / maxR;
	for (let i = 0; i < nodes.length; i += 1) {
		nodes[i].x *= k;
		nodes[i].y *= k;
		nodes[i].z *= k;
	}
	return targetR;
}

/**
 * 跑一次布局。
 * @param {{nodes:Array, links:Array, degrees:Float64Array}} graph
 * @param {object} cfg 覆盖 LAYOUT_DEFAULTS（同量纲）
 * @param {object} [opts] 深探用的增量选项：
 *        · pinned       Map<id,{x,y,z}> 已有节点钉在原位，不参与重排
 *        · spawnFrom    Map<id,parentId> 新节点从父节点身边出生（"冒星点"）
 *        · ticks        覆盖 tick 数（增量时用很小的值）
 *        · alpha        初始 alpha（增量时 0.08 左右，只微调不重排）
 *        · skipNormalize 不做 260 半径归一化（否则已有节点会被整体压缩）
 * @returns {number} 归一化后的半径
 */
export function runLayout(graph, cfg, opts) {
	const o = opts || {};
	const c = Object.assign({}, LAYOUT_DEFAULTS, cfg);
	const nodes = graph.nodes;
	const links = graph.links;
	const degrees = graph.degrees;
	if (!nodes.length) return 260;

	/* 种子半径照它的 seedRadius 公式，给 40 下限防止极小数据集挤成一坨 */
	const seedR = Math.max(40, 80 * Math.cbrt(Math.max(nodes.length, 1) / 1000));
	const pinned = o.pinned && o.pinned.size ? o.pinned : null;
	const spawnFrom = o.spawnFrom || null;

	if (pinned) {
		/* 已有节点：钉死在原位 */
		for (const n of nodes) {
			const p = pinned.get(n.id);
			if (!p) continue;
			n.x = p.x; n.y = p.y; n.z = p.z;
			n.vx = 0; n.vy = 0; n.vz = 0;
			n.fx = p.x; n.fy = p.y; n.fz = p.z;
		}
		/* 新节点：优先从父节点身边冒出来，没有父节点才按哈希撒种 */
		for (const n of nodes) {
			if (pinned.has(n.id)) continue;
			const pid = spawnFrom && spawnFrom.get(n.id);
			const parent = pid ? pinned.get(pid) : null;
			if (parent) {
				n.x = parent.x + (Math.random() - 0.5) * 12;
				n.y = parent.y + (Math.random() - 0.5) * 12;
				n.z = parent.z + (Math.random() - 0.5) * 12;
			} else {
				const u = unit(n.id);
				const v = unit(n.id + ':v');
				const w = unit(n.id + ':w');
				const r = seedR * Math.cbrt(u);
				const theta = 2 * Math.PI * v;
				const phi = Math.acos(2 * w - 1);
				n.x = r * Math.sin(phi) * Math.cos(theta);
				n.y = r * Math.cos(phi);
				n.z = r * Math.sin(phi) * Math.sin(theta);
			}
			n.vx = 0; n.vy = 0; n.vz = 0;
		}
	} else if (o.warmStart) {
		/*
		 * 热启动：**从当前位置继续跑**，既不重新撒种、也不锁定。
		 *
		 * 用于「拖动滑杆重排」—— 节点数没变，只是力学参数变了。
		 * 之前走的是 seed()，等于把所有点扔回随机初始位置再收回来，
		 * 所以每次调参都像换了张图、还跳一下。
		 * 热启动只让力去微调现有位置，位移小、过渡自然。
		 */
		for (const n of nodes) {
			n.vx = 0; n.vy = 0; n.vz = 0;
			n.fx = null; n.fy = null; n.fz = null;
		}
	} else {
		seed(nodes, seedR);
	}

	/*
	 * ── 极坐标布点（深探专用，直接落位、不跑力导向）──
	 *
	 * 深探一个会话会一次灌进 2000+ 条消息。如果交给力导向：
	 * 斥力把这堆点从父轮次身边推开几百个单位 → 点散落到全屏，
	 * 连线被拉成几千单位长的射线 —— 就是用户看到的
	 * 「点散落全屏、点和线分离」。跑够 tick 能收敛，但要卡几百毫秒。
	 *
	 * 极坐标是确定的、瞬时的、永远贴着父节点：
	 * 同一个轮次下的消息围成一小簇，轮次再绕着会话 ——
	 * 正好是「一簇连着一簇」的枝条形状。
	 */
	if (pinned && spawnFrom && spawnFrom.size && o.polarSpawn) {
		const kids = new Map();
		const singles = [];
		for (const n of nodes) {
			if (pinned.has(n.id)) continue;
			const pid = spawnFrom.get(n.id);
			const base = pid ? pinned.get(pid) : null;
			if (!base) { singles.push(n); continue; }
			let arr = kids.get(pid);
			if (!arr) { arr = []; kids.set(pid, arr); }
			arr.push(n);
		}

		const GOLDEN = 2.399963229728653;   /* 同一个黄金角，和簇锚点一致 */
		for (const [pid, arr] of kids) {
			const base = pinned.get(pid);
			const cnt = arr.length;
			for (let k = 0; k < cnt; k += 1) {
				const n = arr[k];
				const isTurn = n.point && n.point.kind === 'turn';
				/* 轮次比消息散得更开 —— 它下面还要挂消息 */
				const r0 = isTurn ? 30 : 15;
				const r1 = isTurn ? 14 : 9;
				const r = r0 + r1 * Math.sqrt(k);
				/* Fibonacci 球面：不挤在一个平面上，也不会重叠成一坨 */
				const phi = Math.acos(1 - 2 * ((k + 0.5) / cnt));
				const th = k * GOLDEN;
				const sp = Math.sin(phi);
				n.x = base.x + r * sp * Math.cos(th);
				n.y = base.y + r * Math.cos(phi) * 0.5;   /* y 压扁，整体仍是盘状 */
				n.z = base.z + r * sp * Math.sin(th);
				n.vx = 0; n.vy = 0; n.vz = 0;
			}
		}
		/* 没有父节点的（理论上不该出现）：贴着原点撒一圈，别飞出去 */
		for (let k = 0; k < singles.length; k += 1) {
			const n = singles[k];
			const r = 120 + 20 * Math.sqrt(k);
			const th = k * GOLDEN;
			n.x = r * Math.cos(th);
			n.y = 0;
			n.z = r * Math.sin(th);
			n.vx = 0; n.vy = 0; n.vz = 0;
		}

		let maxR = 0;
		for (const n of nodes) {
			n.fx = null; n.fy = null; n.fz = null;
			const r = Math.hypot(n.x, n.y, n.z);
			if (r > maxR) maxR = r;
		}
		return maxR || 260;
	}

	/*
	 * 按 cluster 分组布局：每个簇（cwd / 项目）有自己的球面锚点。
	 *
	 * 这是为了治「蒲公英」——原来所有点被 forceX/Y/Z(0) 和 coreGravity 吸向
	 * 同一个原点，18 个项目糊成一个中心 + 放射。数据本来是 **分层嵌套的树**
	 * （项目 ⊃ 会话 ⊃ 轮次 ⊃ 消息），布局必须体现这个结构。
	 */
	const clusterKeys = [];
	{
		const seenK = new Set();
		for (const n of nodes) {
			const k = clusterKeyOf(n);
			if (k === null || seenK.has(k)) continue;
			seenK.add(k);
			clusterKeys.push(k);
		}
	}
	const spread = Math.max(120, seedR * 2.6) * (Number(c.clusterSpread) || 1);
	const anchors = clusterAnchors(clusterKeys, spread);

	/*
	 * 初始位置也贴到各自簇的锚点上。
	 * 否则所有点从原点附近撒开，力导向要花很多 tick 才能把 18 个簇拉开，
	 * 中途看起来就是「一团糊」。
	 */
	if (!pinned && anchors.size) {
		for (const n of nodes) {
			const a = anchors.get(clusterKeyOf(n));
			if (!a) continue;
			n.x += a.x; n.y += a.y; n.z += a.z;
		}
	}

	/* 层级距离：消息贴着轮次、轮次贴着会话，越深越紧，形成星座式的局部结构 */
	const linkDist = (l) => {
		const a = nodes[refIndex(l.source)];
		const b = nodes[refIndex(l.target)];
		const ka = a && a.point && a.point.kind;
		const kb = b && b.point && b.point.kind;
		if (ka === 'record' || kb === 'record') return c.linkDistance * 0.5;
		if (ka === 'word' || kb === 'word') return c.linkDistance * 0.45;
		return c.linkDistance;
	};

	const ticks = Math.max(1, Math.round(o.ticks !== undefined && o.ticks !== null ? o.ticks : c.ticks));
	const sim = forceSimulation(nodes, 3)
		.alphaDecay(1 - Math.pow(0.001, 1 / Math.max(1, ticks)))
		.velocityDecay(c.velocityDecay)
		.force('link', forceLink(links).distance(linkDist).strength(linkStrengthFn(c.linkStrength, degrees)))
		.force('charge', forceManyBody().strength(-Math.abs(c.repel)).distanceMax(900))
		/* 簇内聚：拉向自己簇的锚点，而不是全局原点 */
		.force('cluster', asForce((alpha, ns) => {
			const k = (Number(c.clusterPull) || 0.16) * alpha;
			if (!k || !anchors.size) return;
			for (const n of ns) {
				const a = anchors.get(clusterKeyOf(n));
				if (!a) continue;
				n.vx += (a.x - n.x) * k;
				n.vy += (a.y - n.y) * k;
				n.vz += (a.z - n.z) * k;
			}
		}))
		/* 全局向心只留很弱的一点，防止整体飘走 */
		.force('x', forceX(0).strength(c.centerPull * 0.25))
		.force('y', forceY(0).strength(c.centerPull * 0.25))
		.force('z', forceZ(0).strength(c.centerPull * 0.25))
		.force('core', asForce((alpha, ns) => applyCoreGravity(c.coreGravity, alpha, ns, degrees)))
		.force('spiral', asForce((alpha, ns) => applySpiral(c.spiral, alpha, ns)))
		.stop();

	if (o.alpha !== undefined && o.alpha !== null) sim.alpha(o.alpha);

	/*
	 * 分步模式：先跑几 tick 让点落到大致方向，把 sim 交出去，
	 * 剩下的由渲染循环每帧跑一点。
	 *
	 * 目的是首帧交互 —— 用户点进来先看到东西在动，而不是盯着空白等
	 * 300 tick 跑完。这就是"细胞增殖/烟火扩散"的观感：一边出现一边归位。
	 */
	if (o.stepwise) {
		const pre = Math.min(ticks, Math.max(0, o.preTicks || 6));
		for (let i = 0; i < pre; i += 1) sim.tick();
		graph.__sim = sim;
		graph.__pendingTicks = Math.max(0, ticks - pre);
		let preR = 0;
		for (let i = 0; i < nodes.length; i += 1) {
			const r = Math.hypot(nodes[i].x, nodes[i].y, nodes[i].z);
			if (r > preR) preR = r;
		}
		return preR || 260;
	}

	for (let i = 0; i < ticks; i += 1) {
		sim.tick();
		if (sim.alpha() < sim.alphaMin()) break;
	}

	/* 解除固定，否则之后拖动/相机操作会被钉住 */
	if (pinned) {
		for (const n of nodes) { n.fx = null; n.fy = null; n.fz = null; }
	}

	/* 压盘：按 flatten 缩放 y（0 = 球，1 = 极薄盘）。必须在 normalize 之前，
	   否则等比缩放会把刚做好的厚度又拉回去。 */
	const keep = 1 - Math.min(0.9, Math.max(0, c.flatten) * FLATTEN_KEEP);
	if (keep < 0.999) {
		for (let i = 0; i < nodes.length; i += 1) nodes[i].y *= keep;
	}

	/* 深探：不归一化，保住已有节点的坐标，否则整图会被压小 */
	if (o.skipNormalize) {
		let maxR = 0;
		for (let i = 0; i < nodes.length; i += 1) {
			const r = Math.hypot(nodes[i].x, nodes[i].y, nodes[i].z);
			if (r > maxR) maxR = r;
		}
		return maxR || 260;
	}

	return normalize(nodes, 260);
}

/** 半径 → 建议相机距离 */
export function fitDistance(radius) {
	const r = radius > 1 ? radius : 260;
	/* 2.35 太远：星系只占画面中间一块，四周大片空黑，点也显得小。
	   1.85 让盘铺满视口。点尺寸按透视换算，相机拉近本身就会让点变大。 */
	return r * 1.85;
}

/** 相机仰角（度）→ 相机位置：0 = 贴盘面平视，90 = 正上方俯视 */
export function cameraFromElev(radius, elevDeg) {
	const d = fitDistance(radius);
	const e = (Math.max(0, Math.min(90, Number(elevDeg) || 50)) * Math.PI) / 180;
	return { x: 0, y: d * Math.sin(e), z: d * Math.cos(e) };
}
