# 模型会话列表（Model Session List）设计

- 日期：2026-10-31
- 状态：设计已获口头确认，待用户审阅本 spec
- 基线：仓库 `busy-magpie` 分支 main，提交 `5b15937`（v1.4.3）
- 涉及版本：破坏性 UI 变更，建议 `1.4.3 → 1.5.0`

## 1. 背景与目标

卡片当前的主视图是「Agent → magpie → 账号」实时路由舞台（单请求舞台 / 多 Agent 扇出、连线、请求标记飞行、穿过动效）。用户希望把它改成一张**按模型分组的最近会话列表**，用来一眼看清每个模型最近一次请求的表现。

需求原文：*“重新修改ui，显示最新会话列表，只显示按照model进行group，显示每个model 最近一次的 会话时长、首字节时长、token每秒和状态”*。

成功标准：

1. 卡片主视图只有「按实际服务模型分组」的列表，每个模型一行，显示该模型最近一次请求的 时长 / 首字节 / token/s / 状态。
2. 路由舞台、连线、请求标记飞行动画、穿过动效、12s 驻留逻辑在代码与 DOM 中彻底移除（不是隐藏）。
3. `npm test` 全绿，并有一条针对新列表的真实 Electron UI 回归。
4. 指标缺失时显示 `—`，不编造数值、不用 0 填充。
5. 账号打码、菜单、设置面板、紧凑模式、点击阻挡、拖动缩放行为不回归。

## 2. 非目标（YAGNI）

- 不做会话跨度统计（不计算 conv 存活时长）、不做历史会话列表、不做分页/滚动。
- 不新增 magpie 接口，不改 magpie；数据仍只来自 `/v1/magpie/trace`（长轮询）与 `/v1/magpie/usage`。
- 不做按账号/供应商分组、不做多视图切换开关、不做行内动画。
- 不动业务包签名与更新渠道（`shell/`、`plugin/`、`package.json` 发布字段均不变）。

## 3. 现状与约束（已核实）

- 数据源：`src/main.js` 的 `TraceClient`（约 1345 行起）长轮询 `trace?after=<seq>&wait=1`，主进程维护增量合并表（上限 220，超出按完成时间裁剪到 200），通过 `magpie:trace` 推给渲染层；usage 由主进程 20s 轮询。
- route 实测字段：`id, time, agent, model, served, provider, group, conv, order, tries[], done, status, ms, ttft, out, tokens, error, flow, firstText, firstReasoning, reasoning, prompt, usage, affinity, seq`。
- **没有 `session` 字段**，会话标识只有 `conv`；`/v1/magpie/usage` 的 `sessions` 在 today/7d/30d/all 四种时间窗实测 `sessionCount=0`（magpie 未提供会话记录）。因此本设计只用单次请求指标，不推导会话跨度。
- `model` 是请求的模型（`group/deepseek-v4.1-flash`、`officeace/deepseek-v4.1-flash`），`served` / `tries[].model` 是实际服务的模型（`glm-5.3`、`deepseek-v4.1-flash`），二者经常不同；请求进行中时 `served` 可能为空。
- tok/s 口径已有实现：`web/presenter.js` 内部函数 `speedInfo()`（约 180 行），对「整段返回」与「仍在流式」的请求返回 `null`，并处理「可见思考」区间；同文件 `timingInfo()`（约 205 行）聚合 ttft/ms/排队等。两者目前**未导出**。
- 渲染层 imports：`web/app.js` 顶部导入 `FlightBook`、`wireCurve/hubCurve/glideProgress`、`stagedRoutes/wireState/nextRestExpiry`、`requestActive/requestGroupKey/redactDiagnostic/groupRequests`、`projectRequestModes`；其中只有 `redactDiagnostic`（用于设置里的「复制诊断」，app.js 约 926 行）与本次保留功能有关。
- 卡片画布：内容画在 600×400 逻辑画布上，窗口保持同比例缩放（`src/main.js` 的 `heightForWidth`）；窗口默认 632×432，最小 600×432；紧凑模式 360×112。
- UI 回归测试模式：`tests/ui/*.cjs` 用本地 HTTP server 伪造 trace/usage + 真实 Electron 加载 main+preload+renderer，并用 `win.showInactive` 等方法打桩避免打扰桌面（见 `tests/ui/account-metrics.cjs` 头部）；`tests/main-harness.cjs` 是主进程 vm 沙箱，与 DOM 无关。
- CI（`.github/workflows/build.yml`）在 `npm test` 之后显式运行 `tests/ui/pointer-input.cjs`（含 `--native`、`--fallback`）、`tests/ui/drag-bounds.cjs`（100%/175% 缩放）与 `tests/ui/routing-animation-bounds.cjs`。

