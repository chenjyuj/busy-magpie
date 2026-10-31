# Provider 分组模型列表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v1.5.0 的「按模型分组列表」改成「按 Provider 分组 + 组头额度进度条 + live 保留上次指标」的浅灰不透明卡片视图。

**Architecture:** 分组逻辑重构为 `web/model-sessions.mjs` 的 `providerSessionGroups()`（纯函数，两遍扫描：先取 (provider, model) 最近完成指标，再叠加最新状态）；渲染层 `app.js` 换成组容器（组头 + 进度条 + 模型行卡片）；窗口材质固定不透明，移除 opacity 设置链路。

**Tech Stack:** Electron 39、原生 JS/CSS、`node --test`、CDP（tools/cdp.mjs）、ruflo（任务/记忆记录）。

**Spec:** `docs/superpowers/specs/2026-10-31-provider-grouped-model-list-design.md`

## Global Constraints

- 不新增 npm 依赖；不改 magpie 接口；数据只来自 trace 长轮询。
- 画布 600×400，等比缩放（applyUiScale）不变；拖边/拖角缩放保留；整卡阻挡点击保留。
- 浅灰不透明：卡片底 `#f5f5f7`、行卡片 `#ffffff`、组头灰 `#86868b`。
- 进度条颜色阈值：≥50% `#34c759`、20-49% `#ff9500`、<20% `#ff3b30`；底轨 `#e5e5ea`；80×4px。
- 指标缺失显示 `—`；live 行保留上一次完成指标；状态判定顺序 error→live→ok。
- `opacity` 设置项整体移除（defaults/loadSettings/publicSettings/settings:save/设置面板滑条/applySurface/magpie:surface-opacity IPC）。
- ruflo 过程记录：每任务完成 `ruflo memory store -k "busy-magpie/v2-<task-id>" -v "<状态与证据>"`。

## Review Focus

1. 同一 (provider, model) 只有进行中请求、从未完成过 → 指标显示 `—` 而非 0/空崩（T1）。
2. `order[]` 条目缺 `known`/`used`（无订阅额度账号）→ `quota` 为 null、组头不渲染进度条、不抛异常（T1 + T6）。
3. 进度条百分比边界：49/50/19/20 → 颜色分档正确（T2 渲染 + T6 断言）。
4. 移除 opacity 后旧 settings.json 仍带 `opacity` 字段 → 应用不崩、字段被忽略（T4）。
5. 窗口 `transparent: false` 后拖边缩放/点击阻挡/紧凑模式不回归（T6 + T8）。

---

### Task 1: `providerSessionGroups()` + 单测重写

**Files:**
- Modify: `web/model-sessions.mjs`（整体重写）
- Test: `tests/model-sessions.test.mjs`（整体重写）

**Interfaces:**
- Produces: `providerSessionGroups(routes, { limit = 6 } = {}) -> { groups: Group[], hiddenCount: number }`
- `Group = { key, provider, account, quota, at, models: ModelRow[] }`
- `ModelRow = { model, ms, ttft, speed, status, reroutes, at, route }`
- `quota = { remaining, used, amount, limit, unit, renewAt } | null`（取 `seat` 的 `known/used/amount/limit/unit/usedRenews||renews[0]`；`known` 缺失或 `used` 非有限数 → null）
- Consumes: `timing.speedInfo`（现有）

- [ ] **Step 1: 重写 `tests/model-sessions.test.mjs`**，用例至少覆盖：按 provider 分组与组排序（最新活动在上）；组内模型去重与排序；`seat.provider` 优先于 `route.provider`；无 provider 归入兜底组（provider 名 'magpie'）；额度取数（known/used/renews 正常值 → remaining 89；known 缺失 → null；used 非有限 → null）；live 保留最近完成指标（同 provider+model 先有一条 done、后有一条 live → ms/ttft/speed 取 done 那条、status 为 live）；只有 live 无 done → 指标 null；error 状态优先；hiddenCount 上限（limit 限模型行总数）；改道计数。
- [ ] **Step 2: 跑失败** `node --test tests/model-sessions.test.mjs` → FAIL（providerSessionGroups 未导出）。
- [ ] **Step 3: 重写 `web/model-sessions.mjs`**：删 `modelSessionRows`，实现 `providerSessionGroups`——按 (provider, model) 两遍扫描（第一遍取最近 done 的指标，第二遍取最新请求的状态/at/reroutes），quota 取最近使用账号的 seat 条目（复用 1.4.3 quotaInfo 口径）。
- [ ] **Step 4: 跑通过** `node --test tests/model-sessions.test.mjs` → PASS；`npm test`（此时 app.js 仍引用旧名会挂——跳过全量，单独跑此文件）。
- [ ] **Step 5: Commit** `git commit -m "feat: group sessions by provider with quota and live-retained metrics"`

