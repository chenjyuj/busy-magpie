# Provider 分组模型列表（Provider-Grouped Model List）设计

- 日期：2026-10-31
- 状态：设计已获口头确认，待用户审阅本 spec
- 基线：提交 `6930dcb`（v1.5.0 模型会话列表已落地）
- 前置 spec：`docs/superpowers/specs/2026-10-31-model-session-list-design.md`（1.5.0 的初始设计；本文取代其分组与视觉章节）

## 1. 背景与目标

1.5.0 把卡片主视图改成了「按实际服务模型分组的最近会话列表」。用户在实际使用后提出 5 条改进，核心变化是：**分组维度从模型改为 Provider**，**视觉风格从深色透明改为 magpie 额度页的浅灰卡片风**，并让**进行中的请求不再清空行数据**。

需求原文：
1. 需要显示模型的来源（provider）
2. 可以缩放框（保留现有拖边缩放）
3. 进行中不影响显示上一次的数据
4. 增加额度显示（进度条，挂 Provider 组头）
5. 样式参照截图（magpie 额度页，完全复刻）

成功标准：

1. 卡片按 Provider 分组，每组一个灰色大写组头 + 额度进度条，组内是模型行。
2. 模型行显示四项指标 + 状态；进行中的行保留上一次完成的指标，不清空。
3. 浅灰不透明卡片风格，视觉对齐 magpie 额度页。
4. 拖边/拖角缩放继续工作，整卡继续阻挡点击。
5. `npm test` 全绿；新增/更新对应的单测与 UI 回归；浏览器实测通过。

## 2. 非目标（YAGNI）

- 不做深色/浅色双主题；只做浅色一套。
- 不加缩放按钮（保留拖边缩放即可）。
- 不做按模型分组与按 Provider 分组的切换开关。
- 不改 magpie 接口、不改 shell/ 更新机制、不动 plugin/。
- 不做每个模型行的独立额度（额度只在 Provider 组头）。

## 3. 现状与约束（已核实）

- 分组逻辑在 `web/model-sessions.mjs`：`modelSessionRows(routes, {limit=6}) -> {rows, hiddenCount}`，按 `served` 模型名分组，每行取该模型最新请求。
- 渲染在 `web/app.js`：`renderModelList(rows, hiddenCount)` → `modelRowNode(row)` → 五列固定网格（`.model-row`）。
- 视觉在 `web/styles.css`：深色半透明（`--surface-alpha` 渐变）、`.model-row` 深色圆角行。
- 窗口材质在 `src/window-material.cjs`：Win11 22H2+ 原生模糊 / macOS Vibrancy / 其余透明。
- trace 数据字段（本机实测）：`route.order[].{id,provider,name,who,kind,used,amount,limit,unit,renews,known}`、`route.tries[].{id,model,done,status}`、`route.{served,done,status,error,ms,ttft,out,flow,time}`。
- 旧版 `quotaInfo()` 取数逻辑（1.4.3 `presenter.js:160-173`，git 历史可取）：`picked.known` → `used` 夹取 0-100 → `remaining = 100-used`、`amount/limit/unit/renewAt(usedRenews||renews[0])`。

## 4. 决策记录

| 问题 | 决定 |
| --- | --- |
| 模型来源显示 | 行内 provider 小标签 → **改为按 Provider 分组，组头常驻显示** |
| 缩放 | 保留现有四边/四角拖动缩放 |
| 进行中请求 | 行保留**上一次完成**的指标，状态显示「进行中」 |
| 额度显示 | **Provider 组头**水平进度条 + 百分比；悬停看明细 |
| 视觉风格 | **完全复刻 magpie 额度页**：浅灰底、白色卡片、灰色大写组头 |

## 5. 数据模型

### 5.1 `web/model-sessions.mjs` 重构

```js
export function providerSessionGroups(routes, { limit = 6 } = {})
// -> { groups: Group[], hiddenCount: number }
```

`Group`：

