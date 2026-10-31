# Provider 分组模型列表 · 测试用例（v1.6.0）

- 日期：2026-10-31
- 对应设计：`docs/superpowers/specs/2026-10-31-provider-grouped-model-list-design.md`
- 对应实现计划：`docs/superpowers/plans/2026-10-31-provider-grouped-model-list.md`
- 自动化位置：`tests/model-sessions.test.mjs`（单测）、`tests/ui/model-list.cjs`（真实 Electron 回归）、`tools/mock_models.py` + `tools/cdp.mjs`（浏览器实测）
- 浏览器实测报告：`docs/reports/2026-10-31-provider-grouped-list-test-report.html`（含 8 张截图与逐步命令）

## 层级与运行方式

| 层级 | 命令 | 产物 |
| --- | --- | --- |
| 单测 | `npm test`（含 `tests/model-sessions.test.mjs`、`tests/timing.test.mjs`、`tests/settings-panel.test.cjs`、`tests/settings-save.test.cjs`） | 标准输出 |
| 界面回归 | `node node_modules/electron/cli.js tests/ui/model-list.cjs --disable-gpu --no-sandbox` | `artifacts/model-list/result.json` + 截图 |
| 浏览器实测 | `python tools/mock_models.py 3500 <场景>` + `node node_modules/electron/cli.js . --preview --remote-debugging-port=9223 --disable-gpu --no-sandbox` + `node tools/cdp.mjs eval|shot` | `docs/reports/screenshots-v2/*.png` → HTML 报告 |

> 本机会话没有 GPU 上下文，Electron 需带 `--disable-gpu --no-sandbox`；截图按 `CDP_SCALE=2` 出双倍图。

## 用例表

