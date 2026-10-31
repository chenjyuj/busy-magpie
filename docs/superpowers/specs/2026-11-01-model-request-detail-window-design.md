# 模型请求明细浮窗（Model Request Detail Window）设计

- 日期：2026-11-01
- 状态：**待评审**（评审通过前不进入实施）
- 需求来源：用户本轮需求——「点击模型名称，弹窗显示该 provider 的模型的请求列表，显示每个请求的时长、首字节时、token每秒、状态」
- 相关文档：`docs/superpowers/specs/2026-10-31-provider-grouped-model-list-design.md`（主卡片 v1.6.0）

## 1. 背景与目标

主卡片每个（provider, 模型）只显示**最近一次**请求。当某次请求变慢、报错或改道时，用户看不到它是否偶发、是不是一直如此。

目标：点击卡片上的模型行，打开一个**独立浮窗**，列出该 provider 下该模型的**每一次请求**，逐行给出时间、时长、首字节、token/s 与状态；列表实时追加，可分批加载。

成功标准：

- 一次点击就能看到该模型最近 20 次请求的逐条表现，并能继续加载更早的；
- 浮窗出现后不影响卡片的实时性与既有交互（卡片仍可点其他模型切换明细）；
- 明细的判定口径（状态、缺失值、速度）与主卡片**完全同源**，不出现两套算法漂移。

## 2. 非目标（YAGNI）

- 不做账号列、改道次数列、统计行（用户明确从简）；
- 不做导出、复制、单请求更细内容（token 明细、prompt、trace id 详情）；
- 不做「点组头看该 provider 全部模型的请求」；
- 不做多个浮窗并存；
- **不持久化**浮窗位置与尺寸（位置每次由卡片推算，尺寸每次回到默认）；
- 不做脱离卡片独立存在的浮窗（跟随卡片隐藏/关闭）；
- 不改动主卡片的现有布局、分组口径与额度条。

## 3. 现状与约束（已核实）

| 事实 | 位置 | 对本设计的影响 |
| --- | --- | --- |
| 主进程维护合并路由表，上限 220 条、超限裁剪到 200 条（丢最旧的已完成） | `src/main.js:1389-1409` | 渲染层已持有每个模型的多条历史请求，**不需要新增持久化或历史存储** |
| `win` 是全局单窗口，`showWindow/hideWindow/applyPointerInput/applyTopmost/watchHover/send()` 均只处理它 | `src/main.js:321-368, 759-1000` | 新窗口必须自管生命周期，并在这些入口挂接 |
| `applyPointerInput()` 恒为 `setIgnoreMouseEvents(false)`：整卡片始终阻挡点击；`setFocusable()` 才取决于 `settingsOpen/quickMenuOpen/layoutMode/drag/resize/hoverInteractive` | `src/main.js:759-765` | 模型行**鼠标点击天然可用**；但要让键盘 Tab 进来，行必须登记进 `hitAreas.controls`（`watchHover` 用它算 `hoverInteractive`，见 `src/main.js:953-973`） |
| 渲染层通过 `busy:hit-areas` 上报控件/缩放/拖动条矩形 | `src/main.js:975-993`、`web/app.js` | 新增行控件矩形只需并入现有上报结构 |
| 卡片窗口材质已固定为 `kind:'none'`（`transparent: true, roundedCorners: false, hasShadow: false`），卡片自身浅灰不透明 | `src/window-material.cjs` | 浮窗复用同一材质与视觉语言，不需要新的平台分支 |
| 卡片窗口是 frameless 且自绘缩放的（因为它要点击穿透） | `src/main.js`、`web/app.js` | 浮窗**不需要**点击穿透，因此直接用 Electron 原生 `resizable: true` 拖边，省掉整套命中区/自绘缩放 |
| 现有 UI 回归用 `browser-window-created` 抓窗口并 monkey-patch：`win = created`（后创建的会覆盖先创建的） | `tests/ui/model-list.cjs`、`pointer-input.cjs`、`drag-bounds.cjs`、`glass-composition.cjs` | 浮窗一出现，这些 harness 会把浮窗当成卡片 → **必须一并改造**（见 §10.3） |
| body 级 `window-all-closed` 为空实现（托盘常驻）；托盘隐藏、`quit()`、更新安装均只处理卡片 | `src/main.js:1648, 1958-1965` | 浮窗需要在托盘隐藏/退出/更新前关闭 |

