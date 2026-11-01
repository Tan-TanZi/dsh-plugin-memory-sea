/**
 * 功能审计：检查每个用户可见功能的调用链是否还在。
 *
 * 起因：反复出现「改 A 功能把 B 弄没了」（点击吃掉拖动、拖动吃掉点击）。
 * 静态 grep 抓不到顺序问题，但能抓到「整条链路被删/被替换」这种最常见的情况。
 * 交互的顺序问题由 tools/test-interact.mjs 负责。
 *
 * 跑法：node tools/audit-features.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');

const render = src('render.js');
const shell = src('shell.js');
const interact = src('interact.js');
const presets = src('presets.js');

function slice(code, start, end) {
	const a = code.indexOf(start);
	if (a < 0) return '';
	if (!end) return code.slice(a);
	const b = code.indexOf(end, a + start.length);
	return b > a ? code.slice(a, b) : code.slice(a);
}

const onTap = slice(render, 'onTap(idx) {', 'onDragStart(idx)');
const onHover = slice(render, 'onHover(idx) {', '}');
const onDragMove = slice(render, 'onDragMove(idx, x, y) {', 'onDragEnd()');
const setFocusFn = slice(render, 'function setFocus(idx)', 'function replayReveal');
const handlePick = slice(shell, 'const handlePick', 'const [');
const anchorCard = slice(shell, 'const anchorCard', 'const handlePick');

let bad = 0;
function must(name, ok, hint) {
	console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '   ← ' + (hint || '调用链断了')));
	if (!ok) bad += 1;
}

console.log('交互链路（render.js → interact.js → shell.js）\n');

must('点击 → 弹详情卡', onTap.includes('cb.onPick('), 'onTap 里没有 cb.onPick');
must('点击 → 相机推进', onTap.includes('focusNode(idx)'), 'onTap 里没有 focusNode(idx)');
must('点击 → 选中高亮', onTap.includes('selectedIndex = idx') && onTap.includes('setFocus(idx)'), 'onTap 里没设 selectedIndex / setFocus');
must('悬浮 → 邻居高亮', onHover.includes('setFocus('), 'onHover 里没有 setFocus');
must('拖动 → 移动节点', onDragMove.includes('attr.setXYZ('), 'onDragMove 没更新 position');
must('拖动 → 连线跟随', onDragMove.includes('refreshLinksOf('), 'onDragMove 没重算连线');
must('拖动 → 暂停环绕', onDragMove !== '' && render.includes('controls.enabled = false'), '拖动时没禁用 OrbitControls');

must('详情卡跟随星点', render.includes('cb.onAnchor(p.x, p.y, p.visible)'), 'anchor 回调没了');
must('外壳接收 anchor', anchorCard.includes('placeCard('), 'anchorCard 没排位置');
must('外壳接收点击', handlePick.includes('setDetail('), 'handlePick 没 setDetail');

must('压暗属性 aDim', render.includes('aDim') && setFocusFn.includes('dimAttr'), 'aDim 没在 setFocus 里更新');
must('连线高亮 aHot', render.includes('aHot') && setFocusFn.includes('hotAttr'), 'aHot 没在 setFocus 里更新');
must('高亮不新增几何', !render.includes('highlight = new LineSegments'), '又出现了独立的 highlight 对象');

must('开场动画 uniform', render.includes('uRevealProgress'), 'reveal uniform 没了');
must('开场动画可重播', render.includes('replayReveal'), 'replayReveal 没了');
must('曲线系数 0.32', render.includes('CURVE_BOW = 0.32'), '曲线系数被改');

console.log('\n状态机（interact.js）\n');
must('点击回调存在', interact.includes('o.onTap'), 'onTap 没有被调用');
must('拖动回调存在', interact.includes('o.onDragStart') && interact.includes('o.onDragEnd'), '拖动回调缺失');
must('拖动后不点击', interact.includes("return 'drag'"), '拖动分支没提前返回');
must('空白拖动不算点击', interact.includes('blankDrag'), 'blankDrag 标志没了');
must('手抖仍算点击', interact.includes('if (pending < 0) blankDrag = true;'), 'buttons 分支又无条件置 blankDrag');

console.log('\n渲染与画质\n');
must('composer DPR 传递', render.includes('composer.setPixelRatio(dpr)'), '后处理链会退回 CSS 分辨率');
must('HDR 渲染目标', render.includes('HalfFloatType'), 'bloom 会因 8-bit 截断而发灰');
must('MSAA', render.includes('samples: 4'), '边缘会有锯齿');
must('超采样', render.includes('ssaa'), 'ssaa 没接');
must('节点尺寸公式', render.includes('Math.sqrt(deg)'), '度数尺寸公式被改');
must('相机距离 1.85', render.includes('1.85') || src('layout.js').includes('1.85'), '取景距离被改');

console.log('\n指针事件（拖动后按钮失灵那类问题）\n');
must('pointerdown 走 capture 阶段',
	render.includes("addEventListener('pointerdown', onDownCapture, true)"),
	'没在 capture 阶段拦，OrbitControls 会抢 pointer capture');
must('命中节点阻止 OrbitControls',
	render.includes('e.stopPropagation()'),
	'没 stopPropagation，OrbitControls 仍会 capture 并永不释放');
must('pointerup 绑 window 兜底',
	render.includes("window.addEventListener('pointerup', onUp)"),
	'鼠标移出 canvas 松开时状态机收不了尾');
must('pointercancel 也兜底',
	render.includes("window.addEventListener('pointercancel', onUp)"),
	'触摸被打断时状态机卡住');
must('up 去重', render.includes('if (!pointerActive) return;'), 'window 兜底会和 canvas 重复触发');
must('destroy 摘 window 监听',
	render.includes("window.removeEventListener('pointerup', onUp)"),
	'重挂时会重复绑定');

console.log('\n面板布局\n');
const panelStyle = slice(shell, 'panel: {', 'canvas: {');
must('画布 fixed 铺到窗口顶部', /position\s*=\s*['"]fixed['"]/.test(shell) || /position:\s*['"]fixed['"]/.test(shell), '画布不是 fixed，会被 frame 的 overflow:hidden 裁掉');
must('画布横向由 JS 对齐', /el\.style\.left = r\.left/.test(shell), '没对齐 main 区域，会盖住左侧栏');
must('标签层同步定位', shell.includes('labelRef.current') && shell.includes('data-memorysea-labels'),
	'标签画布不跟着主画布走，文字会错位');
must('视图开关（铺满顶部）', shell.includes('fullBleed') && shell.includes('铺满顶部导航栏'), '设置页没有这个开关');
must('开关切换后重定位', shell.includes('placeRef.current()'), '切换开关后画布位置不更新');
must('开关切换后重算 buffer', shell.includes('rndRef.current.resize'), '切换开关后 drawingBuffer 尺寸不对');
must('面板背景透明', /background:\s*['"]transparent['"]/.test(shell), '面板背景会盖住 fixed 画布');
must('底色走 WebGL', render.includes('setClearColor(col, alpha)'), '底色没走 clearColor，画布没有背景色');
must('面板直角贴合', /borderRadius:\s*0/.test(panelStyle), '圆角会在四角露出宿主背景');
must('HUD 用面板内偏移', slice(shell, 'top: {', 'title: {').includes('top: 10'), 'HUD 的 top 被改成了 clearance 补偿（面板已不上移，不需要）');
const dockStyle = slice(shell, 'dock: {', 'dockBar:');
must('控制台高度封顶 500px', dockStyle.includes('500px'), 'S.dock 的 maxHeight 不是 500px');
must('控制台内部滚动', dockStyle.includes('overflowY') && dockStyle.includes('auto'), '没有 overflowY: auto，内容会溢出');
must('控制台留出底部工具栏', dockStyle.includes('92px'), '小窗口下会压到左下工具栏');

console.log('\n数据接入（host 侧边界）\n');
const host = fs.readFileSync(path.join(here, '..', 'host', 'index.js'), 'utf8');
const live = fs.readFileSync(path.join(here, '..', 'src', 'live.js'), 'utf8');
must('只用读方法', host.includes('listSessions') && host.includes('listEvents'), 'host 没读会话');
must('不读 tools 服务', !/ctx\.get\(['"]tools['"]\)/.test(host), '碰了 tools —— 等于把内容塞进上下文');
must('不调 prompt', !/\.prompt\s*\(/.test(host), 'host 调了 prompt');
must('不碰 systemPrompt', !/ctx\.get\(['"]systemPrompt['"]\)|systemPrompt\s*:|systemPrompt\.push/.test(host), 'host 动了 systemPrompt');
must('不写会话事件', !/appendEvent|writeSession|putEvent/.test(host), 'host 在写会话');
must('注册 fetch 路由', host.includes('register') && host.includes('fetch'), 'host 没暴露接口');
must('落盘 index/turns', host.includes("'index.json'") && host.includes("'turns.json'"), '缺索引落盘');
must('分词 Intl.Segmenter', host.includes('Intl.Segmenter'), '没分词，词频视图无从谈起');
must('参数自适应', host.includes('tryVariants'), '方法签名未知，必须自适应试错');
must('client 有回退', live.includes('toLiveScene') && shell.includes('liveScene || DEMO'), '拿不到数据时要退回 demo');

console.log('\n宿主 API 契约（踩过的坑，防止回归）\n');
/* 每条都对应一次真实故障，见 docs/HOST-API.md */
must('route 字段用 fetch 不是 handler', /fetch:\s*async/.test(host) && !/handler:\s*async/.test(host), 'registerFetchRoute 认 route.fetch，写 handler 会导致请求挂起');
must('route 带 requestBody', (host.match(/requestBody:\s*'buffered'/g) || []).length >= 2, '漏掉 requestBody 会让宿主返回 400');
must('methods 传数组', /methods:\s*\[/.test(host) && !/methods:\s*new Set/.test(host), 'assertFetchRoute 读 route.methods.length，Set 没有 length 会抛');
must('用 ctx.inject 等依赖', host.includes('ctx.inject([') || host.includes("ctx.inject(['connection']"), 'apply 里立即 ctx.get 会拿到 undefined');
must('有重试兜底', host.includes('setInterval'), 'inject 不触发时要有兜底');
must('相对路径是首个候选', /push\(''\)/.test(live), '桌面端页面是 dsh-app://app，相对路径由协议转发，直连 19387 会被 CORS 挡');
must('候选不过滤空串', !/if\s*\(\s*u\s*&&\s*!out\.includes/.test(live), '空字符串是合法的相对路径候选，falsy 判断会把它丢掉');
must('接口带 API 前缀', /requestJson\(API \+/.test(live), 'requestJson 只传 /scene 会打到错误路径');
must('错误含响应体', live.includes('res.text()'), '4xx/5xx 的原因写在响应体里，不读就只能猜');
must('用 observeSession 取内容', host.includes('observeSession') && host.includes("projectionMode: 'none'"), 'listEvents 只给事件壳（surface: shadowed），没有 data');
must('过滤系统注入', host.includes('isNoise') && host.includes('system-reminder'), '系统提示会污染词频和预览');
must('过滤在分轮之前', /isNoise\(text\)\)\s*\{[\s\S]{0,200}continue/.test(host), '先分轮再过滤会让注入独占一轮');
must('observation 收尾', host.includes('disposeObs'), 'observeSession 不 close 会一直占着');
must('deploy 检查产物新鲜度', fs.readFileSync(path.join(here, '..', 'deploy.mjs'), 'utf8').includes('产物比源码旧'), 'build 失败会静默部署旧包');

console.log('\n深探（交互契约）\n');
const dive = fs.readFileSync(path.join(here, '..', 'src', 'deepdive.js'), 'utf8');
const layout = fs.readFileSync(path.join(here, '..', 'src', 'layout.js'), 'utf8');
must('一次到底', dive.includes('buildSessionAddon') && dive.includes('records'), '深探要直接摊到消息层');
must('收起反向幂等', dive.includes('removeSessionAddon') && shell.includes('expanded.has(sid)'), '再点一次要能收起');
must('分片缓存有上限', dive.includes('MAX_CACHE'), '缓存不设上限会吃内存');
must('深探状态不落盘', !/localStorage|dsh\.config/.test(dive), '展开状态只存内存，重启重置');
must('布局支持钉住', layout.includes('o.pinned') && layout.includes('n.fx = p.x'), '深探会让整图重排');
must('不归一化', layout.includes('skipNormalize'), '归一化会把已有节点整体压缩');
must('新点从父节点冒出', layout.includes('spawnFrom') && layout.includes('parent.x'), '要"冒星点"效果');
must('render 暴露图坐标', fs.readFileSync(path.join(here, '..', 'src', 'render.js'), 'utf8').includes('getGraph()'), '深探需要快照已有位置');
must('设置页有深探分组', shell.includes('深探') && shell.includes('cacheStats()'), '设置面板要能看/清缓存');
must('只连轮次→消息', dive.includes("'T:' + r.turnId"), '消息间连顺序链会让边缘糊成一团');

console.log('\n镜头与生长动画\n');
const rend = fs.readFileSync(path.join(here, '..', 'src', 'render.js'), 'utf8');
/* 2026-11-01 用户报："点深探后点其他星无法拉近，反而拉远"。
   病根是 focusNode 用全局 radius 当观察距离。 */
must('聚焦不用全局半径', !rend.includes('radius * 1.05'), '深探后 radius 变大 → 越点越远');
must('聚焦只推不拉', rend.includes('curDist * 0.72'), '单次聚焦必须只允许更近，不能后退');
must('聚焦用局部尺度', rend.includes('spread * 2.1'), '要按这颗星和邻居的散布范围算距离');
must('聚焦保持视线方向', rend.includes('subVectors(camera.position, controls.target)'), '用世界原点归一化会绕到星域背面');
must('分层生长有层序', rend.includes('LAYER_ORDER') && rend.includes('session: 1') && rend.includes('turn: 2'), '同一层级的点必须同批显形');
/* 2026-11-01 用户报："点和线没有连，刷新后就正常了"。
   病根：CPU 上改 position 再改回来，点和线是两条独立更新路径。
   现在 position 永远是正确结构，位移在 shader 里 mix(aFrom, position) —— 物理上不可能分离。 */
must('位移在 GPU 上做', rend.includes('mix(aFrom, p, morphT())'), 'position 必须始终是正确结构');
must('点和线共用位移公式', (rend.match(/morphPosition/g) || []).length >= 3, '两边各写一套就会再次分离');
must('点线共享同一 uniform', rend.includes('uMorphOn') && rend.includes('uMorphT'), '两块材质读同一个进度值');
must('生长不改 position', !/posAttr\.setXYZ\(it\.i,\s*it\.sx/.test(rend), '还在 CPU 上搬点 = 又会分离');
must('层序在 shader 里', rend.includes('aLayer') && rend.includes('uLayerSpan'), '同一层级的点必须同批');
/* ★★ 2026-11-01 最终定稿：深探的动画是**纯显隐**，位置一次到位永不移动。
   用户原话："结构你都没算完，你播什么动画" —— 只有位置固定，才可能"先算完再显示"。 */
must('深探位置不移动', !rend.includes('(fx - px) * 0.2') && !rend.includes('sx = px + (fx - px)'),
	'让点从父节点挪过去 = 动画里还在改结构，玩家能截到中间态');
must('深探靠透明度渐显', rend.includes('varying float vM') && /vM\s*=\s*morphT\(\)/.test(rend),
	'位置不动的前提下，只能用透明度做"出现"');
must('线和点同一条显隐', (rend.match(/vM/g) || []).length >= 5 && rend.includes('mix(uBaseAlpha, uHotAlpha, vHot) * vM'),
	'线不跟着淡入，会出现"线先全在、点才出来"');
must('线的起点按端点插值', rend.includes('syncLinkMorph') && rend.includes('Math.floor((s + 1) / 2) / segs'),
	'整条边平移的话中途会和点脱节');
/* 2026-11-01 用户报："第一阶段线还是全部出来了"。
   旧实现靠 linkVertBase 索引表定位顶点，错一位整批线拿不到出生点 →
   线的 aFrom 留在最终位置 = 线一直全长。改成遍历全部顶点，不依赖索引表。 */
must('线的起点覆盖全部顶点', rend.includes('const vcount = layerAttr.count'), '靠索引表错位，整批线就没有出生点');
must('不做 -1 兜底 0', rend.includes('=== undefined ? -1 :'), '-1（不参与）被 || 0 洗成 0 会被错误激活');
must('点位与线位同步', !rend.includes('(m - 0.25) / 0.75'), '给点加滞后会让前 25% 只剩几根线在飘');
must('手动节点也同步线', rend.includes('refreshLinksOf'), '拖动星点时连线要跟');
must('收起不播生长', shell.includes('noGrow: true'), '收起时整图重播动画会闪');
must('深探不动已有点', !shell.includes('turn') === false && !/p\.kind === ['"]turn['"] && p\.sessionId === sid/.test(shell), '已经存在的轮次点不该再播一次动画');
must('重排是平滑过渡', shell.includes('morphFrom: before') && rend.includes('armMorphFrom'), '预设切换不该像切帧一样跳变');
must('重排不动相机', shell.includes('keepCamera: true'), '一点预设就把视角拉回默认机位');
must('首次从中心散开', rend.includes('bigBang') && rend.includes('fromAttr.array.fill(0)'), '入场必须是"从一点炸开散成预设形状"');

console.log('\n线不能丢 / 设置不刷新\n');
/* 2026-11-01 用户报："打开后有几率没有线 / 展开的都没有线"。
   当年是出生点和父节点完全重合导致边长 0。
   现在深探不做位移了，这条改盯"线的顶点必须真的被写过"。 */
must('线的顶点有数据', rend.includes('linkGeo.setAttribute(\'position\'') && rend.includes('fillLinkSegments'),
	'线没有顶点就不会显示');
/* ★ 2026-11-01："我叫你点击深探，整套动作完成下来" ——
   整图重算必须在**深探这一下**里完成，不能拆成单独的按钮让用户去点。
   注意：收起分支仍然用 pinned（钉住别的节点是对的），所以只检查展开分支。 */
{
	const expandBranch = slice(shell, 'const grows = new Set', 'setExpanded(');
	must('深探自己整图重算',
		/ticks:\s*300/.test(expandBranch) && expandBranch.includes('warmStart: true') && !expandBranch.includes('pinned,'),
		'深探必须一次把整张图算完，不是只算新节点');
	must('深探仍有生长动画', expandBranch.includes('newIds: grows') && rend.includes('planGrow(nodes, newIds, o.growMs'),
		'整图重算不能把生长动画挤掉');
	must('深探老节点平滑归位', expandBranch.includes('morphFrom: snapshotPositions') && rend.includes('morphFrom && morphFrom.size'),
		'整图重算后老节点会跳，必须用 morphFrom 滑过去');
}
must('重排不重建几何', rend.includes('function relayout') && shell.includes('r2.relayout(next'),
	'每次都重建 BufferGeometry = 几十毫秒 + GC，这就是"要等一秒"的来源');
must('重排用热启动', layout.includes('warmStart'),
	'重新撒种等于把点扔回随机位置再收回来，调参就像换图');
must('深探才走分层生长', rend.includes('} else if (newIds) {'),
	'收起 / 重排不该重播层级生长');
must('入场不自动播', !rend.includes('if (!o.skipReveal && !grow) replayReveal()'),
	'一打开就该是完整的图，入场动画交给按钮');
must('生长时长可配', shell.includes('growMs') && rend.includes('totalMs'), '"一起炸开"是因为 0.4 秒内就长完了');
must('默认 5 秒', /growMs:\s*(5000|5e3)/.test(shell), '太短人眼分不出层次');
must('生长会收尾', rend.includes('finishGrow'), '动画没完就快照会钉住半路坐标');

/* 2026-11-01 用户报："视图里面的设置为什么切换要刷新"。 */
must('配色不重建几何', !/geometryKey\(c\)\s*\{[^}]*colorKey/.test(shell), '配色走 applyAttrs，不该 rebuild');
must('点大小走 applyAttrs', rend.includes('function applyAttrs') && rend.includes('sizeArrayFor'), '改点大小依据不该重建几何');
must('连线弯曲就地重采样', rend.includes('function applyCurve') && rend.includes('perLinkSegs = 6'), '段数一变就得重建 buffer，等于刷新');
must('几何键只含布局', /function geometryKey\(c\d?\)\s*\{\s*return layoutKey\(c\d?\);/.test(shell), '几何键里混进视觉参数 = 每次都要重建');

console.log('\n详情卡 / 消息可辨识\n');
must('host 存正文预览', host.includes('preview: text.replace') && host.includes('const SCHEMA = 2'), '没正文，详情卡只能说"1340 字"');
must('深探点带 text', dive.includes('text: r.preview'), '详情面板要能读出内容');
must('消息按角色分色', fs.readFileSync(path.join(here, '..', 'src', 'scene.js'), 'utf8').includes('RECORD_RGB'), '几千个同色点分不清谁是谁');
must('详情卡有字段名', shell.includes('kvRow(') && /add\(["']长度["']/.test(shell), '一串没有标签的数字等于没说');
/* ★ 2026-11-01："某一轮对话，没有所谓项目的说法吧" —— 字段必须按类型分别组装，
   而不是一堆 kvRow 并列 + 条件兜，那样会漏（轮次冒出"项目"和"工具 false"）。 */
must('字段按类型组装', shell.includes('if (p.kind === "session")') && shell.includes('} else if (p.kind === "turn")'),
	'并列 kvRow 靠"碰巧不显示"，一定会漏字段');
must('轮次不显示项目', !/kvRow\(["']项目["'],\s*detail\.point\.subtitle\)/.test(shell),
	'轮次没有项目概念，那行装的其实是首条消息预览，和底部正文重复');

console.log('\n交互四项（2026-11-01 新增）\n');
/* ① 拾取：必须按屏幕像素算，且必须跟 GPU 位移后的真实位置一致。 */
must('拾取按屏幕像素', rend.includes('PICK_RADIUS_PX') && !rend.includes('Points.threshold'),
	'写死世界单位：拉远后远处的星点不中');
must('拾取跟随动画位置', rend.includes('function visualPos') && rend.includes('function morphAt'),
	'raycaster 只认 position；GPU 位移后点画在别处 = 永远点不中');
must('拾取算法与 shader 一致', rend.includes('k * k * (3 - 2 * k)') && rend.includes('start = n > 1.5'),
	'两边公式对不上，动画期间还是会错位');
must('主动释放 pointer capture', rend.includes('releasePointerCapture'),
	'OrbitControls 在 enabled=false 时不 release，canvas 会永久占着指针');

/* ② 高亮：自身 + 向下整棵子树 + 向上 N 节链，兄弟不亮 */
must('高亮可回溯到根', rend.includes('lowerNeighborOf') && rend.includes('focusDepth'),
	'只亮直接邻居，看不到"这条链是从哪来的"');
must('回溯只走父链', rend.includes('kj < bestKey'), '无向 BFS 会点亮整个连通分量 = 等于没高亮');
must('高亮只标链不标兄弟', !rend.includes('顺便点亮新节点的其他孩子') && rend.includes('counted += 1'),
	'兄弟亮起来会把"一条链通到头部"的形状糊掉');
/* ★ 2026-11-01：曾经为了"只亮一节链"把向下的子树也删了，
   结果悬浮根节点什么都不亮。这条断言专门盯住"向下要有"。 */
must('高亮包含整棵子树', rend.includes('const down = [idx]') && rend.includes('down.pop()'),
	'悬浮根节点必须亮出它包含的所有东西，否则悬浮它毫无意义');
must('子树只向下不收兄弟', rend.includes('layerKeyOf(graph.nodes[v].point) <= lu'),
	'不加层级判断就会把兄弟和父节点一起收进来');

/* ③ 观赏模式 */
must('观赏模式禁用拾取', /if \(readOnly\) return -1;/.test(rend), '观赏模式还响应点击就不叫观赏');must('观赏模式不改鼠标映射', !rend.includes('MOUSE.PAN'),
	'左键旋转是肌肉记忆，观赏模式只该"不碰星点"，不该换操作习惯');
must('工具栏有观赏按钮', shell.includes('data-memorysea-readonly-btn'), '要有图标按钮能一键切换');

/* ④ Ctrl 拖整簇 + 绳子模型 */
must('Ctrl 拖整簇', rend.includes('collectCluster') && rend.includes('dragMods.ctrl'),
	'按下时要记住修饰键，否则拖起来还是单点');
must('每节追自己的父节点', rend.includes('const tx = p.x + it.ox') && rend.includes('parent: u'),
	'全部追主点 = 一块铁板平移；追父节点才有绳子/鞭子的传递感');
must('绳子参数可调', shell.includes('dragStiffness') && shell.includes('高亮段数'),
	'刚度小 = 软绳，大 = 绷紧；阻尼都要能拖');

console.log('\n标签系统\n');
/* ★ 2026-11-01 事故：`let labelCanvas` 声明写在中部，却在函数开头赋值。
   let 有 TDZ，createRenderer 一开始就抛 ReferenceError，整个面板打不开。
   这条断言专门盯"先声明后赋值"的顺序。 */
{
	const iDecl = rend.indexOf('let labelCanvas');
	const iAssign = rend.indexOf('labelCanvas = cb.labelCanvas');
	must('标签画布先声明后赋值', iDecl >= 0 && iAssign > iDecl,
		'TDZ：在 let 之前赋值会抛 ReferenceError，面板直接打不开');
}
/* 2026-11-01："加多标签。开启后圆点要显示文本。太长的自己想办法，不能把画面弄脏" */
must('有标签开关', shell.includes('data-memorysea-labels-btn') && shell.includes('labels: false'), '默认关，要有按钮开');
must('标签画在独立 2D 层', rend.includes('function drawLabels') && shell.includes('labelCanvas: labelRef.current'),
	'3D 里画几千条文字会卡死，必须单独一层');
must('标签不挡鼠标', shell.includes('pointerEvents: "none"'), '标签层吃掉鼠标就点不中星了');
must('标签按类型可选', rend.includes('labelOn.session') && rend.includes('labelOn.turn') && rend.includes('labelOn.record'),
	'会话/轮次/消息要能分开勾，否则只能全开或全关');
must('消息默认不出标签', shell.includes('labelOnRecord: false'), '几千条消息各自一条标签，画面直接完蛋');
must('消息只在悬停时写', rend.includes('focal >= 0 && dimArr') && rend.includes('dimArr[i] > 0.5'),
	'几千条消息各自一条标签，画面直接完蛋');
must('标签写名称或内容', rend.includes("labelField === 'name'") && shell.includes('labelField === "name"'),
	'只能写一种的话，想看正文就得另开一个功能');
must('标签有数量上限', rend.includes('labelMax') && rend.includes('placed < labelMax'), '不封顶就会铺满屏幕');
must('标签有避让', rend.includes('labelBoxes') && rend.includes('hit = true'), '重叠的标签叠着看不清');
must('长文本截断', rend.includes('labelChars') && rend.includes("slice(0, labelChars)"), '一轮对话上千字，不截断就完蛋');

console.log('\n筛选系统\n');
/* 2026-11-01："我教你做筛选，你硬生生不肯做啊。比如筛：工具调用、用户、还有他" */
must('按类型筛点', rend.includes('function applyFilter') && rend.includes("on[p.recordKind] === false"),
	'想只看工具调用、或者屏蔽工具调用，必须能按类型藏');
must('筛选就地生效', rend.includes('aShow') && !shell.includes('geometryKey(c) + c.showUser'),
	'筛一次重建整个几何 = 又是一个"要等一秒"；必须只改 aShow');
must('筛掉点连线一起消失', rend.includes('show[e[0]] > 0.5 && show[e[1]] > 0.5'),
	'端点藏了线还留着，会剩一堆悬空线段');
must('设置里有过滤组', shell.includes('id: "filter"') && shell.includes('title: "过滤"') && shell.includes('showUser'),
	'工具栏放不下，必须在设置面板里勾');
must('过滤分两个小节', shell.includes('"节点筛选"') && shell.includes('S.subHead'),
	'节点筛选和标签混在一起，找不着');

console.log('\n预设与配色\n');
/* 2026-11-01："用户编辑过就在预设名后面打上 * 号；加多一个按钮：当前预设重置" */
must('预设被改会打星号', shell.includes('presetIsDirty') && shell.includes('presetDirty ? " *"'),
	'改了参数却还显示原预设名，用户以为还是原样');
must('有当前预设重置', shell.includes('setCfg(presetPatch(activePreset))'),
	'只有"全部重置"的话，想还原一个预设得连带别的设置一起清');
must('星号只统计预设字段', presets.includes('export function presetIsDirty') && presets.includes("k === 'preset'"),
	'把交互/标签也算进去，调个标注也会打星');

console.log('\n首帧与面板\n');
/* 2026-11-01："首次打开不要等加载完再出来，跟烟火扩展一样" */
must('布局分步推进', layout.includes('o.stepwise') && rend.includes('function stepLiveLayout'),
	'等全部 tick 跑完才出图 = 点进来先看空白');
must('分步每帧有上限', rend.includes('const budget = 26'), '一帧跑几百 tick 还是会卡住主线程');
must('分步隔帧刷线', rend.includes('linkSyncTick') && rend.includes('(linkSyncTick & 1) === 0'),
	'6000 条边的 buffer 每帧重传 864KB，光上传就把帧率拉下来了');
must('点尺寸有上限', /Math\.max\(24, Math\.min\(70/.test(rend),
	'放大时每点 240px ×1200 个 = 满屏 overdraw，必掉帧');
must('观赏按钮是👁️且带灰度', shell.includes('👁️') && shell.includes('grayscale(1)'),
	'未激活要黑白、激活要彩色');
must('设置面板默认收起', shell.includes('设置面板默认收起'), '一进来就挡住星图');
must('复位和设置归一类', shell.includes('data-memorysea-reset-btn'), '复位是单击按钮，不该混在激活态里');
must('有悬浮详情开关', shell.includes('data-memorysea-hoverdetail-btn') && rend.includes('onHoverDetail'),
	'要能悬浮看内容，不点');
must('悬浮详情在工具栏里', shell.includes('"ⓘ 悬浮详情"') && !shell.includes('bottom: 38'),
	'飘在外面压住工具栏不算放进去');
must('重置按钮四个字', shell.includes('"重置本预设"') && shell.includes('"重置系统"'),
	'"本预设"/"全部" 是在给谁读');
/* ★ 2026-11-01：点「重置系统」反而打上星号 —— 因为 CFG_DEFAULT 和
   presetPatch(galaxy) 本来就不完全一样，重置后 cfg 必然"偏离预设"。 */
must('重置后不打星', shell.includes('presetPatch(presetById(CFG_DEFAULT.preset))'),
	'只 setCfg(CFG_DEFAULT) 的话，重置完立刻显示"已改"');
must('观赏模式藏周边', shell.includes('(dockOpen && !liveCfg.readOnly)'),
	'观赏模式屏幕上只该剩一个按钮');
must('观赏模式只留观赏按钮', shell.includes('roHideStyle') && shell.includes('visibility: "hidden"'),
	'用 display:none 会让观赏按钮跳位置；要原位置原样式地隐形兄弟元素');
must('观赏模式底板也隐形', shell.includes('border: "1px solid transparent"'),
	'只藏按钮不藏底板，那块半透明底还杵在那儿');
/* ★ 2026-11-01：用户否掉了"鼠标进卡片就不关"。改成：再点一下这颗星就锁住。 */
must('悬浮详情再点可锁', shell.includes('detailLockedRef.current = true'),
	'不锁的话，鼠标从星点挪到卡片路上就关了，永远点不到「深探」');
must('锁住后 hover 不再关', /if \(detailLockedRef\.current\) return;/.test(shell),
	'锁了还响应 hover 等于没锁');
must('点空白解锁', shell.includes('detailLockedRef.current = false'), '点空白应该回到"移开就关"');

console.log('\n预设与配色\n');
must('8 套预设', (presets.match(/name: '/g) || []).length >= 8, '预设数量不足');
must('6 套配色', (presets.match(/id: '/g) || []).length >= 6, '配色数量不足');
must('配色洗牌', presets.includes('seededShuffle'), '洗牌函数没了');
must('日记金色', presets.includes('DIARY_RGB'), '日记配色被改');

/* ★★ 2026-11-01 两个真病灶：
   ① toGraph 每次新建节点、坐标是 (0,0,0)，深探 rebuild 时 warmStart 保住的是这堆 0
      → 300 tick 从原点跑不完 → position 本身就没收敛 → "一堆线堆着，动画里慢慢拉开"
   ② 老节点和新节点同层 → 滑动和生长糊在 2.6 秒里，没有先后 */
must('回填旧坐标再布局', rend.includes('bn[k].x = p.x'),
	'不回填 = warmStart 从原点出发，结构算不完就播动画');
must('旧坐标回填在布局之前', rend.indexOf('bn[k].x = p.x') < rend.indexOf('radius = runLayout(built'),
	'先布局再回填就白填了');
/* ★★ 当前形态（用户拍板："对就是这个效果"）：
   ① 结构同步算完 → ② 新节点 alpha=0 完全不可见 → ③ 分 3 批渐显。
   **位置全程不动**，所以不存在"边播边改结构"的中间态。
   （试过两段串行让老节点滑过去，用户喊停，已回退。） */
must('深探位置不移动', !rend.includes('(fx - px) * 0.2') && !rend.includes('sx = px + (fx - px)'),
	'让点从父节点挪过去 = 动画里还在改结构');
must('老节点不参与动画', rend.includes('layerAttr.setX(i, -1)'),
	'老节点也播动画 = 整片老树在动，看着像结构还没算完');
must('新节点分批渐显', rend.includes('SUB_BATCH') && rend.includes('Math.floor((seen / count) * SUB_BATCH)'),
	'深探新增全是一个层级，不切批就是一坨同时亮');
must('一次 armMorph 播完', !rend.includes('morphStage2'),
	'两段串行已回退，别再拆成两段');

/* ★ 2026-11-01 详情卡两个 bug：
   ① 索引里 userLen/assistantLen 只记在轮次上，会话从没汇总 → 永远"你/她 0/0 字"
   ② kvRow("工具", kind === "record" && toolName) 对会话求值成 false → 渲染出字面量 "false" */
must('会话汇总字数', live.includes('const agg = new Map()') && live.includes('userLen: agg.has(s.id)'),
	'不汇总的话，会话详情永远 0/0 字');
must('工具行不渲染 false', !shell.includes('kvRow("工具", detail.point.kind === "record" && detail.point.toolName)'),
	'false 被当内容渲染出来了');

console.log('\n结构层级筛选\n');
/* 2026-11-01："加上：对话、会话（由于是根，所以要选择，具体如何做你设计）" */
must('有对话层开关', shell.includes('showTurn') && rend.includes('c.showTurn !== false'),
	'关掉对话层应该只留会话星（概览视图）');
must('会话用选择不用开关', shell.includes('hiddenSessions') && shell.includes('pickList'),
	'会话是根，一个总开关关掉等于整张图全没');
must('藏会话连带整棵树', rend.includes('hidden.has(p.sessionId)'),
	'只藏根点、子孙还在，会剩一堆无主的枝');
must('关对话连带消息', rend.includes("!showTurn && (p.kind === 'turn' || p.kind === 'record')"),
	'轮次没了但消息还挂着，等于一堆散点');
/* 2026-11-01："隐藏后还能点击还能悬浮详情" —— 看不见的点不能可拾取 */
must('隐藏的点不可拾取', rend.includes('if (showArr && showArr.array[i] < 0.5) continue;'),
	'aShow=0 的点 CPU 这边照样算得出坐标，不跳过就能点中看不见的星');
/* 2026-11-01："扩展上限。最多 10000 条，最多 100 字"
   ★ 滑杆上限和 clamp 上限必须一致，否则滑到底会被悄悄压回去 */
must('标签上限 10000 条', shell.includes('max: 10000') && /Math\.min\(10000, lm\)/.test(rend),
	'滑杆和 clamp 的 10000 不一致就会"滑到底没反应"');
must('标签上限 100 字', shell.includes('max: 100, step: 1') && /Math\.min\(100, lc2\)/.test(rend),
	'上限卡在 28 字');
/* ★ 2026-11-01："切换没有任何区别" —— 会话/轮次的 point 上没有 text 字段，
   content 分支退回 title 就和 name 一模一样了 */
must('内容模式有真内容', rend.includes('p.digest || p.subtitle') && rend.includes('p.subtitle || p.title'),
	'退回 title 的话，名称/内容两个按钮完全一样');
must('会话带 digest', live.includes('digest: (agg.get(s.id) || {}).digest'),
	'会话没 digest，「内容」模式只能显示标题');
/* ★ 2026-11-01："消息开了没有东西" —— 原来 focal < 0 时一条 record 都不给 */
must('消息标签不依赖悬停', rend.includes('MAX_RECORD_CANDS') && rend.includes('recSeen % recStep === 0'),
	'不悬停就一条都不出，用户会以为开关坏了');
/* ★ 2026-11-01："可重叠，加一个按钮…一缩小就会损失很多东西" ——
   避让在缩小时会把标签几乎全丢掉，需要一个"全画"模式 */
must('有重叠开关', shell.includes('labelOverlap') && rend.includes('if (!labelOverlap)'),
	'没有这个开关，缩小后标签会被避让吃光');
must('默认仍避让', shell.includes('labelOverlap: false'), '默认就重叠的话画面一开始就是糊的');

console.log('\n首屏数据完整性\n');
/* ★ 2026-11-01："加载数据不太全，有些会话就一个点…再刷新插件又可以了"
   索引在 apply() 后 4 秒才跑，前端只拉一次 = 必然拿到半截数据。 */
must('按 phase 轮询重拉', shell.includes('lastPhase') && shell.includes('phase === "ready"'),
	'只拉一次的话，索引没跑完就永远是残缺图');
must('ready 后平滑替换', shell.includes('noGrow: true, keepCamera: true, ticks: 80'),
	'补数据时重播入场动画 = 用户正看着突然整图炸开重来');
must('索引期间显示进度', shell.includes('正在索引 '),
	'补数据那十几秒没有任何反馈');
/* ★ 2026-11-01："比如这个好像没有获取到" —— 其实宿主那边就是空的。
   原来会话正文退回 title（= shortId），卡片上显示一串 "ea7deb01"，看着像读取失败。 */
must('空会话不显示 id 当正文', shell.includes('这个会话在宿主里没有任何对话记录'),
	'把 id 碎片当正文，用户会以为是我们的 bug');
must('空会话亮出标识', shell.includes('add("标识"'),
	'空会话要能回溯到底是哪一个');

console.log('\n排除元素\n');
/* 2026-11-01："用户只需填 id 或 class 类名就行了，就能排除掉了" */
must('有排除输入框', shell.includes('excludeSelectors') && shell.includes('excludeBox'),
	'宿主 DOM 结构不可预知，交给用户填最省事');
must('用注入样式不改 inline', shell.includes('data-memorysea-exclude') && !shell.includes("el.style.display = 'none'"),
	'改宿主元素的 inline style 会被它自己的渲染覆盖，也不保证还原');
must('不藏到自己', shell.includes('el.contains(mine)'),
	'填错一个 .panel 就把星图也藏了，界面直接空白');
must('清空即恢复', shell.includes('setCfg({ excludeSelectors: "" })'),
	'没有出口的话，藏掉的东西永远回不来');
/* ★ 2026-11-01："这个系统级别设置，你为什么放画布渲染设置里面" ——
   排除元素改的是宿主界面，不是星海渲染参数，属于系统级，必须待在设置页。
   注意：只认 JSX 里的 `style: S.excludeBox`，样式表里那个同名 key 不算。 */
must('排除不在画布控制台',
	!shell.slice(0, shell.indexOf('export function SettingsPage')).includes('style: S.excludeBox'),
	'系统级设置塞进渲染控制台，归类是错的');
must('排除在设置页',
	shell.indexOf('style: S.excludeBox') > shell.indexOf('export function SettingsPage'),
	'要放在「设置 → 记忆海」里');
/* 2026-11-01："名字严格。执行后说个数" */
must('选择器严格不猜', !shell.includes('只写名字也行'),
	'替用户猜 # 还是 . 会藏掉意外的东西');
must('应用后有命中数', shell.includes('setExcludeHit') && shell.includes('" 个元素"'),
	'点了没反应，用户不知道到底藏了几个');

console.log('\n关于\n');
/* 2026-11-01："设置加上关于项：版本 + 开源地址" */
must('设置页有关于卡片', shell.includes('"关于"') && shell.includes('APP_VERSION'),
	'没有版本信息，用户报 bug 都没法说是哪个版本');
must('版本来自构建注入', shell.includes('__MS_VERSION__') && !/APP_VERSION\s*=\s*"\d/.test(shell),
	'手写版本号迟早和 package.json 对不上');
must('开源地址可点', shell.includes('APP_REPO') && shell.includes('data-memorysea-about'),
	'要能直接点开仓库');

console.log('\n重置职责隔离\n');
/* 2026-11-01："点重置系统为什么连系统设置里面的东西也重置了"
   画布控制台的「重置系统」只管渲染参数；fullBleed / bgColor / bgAlpha / bgBlur /
   excludeSelectors 由「设置 → 记忆海」页负责，那边有自己的「全部恢复默认」。 */
must('系统键有明确定义', shell.includes('SYSTEM_KEYS = ["fullBleed"') && shell.includes('"excludeSelectors"]'),
	'不列出来的话，改一次功能就会又被一起重置');
must('重置系统保留系统键', shell.includes('for (const k of SYSTEM_KEYS)'),
	'画布控制台跨界面清空系统设置，属于职责越界');
must('按钮标题写明范围', shell.includes('不动「设置 → 记忆海」里的系统项'),
	'标题不写清楚，用户不知道它到底重置了什么');

console.log('\n画布跟随布局\n');
/* 2026-11-01：截图里左侧一大块空白 —— 侧边栏收起后面板位置变了，
   但 ResizeObserver 只盯尺寸，place() 只在挂载后轮询 5 秒就停了。
   这是很早就存在的缺陷（backup/shell.20261101-1934.js 里是同样的写法），不是新引入的。 */
must('几何变化才写样式', shell.includes('if (key === lastGeom) return;'),
	'每 800ms 无条件写 style 会触发无谓重排');
must('常驻低频跟随', shell.includes('const watch = setInterval(place, 800)'),
	'只轮询前 5 秒，侧边栏一收起画布就不跟了');
must('跟随定时器会被清理', shell.includes('clearInterval(watch)'),
	'不清理会随组件卸载泄漏');

console.log('');
if (bad) {
	console.log('✗ ' + bad + ' 项断了');
	process.exit(1);
}
console.log('✓ 全部功能链路完整');