### Task 2: 浅灰不透明卡片骨架（styles.css + index.html）

**Files:**
- Modify: `web/index.html`（DOM：组容器+组头+行容器+进度条；设置面板删「背景不透明度」区块）
- Modify: `web/styles.css`（浅灰卡片全套样式；删深色透明变量 `--surface-alpha`/`--node-bg-*`）

- [ ] **Step 1: index.html**：`#modelList` 内部改为 `#providerGroups`（组容器模板由 JS 动态生成）；删设置面板 `settingsOpacity` 区块。
- [ ] **Step 2: styles.css**：卡片 `#f5f5f7`/`transparent: false` 视觉；`.provider-group`、`.provider-head`（灰大写+进度条+剩余百分比）、`.provider-bar`/`.provider-bar-fill`（80×4px，三色档）、`.model-row`（白底圆角 12px 卡片）、状态点/指标列浅色配色。
- [ ] **Step 3: 验证** 无 CSS 语法错误（文件可被 Electron 加载——Task 3 后统一验证）。
- [ ] **Step 4: Commit**（与 Task 3 合并提交，此任务先不单独提交）

### Task 3: 渲染接入 `renderProviderGroups`（app.js）

**Files:**
- Modify: `web/app.js`（import 改 `providerSessionGroups`；`renderModelList`→`renderProviderGroups`；`modelRowNode` 改为新结构；新增 `providerGroupNode(group)`、`quotaBarNode(quota)`）

**Interfaces:**
- Consumes: Task 1 的 `providerSessionGroups`；`presenter.providerName/mask/formatDuration/formatTokens`
- Produces: `renderProviderGroups(groups, hiddenCount)`（渲染层唯一入口）

- [ ] **Step 1: 实现** `providerGroupNode(group)`（组头：大写 provider 名 + 进度条 + 剩余 N%；无 quota 时只显示名字）和 `modelRowNode(row)`（状态点 + 模型名 + 三指标 + 状态词 + 改道小字；live 行指标来自 done 快照）。
- [ ] **Step 2: 实现** `renderProviderGroups(groups, hiddenCount)`（替换 `renderModelList` 调用点；`rowsShown` 改为 `groupsShown`）。
- [ ] **Step 3: 删** `applySurface`、`onSurfaceOpacity` 监听、`settings.opacity` 默认值。
- [ ] **Step 4: 验证** CDP 冒烟（Task 8 统一做，此处跑 `node --check` 语法确认）。
- [ ] **Step 5: Commit** `git commit -m "feat: render provider groups with quota bars in the light card"`

### Task 4: 移除 opacity 设置链路（main.js + 测试适配）

**Files:**
- Modify: `src/main.js`（删 `opacity` 相关：defaults/loadSettings/publicSettings/settings:save/normalizeOpacity/applySurface 调用/magpie:surface-opacity IPC/createWindow 中 opacity 相关）
- Modify: `tests/settings-panel.test.cjs`、`tests/settings-save.test.cjs`、`tests/preview.test.cjs`、`tests/ui/pointer-input.cjs`（删 opacity 断言/交互）

- [ ] **Step 1: main.js** 删 opacity 链路；`publicSettings` 不再传 `backgroundMaterial`。
- [ ] **Step 2: 测试适配** 搜索四个测试文件中 `opacity`/`surface` 引用，删或改。
- [ ] **Step 3: 跑** `npm test` → 全绿（此时 model-sessions 已重写 + app.js 已接新渲染，全量跑）。
- [ ] **Step 4: Commit** `git commit -m "refactor: drop the opacity setting now that the card is opaque"`