## 4. 决策记录

| # | 决策 | 选择 | 理由 |
| --- | --- | --- | --- |
| D1 | 呈现形态 | **独立浮窗（新 BrowserWindow）** | 用户选择；可在卡片外看，空间不受 600×400 限制 |
| D2 | 技术方案 | **独立页面 + 主进程推送**（方案 B） | 卡片渲染层零改动（只加点击入口），新窗口复杂度锁在独立页面里；实时性复用主进程已有推送点 |
| D3 | 位置 | 每次打开时由卡片位置推算，**不持久化** | 用户选择「位置自动跟随卡片」；同时避免新增 `settings.json` 字段 |
| D4 | 尺寸 | 默认 420×520，**可原生拖边缩放**，**关掉即忘** | 用户选择「可缩放但不记住尺寸」（早先同时勾选"固定尺寸"与"可缩放"的冲突由此消解：默认尺寸固定、内容超出内部滚动、允许用户临时改大小） |
| D5 | 生命周期 | 跟随卡片：卡片隐藏即关闭，退出/更新前关闭 | 用户选择「跟随卡片隐藏/关闭」，避免桌面残留孤儿窗口 |
| D6 | 卡片交互 | 浮窗打开期间卡片仍可点，**点其他模型名即切换浮窗内容**（窗口复用） | 用户选择；连续查看多个模型不必反复开关 |
| D7 | 列表列 | 时间 `HH:MM:SS` + 时长 + 首字节 + tok/s + 状态 | 用户指定四项，并补充时间列以便区分先后 |
| D8 | 分页 | 每页 20 条，「加载更多」再 +20，加载完按钮隐藏 | 用户明确「上限20条，点击加载更多，可以再加载20条」 |
| D9 | 实时性 | 新请求实时置顶追加，**保持已加载条数不变** | 用户选择实时；保持条数使"加载更多"语义稳定，不被数据流重置 |
| D10 | 口径同源 | 抽 `web/route-facts.mjs` 共享判定，卡片与明细共用 | 避免两处 `statusOf`/速度口径各写一份后漂移（本次顺带整理，不改行为） |

## 5. 架构

### 5.1 组件与职责

| 单元 | 职责 | 依赖 | 不做什么 |
| --- | --- | --- | --- |
| `web/route-facts.mjs`（新增，纯函数） | 从一条 route 提取事实：实际服务模型、provider 键、seat、状态、改道数、测量值、时间戳、排序比较器 | 无（`timing.mjs` 只用于速度） | 不持有状态、不碰 DOM |
| `web/requests.mjs`（新增，纯函数） | 按（provider, 模型）过滤 + 倒序 + 分页切片，产出明细行 | `route-facts.mjs`、`timing.mjs` | 不做 DOM、不做 IPC |
| `web/model-sessions.mjs`（改） | 主卡片分组（行为不变），改为从 `route-facts.mjs` 取共享判定 | `route-facts.mjs` | — |
| `web/detail.js`（新增，渲染层） | 浮窗页面：标题、表头、行渲染、分页按钮、实时重算、关闭按钮、Esc | `requests.mjs`、`presenter.js` | 不轮询网关（数据由主进程推）、不管窗口 |
| `web/detail.html`（新增） | 浮窗骨架 | `styles.css` | — |
| `src/detail-placement.cjs`（新增，纯函数） | 由卡片矩形与工作区算出浮窗位置 | 无 | 不碰 Electron API |
| `src/main.js`（改） | 浮窗创建/复用/定位/跟随/关闭、IPC、实时推送 | — | 不在主进程里做过滤/分页（那属于渲染层纯函数） |
| `src/preload.js`（改） | 暴露 4 个通道 | — | — |

### 5.2 窗口与生命周期

浮窗 `detailWin` 创建参数：

```js
new BrowserWindow({
  width: 420, height: 520, minWidth: 360, minHeight: 300,
  frame: false, resizable: true, maximizable: false, minimizable: false, fullscreenable: false,
  show: false, skipTaskbar: true, parent: win,
  alwaysOnTop: settings.topmost, backgroundColor: '#00000000',
  ...MATERIAL.options,                       // 恒为 { transparent: true, roundedCorners: false, hasShadow: false }
  title: 'Busy Magpie · 请求明细',
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false,
                    spellcheck: false, backgroundThrottling: false },
});
```

