# 模型请求明细浮窗 · 测试用例（v1.7.0）

- 日期：2026-11-01
- 对应设计：`docs/superpowers/specs/2026-11-01-model-request-detail-window-design.md`
- 对应实施计划：`docs/superpowers/plans/2026-11-01-model-request-detail-window.md`
- 自动化位置：`tests/route-facts.test.mjs`、`tests/requests.test.mjs`、`tests/detail-placement.test.cjs`（单测）；`tests/ui/detail-window.cjs`（真实 Electron 双窗口回归）；`tools/mock_models.py` + `tools/cdp.mjs`（浏览器实测）
- 浏览器实测报告：`docs/reports/2026-11-01-model-request-detail-test-report.html`（含 5 张截图与逐步命令）

## 层级与运行方式

| 层级 | 命令 | 产物 |
| --- | --- | --- |
| 单测 | `npm test` | 标准输出（227 项） |
| 浮窗界面回归 | `Remove-Item Env:ELECTRON_RUN_AS_NODE; node node_modules/electron/cli.js tests/ui/detail-window.cjs --disable-gpu --no-sandbox` | `artifacts/detail-window/result.json` + `detail.png` |
| 既有回归 | 同上，文件名换 `model-list.cjs` / `pointer-input.cjs` / `drag-bounds.cjs`（后者加 `--scale=1 --label=x`） | 各自 `artifacts/*` |
| 浏览器实测 | `python tools/mock_models.py 3500 detail` + `BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 node node_modules/electron/cli.js . --preview --remote-debugging-port=9223 --disable-gpu --no-sandbox` + `CDP_MATCH=index.html|detail.html node tools/cdp.mjs eval|shot` | `docs/reports/screenshots-detail/*.png` → HTML 报告 |

> 两个页面靠 `CDP_MATCH` 区分：`index.html` 是卡片，`detail.html` 是浮窗。

## 用例表

| ID | 标题 | 前置 | 步骤 | 预期 | 层级 | 自动化位置 |
| --- | --- | --- | --- | --- | --- | --- |
| PG-D01 | 点模型行打开浮窗 | 卡片有 `glm-5.3` 行 | 1. 点击行 2. 读浮窗标题 | 出现第二个窗口；标题为 `{provider 显示名} · {模型}` | UI 回归 + 浏览器实测 | `tests/ui/detail-window.cjs`「the detail window opens with a title…」；报告 D1 |
| PG-D02 | 行内含时间与四项指标 | 浮窗已打开 | 1. 读首行五个格子 | 时间 `HH:MM:SS`、时长、首字节、tok/s、状态齐备且数值正确 | UI 回归 + 浏览器实测 | 同上「each row carries clock, duration, first byte, pace and state」；报告 D1 |
| PG-D03 | 每页 20 条，可继续加载 | 该模型有 25 条请求 | 1. 首屏读行数 2. 点「加载更多」 3. 再读 | 首屏 20 行且按钮可见；点击后 25 行且按钮隐藏 | UI 回归 + 浏览器实测 | 同上「twenty rows a page, with the rest on demand」；报告 D2 |
| PG-D04 | 实时置顶且不改变已加载窗口 | 已加载 2 页（40 行窗口） | 1. 推入更新的请求 2. 读行数与首行 | 行数保持 40；新请求在首行；更早的重新出现在「加载更多」后 | UI 回归 + 浏览器实测 | 同上「a newer request slides in on top without resizing the loaded window」；报告 D3 |
| PG-D05 | 进行中行只显示自己的空缺 | 该模型最新请求仍在流式 | 1. 读该行五格 | 时长/首字节/tok·s 均为 `—`，状态「进行中」；**不继承**上一次完成的数据 | 单测 + UI 回归 + 浏览器实测 | `tests/requests.test.mjs`「a live row keeps none of the metrics」；`tests/ui/detail-window.cjs`「an in-flight row shows its own gaps…」；报告 D4 |
| PG-D06 | 错误行与缺首字节行 | 该模型含一条 500 与一条无 ttft | 1. 读错误行 2. 读缺首字节行 | 错误行状态「错误」、红点；缺首字节行显示 `4.2 秒 / — / —`，不出现 `0ms` | 单测 + 浏览器实测 | `tests/requests.test.mjs` 缺失独立判定；报告 D4 |
| PG-D07 | 默认尺寸与可缩放 | 浮窗已打开 | 1. 读窗口尺寸 2. 拖边后重开 | 默认 420×520（最小 360×300）；可原生拖边缩放；关掉重开回到默认尺寸（不持久化） | 人工核对 + 源码约束 | `src/main.js` 的 `DETAIL_WIDTH/DETAIL_HEIGHT/minWidth/minHeight`；设计 §5.2 |
| PG-D08 | 位置贴卡片、空间不足翻左、夹取 | 卡片在屏幕右侧 | 1. 读卡片与浮窗 `screenX/outerWidth` 2. 算缝隙 | 右侧有位置时 `x = 卡片右缘 + 12`；放不下翻到左侧同样 12px；越界夹取到工作区内；顶部对齐 | 单测 + 浏览器实测 | `tests/detail-placement.test.cjs`（7 项）；报告 D5（实测翻左 12px） |
| PG-D09 | 浮窗跟随卡片移动 | 浮窗已打开 | 1. 移动卡片 2. 读两窗口位置差 | 浮窗与卡片位移一致（±2px） | UI 回归 | `tests/ui/detail-window.cjs`「the detail window follows the card and sits beside it」 |
| PG-D10 | 卡片隐藏 / 退出 / 更新前关闭浮窗 | 浮窗已打开 | 1. `hide()` 卡片 2. 读窗口数 | 浮窗关闭，只剩卡片；退出与更新安装路径同样先关闭（源码路径核对） | UI 回归 + 源码核对 | 同上「the close button and a hidden card both close the detail window」；`src/main.js` `quit()`/`installUpdate()` |
| PG-D11 | Esc 与 × 关闭 | 浮窗已打开 | 1. 派发 Esc 2. 点 `.detail-x` | 两种方式都关闭浮窗，卡片不受影响 | UI 回归 + 浏览器实测 | 同上「Escape closes the detail window」；报告 D5 末步 |
| PG-D12 | 点其他模型切换内容且不新开窗 | 卡片上有第二个模型 | 1. 点模型 A 2. 点模型 B | 窗口数仍为 2；标题与列表换成 B；条数按 B 的第一页 | UI 回归 | 同上「clicking another model swaps the list in the same window」 |
| PG-D13 | 网关重启清表 → 空态 | 已加载多行 | 1. 模拟网关重启（pid 变化、routes 为空） 2. 读浮窗 | 0 行、「这个模型还没有请求」可见、按钮隐藏，不残留旧行 | UI 回归 | 同上「a restarted gateway leaves an empty list, not stale rows」 |
| PG-D14 | 模型行可键盘到达 | 卡片有模型行 | 1. 读行的 `tabIndex/role/aria-label` 2. 读命中区上报 | `tabIndex=0`、`role=button`、`aria-label` 含模型名；行矩形出现在 `busy:hit-areas` 的 `controls` 里 | UI 回归 | 同上前三项检查（focusable button / asks for that provider / reported as a control） |
| PG-D15 | 共享事实口径 | — | 1. 跑 route-facts 单测 | `providerKeyOf` 兜底 `magpie`、`servedModel` 回落最后一次尝试、`statusOf` 三态、`measured(0)→null`、`clockOf` 本地 `HH:MM:SS` 与非法→空、`quotaOf` 无窗口→null | 单测 | `tests/route-facts.test.mjs`（11 项） |
| PG-D16 | 明细投影 | — | 1. 跑 requests 单测 | 过滤/倒序+id 决胜/分页 20 与 40/`hasMore`/进行中不继承/错误优先/缺失独立/空输入不抛/`providerName` 优先级 | 单测 | `tests/requests.test.mjs`（11 项） |
| PG-D17 | 抽取未改行为 | — | 1. `npm test` 2. `git diff tests/model-sessions.test.mjs` | 227/227 全绿；断言文件一行未改 | 单测 + git | 计划 Task 1 验收；报告「单元测试」条目 |
| PG-D18 | 既有回归不受浮窗影响 | harness 已改造 | 1. 跑三个既有回归 | model-list 11/11、pointer-input 16/16、drag-bounds 7/7 | UI 回归 | `tests/ui/{model-list,pointer-input,drag-bounds}.cjs`；报告「既有回归」条目 |
| PG-D19 | 文档与报告 | — | 1. 核对 README 小节 2. 打开报告 | README 有「请求明细浮窗」说明；报告 5 场景全过、含截图与命令 | 人工核对 | `README.md`；`docs/reports/2026-11-01-model-request-detail-test-report.html` |

