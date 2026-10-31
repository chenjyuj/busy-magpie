# 模型会话列表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 busy-magpie 卡片主视图从「Agent→magpie→账号」路由舞台换成「按实际服务模型分组的最近会话列表」，每行显示时长 / 首字节 / token/s / 状态，并补齐测试用例文档、浏览器实测与含截图步骤的 HTML 报告。

**Architecture:** 分组与指标计算下沉到新的纯逻辑模块 `web/model-sessions.mjs`（输入 routes，输出可渲染的行），渲染层只负责排版；速度口径从 `presenter.js` 提取到 `web/timing.mjs` 供两边共用；路由舞台、飞行动画、驻留与 Fast 标记相关的模块/测试整块删除，CI 那一步换成新的列表回归。

**Tech Stack:** Electron 39（无前端框架，原生 JS/SVG/CSS）、Node >=20 的 `node --test`、真实 Electron UI 回归（`node node_modules/electron/cli.js tests/ui/*.cjs`）、`tools/cdp.mjs`（CDP 截图/求值）、ruflo 3.42.5（任务与过程记录）。

**Spec:** `docs/superpowers/specs/2026-10-31-model-session-list-design.md`（实现必须与 spec 一致；冲突时以 spec 为准并回头改 spec）

## Global Constraints

- 不新增任何 npm 运行依赖；`dependencies` / `devDependencies` 保持原样。
- 不新增 magpie 接口、不改 magpie；数据只来自 `/v1/magpie/trace` 与 `/v1/magpie/usage`。
- 卡片画布固定 600×400 逻辑像素，窗口最小 600×432（紧凑 360×112）；列表随 `applyUiScale()` 等比缩放。
- 整卡必须继续阻挡鼠标点击（`pointer-input` 回归不许失败）；顶部 28px 拖动条、四边 7px / 四角 14px 缩放带、token 胶囊、右上角菜单照旧可用。
- 账号默认打码，悬停里的账号遵守 `maskAccounts`；日志不得写入账号/Key/请求内容。
- 指标缺失一律显示 `—`，禁止用 `0ms`/`0 tok/s` 兜底；tok/s 只在 `speedInfo()` 返回非 null 时显示。
- 版本号升到 `1.5.0`；发布渠道字段（`build.publish`、`magpie`）不动。
- 现有 `npm test` 基线 223 个测试；改完后必须全绿（数量因删除而减少是预期）。
- ruflo 过程记录约定：每个任务完成时执行 `ruflo memory store -k "busy-magpie/<task-id>" -v "<状态与证据>"`，并在 T10 汇总（ruflo task 子命令没有 complete，因此用 memory 记录进度）。

## Review Focus

以下五类最容易伤到真实使用者、且 spec 没写测试的情形；每一条都在拥有该代码的任务里落一条测试：

1. route 既无 `served` 也无 `tries`（magpie 早期/异常快照）→ 应跳过不建行，且不抛异常（T2）。
2. 指标为 `0` / `null` / 缺失（例如 ttft=0、out=0、ms 未到）→ 显示 `—`，不得渲染 `0ms`、`0 tok/s`（T2 + T6）。
3. 网关断线或 pid 变化清表后 → 列表保留上一帧、状态标注「暂未刷新」，不闪空、不残留已清空的模型（T4 + T6）。
4. 模型数超过 6 → 只渲染 6 行 + 「+N 个模型」汇总行，`N` 与真实剩余数一致（T2 + T6）。
5. 窗口缩到最小 / 切紧凑模式 / 断开显示器后 → 列表不溢出画布、行不被裁切、缩放比例正确（T6 + T9）。

---

## File Structure

**新增**：`web/model-sessions.mjs`（分组+行投影）、`web/timing.mjs`（速度/耗时口径）、`web/redact.mjs`（诊断脱敏）、`tests/model-sessions.test.mjs`、`tests/timing.test.mjs`、`tests/redact.test.mjs`（由 `tests/request-model.test.mjs` 改名）、`tests/ui/model-list.cjs`、`tools/mock_models.py`（新视图的确定性 mock）、`tools/model-report.mjs`（报告生成）、`docs/test-cases/2026-10-31-model-session-list-test-cases.md`、`docs/reports/2026-10-31-model-session-list-test-report.html`。

**修改**：`web/app.js`（接列表、删舞台）、`web/presenter.js`（口径外提、文案改空态）、`web/index.html`、`web/styles.css`、`tests/ui/account-metrics.cjs`、`tests/ui/layout-motion.cjs`、`.github/workflows/build.yml`、`README.md`、`package.json`、`.gitignore`（ruflo 已自行追加）。

