# 模型请求明细浮窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击卡片模型行打开一个独立浮窗，逐行列出该（provider, 模型）的每一次请求（时间 / 时长 / 首字节 / tok·s / 状态），实时置顶追加，每页 20 条可继续加载。

**Architecture:** 新增独立页面 `web/detail.html` + `web/detail.js` 作为浮窗渲染层；主进程持有浮窗与当前查询，把**已合并的路由表**推给浮窗；过滤/排序/分页全在纯模块 `web/requests.mjs` 完成，主进程不含业务逻辑。浮窗不点击穿透，因此用 Electron 原生 `resizable: true` 拖边，不复制卡片那套命中区/自绘缩放。

**Tech Stack:** Electron 39、原生 ESM 渲染层（无框架）、`node --test` 单测、真实 Electron 的 `tests/ui/*.cjs` 回归、CDP（`tools/cdp.mjs`）浏览器实测。

**Spec:** `docs/superpowers/specs/2026-11-01-model-request-detail-window-design.md`

## Global Constraints

- 卡片渲染层改动最小化：只加"行可点击 + 行矩形并入命中区"，不改分组/额度/布局。
- 判定口径必须同源：状态、测量值、排序比较器一律来自 `web/route-facts.mjs`，禁止在 `requests.mjs` 里另写一套。
- 明细行**只描述自己那一次请求**：进行中时 `ms/ttft/speed` 为 `null`（UI 显示 `—`），**不继承**历史（与主卡片刻意相反）。
- 缺失指标一律 `—`，不出现 `0ms` / `0 tok/s`。
- 隐私：明细不显示账号；不把账号写入日志。
- 时间显示为本地时区 `HH:MM:SS`，手写补零，不用 `toLocaleTimeString`（跨机器输出不稳定、不便断言）。
- `settings.json` **不新增字段**；浮窗位置与尺寸都不持久化。
- 纯模块放 `web/`（ESM，可被渲染层 import）；主进程纯函数放 `src/`（CJS，可被 `node --test` 直接 require）。
- 命令基线（本机无 GPU 会话）：`npm test`；UI 回归 `node node_modules/electron/cli.js tests/ui/<name>.cjs --disable-gpu --no-sandbox`（先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`）。
- 写文件避免 PowerShell `Set-Content -Encoding UTF8`（PS 5.1 会写 BOM，曾导致 `package.json` 解析失败）。
- 文案用中文，与现有 UI 一致（完成 / 进行中 / 错误）。

## Review Focus

1. **卡片被拖到另一台显示器/贴边时打开浮窗** —— 期望用卡片所在显示器的工作区定位，浮窗不跑到屏幕外、不留在旧屏（`screen.getDisplayMatching`）。
2. **网关重启清表（routes 骤降为 0）时浮窗已加载 40 条** —— 期望切到空态「这个模型还没有请求」，不崩、不残留旧行。
3. **同一模型只有 1 条请求时点开，随后实时再来 1 条** —— 期望 2 行、不重复、且已加载条数语义正确（1 页窗口内）。
4. **点开浮窗后把卡片隐藏（托盘/暂停）** —— 期望浮窗关闭；再次点开时不残留旧查询或旧行。
5. **trace 时间为 UTC 偏移（跨午夜）** —— 期望 `clock` 显示本地时间；非法时间显示 `—` 而不是 `NaN:NaN:NaN`。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `web/route-facts.mjs`（新） | 一条 route 的事实提取与共享判定（从 `model-sessions.mjs` 抽出 + 新增 `providerKeyOf`/`clockOf`） |
| `web/requests.mjs`（新） | 按（provider, 模型）过滤、倒序、分页 → 明细行 |
| `web/model-sessions.mjs`（改） | 主卡片分组；改为从 `route-facts.mjs` 取判定（行为不变） |
| `src/detail-placement.cjs`（新） | 纯函数：由卡片矩形与工作区算浮窗位置 |
| `web/detail.html` / `web/detail.js`（新） | 浮窗页面：标题、表头、行、分页、实时、Esc/关闭 |
| `src/main.js`（改） | 浮窗创建/复用/定位/跟随/关闭、IPC、trace 推送、托盘与退出处理 |
| `src/preload.js`（改） | 4 个通道：`openDetail`/`closeDetail`/`onDetail`/`detailReady` |
| `web/app.js`（改） | 模型行可聚焦可点击 → `openDetail`；行矩形并入 `hitAreas.controls` |
| `web/styles.css`（改） | 行可点击态（hover/cursor/focus）+ `.detail-*` 区块 |

---

### Task 1: 共享事实模块 `web/route-facts.mjs`

**Files:**
- Create: `web/route-facts.mjs`
- Modify: `web/model-sessions.mjs:1-72`（改为 import，删除本地副本）
- Test: `tests/route-facts.test.mjs`

**Interfaces:**
- Consumes: `speedInfo` 仍由 `model-sessions.mjs` 直接从 `./timing.mjs` 引入（不搬进 route-facts）。
- Produces: `timestamp(value) → number`、`numericId(value) → number`、`newest(a, b) → number`、`servedModel(route) → string`、`measured(value) → number|null`、`rerouteCount(tries) → number`、`statusOf(route) → 'ok'|'live'|'error'`、`seatOf(route) → object|null`、`quotaOf(seat) → object|null`、`providerKeyOf(route) → string`、`clockOf(iso) → string`。

- [ ] **Step 1: 写失败测试** `tests/route-facts.test.mjs`

断言（用 `node:test` + `node:assert/strict`）：
- `providerKeyOf`：`order[0].provider` 存在时取它并小写；无 `order` 时取 `route.provider`；两者都空 → `'magpie'`。
- `servedModel`：有 `served` 用 `served`；无 `served` 用 `tries.at(-1).model`；都无 → `''`。
- `statusOf`：`status: 500` → `'error'`；`error: '上游 500'` → `'error'`；`done: false` → `'live'`；其余 → `'ok'`。
- `measured`：`0`、`'0'`、`undefined`、`NaN` → `null`；`600` → `600`。
- `rerouteCount`：`[{model:'a'},{model:'b'},{model:'b'}]` → `1`；`[]`/`undefined` → `0`。
- `clockOf`：`'2026-11-01T14:32:07+08:00'` → `'14:32:07'`（本地时区为 Asia/Shanghai）；`'abc'` → `''`；`''` → `''`。
- `quotaOf`：`known:true, used:11, amount:5755, limit:9600, unit:'credits', usedRenews:'2026-11-19T16:00:00Z'` → `{used:11, remaining:89, renewAt:'2026-11-19T16:00:00Z', amount:5755, limit:9600, unit:'credits'}`；`used:0` 但无 `limit` → `null`（假 100% 回归钉子）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/route-facts.test.mjs`
Expected: FAIL —— 找不到模块 `web/route-facts.mjs`。