| ID | 标题 | 前置 | 步骤 | 预期 | 层级 | 自动化位置 |
| --- | --- | --- | --- | --- | --- | --- |
| PG-01 | 按服务供应商分组 | mock `ok` | 1. 起卡片 2. 读 `.provider-group` | 每个供应商一个组；组头显示供应商名；组内每个模型一行 | 单测 | `tests/model-sessions.test.mjs`「groups by the serving provider, newest group first」 |
| PG-02 | seat 的 provider 优先于请求自身的 provider | 单条 route，`order[].provider` 与 `route.provider` 不同 | 1. 分组 2. 读组键与组头 | 组键取 `order[].provider`，组头显示其展示名 | 单测 | `tests/model-sessions.test.mjs`「the seat provider wins over the route provider」 |
| PG-03 | 没有 provider 时归入 magpie 兜底组 | route 与 order 的 provider 都为空 | 1. 分组 | 出现 `magpie` 组，不抛异常 | 单测 | `tests/model-sessions.test.mjs`「a route with no provider falls into the magpie group」 |
| PG-04 | 同一供应商下同一模型只占一行 | 同一 provider 的同名模型两条 route | 1. 分组 | 组内该模型一行，取最新一条 | 单测 | `tests/model-sessions.test.mjs`「each provider keeps one row per model, newest first」 |
| PG-05 | 组头额度取自最近使用的账号 | `order[]` 带 `known/used/amount/limit/unit/renews` | 1. 分组 2. 读 `quota` | `remaining = 100 - used`（夹取 0–100），其余字段原样 | 单测 | `tests/model-sessions.test.mjs`「the quota comes from the provider seat and is clamped to 0-100」 |
| PG-06 | 没有额度数据时无进度条 | `known` 缺失或 `used` 非有限数 | 1. 分组 2. 读组头 | `quota` 为 null，界面不画条 | 单测 + 界面回归 | `tests/model-sessions.test.mjs`「a seat without known or with a non-finite used has no quota」；`tests/ui/model-list.cjs`「a provider with no reported allowance shows no bar at all」 |
| PG-06b | **没有额度窗口时不得谎报 100%** | `known: true, used: 0`，但 `limit` 缺失或为 0（按量计费 Key，或供应商接口报错、magpie 没读到额度） | 1. 分组 2. 读 `quota` 与组头 | `quota` 为 null，**不画条**、不显示「剩余 100%」 | 单测 + 界面回归 | `tests/model-sessions.test.mjs`「a seat without a quota window has no allowance, not a full one」；`tests/ui/model-list.cjs` 同 PG-06 用例后半段；真实网关核对 `tools/quota-audit.mjs` |
| PG-07 | 额度条按剩余量分三档 | 剩余 89% / 40% / 15% | 1. 读 `.provider-bar i` 的 class 与宽度 | 89% 无 class（绿）、40% `mid`（橙）、15% `low`（红）；宽度等于剩余百分比 | 界面回归 + 浏览器实测 | `tests/ui/model-list.cjs`「the allowance bar is green, amber or red by what is left」；报告场景 S2 |
| PG-08 | 进行中的请求保留上一次完成的数据 | 同一 provider+model 先有一条已完成，再有一条进行中 | 1. 渲染 2. 读该行三项指标与状态 | 指标仍是上一次完成请求的值；状态为「进行中」 | 单测 + 界面回归 + 浏览器实测 | `tests/model-sessions.test.mjs`「a live request keeps the metrics of the last completed one」；`tests/ui/model-list.cjs` 同名用例；报告场景 S3 |
| PG-09 | 从未完成的请求没有指标 | 只有一条进行中的请求 | 1. 渲染 2. 读该行 | 三项均为 `—`，不是 0 | 单测 + 界面回归 | `tests/model-sessions.test.mjs`「a model that has never completed shows no metrics, not zero」；`tests/ui/model-list.cjs`「missing measurements read as a dash…」 |
| PG-10 | 缺失的指标显示破折号 | route 有 `ms` 但无 `ttft`/`out` | 1. 渲染 2. 读该行与整段文本 | 时长正常显示，首字与 tok/s 为 `—`；页面不出现 `0ms`/`0 毫秒`/`0 tok/s` | 单测 + 界面回归 + 浏览器实测 | `tests/model-sessions.test.mjs`「missing metrics stay null instead of zero」；报告场景 S4 |
| PG-11 | 状态三态判定 | 分别给出 `status>=400`、未完成、正常完成的 route | 1. 渲染 2. 读状态类与状态词 | 依次为 错误 / 进行中 / 完成 | 单测 + 界面回归 + 浏览器实测 | `tests/model-sessions.test.mjs`「an error outranks live and ok」；报告场景 S5 |
| PG-12 | 改道次数 | 一条 route 的 `tries` 跨 3 个模型 | 1. 分组 2. 读 `reroutes` | `reroutes = 2`；行尾显示「改道 2 次」；未改道的行不显示该小字 | 单测 + 浏览器实测 | `tests/model-sessions.test.mjs`「a rerouted request counts the models it moved through」；报告场景 S5 |
| PG-13 | 行数上限只算模型行 | 7 个模型分属 3 个供应商 | 1. 分组 2. 数行与组 | 行数 ≤ 6；组要么整组显示要么整组不显示，不出现空组头；余量汇总为 `hiddenCount` | 单测 + 界面回归 + 浏览器实测 | `tests/model-sessions.test.mjs`「the limit caps model rows, not groups…」；报告场景 S6 |
| PG-14 | 汇总行文案 | 超过上限 | 1. 渲染 2. 读 `#modelHidden` | 显示「+N 个模型」，`N` 等于未显示的模型数 | 界面回归 + 浏览器实测 | `tests/ui/model-list.cjs`「the cap keeps model rows…」；报告场景 S6 |
| PG-15 | 卡片为浅灰不透明、行是白色 | 任意场景 | 1. 读 `.card` 与 `.model-row` 的计算样式 | 卡片 `rgb(245,245,247)`、圆角 16px；行 `rgb(255,255,255)` | 界面回归 | `tests/ui/model-list.cjs`「the card is the opaque light sheet with white rows」 |
| PG-16 | 断线保留上一帧并标暂未刷新 | 先有数据，再让网关失败 | 1. 渲染 2. 读 `body.className`、`#liveState`、行数 | 行数据保留；`body` 带 `stale`；`#liveState` 为「重连中」 | 界面回归 + 浏览器实测 | `tests/ui/model-list.cjs`「a dropped gateway keeps the last frame and marks it stale」；报告场景 S7 |
| PG-17 | 空态文案 | 网关可读但没有请求 | 1. 渲染 2. 读行数与 `#modelEmpty` | 0 行、0 组；显示「等待 magpie 数据」；无汇总行；`#liveState` 仍为「实时」 | 浏览器实测 | 报告场景 S8 |
| PG-18 | 整卡仍阻挡鼠标点击 | 正常渲染 | 1. 检查 `setIgnoreMouseEvents` 调用 2. 读命中区上报 | 面板区域不穿透；token 胶囊与拖动条仍在命中区里 | 界面回归 | `tests/ui/model-list.cjs`「the card keeps blocking clicks and reporting its hit areas」；`tests/ui/pointer-input.cjs`（16 项） |
| PG-19 | 缩放后行不溢出画布 | 窗口放大到 700×700 | 1. 读 `--window-h` 2. 比较末行底边与列表底边 | 窗口高度随放大；末行底边不超过列表底边 | 界面回归 | `tests/ui/model-list.cjs`「a resized window keeps rows inside the card…」 |
| PG-20 | 紧凑模式隐藏列表 | 切紧凑模式 | 1. 读 `body.compact`、`.stage-area` 与 `#compactView` 的 display | `body` 带 `compact`；`.stage-area` 为 `none`；`#compactView` 为 `flex` | 界面回归 | `tests/ui/model-list.cjs` 同上用例后半段 |
| PG-21 | 设置面板不再有透明度 | 打开设置 | 1. 读设置面板 2. 保存一次 | 没有「背景不透明度」滑条；保存载荷里没有 `opacity` 键 | 单测 | `tests/settings-panel.test.cjs`「saving the settings sends no opacity…」 |
| PG-22 | 旧配置文件仍可启动与保存 | `settings.json` 里残留 `opacity` | 1. 重新加载设置 2. 保存 | 正常加载；旧字段被忽略；保存成功 | 单测 | `tests/settings-save.test.cjs`「a legacy settings file that still carries opacity loads and stays usable」 |
| PG-23 | 升级/回滚仍保持用户设置 | 打包应用升级流程 | 1. 改一项设置 2. 升级 3. 回滚 | 该设置（现为 `showTiming`）在升级与回滚后保持 | 打包 E2E | `tests/business-update-e2e.cjs`（CI 打包流程，不在本地 `npm test` 内） |