**删除**：`web/flight-playback.mjs`、`web/flight-path.mjs`、`web/routing-state.mjs`、`web/request-model.mjs`、`web/request-modes.mjs`；`tests/flight-path.test.mjs`、`tests/flight-playback.test.mjs`、`tests/request-groups.test.mjs`、`tests/request-modes.test.mjs`、`tests/routing-state.test.mjs`；`tests/ui/routing-animation-bounds.cjs`、`tests/ui/flight-replay.cjs`、`tests/ui/routing-state.cjs`、`tests/ui/request-modes.cjs`、`tests/ui/column-motion.cjs`。

---

### Task 1: 提取共享口径模块（timing / redact）

**Files:**
- Create: `web/timing.mjs`, `web/redact.mjs`, `tests/timing.test.mjs`
- Modify: `web/presenter.js`（内部 `speedInfo`/`timingInfo` 移出，改为 import）、`web/app.js:12-16` 的 import 段
- Rename: `tests/request-model.test.mjs` → `tests/redact.test.mjs`
- Delete: `web/request-model.mjs`

**Interfaces:**
- Produces: `timing.speedInfo(route, lastTry) -> {rate:Number, tokens:Number, window:Number} | null`；`timing.timingInfo(route, lastTry) -> {ms,ttft,queued,wait,own,speed} | null`；`redact.redactDiagnostic(value, limit=1800) -> String`
- Consumes: 无（本任务只做搬迁，算法逐字保持）

- [ ] **Step 1: 写失败测试** `tests/timing.test.mjs`：① 流式完成（`ms=3000, ttft=600, out=240, firstText=600, flow=1`）→ `speedInfo().rate` 约等于 100；② 整段返回（`firstText=0, flow=1`）→ `null`；③ 仍在流式（`done=false`）→ `null`。
- [ ] **Step 2: 跑失败** `node --test tests/timing.test.mjs` → FAIL（模块不存在）。
- [ ] **Step 3: 搬迁实现**：把 `presenter.js` 的 `speedInfo`/`timingInfo`（约 180/205 行起）逐字移到 `web/timing.mjs` 并导出；`presenter.js` 改为 import；`redactDiagnostic` 逐字移到 `web/redact.mjs`，`app.js:926` 改 import 来源。
- [ ] **Step 4: 跑通过** `node --test tests/timing.test.mjs` → PASS；`git mv tests/request-model.test.mjs tests/redact.test.mjs` 并改 import → `node --test tests/redact.test.mjs` PASS。
- [ ] **Step 5: 提交** `git add web/timing.mjs web/redact.mjs web/presenter.js web/app.js tests/timing.test.mjs tests/redact.test.mjs && git rm web/request-model.mjs && git commit -m "refactor: extract timing and redact modules"`

### Task 2: 分组模块 `web/model-sessions.mjs`（TDD）

**Files:**
- Create: `web/model-sessions.mjs`, `tests/model-sessions.test.mjs`
- Consumes: `timing.speedInfo`（Task 1）

**Interfaces:**
- Produces：`modelSessionRows(routes, {now = Date.now(), limit = 6} = {}) -> {rows: Row[], hiddenCount: Number}`；`Row = {key, model, provider, account, ms, ttft, out, speed, status, reroutes, at, route}`；`status ∈ {'error','live','ok'}`
- 分组键：`served = route.served || route.tries?.at(-1)?.model || ''`，仅按模型名（不含 provider）；无 `served` 的行跳过。
- 取最新：`time` 降序，`time` 相同按 `id` 数值降序；输出按近期活动降序；`limit` 之外计入 `hiddenCount`。
- 状态顺序：`error`（`route.error` 或 `status>=400`）→ `live`（`!done`）→ `ok`。

- [ ] **Step 1: 写失败测试** `tests/model-sessions.test.mjs`，至少覆盖：served 优先于 `tries.at(-1).model`；同模型多次请求取最新；改道跨模型归最后一次尝试且 `reroutes` 计数；无 served/tries 的 route 被跳过且不抛（Review Focus 1）；`ttft=0`/`out=0` 时 `ttft`/`speed` 为 `null` 而非 0（Review Focus 2）；`error`/`live`/`ok` 三态判定；7 个模型时 `rows.length===6 && hiddenCount===1`（Review Focus 4）。
- [ ] **Step 2: 跑失败** `node --test tests/model-sessions.test.mjs` → FAIL。
- [ ] **Step 3: 实现** `modelSessionRows`（纯函数，不读 DOM/全局）；`speed` 取 `timing.speedInfo(route, tries.at(-1))?.rate ?? null`。
- [ ] **Step 4: 跑通过** `node --test tests/model-sessions.test.mjs` → PASS；`node --test` 全量仍绿。
- [ ] **Step 5: 提交** `git commit -m "feat: group trace routes into per-model latest sessions"`