- **复用**：`openDetail()` 时若 `detailWin` 存活，只更新查询并推数据，不重建窗口（D6）；再次点击**同一个**模型行 → 内容不变（同样走复用路径，不分叉逻辑）；
- **跟随卡片**：监听卡片 `move`/`resize` → 合并到一次重算（避免拖动时每像素计算）；卡片 `hide` → 关闭浮窗（D5）。
- **置顶**：`applyTopmost()` 内同步浮窗的 `setAlwaysOnTop(settings.topmost, IS_MAC ? 'floating' : 'normal')`；`parent` 关系保证浮窗始终在卡片之上。
- **关闭路径**：浮窗 × 按钮、Esc、卡片隐藏、`quit()`、更新安装前；关闭后清空 `detailWin` 与 `detailQuery`，并处理 `closed` 事件兜底。
- **不主动关闭的情形**：卡片打开设置/关于面板、切进/切出紧凑模式、切到托盘菜单——浮窗保持打开并随卡片移动（卡片位置变化由 `move`/`resize` 跟随重算）。
- **不做**：位置/尺寸持久化、多浮窗、脱离卡片存在。

### 5.3 定位算法（`src/detail-placement.cjs`）

```js
placeDetail({ width, height }, cardBounds, workArea, gap = 12) → { x, y }
```

1. 首选右侧：`x = card.x + card.width + gap`；
2. 若 `x + width > workArea.right` → 改左侧 `x = card.x - gap - width`；
3. 左侧仍越界 → 夹取到 `workArea.x`；
4. `y = card.y`，若下沿越界则上移，最终夹取在 `[workArea.y, workArea.bottom - height]`；
5. 返回整数像素（`Math.round`）。

工作区取**卡片所在显示器**：`screen.getDisplayMatching(win.getBounds()).workArea`（多屏不跑偏）。

### 5.4 IPC 通道

| 通道 | 方向 | 载荷 | 用途 |
| --- | --- | --- | --- |
| `detail:open` | 卡片 → 主 | `{ providerKey, model, providerName }` | 打开或切换浮窗内容 |
| `detail:close` | 浮窗 → 主 | — | × / Esc 关闭 |
| `detail:ready` | 浮窗 → 主 | — | 页面加载完主动索取首帧（避免竞态） |
| `magpie:detail` | 主 → 浮窗 | `{ query, routes }` | 首帧与后续实时数据（routes 为主进程合并表，≤200 条） |

`preload.js` 新增：`openDetail(query)`、`closeDetail()`、`onDetail(handler)`、`detailReady()`。

推全量 routes 而不做服务端分页的理由：过滤/分页是纯函数（可单测）、"加载更多"零 IPC、实时追加只需重算；数据量与卡片每轮已收的同一份，无新增量级。

### 5.5 数据流时序

```
用户点模型行
   → 卡片 openDetail({providerKey, model, providerName})
   → 主进程：无窗口则建窗 + loadFile(detail.html)；有窗口则复用并更新 query
   → 浮窗 DOMContentLoaded → detailReady()
   → 主进程推 magpie:detail（当前合并表）
   → 浮窗 requests.modelRequests() 过滤+分页 → 渲染
   → 之后每次 trace 合并：卡片收到 magpie:trace 的同时，浮窗收到 magpie:detail
   → 浮窗重算（pages 不变）→ 顶部插入新请求
关闭：浮窗 ×/Esc → detail:close → 主进程 close() → closed 事件清理
```

## 6. 数据模型

### 6.1 `web/route-facts.mjs` 抽取清单（纯搬运，不改行为）

从 `web/model-sessions.mjs` 原样迁出并导出：`timestamp`、`numericId`、`newest`（排序比较器）、`servedModel`、`measured`、`rerouteCount`、`statusOf`、`seatOf`、`quotaOf`；新增 `providerKeyOf(route)`（= `seat.provider || route.provider` 小写，空则 `'magpie'`，即现有 `model-sessions.mjs:81` 的表达式）。

