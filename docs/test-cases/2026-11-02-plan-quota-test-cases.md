# 套餐窗口剩余量显示 · 测试用例（v1.10.0）

- 日期：2026-11-02
- 对应需求：opencode go 这类「套餐」供应商的剩余量没有正常显示——它的额度不是一个窗口，而是 5 小时 / 7 天 / 本月三个时间窗口，卡片要能把套餐的剩余量显示出来
- 相关文档：`README.md`、`docs/test-cases/2026-10-31-provider-grouped-list-test-cases.md`、`docs/superpowers/plans/2026-10-31-provider-grouped-model-list.md`
- 自动化位置：`web/plan-quota.mjs`（纯函数）、`tests/plan-quota.test.mjs`（单测）、`tests/model-sessions.test.mjs`（单测）、`tests/ui/model-list.cjs`（真实 Electron）、`tools/mock_models.py` `plan` 场景、`tools/quota-audit.mjs`

## 背景与根因

卡片的组头额度条一直只认一个口径：trace 里账号条目的 `known` / `used` / `amount` / `limit` / `unit` / `renews`——`used` 是「这个额度窗口已消耗的百分比」，`limit` 是窗口大小，两者都要有才画条（少了 `limit` 说明 magpie 手里没有这个账号的额度窗口，按量计费的 Key 就是这种，此时 `used: 0` 只代表「没有窗口」，画条会谎报「剩余 100%」）。

但 opencode go 不是这个形状。它是**套餐**：额度被拆成 5 小时、7 天、本月三个时间窗口，每个窗口各自算剩余量。magpie 在 trace 的账号条目里只报告「当前被哪个窗口约束着」和它的 `used`，**没有 `limit`**——所以卡片把它当成「没有额度窗口」，组头什么都不画。用户看到的是 opencode go 没有剩余量显示。

根因：卡片只有一个「单一额度窗口」的模型，读不到套餐的多窗口结构。

本轮的做法：

- **套餐是另一条数据通道**：`GET /v1/magpie/quotas` 返回 `{data: [{provider, name, kind, user, windows: [{name, used, remaining, resetsAt, holdsWhy}], last}]}`。`kind: "plan"` 的供应商才是套餐；卡片为这类供应商多画一行窗口列表。
- **套餐组头两行**：第一行仍是额度条，描述「套餐现在被哪个窗口约束着」（优先 `holdsWhy: "clock"` 的窗口，否则剩余最少的那个）；第二行列出套餐的**全部窗口**，短标签 `5H` / `7D` / `本月`。
- **同一供应商多账号按账号取**：`/v1/magpie/quotas` 里 opencode-go 有 6 条（每个账号一条），组头账号的 `user` 决定取哪条；取不到退到 magpie 标了 `last` 的那条。
- **纯函数分层**：窗口归一化、短标签、绑定窗口、按供应商索引都在 `web/plan-quota.mjs`，可单测；`providerSessionGroups` 只负责把套餐挂到组上。

## 用例表

