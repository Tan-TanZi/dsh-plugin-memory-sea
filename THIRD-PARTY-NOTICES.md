# 第三方代码与许可

本项目包含或移植了以下第三方作品。分发时请同时保留本文件与其原始许可声明。

---

## 移植的代码

### galaxy-view

- **地址**：https://github.com/Longwind1984/galaxy-view
- **许可**：MIT
- **用在哪**：`src/galaxyForces.js`
- **范围**：`forceRadialCore`（径向核心引力）与 `forceSpiral`（切向旋臂力）
  移植自该项目的 `src/layout/galaxyForces.ts`，公式与量纲保持一致。
  本项目把 d3 的 `Force` 对象改写成「直接读节点数组、直接写速度」的普通函数，
  以便接入自己的积分循环，**数学部分未改动**。
- **作用**：星系观感的核心。没有这两个力，布局会退化成一团均匀的球。

原项目的 MIT 许可要求保留版权声明。若你二次分发本项目，请一并保留上述链接与署名。

---

## 打包进产物的依赖

以下依赖在构建时被 esbuild 内联进 `lib/client.js`，不单独分发文件，
但其代码存在于产物中。

### three.js

- **地址**：https://threejs.org/
- **许可**：MIT
- **用在哪**：渲染（WebGL 渲染器、Points、LineSegments、EffectComposer、UnrealBloomPass、OrbitControls）

### d3-force-3d

- **地址**：https://github.com/vasturiano/d3-force-3d
- **许可**：ISC
- **用在哪**：力导向布局的积分器与碰撞检测（`src/layout.js`）

---

## 仅作灵感参考

### 3d-memory-sea

- **地址**：https://github.com/asdfd3r/3d-memory-sea
- **关系**：本项目的**最初想法**来源（把记忆画成三维星海）。
  代码、数据结构、渲染管线均为独立实现，未复制该项目代码。

---

## 许可全文

`three.js` 与 `galaxy-view` 使用 MIT，`d3-force-3d` 使用 ISC。两种许可均要求：

- 保留原版权声明与许可声明
- 软件按「原样」提供，不附带任何明示或暗示的担保

MIT 全文见本项目 [LICENSE](LICENSE)（与本项目自身许可相同）。
ISC 与 MIT 条款实质等价，差异仅在措辞。