- [ ] **Step 3: 实现 `web/route-facts.mjs`**

把 `web/model-sessions.mjs` 现有实现**原样搬入**并导出：`timestamp`、`numericId`、`newest`、`servedModel`、`measured`、`rerouteCount`、`statusOf`、`seatOf`、`quotaOf`（含 `quotaOf` 的 `limit <= 0 → null` 契约与既有注释）；新增 `providerKeyOf(route)` = `String(seatOf(route)?.provider || route.provider || '').trim().toLowerCase() || 'magpie'`（即 `model-sessions.mjs:81` 的表达式）；新增 `clockOf(iso)`：`Date.parse` 非法返回 `''`，否则用 `getHours/getMinutes/getSeconds` 补零拼 `HH:MM:SS`。

- [ ] **Step 4: 改 `web/model-sessions.mjs` 为 import**

顶部 `import { timestamp, newest, servedModel, measured, rerouteCount, statusOf, seatOf, quotaOf, providerKeyOf } from './route-facts.mjs';`，保留 `import { speedInfo } from './timing.mjs';`；删除被搬走的本地定义；第 81 行改用 `providerKeyOf(route)`。

- [ ] **Step 5: 跑两条测试**

Run: `node --test tests/route-facts.test.mjs tests/model-sessions.test.mjs`
Expected: 两者全绿，且 `model-sessions.test.mjs` 的**断言文件未被修改**（证明抽取未改行为）。

- [ ] **Step 6: 提交**

```bash
git add web/route-facts.mjs web/model-sessions.mjs tests/route-facts.test.mjs
git commit -m "refactor: share route facts between the card and the upcoming detail list"
```

---

### Task 2: 明细投影 `web/requests.mjs`