## 覆盖矩阵

| 需求（来自设计） | 用例 |
| --- | --- |
| 按 Provider 分组显示模型 | PG-01、PG-02、PG-03、PG-04 |
| 额度显示在 Provider 上 | PG-05、PG-06、PG-06b、PG-07、PG-14 |
| 进行中不影响显示上一次的数据 | PG-08、PG-09、PG-16 |
| 保留拖边缩放 | PG-19、PG-20 |
| 样式参照截图（浅灰卡片 + 组头 + 进度条） | PG-15、PG-07、PG-11 |
| 附带清理（透明度设置移除） | PG-21、PG-22、PG-23 |

## 额度口径（与供应商余额的区别）

- 组头百分比 = `100 - order[].used`，其中 `used` 是**该账号额度窗口已消耗的百分比**，`limit` 是窗口大小；与 magpie 额度页同口径（例如 WorkBuddy 11.14% → 剩余 88.86%，magpie 页面显示 89%）。
- **必须 `known === true` 且 `limit > 0`** 才画条。只有一个 `used: 0` 而无窗口时，那表示「magpie 没有这个账号的窗口数据」（按量计费 Key，或供应商接口失败导致额度没读到），此时不画条。历史上这里会把 `used: 0` 当成「剩余 100%」并画出满格绿条——PG-06b 就是钉住这个缺陷的回归。
- trace 里没有供应商的**实时积分余额**字段，所以供应商接口回「积分不足」时，卡片可能仍显示窗口剩余若干（那是 magpie 上次读到的窗口读数）。真实网关核对方式：`node tools/quota-audit.mjs`（用渲染层同一个 `providerSessionGroups` 打印每个账号的判定与原始字段）。

## 维护约定

- 每条用例必须指向一个具体自动化位置；浏览器实测用例要写明报告场景号，否则不予收录。
- mock 场景与报告场景号保持一一对应：`ok→S1`、`quota→S2`、`live→S3`、`missing→S4`、`error→S5`、`many→S6`、`flaky→S7`、`empty→S8`；`one` 只用于 README 单组截图。
- mock 的额度表（`tools/mock_models.py` 的 `QUOTAS`）是确定值：OfficeAce 11%（剩 89%）、WorkBuddy 0%（剩 100%）、CodeArts 60%（剩 40%）、Trae CN 85%（剩 15%）；其余供应商不报额度。
- 新增界面元素时，同步更新本表、`tests/ui/model-list.cjs` 与报告场景。