### Task 3: 列表骨架（index.html / styles.css）

**Files:** Modify `web/index.html`、`web/styles.css`

- [ ] **Step 1: 换 DOM**：删除路由舞台相关容器，新增 `#modelList`（行容器）与行模板（5 个固定列：模型名 / 状态 / 时长 / 首字 / tok/s）、汇总行、空态与暂未刷新文案节点。
- [ ] **Step 2: 样式**：行高 48px、五列固定列宽、模型名超长省略号、三种状态点颜色、汇总行灰字、容器不溢出 600×400 画布。
- [ ] **Step 3: 验证**：`npx electron . --preview --remote-debugging-port=9223` 后 `node tools/cdp.mjs eval "!!document.getElementById('modelList')"` → `true`。
- [ ] **Step 4: 提交** `git commit -m "feat: add the model list card skeleton"`

### Task 4: 渲染接入 `renderModelList`（app.js / presenter.js）

**Files:** Modify `web/app.js`、`web/presenter.js`

**Interfaces:** Consumes `modelSessionRows`（Task 2）；Produces `renderModelList(rows)`（渲染层唯一入口，供 UI 回归调用）

- [ ] **Step 1: 渲染实现**：trace 到达时用 `modelSessionRows(routes)` 取行并渲染；每行写四指标（`formatDuration`/`formatLatency`/`tok/s`/状态）+ 行尾小字「改道 N 次」（仅 `N>0`）+ 悬停 tip（供应商 · 账号（打码）· 最近活动 · 改道次数 · tok/s 明细）；`hiddenCount>0` 时渲染汇总行。
- [ ] **Step 2: 空态/断线**：无 routes → 「等待 magpie 数据」；断线或 pid 变化清表 → 保留上一帧行 + 「暂未刷新」（Review Focus 3）；`presenter.js` 的 `empty/connecting/offline` 改成列表文案。
- [ ] **Step 3: 验证**：mock 网关 + preview，`node tools/cdp.mjs eval "document.querySelectorAll('.model-row').length"` 与 `eval "document.body.innerText.includes('tok/s')"` 均符合预期。
- [ ] **Step 4: 提交** `git commit -m "feat: render the model session list"`

### Task 5: 删除路由舞台与失效测试，改 CI

**Files:** Modify `web/app.js`、`web/presenter.js`、`src/main.js`、`.github/workflows/build.yml`；Delete 上文 File Structure 中列出的 4 个 web 模块 / 5 个单测 / 5 个 UI 回归

- [ ] **Step 1: 删渲染代码**：`app.js` 中删除 `renderMulti`、`renderView` 舞台分支、`buildFanAgent`、`buildFanAccount`、`drawFanWires`、`drawSingleWires`、`renderStory`、`syncFlights`/`flyTrip`/`passHub`/`hubBurst`/`ripplePass`/`vortexPass`/`dissolvePass`/`arcPass`、`animateRoutingLayout`/`followRoutingLayout`/`updateRoutingPaths`/`captureRoutingLayout`/`reuseRoutingNode`/`placeRoutingNodes`、`setMulti`、`applyRoutingState`/`visibleFlightGroups`/`sessionGroups`/`requestsOnWire`/`routingNow`/`scheduleStageExpiry`/`flightDisplayRoute`、`modeSvg`/`renderRequestModes`；`presenter.js` 删除 `present()`。
- [ ] **Step 2: 删模块与测试**：按 File Structure 的删除清单 `git rm`。
- [ ] **Step 3: 清残留引用**：`grep -rn "flight-playback\|flight-path\|routing-state\|request-modes\|request-model\|hubEffect\|ROUTE_LINGER" web src tests .github` → 无匹配（`hubEffect` 设置项按 spec 一并移除；若设置面板仍列出它需同步删除）。
- [ ] **Step 4: 去掉 lanes 语义**（spec §8）：`src/main.js` 的 `fitWindow(lanes)` 不再用活跃请求数当行数，`magpie:frame` 保留该字段以兼容但值恒为 0；`activeCount()` 仍供紧凑模式状态条与「空闲更新」策略使用。
- [ ] **Step 5: 改 CI**：`build.yml` 中 `routing-animation-bounds.cjs` 那一步换成 `tests/ui/model-list.cjs`（Task 6 交付后生效）。
- [ ] **Step 6: 验证**：`npm test` → 全绿（数量减少）；`node --test` 无导入错误。
- [ ] **Step 7: 提交** `git commit -m "refactor: remove the routing stage and its regressions"`

### Task 6: UI 回归（新增 model-list + 改写两个）