**Files:**
- Create: `web/requests.mjs`
- Test: `tests/requests.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `providerKeyOf`、`servedModel`、`measured`、`rerouteCount`、`statusOf`、`newest`、`clockOf`、`timestamp`；`speedInfo` 来自 `./timing.mjs`。
- Produces: `modelRequests(routes, { providerKey, model, pages = 1, pageSize = 20 }) → { rows, total, shown, hasMore, providerName }`；行 = `{ id, at, clock, ms, ttft, speed, status, reroutes }`。

- [ ] **Step 1: 写失败测试** `tests/requests.test.mjs`（Spec §10.1 的 10 条）

要点（每条一个 `test(...)`）：
1. 只返回该 provider + 该模型：喂 `officeace/glm-5.3`、`workbuddy/glm-5.3`、`officeace/deepseek`，查 `{providerKey:'officeace', model:'glm-5.3'}` → 只有 1 条。
2. 倒序且 id 决胜：同秒两条 `id: 2` 与 `id: 9`，**数组顺序反转后结果不变**，`rows[0].id === 9`。
3. 分页：25 条 → `pages:1` 时 `rows.length===20`、`hasMore===true`、`total===25`、`shown===20`；`pages:2` → `rows.length===25`、`hasMore===false`。
4. 不足一页：3 条 → 3 行、`hasMore===false`。
5. **进行中不继承**：一条 `done:false`（`ms` 为空、`ttft:900`）+ 一条完成——查到的进行中行 `ms===null && speed===null`，`ttft` 为 `null` 或该行自己的 900（若该 route 自己有 ttft），**不得等于完成那条的 ms**。
6. 错误优先：`status:500` → `'error'`；带 `error` 文本且 `done:true` → `'error'`。
7. 缺失独立判定：`ms:4200` 无 `ttft`/`out` → `ms===4200`、`ttft===null`、`speed===null`。
8. `clock`：ISO 带 `+08:00` → `HH:MM:SS`；非法时间行 `clock===''`。
9. 空/未命中：`[]`、`undefined`、模型名不匹配 → `rows:[]`、`total:0`、`hasMore:false`，不抛异常。
10. `providerKey` 兜底：route 与 seat 都无 provider → 查 `{providerKey:'magpie'}` 能命中；`providerName` 回落到 `'magpie'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/requests.test.mjs`
Expected: FAIL —— 找不到模块。

- [ ] **Step 3: 实现 `web/requests.mjs`**

过滤 → `newest` 排序 → `slice(0, pageSize * pages)`；`pageSize` 兜底 20、`pages` 兜底 1（非有限数或 <1 时取默认）；`providerName` 取命中集合中**最新一条**的 `seatOf(...).name`，空则回落 `providerKey`；每行用自己的 `measured(route.ms)`、`measured(route.ttft) ?? measured(route.tries?.at(-1)?.ttft)`、`speedInfo(route, route.tries?.at(-1))?.rate ?? null`（与卡片同口径，但**不做**"取最近完成值"的继承）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/requests.test.mjs`
Expected: PASS（10/10）。

- [ ] **Step 5: 提交**

```bash
git add web/requests.mjs tests/requests.test.mjs
git commit -m "feat: project one provider's model requests into a paged detail list"
```

---

### Task 3: 浮窗定位 `src/detail-placement.cjs`

**Files:**
- Create: `src/detail-placement.cjs`
- Test: `tests/detail-placement.test.cjs`

**Interfaces:**
- Produces: `placeDetail(size, card, area, gap = 12) → { x, y }`；`size/card/area` 均为 `{x,y,width,height}`（`size` 只有 `width`/`height`），返回值 `Math.round` 后的整数。

- [ ] **Step 1: 写失败测试** `tests/detail-placement.test.cjs`（Spec §10.1）

1. 右侧放得下：卡片 `{x:100,y:100,width:600,height:400}`、浮窗 `{width:420,height:520}`、工作区 `{x:0,y:0,width:1920,height:1040}` → `{x:712, y:100}`。
2. 右侧放不下翻左侧：卡片 `{x:1400,...}` 同上工作区 → `x === 1400 - 12 - 420 = 968`。
3. 两侧都放不下 → `x === area.x`（夹取）。
4. 垂直下沿越界：卡片 `y:900`、浮窗 520、工作区高 1040 → `y === 1040 - 520 = 520`。
5. 垂直上沿越界：卡片 `y:-50` → `y === 0`。
6. 工作区原点非 0（第二显示器 `{x:1920,y:0,width:1920,height:1040}`）且卡片在该屏 → `x === 1920 + 712`（右侧放得下时）。
7. 返回值都是整数（给 `gap = 12.5`、位置带小数时仍为整数）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/detail-placement.test.cjs`
Expected: FAIL —— 找不到模块。

- [ ] **Step 3: 实现**：先算右侧 `x = card.x + card.width + gap`，越 `area.x + area.width` 则左侧 `x = card.x - gap - width`，仍小于 `area.x` 则夹到 `area.x`；`y = card.y`，下沿越界上移、上沿越界下压，最终夹在 `[area.y, area.y + area.height - height]`；`Math.round` 输出。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/detail-placement.test.cjs`
Expected: PASS（7/7）。

