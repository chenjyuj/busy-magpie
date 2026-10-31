# 模型会话列表 测试用例

- 关联设计：`docs/superpowers/specs/2026-10-31-model-session-list-design.md`（行为口径以 §5、§6、§7、§8 为准）
- 关联计划：`docs/superpowers/plans/2026-10-31-model-session-list.md`（本文件对应 Task 8，覆盖 Task 8 Step 1 的 12 项）
- 被测版本：`1.5.0`（基线 v1.4.3，提交 `5b15937`）
- 实测报告：`docs/reports/2026-10-31-model-session-list-test-report.html`（内含各场景截图）

## 层级与自动化入口

| 层级 | 入口 | 覆盖对象 |
| --- | --- | --- |
| 单测 | `node --test tests/model-sessions.test.mjs`（`npm test` 也会跑到） | `web/model-sessions.mjs` 纯逻辑：分组键、取最新、排序、6 行上限 |
| UI 回归 | `node node_modules/electron/cli.js tests/ui/model-list.cjs` | 本地 HTTP mock trace 与 usage + 真实 Electron（沿用本仓库 UI 回归的窗口打桩模式，见 `tests/ui/model-list.cjs` 头部）下的 DOM 文案与交互；结果写入 `artifacts/model-list/result.json` |
| 浏览器实测 | `python tools/mock_models.py 3500 <场景>` 与 `BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 node node_modules/electron/cli.js . --preview --remote-debugging-port=9223`，断言用 `node tools/cdp.mjs eval`，截图用 `node tools/cdp.mjs shot` | 报告场景 S1–S8，见文末「浏览器实测场景表」 |

DOM 约定（来自计划 Task 3 / Task 4）：列表容器 `#modelList`；数据行 `.model-row`；每行五列固定宽度（模型名 / 状态 / 时长 / 首字 / tok/s）；汇总行、空态与「暂未刷新」文案节点在容器内。若实现改动这些约定，需同步本表与报告。

## 覆盖矩阵（计划 Task 8 Step 1 的 12 项）

| 要求覆盖项 | 对应用例 |
| --- | --- |
| 6 行内分组与排序 | MSL-07、MSL-08、MSL-12 |
| `served` 优先于 `tries.at(-1).model` | MSL-01、MSL-10 |
| 改道跨模型归属与计数 | MSL-03、MSL-27 |
| 缺失指标显示 `—`（不得 `0ms` / `0 tok/s`） | MSL-05、MSL-13 |
| 三态状态（错误 / 进行中 / 完成） | MSL-06、MSL-14 |
| `+N 个模型` 汇总行 | MSL-08、MSL-15、MSL-26 |
| 断线保留上一帧并标「暂未刷新」 | MSL-16、MSL-25 |
| 空态「等待 magpie 数据」 | MSL-09、MSL-17、MSL-24 |
| 整卡阻挡点击 | MSL-18、MSL-20 |
| 窗口缩放 | MSL-22 |
| 紧凑模式 | MSL-23 |
| 悬停账号打码 | MSL-19 |

每条用例都有自动化归属：`tests/model-sessions.test.mjs`（新建）、`tests/ui/model-list.cjs`（新建）或浏览器实测的某个报告场景；没有归属的用例不收录。

## 用例表