**约束**：`model-sessions.mjs` 改为从这里导入后，`tests/model-sessions.test.mjs` 必须全绿且断言不变——抽取是重构，不是行为变更。

### 6.2 `web/requests.mjs`

```js
modelRequests(routes, { providerKey, model, pages = 1, pageSize = 20 })
  → { rows, total, shown, hasMore, providerName }
```

- 过滤：`providerKeyOf(route) === providerKey && servedModel(route) === model`；
- 排序：`newest` 比较器（时间倒序，id 决胜 → 与数组顺序无关，结果稳定）；
- 切片：`rows = sorted.slice(0, pageSize * pages)`；`total = sorted.length`；`hasMore = total > rows.length`；
- `providerName`：**优先用查询里带的显示名**（`detail:open` 的 `providerName`，即卡片组头上那个名字），为空时回落为"该 provider 最新一条 route 的 seat 名字"，再为空则用 `providerKey`。三者优先级明确，避免标题与卡片组头显示不一致；
- 行结构：

```js
{
  id,          // route.id，渲染层做 key
  at,          // ISO 原文
  clock,       // 'HH:MM:SS' 本地时区，手写补零
  ms,          // number | null
  ttft,        // number | null
  speed,       // number | null（tok/s）
  status,      // 'ok' | 'live' | 'error'
  reroutes,    // number（数据保留，UI 不渲染）
}
```

- **每行只描述它自己那一次请求**：进行中的行 `ms/ttft/speed` 为 `null`（显示 `—`），**不继承历史**——与主卡片刻意相反（卡片回答"这个模型现在什么状态"，故保留上次指标；明细回答"这单请求发生了什么"，保留即造假账）。两条规则各自有测试钉住。

### 6.3 时间格式

`clock(at)`：解析失败 → `''`（UI 显示 `—`）；否则用本地时区的 `getHours/getMinutes/getSeconds` 手工补零。不依赖 `toLocaleTimeString`（跨机器/跨区域输出不稳定，不便断言）。

## 7. 视觉规格

### 7.1 窗口与卡面

- 与主卡片同源：浅灰不透明卡面 `#f5f5f7`、圆角 16px、白色行卡片、`--ink #1d1d1f` / `--muted #3a3a3c` / `--faint #86868b`；
- 四周留透明边距用于阴影与圆角（与卡片一致），原生缩放边框落在窗口边缘；
- 行高 34px、行间距 6px、行圆角 10px；标题栏 34px；字号 12–13px；时间与数值用等宽字体；
- 窗口可缩放：列宽自适应、**无横向滚动**；列表区域 `overflow-y: auto`（细滚动条，配色匹配浅色主题）。

### 7.2 标题栏与表头

```
OfficeAce · glm-5.3                                    ×
时间       时长      首字节    tok/s     状态
```

- 标题左侧 = `providerName` · 模型名；右侧 = 关闭按钮（`aria-label="关闭请求明细"`）；
- 表头列与行同栅格：`grid-template-columns: 62px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 54px`（时间固定、中间三列等分、状态固定）；
- 标题栏也是拖动区：`-webkit-app-region: drag`（按钮设 `no-drag`），让浮窗可被拖动——**注意**：位置在卡片移动时会被重算覆盖，因此拖动只影响当前会话，下次打开仍回默认位置（与 D3 一致，需在文档说明，避免"拖了又弹回"被误判为 bug）。

### 7.3 行与状态

- 行内容：`14:32:07 | 3.0 秒 | 600ms | 100 tok/s | ● 完成`；
- 缺失指标一律 `—`（不出现 `0ms`/`0 tok/s`）；
- 状态色沿用卡片：完成 `#34c759`、进行中 `#007aff`、错误 `#ff3b30`；错误行状态文字「错误」，进行中「进行中」；
- 行悬停仅轻微背景变化；**不显示账号**（D7 从简）。

### 7.4 分页与实时

- 初始 `pages = 1`（20 条）；「加载更多」→ `pages += 1` 重算渲染；`hasMore === false` 时按钮隐藏；
- 实时：收到新 `magpie:detail` 即重算，**`pages` 不变** → 始终显示"最新 20×pages 条"，最早的滑出；
- 空态：该模型在 trace 窗口内无请求 → 列表区显示「这个模型还没有请求」，按钮隐藏。

