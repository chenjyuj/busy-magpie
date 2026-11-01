# 字号档位 / 卡片大小预设 / 设置面板不跟着缩放 · 测试用例（v1.9.0）

- 日期：2026-11-01
- 对应需求：卡片上的字想看清，不想靠手拖窗口；设置里直接选「字号」和「卡片大小」；调字号时设置面板不能跟着变大、也不能溢出要滚动
- 相关文档：`README.md`、`docs/test-cases/2026-11-01-card-legibility-test-cases.md`
- 自动化位置：`tests/ui/font-tiers.cjs`（真实 Electron）、`tests/settings-save.test.cjs`（单测）

## 背景与根因

1.8.0 把窗口减半到 `316×221` 后，卡片按 500×333 的画布等比缩放（`--ui ≈ 0.56`），列表已经按出厂尺寸调到可读；但用户想再大一点时只有两条路——手动拖窗口（改的是尺寸记忆，还不保证形状），或者忍受小字。

同时，设置面板和卡片共用同一块画布和同一个 `--ui`：一旦把画布调小（放大内容），设置面板的字、间距、表单也一起放大，外观页放不下，只能滚动。用户看到的是「调字号把设置调花了」。

本轮的做法：

- **字号 = 内容缩放，不是窗口缩放**：`--canvas-w/h = 500×333 ÷ 档位`，档位为 小 `0.88` / 标准 `1` / 大 `1.16` / 特大 `1.34`。窗口不动，`--ui` 随之升高，模型名、测量值、组头、页脚、胶囊一起变大，行数随之减少。
- **卡片大小 = 窗口尺寸**：只把宽度发给主进程，主进程用 `heightForWidth` 补高度，四档为 `308×216` / `316×221` / `380×264` / `460×317`。小档取 308 而不是 300，因为 300 宽按形状只有 211 高、低于 216 的下限，主进程会把它拉回 `308×216`——芯片必须承诺用户真拿得到的窗口。
- **设置面板是 chrome，不是卡片内容**：面板仍按画布排版、跟着窗口缩放，但 `.settings-inner` 用 `transform: scale(1 / var(--font-zoom))` 抵消字号档位，四个档位下字都读同一个大小；外观页在四个档位都不需要滚动。
- **「恢复默认位置和大小」改叫「复位」，移到设置标题栏**：给「卡片大小」让出外观页的位置；托盘菜单里的同名项不变。

## 用例表

| ID | 标题 | 前置 | 步骤 | 预期 | 自动化位置 |
| --- | --- | --- | --- | --- | --- |
| FT-01 | 默认档位就是 1.8.0 的出厂卡片 | 新配置 | 读 `--font-zoom` / 画布 | `--font-zoom = 1`，画布 500×333，窗口不因打开设置变化 | `tests/ui/font-tiers.cjs`「the card renders at the default tier」 |
| FT-02 | 大档位放大内容、不动窗口 | 默认窗口 | 选「大」 | `--font-zoom = 1.16`，画布缩到 431×287，`--ui` 升高，模型名到屏幕 ≥ 原值 +1.5px，窗口 bounds 不变，行仍在列表内 | `font-tiers.cjs`「a larger tier zooms the card without touching the window」 |
| FT-03 | 小档位缩回、不动窗口 | 默认窗口 | 选「小」 | `--font-zoom = 0.88`，模型名到屏幕比标准小，窗口 bounds 不变 | `font-tiers.cjs`「a smaller tier zooms the card down without touching the window」 |
| FT-04 | 胶囊热区跟着缩放走 | 大档位 | 读 `tokenPill` 的屏幕矩形与上报热区 | 热区与胶囊矩形一致（`--ui` 参与换算） | `font-tiers.cjs` FT-02 内断言 |
| FT-05 | 设置面板在四个档位读到一样大 | 设置打开 | 标准档与特大档各量一次面板/内层矩形 | 面板宽、内层屏幕宽一致；特大档 `scale = 1/1.34`；外观页最后一项在页内，`scrollHeight - clientHeight ≤ 1` | `font-tiers.cjs`「the settings panel reads at one size whatever the card tier」 |
| FT-06 | 卡片大小档位真的改窗口 | 默认窗口 | 选「特大」 | 窗口变 `460×317`（±1），画布随之变宽，行不越界，窗口比例仍 1.5 | `font-tiers.cjs`「a card size preset resizes the window and keeps the card shape」 |
| FT-07 | 小档是主进程保得住的最小窗口 | 默认窗口 | 选「小」 | 窗口是 `308×216`（不是被拉回的 300 宽） | `font-tiers.cjs`「the smallest size preset is the smallest window main keeps」 |
| FT-08 | 回到标准档位即恢复原样 | 改过窗口与字号 | 选「标准」 | 窗口 bounds 与初始一致，模型名到屏幕与初始差 < 0.5px | `font-tiers.cjs`「the standard preset restores the original card」 |
| FT-09 | 字号芯片按下即保存、重开还原 | 设置打开 | 点字号芯片 → 保存 → 重开设置 | 芯片 `aria-pressed` 跟随 `settings.fontSize`；保存写进 `settings.json`，重载仍保留；未知值回退 `normal` | `tests/settings-save.test.cjs`「the font tier survives a save and reload and falls back to normal」 |
| FT-10 | 卡片大小只发宽度，高度由主进程补 | 设置打开 | 点卡片大小芯片 → 保存 | 保存载荷只带 `width`；主进程按形状补高度（460 → 317），宽度夹在 300..屏幕宽度之间 | `tests/settings-save.test.cjs`「a card size preset arrives as a width and the height follows the card shape」 |
| FT-11 | 复位在设置标题栏、和表单分开 | 设置打开 | 读 `settingsResetPosition` 的位置 | 按钮在标题栏内（位于表单组之上、面板右上），点它调 `resetPlacement()` 且不关闭面板 | `tests/ui/font-tiers.cjs`「the settings panel reads at one size whatever the card tier」（含复位位置断言） |
| FT-12 | 其他入口不受影响 | — | 模型行点击、拖动、滚轮、设置各页 | 见回归基线 | 见下 |