| ID | 标题 | 前置条件 | 步骤 | 预期 | 层级 | 自动化位置 |
| --- | --- | --- | --- | --- | --- | --- |
| MSL-01 | 分组键优先取 `served`，回退最后一次尝试的模型 | route A：`served='glm-5.3'`、`tries.at(-1).model='deepseek-v4.1-flash'`；route B：`served` 为空、`tries.at(-1).model='glm-5.3'` | 1. `modelSessionRows([A, B])`<br>2. 读 `rows[0].model` 与 `rows.length` | 两段请求合并为一行，`model='glm-5.3'`；不出现 `deepseek-v4.1-flash` 行；该行取两段中 `time` 更大的那段 route | 单测 | `tests/model-sessions.test.mjs` |
| MSL-02 | 同模型多次请求只保留最新一次 | 两条 route 同为 `served='glm-5.3'`，`time` 分别早 10s 与早 1s，`ms` 不同；另备一对 `time` 相同、`id` 一大一小的 route | 1. `modelSessionRows(routes)`<br>2. 读行的 `ms` / `at`；`time` 相同时读胜出行的 `key` | 同模型只有一行，取 `time` 最大的 route（`ms`/`at` 来自较新那条）；`time` 相同则 `id` 数值大者胜出 | 单测 | `tests/model-sessions.test.mjs` |
| MSL-03 | 改道跨模型归属最后一次尝试并计 `reroutes` | 四种 tries：① 全 `glm-5.3`；② `deepseek-v4.1-flash` → `glm-5.3`；③ 三个不同模型；④ 同一模型重试三次 | 1. 分别调用 `modelSessionRows`<br>2. 读 `model` 与 `reroutes` | ① `reroutes=0`；② 归 `glm-5.3` 且 `reroutes=1`；③ `reroutes=2`；④ `reroutes=0`（不同模型数减 1，最小 0） | 单测 | `tests/model-sessions.test.mjs` |
| MSL-04 | 无 `served` 也无 `tries` 的 route 被跳过且不抛异常 | 一条正常 route（有 `served`）与两条异常 route：`served=''` + `tries=[]`；`served=undefined` + `tries=undefined` | 1. `modelSessionRows(routes)`<br>2. 读 `rows.length`、`hiddenCount` 与 `rows[0].model` | 不抛异常；只建正常那条行；`rows.length=1`；`hiddenCount=0`（跳过的 route 不计入汇总） | 单测 | `tests/model-sessions.test.mjs` |
| MSL-05 | 指标为 `0` / 缺失时降级为 `null`，不伪造数值 | route 甲：`ttft=0`、`out=0`；route 乙：`ms` 缺失；route 丙：`done=true`、`firstText=0`（整段返回） | 1. `modelSessionRows`<br>2. 逐条读 `ttft` / `ms` / `speed` | 甲：`ttft===null`；乙：`ms===null`；丙：`speed===null`。三者都不得为 `0` 或据此推算出速度 | 单测 | `tests/model-sessions.test.mjs` |
| MSL-06 | 三态判定优先级 `error` > `live` > `ok` | 四组 route：① 带 `error` 字段且 `done=false`；② `status=503`、无 `error`；③ `done=false`、`status=200`；④ `done=true`、`status=200` | 1. `modelSessionRows`<br>2. 按顺序读 `status` | 依次为 `error`、`error`、`live`、`ok`；① 证明 `error` 压过 `live`，不显示「未知」 | 单测 | `tests/model-sessions.test.mjs` |
| MSL-07 | 按最近活动倒序排序，活跃模型在上 | 3 个不同模型，`time` 交错（最旧、最新、居中） | 1. `modelSessionRows`<br>2. 读 `rows.map(r => r.at)` | `at` 严格降序；最新活动的模型在首位；同 `at` 时按 `id` 降序稳定输出 | 单测 | `tests/model-sessions.test.mjs` |
| MSL-08 | 6 行上限与 `hiddenCount` 一致 | 7 个不同模型的 route，活动时间各不相同 | 1. `modelSessionRows(routes)`（默认 `limit`）<br>2. 再传 `limit=3` 重跑 | 默认：`rows.length===6`、`hiddenCount===1`；`limit=3`：`rows.length===3`、`hiddenCount===4`；余数始终等于真实剩余模型数 | 单测 | `tests/model-sessions.test.mjs` |
| MSL-09 | 空输入不抛异常 | `routes=[]`、`routes` 缺省 | 1. `modelSessionRows([])` 与 `modelSessionRows()` | `rows` 为空数组、`hiddenCount===0`，不抛异常 | 单测 | `tests/model-sessions.test.mjs` |
| MSL-10 | 只按模型名分组，不含 provider | 两条 route：`served='deepseek-v4.1-flash'`，provider 分别为 `officeace` / `workbuddy`，账号不同，`time` 一旧一新 | 1. `modelSessionRows`<br>2. 读 `rows.length`、`provider`、`account` | 只有一行；`provider`/`account` 取较新那条（悬停明细显示最新请求的供应商与账号） | 单测 | `tests/model-sessions.test.mjs` |
| MSL-11 | 纯函数：不修改输入、不依赖 DOM | 一份 `routes` 深拷贝快照 | 1. 记录快照<br>2. `modelSessionRows(routes)`<br>3. 再次比对快照 | 输入数组与对象未被修改、未被原地排序；模块在无 DOM 的 `node --test` 环境下即可运行，不读全局状态 | 单测 | `tests/model-sessions.test.mjs` |
| MSL-12 | 行数与四项指标文案正确 | UI 回归 mock 三个模型：ok / live / error 各一，ok 行的 `ms`、`ttft`、`out` 齐全 | 1. 起 mock 并等首帧渲染<br>2. 读 `#modelList .model-row` 数量<br>3. 读 ok 行各列文本 | 行数为 3；列顺序为 模型名 / 状态 / 时长 / 首字 / tok/s；ok 行含模型名、「完成」、`formatDuration(ms)` 输出、`formatLatency(ttft)` 输出与 `Math.round(rate) tok/s` | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-13 | 缺失指标显示 `—`，绝不出现 `0ms` / `0 tok/s` | UI 回归 mock 一个缺 `ttft` 的模型与一个整段返回（`firstText=0`）的模型 | 1. 渲染后读这两行的首字列与 tok/s 列文本<br>2. 读 `document.body.innerText` | 缺失格子为 `—`；整页文本不含 `0ms`、`0 tok/s`、`NaN`、`undefined` | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-14 | 三态状态文字与状态点呈现 | UI 回归 mock error（`status=503`）、live（`done=false`）、ok 三个模型 | 1. 读三行状态列文本<br>2. 读状态点的类名 / 计算样式 | 依次为「错误」「进行中」「完成」；三点样式互不相同；live 点带脉冲效果，不出现「未知」 | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-15 | `+N 个模型` 汇总行 | UI 回归切到第二态：7 个模型 | 1. 渲染后统计 `.model-row`<br>2. 读汇总行文本与列结构 | 可见数据行 6 行 + 汇总行 1 行；汇总行为 `+1 个模型`（灰字、无状态列）；`N=0` 时汇总行不存在 | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-16 | 断线保留上一帧并标「暂未刷新」 | UI 回归先送一帧 3 行数据，再送断线（或 pid 变化的清表） | 1. 记录首帧 3 行的文本<br>2. 触发断线<br>3. 再读行数与文本 | 仍为 3 行且内容与首帧一致，不闪空、不残留已清空的模型；出现「暂未刷新」标注；连接恢复后标注消失并接受新数据 | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-17 | 空态文案 | UI 回归 mock 返回 `routes=[]` | 1. 等首帧<br>2. 读 `#modelList` 文本与 `.model-row` 数量 | 显示「等待 magpie 数据」；`.model-row` 为 0；不显示汇总行 | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-18 | 整卡仍阻挡鼠标点击，行不可点击 | UI 回归沿用 `pointer-input` 的窗口打桩与命中区上报 | 1. 检查卡片区域未开启点击穿透<br>2. 对行所在的卡片坐标派发点击<br>3. 点击数据行本体 | 卡片区域接收点击、不穿透到下层窗口；数据行不可点击，不触发菜单、更新或导航；顶部 28px 拖动条、7px 边与 14px 角缩放带、token 胶囊、右上菜单仍可命中 | UI 回归 | `tests/ui/model-list.cjs`（关键断言复用 `tests/ui/pointer-input.cjs`） |
| MSL-19 | 悬停显示供应商与账号，账号跟随打码 | UI 回归 mock 一条带 `provider` 与账号邮箱的 route；`maskAccounts` 默认 `true`，另跑一遍 `false` | 1. 悬停数据行读 tip 文本（默认打码）<br>2. 关闭打码后再读 tip 文本 | 默认：tip 含供应商名、打码账号（形如 `a•••@e•••.com`）与最近活动 / 改道次数，`innerText` 不含完整邮箱；关闭打码后才显示原文；行内不出现账号 | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-20 | 点击与悬停不改变列表布局 | UI 回归渲染 3 行后记录各行的 `getBoundingClientRect()` | 1. 点击行、悬停行<br>2. 重新读行数与位置 | 行数不变、位置与尺寸不变；除悬停 tip 外不新增节点；不打开设置或菜单 | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-21 | 回归结果留档 | 一次完整 `model-list.cjs` 运行 | 1. 运行结束后读 `artifacts/model-list/result.json` | 文件含每条断言的名称与通过状态；断言失败时仍写出文件并记录失败项与错误信息 | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-22 | 窗口缩放下列表不溢出、不被裁切 | UI 回归第 8 项：真实窗口放大到 700×700（再叠 `drag-bounds` 的 1 倍与 1.75 倍路径） | 1. 放大窗口后读 `--window-h`、`--ui` 比例<br>2. 实测 `.model-list` 的底边与末行 `getBoundingClientRect().bottom` | `--window-h` 随窗口增大；末行底边不超出 `.model-list` 底边；行高、列宽、字号按同一比例缩放，行不被裁切 | UI 回归 | `tests/ui/model-list.cjs` |
| MSL-23 | 紧凑模式与恢复 | 浏览器实测场景 S7：先有 ≥3 行列表数据 | 1. 调 `window.busy.toggleCompact()`（真实主进程 IPC）<br>2. 截图并读窗口尺寸与状态条文本<br>3. 再切一次恢复 | 紧凑时窗口 360×112、`.stage-area` 隐藏、`#compactView` 可见并显示连接状态与活动请求数；恢复后回到完整列表 | 浏览器实测 | 报告场景 S7 |
| MSL-24 | 空态实测 | 浏览器实测场景 S8：mock 场景 `empty`（`routes=[]`） | 1. 起卡片并截图<br>2. `node tools/cdp.mjs eval` 读文案与行数 | 卡片显示「等待 magpie 数据」、无 `.model-row`、无汇总行、右上角仍为「实时」；截图可读且无布局塌陷 | 浏览器实测 | 报告场景 S8 |
| MSL-25 | 断线实测：保留上一帧并标「暂未刷新」 | 浏览器实测场景 S6：mock 场景 `flaky`（前 2 次 trace 正常，之后 500） | 1. 等失败生效后截图<br>2. 读行数与连接文案 | 3 行内容保持首帧不变、不闪空；`body` 带 `stale`、右上角「重连中」；重启 mock 后恢复「实时」并接受新数据 | 浏览器实测 | 报告场景 S6 |
| MSL-26 | 7 模型汇总实测 | 浏览器实测场景 S5：mock 场景 `many`（7 个 served 模型） | 1. 截图<br>2. 读 `.model-row` 数量与汇总行文本 | 6 行数据 + 「+1 个模型」汇总行；行高一致、整体不溢出 600×400 画布；截图入报告 | 浏览器实测 | 报告场景 S5 |
| MSL-27 | 行尾「改道 N 次」小字 | UI 回归 mock 一条跨两个模型改道的 route（`reroutes=2`）与一条未改道的 route | 1. 读改道行的行尾文本<br>2. 读未改道行的行尾文本 | 改道行行尾显示「改道 2 次」小字（不是状态列）；`reroutes=0` 的行不显示该小字；悬停 tip 里同样给出改道次数 | UI 回归 | `tests/ui/model-list.cjs` |