- [ ] **Step 5: 提交**

```bash
git add src/detail-placement.cjs tests/detail-placement.test.cjs
git commit -m "feat: place the detail window beside the card, flipping when it would not fit"
```

---

### Task 4: 卡片入口（行可点、可聚焦、命中区上报）

**Files:**
- Modify: `web/app.js`（`modelRowNode`/`renderProviderGroups` 附近 + 命中区上报）
- Modify: `web/styles.css`（`.model-row` 可点击态）
- Modify: `src/preload.js`（新增 `openDetail(query)` 通道，先只加这一个）
- Test: `tests/ui/detail-window.cjs`（新建，本任务只放"入口"检查）

**Interfaces:**
- Consumes: 无（不依赖 Task 1–3）。
- Produces: 渲染层调用 `window.busy.openDetail({ providerKey, model, providerName })`；`detail:open` 为主进程通道名（Task 5 消费）。

- [ ] **Step 1: 写失败测试** `tests/ui/detail-window.cjs`

复用 `tests/ui/model-list.cjs` 的骨架（mock HTTP 服务 + `Module._compile('src/main.js')` + offscreen 窗口），但**只抓第一个窗口**作为卡片：
- 喂 2 条同模型请求（`officeace` / `glm-5.3`）；
- 在测试里 `ipcMain.on('detail:open', (_e, query) => { opened = query; })`；
- 断言 1：点击 `.model-row` 后 `opened` 深等于 `{ providerKey: 'officeace', model: 'glm-5.3', providerName: 'OfficeAce' }`；
- 断言 2：该行矩形出现在渲染层上报的 `busy:hit-areas` 的 `controls` 里（键盘可达的前提）；
- 断言 3：行可聚焦（`row.tabIndex === 0` 且 `role === 'button'`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `Remove-Item Env:ELECTRON_RUN_AS_NODE; node node_modules/electron/cli.js tests/ui/detail-window.cjs --disable-gpu --no-sandbox`
Expected: FAIL —— `opened === undefined`（行没有点击处理）。

- [ ] **Step 3: 实现**

- `modelRowNode(row)` 增加：`node.tabIndex = 0`、`node.setAttribute('role', 'button')`、`node.setAttribute('aria-label', \`查看 ${providerLabel} 的 ${row.model} 请求明细\`)`（providerLabel 用该组的显示名，由 `providerGroupNode` 传入或在行上带 `data-provider-name`）；`node.addEventListener('click', () => window.busy.openDetail({ providerKey: group.key, model: row.model, providerName: group.provider }))`；`keydown` 里 Enter/Space 同路径。
- CSS：`.model-row { cursor: pointer; }`、`.model-row:hover { background: #fff; box-shadow: ... }`（浅色主题下的轻微提升）、`.model-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`。
- 命中区上报：把每个已渲染行的矩形并入 `controls`（沿用现有上报结构，只追加）。
- `src/preload.js`：`openDetail: (query) => ipcRenderer.send('detail:open', query)`。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（3/3）。

- [ ] **Step 5: 跑既有回归确认没破坏卡片**

Run: `node node_modules/electron/cli.js tests/ui/model-list.cjs --disable-gpu --no-sandbox`（若此时浮窗尚未实现，卡片仍应全绿）
Expected: PASS 11/11。

- [ ] **Step 6: 提交**

```bash
git add web/app.js web/styles.css src/preload.js tests/ui/detail-window.cjs
git commit -m "feat: make a model row a button that asks for its request detail"
```

---

### Task 5: 浮窗垂直切片（窗口 + 页面）

**Files:**
- Create: `web/detail.html`、`web/detail.js`
- Modify: `src/main.js`、`src/preload.js`、`web/styles.css`
- Test: `tests/ui/detail-window.cjs`（追加窗口检查）

