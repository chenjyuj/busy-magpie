# 卡片可读性：按出厂尺寸阅读 / 双行模型行 · 测试用例（v1.8.0）

- 日期：2026-11-01
- 对应需求：默认卡片「字太小、看不清」「文字被裁」——不靠手动放大，卡片本身在 316×221 窗口下就要读得清
- 相关文档：`README.md`、`docs/test-cases/2026-11-01-card-shrink-scroll-drag-test-cases.md`
- 自动化位置：`tests/ui/model-list.cjs`（真实 Electron）、`tests/ui/pointer-input.cjs`、`tests/ui/drag-bounds.cjs`

## 背景与根因

上一轮把窗口从 632×442 减半到 316×221，但卡片画布仍是 600×400：`--ui ≈ 0.47`，行内 12px 文字到屏幕只剩 5.6px，模型名 14px 只剩 6.6px，测量值更小。用户实际的感受是「看不了」「被裁」。

本轮把画布改为 500×333、每行改双行：

- 画布 500×333 → `--ui ≈ 0.5616`（316×221 窗口，stage 280×187）。
- 行高 60（画布px）：第一行模型名 20px + 右侧状态 16px；第二行测量值 16px、中点分隔。屏幕上是名称 ≈11.2px、测量 ≈9px。
- 状态从等高红线改为带白底的状态标签，压在名称行右侧；「改道 N 次」橙色小标并到测量行开头（在自增内层里垂直居中）。
- 时长在卡片行内改印 ascii 形式（`3.0s`），与同一行的 `600ms`、`100 tok/s` 一致；未缩放的请求明细窗仍用中文 `3.0 秒`。
- 其他卡片部位（provider 头 16、空表态 16、页脚 14）随画布一起提高；列表高度约 179 画布px，可完整放 1 个 provider 组 + 下个组的头，其余滚动。

## 用例表

| ID | 标题 | 前置 | 步骤 | 预期 | 自动化位置 |
| --- | --- | --- | --- | --- | --- |
| LG-01 | 默认窗口的画布缩放 | 默认 316×221 | 读 `--ui` | `--ui ≈ 0.56`（500×333 画布 / 316×221 窗口面积） | `tests/ui/model-list.cjs`「1b」读取 `--ui` 并断言 |
| LG-02 | 模型行分两行阅读 | 已渲染 | 读 `.row-main` / `.row-metrics` | 第一行含 `.model-name` 与 `.state-word`；第二行含时长、首字节、tok/s 三段 | `tests/ui/model-list.cjs`「1b」`mainHasName/mainHasState/metricsHasAll` |
| LG-03 | 画布字号下限 | 已渲染 | 读计算字号 | 模型名 ≥ 20px、测量行 ≥ 16px（画布px）；行高 = 60 | `tests/ui/model-list.cjs`「1b」字号与 `rowHeight` 断言 |
| LG-04 | 到屏幕后的可读下限 | `--ui` 0.56 | 字号 × `--ui` | 模型名 ≥ 11px、测量行 ≥ 8.5px | `tests/ui/model-list.cjs`「1b」`nameSize*ui`、`metricSize*ui` |
| LG-05 | 双行行不再单行裁字 | 已渲染 | 视觉与截图 | 名称与状态同一行、测量在下一行；`600ms · 100 tok/s` 不被裁 | `tests/ui/model-list.cjs` 截图 `groups.png`；`docs/screenshots/multi.png`、`single.png` |
| LG-06 | 时长在卡片行改印 ascii | 已渲染 | 读 `.col-ms` | `3.0s`（不再是 `3.0 秒`） | `tests/ui/model-list.cjs`「1. 每组一行」与「live 行保留完成指标」 |
| LG-07 | 改道标记仍在 | 有 `tries` 改道 | 读 `.row-reroute` | 文本 `改道 1 次`，橙色小标落在测量行开头 | `tests/ui/model-list.cjs`「1. 每组一行」 |
| LG-08 | 缩放后行距与热区仍正确 | 默认窗口 | 读行 `clientHeight`、点击行中心 | 行的热区在屏幕坐标下仍能点开请求明细（`--ui` 参与换算） | `tests/ui/pointer-input.cjs`（17 项）、`tests/ui/detail-window.cjs`「a real mouse click on a row opens the detail window」 |
| LG-09 | 滚动与拖动不受双行影响 | 多组数据 | 滚轮、按住行拖动 | 列表内部滚动；任意位置拖动正常，拖动不开浮窗 | `tests/ui/model-list.cjs`「7b/7c/7d」、`tests/ui/drag-bounds.cjs`（8 项） |

## 回归基线（2026-11-01 22:30 后重跑）

| 回归 | PASS | 命令 |
| --- | --- | --- |
| `npm test`（单测） | 227/227 | `node tools/run-tests.cjs` |
| `tests/ui/model-list.cjs` | 17/17 | `node node_modules/electron/dist/electron.exe tests/ui/model-list.cjs --disable-gpu --no-sandbox` |
| `tests/ui/pointer-input.cjs` | 17/17 | 同上（换文件） |
| `tests/ui/drag-bounds.cjs` | 8/8 | 同上（换文件） |
| `tests/ui/detail-window.cjs` | 15/15 | 同上（换文件） |

## 说明与坑

- **为什么把画布换成 500×333 而不是继续放大窗口**：窗口是用户放在桌角的常驻卡片，保持 316×221；画布越小缩放比越高。500×333 是「字号能看清」与「一屏仍能看到一个组 + 下一组头」的交点。清单高度约 179 画布px。
- **测量行为什么用 ascii**：中文单位在 9px 屏幕上发虚；同一行上 `600ms`、`100 tok/s` 本来就用 ascii，`3.0s` 跟它们一致。请求明细窗没有缩放，仍用中文完整写法。
- **状态标签压在名称行右端**：名称是单行省略（`text-overflow: ellipsis`），标签占据右侧固定宽度，名称用 `flex:1; min-width:0` 收窄，过长仍打点不换行。
- **改道小标**：本质是 `.row-reroute` 放进 `.row-metrics` 内层 flex（`align-items:center`），因此与三个测量值同一视觉基线，不额外占一行。
- **测试读的是画布字号**：`getComputedStyle` 返回画布 px；是否「到屏幕够大」要再乘 `--ui`（LG-04），这两层分开断言，避免再次出现「字号看着不小但屏幕上看不清」。