## 8. 键盘与可达性

- 卡片模型行：`role="button"` + `tabindex="0"` + `aria-label="查看 {provider} 的 {模型} 请求明细"`；Enter/Space 打开（与鼠标点击同一入口）；
- **行矩形并入 `hitAreas.controls` 上报**（否则 `hoverInteractive` 不成立 → 窗口不可聚焦 → 键盘进不来；鼠标点击不受影响，见 §3）；
- 浮窗：Esc 关闭；「加载更多」可 Tab 聚焦；关闭按钮可聚焦；
- 行可点击后**保留**原有悬停 `title` 明细（账号/时间/改道/tok-s 追加信息）。

## 9. 文件变更清单

**新增**：`web/route-facts.mjs`、`web/requests.mjs`、`web/detail.html`、`web/detail.js`、`src/detail-placement.cjs`、`tests/requests.test.mjs`、`tests/detail-placement.test.cjs`、`tests/ui/detail-window.cjs`、`docs/test-cases/2026-11-01-model-request-detail-test-cases.md`（实施阶段产出）。

**修改**：
- `src/main.js`：浮窗创建/复用/定位/跟随/关闭、置顶同步、IPC handlers、trace 推送点追加浮窗推送、托盘隐藏/`quit()`/更新前关窗；
- `src/preload.js`：4 个通道；
- `web/app.js`：模型行改为可聚焦按钮 + 点击调 `openDetail` + 行矩形并入 `hitAreas.controls`；
- `web/styles.css`：行可点击态（hover 背景、`cursor: pointer`、焦点轮廓）+ 新增 `.detail-*` 区块；
- `web/model-sessions.mjs`：改为从 `route-facts.mjs` 导入共享判定（行为不变）；
- `tests/ui/model-list.cjs`、`pointer-input.cjs`、`drag-bounds.cjs`、`glass-composition.cjs`：窗口捕获改为"只认第一个（卡片）窗口"；
- `README.md`：新增「请求明细浮窗」小节（含"每行=一次请求"与"进行中不继承"的口径说明）。

**不改**：`web/index.html`（行由渲染层生成）、`src/window-material.cjs`、额度条与分组逻辑、`settings.json` 结构（无新字段）。

## 10. 测试策略

### 10.1 单测（`node --test`）

`tests/requests.test.mjs`（新增）：
1. 只返回该 provider + 该模型的请求，其他 provider 同名模型不混入；
2. 时间倒序，且同秒时 id 决胜（数组顺序打乱结果不变）；
3. 分页：总量 25 → pages=1 显示 20、`hasMore=true`；pages=2 → 25、`hasMore=false`；
4. 总量小于一页 → 全部显示且 `hasMore=false`；
5. 进行中请求三项为 `null`（**不继承历史**；与卡片相反，两个模块各自断言）；
6. 错误优先：`status>=400` 或带 `error` → `'error'`；
7. 缺失 `ms` 但有 `ttft`：各自独立判定；
8. `clock` 为本地 `HH:MM:SS`；非法时间 → 空；
9. 空 routes / 未命中模型 / 字段缺失不抛异常；
10. `providerKey` 兜底 `'magpie'`（route 与 seat 都没有 provider）。

`tests/detail-placement.test.cjs`（新增）：右侧放得下；右侧放不下翻左侧；两侧都放不下夹取；垂直越界上下夹取；多显示器工作区原点非 0 时正确；返回值整数。

`tests/model-sessions.test.mjs`：**必须全绿且不加断言**（证明 §6.1 抽取未改行为）。

### 10.2 UI 回归（真实 Electron，`tests/ui/detail-window.cjs` 新增）

1. 点模型行 → 出现第二个窗口，标题为 `provider · 模型`；
2. 行数 = `min(20, 总数)`；列内容与格式（时间/时长/首字节/tok·s/状态）；
3. 喂 25 条 → 20 行 + 「加载更多」→ 点击后 25 行 + 按钮消失；
4. 实时：再推一条新请求 → 顶部插入，总行数保持（已加载窗口不变）；
5. 进行中的新请求 → 该行 `—`/进行中，**不是**继承值；
6. 位置：浮窗左边缘 ≈ 卡片右边缘 + 12；卡片移到底边显示器时翻到左侧；
7. 跟随：改卡片 bounds 后浮窗位置随之更新；
8. 关闭三路径：Esc、×、卡片 `hide()` → 浮窗均关闭；
9. 卡面/行配色（`rgb(245,245,247)` / `rgb(255,255,255)`）；
10. 切换模型：点另一个模型行 → 浮窗内容替换，窗口数仍为 2（复用）。