## 4. 决策记录

| 问题 | 决定 |
| --- | --- |
| 「model」口径 | **B：实际服务的模型**（`route.served`，回退 `tries.at(-1).model`）。同一请求被改道到别的模型时，归入最后一次尝试的模型。 |
| 「会话时长」口径 | **B：该模型最近一次请求的 `route.ms`**（与首字节/tok-s 同一条请求，口径统一、数据精确）。 |
| 改动范围 | **A：完全替换主视图**；保留 token 胶囊、菜单、设置/关于、紧凑模式。 |
| 行内信息 | **A：极简四指标 + 状态**（模型名 + 状态 + 时长 + 首字 + tok/s）；供应商/账号/最近活动/改道次数放悬停提示。 |
| 实现方案 | **A：新增纯逻辑分组模块 + 删除路由舞台**（不保留双视图开关）。 |
| Fast/思考强度标记、12s 驻留 | 随路由舞台一并删除（列表不显示）。 |

## 5. 数据模型

### 5.1 新模块 `web/model-sessions.mjs`（纯逻辑，无 DOM）

```js
export function modelSessionRows(routes, { now = Date.now(), limit = 6 } = {})
// -> { rows: Row[], hiddenCount: number }
```

`Row`：

```js
{
  key,          // 分组键：实际服务模型标识（用于去重与稳定身份）
  model,        // 展示名（取自 served / tries[].model）
  provider,     // 最后一次尝试的 provider（悬停）
  account,      // 最后一次尝试的账号 id（悬停，渲染时按 maskAccounts 打码）
  ms, ttft, out,// 数值或 null
  speed,        // tok/s 数字或 null（复用 timing 口径）
  status,       // 'live' | 'ok' | 'error'
  reroutes,     // 跨模型改道次数（tries 中不同 model 的数量 - 1，最小 0）
  at,           // route.time（悬停显示相对时间）
  route         // 原始 route 引用，供悬停明细（如 tok/s 明细）使用；渲染层不得直接读行数据里未声明的字段
}
```

规则：

1. **分组键**：`served = route.served || route.tries?.at(-1)?.model || ''`；`served` 为空（还没有任何 try）的请求不建行，也不计入 `hiddenCount`。
   - 分组**只按模型名，不含 provider**：`deepseek-v4.1-flash` 无论由 `officeace` 还是 `workbuddy` 服务都归同一行；该行的悬停明细显示的是最新那条请求的 provider/账号。
2. **取最新**：同 `key` 的候选 route 取 `time` 最大者；`time` 相同按 `id` 数值兜底（沿用现有 `routing-state.mjs` 的 `order()` 语义，保证与旧视图一致）。
3. **排序**：按最近活动倒序（`at` 降序，`id` 兜底）。活跃模型在上。
4. **上限**：最多 `limit = 6` 行；其余合并为 `hiddenCount`（渲染成「+N 个模型」一行）。
5. **不驻留、不过期**：删除 12s 驻留；行仅在被同模型更新的请求替换、或 trace 自身裁剪/网关重启清表时消失。
6. 输入为 `routes` 数组（渲染层持有的合并表快照）；模块不读全局、不读时间以外的外部状态。

### 5.2 相关模块调整

- 新增 `web/timing.mjs`：把 `presenter.js` 内部的 `speedInfo()`/`timingInfo()` 提取为导出（保持完全相同的算法与 `null` 语义），供 `presenter.js` 与新模块共用，避免两套口径漂移。
- 新增 `web/redact.mjs`：`redactDiagnostic()` **原样搬迁**（`request-model.mjs` 删除）。`tests/request-model.test.mjs` 随文件改名为 `tests/redact.test.mjs`，三条断言保持不变。

## 6. 指标与状态

| 显示项 | 取数 | 缺失/不可用时 |
| --- | --- | --- |
| 时长 | `route.ms` → `formatDuration()`（`6.5s` / `12.7s`） | `—`（不显示 `0ms`） |
| 首字节 | `route.ttft`，回退 `tries.at(-1).ttft` → `formatLatency()`（`6320ms` / `6.3s`） | `—` |
| token/s | `speedInfo(route, lastTry).rate` → `Math.round(rate) tok/s` | `—`（不猜；整段返回/流式中本就是 `null`） |
| 状态 | 见下表 | 按 `done` 判定，不显示 `未知` |

状态判定（自上而下，首个命中的生效）：

| 顺序 | 状态 | 条件 | 呈现 |
| --- | --- | --- | --- |
| 1 | `error` 错误 | 有 `route.error` 或 `Number(route.status) >= 400` | 红点 +「错误」 |
| 2 | `live` 进行中 | `!route.done` | 蓝点（脉冲）+「进行中」 |
| 3 | `ok` 完成 | 其余（`route.done` 且 `status < 400`） | 绿点 +「完成」 |