## 回归基线（2026-11-01 23:35 重跑）

| 回归 | PASS | 命令 |
| --- | --- | --- |
| `npm test`（单测） | 232/232 | `npm test` |
| `tests/ui/font-tiers.cjs` | 7/7 | `node node_modules/electron/cli.js tests/ui/font-tiers.cjs --no-sandbox --disable-gpu` |
| `tests/ui/model-list.cjs` | 17/17 | 同上（换文件） |
| `tests/ui/pointer-input.cjs` | 17/17 | 同上（换文件） |
| `tests/ui/drag-bounds.cjs` | 8/8 | 同上（换文件） |
| `tests/ui/detail-window.cjs` | 15/15 | 同上（换文件） |
| `tests/ui/resize-handles.cjs` | 环境限制 | 本机无 GPU 会话下 `GetWindowRgn` 返回 0（`0 !== 3`），在 HEAD 上同样失败，与本轮改动无关 |

`tests/ui/glass-composition.cjs`、`material.cjs`、`native-blur.cjs` 是 1.6.0 之前「透明玻璃 + 原生模糊」时代的回归，1.8.0 把卡片改成不透明浅灰后它们断言的透明穿透/材质名已不存在，属于过期用例，不计入本轮基线（本轮不修改也不删除，留给一次性清理）。

## 说明与坑

- **为什么用缩放画布而不是一堆 font-size 规则**：卡片里所有尺寸都已经按 `--ui` 等比缩放，只要改画布大小，文字、行距、图标、列宽、热区一起变，不需要逐条维护字号表。代价是一屏行数随档位变化，这是设计上接受的取舍。
- **设置面板为什么能"免疫"**：面板挂在同一个画布节点里，字号档位会把它一起放大；`.settings-inner` 用 `scale(1/--font-zoom)` 把它按回原来的屏幕尺寸。这是「反向缩放」，所以 `--font-zoom` 必须由 `applyUiScale()` 写在同一处，避免两个来源打架。
- **小档为什么是 308**：`heightForWidth(300) = 211 < MIN_HEIGHT(216)`，主进程会把窗口拉回 216 高、308 宽；芯片写 300 会骗人。测试 `FT-07` 专门锁这一点。
- **手动拖窗口不覆盖芯片选择**：`cardSizeTouched` 只在真的点了卡片大小芯片时才把 `width` 写进保存载荷，否则手拖过的窗口会被「最近档位」硬掰回去。
- **字号与窗口尺寸互不影响**：`fontSize` 与 `width/height` 各存各的；改字号不写尺寸，改窗口不清字号。