**Interfaces:**
- Consumes: Task 2 的 `modelRequests(routes, options)`；Task 3 的 `placeDetail(size, card, area, gap)`；Task 4 的 `detail:open` 通道。
- Produces: 主进程函数 `createDetailWindow(query)`、`openDetail(query)`、`closeDetail()`；通道 `detail:close`、`detail:ready`、`magpie:detail`（载荷 `{ query, routes }`）；preload 的 `closeDetail()`、`onDetail(handler)`、`detailReady()`。

- [ ] **Step 1: 写失败测试**（追加到 `tests/ui/detail-window.cjs`）

- 点行后：`BrowserWindow.getAllWindows().length === 2`；
- 浮窗标题（`document.querySelector('.detail-title').textContent`）为 `'OfficeAce · glm-5.3'`；
- 行数 = `min(20, 总数)`（喂 2 条 → 2 行）；
- 每行有 `.col-clock`（`HH:MM:SS`）、`.col-ms`、`.col-ttft`、`.col-speed`、`.col-state` 五列且取值正确（`3.0 秒` / `600ms` / `100 tok/s` / `完成`）；
- 浮窗卡面 `getComputedStyle('.detail-card').backgroundColor === 'rgb(245, 245, 247)'`，行 `rgb(255, 255, 255)`；
- 按 Esc 后 `BrowserWindow.getAllWindows().length === 1`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/electron/cli.js tests/ui/detail-window.cjs --disable-gpu --no-sandbox`
Expected: FAIL —— 只有 1 个窗口。

- [ ] **Step 3: 实现**

- `src/main.js`：`let detailWin = null; let detailQuery = null;`
  - `createDetailWindow(query)`：按 Spec §5.2 的窗口参数创建（`420×520`、`minWidth:360`、`minHeight:300`、`parent: win`、`...MATERIAL.options`、同一 preload），`loadFile(path.join(__dirname, '../web/detail.html'))`；`closed` 事件里清空 `detailWin`/`detailQuery`。
  - `openDetail(query)`：已验证 query（`providerKey`/`model` 必须为非空字符串，否则忽略）；复用或创建；`positionDetailWindow()`；首次 `ready-to-show` 后 `showInactive()`。
  - `positionDetailWindow()`：取 `screen.getDisplayMatching(win.getBounds()).workArea` 与 `detailWin.getBounds()`，用 `placeDetail` 设置 `x/y`（`setBounds({...}, false)`）。
  - `pushDetail()`：`detailWin?.webContents.send('magpie:detail', { query: detailQuery, routes: lastTrace?.routes || [] })`；在既有 `send('magpie:trace', ...)` 的推送点旁调用（含 `did-finish-load` 与每次 trace 合并后）。
  - IPC：`ipcMain.on('detail:open', ...)`、`ipcMain.on('detail:close', ...)`、`ipcMain.on('detail:ready', ...)`。
  - `applyTopmost()` 内同步 `detailWin.setAlwaysOnTop(settings.topmost, IS_MAC ? 'floating' : 'normal')`。
- `src/preload.js`：补 `closeDetail`、`onDetail`、`detailReady`。
- `web/detail.html`：`<div class="detail-card">` + 标题栏（`.detail-title`、`.detail-x`）+ 表头 + `#detailRows` + 底部 `#detailMore`；引用 `styles.css` 与 `detail.js`（`type="module"`）。
- `web/detail.js`：`window.busy.onDetail(({query, routes}) => { const { rows, hasMore } = modelRequests(routes, { providerKey: query.providerKey, model: query.model, pages }); render(rows, hasMore); })`；`detailReady()` 在启动时调用；`pages` 为模块内状态（初始 1）；`#detailMore` 点击 `pages += 1` 后重算**当前缓存**的 routes；Esc 与 `.detail-x` → `window.busy.closeDetail()`。
- `web/styles.css`：新增 `.detail-*` 区块（`#f5f5f7` 卡面、圆角 16px、白色行、栅格 `62px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 54px`、行高 34px、列表 `overflow-y:auto`、标题栏 `-webkit-app-region: drag` 且按钮 `no-drag`）。
- 空态：`rows.length === 0` → 列表区显示「这个模型还没有请求」，按钮隐藏。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（入口 3 + 窗口 6 = 9 项检查）。

- [ ] **Step 5: 提交**

```bash
git add web/detail.html web/detail.js web/styles.css src/main.js src/preload.js tests/ui/detail-window.cjs
git commit -m "feat: open a detail window listing every request a model served"
```