## 覆盖矩阵（对设计文档 §11 验收标准）

| 设计 §11 验收项 | 用例 |
| --- | --- |
| 点击模型行打开浮窗，标题为 provider · 模型 | PG-D01 |
| 逐行给出时间/时长/首字节/tok·s/状态 | PG-D02、PG-D05、PG-D06 |
| 每页 20，「加载更多」+20，加载完按钮隐藏 | PG-D03 |
| 新请求实时置顶且不改变已加载条数 | PG-D04 |
| 进行中显示 `—` + 进行中（不继承）；错误红点 | PG-D05、PG-D06 |
| 默认 420×520、可拖边缩放、关掉即忘；位置贴卡片、翻左、跟随 | PG-D07、PG-D08、PG-D09 |
| 卡片隐藏 / 退出 / 更新前关闭 | PG-D10 |
| 切换模型不新开窗口 | PG-D12 |
| Esc 与 × 关闭 | PG-D11 |
| `npm test` 全绿、model-sessions 断言未改 | PG-D15、PG-D16、PG-D17 |
| 既有 UI 回归改造后全绿 + 新浮窗回归全过 | PG-D14、PG-D18、PG-D13 |
| README 与用例表更新、报告含截图 | PG-D19 |

## 环境受限项（不算失败，需注明）

| 回归 | 现状 | 原因 |
| --- | --- | --- |
| `tests/ui/glass-composition.cjs` | 0 PASS（改动前后一致；历史桌面可用时为 5 PASS） | 当前桌面会话锁屏（LogonUI 在运行），锁屏时真实桌面窗口不绘制，其 `GetPixel` 采样超时 |
| `tests/ui/material.cjs` | 1 PASS / exit 1（改动前基线同样失败） | 本机无 GPU 会话下的既有失败 |
| `tests/ui/resize-handles.cjs` | 0 PASS / exit 1（改动前基线同样失败） | 同上（`GetWindowRgn` 不可用） |

## 维护约定

- 新增浮窗交互时，同步更新本表、`tests/ui/detail-window.cjs` 与报告场景（D1–D5 编号沿用）。
- 报告场景与 mock 场景对应：`detail` 场景 → D1–D4；位置与关闭 → D5。
- 卡片与明细的口径差异（进行中是否继承）是本设计刻意的相反行为，两边都必须有断言，改动任一侧都要同时看另一侧。