### Task 5: window-material 固定不透明

**Files:**
- Modify: `src/window-material.cjs`（固定 `{ kind: 'none', options: { transparent: false, roundedCorners: true, hasShadow: true } }`）
- Modify: `src/main.js`（`MATERIAL`/`activeMaterial`/`attachBlur` 调用清理）

- [ ] **Step 1: 改** window-material.cjs 为固定返回值；main.js 删 `windowSurface`/`attachBlur`/`refreshWindowMaterial` 调用。
- [ ] **Step 2: 跑** `node --test tests/window-bounds.test.cjs tests/gateway-config.test.cjs` → PASS。
- [ ] **Step 3: Commit** `git commit -m "refactor: fixed opaque window material"`

### Task 6: UI 回归改写（model-list.cjs）

**Files:**
- Modify: `tests/ui/model-list.cjs`（改按新 DOM 断言）

- [ ] **Step 1: 重写** mock 数据带 `order[].{known,used,amount,limit,unit,renews}`；断言：组头渲染（provider 名大写、进度条宽度/颜色档）；模型行指标与状态词；live 行有指标（非 —）；额度 null 时无进度条；hiddenCount 汇总；点击阻挡；缩放后行不溢出；紧凑模式。
- [ ] **Step 2: 跑** `node node_modules/electron/cli.js tests/ui/model-list.cjs --disable-gpu --no-sandbox` → 全 PASS。
- [ ] **Step 3: 跑** `tests/ui/pointer-input.cjs --disable-gpu --no-sandbox` → PASS（opacity 相关断言已在 T4 适配）。
- [ ] **Step 4: Commit** `git commit -m "test: cover provider groups and quota bars in the regression"`

### Task 7: README + 测试用例文档 v2

**Files:**
- Modify: `README.md`（视图章节改为 Provider 分组 + 进度条；settings 示例删 opacity）
- Modify: `docs/test-cases/2026-10-31-model-session-list-test-cases.md`（追加 v2 用例或另建 v2 文档）

- [ ] **Step 1: README** 更新模型会话列表章节（Provider 分组、组头额度进度条、live 保留、浅色不透明）。
- [ ] **Step 2: 测试用例文档** 按新 DOM/行为更新用例表（分组/额度/live 保留/进度条颜色档）。
- [ ] **Step 3: Commit** `git commit -m "docs: describe the provider-grouped list"`

### Task 8: mock 补额度字段 + 浏览器实测 + HTML 报告

**Files:**
- Modify: `tools/mock_models.py`（`order[]` 补 `known/used/amount/limit/unit/renews`）
- Create: `docs/reports/2026-10-31-provider-grouped-list-test-results.json`、`docs/reports/2026-10-31-provider-grouped-list-test-report.html`、`docs/reports/screenshots/P*.png`

- [ ] **Step 1: mock** 各场景的 `order[]` 条目带确定性额度数据（如 used=11 → 剩余 89%）。
- [ ] **Step 2: 实测** 复用 CDP 流程跑 7 场景（ok/error/live/missing/many/flaky/empty）+ 进度条专项断言。
- [ ] **Step 3: 报告** `node tools/model-report.mjs --out ... --shots ... --results ...` 生成单文件 HTML。
- [ ] **Step 4: Commit** `git commit -m "test: browser evidence for the provider-grouped list"`

### Task 9: 收尾

- [ ] **Step 1:** `npm test` 全量 + UI 回归逐个跑通。
- [ ] **Step 2:** ruflo memory 记录 V2-T1…T9 最终状态；`ruflo task list` 留档。
- [ ] **Step 3:** 停本机 Busy Magpie → 同步 `resources/app` → 重启验证 1.6.0。
- [ ] **Step 4:** `git status` 干净 + 版本号 1.6.0 + 最终提交。
- [ ] **Step 5:** 向用户汇报。