- 「改道 N 次」不是状态，只在行尾小字（`N>0` 时）与悬停提示里出现。计数口径：`tries` 中出现的不同 `model` 数量减 1。
- 悬停提示内容：`供应商 · 账号（跟随「隐藏账号名称」打码）· 最近活动 12s 前 · 改道 N 次 · tok/s 明细（N token / Xs，若可用）`。
- 相对时间在渲染时由 `now - Date.parse(at)` 计算；行内不显示时间。

## 7. UI 规格

- **布局**：一个列表容器替换原路由舞台容器（原单请求舞台、扇出视图、底部「最近一个请求是怎么路由的」说明全部移除）。上方 token 胶囊、右上 `···` 菜单与版本号按钮位置不变。
- **行结构**（单行，五列固定宽度，左对齐）：
  `模型名（可截断省略） | ● 状态文字 | 时长 | 首字 | tok/s`
  列宽固定以避免数字长短导致抖动；行高约 48px，6 行 + 汇总行不超出 600×400 画布。
- **汇总行**：`+N 个模型`（灰字，无状态列）；`N = 0` 时不显示。
- **空态**：无 routes 时显示「等待 magpie 数据」。
- **断线**：保留上一帧行数据，并在状态位置标注「暂未刷新」（沿用现有连接/用量文案习惯，不新增弹窗）。
- **隐私**：行内不显示账号；悬停里的账号遵守 `maskAccounts`（默认打码）。
- **交互**：行不可点击、不改变布局（悬停只出 tip）；整卡仍阻挡鼠标点击；菜单、设置、关于、紧凑模式、拖动条、缩放命中区行为不变。
- **紧凑模式**：维持现状（360×112 状态条：连接状态、活动请求数、当前用量），本次不改。活动请求数继续由主进程 `activeCount()` 统计。
- **缩放**：沿用 `applyUiScale()` 的 600×400 等比缩放，列表随窗口缩放，字号与列宽按同一比例。

## 8. 文件变更清单

**新增**

- `web/model-sessions.mjs`（分组/取最新/排序/上限，纯逻辑）
- `web/timing.mjs`（从 presenter 提取的速度与耗时口径）
- `web/redact.mjs`（`redactDiagnostic` 搬迁）
- `tests/model-sessions.test.mjs`
- `tests/redact.test.mjs`（由 `tests/request-model.test.mjs` 改名）
- `tests/ui/model-list.cjs`（真实 Electron + mock trace 的列表回归）

**删除**

- `web/flight-playback.mjs`、`web/flight-path.mjs`、`web/routing-state.mjs`、`web/request-model.mjs`、`web/request-modes.mjs`
- `tests/flight-path.test.mjs`、`tests/flight-playback.test.mjs`、`tests/request-groups.test.mjs`、`tests/request-modes.test.mjs`、`tests/routing-state.test.mjs`（`tests/request-model.test.mjs` 不是删除，而是随迁移改名为 `tests/redact.test.mjs`，见「新增」）
- `tests/ui/routing-animation-bounds.cjs`、`tests/ui/flight-replay.cjs`、`tests/ui/routing-state.cjs`、`tests/ui/request-modes.cjs`、`tests/ui/column-motion.cjs`

**改写**

- `web/app.js`：删除路由舞台渲染与动画（`renderMulti`、`renderView` 的舞台分支、`buildFanAgent`、`buildFanAccount`、`drawFanWires`、`drawSingleWires`、`renderStory`、`syncFlights`/`flyTrip`/`passHub`/`hubBurst`/`ripplePass`/`vortexPass`/`dissolvePass`/`arcPass`、`animateRoutingLayout`/`followRoutingLayout`/`updateRoutingPaths`/`captureRoutingLayout`/`reuseRoutingNode`/`placeRoutingNodes`、`setMulti`、`applyRoutingState`/`visibleFlightGroups`/`sessionGroups`/`requestsOnWire`/`routingNow`/`scheduleStageExpiry`/`flightDisplayRoute`、`modeSvg`/`renderRequestModes`）；新增 `renderModelList(rows)`；保留 `applyUiScale`、用量胶囊与 `renderUsageStatus`、设置面板、关于、快速菜单、拖动/缩放、`reportHitAreas`、`applySurface`/`applySettings`。
- `web/presenter.js`：保留 `formatDuration`/`formatTokens`/`formatEta`/`timeOf`/`mask`/`providerName`/`shortModel`（`shortModel` 用于把 `provider/model` 缩短为模型名）；删除路由叙述 `present()`；`empty`/`connecting`/`offline` 改造成列表的空态/断线文案（保留函数，改写内容）。
- `web/index.html`、`web/styles.css`：路由舞台 DOM 与样式（`request-modes`、扇出/舞台类名）换成列表 DOM 与样式。
- `tests/ui/account-metrics.cjs`、`tests/ui/layout-motion.cjs`：只保留仍被测的保留功能断言（用量胶囊/命中区/布局缩放），删除账号卡与舞台布局专有断言；若改写后断言密度过低，则删除并在 `tests/ui/model-list.cjs` 里补齐对应覆盖。
- `.github/workflows/build.yml`：把 `routing-animation-bounds.cjs` 那一步替换为 `tests/ui/model-list.cjs`。
- `README.md`：删「路由视图」「穿过动效」「Fast 与思考强度」「会话模式」等章节，新增「模型会话列表」；`docs/screenshots/{single,multi}.png` 用 `tools/cdp.mjs shot` 重拍。
- `package.json`：版本 `1.5.0`（发布渠道字段不动）。