| ID | 标题 | 前置 | 步骤 | 预期 | 自动化位置 |
| --- | --- | --- | --- | --- | --- |
| QW-01 | 一个窗口的剩余量与已用量被归一化并夹在 0–100 | 有 `windowQuota` | 传一个 `{remaining: 95, used: 5}` | `remaining=95`、`used=5`、`renewAt` 原样带出 | `tests/plan-quota.test.mjs`「windowQuota keeps the shares…」 |
| QW-02 | 越界的百分比被夹住，不是负数或超 100 | 同上 | 传 `{used: 140, remaining: -4}` | `remaining=0`、`used=100` | `tests/plan-quota.test.mjs`「windowQuota keeps the shares…」 |
| QW-03 | 只报一个份额时补出另一个 | 同上 | 传 `{used: 6}` / `{remaining: 94}` | 分别得 `remaining=94` / `used=6` | `tests/plan-quota.test.mjs`「windowQuota falls back…」 |
| QW-04 | 时间窗口用短标签，其他名字原样保留 | 有 `windowLabel` | 传 `5 hours` / `7 days` / `Month` / `Credits` | `5H` / `7D` / `本月` / `Credits`（中文名如「每日赠送」不被截断） | `tests/plan-quota.test.mjs`「windowLabel shortens…」 |
| QW-05 | 绑定窗口优先取 `holdsWhy: "clock"` | 有 `primaryWindow` | 三个窗口里只有一个标了 clock | 返回标了 clock 的那个，不是数组第一个 | `tests/plan-quota.test.mjs`「primaryWindow prefers…」 |
| QW-06 | 没标 clock 时取剩余最少的窗口 | 同上 | 三个窗口都没标 holdsWhy | 返回 `remaining` 最小的那个 | `tests/plan-quota.test.mjs`「primaryWindow falls back…」 |
| QW-07 | `kind: "plan"` 且至少一个可读窗口才算套餐 | 有 `planOf` | 传 subscription / 空 windows / 窗口无数字 | 都返回 `null`，不画套餐行 | `tests/plan-quota.test.mjs`「planOf reads a plan…」 |
| QW-08 | 组按账号取自己的套餐，退路是 `last` | 有 `planForGroup` | 一个供应商两条套餐（`user: "1"` / `"6"`） | `user: "1"` 取 1，`user: "6"` 取 6，空账号取 `last` 那条 | `tests/plan-quota.test.mjs`「planForGroup picks the account's own…」 |
| QW-09 | 按 provider 归组，不可读的条目被丢掉 | 有 `plansByProvider` | 混入 subscription / 空 windows / `null` | 只剩 `opencode-go` 一条键，且两个套餐条目都在里面 | `tests/plan-quota.test.mjs`「plansByProvider groups…」 |
| QW-10 | 套餐组的额度条描述绑定窗口，且挂着套餐 | 有 `providerSessionGroups` | 传一条 opencode-go 的 route + 套餐 | `group.plan.windows.length=3`，`group.quota.remaining=94`（clock 窗口），`renewAt` 是月窗口的续期时间 | `tests/model-sessions.test.mjs`「a plan group draws its windows…」 |
| QW-11 | 没有套餐的供应商保持原来的额度口径 | 同上 | 传 officeace 的 route + 空套餐 | `group.plan` 为 `undefined`，`group.quota.remaining=89` | `tests/model-sessions.test.mjs`「a provider without a plan keeps its seat allowance…」 |
| QW-12 | 组头画出两行：额度条 + 窗口行 | 真实 Electron + mock 网关 `plan` 场景 | 打开卡片 | `剩余 94%`、条宽 94%、`5H 95% · 7D 98% · 本月 94%`、`.provider-head-plan` 存在 | `tests/ui/model-list.cjs`「a plan head names the window it holds and the windows it is split into」 |
| QW-13 | 窗口行在条的正下方、不越过组头宽度 | 同上 | 读布局矩形 | 窗口行右边缘 ≤ 条的右边缘；窗口行宽度 < 组头宽度 | `tests/ui/model-list.cjs` 同一条（布局断言） |
| QW-14 | 悬停组头看到每个窗口的已用与续期 | 同上 | 读 `title` | 含 `5H 剩余 95%`、`7D 剩余 98%`、`本月 剩余 94%` | `tests/ui/model-list.cjs` 同一条 |
| QW-15 | mock 网关的 `plan` 场景可独立复现 | 起 `python tools/mock_models.py 3512 plan` | 读 `/v1/magpie/quotas` 与 `tools/quota-audit.mjs` | quotas 返回 3 个窗口；审计打印 `剩余 94.00%` 与 `5 hours 95% · 7 days 98% · Month 94%` | `tools/mock_models.py`、`tools/quota-audit.mjs` |
| QW-16 | 套餐窗口读不到时不画套餐行，也不谎报 | 真实网关 | 供应商 `kind: "plan"` 但 `windows` 为空 | 不画套餐行，也不拿普通额度条顶替 | `web/plan-quota.mjs` `planOf` 的 `null` 分支（QW-07 已锁） |

## 回归基线（2026-11-02 重跑）

| 回归 | PASS | 命令 |
| --- | --- | --- |
| `npm test`（单测） | 242/242 | `npm test` |
| `tests/ui/model-list.cjs` | 18/18 | `node node_modules/electron/cli.js tests/ui/model-list.cjs --no-sandbox --disable-gpu` |
| `tests/ui/font-tiers.cjs` | 7/7 | 同上（换文件） |
| `tests/ui/detail-window.cjs` | 15/15 | 同上（换文件） |
| `tests/ui/pointer-input.cjs` | 17/17 | 同上（换文件） |
| `tests/ui/drag-bounds.cjs` | 8/8 | 同上（换文件） |
| `tests/ui/resize-handles.cjs` | 环境限制 | 本机无 GPU 会话下 `GetWindowRgn` 返回 0，与改动无关（见既有用例文档） |

`tests/ui/glass-composition.cjs`、`material.cjs`、`native-blur.cjs` 是 1.6.0 之前「透明玻璃 + 原生模糊」时代的回归，1.8.0 把卡片改成不透明浅灰后已过期，不计入本轮基线。

## 说明与坑

- **为什么套餐走第二个通道而不是从 trace 推导**：trace 的账号条目只报告「当前被哪个窗口约束着」和它的 `used`，没有窗口清单，也没有每个窗口的剩余量。要从 trace 还原 5H/7D/本月，等于让卡片去猜 magpie 的内部模型。`/v1/magpie/quotas` 是 magpie 自己的额度页同口径，卡片直接读它，和读 trace 一样是「读本机 magpie」。
- **为什么套餐组头是两行而不是一个更宽的条**：5H / 7D / 本月三个窗口各自的剩余量不是一个「当前窗口剩余量」能代表的，一个条只能描述一个窗口。两行里第一行回答「现在被哪个窗口约束」，第二行回答「套餐里每个窗口还剩多少」。
- **为什么优先 `holdsWhy: "clock"`**：magpie 用 `holdsWhy` 标出哪个窗口正在约束这次请求（`clock` 是时钟窗口，`low` 是低额窗口）。没标时退化成「剩余最少的窗口」，因为那才是额度条该描述的约束。
- **为什么套餐的额度条不沿用 trace 的 `used`**：套餐账号的 trace 条目只有 `used`（当前窗口的百分比）而没有 `limit`，按老口径会被判成「没有额度窗口」而不画条。套餐组直接用套餐自己的 `primary` 窗口，`used`/`remaining` 都是套餐通道给的。
- **账号匹配是必要的**：opencode-go 有 6 个账号，每个的窗口剩余量不同。按组头账号的 `user` 取，才能保证画出来的不是别的账号的剩余量。
