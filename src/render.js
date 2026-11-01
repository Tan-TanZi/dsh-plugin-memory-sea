/**
 * three 渲染层：一座星系。
 *
 * 着色器 / 曲线 / 开场动画**照抄** galaxy-view（MIT）：
 *   · 节点 shader ← src/render/shaders.ts 的 NODE_VERTEX_SHADER / NODE_FRAGMENT_SHADER
 *   · 曲线系数    ← src/render/linkCurves.ts 的 CURVE_BOW = 0.32
 *   · 开场展开    ← src/render/reveal.ts 的 DELAY_SPAN 0.55 / ACTIVE_SPAN 0.45
 *
 * 悬浮与拖动参考 orrery（MIT）：
 *   · 悬浮一颗星 → 它和邻居保持满亮，其余淡到 0.12（`aDim` 属性）
 *   · 拖动一颗星 → 它在过自身且垂直于相机的平面上移动，连线实时跟随
 *
 * 高亮**不新增几何**：连线的每段带 `aHot` 属性，与焦点相连的那几段在原缓冲里
 * 直接变亮变白 —— 所以看起来是「原来的线亮了」，不是盖了一条新线。
 *
 * 画质：后处理链的 RT 用 HalfFloatType + MSAA 4x；`ssaa` 倍率做超采样。
 */