### 10.3 既有 harness 改造（必须同批完成）

现有 `tests/ui/*.cjs` 里 `app.on('browser-window-created', (_e, created) => { win = created; ... })` 会被浮窗覆盖。改为**只接管第一个创建的窗口**（卡片），并对浮窗不做 `showInactive`/`isVisible` 打桩（或在测试内分别跟踪 `cardWin`/`detailWin`）。改造后 4 个回归（model-list / pointer-input / drag-bounds / glass-composition）必须恢复全绿。

### 10.4 浏览器实测与报告

新增场景截图并入 `docs/reports/`：① 明细首屏（20 条）② 加载更多后（40 条）③ 实时追加后 ④ 含进行中与错误行 ⑤ 浮窗贴卡片右侧（含卡片同框）。用例表新增条目（PG-25 起），沿用现有三层结构（单测 / UI 回归 / 浏览器实测）。

## 11. 验收标准

- [ ] 点击模型行打开浮窗，标题为 `provider · 模型`；
- [ ] 列表逐行给出时间 `HH:MM:SS`、时长、首字节、tok/s、状态；
- [ ] 每页 20 条，「加载更多」+20；加载完按钮隐藏；
- [ ] 新请求实时置顶，且不改变已加载条数；
- [ ] 进行中的行显示 `—` + 进行中（不继承历史）；错误行红点「错误」；
- [ ] 浮窗默认 420×520、可拖边缩放、关掉即忘；位置贴卡片右侧、空间不足翻左、跟随卡片移动；
- [ ] 卡片隐藏 / 退出 / 更新安装前浮窗关闭；
- [ ] 点其他模型行切换浮窗内容且不新开第三个窗口；
- [ ] Esc 与 × 均可关闭；
- [ ] `npm test` 全绿（含新增 2 个单测文件），既有 `model-sessions` 断言未改；
- [ ] 4 个既有 UI 回归在 harness 改造后全绿，新 `detail-window.cjs` 全过；
- [ ] README 与用例表已更新，浏览器报告含新增截图。

## 12. 风险与未决项

| # | 风险/未决 | 应对 |
| --- | --- | --- |
| R1 | 既有 UI harness 的单窗口假设 | §10.3 列为同批必做项；先改 harness 再写新浮动窗口测试 |
| R2 | `parent` 子窗口在 Windows/macOS 的置顶与隐藏语义可能有差异 | 实施时在真机验证；若不达预期，退化为手动 `setAlwaysOnTop` + 卡片 `hide` 时显式关闭浮窗 |
| R3 | 卡片拖动时浮窗跟随抖动 | `move`/`resize` 事件合并为一次重算（`setImmediate` 节流） |
| R4 | 标题栏可拖动与"位置每次重算"的观感冲突 | 文档写明"拖动只影响当前会话"，避免被当成 bug |
| R5 | 透明窗口 + `--disable-gpu` 会话下的截图与缩放 | 沿用现有测试姿势（`--disable-gpu --no-sandbox`，offscreen 截图） |
| R6 | DPI 取整导致位置差 1–2px | 位置不持久化，误差不累积；测试断言用容差（±2px） |
| R7 | 更新安装/重启流程遗留浮窗 | 安装前关闭浮窗，列入实施的清单 |
| R8 | 未决：是否允许点组头看 provider 全量请求 | 当前不做；若需要，扩展 `detail:open` 的查询形态即可（`{ providerKey }` 无 model） |
| R9 | 未决：明细是否显示账号 | 当前不显示；数据结构已保留 `reroutes`，账号可按需从 route 提取 |

## 13. 后续

spec 评审通过后，进入 `writing-plans` 出实施计划（任务拆分、写入范围、依赖顺序、验收命令），再按计划实施。**在 spec 与计划获批前不写实现代码。**