## 浏览器实测场景表

场景名与 CLI 参数以 `tools/mock_models.py` 的实现为准（`ok | error | live | missing | many | flaky | empty`）。

| 场景 | mock 场景参数 | 数据特征 | 覆盖用例 |
| --- | --- | --- | --- |
| S1 | `ok` | 4 条 route / 3 个 served 模型；glm-5.3 由两个 provider 各服务一次（应合并为一行）；全部完成且 `ms`/`ttft`/`out` 齐全 → 恰好 100 tok/s | MSL-01、MSL-10、MSL-12 |
| S2 | `error` | 3 行：一条 500 + `error`（错误）、一条 tries 跨两个模型（改道 1 次，route 自身 200）、一条普通成功 | MSL-14、MSL-27 |
| S3 | `live` | 3 行：最新一条 `done=false`、无 `ms`/`out`、`ttft=900` | MSL-13、MSL-14 |
| S4 | `missing` | 3 行：最新一条有 `ms=4200` 但无 `ttft`/`out` | MSL-13 |
| S5 | `many` | 7 个 served 模型，活动时间步进 10s | MSL-15、MSL-26 |
| S6 | `flaky` | 前 2 次 trace 正常（同 `ok` 数据），第 3 次起 HTTP 500 | MSL-16、MSL-25 |
| S7 | `ok` + 紧凑切换 | 先出 3 行，再调 `window.busy.toggleCompact()` 进入 360×112 状态条 | MSL-23 |
| S8 | `empty` | trace 返回 `routes=[]`（网关可读但还没有请求） | MSL-17、MSL-24 |

缩放（MSL-22）由 UI 回归里真实窗口改尺寸覆盖，不再单列浏览器场景；`tests/ui/model-list.cjs` 第 8 项同时验证窗口放大后行不溢出与紧凑模式隐藏列表。

## 维护约定

- 用例与实现同批提交；单测先于实现落地（TDD），UI 回归与浏览器实测的截图一并进报告。
- 每新增一条覆盖项，必须指向上述三个层级中的一个具体位置；浏览器实测用例要写明报告场景号，否则不予收录。
- 场景截图（含缩放与紧凑态）保存在 `docs/reports/screenshots/`，报告为单文件内联图片，不依赖外链。