---

### Task 6: 分页、实时、跟随与关闭

**Files:**
- Modify: `web/detail.js`、`src/main.js`
- Test: `tests/ui/detail-window.cjs`（追加检查）

**Interfaces:**
- Consumes: Task 5 的全部产出。
- Produces: 无新接口（行为补齐）。

- [ ] **Step 1: 写失败测试**（追加；Review Focus 1–4 的钉子都在这里）

- 分页：喂 25 条 → 20 行且 `#detailMore` 可见 → 点击后 25 行且 `#detailMore` 隐藏；
- 实时置顶：再推一条更新时间的请求 → 行数不变（仍是已加载窗口），新请求在首行；
- 进行中行：推一条 `done:false` 同模型请求 → 该行 `.col-ms === '—'`、`.col-state === '进行中'`（**不继承**）；
- 卡片移动跟随：`win.setBounds()` 移动卡片 → 浮窗 x 随之变化（±2px 容差）；
- 右侧不够翻左：把卡片移到接近屏幕右缘 → 浮窗 x 小于卡片 x（在左侧）；
- 关闭三路径：Esc、点 `.detail-x`、`win.hide()` → 均只剩 1 个窗口；
- 切换模型：点另一个模型行 → 仍只有 2 个窗口，标题变成新模型；
- 清表空态（Review Focus 2）：推 `routes: []` → 浮窗显示空态文案且无行、无按钮；
- 不重复（Review Focus 3）：单条请求时点开 → 推同一 id 的更新（`done:true` 带 ms）→ 仍是 1 行且 `ms` 更新。

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/electron/cli.js tests/ui/detail-window.cjs --disable-gpu --no-sandbox`
Expected: 至少"实时/跟随/清表"若干项 FAIL。

- [ ] **Step 3: 实现**

- `web/detail.js`：缓存最近一次 `routes`，供"加载更多"与实时重算共用；重算时 `rows = modelRequests(cached, { ..., pages })`（`pages` 不变 → 保持已加载窗口）；`hasMore === false` 时隐藏按钮；`rows.length === 0` 时显示空态。
- `src/main.js`：`win.on('move')`/`win.on('resize')` → 合并到一次 `positionDetailWindow()`（`setImmediate` 节流）；`win.on('hide')` → `closeDetail()`；`quit()` 与更新安装前 → `closeDetail()`。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/detail.js src/main.js tests/ui/detail-window.cjs
git commit -m "feat: page, follow and close the detail window"
```

---

### Task 7: 既有 UI harness 改造（独立窗口不再冒充卡片）

**Files:**
- Modify: `tests/ui/model-list.cjs`、`tests/ui/pointer-input.cjs`、`tests/ui/drag-bounds.cjs`、`tests/ui/glass-composition.cjs`

**Interfaces:**
- Consumes: 无。
- Produces: 无（只改测试骨架）。

- [ ] **Step 1: 改造**：把 `app.on('browser-window-created', (_event, created) => { win = created; ... })` 改为**只接管第一个**创建的窗口（`if (win) return;`），后续窗口（浮窗）不被打桩覆盖。
- [ ] **Step 2: 跑 4 条回归**

Run: `node node_modules/electron/cli.js tests/ui/<name>.cjs --disable-gpu --no-sandbox`（四个都跑）
Expected: model-list 11/11、pointer-input 16/16、drag-bounds 7/7、glass-composition 5/5 全绿（分别记录实际数字；`resize-handles.cjs` 已知在本机无 GPU 会话下失败，与本次改动无关，不作为验收项）。

- [ ] **Step 3: 提交**

```bash
git add tests/ui/model-list.cjs tests/ui/pointer-input.cjs tests/ui/drag-bounds.cjs tests/ui/glass-composition.cjs
git commit -m "test: let the ui harnesses ignore windows that are not the card"
```

---

### Task 8: 测试用例文档 + 浏览器实测 + HTML 报告

**Files:**
- Create: `docs/test-cases/2026-11-01-model-request-detail-test-cases.md`
- Modify: `tools/mock_models.py`（新增 `detail` 场景：同一模型 25 条请求，含 1 条进行中、1 条错误、1 条缺 ttft）
- Create: `docs/reports/2026-11-01-model-request-detail-test-results.json`
- Create: `docs/reports/screenshots-detail/*.png`
- Create: `docs/reports/2026-11-01-model-request-detail-test-report.html`（用 `tools/model-report.mjs`）