```js
{
  key,          // provider 标识（小写）
  provider,     // 显示名（OfficeAce / WorkBuddy AI），沿用 presenter.providerName
  account,      // 组头账号（打码跟随设置，渲染时处理）
  quota,        // {remaining, used, amount, limit, unit, renewAt} | null
  at,           // 组内最新活动时间（组排序用）
  models: [     // 该 provider 最近服务过的模型，按活动时间倒序
    {
      model,        // served 模型名
      ms, ttft,     // 最近完成请求的指标（number|null）
      speed,        // tok/s（number|null）
      status,       // 'error' | 'live' | 'ok'（最新请求的状态）
      reroutes,     // 跨模型改道次数
      at,           // 最新活动时间
      route,        // 原始 route 引用（悬停明细用）
    }
  ]
}
```

规则：

1. **分组键**：`seat.provider || route.provider`（`seat` = `order` 匹配 `tries.at(-1).id` 的条目，回退 `order[0]`）；无 provider 的归入 `provider: 'magpie'` 兜底组。
2. **组内模型去重**：同一 provider 下同一 `served` 模型只保留一行。
3. **指标取最近完成请求**：先找该 (provider, model) 的最近 `done` 请求取 `ms/ttft/speed`；再找最新请求（可能 `live`）决定 `status/at/reroutes`。无完成请求时指标为 null → 渲染 `—`。
4. **额度**：取该 provider 最近使用账号的 `order` 条目，复用旧版 `quotaInfo()` 口径；`known` 缺失或 `used` 非有限数 → null。
5. **排序**：组按 `at` 倒序（最新活动的 provider 在上）；组内模型按 `at` 倒序。
6. **上限**：`limit` 限模型行总数（不含组头），超出计入 `hiddenCount`；不截断组（组完整显示或完整隐藏）。
7. 纯函数，不读 DOM/全局/时钟。

### 5.2 保留的接口

`modelSessionRows` **导出名保留**但标记 deprecated？**不保留**——直接替换为 `providerSessionGroups`，同步更新 `tests/model-sessions.test.mjs` 与 `web/app.js`。旧的按模型分组逻辑整个删除。

## 6. 视觉规格

参照 magpie 额度页截图（浅灰底、白色卡片、灰色大写组头、水平进度条）：

### 6.1 画布与卡片

- 画布仍为 600×400 逻辑像素，等比缩放机制（`applyUiScale`）不变。
- 卡片底色 `#f5f5f7`，**不透明**（`--surface-alpha` 固定为 1；不再依赖原生模糊）。
- 圆角 `16px`；边框 `1px solid #e5e5ea`；阴影 `0 4px 16px rgba(0,0,0,0.12)`。

### 6.2 组头（Provider 行）

```
OFFICEACE                              剩余 89%
                                    ████████████░░░░
```

- 高度约 28px，上下留 8px 间距。
- 左：Provider 名大写灰色 `#86868b`、10px、字间距 `0.08em`。
- 右：`剩余 89%` 文字（11px，同灰色）+ 进度条（80×4px 圆角，颜色阈值见 6.4）。
- 无额度（quota null）→ 只显示组名，不渲染进度条与「剩余」。
- 悬停组头：`额度明细：已用 5755 / 9600 credits · 11月19日续期`（title 属性）。

### 6.3 模型行

```
● glm-5.3                    3.0 秒   600ms   100 tok/s   完成
```

- 白色背景 `#ffffff`、圆角 `12px`、内边距 `10px 14px`、行间距 `4px`。
- 行首状态点（8px 圆）：`ok` 绿 `#34c759`、`live` 蓝 `#007aff` 脉冲、`error` 红 `#ff3b30`。
- 模型名：`#1d1d1f` 加粗 13px；`live` 行的状态词用蓝色、`error` 用红色、`ok` 用灰色 `#86868b`。
- 三指标列：等宽数字右对齐，颜色 `#3a3a3c`；缺失显示 `—`（灰色 `#c7c7cc`）。
- 行尾「改道 N 次」小字（`#ff9500`，9.5px）。
- 悬停模型行：`provider · 账号（打码）· 最近活动 · 改道 N 次 · tok/s 明细`（沿用现有逻辑）。
- **进行中的行**：显示上一次完成的指标（非 `—`），状态点蓝色脉冲 + 状态词「进行中」。

### 6.4 进度条颜色

| 剩余 | 颜色 |
| --- | --- |
| ≥ 50% | `#34c759` 绿 |
| 20% – 49% | `#ff9500` 橙 |
| < 20% | `#ff3b30` 红 |

底轨 `#e5e5ea`；进度条宽 80px、高 4px、圆角 2px。

### 6.5 顶部条与汇总