**保留不动**

- `src/main.js`：除下面一处外不动。`magpie:frame` 继续驱动缩放与窗口高度；去掉已无意义的 `lanes` 语义（保留字段以兼容，值不再表示分组行数）。`activeCount()` 保留。
- `shell/*`、`plugin/*`、`src/preload.js`（IPC 白名单不变）、`src/gateway-config.cjs`、`src/launch-policy.cjs`、`src/window-*`。
- 保留功能的 UI 回归：`tests/ui/pointer-input.cjs`、`drag-bounds.cjs`、`resize-handles.cjs`、`material.cjs`、`native-blur.cjs`、`glass-composition.cjs`。

## 9. 测试策略

- **单测（node --test）** `tests/model-sessions.test.mjs`：分组键优先级（`served` 优先于 `tries.at(-1).model`）；同模型并发取最新；改道跨模型归属（归最后一次尝试的模型）与 `reroutes` 计数；缺 `ttft`/`speed` 时的 `null` 降级；空 routes；进行中 route 的归属与 `live` 状态；`error`/`ok` 判定；排序与 6 行上限 `hiddenCount`；无 try 的请求不建行。
- **UI 回归** `tests/ui/model-list.cjs`：沿用 `tests/ui/account-metrics.cjs` 的模式（本地 HTTP server 注入 mock trace/usage + 真实 Electron + 窗口打桩），断言：行数、模型名与四项指标文案、`—` 降级、汇总行、断线时保留上一帧、点击仍然被阻挡（复用 `pointer-input` 的关键断言）；产出 `artifacts/model-list/result.json`。
- **全量**：`npm test` 必须全绿（当前基线 223 通过）。
- 删除的测试所覆盖的功能已不存在，删除即正确的覆盖收敛，不视为覆盖下降；`model-list.cjs` 与保留的命中区/拖动/材质测试共同覆盖剩余行为。

## 10. 交付顺序（供实现计划参考）

1. 提取 `web/timing.mjs`、`web/redact.mjs`（纯搬迁，测试改路径）。
2. 新增 `model-sessions.mjs` + 单测（TDD：先写测试）。
3. `index.html`/`styles.css` 换成列表骨架，`app.js` 接上新渲染。
4. 删除路由舞台/动画代码与模块、删除失效测试、改 CI。
5. 改写 `account-metrics`/`layout-motion`，新增 `tests/ui/model-list.cjs`。
6. `README` 与截图、版本号 1.5.0。
7. 全量 `npm test` + UI 回归验证。

## 11. 风险与未决项

- **排序跳动**：最近活动倒序会让行在请求到达时换位。已确认采用倒序；实现时用一个常量开关保留切换到稳定字典序的可能。
- **trace 裁剪**：挂件长时间运行后，某模型的行可能因裁剪消失。可接受（行语义是「最近一次请求」），不在本次处理。
- **无 try 的极早期请求**不建行（不显示、不计入汇总），窗口极短。
- **`served` 与 `tries[].model` 不一致**时以 `served` 优先；若实测出现反例，需要回到本 spec 修订。
- **覆盖收敛**：删除 5 个 UI 回归会降低舞台动画方面的覆盖，属于功能移除的必然结果；新增 `model-list.cjs` 需至少覆盖行数/文案/降级/阻挡点击四项。
- **截图重拍**需要真机窗口（离屏截图不反映 Windows 原生模糊，README 已有说明），需在有桌面会话时执行。
- **版本号 1.5.0** 会改变 `package.json`；本次不触发发布（用户 fork 的发布渠道尚未建立）。