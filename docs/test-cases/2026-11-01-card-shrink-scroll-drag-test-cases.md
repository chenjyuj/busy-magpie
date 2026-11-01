# 卡片减半 / 全量渲染滚动 / 任意位置拖动 · 测试用例（v1.8.0）

- 日期：2026-11-01
- 对应需求：卡片整体缩小一半（含字号）、主页面列表可滚动、点窗口任意位置可拖动
- 相关文档：`docs/superpowers/specs/2026-11-01-model-request-detail-window-design.md`、`README.md`
- 自动化位置：`tests/ui/model-list.cjs`、`tests/ui/pointer-input.cjs`、`tests/ui/drag-bounds.cjs`、`tests/ui/detail-window.cjs`（真实 Electron）

## 用例表

| ID | 标题 | 前置 | 步骤 | 预期 | 自动化位置 |
| --- | --- | --- | --- | --- | --- |
| PG-S01 | 窗口默认减半 | 无配置或旧配置 | 1. 启动 2. 读 `innerWidth/innerHeight` 与 `settings.json` | 卡片 `316×221`（紧凑 `180×56`）；旧配置 `width:632` 无 `sizeEpoch` 时启动后自动减半并写回 `sizeEpoch:2` | `src/main.js` 的 `WIDTH/HEIGHT/MIN_WIDTH/MIN_HEIGHT/SIZE_EPOCH` 与 `loadSettings` 迁移；`tests/ui/drag-bounds.cjs`（`width:316, sizeEpoch:2`） |
| PG-S02 | 字号与行高随画布缩小 | 窗口减半 | 1. 读 `--ui` 2. 读模型行 `getBoundingClientRect().height` | `--ui ≈ 0.4675`（= 画布/窗口），行高从 44 缩到 ~20.6（44 × 0.4675），整张卡片等比缩放 | 浏览器实测（预览实例实测 `ui=0.4675, rowH=20.6`） |
| PG-S03 | 取消 6 行上限，全部渲染 | `many` 场景 7 个模型 | 1. 渲染 2. 数行数与 `#modelHidden` | 7 行全部显示（旧行为是 6 行 + 「+1 个模型」）；`#modelHidden` 恒 `hidden`、文本为空 | `tests/ui/model-list.cjs`「many 场景渲染全部 8 行」 |
| PG-S04 | 列表可滚动 + 滚轮 | 行数超过容器高度 | 1. 读 `scrollHeight > clientHeight` 2. 派发滚轮事件 | 容器 `overflow-y:auto`；滚轮事件路由到 `provider-groups`（offscreen 窗口不执行默认滚动，属 harness 限制）；`scrollIntoView` 后 `scrollTop > 0` | `tests/ui/model-list.cjs`「7b 滚动容器 / 7c 滚轮路由 + 可滚动」 |
| PG-S05 | 按住任意位置并移动即可拖动 | 卡片已渲染 | 1. 在卡片中部（列表内）派发 mouseDown 2. mouseMove 超过 4px 3. mouseUp 4. 读窗口 `getBounds()` | 窗口随光标位移移动（列表内、顶栏、页脚三处都能拖）；mouseUp 后停止 | `tests/ui/model-list.cjs`「7d 任意位置拖动」、`tests/ui/pointer-input.cjs`、`tests/ui/drag-bounds.cjs` |
| PG-S06 | 不移动的单击仍触发原操作 | 卡片已渲染模型行 | 1. 在行中心按下并直接松开（不移动）2. 读窗口数与事件 | 窗口不移动；该行点击照常打开明细浮窗；Token 胶囊单击仍切时间窗 | `tests/ui/detail-window.cjs`「a real mouse click on a row opens the detail window」 |
| PG-S07 | 拖动不误开浮窗 | 卡片已渲染模型行 | 1. 按住行并拖动超过阈值 2. 松手 3. 读窗口数 | 拖动后仍只有 1 个窗口（拖动产生的 click 被抑制，不会打开明细） | `tests/ui/model-list.cjs`「7d 拖动后窗口数仍为 1」、`tests/ui/pointer-input.cjs`「任意位置拖动后不开浮窗」 |
| PG-S08 | 顶部长按手势与缩放不受影响 | 卡片已渲染 | 1. 顶栏长按拖动 2. 拖边框/角缩放 | 顶部小圆点长按 0.15s 仍可拖动；四条边与四角仍可缩放（最小 `300×216`） | `tests/ui/pointer-input.cjs`（17 项）、`tests/ui/drag-bounds.cjs`（8 项） |

## 回归基线（2026-11-01）

| 回归 | PASS | 命令 |
| --- | --- | --- |
| `npm test`（单测） | 227/227 | `npm test` |
| `tests/ui/detail-window.cjs` | 15/15 | `node node_modules/electron/cli.js tests/ui/detail-window.cjs --disable-gpu --no-sandbox` |
| `tests/ui/model-list.cjs` | 14/14 | 同上 |
| `tests/ui/pointer-input.cjs` | 17/17 | 同上 |
| `tests/ui/drag-bounds.cjs` | 8/8 | 同上 + `--scale=1 --label=half` |

## 说明与坑

- **缩放方式**：卡片是一块 600×400 画布，窗口越小 `--ui` 越小，字号/行高/间距随之等比缩小（不是逐元素改 px）。因此「窗口减半」即可实现「整体缩小一半 + 字体缩小」。
- **迁移一次性**：`loadSettings` 里 `sizeEpoch` 缺省时按旧尺寸减半并写回；已经带 `sizeEpoch` 的配置不再动，用户后来的手动缩放得以保留。
- **拖动判定**：`pointerdown` 记录起点，`pointermove` 超过 4px 才调用 `dragStart`；**起手不设指针捕获**（否则 click 会被重定向到 `#card`，行的点击失效），只有判定为拖动后才捕获，并用 `suppressClick` 吞掉拖动后的 click。
- **滚动**：`.provider-groups` 需要 `pointer-events: auto` 才能收到滚轮/拖动（卡片整体是 `#app` 的 `pointer-events: none`）。
- **CDP 测不出拖动位移**：CDP 的 `Input.dispatchMouseEvent` 不会移动 Electron 的 `screen.getCursorScreenPoint()`（那是真实光标），所以拖动位移必须用 `sendInputEvent` 的 UI 回归来验证。

> 2026-11-01 晚：画布从 600×400 改为 500×333，`--ui` 从 ≈0.4675 变为 ≈0.56，模型行改为双行（行高 60 画布px），本文 PG-S02 的数值以当时为准；现行布置见 `2026-11-01-card-legibility-test-cases.md`。