- 顶部条：「模型 · 实时」+ token 胶囊 + 右上菜单，配色改浅色系（文字 `#1d1d1f`，胶囊 `#e8e8ed` 底）。
- 汇总行（hiddenCount > 0）：灰字 `+N 个模型`，右对齐。
- 空态/断线：沿用现有文案与行为（「等待 magpie 数据」/「暂未刷新」+ 保留上一帧）。

### 6.6 窗口材质

`src/window-material.cjs` 简化为：始终 `{ kind: 'none', options: { transparent: false, roundedCorners: true, hasShadow: true } }`。浅色不透明卡片不需要原生模糊/Vibrancy。**连带**：`windows-blur.cjs` 的 `attachBlur` 不再被调用（保留文件，shell 仍引用）；**「背景不透明度」设置项（滑条 + `settings.json` 的 `opacity` 字段）一并移除**——卡片不透明后该设置无意义；`publicSettings` 不再传 `backgroundMaterial` 与 `opacity`；渲染端 `applySurface` 删除。

## 7. 文件变更清单

**修改**
- `web/model-sessions.mjs`：`modelSessionRows` → `providerSessionGroups`；行数据增加 quota/最近完成指标分离。
- `web/app.js`：`renderModelList` → `renderProviderGroups`；组头+进度条渲染。
- `web/index.html`：DOM 骨架改为组容器 + 组头 + 行容器；设置面板删「背景不透明度」滑条。
- `web/styles.css`：整卡浅灰不透明卡片风；组头/行卡片/进度条/状态点样式；删除深色透明与 opacity 相关变量。
- `src/main.js`：删 `opacity` 设置链路（defaults/loadSettings/publicSettings/settings:save）；`applySurface`/`magpie:surface-opacity` IPC 删除。
- `src/window-material.cjs`：简化为固定 `kind: 'none'`。
- `tests/model-sessions.test.mjs`：改为测 `providerSessionGroups`（分组/额度/live 保留/上限/排序）。
- `tests/ui/model-list.cjs`：改为按新 DOM 断言（组头/行/进度条/live 保留）。
- `tests/settings-panel.test.cjs`、`tests/settings-save.test.cjs`、`tests/preview.test.cjs`、`tests/ui/pointer-input.cjs`：适配 opacity 设置移除与新视觉。
- `README.md`：视图章节更新；settings.json 示例与字段表删 `opacity`。

**不动**
- `shell/`、`plugin/`、`src/preload.js`、`src/gateway-config.cjs`、`src/launch-policy.cjs`。
- `web/timing.mjs`、`web/redact.mjs`、`web/presenter.js`。
- CI 结构（`tests/ui/model-list.cjs` 名称不变）。

## 8. 测试策略

- **单测**（`tests/model-sessions.test.mjs` 重写）：provider 分组键；组内模型去重与排序；额度取数（known/used/renews；null 情形）；live 保留最近完成指标；error 状态优先；hiddenCount 上限；无 provider 兜底组；纯函数不变式。
- **UI 回归**（`tests/ui/model-list.cjs` 改写）：组头渲染与进度条宽度/颜色；模型行指标与状态词；live 行有指标（非 —）；点击阻挡；缩放后行不溢出；紧凑模式。
- **浏览器实测**（复用 `tools/mock_models.py` + CDP）：ok/error/live/missing/many/flaky/empty 七场景在新视图下的截图与断言；新增额度场景验证进度条。
- **`npm test` 全量**必须全绿。

## 9. 风险与未决项

- **`transparent: false` 的窗口行为**：从透明改为不透明窗口后，Windows 上的圆角由 `roundedCorners: true` 处理（Chromium 自绘）；需在真实桌面验证拖动/缩放/点击阻挡不回归（`pointer-input`/`drag-bounds` 回归覆盖）。
- **额度数据覆盖面**：只有 `known: true` 的账号有额度；无额度的 provider 组头只显示名字，视觉上会与其他组不对称——可接受。
- **trace 裁剪**：长时间运行后某 provider 组可能消失（同 1.5.0 行为，可接受）。
- **mock 需补额度字段**：`tools/mock_models.py` 的 `order[]` 需带 `known/used/amount/limit/unit/renews` 才能驱动进度条断言；需验证或补充。
- **旧 `modelSessionRows` 的调用方**：只有 `app.js` 与单测，同步替换即可。