**Interfaces:**
- Consumes: Task 1–7 的产出。
- Produces: 用例表 + 单文件自包含报告。

- [ ] **Step 1: 用例表**：按 Spec §11 验收标准逐条编号（PG-D01…），三层（单测 / UI 回归 / 浏览器实测）各自标注自动化位置与命令。
- [ ] **Step 2: mock 场景** `detail`：`officeace` 下 `glm-5.3` 共 25 条（时间递减），含 `done:false` 一条、`status:500` 一条、缺 `ttft/out` 一条，其余正常；`SCENARIOS` 注册。
- [ ] **Step 3: 浏览器实测**：起预览实例（`--preview --remote-debugging-port=9223`），用 `tools/cdp.mjs eval` 点击模型行、`Shot` 截图：
  - D1 明细首屏（20 条）；D2 点「加载更多」后（25 条、按钮消失）；D3 实时追加后（新请求置顶）；D4 含进行中与错误行的明细；D5 浮窗与卡片同框（位置贴右侧）。
- [ ] **Step 4: 生成报告**

Run: `node tools/model-report.mjs --out docs/reports/2026-11-01-model-request-detail-test-report.html --shots docs/reports/screenshots-detail --results docs/reports/2026-11-01-model-request-detail-test-results.json`
Expected: 打印场景数与图片数；校验 `external: 0 references`。

- [ ] **Step 5: 提交**

```bash
git add docs/test-cases/2026-11-01-model-request-detail-test-cases.md docs/reports tools/mock_models.py
git commit -m "docs: test cases and browser evidence for the detail window"
```

---

### Task 9: 收尾（全量验证、文档、版本、装机、ruflo、提交）

**Files:**
- Modify: `README.md`（新增「请求明细浮窗」小节：每行=一次请求、进行中不继承、分页 20、位置/尺寸不持久化）
- Modify: `package.json`（版本 → `1.7.0`，**用无 BOM 写入**）

- [ ] **Step 1: 全量单测** —— `npm test`，Expected: 全绿（含新增 `route-facts`/`requests`/`detail-placement` 三个文件）。
- [ ] **Step 2: 全量 UI 回归** —— `model-list`、`detail-window`、`pointer-input`、`drag-bounds`、`glass-composition`，逐条记录 PASS 数。
- [ ] **Step 3: README + 版本号**（BOM 检查：`[System.IO.File]::ReadAllBytes('package.json')[0] -ne 0xEF`）。
- [ ] **Step 4: 同步安装版** —— 停进程 → 复制 `src/`、`web/`、`package.json` 到 `%LOCALAPPDATA%\Programs\Busy Magpie\resources\app` → 启动并确认真实网关下点行能开浮窗。
- [ ] **Step 5: ruflo 记录 + 提交**（`ruflo memory store` 每条里程碑；`git commit`）。

---

## Self-Review

**Spec 覆盖检查**：§5.2 窗口参数/生命周期 → T5；§5.3 定位 → T3+T6；§5.4 IPC 四通道 → T4（`detail:open`）+T5（其余三个）；§5.5 时序 → T5；§6.1 抽取 → T1；§6.2 `requests.mjs` → T2；§6.3 时间格式 → T1（`clockOf`）+T2；§7 视觉 → T5（样式）与 T4（行可点击态）；§8 键盘与命中区 → T4；§9 文件清单 → T1–T7；§10.1 单测 → T1–T3；§10.2 UI 回归 → T4–T6；§10.3 harness 改造 → T7；§10.4 浏览器证据 → T8；§11 验收 → T9；§12 风险 R1→T7、R2→T5/T6、R3→T6、R4/R5/R6→T8、R7→T6。

**类型一致性**：`modelRequests` 的签名在 T2 定义、T5/T6 使用一致；行字段 `clock` 在 T1 的 `clockOf` 与 T2 的行结构、T5 的 `.col-clock` 三处同名；`placeDetail(size, card, area, gap)` 在 T3 定义、T5 调用一致；`detail:open` 载荷字段 `{providerKey, model, providerName}` 在 T4 断言、T5 消费一致。

**Review Focus 归属**：1（跨屏定位）→ T6；2（清表空态）→ T6；3（单条后实时新增不重复）→ T6；4（卡片隐藏后重开无残留）→ T6；5（跨午夜/非法时间的 `clock`）→ T1 + T2。