import {
	WebGLRenderer,
	WebGLRenderTarget,
	HalfFloatType,
	Scene,
	PerspectiveCamera,
	Vector2,
	Vector3,
	Color,
	Plane,
	BufferGeometry,
	Float32BufferAttribute,
	Points,
	ShaderMaterial,
	AdditiveBlending,
	LineSegments,
	Raycaster,
	SphereGeometry,
	Mesh,
	BackSide,
	ACESFilmicToneMapping,
	SRGBColorSpace,
	MOUSE
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { rgbOf, toGraph } from './scene.js';
import { colorFnFor } from './presets.js';
import { runLayout, cameraFromElev, fitDistance } from './layout.js';
import { createPointerMachine } from './interact.js';

/* ══ 着色器（照抄）═══════════════════════════════════════════════════════ */
const REVEAL_GLSL = /* glsl */ `
	vec3 revealPosition(vec3 p) {
		if (uRevealActive < 0.5) return p;
		float delay = (length(p) / max(uRevealMaxRadius, 0.0001)) * 0.55;
		float local = clamp((uRevealProgress - delay) / 0.45, 0.0, 1.0);
		float scale = 1.0 - pow(1.0 - local, 3.0);
		return p * scale;
	}
`;

/*
 * ── 位移动画（GPU 侧）──
 *
 * 核心约定：**position 永远是正确的最终结构**。
 * 出生位置放在 aFrom 里，shader 按 morphT() 在两者之间插值。
 *
 * 为什么必须这样做：
 *   之前是在 CPU 上把 position 改成出生位置、每帧写回 buffer。
 *   点和线是两份独立的 buffer，两条更新路径 —— 只要有一条没刷到，
 *   就出现用户看到的「点和线分离、点散落但线伸向远方」。
 *   放到 GPU 上以后，点和线走的是**同一个公式、同一个 uniform**，
 *   物理上不可能不同步。
 *
 * 而且每帧只改一个 uniform（uMorphT），零 buffer 上传。
 *
 * 分层：aLayer 是节点所属层级；同层共享同一个进度，
 * 所以同一层级的点**同批**显形（用户要的"一层一层长出来"）。
 * aLayer 全部为 0 时退化成"所有东西一起过渡" —— 预设切换就靠这个。
 */
const MORPH_GLSL = /* glsl */ `
	attribute vec3 aFrom;
	attribute float aLayer;
	uniform float uMorphOn;
	uniform float uMorphT;
	uniform float uLayerCount;
	uniform float uLayerSpan;
	float morphT() {
		if (uMorphOn < 0.5) return 1.0;
		/* aLayer < 0 = 这一轮不参与（已经在那儿的老节点），直接停在结构态 */
		if (aLayer < -0.5) return 1.0;
		float n = max(uLayerCount, 1.0);
		/* 层在总时长里的起点：0, 1/(n-1), 2/(n-1)… 每层占 span */
		float start = n > 1.5 ? aLayer * (1.0 - uLayerSpan) / (n - 1.0) : 0.0;
		float t = clamp((uMorphT - start) / max(uLayerSpan, 0.0001), 0.0, 1.0);
		/*
		 * smoothstep 而不是 easeOutCubic。
		 * easeOutCubic 前三成时间就跑完九成路程，肉眼看起来就是"线一下就全长、
		 * 点和线几乎同时到位"，等于没有过程。smoothstep 慢起慢收，线是真的
		 * 一格一格伸出去 —— 用户要的"像通电一样"。
		 */
		return t * t * (3.0 - 2.0 * t);
	}
	vec3 morphPosition(vec3 p) {
		return mix(aFrom, p, morphT());
	}
`;

const NODE_VERTEX = /* glsl */ `
	attribute vec3 aColor;
	attribute float aSize;
	attribute float aDim;
	/* 筛选：0 = 这个点被筛掉了，直接丢到裁剪空间外，size 也归零 */
	attribute float aShow;
	varying vec3 vColor;
	varying float vDim;
	/* 显隐进度：深探时位置不动，只靠它把新节点按层"点"出来 */
	varying float vM;
	uniform float uPixelScale;
	uniform float uSizeMul;
	uniform float uMaxPoint;
	uniform float uRevealActive;
	uniform float uRevealProgress;
	uniform float uRevealMaxRadius;
	uniform float uGrowScale;
	${REVEAL_GLSL}
	${MORPH_GLSL}
	void main() {
		if (aShow < 0.5) {
			gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
			gl_PointSize = 0.0;
			return;
		}
		vColor = aColor;
		vDim = aDim;
		float m = morphT();
		vM = m;
		vec4 mv = modelViewMatrix * vec4(revealPosition(morphPosition(position)), 1.0);
		/* 尺寸和位置同一条时间线。之前给点加了"滞后"想让线先到，
		   结果前 25% 时间里点被缩到 0.12 倍 —— 屏幕上只剩几根线在飘，
		   用户看到的就是"画几根线到那里是什么意思"。 */
		gl_PointSize = min(aSize * uSizeMul * uPixelScale / max(-mv.z, 1.0), uMaxPoint)
			* mix(uGrowScale, 1.0, m);
		gl_Position = projectionMatrix * mv;
	}
`;

const NODE_FRAGMENT = /* glsl */ `
	varying vec3 vColor;
	varying float vDim;
	varying float vM;
	uniform float uBoost;
	void main() {
		vec2 uv = gl_PointCoord - 0.5;
		float d = length(uv);
		/* 白热核心：中心向白色混 55% —— NASA「luminous orb」的配方 */
		float core = smoothstep(0.18, 0.0, d) * 0.55;
		vec3 col = mix(vColor, vec3(1.0), core) * uBoost;
		/* 圆盘几乎全实，只有最外 8% 软边；vDim 做聚焦淡出，
		   vM 做深探的分层显形（位置不动，只是从无到有） */
		float alpha = smoothstep(0.5, 0.42, d) * vDim * vM;
		if (alpha < 0.01) discard;
		gl_FragColor = vec4(col, alpha);
	}
`;

/* 连线：高亮走 aHot，不新增几何 */
const LINE_VERTEX = /* glsl */ `
	attribute float aHot;
	/* 筛选：任一端被筛掉，整条边也一起消失 */
	attribute float aShow;
	varying float vHot;
	/* 显隐进度：和点读同一个 uniform，所以线和点的亮起完全同步 */
	varying float vM;
	uniform float uRevealActive;
	uniform float uRevealProgress;
	uniform float uRevealMaxRadius;
	${REVEAL_GLSL}
	${MORPH_GLSL}
	void main() {
		if (aShow < 0.5) {
			gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
			return;
		}
		vHot = aHot;
		vM = morphT();
		/* 和点走同一个 morphPosition —— 线的两端各自插值，
		   所以边是"被拉长"，不是整条平移 */
		gl_Position = projectionMatrix * modelViewMatrix * vec4(revealPosition(morphPosition(position)), 1.0);
	}
`;
const LINE_FRAGMENT = /* glsl */ `
	varying float vHot;
	varying float vM;
	uniform vec3 uBaseColor;
	uniform vec3 uHotColor;
	uniform float uBaseAlpha;
	uniform float uHotAlpha;
	void main() {
		vec3 c = mix(uBaseColor, uHotColor, vHot);
		float a = mix(uBaseAlpha, uHotAlpha, vHot) * vM;
		if (a < 0.004) discard;
		gl_FragColor = vec4(c, a);
	}
`;

const STAR_VERTEX = /* glsl */ `
	uniform float uPixelRatio;
	uniform float uSize;
	void main() {
		gl_PointSize = uSize * uPixelRatio;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}
`;
const STAR_FRAGMENT = /* glsl */ `
	uniform float uAlpha;
	uniform vec3 uColor;
	uniform float uTime;
	uniform float uTwinkle;
	void main() {
		vec2 uv = gl_PointCoord - 0.5;
		if (length(uv) > 0.5) discard;
		float k = 1.0;
		if (uTwinkle > 0.001) k = 1.0 - uTwinkle * 0.5 * (0.5 + 0.5 * sin(uTime * 2.3));
		gl_FragColor = vec4(uColor, uAlpha * k);
	}
`;

const NEBULA_VERTEX = /* glsl */ `
	varying vec3 vPos;
	void main() {
		vPos = position;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}
`;
const NEBULA_FRAGMENT = /* glsl */ `
	varying vec3 vPos;
	uniform float uStrength;
	uniform vec3 uInner;
	uniform vec3 uOuter;
	void main() {
		float h = clamp(normalize(vPos).y * 0.5 + 0.5, 0.0, 1.0);
		float band = pow(1.0 - abs(h - 0.5) * 2.0, 3.0);
		vec3 col = mix(uOuter, uInner, band);
		gl_FragColor = vec4(col, band * uStrength * 0.30);
	}
`;

/* ══ 工具 ══════════════════════════════════════════════════════════════ */
function nodeAt(nodes, ref) {
	if (typeof ref === 'number') return nodes[ref] || null;
	if (ref && typeof ref.index === 'number') return nodes[ref.index] || null;
	return null;
}
function refIndex(ref) {
	if (typeof ref === 'number') return ref;
	if (ref && typeof ref.index === 'number') return ref.index;
	return -1;
}

function makeStarLayer(count, rMin, rMax, size) {
	const pos = new Float32Array(count * 3);
	for (let i = 0; i < count; i += 1) {
		const u = Math.random();
		const v = Math.random();
		const w = Math.random();
		const r = rMin + (rMax - rMin) * Math.cbrt(u);
		const theta = 2 * Math.PI * v;
		const phi = Math.acos(2 * w - 1);
		pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
		pos[i * 3 + 1] = r * Math.cos(phi);
		pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
	}
	const geo = new BufferGeometry();
	geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
	const mat = new ShaderMaterial({
		uniforms: {
			uPixelRatio: { value: 1 },
			uSize: { value: size },
			uAlpha: { value: 0.5 },
			uColor: { value: new Color(0.80, 0.86, 1.0) },
			uTime: { value: 0 },
			uTwinkle: { value: 0 }
		},
		vertexShader: STAR_VERTEX,
		fragmentShader: STAR_FRAGMENT,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending
	});
	const pts = new Points(geo, mat);
	pts.frustumCulled = false;
	return pts;
}

/** 曲线连线：控制点 = 边中点沿「远离星系核」外推，弓高 = curvature × 0.32 × 边长 */
const CURVE_BOW = 0.32;

function fillLinkSegments(out, offset, a, b, curve) {
	const SEG = 6;
	if (curve <= 0.001) {
		/*
		 * 直边也切成 SEG 段。
		 * 好处：「连线弯曲」可以从 0 平滑拖到任意值，不必重建 buffer ——
		 * 重建一次就是整图刷新一次，那是用户最烦的"改个设置还要刷页面"。
		 * 代价只有 6 倍顶点，1385 条边也就 200KB。
		 */
		for (let i = 0; i < SEG; i += 1) {
			const t0 = i / SEG;
			const t1 = (i + 1) / SEG;
			const o = offset + i * 6;
			out[o] = a.x + (b.x - a.x) * t0;
			out[o + 1] = a.y + (b.y - a.y) * t0;
			out[o + 2] = a.z + (b.z - a.z) * t0;
			out[o + 3] = a.x + (b.x - a.x) * t1;
			out[o + 4] = a.y + (b.y - a.y) * t1;
			out[o + 5] = a.z + (b.z - a.z) * t1;
		}
		return SEG;
	}
	const mx = (a.x + b.x) * 0.5;
	const my = (a.y + b.y) * 0.5;
	const mz = (a.z + b.z) * 0.5;
	const mr = Math.hypot(mx, my, mz);
	const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
	const h = curve * CURVE_BOW * len;

	let dx;
	let dy;
	let dz;
	if (mr > 1e-3) {
		dx = mx / mr; dy = my / mr; dz = mz / mr;
	} else {
		const ex = b.x - a.x;
		const ez = b.z - a.z;
		const pl = Math.hypot(ez, ex);
		if (pl > 1e-6) { dx = ez / pl; dy = 0; dz = -ex / pl; }
		else { dx = 1; dy = 0; dz = 0; }
	}
	const cx = mx + dx * h;
	const cy = my + dy * h;
	const cz = mz + dz * h;

	let px = a.x;
	let py = a.y;
	let pz = a.z;
	let o = offset;
	for (let s = 1; s <= SEG; s += 1) {
		const t = s / SEG;
		const w0 = (1 - t) * (1 - t);
		const w1 = 2 * (1 - t) * t;
		const w2 = t * t;
		const qx = w0 * a.x + w1 * cx + w2 * b.x;
		const qy = w0 * a.y + w1 * cy + w2 * b.y;
		const qz = w0 * a.z + w1 * cz + w2 * b.z;
		out[o] = px; out[o + 1] = py; out[o + 2] = pz;
		out[o + 3] = qx; out[o + 4] = qy; out[o + 5] = qz;
		o += 6;
		px = qx; py = qy; pz = qz;
	}
	return SEG;
}

/* ══ 渲染器 ════════════════════════════════════════════════════════════ */
export function createRenderer(canvas, sceneData, hooks) {
	const cb = hooks || {};

	/*
	 * 标签画在单独一张 2D canvas 上（由外壳创建、绝对定位盖在 WebGL 画布上）。
	 *
	 * ★ 必须在这里声明：之前把 `let labelCanvas` 写在下面"标签层"那一节，
	 *   却在这个位置赋值 —— `let` 有 TDZ，赋值的瞬间抛
	 *   ReferenceError: Cannot access 'labelCanvas' before initialization，
	 *   createRenderer 直接炸，面板根本打不开。
	 */
	let labelCanvas = cb.labelCanvas || null;
	const labelCtx = labelCanvas ? labelCanvas.getContext('2d') : null;

	let renderer;
	try {
		renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
	} catch (e) {
		return null;
	}
	if (!renderer || !renderer.getContext()) return null;

	renderer.setClearColor(0x000000, 0);
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.28;
	renderer.outputColorSpace = SRGBColorSpace;

	const scene = new Scene();
	const camera = new PerspectiveCamera(52, 1, 1, 40000);
	camera.position.set(0, 300, 700);

	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.07;
	controls.rotateSpeed = 0.62;
	controls.zoomSpeed = 0.8;
	controls.panSpeed = 0.7;
	controls.minDistance = 60;
	controls.maxDistance = 12000;
	controls.autoRotate = true;
	controls.autoRotateSpeed = 0.22;

	/* 后处理链：HalfFloat（HDR）+ MSAA 4x。
	   antialias: true 只作用于默认帧缓冲，走 composer 就失效，只能靠 RT 的 samples。 */
	const composerTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
	const composer = new EffectComposer(renderer, composerTarget);
	composer.addPass(new RenderPass(scene, camera));
	/*
	 * UnrealBloomPass(resolution, strength, radius, threshold)
	 * 第四个参数是 threshold —— 原值 0.22 太低，几乎全部像素都参与发光，
	 * 1177 个点的真实数据挤在一起立刻过曝成白。提到 0.62 后只有亮核才晕开，
	 * 颜色才留得住。
	 */
	const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.28, 0.42, 0.62);
	composer.addPass(bloom);
	composer.addPass(new OutputPass());

	const starFar = makeStarLayer(900, 3200, 4600, 1.4);
	const starNear = makeStarLayer(260, 900, 2400, 2.4);
	scene.add(starFar);
	scene.add(starNear);

	const nebula = new Mesh(
		new SphereGeometry(18000, 24, 16),
		new ShaderMaterial({
			uniforms: {
				uStrength: { value: 0.35 },
				uInner: { value: new Color(0.10, 0.16, 0.34) },
				uOuter: { value: new Color(0.02, 0.02, 0.06) }
			},
			vertexShader: NEBULA_VERTEX,
			fragmentShader: NEBULA_FRAGMENT,
			transparent: true,
			depthWrite: false,
			side: BackSide,
			blending: AdditiveBlending
		})
	);
	nebula.frustumCulled = false;
	scene.add(nebula);

	/* ── 状态 ── */
	let graph = null;
	let radius = 260;
	/* 当前场景数据：applyAttrs 重算颜色时要重新走 colorFnFor，需要原始 scene */
	let lastScene = null;
	/* 最近一次 build 的配置：replayGrow 要用它拿生长时长 */
	let lastCfg = null;
	let nodePoints = null;
	let linkLines = null;
	/* 每条成功写入的边：顶点起始索引 + 段的浮点偏移（拖动时重算用） */
	let linkVertBase = [];
	let linkFloatBase = [];
	let linkEnds = [];
	let perLinkSegs = 1;
	let selectedIndex = -1;
	let hoverIndex = -1;
	let draggingIndex = -1;
	/*
	 * ── 分层生长动画 ──
	 *
	 * 用户的原话：「知道树吧，从根长到树干。同一级别（层次）的就一起讲。」
	 *
	 * 所以不是所有新点一起均匀淡入（那只叫整体性，没有过程），而是**按层推进**：
	 *   项目/会话(0) → 轮次(1) → 消息(2) → 词(3)
	 * 同一层的点**同批**显形，层与层之间隔 GROW_GAP_MS。
	 *
	 * 每个点的出生位置 = 它父节点的位置，于是观感是「枝干从分叉处伸出去」，
	 * 连线也跟着被拉长 —— 不是原地淡入。
	 *
	 * grow = {
	 *   t0:      performance.now()
	 *   layers:  [[item,...], ...]      按层分好
	 *   dur:     单层生长时长
	 *   gap:     层间隔
	 *   growing: Set<index>             这一帧还在动的点（用来重算它们的边）
	 * }
	 * item = { i, sx, sy, sz, fx, fy, fz, done }
	 */
	/*
	 * 分层生长动画。总时长由「生长时长」设置决定，默认 5 秒 ——
	 * 0.45 秒内全部长完时人眼分不出层次，只会看到"一起炸开"。
	 */
	let grow = null;
	let growMs = 400;
	/* 高亮回溯深度（设置项）：1 = 只有直接邻居，越大越往回亮到根 */
	let focusDepth = 1;
	/* 观赏模式：不响应悬停高亮、不响应点击选中，左键改为平移 */
	let readOnly = false;
	/* 邻接表（索引域）：回溯高亮和 Ctrl 整簇拖动都要用 */
	let adjOf = new Map();
	/* Ctrl 拖动整簇时的弹簧状态 */
	let clusterDrag = null;
	/* 弹簧参数（设置项）：刚度越大追得越紧，阻尼越小晃得越久 */
	let clusterStiffness = 0.22;
	let clusterDamping = 0.82;
	/* 按下那一刻的修饰键：Ctrl = 拖整簇 */
	const dragMods = { ctrl: false };
	/* 当前按住的指针 id，用来在结束时强制释放 capture */
	let activePointerId = -1;
	const GROW_TOTAL_MS = 5000;    /* 整个生长动画的总时长 */
	const GROW_START_SCALE = 0.3; /* 刚冒出来时的尺寸系数：太小就只剩线、看不见点 */
	const reveal = { active: 0, progress: 1, maxRadius: 1, t0: 0 };

	/* 层级序：数字小的先长出来。词是横向突触，放最后。 */
	const LAYER_ORDER = { cluster: 0, session: 1, turn: 2, record: 3, word: 4 };
	const layerKeyOf = (p) => {
		const k = p && p.kind;
		return LAYER_ORDER[k] !== undefined ? LAYER_ORDER[k] : 2;
	};

	/* ── 尺寸 ── */
	let w = 1;
	let h = 1;
	let dpr = 1;
	let ssaa = 1;
	let pixelScale = 820;
	let perfTier = 'auto';

	function resize() {
		w = Math.max(1, canvas.clientWidth);
		h = Math.max(1, canvas.clientHeight);
		const cap = (perfTier === 'low' || perfTier === 'mobile') ? 1 : 2;
		const base = Math.min(cap, window.devicePixelRatio || 1);
		/* 超采样：以 base×ssaa 渲染，再由浏览器缩到 CSS 尺寸。
		   dpr=1 的普通屏上这是唯一还能明显提锐的手段。 */
		dpr = base * Math.max(1, ssaa);
		renderer.setPixelRatio(dpr);
		renderer.setSize(w, h, false);
		/* ★ composer 内部用 _pixelRatio 乘尺寸；漏了这一步整个后处理链会跑在 CSS 分辨率上 */
		if (typeof composer.setPixelRatio === 'function') composer.setPixelRatio(dpr);
		composer.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		pixelScale = (h * dpr) / (2 * Math.tan((camera.fov * Math.PI) / 360));
		if (nodePoints) nodePoints.material.uniforms.uPixelScale.value = pixelScale;
		for (const p of [starFar, starNear]) p.material.uniforms.uPixelRatio.value = dpr;
		/* 标签层跟主画布同尺寸（按 dpr 放大，文字才不虚） */
		if (labelCanvas) {
			labelCanvas.width = Math.max(1, Math.round(w * dpr));
			labelCanvas.height = Math.max(1, Math.round(h * dpr));
		}
	}

	function disposeObj(obj) {
		if (!obj) return;
		scene.remove(obj);
		if (obj.geometry) obj.geometry.dispose();
		if (obj.material) obj.material.dispose();
	}

	/* 位移动画的四个 uniform：点和线共用同一份，所以两者永远同步 */
	function MORPH_UNIFORMS() {
		return {
			uMorphOn: { value: 0 },      /* 0 = 直接用 position（结构态） */
			uMorphT: { value: 1 },       /* 0..1 总进度 */
			uLayerCount: { value: 1 },   /* 层数；1 = 所有点一起过渡 */
			uLayerSpan: { value: 0.45 }, /* 单层占多少总时长 */
			uGrowScale: { value: GROW_START_SCALE }
		};
	}

	function makeNodeMaterial(sizeMul, maxPoint) {
		return new ShaderMaterial({
			uniforms: {
				uPixelScale: { value: pixelScale },
				uSizeMul: { value: sizeMul },
				uMaxPoint: { value: maxPoint },
				uBoost: { value: 1 },
				uRevealActive: { value: 0 },
				uRevealProgress: { value: 1 },
				uRevealMaxRadius: { value: 1 },
				...MORPH_UNIFORMS()
			},
			vertexShader: NODE_VERTEX,
			fragmentShader: NODE_FRAGMENT,
			transparent: true,
			depthWrite: false
		});
	}

	/* ── 颜色 / 尺寸的纯计算（build 和 applyAttrs 共用） ──
	 *
	 * 抽出来的原因：切换「配色」「点大小依据」不该重建几何。
	 * 之前这两个参数进 geometryKey，一改就整图重建 —— 用户的体感就是
	 * "改个设置还要刷页面"。
	 */

	/*
	 * 层级尺寸表。消息层再细分：
	 *   工具调用最轻（它是动作记录，不是内容）
	 *   压缩摘要是被蒸馏过的精华，比普通消息重
	 */
	const LEVEL_SIZE = { cluster: 5.4, session: 4.4, turn: 2.6, record: 1.9, word: 1.6 };
	function levelOf(p) {
		if (!p) return 1.9;
		if (p.kind === 'record') {
			if (p.recordKind === 'tool') return 1.35;
			if (p.recordKind === 'compaction') return 2.7;
			if (p.recordKind === 'user') return 2.0;
			return 1.8;                    /* assistant */
		}
		if (p.kind && LEVEL_SIZE[p.kind] !== undefined) return LEVEL_SIZE[p.kind];
		return 1.9;
	}

	/**
	 * 点大小依据（sizeBy）：
	 *   degree  —— 按连接数（枢纽大）
	 *   uniform —— 一律同大
	 *   weight  —— 按数据权重（消息长度 / 工具数 / 压缩摘要加权）
	 *   level   —— 按层级递减：会话 > 轮次 > 消息 > 词
	 */
	function sizeArrayFor(nodes, c) {
		const cc = c || {};
		const n = nodes.length;
		const out = new Float32Array(n);
		const weights = new Float32Array(n);
		let wMax = 0;
		for (let i = 0; i < n; i += 1) {
			weights[i] = Math.max(0.05, Number(nodes[i].point && nodes[i].point.weight) || 0.2);
			if (weights[i] > wMax) wMax = weights[i];
		}
		if (wMax <= 0) wMax = 1;
		for (let i = 0; i < n; i += 1) {
			const node = nodes[i];
			const deg = Math.max(1, Number(node.degree) || 1);
			let base;
			if (cc.sizeBy === 'uniform') base = 2.2 * 1.5;
			else if (cc.sizeBy === 'weight') base = (1.1 + 3.0 * Math.sqrt(weights[i] / wMax)) * 1.5;
			else if (cc.sizeBy === 'level') base = levelOf(node.point) * 1.5;
			else base = Math.min(20, 2.2 * (1 + 0.5 * Math.sqrt(deg)) * 1.5);
			out[i] = base * (node.point && node.point.diary ? 1.15 : 1);
		}
		return out;
	}

	function colorArrayFor(nodes, scene_, c) {
		const colorFn = colorFnFor(scene_, c);
		const out = new Float32Array(nodes.length * 3);
		for (let i = 0; i < nodes.length; i += 1) {
			const rgb = colorFn(nodes[i].point);
			out[i * 3] = rgb[0];
			out[i * 3 + 1] = rgb[1];
			out[i * 3 + 2] = rgb[2];
		}
		return out;
	}

	/**
	 * 只重算颜色 / 点大小 —— 不重建几何、不重排布局、不动相机。
	 * 观感上是"立刻变"，不是"刷新"。
	 */
	function applyAttrs(cfg) {
		const c = cfg || {};
		if (!nodePoints || !graph) return;
		const colAttr = nodePoints.geometry.attributes.aColor;
		const sizAttr = nodePoints.geometry.attributes.aSize;
		if (!colAttr || !sizAttr) return;
		const nodes = graph.nodes;
		colAttr.array.set(colorArrayFor(nodes, lastScene, c));
		colAttr.needsUpdate = true;
		sizAttr.array.set(sizeArrayFor(nodes, c));
		sizAttr.needsUpdate = true;
		const sm = Number(c.nodeSize);
		nodePoints.material.uniforms.uSizeMul.value = Number.isFinite(sm) ? Math.max(0.05, sm) : 1;
	}

	/**
	 * 只改连线弯曲度：重采样所有边，不重排、不动相机。
	 * 段数恒为 6（见 fillLinkSegments），所以这里能就地重写 buffer。
	 */
	function applyCurve(v) {
		const curve = Math.max(0, Number(v) || 0);
		if (!graph || !linkLines) return;
		if (Math.abs(curve - linkCurveRef.value) < 1e-4) return;
		linkCurveRef.value = curve;
		const attr = linkLines.geometry.attributes.position;
		const need = perLinkSegs * 6;
		if (!linkTmp || linkTmp.length < need) linkTmp = new Float32Array(need);
		for (let i = 0; i < linkEnds.length; i += 1) {
			const e = linkEnds[i];
			const a = graph.nodes[e[0]];
			const b = graph.nodes[e[1]];
			if (!a || !b) continue;
			fillLinkSegments(linkTmp, 0, a, b, curve);
			const fo = linkFloatBase[i];
			for (let k = 0; k < need; k += 1) attr.array[fo + k] = linkTmp[k];
		}
		attr.needsUpdate = true;
	}

	/**
	 * 把正在进行的位移动画立即推到终点。
	 *
	 * 必须提供：`snapshotPositions` 会拿当前坐标去做下次深探的 pinned。
	 * 好在新架构里 position 从没被动过，所以这里只需要关掉 morph。
	 */
	function finishGrow() {
		grow = null;
		for (const obj of [nodePoints, linkLines]) {
			if (obj) obj.material.uniforms.uMorphOn.value = 0;
		}
	}

	/**
	 * 把整棵树从会话开始重新长一遍。
	 * 不重排布局、不动相机 —— 只是重播显形过程，方便反复看节奏。
	 */
	function replayGrow() {
		if (!graph || !nodePoints) return;
		/* 全部点参与，按层级分 */
		planGrow(graph.nodes, null, lastCfg && lastCfg.growMs);
	}

	function build(scene_, cfg, opts) {
		const c = cfg || {};
		const o = opts || {};
		for (const o2 of [nodePoints, linkLines]) disposeObj(o2);
		nodePoints = linkLines = null;
		lastScene = scene_;
		lastCfg = c;

		const built = toGraph(scene_);
		/*
		 * ★★ 关键一步：把上一帧的真实坐标回填给新节点。
		 *
		 * toGraph 每次都新建节点，坐标是 (0,0,0)（见 scene.js）。
		 * 深探 rebuild 时 warmStart 保住的其实就是这堆 0 ——
		 * 所有点挤在原点、300 tick 根本拉不开，于是 position 本身就是
		 * "一团线堆在一起"的中间态，动画播的也是这个中间态。
		 * 用户看到"一堆线堆着、然后慢慢拉开"，就是结构压根没算完。
		 *
		 * 回填之后，warmStart 从**真实旧位置**出发，300 tick 只做局部优化，
		 * 结构一次到位；动画只是把「旧位置 → 新位置」演出来，结构不会再变。
		 */
		if (o.morphFrom && o.morphFrom.size) {
			const bn = built.nodes;
			let back = 0;
			for (let k = 0; k < bn.length; k += 1) {
				const p = o.morphFrom.get(bn[k].id);
				if (p) { bn[k].x = p.x; bn[k].y = p.y; bn[k].z = p.z; back += 1; }
			}
			if (back) console.log('[memory-sea] 回填旧坐标', back + '/' + bn.length);
		}
		/*
		 * 首次进入用**分步布局**：先跑几 tick 就把图交出来，
		 * 剩下的每帧推进一点。用户点进来第一秒就能看到东西在动、在归位。
		 *
		 * 深探 / 重排都是"结构已经定好、只差藏和显"，所以不用分步。
		 */
		const stepwise = !o.pinned && !o.morphFrom && (o.ticks === undefined || o.ticks > 80);
		radius = runLayout(built, c, stepwise ? Object.assign({}, o, { stepwise: true, preTicks: 8 }) : o) || 260;
		graph = built;
		const nodes = built.nodes;
		const n = nodes.length;

		const sizeMul = Number(c.nodeSize) || 1;
		/*
		 * 点尺寸上限。
		 *
		 * ★ 原来是 h*dpr*0.12（1080p + dpr2 ≈ 240px）。
		 *   放大视角时每个点都顶到 240px，1200 个点就是 1200×240² ≈ 6900 万像素的
		 *   overdraw，屏幕才 200 万像素 —— 叠加 additive + bloom，必然掉帧。
		 *   现在压到 ~70px（面积降到 1/12），星点仍然够大，但不会再糊满屏。
		 */
		const maxPoint = Math.max(24, Math.min(70, h * dpr * 0.035));

		/* 节点 */
		const pos = new Float32Array(n * 3);
		const col = colorArrayFor(nodes, scene_, c);
		const siz = sizeArrayFor(nodes, c);
		const dim = new Float32Array(n).fill(1);
		for (let i = 0; i < n; i += 1) {
			pos[i * 3] = nodes[i].x;
			pos[i * 3 + 1] = nodes[i].y;
			pos[i * 3 + 2] = nodes[i].z;
		}

		const nodeGeo = new BufferGeometry();
		nodeGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
		nodeGeo.setAttribute('aColor', new Float32BufferAttribute(col, 3));
		nodeGeo.setAttribute('aSize', new Float32BufferAttribute(siz, 1));
		nodeGeo.setAttribute('aDim', new Float32BufferAttribute(dim, 1));
		/* 筛选开关：1 = 显示，0 = 被筛掉（shader 里丢到裁剪空间外） */
		const show = new Float32Array(n).fill(1);
		nodeGeo.setAttribute('aShow', new Float32BufferAttribute(show, 1));

		/*
		 * 位移动画的起点 + 层号。
		 * 默认 aFrom = position、aLayer = 0 → uMorphOn 关着，shader 直接用 position。
		 * 深探 / 重排时由 armMorph() 填真正的内容。
		 */
		const from = new Float32Array(pos);
		/* aLayer = -1：默认不参与位移（结构态）。深探/重排时再由 arm* 填 */
		const layerAttr = new Float32Array(n).fill(-1);
		nodeGeo.setAttribute('aFrom', new Float32BufferAttribute(from, 3));
		nodeGeo.setAttribute('aLayer', new Float32BufferAttribute(layerAttr, 1));

		const newIds = o.newIds && o.newIds.size ? o.newIds : null;

		nodePoints = new Points(nodeGeo, makeNodeMaterial(sizeMul, maxPoint));
		nodePoints.frustumCulled = false;
		scene.add(nodePoints);

		/* 连线：位置 + aHot 一次建好，之后高亮只改 aHot */
		const links = built.links;
		const curve = Math.max(0, Number(c.linkCurve) || 0);
		linkCurveRef.value = curve;
		/* 段数恒为 6：让「连线弯曲」能就地重采样，不用重建 buffer */
		perLinkSegs = 6;
		const vertsPerLink = perLinkSegs * 2;
		const buf = new Float32Array(links.length * perLinkSegs * 6);
		const hot = new Uint8Array(links.length * vertsPerLink);
		linkVertBase = [];
		linkFloatBase = [];
		linkEnds = [];
		let seg = 0;
		for (let i = 0; i < links.length; i += 1) {
			const l = links[i];
			const a = nodeAt(nodes, l.source);
			const b = nodeAt(nodes, l.target);
			if (!a || !b) continue;
			const written = fillLinkSegments(buf, seg * 6, a, b, curve);
			linkVertBase.push(seg * 2);
			linkFloatBase.push(seg * 6);
			linkEnds.push([refIndex(l.source), refIndex(l.target)]);
			seg += written;
		}
		/*
		 * 邻接表（索引域）。回溯高亮要往上找父节点、Ctrl 拖动要找整簇的子孙，
		 * 每帧线性扫 linkEnds 太浪费，建一次表。
		 */
		adjOf = new Map();
		for (let i = 0; i < linkEnds.length; i += 1) {
			const e = linkEnds[i];
			let a = adjOf.get(e[0]);
			if (!a) { a = []; adjOf.set(e[0], a); }
			a.push(e[1]);
			let b = adjOf.get(e[1]);
			if (!b) { b = []; adjOf.set(e[1], b); }
			b.push(e[0]);
		}

		const linkGeo = new BufferGeometry();
		linkGeo.setAttribute('position', new Float32BufferAttribute(buf.subarray(0, seg * 6), 3));
		linkGeo.setAttribute('aHot', new Float32BufferAttribute(hot.subarray(0, seg * 2), 1));
		linkGeo.setAttribute('aShow', new Float32BufferAttribute(new Float32Array(seg * 2).fill(1), 1));
		/* 线的位移起点 + 层号，默认 = position / 0，由 armMorph 填 */
		linkGeo.setAttribute('aFrom', new Float32BufferAttribute(buf.slice(0, seg * 6), 3));
		linkGeo.setAttribute('aLayer', new Float32BufferAttribute(new Float32Array(seg * 2).fill(-1), 1));
		const lo = Number(c.linkOpacity);
		linkLines = new LineSegments(linkGeo, new ShaderMaterial({
			uniforms: {
				uBaseColor: { value: new Color(0.60, 0.70, 0.88) },
				uHotColor: { value: new Color(0.92, 0.96, 1.0) },
				uBaseAlpha: { value: Number.isFinite(lo) ? Math.max(0, lo) : 0.14 },
				uHotAlpha: { value: 0.85 },
				uRevealActive: { value: 0 },
				uRevealProgress: { value: 1 },
				uRevealMaxRadius: { value: 1 },
				...MORPH_UNIFORMS()
			},
			vertexShader: LINE_VERTEX,
			fragmentShader: LINE_FRAGMENT,
			transparent: true,
			depthWrite: false
		}));
		linkLines.frustumCulled = false;
		scene.add(linkLines);

		applyVisual(c);

		/*
		 * 三种位移动画，来源不同、语义不同：
		 *
		 *   · 首次打开 → **从中心散开**（bigBang）：
		 *     所有点的 aFrom = 原点，一起向外散到各自位置。
		 *     之前用的是 planGrow（每个点从父节点长出来），结果是 40 个星团
		 *     各自原地炸开、中间空一片 —— 不是"从中心散到预设"。
		 *
		 *   · 深探 → 只有**新增的**消息从各自轮次伸出来（planGrow）。
		 *     已存在的轮次点不再播一次 —— 它本来就在那儿。
		 *
		 *   · 重排 → 所有点从旧坐标滑到新坐标（armMorphFrom）。
		 *
		 * position 永远是正确结构，动画只在 shader 里 mix(aFrom, position)。
		 */
		if (o.noGrow) {
			/* 收起：什么都不播 */
			if (o.morphFrom && o.morphFrom.size) armMorphFrom(nodes, o.morphFrom, 280);
		} else if (newIds) {
			/* 深探：新枝从父节点长出，老节点从旧坐标滑到重排后的新家 */
			planGrow(nodes, newIds, o.growMs !== undefined ? o.growMs : c.growMs, o.morphFrom);
		} else if (o.morphFrom && o.morphFrom.size) {
			armMorphFrom(nodes, o.morphFrom, 280);
		} else {
			/* 入场别用 5 秒 —— 那是分辨率不出来的慢；2.2 秒刚好看清"从一点散开" */
			bigBang(Math.min(2200, Number(c.growMs) || 2200));
		}

		/* keepCamera：重排 / 深探都不能动镜头，否则用户转过的视角会被拉回去 */
		if (!o.keepCamera && !o.morphFrom) setCameraElev(radius, c.frameElevDeg, false);
		selectedIndex = -1;
		hoverIndex = -1;
		draggingIndex = -1;
		setFocus(-1);
		return radius;
	}

	function applyVisual(cfg) {
		const c = cfg || {};

		/*
		 * 画布底色走 WebGL 清屏色，不走面板的 CSS 背景。
		 * 因为画布是 fixed、铺到了面板之外（窗口顶部），面板背景盖不住它，
		 * 底色 + 透明度必须由画布自己带。
		 */
		{
			const hex = /^#?([0-9a-fA-F]{6})$/.exec(String(c.bgColor || ''));
			const col = hex ? parseInt(hex[1], 16) : 0x05060b;
			const a = Number(c.bgAlpha);
			const alpha = Number.isFinite(a) ? Math.max(0, Math.min(100, a)) / 100 : 1;
			renderer.setClearColor(col, alpha);
		}

		const tier = c.perfTier || 'auto';
		const nextSsaa = Math.max(1, Math.min(2, Number(c.ssaa) || 1));
		if (tier !== perfTier || nextSsaa !== ssaa) {
			perfTier = tier;
			ssaa = nextSsaa;
			resize();
		}

		/* 悬停高亮：自身 + 向下整棵子树；再沿父链向上数这么多「节」。
		   3 节 = 消息 → 轮次 → 会话，一眼看清"这条属于哪儿" */
		const fl = Math.round(Number(c.focusDepth));
		focusDepth = Number.isFinite(fl) ? Math.max(1, Math.min(12, fl)) : 3;

		/* 标签：开关 / 数量上限 / 截断长度 / 给哪几类画 / 写名称还是内容 */
		const wantLabels = c.labels === true;
		const lm = Math.round(Number(c.labelMax));
		labelMax = Number.isFinite(lm) ? Math.max(4, Math.min(10000, lm)) : 40;
		const lc2 = Math.round(Number(c.labelChars));
		labelChars = Number.isFinite(lc2) ? Math.max(4, Math.min(100, lc2)) : 20;
		labelOn.session = c.labelOnSession !== false;
		labelOn.turn = c.labelOnTurn !== false;
		labelOn.record = c.labelOnRecord === true;
		labelField = c.labelField === 'name' ? 'name' : 'content';
		labelOverlap = c.labelOverlap === true;
		if (wantLabels !== labelsOn) {
			labelsOn = wantLabels;
			if (!wantLabels && labelCtx) {
				labelCtx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
			}
		}

		/* 筛选：按类型藏点，就地改 aShow */
		applyFilter(c);

		/* 整簇拖动的弹簧：刚度 / 阻尼 */
		const cs = Number(c.dragStiffness);
		clusterStiffness = Number.isFinite(cs) ? Math.max(0.02, Math.min(0.6, cs)) : 0.22;
		const cdmp = Number(c.dragDamping);
		clusterDamping = Number.isFinite(cdmp) ? Math.max(0.55, Math.min(0.985, cdmp)) : 0.82;
		if (clusterDrag) {
			clusterDrag.stiffness = clusterStiffness;
			clusterDrag.damping = clusterDamping;
		}

		/*
		 * 观赏模式：**只禁用拾取**，鼠标映射保持默认。
		 *
		 * 之前这里把左键改成平移、右键改成旋转 —— 反了。
		 * 观赏模式是"不碰星点"，不是换操作习惯：
		 *   左键拖 = 旋转，右键拖 = 平移，滚轮 = 缩放，和平时完全一样。
		 */
		const ro = c.readOnly === true;
		if (ro !== readOnly) {
			readOnly = ro;
			if (ro) {
				hoverIndex = -1;
				selectedIndex = -1;
				setFocus(-1);
				if (typeof cb.onAnchor === 'function') cb.onAnchor(0, 0, false);
			}
		}

		const bs = Number(c.bloomStrength);
		bloom.strength = Number.isFinite(bs) ? Math.max(0, bs) : 0.35;
		bloom.radius = Math.max(0, Number(c.bloomRadius === undefined ? 0.35 : c.bloomRadius));
		bloom.threshold = Math.max(0, Number(c.bloomThreshold === undefined ? 0.22 : c.bloomThreshold));
		bloom.enabled = c.bloom !== false && bloom.strength > 0.001;

		if (nodePoints) {
			const sm = Number(c.nodeSize);
			nodePoints.material.uniforms.uSizeMul.value = Number.isFinite(sm) ? Math.max(0.05, sm) : 1;
		}

		const tw = Math.max(0, Number(c.twinkle) || 0);
		for (const p of [starFar, starNear]) p.material.uniforms.uTwinkle.value = tw;

		if (linkLines) {
			const lo = Number(c.linkOpacity);
			linkLines.material.uniforms.uBaseAlpha.value = Number.isFinite(lo) ? Math.max(0, lo) : 0.14;
		}

		const field = Math.max(0, Number(c.fieldStars) || 0);
		starFar.visible = c.starfield !== false;
		starFar.material.uniforms.uAlpha.value = 0.4 * (c.starfield === false ? 0 : (field > 0 ? field : 0.5));
		starNear.visible = c.starfield !== false && field > 0.001;
		starNear.material.uniforms.uAlpha.value = 0.55 * field;

		const neb = Math.max(0, Number(c.nebula) || 0);
		const clouds = Math.max(0, Number(c.clusterClouds) || 0);
		const nebTotal = neb * 0.55 + clouds * 0.18;
		nebula.visible = nebTotal > 0.001;
		nebula.material.uniforms.uStrength.value = nebTotal;
	}

	/**
	 * 调仰角。
	 *
	 * ★ 只改仰角，**绝不动 target、不动方位角**。
	 *
	 * 老实现是 `camera.position.set(p)` + `controls.target.set(0,0,0)`：
	 * 于是每次切预设（每个预设都带自己的 frameElevDeg）都把镜头拉回默认机位、
	 * 把注视点拽回原点 —— 用户转过、放大过、正盯着看的目标全丢。
	 *
	 * keepZoom=false 时顺便把距离收到推荐取景距离（首次进入 / 点复位用）。
	 */
	function setCameraElev(r, elevDeg, keepZoom) {
		const elev = (Math.max(0, Math.min(90, Number(elevDeg) || 0)) * Math.PI) / 180;
		const cur = new Vector3().subVectors(camera.position, controls.target);
		const curDist = cur.length();
		const d = keepZoom && curDist > 1
			? curDist
			: Math.max(70, fitDistance(r));
		/* 方位角：从 target 指向相机的水面投影方向，原样保留 */
		const az = curDist > 1e-3 && (Math.abs(cur.x) > 1e-6 || Math.abs(cur.z) > 1e-6)
			? Math.atan2(cur.z, cur.x)
			: Math.PI * 0.5;
		const horiz = Math.cos(elev) * d;
		camera.position.set(
			controls.target.x + Math.cos(az) * horiz,
			controls.target.y + Math.sin(elev) * d,
			controls.target.z + Math.sin(az) * horiz
		);
		controls.update();
	}

	/* ── 聚焦：悬浮/选中时高亮 ──
	 *
	 * 三层，缺一层都会"看不懂"：
	 *   自身 + **向下整棵子树**（"它包含什么"）
	 *        + **沿父链向上 focusDepth 节**（"它属于哪儿"）
	 *   兄弟不亮（那会把链的形状糊掉）。
	 *
	 * ★ 2026-11-01：曾经为了"只亮一节链"，把向下也删了 ——
	 *   结果悬浮根节点什么都不亮。删功能比加功能更需要先说。
	 */
	/**
	 * 找 from 的「父节点」—— 层级比自己低的那个邻居。
	 *
	 * ★ visit 只用来防回头路，**不能**用 isHot。
	 *   之前传的是 isHot：直接邻居在第一轮就已经置 1 了，
	 *   于是第一次回溯就被自己的过滤条件挡掉、`best` 一直是 -1、立刻 break ——
	 *   所以段数拉到 12 也只亮一跳。用户报的就是这个。
	 */
	function lowerNeighborOf(from, visit) {
		const nb = adjOf.get(from);
		if (!nb || !nb.length) return -1;
		const mine = layerKeyOf(graph.nodes[from].point);
		let best = -1;
		let bestKey = mine;
		for (let k = 0; k < nb.length; k += 1) {
			const j = nb[k];
			if (j < 0 || j >= graph.nodes.length) continue;
			if (visit.has(j)) continue;
			const kj = layerKeyOf(graph.nodes[j].point);
			if (kj < bestKey) { bestKey = kj; best = j; }
		}
		return best;
	}

	/** 把一条边标热（按端点查） */
	function markEdgeHot(hotEdge, u, v) {
		for (let i = 0; i < linkEnds.length; i += 1) {
			const e = linkEnds[i];
			if ((e[0] === u && e[1] === v) || (e[0] === v && e[1] === u)) hotEdge[i] = 1;
		}
	}

	function setFocus(idx) {
		if (!graph || !nodePoints) return;
		const n = graph.nodes.length;
		const isHot = new Uint8Array(n);
		const hotEdge = new Uint8Array(linkEnds.length);

		if (idx >= 0 && idx < n) {
			isHot[idx] = 1;

			/*
			 * ① 向下：这颗星**包含的全部子孙**。
			 *
			 * 悬浮一个会话，你想知道的是"它下面有哪些轮次、聊了些什么"——
			 * 不高亮就等于什么都没说。所以子树全亮，不设深度限制。
			 * 只往更深的层级走，不会顺带把兄弟也点亮。
			 */
			const down = [idx];
			while (down.length) {
				const u = down.pop();
				const nb = adjOf.get(u);
				if (!nb) continue;
				const lu = layerKeyOf(graph.nodes[u].point);
				for (let k = 0; k < nb.length; k += 1) {
					const v = nb[k];
					if (v < 0 || v >= n || isHot[v]) continue;
					if (layerKeyOf(graph.nodes[v].point) <= lu) continue;
					isHot[v] = 1;
					markEdgeHot(hotEdge, u, v);
					down.push(v);
				}
			}

			/*
			 * ② 向上：沿父链数「节」。
			 * 一节 = 两个点之间的一条边，focusDepth = N 就是 N 节（N+1 个点），
			 * 一路数到根为止。兄弟不亮 —— 兄弟亮起来会把链的形状糊掉。
			 */
			const visit = new Set();
			let cur = idx;
			let counted = 0;
			while (counted < focusDepth) {
				visit.add(cur);
				const up = lowerNeighborOf(cur, visit);
				if (up < 0) break;
				isHot[up] = 1;
				markEdgeHot(hotEdge, cur, up);
				cur = up;
				counted += 1;
			}
		}

		const dimAttr = nodePoints.geometry.attributes.aDim;
		if (dimAttr) {
			for (let i = 0; i < n; i += 1) {
				dimAttr.array[i] = idx < 0 ? 1 : (isHot[i] ? 1 : 0.12);
			}
			dimAttr.needsUpdate = true;
		}

		const hotAttr = linkLines && linkLines.geometry.attributes.aHot;
		if (hotAttr) {
			const vpl = perLinkSegs * 2;
			for (let i = 0; i < linkEnds.length; i += 1) {
				const on = hotEdge[i];
				const base = linkVertBase[i];
				for (let v = 0; v < vpl; v += 1) hotAttr.array[base + v] = on;
			}
			hotAttr.needsUpdate = true;
		}
	}

	/* ── 开场动画 ── */
	function replayReveal() {
		reveal.active = 1;
		reveal.progress = 0;
		reveal.maxRadius = Math.max(1, radius);
		reveal.t0 = performance.now();
		applyRevealUniforms();
	}
	function applyRevealUniforms() {
		for (const obj of [nodePoints, linkLines]) {
			if (!obj) continue;
			const u = obj.material.uniforms;
			u.uRevealActive.value = reveal.active;
			u.uRevealProgress.value = reveal.progress;
			u.uRevealMaxRadius.value = reveal.maxRadius;
		}
	}

	/**
	 * 把 graph.nodes 的当前坐标写回顶点缓冲，并重算所有边。
	 * 分步布局每帧调一次 —— 点会一边散开一边往该去的地方挪。
	 */
	function syncPositionsFromNodes() {
		if (!graph || !nodePoints) return;
		const posAttr = nodePoints.geometry.attributes.position;
		const nodes = graph.nodes;
		for (let i = 0; i < nodes.length; i += 1) {
			posAttr.setXYZ(i, nodes[i].x, nodes[i].y, nodes[i].z);
		}
		posAttr.needsUpdate = true;
		refreshLinksBy(() => true);
	}

	/**
	 * 每帧推进一点布局；返回 true 表示还在算。
	 *
	 * ★ 连线 buffer 有 6000 条边 × 12 顶点 × 3 float ≈ 864KB，
	 *   每帧重算并重传一次，光上传就够把帧率拉下来。
	 *   所以这里**隔帧刷边**：点每帧都更新（便宜，48KB），
	 *   线每两帧一次。肉眼看不出滞后，开销直接减半。
	 */
	let linkSyncTick = 0;

	function stepLiveLayout() {
		if (!graph || !graph.__sim || !graph.__pendingTicks) return false;
		const budget = 26;
		const k = Math.min(budget, graph.__pendingTicks);
		for (let i = 0; i < k; i += 1) graph.__sim.tick();
		graph.__pendingTicks -= k;

		/* 点：每帧都写，便宜 */
		const posAttr = nodePoints.geometry.attributes.position;
		const nodes = graph.nodes;
		for (let i = 0; i < nodes.length; i += 1) {
			posAttr.setXYZ(i, nodes[i].x, nodes[i].y, nodes[i].z);
		}
		posAttr.needsUpdate = true;

		/* 线：隔帧刷，省一半上传 */
		linkSyncTick += 1;
		const last = graph.__pendingTicks <= 0;
		if (last || (linkSyncTick & 1) === 0) refreshLinksBy(() => true);

		if (last) {
			graph.__sim = null;
			/* 收敛后重算一次半径，相机取景才准 */
			let maxR = 0;
			for (let i = 0; i < nodes.length; i += 1) {
				const r = Math.hypot(nodes[i].x, nodes[i].y, nodes[i].z);
				if (r > maxR) maxR = r;
			}
			if (maxR > 1) radius = maxR;
		}
		return true;
	}

	/* ── 筛选 ──
	 *
	 * 按**类型**把点藏起来：用户 / 她 / 工具调用 / 摘要。
	 * 纯渲染层操作，就地改 aShow，不重建几何、不动布局 ——
	 * 所以勾选框一点就生效，不需要刷新。
	 *
	 * 边跟着端点走：任一端被筛掉，这条边也一起消失（否则会剩一堆悬空的线）。
	 */
	function applyFilter(c) {
		if (!graph || !nodePoints) return;
		const showAttr = nodePoints.geometry.attributes.aShow;
		if (!showAttr) return;
		const n = graph.nodes.length;
		const on = {
			user: c.showUser !== false,
			assistant: c.showAssistant !== false,
			tool: c.showTool !== false,
			compaction: c.showCompaction !== false
		};
		/*
		 * 结构层级：
		 *   · showTurn 关掉 → 轮次**连同它的消息**一起藏，只留会话星（概览视图）
		 *   · hiddenSessions 里列出的会话 → 整棵树藏掉
		 *     （会话是根，所以用"选择"而不是开关；关一个开关等于全关，没意义）
		 */
		const showTurn = c.showTurn !== false;
		const hidden = new Set(Array.isArray(c.hiddenSessions) ? c.hiddenSessions : []);
		const show = showAttr.array;
		for (let i = 0; i < n; i += 1) {
			const p = graph.nodes[i].point;
			if (!p) { show[i] = 1; continue; }
			if (p.sessionId && hidden.has(p.sessionId)) { show[i] = 0; continue; }
			if (!showTurn && (p.kind === 'turn' || p.kind === 'record')) { show[i] = 0; continue; }
			if (p.kind === 'record' && p.recordKind && on[p.recordKind] === false) { show[i] = 0; continue; }
			show[i] = 1;
		}
		showAttr.needsUpdate = true;

		/* 边：两端都显示才显示 */
		if (linkLines) {
			const ls = linkLines.geometry.attributes.aShow;
			if (ls) {
				const vpl = perLinkSegs * 2;
				for (let i = 0; i < linkEnds.length; i += 1) {
					const e = linkEnds[i];
					const v = (show[e[0]] > 0.5 && show[e[1]] > 0.5) ? 1 : 0;
					const base = linkVertBase[i];
					for (let k = 0; k < vpl; k += 1) ls.array[base + k] = v;
				}
				ls.needsUpdate = true;
			}
		}
	}

	/* ── 标签层 ──
	 *
	 * 3D 里直接画文字（sprite / canvas texture）在几千个点上扛不住，
	 * 所以单独叠一张 2D canvas，每帧只画几十条。
	 *
	 * 关键是**筛选**，否则画面会被文字淹掉：
	 *   · 只给会话和轮次画（消息太多、也没必要）
	 *   · 消息只在它被悬停/选中时画
	 *   · 总数封顶 labelMax
	 *   · 已经放了标签的区域不再放（矩形避让）
	 *   · 文字超长截断到 labelChars
	 */
	let labelsOn = false;
	let labelMax = 40;
	let labelChars = 14;
	let labelTick = 0;
	/* 允许标签互相重叠：缩小时不丢失（挤一点，但都在） */
	let labelOverlap = false;
	/* 标签给哪几类画 */
	const labelOn = { session: true, turn: true, record: false };
	/* 标签写什么：'name' = 名称/角色，'content' = 正文摘要 */
	let labelField = 'content';

	function labelTextOf(p) {
		if (!p) return '';
		const cut = (s) => {
			const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
			return t.length > labelChars ? t.slice(0, labelChars) + '…' : t;
		};
		const role = { user: '你', assistant: '她', tool: '工具', compaction: '摘要' }[p.recordKind] || '消息';

		/*
		 * 名称 = 短标识；内容 = 正文。
		 *
		 * ★ 之前 content 分支写的是 `cut(p.text || p.title)`，但会话和轮次的
		 *   point 上**没有 text 字段**，于是退回 title —— 和名称一模一样，
		 *   用户切换两个按钮当然看不出任何区别。
		 *   现在会话读 digest（该会话第一轮的开头），轮次读 subtitle（首条消息），
		 *   消息读 preview，三个层级都有真的内容。
		 */
		if (labelField === 'name') {
			if (p.kind === 'session') return cut(p.title || '会话');
			if (p.kind === 'turn') return cut(p.title || '一轮');
			if (p.kind === 'record') return cut(p.toolName ? role + '·' + p.toolName : role);
			return cut(p.title || '');
		}
		if (p.kind === 'session') return cut(p.digest || p.subtitle || p.title || '');
		if (p.kind === 'turn') return cut(p.subtitle || p.title || '');
		if (p.kind === 'record') {
			const body = p.preview || p.text || '';
			return body ? cut(role + ' ' + body) : cut(role + ' ' + (p.len || 0) + '字');
		}
		return cut(p.subtitle || p.title || '');
	}

	const labelBoxes = [];

	function drawLabels() {
		if (!labelCtx) return;
		const cw = labelCanvas.width;
		const ch = labelCanvas.height;
		labelCtx.clearRect(0, 0, cw, ch);
		if (!labelsOn || !graph || !nodePoints || cw < 2 || ch < 2) return;

		const n = graph.nodes.length;
		const dimAttr = nodePoints.geometry.attributes.aDim;
		const dimArr = dimAttr ? dimAttr.array : null;
		const focal = hoverIndex >= 0 ? hoverIndex : selectedIndex;

		const cands = [];
		const showArr = nodePoints.geometry.attributes.aShow;
		/*
		 * 消息标签：不再"只有悬停才出"。
		 *
		 * 之前 focal < 0 时一条 record 都不给，于是用户勾上「消息」发现
		 * 什么都没有 —— 逻辑没错，但体验是"这个开关是坏的"。
		 *
		 * 现在：有焦点时只给高亮那一群（保持"看谁标谁"的干净），
		 * 没焦点时**抽样**给全体的候选（上限 2000，避免两万次投影），
		 * 最终能画多少由避让和 labelMax 决定。
		 */
		const MAX_RECORD_CANDS = 2000;
		let recTotal = 0;
		for (let i = 0; i < n; i += 1) {
			const p = graph.nodes[i].point;
			if (p && p.kind === 'record' && (!showArr || showArr.array[i] > 0.5)) recTotal += 1;
		}
		const recStep = Math.max(1, Math.ceil(recTotal / MAX_RECORD_CANDS));
		let recSeen = 0;

		for (let i = 0; i < n; i += 1) {
			const p = graph.nodes[i].point;
			if (!p) continue;
			/* 被筛掉的点不出标签 */
			if (showArr && showArr.array[i] < 0.5) continue;
			if (p.kind === 'session') { if (labelOn.session) cands.push({ i, pri: 0 }); }
			else if (p.kind === 'turn') { if (labelOn.turn) cands.push({ i, pri: 1 }); }
			else if (p.kind === 'record' && labelOn.record) {
				const hot = focal >= 0 && dimArr && dimArr[i] > 0.5;
				if (hot) cands.push({ i, pri: 2 });
				else {
					if (recSeen % recStep === 0) cands.push({ i, pri: 2 });
					recSeen += 1;
				}
			}
		}
		if (!cands.length) return;

		const drawn = [];
		for (let k = 0; k < cands.length; k += 1) {
			const c = cands[k];
			visualPos(c.i, _pv);
			_proj.copy(_pv).project(camera);
			if (_proj.z < -1 || _proj.z > 1) continue;
			const sx = (_proj.x * 0.5 + 0.5) * cw;
			const sy = (-_proj.y * 0.5 + 0.5) * ch;
			if (sx < -60 || sy < -20 || sx > cw + 60 || sy > ch + 20) continue;
			c.sx = sx;
			c.sy = sy;
			drawn.push(c);
		}
		drawn.sort((a, b) => (a.pri - b.pri) || (a.sy - b.sy));

		labelCtx.textBaseline = 'middle';
		labelCtx.font = Math.round(11 * dpr) + 'px -apple-system, "Segoe UI", system-ui, sans-serif';
		labelBoxes.length = 0;

		let placed = 0;
		for (let k = 0; k < drawn.length && placed < labelMax; k += 1) {
			const c = drawn[k];
			const txt = labelTextOf(graph.nodes[c.i].point);
			if (!txt) continue;
			const tw = labelCtx.measureText(txt).width;
			const bw = tw + 10 * dpr;
			const bh = 15 * dpr;
			const bx = c.sx + 7 * dpr;
			const by = c.sy - bh / 2;

			/*
			 * 避让：已经放下的矩形占住位置，重叠的不画。
			 * 「允许重叠」模式跳过这一步 —— 视图缩小时大量标签会挤在同一片区域，
			 * 避让会把它们几乎全丢掉，于是"缩得越小，标签越少"。
			 * 开了之后就都画出来，挤一点、但至少看得到。
			 */
			if (!labelOverlap) {
				let hit = false;
				for (let m = 0; m < labelBoxes.length; m += 1) {
					const b = labelBoxes[m];
					if (bx < b.x + b.w && bx + bw > b.x && by < b.y + b.h && by + bh > b.y) { hit = true; break; }
				}
				if (hit) continue;
				labelBoxes.push({ x: bx, y: by, w: bw, h: bh });
			}

			const alpha = c.pri === 0 ? 0.55 : 0.38;
			labelCtx.fillStyle = 'rgba(6,10,22,' + alpha + ')';
			labelCtx.beginPath();
			const r = bh / 2;
			labelCtx.moveTo(bx + r, by);
			labelCtx.lineTo(bx + bw - r, by);
			labelCtx.arc(bx + bw - r, by + r, r, -Math.PI / 2, Math.PI / 2);
			labelCtx.lineTo(bx + r, by + bh);
			labelCtx.arc(bx + r, by + r, r, Math.PI / 2, -Math.PI / 2);
			labelCtx.closePath();
			labelCtx.fill();

			labelCtx.fillStyle = c.pri === 0 ? 'rgba(235,242,255,0.95)' : 'rgba(210,222,245,0.85)';
			labelCtx.fillText(txt, bx + 5 * dpr, c.sy);
			placed += 1;
		}
	}

	/* ── 拾取 ──
	 *
	 * ★ 这里有个很隐蔽的病灶：位移在 GPU 上做（mix(aFrom, position, morphT)），
	 *   而 Raycaster 只认 CPU 上的 position。
	 *   ⇒ 动画没播完时，点画在 A 处、检测在 B 处，**根本点不中**；
	 *     转动一下视图位置变了又"碰巧"能点中。
	 *   用户报的"拖远了点不中""越来越严重""转一下视图才能捕获"全是它。
	 *
	 * 所以改成自己遍历：
	 *   ① 投影到**屏幕像素**取最近的一颗 —— 和相机距离无关，远近一样好点
	 *   ② 投影前先按当前 morph 进度算出"真正画在屏幕上的坐标"
	 */
	const PICK_RADIUS_PX = 16;
	const raycaster = new Raycaster();          /* 只留给拖动平面求交用 */
	const ndc = new Vector2();
	const _proj = new Vector3();
	const _pv = new Vector3();

	/** 和 shader 里的 morphT() 完全一致：层号 → 当前进度 → 缓动值 */
	function morphAt(layer, on, t, count, span) {
		if (!on) return 1;
		if (layer < -0.5) return 1;
		const n = Math.max(1, count);
		const start = n > 1.5 ? (layer * (1 - span)) / (n - 1) : 0;
		const k = Math.max(0, Math.min(1, (t - start) / Math.max(span, 0.0001)));
		return k * k * (3 - 2 * k);
	}

	/** 某个节点**这一帧真正画在哪**（世界坐标），写进 out */
	function visualPos(i, out) {
		const geo = nodePoints.geometry;
		const posA = geo.attributes.position.array;
		const fromA = geo.attributes.aFrom.array;
		const layerA = geo.attributes.aLayer.array;
		const u = nodePoints.material.uniforms;
		const on = u.uMorphOn.value >= 0.5;
		const m = on ? morphAt(layerA[i], on, u.uMorphT.value, u.uLayerCount.value, u.uLayerSpan.value) : 1;
		const i3 = i * 3;
		out.set(
			fromA[i3] + (posA[i3] - fromA[i3]) * m,
			fromA[i3 + 1] + (posA[i3 + 1] - fromA[i3 + 1]) * m,
			fromA[i3 + 2] + (posA[i3 + 2] - fromA[i3 + 2]) * m
		);
		return out;
	}

	function pickAt(clientX, clientY) {
		if (readOnly) return -1;   /* 观赏模式：不响应任何拾取 */
		if (!graph || !nodePoints) return -1;
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return -1;

		const mx = clientX - rect.left;
		const my = clientY - rect.top;
		const n = graph.nodes.length;
		let best = -1;
		let bestD2 = PICK_RADIUS_PX * PICK_RADIUS_PX;

		/*
		 * 被过滤掉的点不可拾取。
		 * aShow = 0 的点在 shader 里已经被丢到裁剪空间外，屏幕上看不见，
		 * 但 CPU 这边照样算得出它的投影坐标 —— 不跳过的话就会出现
		 * "看不见的星星还能点中、还能弹出详情卡"。
		 */
		const showArr = nodePoints.geometry.attributes.aShow;

		for (let i = 0; i < n; i += 1) {
			if (showArr && showArr.array[i] < 0.5) continue;
			visualPos(i, _pv);
			_proj.copy(_pv).project(camera);
			if (_proj.z < -1 || _proj.z > 1) continue;   /* 视锥外 */
			const sx = (_proj.x * 0.5 + 0.5) * rect.width;
			const sy = (-_proj.y * 0.5 + 0.5) * rect.height;
			const dx = sx - mx;
			const dy = sy - my;
			const d2 = dx * dx + dy * dy;
			if (d2 < bestD2) { bestD2 = d2; best = i; }
		}
		return best;
	}
	function pointOf(idx) {
		if (!graph || idx < 0 || idx >= graph.nodes.length) return null;
		return graph.nodes[idx].point;
	}
	function projectScreen(idx) {
		if (!graph || idx < 0 || idx >= graph.nodes.length) return null;
		const n = graph.nodes[idx];
		_proj.set(n.x, n.y, n.z).project(camera);
		const sx = (_proj.x * 0.5 + 0.5) * w;
		const sy = (-_proj.y * 0.5 + 0.5) * h;
		const inFront = _proj.z > -1 && _proj.z < 1;
		return {
			x: sx, y: sy,
			visible: inFront && sx > -20 && sy > -20 && sx < w + 20 && sy < h + 20
		};
	}

	/* ── 拖动 ── */
	const dragPlane = new Plane();
	const _hit = new Vector3();
	/* 曲线参数：build 时写入，refreshLinksOf 每帧重采样用 */
	const linkCurveRef = { value: 0 };
	/* 拖动时复用的临时缓冲，避免每帧分配 */
	let linkTmp = null;

	/** 重算满足 match(a,b) 的那些边；曲线模式下整条重采样 */
	function refreshLinksBy(match) {
		if (!graph || !linkLines) return;
		const attr = linkLines.geometry.attributes.position;
		const need = perLinkSegs * 6;
		if (!linkTmp || linkTmp.length < need) linkTmp = new Float32Array(need);
		let touched = false;
		for (let i = 0; i < linkEnds.length; i += 1) {
			const e = linkEnds[i];
			if (!match(e[0], e[1])) continue;
			const a = graph.nodes[e[0]];
			const b = graph.nodes[e[1]];
			if (!a || !b) continue;
			fillLinkSegments(linkTmp, 0, a, b, linkCurveRef.value);
			const fo = linkFloatBase[i];
			for (let k = 0; k < need; k += 1) attr.array[fo + k] = linkTmp[k];
			touched = true;
		}
		if (touched) attr.needsUpdate = true;
	}

	/** 拖动一颗星：只动它自己连着的那几条边 */
	function refreshLinksOf(idx) {
		refreshLinksBy((a, b) => a === idx || b === idx);
	}

	/* ── 分层生长的排期 ──
	 *
	 * 谁参与生长：
	 *   全量构建 → 所有点（先会话、后轮次，树一层层长出来）
	 *   深探     → 只有 newIds 里的点（新的枝继续长，别的星原地不动）
	 *
	 * 从哪儿冒出来：找**层级比自己小**的邻居，取它的位置当出生点 ——
	 * 也就是"芽从树干上那个分叉处长出来"。找不到更上层邻居（会话本身）
	 * 就原地亮起，因为它是这棵树的根。
	 *
	 * 层号会压缩：深探只新增消息时 keys=[3] → 只有第 0 层，
	 * 不会傻等两种空层。深探时消息的父轮次若也参与，就是 [2,3] → 两层。
	 */
	/**
	 * 分层生长：newIds 里的点从父节点抽出去，其余点保持不动。
	 *
	 * ★ 第四个参数 morphFrom：**老节点的旧坐标**。
	 *   深探现在会在整图上重跑一遍力导向（布局质量才和刷新后一致），
	 *   老节点也会被挪位置。给它们填上旧坐标当起点，
	 *   于是"老节点滑到新家"和"新节点从父节点长出来"在同一段动画里完成。
	 */
	function planGrow(nodes, newIds, totalMs, morphFrom) {
		const n = nodes.length;
		if (!n || !nodePoints) return null;

		const active = new Uint8Array(n);
		let count = 0;
		for (let i = 0; i < n; i += 1) {
			if (newIds && !newIds.has(nodes[i].id)) continue;
			active[i] = 1;
			count += 1;
		}
		if (!count) return null;

		/* 全图邻接（索引域），用来找出生点 */
		const adj = new Map();
		const add = (u, v) => {
			let a = adj.get(u);
			if (!a) { a = []; adj.set(u, a); }
			a.push(v);
		};
		for (let i = 0; i < linkEnds.length; i += 1) {
			const e = linkEnds[i];
			add(e[0], e[1]);
			add(e[1], e[0]);
		}

		const anchorOf = (i) => {
			const nb = adj.get(i);
			if (!nb || !nb.length) return -1;
			const mine = layerKeyOf(nodes[i].point);
			let best = -1;
			let bestKey = mine;
			for (let k = 0; k < nb.length; k += 1) {
				const j = nb[k];
				const kj = layerKeyOf(nodes[j].point);
				if (kj < bestKey) { bestKey = kj; best = j; }
			}
			return best;
		};

		/* 真正出现的层号，排序后压缩 */
		const seenKeys = [];
		for (let i = 0; i < n; i += 1) if (active[i]) seenKeys.push(layerKeyOf(nodes[i].point));
		seenKeys.sort((a, b) => a - b);
		const order = [];
		for (const k of seenKeys) if (order[order.length - 1] !== k) order.push(k);
		/*
		 * ★ 第 0 层专给**老节点**（从旧位置滑到重排后的新家），
		 *   新节点从第 1 层起 —— 于是时序是：
		 *     先：整张图滑到重算后的位置（结构归位，看得见它在动）
		 *     后：新消息一层层从轮次抽出去
		 *   而不是两件事一起糊在 2.6 秒里。
		 */
		/*
		 * ★ 老节点不参与，所以**不留第 0 层占位**。
		 *   之前留了 0 号位再让老节点 -1，等于白给 45% 的空档，
		 *   新节点要等到 55% 才亮 —— 用户会觉得"卡了半天才出来"。
		 *   现在层号从 0 开始，新节点在整段时间里均匀亮起。
		 */
		const layerOfKey = new Map(order.map((k, idx) => [k, idx]));
		/*
		 * 深探新增的往往全是一个层级（record），只有一层的话就没有"先后"可言，
		 * 一坨同时亮起来。所以同层内按**点的顺序**（= 时间顺序）再切 3 批，
		 * 看起来就是一束一束长出来。
		 */
		const SUB_BATCH = 3;
		const layers = [];
		for (let k = 0; k < order.length * SUB_BATCH; k += 1) layers.push([]);
		const posAttr = nodePoints.geometry.attributes.position;
		const fromAttr = nodePoints.geometry.attributes.aFrom;
		const layerAttr = nodePoints.geometry.attributes.aLayer;
		if (!posAttr || !fromAttr || !layerAttr) return null;

		/*
		 * ★★ 深探的动画是**纯显隐**，不是位移。
		 *
		 * 之前把 aFrom 设成"父节点往回 20%"，于是新点在动画里一路从轮次
		 * 挪到目标位置 —— 结构明明已经算好了，屏幕上却还在动，
		 * 用户因此截到了"进行一半"的中间态（一堆放射状的散线）。
		 *
		 * 现在 aFrom 直接等于 position：**位置一次到位、永不移动**，
		 * 新节点只靠（尺寸 × 透明度）按层渐显。
		 * 老节点同理（整图重算只是微调，不需要演出来）。
		 */
		let seen = 0;
		for (let i = 0; i < n; i += 1) {
			if (!active[i]) continue;
			const fx = posAttr.getX(i);
			const fy = posAttr.getY(i);
			const fz = posAttr.getZ(i);
			const base = layerOfKey.get(layerKeyOf(nodes[i].point)) || 0;
			/* 同层内按出现顺序切成 SUB_BATCH 批，制造"一束一束"的节奏 */
			const sub = Math.min(SUB_BATCH - 1, Math.floor((seen / count) * SUB_BATCH));
			const L = base * SUB_BATCH + sub;
			seen += 1;
			layers[L].push({ i, sx: fx, sy: fy, sz: fz, L });
			fromAttr.setXYZ(i, fx, fy, fz);
			layerAttr.setX(i, L);
		}
		fromAttr.needsUpdate = true;
		layerAttr.needsUpdate = true;

		/*
		 * 老节点：aLayer = -1 → **完全不参与这一轮动画**。
		 * 位置直接落在整图重算后的结果上（微调幅度很小，看不出来），
		 * 透明度也不会跟着闪 —— 它们本来就该一直在场。
		 *
		 * 之前给它们填旧坐标、让它们滑过去，结果老树整片在动，
		 * 看起来就是"结构还在算"。
		 */
		for (let i = 0; i < n; i += 1) {
			if (active[i]) continue;
			layerAttr.setX(i, -1);
		}
		layerAttr.needsUpdate = true;

		/* 线的 aFrom 按端点插值，aLayer 取两端较大值 —— 边是"被拉长"而不是整条平移 */
		syncLinkMorph(layerAttr.array, fromAttr.array);

		/* 诊断：动画没播 / 线全长 的时候，这行会直接指出断在哪一环 */
		let matchedOld = 0;
		if (morphFrom && morphFrom.size) {
			for (let i = 0; i < n; i += 1) if (!active[i] && morphFrom.has(nodes[i].id)) matchedOld += 1;
		}
		const growTotal = Math.max(300, Number(totalMs) || GROW_TOTAL_MS);
		console.log('[memory-sea] 生长动画', {
			节点总数: n,
			本次新增: count,
			老节点匹配到起点: matchedOld,
			传入旧坐标数: morphFrom ? morphFrom.size : 0,
			层数: Math.max(1, layers.length),
			时长ms: growTotal
		});

		/* 启动：只设 uniform。position 一点没动，结构始终正确 */
		armMorph(growTotal, layers.length);
	}

	/**
	 * 把节点的 aFrom / aLayer 复制到线的对应顶点上。
	 *
	 * 遍历**全部顶点**（不靠 linkVertBase 索引表，那张表一旦和 seg 错位就整
	 * 批线拿不到出生点 —— 线的 aFrom 留在最终位置，于是"线一直是全长、
	 * 点却在动"，也就是用户看到的第一阶段点线分离）。
	 *
	 * 顶点号 v → 第 floor(v / 12) 条边；边内第 s 个顶点在 a→b 的 t 位置
	 * （每段 2 个顶点，段 k 的两端在 k/6 和 (k+1)/6）。所以边是两端同时伸长。
	 * 层号取两端较大值，且 -1（不参与）不会错误地压过 0。
	 */
	function syncLinkMorph(nodeLayer, nodeFrom) {
		if (!linkLines) return;
		const geo = linkLines.geometry;
		const fromAttr = geo.attributes.aFrom;
		const layerAttr = geo.attributes.aLayer;
		if (!fromAttr || !layerAttr) return;
		const fa = fromAttr.array;
		const la = layerAttr.array;
		const VPL = perLinkSegs * 2;
		const segs = perLinkSegs;
		const vcount = layerAttr.count;

		for (let v = 0; v < vcount; v += 1) {
			const li = Math.floor(v / VPL);
			const e = linkEnds[li];
			if (!e) continue;
			const s = v - li * VPL;
			const t = Math.floor((s + 1) / 2) / segs;
			const ai = e[0];
			const bi = e[1];
			const ax = nodeFrom[ai * 3] || 0;
			const ay = nodeFrom[ai * 3 + 1] || 0;
			const az = nodeFrom[ai * 3 + 2] || 0;
			const bx = nodeFrom[bi * 3] || 0;
			const by = nodeFrom[bi * 3 + 1] || 0;
			const bz = nodeFrom[bi * 3 + 2] || 0;
			fa[v * 3] = ax + (bx - ax) * t;
			fa[v * 3 + 1] = ay + (by - ay) * t;
			fa[v * 3 + 2] = az + (bz - az) * t;
			const laA = nodeLayer[ai] === undefined ? -1 : nodeLayer[ai];
			const laB = nodeLayer[bi] === undefined ? -1 : nodeLayer[bi];
			la[v] = Math.max(laA, laB);
		}

		fromAttr.needsUpdate = true;
		layerAttr.needsUpdate = true;
	}

	/** 启动一次位移动画：只设 uniform，不动任何 buffer */
	function armMorph(totalMs, layerCount) {
		growMs = Math.max(100, totalMs || 400);
		grow = { t0: performance.now(), total: growMs };
		for (const obj of [nodePoints, linkLines]) {
			if (!obj) continue;
			const u = obj.material.uniforms;
			u.uMorphOn.value = 1;
			u.uMorphT.value = 0;
			u.uLayerCount.value = Math.max(1, layerCount || 1);
			u.uLayerSpan.value = (layerCount || 1) > 1 ? 0.45 : 1.0;
		}
	}

	/**
	 * 就地重排 —— 拖动力学滑杆 / 切预设走这条路，**不重建任何几何**。
	 *
	 * 这是"接近实时"的关键。
	 * `build()` 每次要重新分配 5 个 Float32Array、新建 BufferGeometry 和
	 * ShaderMaterial、dispose 旧的 —— 在 4000 个点 + 6000 条边上这是几十毫秒，
	 * 还会触发一次 GC。而 Obsidian 那边只是让同一个 simulation 继续 tick。
	 *
	 * 节点数没变时这里只做四件事：
	 *   1. 把当前位置存进 aFrom（下一帧的起点）
	 *   2. 热启动重跑布局（不重新撒种、不锁定，原地微调）
	 *   3. 把新坐标写回 position buffer
	 *   4. 重算边的坐标 + 播一段平滑过渡
	 *
	 * @returns {boolean} false 表示结构变了（节点数不同），调用方要退回 build()
	 */
	function relayout(cfg, ticks) {
		if (!graph || !nodePoints || !linkLines) return false;
		const c = cfg || {};
		const nodes = graph.nodes;
		const n = nodes.length;
		if (!n) return false;

		const posAttr = nodePoints.geometry.attributes.position;
		const fromAttr = nodePoints.geometry.attributes.aFrom;
		const layerAttr = nodePoints.geometry.attributes.aLayer;
		if (!posAttr || !fromAttr || !layerAttr) return false;

		/* 1. 旧位置 → aFrom（shader 从这儿滑过去） */
		fromAttr.array.set(posAttr.array);
		layerAttr.array.fill(0);           /* 所有点同一层，一起动 */

		/* 2. 热启动跑布局：保留当前坐标，只让力去微调 */
		radius = runLayout(graph, c, {
			ticks: Math.max(1, ticks || 120),
			warmStart: true,
			skipNormalize: true,
			alpha: 0.45
		}) || radius;

		/* 3. 写回顶点坐标 */
		for (let i = 0; i < n; i += 1) {
			posAttr.setXYZ(i, nodes[i].x, nodes[i].y, nodes[i].z);
		}
		posAttr.needsUpdate = true;
		fromAttr.needsUpdate = true;
		layerAttr.needsUpdate = true;

		/* 4. 边的坐标跟着重算（就地），然后播过渡 */
		refreshLinksBy(() => true);
		syncLinkMorph(layerAttr.array, fromAttr.array);
		armMorph(450, 1);

		lastCfg = c;
		return true;
	}

	/** 入场：所有点从**中心**散开到自己位置。 */
	function bigBang(totalMs) {
		if (!nodePoints) return;
		const fromAttr = nodePoints.geometry.attributes.aFrom;
		const layerAttr = nodePoints.geometry.attributes.aLayer;
		if (!fromAttr || !layerAttr) return;
		fromAttr.array.fill(0);            /* 全部从原点出发 */
		layerAttr.array.fill(0);           /* 同一层：一起散开 */
		fromAttr.needsUpdate = true;
		layerAttr.needsUpdate = true;
		syncLinkMorph(layerAttr.array, fromAttr.array);
		armMorph(Math.max(300, Number(totalMs) || GROW_TOTAL_MS), 1);
	}

	/** 重排过渡：所有点从旧坐标滑到新坐标（同一层，一起动） */	function armMorphFrom(nodes, oldPos, totalMs) {
		if (!nodePoints || !oldPos) return;
		const fromAttr = nodePoints.geometry.attributes.aFrom;
		const layerAttr = nodePoints.geometry.attributes.aLayer;
		if (!fromAttr || !layerAttr) return;
		const posAttr = nodePoints.geometry.attributes.position;
		let moved = 0;
		for (let i = 0; i < nodes.length; i += 1) {
			const p = oldPos.get(nodes[i].id);
			if (p) {
				fromAttr.setXYZ(i, p.x, p.y, p.z);
				moved += 1;
			} else {
				/* 新出现的节点：从最终位置"原地亮起" */
				fromAttr.setXYZ(i, posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
			}
			layerAttr.setX(i, 0);
		}
		fromAttr.needsUpdate = true;
		layerAttr.needsUpdate = true;
		syncLinkMorph(layerAttr.array, fromAttr.array);
		/* 有东西真的移动过才播，否则白跑一趟 */
		if (moved) armMorph(totalMs || 420, 1);
	}

	/** 每帧：推进一个 uniform 就够了 */
	function stepGrow(now) {
		const g = grow;
		if (!g) return;
		const t = Math.min(1, (now - g.t0) / g.total);
		for (const obj of [nodePoints, linkLines]) {
			if (!obj) continue;
			obj.material.uniforms.uMorphT.value = t;
		}
		if (t >= 1) {
			/* 结束：关掉 morph，shader 直接用正确的 position */
			for (const obj of [nodePoints, linkLines]) {
				if (obj) obj.material.uniforms.uMorphOn.value = 0;
			}
			grow = null;
		}
	}

	/* ── Ctrl 拖动整簇（链条 / 绳子模型） ──
	 *
	 * 顺着"层级更高"的邻居做 BFS，把所有子孙收进来，**记下 BFS 顺序和每个节点的父节点**。
	 *
	 * 关键改动：每个子孙追的是**自己的父节点**，不是全部追主点。
	 * 于是拖动时抖动沿链传递 —— 主点先动，一级子女跟着，二级孙再跟着，
	 * 越远越滞后、越晃。这就是绳子/鞭子的手感。
	 *
	 * 之前所有子孙都刚性追主点：整坨硬邦邦一起平移，像一块铁板。
	 *
	 * 刚度小 → 软趴趴的绳子；刚度大 → 绷紧的链条。阻尼小 → 晃得久。
	 * 两个参数都在设置面板「交互」组里。
	 */
	function collectCluster(idx) {
		const items = [];
		const seen = new Set([idx]);
		const queue = [idx];
		while (queue.length) {
			const u = queue.shift();
			const nb = adjOf.get(u);
			if (!nb) continue;
			for (let k = 0; k < nb.length; k += 1) {
				const v = nb[k];
				if (seen.has(v)) continue;
				/* 只往更深的层级走，别把父节点和兄弟也拽进来 */
				if (layerKeyOf(graph.nodes[v].point) <= layerKeyOf(graph.nodes[u].point)) continue;
				seen.add(v);
				const m = graph.nodes[v];
				const pu = graph.nodes[u];
				items.push({
					i: v,
					parent: u,
					/* 相对父节点的偏移：链条每一节只关心自己这一节的长度 */
					ox: m.x - pu.x,
					oy: m.y - pu.y,
					oz: m.z - pu.z,
					vx: 0, vy: 0, vz: 0
				});
				queue.push(v);
			}
		}
		return items;
	}

	function stepClusterDrag() {
		const cd = clusterDrag;
		if (!cd || !graph || !nodePoints) return;
		const anchor = graph.nodes[cd.anchor];
		if (!anchor) { clusterDrag = null; return; }
		const posAttr = nodePoints.geometry.attributes.position;
		const k = cd.stiffness;
		const damp = cd.damping;
		const moving = new Set();
		let movingAll = 0;

		/*
		 * items 是按 BFS 顺序排的：父一定排在子前面。
		 * 顺序推进，子读到的就是父**这一帧已经更新过**的位置 ——
		 * 位移因此沿链一节一节传下去。
		 */
		for (let m = 0; m < cd.items.length; m += 1) {
			const it = cd.items[m];
			const n = graph.nodes[it.i];
			const p = graph.nodes[it.parent];
			if (!n || !p) continue;
			const tx = p.x + it.ox;
			const ty = p.y + it.oy;
			const tz = p.z + it.oz;
			it.vx = (it.vx + (tx - n.x) * k) * damp;
			it.vy = (it.vy + (ty - n.y) * k) * damp;
			it.vz = (it.vz + (tz - n.z) * k) * damp;
			let dx = it.vx;
			let dy = it.vy;
			let dz = it.vz;
			/* 限步长：低阻尼时不会甩飞 */
			const len = Math.hypot(dx, dy, dz);
			const cap = 40;
			if (len > cap) { const s = cap / len; dx *= s; dy *= s; dz *= s; }
			n.x += dx; n.y += dy; n.z += dz;
			posAttr.setXYZ(it.i, n.x, n.y, n.z);
			moving.add(it.i);
			if (len > 0.02) movingAll += 1;
		}
		posAttr.needsUpdate = true;
		refreshLinksBy((a, b) => moving.has(a) || moving.has(b) || a === cd.anchor || b === cd.anchor);
		cd.movingCount = movingAll;
		cd.settled = movingAll === 0;
	}

	/* ── 交互 ──
	 *
	 * 逻辑全部在 src/interact.js 的 createPointerMachine 里（纯函数，有单测
	 * tools/test-interact.mjs）。这里只负责把「状态机事件」翻译成场景操作。
	 *
	 * 这样做的原因：之前把判定写在事件回调里，一个 return 位置写错就吃掉了
	 * 整个点击（详情卡 + 相机推进一起消失），而且没有测试能发现。
	 */
	const machine = createPointerMachine({
		hitTest: (x, y) => pickAt(x, y),
		now: () => performance.now(),
		threshold: 3,
		tapTimeout: 420,

		/* 点击：选中 + 高亮 + 相机推进 + 通知外壳弹卡片 */
		onTap(idx) {
			selectedIndex = idx;
			setFocus(idx);
			if (idx >= 0) focusNode(idx);
			if (typeof cb.onPick === 'function') cb.onPick(pointOf(idx));
		},

		/* 拖动开始：建一个过该点、垂直于相机视线的平面 */
		onDragStart(idx) {
			if (!graph || idx < 0) return;
			const n = graph.nodes[idx];
			const normal = new Vector3().subVectors(camera.position, controls.target).normalize();
			dragPlane.setFromNormalAndCoplanarPoint(normal, new Vector3(n.x, n.y, n.z));
			draggingIndex = idx;
			controls.enabled = false;
			canvas.style.cursor = 'grabbing';
			/*
			 * Ctrl 按住 = 拖整簇（链条模型）。
			 * collectCluster 给出 BFS 顺序 + 每个节点的父节点，
			 * 之后每一节追自己上一节，位移沿链传递。
			 */
			clusterDrag = null;
			if (dragMods.ctrl) {
				const items = collectCluster(idx);
				if (items.length) {
					clusterDrag = {
						anchor: idx,
						items,
						stiffness: clusterStiffness,
						damping: clusterDamping,
						movingCount: items.length,
						settled: false
					};
				}
			}
		},

		/* 拖动中：射线与平面求交 → 更新节点位置 + 相关连线 */
		onDragMove(idx, x, y) {
			if (!graph || !nodePoints || idx < 0) return;
			const rect = canvas.getBoundingClientRect();
			if (!rect.width || !rect.height) return;
			ndc.x = ((x - rect.left) / rect.width) * 2 - 1;
			ndc.y = -((y - rect.top) / rect.height) * 2 + 1;
			raycaster.setFromCamera(ndc, camera);
			if (!raycaster.ray.intersectPlane(dragPlane, _hit)) return;
			const n = graph.nodes[idx];
			n.x = _hit.x; n.y = _hit.y; n.z = _hit.z;
			const attr = nodePoints.geometry.attributes.position;
			attr.setXYZ(idx, n.x, n.y, n.z);
			attr.needsUpdate = true;
			refreshLinksOf(idx);
		},

		onDragEnd() {
			draggingIndex = -1;
			controls.enabled = true;
			canvas.style.cursor = hoverIndex >= 0 ? 'pointer' : 'grab';
			/* 簇还没收拢就留着，让弹簧自己跑完（stepClusterDrag 会清掉） */
			if (clusterDrag && clusterDrag.settled) clusterDrag = null;
		},

		/* 悬浮：邻居高亮 / 其余压暗 */
		onHover(idx) {
			hoverIndex = idx;
			canvas.style.cursor = idx >= 0 ? 'pointer' : 'grab';
			setFocus(idx >= 0 ? idx : selectedIndex);
			if (typeof cb.onHover === 'function') cb.onHover(pointOf(idx));
			/* 悬浮详情：只开关卡片，不飞行、不选中 —— 外壳自己判断开关状态 */
			if (typeof cb.onHoverDetail === 'function') cb.onHoverDetail(pointOf(idx));
		}
	});

	/*
	 * 事件绑定（这里踩过一个大坑）：
	 *
	 * OrbitControls 在自己的 pointerdown 里调 `domElement.setPointerCapture()`，
	 * 而 release 写在自己的 pointerup 里 —— 那个函数第一行是
	 * `if (this.enabled === false) return;`。
	 *
	 * 我们拖动节点时会把 controls.enabled 设为 false，于是：
	 *   pointerdown → OrbitControls 抢到 pointer capture
	 *   拖动中     → enabled = false
	 *   pointerup  → OrbitControls 提前 return，**不 release**
	 *   ⇒ canvas 永久持有该 pointerId 的 capture，之后所有鼠标事件都被它吃掉，
	 *     面板上的按钮全部点不动；直到下一次 pointerup 走到 release 分支才恢复。
	 *     用户看到的现象正是「拖完按钮失灵，点一下别的再点回来又好了」。
	 *
	 * 修法：pointerdown 用 **capture 阶段**监听，命中节点时 stopPropagation()，
	 * 让 OrbitControls 根本收不到这一下（它就不会 capture）。它没 capture，
	 * 我们也就不需要它 release。
	 *
	 * pointerup / pointercancel 绑到 window 兜底：拖动时鼠标可能移出 canvas，
	 * 只绑 canvas 会丢事件，导致拖动状态一直不结束。
	 */
	let pointerActive = false;

	const onDownCapture = (e) => {
		/*
		 * 每次按下先把上一轮可能残留的 pointer capture 放掉。
		 *
		 * 用户报："Ctrl 拖动后很多点像被鼠标捕获选上，之后点不动。"
		 * 上一次拖动的 capture 如果没清，新一轮 pointerdown 会被旧 capture 吃掉。
		 * 这里无脑清一次，代价是个空 try/catch。
		 */
		if (activePointerId >= 0) {
			try { canvas.releasePointerCapture(activePointerId); } catch (err) { /* 没捕获过，忽略 */ }
		}
		pointerActive = true;
		activePointerId = e.pointerId;
		/* Ctrl = 拖整簇，按下这一刻就要记，拖动中途按不按不管 */
		dragMods.ctrl = !!(e.ctrlKey || e.metaKey);
		/* 命中星点 → 这一下归我们，别让 OrbitControls 抢 capture */
		const hit = pickAt(e.clientX, e.clientY);
		if (hit >= 0) {
			e.stopPropagation();
			e.preventDefault();
		}
		machine.down(e.clientX, e.clientY);
	};
	/*
	 * move 也绑 window：
	 *   · 拖动中鼠标移出 canvas，只绑 canvas 会丢事件 → 节点不跟手
	 *   · 没按下时，只处理落在 canvas 上的 move（做悬浮），不打扰面板按钮
	 */
	const onMove = (e) => {
		if (pointerActive) {
			machine.move(e.clientX, e.clientY, e.buttons);
			return;
		}
		if (e.target !== canvas) return;
		machine.move(e.clientX, e.clientY, e.buttons);
	};
	const onUp = (e) => {
		/*
		 * pointer capture 兜底释放。
		 *
		 * 用户报："拖动到较远的点后可能无法再次拖"。
		 * 病根：OrbitControls 在 pointerdown 里 setPointerCapture，release 写在自己
		 * 的 pointerup 里 —— 而那个函数第一行是 `if (enabled === false) return`。
		 * 我们拖节点时把 controls.enabled 设成 false，于是它不 release，
		 * canvas 永久持有这个 pointerId，后续鼠标事件全被吃掉。
		 * 主动释放一次，无论谁设的。
		 */
		if (activePointerId >= 0) {
			try { canvas.releasePointerCapture(activePointerId); } catch (err) { /* 没捕获过会抛，忽略 */ }
			activePointerId = -1;
		}
		if (!pointerActive) return;   /* window 兜底与 canvas 自身会重复触发，这里去重 */
		pointerActive = false;
		machine.up(e.clientX, e.clientY);
	};

	/* capture: true —— 必须在 OrbitControls 之前拿到这一下 */
	canvas.addEventListener('pointerdown', onDownCapture, true);
	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
	window.addEventListener('pointercancel', onUp);
	canvas.style.cursor = 'grab';

	/* ── 相机飞行 ── */
	let fly = null;

	/**
	 * 点一颗星 → 拉到画面中央并**推近**。
	 *
	 * ★ 老实现把观察距离写成「全局半径的 1.05 倍」，radius 是**全局**半径。
	 *   深探之后点数从 1200 涨到 4000，radius 跟着变大，于是每点一颗星，
	 *   相机就退到全局半径那个量级 —— 表现就是"越点越远"。
	 *   病根：拿全局尺度当观察距离。
	 *
	 * 现在按**局部**尺度算：这颗星和它直接邻居铺开的范围，并夹住上界
	 * `当前距离 × 0.72` —— 只推不拉，单次最多推 28%，连点几次才一路推进去。
	 */
	function focusNode(idx) {
		if (!graph || idx < 0) return;
		const n = graph.nodes[idx];

		/* 当前视线方向用「相机 − target」而不是「相机 − 世界原点」：
		   相机已经偏到别的簇时，后者会把镜头绕到星域背面去。 */
		const off = new Vector3().subVectors(camera.position, controls.target);
		const curDist = off.length();
		const dir = curDist > 1
			? off.clone().divideScalar(curDist)
			: new Vector3(0, 0.4, 1).normalize();

		/* 局部尺度：这颗星 + 直接邻居的散布半径与数量 */
		let spread = 0;
		let around = 1;
		for (let i = 0; i < linkEnds.length; i += 1) {
			const e = linkEnds[i];
			let j = -1;
			if (e[0] === idx) j = e[1];
			else if (e[1] === idx) j = e[0];
			else continue;
			const m = graph.nodes[j];
			if (!m) continue;
			const d = Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z);
			if (d > spread) spread = d;
			around += 1;
		}

		/*
		 * 想看的距离：
		 *   local —— 把邻居都框住（spread×2.1，52° FOV 下留得出白）
		 *   floor —— 至少退到全局星域的 30%，否则点一颗孤立消息会贴到脸上、四周全黑
		 */
		const local = spread * 2.1 + 18 * Math.sqrt(around);
		const floor = Math.max(80, radius * 0.3);
		let dist = Math.max(local, floor);
		if (curDist > 1) dist = Math.min(dist, curDist * 0.72);   /* 只推不拉 */
		dist = Math.max(70, dist);   /* controls.minDistance = 60，留点余量 */

		fly = {
			t0: performance.now(), dur: 620,
			from: camera.position.clone(),
			/* dir 是单位向量，所以相机到 n 的距离正好是 dist，且仰角原样保留 */
			to: new Vector3(n.x + dir.x * dist, n.y + dir.y * dist, n.z + dir.z * dist),
			fromTarget: controls.target.clone(),
			toTarget: new Vector3(n.x, n.y, n.z)
		};
	}
	function stepFly(now) {
		if (!fly) return;
		const k = Math.min(1, (now - fly.t0) / fly.dur);
		const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
		camera.position.lerpVectors(fly.from, fly.to, e);
		controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
		if (k >= 1) fly = null;
	}

	/* ── 主循环 ── */
	let raf = 0;
	let alive = true;
	function frame() {
		if (!alive) return;
		const now = performance.now();

		if (reveal.active > 0.5) {
			const p = (now - reveal.t0) / 2400;
			reveal.progress = Math.min(1, p);
			if (p >= 1) reveal.active = 0;
			applyRevealUniforms();
		}

		/* 首次进入的分步布局：每帧 22 tick，点一边散开一边归位 */
		stepLiveLayout();

		/* 标签：每 3 帧刷一次就够，文字不需要 60fps */
		labelTick += 1;
		if (labelsOn && (labelTick % 3 === 0)) drawLabels();

		/* 分层生长：一层一层往外抽枝 */
		if (grow) stepGrow(now);
		/* Ctrl 拖整簇：子孙用弹簧追主点，带惯性和过冲 */
		if (clusterDrag) {
			stepClusterDrag();
			if (clusterDrag.settled && draggingIndex < 0) clusterDrag = null;
		}

		const t = now / 1000;
		starFar.material.uniforms.uTime.value = t;
		starNear.material.uniforms.uTime.value = t;

		stepFly(now);
		controls.update();
		composer.render();

		if (selectedIndex >= 0 && typeof cb.onAnchor === 'function') {
			const p = projectScreen(selectedIndex);
			if (p) cb.onAnchor(p.x, p.y, p.visible);
		}
		raf = requestAnimationFrame(frame);
	}

	const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;

	return {
		build,
		relayout,
		applyVisual,
		applyAttrs,
		applyCurve,
		replayReveal,
		replayGrow,
		finishGrow,
		/* 深探需要当前节点坐标做「钉住」，所以把图暴露出去 */
		getGraph() { return graph; },
		getRadius() { return radius; },
		setLinkCurve(v) { linkCurveRef.value = Math.max(0, Number(v) || 0); },
		start() {
			resize();
			if (observer) observer.observe(canvas);
			raf = requestAnimationFrame(frame);
		},
		destroy() {
			alive = false;
			if (raf) cancelAnimationFrame(raf);
			if (observer) observer.disconnect();
			controls.dispose();
			/* 监听器挂在 canvas(capture) 和 window 上，卸载时一并摘掉，否则重挂会重复触发 */
			canvas.removeEventListener('pointerdown', onDownCapture, true);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			/* 万一卸载时还在拖动，把 OrbitControls 还原，别把画布留成禁状态 */
			controls.enabled = true;
			composer.dispose();
			for (const o of [nodePoints, linkLines]) disposeObj(o);
			disposeObj(nebula);
			disposeObj(starFar);
			disposeObj(starNear);
			renderer.dispose();
		},
		resetView() {
			/* 复位是唯一允许把 target 拽回原点、距离收到推荐取景的操作 */
			controls.target.set(0, 0, 0);
			setCameraElev(radius, 50, false);
			selectedIndex = -1;
			setFocus(-1);
		},
		focusNode,
		projectScreen,
		setCameraElev,
		/* 画布尺寸被外部改了（比如「铺满顶部导航栏」开关）时，让渲染器重算 drawingBuffer */
		resize,
		setAutoRotate(on) { controls.autoRotate = !!on; },
		setAutoRotateSpeed(v) { controls.autoRotateSpeed = Number(v) || 0.22; },
		/* 自查用：还剩几层没长完、相机现在离 target 多远 */
		getGrowState() {
			return grow
				? {
					layers: grow.layers.length,
					left: grow.layers.reduce((s, L) => s + L.filter((it) => !it.done).length, 0)
				}
				: null;
		},
		getCamDistance() { return camera.position.distanceTo(controls.target); }
	};
}