**Files:** Create `tests/ui/model-list.cjs`；Modify `tests/ui/account-metrics.cjs`、`tests/ui/layout-motion.cjs`

- [ ] **Step 1: 写 model-list.cjs**：沿用 `account-metrics.cjs` 的本地 HTTP mock + 真实 Electron + 窗口打桩模式；mock 三个模型（ok / error / live + 一个缺 ttft）与七个模型的第二态；断言：行数、四指标文案、`—` 降级、汇总行、点击仍被阻挡、断线保留上一帧；产出 `artifacts/model-list/result.json`。
- [ ] **Step 2: 跑** `node node_modules/electron/cli.js tests/ui/model-list.cjs` → 全部 PASS。
- [ ] **Step 3: 改写两个旧回归**：只留保留功能断言（用量胶囊、命中区、缩放布局），删除账号卡/舞台断言。
- [ ] **Step 4: 跑** 上述两个 + `pointer-input.cjs` → PASS。
- [ ] **Step 5: 提交** `git commit -m "test: cover the model list with a real Electron regression"`

### Task 7: 文档与版本

**Files:** Modify `README.md`、`package.json`

- [ ] **Step 1: README**：删「路由视图」「穿过动效」「Fast 与思考强度」「会话模式」，新增「模型会话列表」（分组口径、四指标、状态、悬停、6 行上限）。
- [ ] **Step 2: 版本** `package.json` → `1.5.0`（发布字段不动）。
- [ ] **Step 3: 截图** 用 `tools/cdp.mjs shot` 重拍 `docs/screenshots/{single,multi}.png`（依赖 T9 的 mock 环境）。
- [ ] **Step 4: 提交** `git commit -m "docs: describe the model session list"`

### Task 8: 测试用例文档

**Files:** Create `docs/test-cases/2026-10-31-model-session-list-test-cases.md`

- [ ] **Step 1: 写用例表**：列 `ID / 标题 / 前置 / 步骤 / 预期 / 层级 / 自动化位置`；至少覆盖：6 行内分组与排序、served 优先、改道归属、`—` 降级、三态状态、汇总行、断线保留、空态、点击阻挡、缩放、紧凑模式、悬停打码。
- [ ] **Step 2: 对齐**：每条用例必须指向已存在的自动化测试（`tests/model-sessions.test.mjs` / `tests/ui/model-list.cjs`）或 T9 的浏览器实测步骤；无归属的用例要么补测试要么删。
- [ ] **Step 3: 提交** `git commit -m "docs: add model list test cases"`

### Task 9: 浏览器实测 + HTML 报告

**Files:** Create `tools/mock_models.py`、`tools/model-report.mjs`、`docs/reports/2026-10-31-model-session-list-test-report.html`、`docs/reports/screenshots/*.png`

- [ ] **Step 1: mock**：`tools/mock_models.py` 提供 `/v1/magpie/trace`+`/v1/magpie/usage`，可切换场景（ok/error/live、缺 ttft、7 模型、断线）。
- [ ] **Step 2: 实测**：`python tools/mock_models.py 3500 <场景>` + `BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 npx electron . --preview --remote-debugging-port=9223`，用 `node tools/cdp.mjs eval` 断言 + `shot` 截图（Review Focus 5 的缩放/紧凑态各一张）。
- [ ] **Step 3: 生成报告** `node tools/model-report.mjs --out docs/reports/...html`：内联 CSS + 截图（base64 内嵌，单文件可分享）+ 每个场景的步骤与实际结果 + `npm test`/UI 回归结果 + `ruflo task list --format json` 与 `ruflo memory list` 证据。
- [ ] **Step 4: 校验**：HTML 文件存在、图片数 ≥6、无外链依赖；用浏览器打开确认可读。
- [ ] **Step 5: 提交** `git commit -m "test: add browser evidence report for the model list"`

### Task 10: 收尾验证

- [ ] **Step 1:** `npm test` → 全绿并记录数量。
- [ ] **Step 2:** 保留的 UI 回归逐个跑通：`pointer-input.cjs`（含 `--native`、`--fallback`）、`drag-bounds.cjs`（1 / 1.75）、`resize-handles.cjs`、`material.cjs`、`native-blur.cjs`、`glass-composition.cjs`、`model-list.cjs`、`account-metrics.cjs`、`layout-motion.cjs`。
- [ ] **Step 3:** `ruflo memory store` 写入 T1–T10 的最终状态与证据；`ruflo task list --format json` 留档。
- [ ] **Step 4:** `git status` 干净（除 `.mnemon/`、`.claude-flow/` 等运行目录）+ 最终提交。
- [ ] **Step 5:** 向用户汇报：改动摘要、测试结果、报告路径、ruflo 记录位置。