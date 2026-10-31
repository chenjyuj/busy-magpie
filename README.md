# Busy Magpie

**magpie 实时模型会话桌面挂件**

**A transparent live model-session perch for your desktop.**

一张浅灰、无边框的实时卡片，面板内的鼠标点击不会穿透到下面的窗口。它读取 magpie 本机 trace，按服务供应商分组显示最近的会话：每个供应商一个组头（含额度进度条），组内每个模型一行，给出最近一次请求的时长、首字节、token/s 和状态，以及这段时间用了多少 token。

A transparent, borderless card that blocks clicks within the panel, reads magpie's local trace and groups recent sessions by the model that actually served them, showing duration, time to first byte, tokens per second and status per model, plus the total tokens used.

[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20%C2%B7%20macOS%2012%2B-4b465c?style=flat-square)](#)
[![electron](https://img.shields.io/badge/Electron-39-8f7cff?style=flat-square)](https://www.electronjs.org/)
[![license](https://img.shields.io/badge/license-MIT-61d7e7?style=flat-square)](./LICENSE)

![Busy Magpie 模型会话列表](./docs/screenshots/multi.png)

> 截图为 v1.6.0 界面，使用本地模拟数据，账号已打码。

## 为什么是它

magpie 的「路由」页很好看，但它只在 magpie 自己的窗口里。Busy Magpie 把同一份实时 trace 变成一张常驻桌面的小卡片：

- **浅色、无边框**，不挡桌面。卡片是一张浅灰不透明的圆角卡片，文字和控件保持清晰。
- **阻挡点击**：面板内的鼠标点击不会落到下面的窗口，主视图和紧凑模式都生效。
- **不修改 magpie**：只读取本机的 `/v1/magpie/trace` 和 `/v1/magpie/usage`。
- **按服务供应商分组**：每个供应商一个灰色组头，组头带额度进度条（剩余 ≥50% 绿、20–49% 橙、<20% 红，没报额度就不画）；组内每个模型一行，显示最近一次请求的时长、首字节、token/s 和状态，最多 6 行，超出部分汇总成「+N 个模型」。请求进行中时，这一行保留上一次完成请求的数据。
- **缺失指标就留空**：拿不到时长、首字节或输出速度时显示 `—`，不编造 `0ms` / `0 tok/s`。
- **不随请求数量变高变矮**：窗口尺寸稳定，需要更大或更小时手动拖边框。
- **总 token + 逐位滚动 + 单击换窗口**：读取 magpie usage，单击在 今日 / 7 天 / 30 天 / 全部 之间循环。
- **设置直接在当前面板展开**，保存后收回，不额外弹窗。

## 作为 magpie 插件

这个仓库同时是一个 **magpie 启动器插件**。magpie 第一次加载插件时，会启动已安装的 Busy Magpie；尚未安装时，插件会自行下载正式发布包，安装后启动，无需运行开发目录里的源码或 dist 产物：

```bash
magpie plugin add github:yimi1mi/busy-magpie
```

工作方式：

- 插件入口是 `plugin/launch.hooks.mjs`，在 `package.json` 的 `magpie.hooks` 里声明。
- magpie 第一次用到插件宿主时（通常是第一个 Agent 请求），查找已安装的桌面应用并启动。
- 没安装时会自动从 GitHub 最新正式 release 下载安装包，校验 SHA-256 后安装并启动。Windows 使用 x64 安装器，静默安装到 `%LOCALAPPDATA%\Programs\Busy Magpie`；macOS 按运行架构选择 arm64 / x64 ZIP，安装到 `~/Applications/Busy Magpie.app`，无需管理员权限。
- 下载文件保存在系统临时目录中新建的 `busy-magpie-*` 子目录。macOS 解压到 `~/Applications/.busy-magpie-install-*` 暂存目录，检查可执行文件后再整体移动到安装位置；不会覆盖已有应用，结束后清理下载和解压临时文件。下载与安装在后台进行，Agent 请求直接通过。
- 设置 `BUSY_MAGPIE_NO_INSTALL=1` 可以关闭自动安装；`BUSY_MAGPIE_NO_LAUNCH=1` 同时关闭自动启动。
- 下载开始、开始安装、安装完成/失败时都会发一条系统通知（Windows 用通知气泡，macOS 用通知中心）。如果系统开了专注模式，通知可能被折叠；插件日志里仍有 `[busy-magpie]` 记录。
- `plugin/server.mjs` 是一个空 provider stub，避免 magpie 把 Electron 主进程当成供应商插件加载。
- 如果安装在非默认目录，设置 `BUSY_MAGPIE_APP` 指向可执行文件后重启 magpie（Mac 为 `.app/Contents/MacOS/Busy Magpie`）：

```powershell
setx BUSY_MAGPIE_APP "D:\Apps\Busy Magpie\Busy Magpie.exe"
```

插件只负责启动桌面层；透明窗口、实时 trace 和所有界面仍然由 Electron 应用提供。magpie 的插件页面运行在沙盒 iframe 里，既拿不到实时 trace，也不能创建跨应用的透明窗口，所以这里采用启动器，而不是页面插件。

安装内置版本为 `v1.5.0`。桌面卡片、设置和托盘显示当前业务版本；业务包更新后，它可以高于运行环境版本。插件列表的版本仍由插件自身的 `package.json` 决定。

## 截图

### 一个模型

![单个模型](./docs/screenshots/single.png)

只有一个模型有请求时，列表只有一行：模型名、状态、时长、首字节和 tok/s。

### 多个模型

![多个模型](./docs/screenshots/multi.png)

多个模型各占一行，按最近活动倒序排列，最活跃的在最上面。改道过的行在末尾带「改道 N 次」小字；超过 6 个模型时最后一行汇总为「+N 个模型」。

### 设置

![设置面板](./docs/screenshots/settings.png)

设置在卡片上展开，分为「外观与动效」「用量与更新」「连接」三页，无需滚动。设置项只保留名称和控件，保存和取消固定在底部。切页保留未保存的修改；关闭或保存后淡出回到卡片。

### 关于与更新

![关于与更新](./docs/screenshots/update.png)

点右上角版本号打开。应用更新和启动器插件更新分开处理：应用可以直接更新，插件去 magpie 插件中心更新。

## 快速开始

### 直接运行源码

需要 Node.js 20+，以及本机正在运行的 magpie（默认 `127.0.0.1:3425`）。

```bash
npm install
npm start
```

`npm install` 只会把 Electron 装进当前项目的 `node_modules`，不会全局安装，也不会改系统 PATH。启动后没有任务栏窗口，只有桌面卡片和托盘图标。

### 构建安装包

```bash
# Windows：NSIS 安装包（x64）
npm run dist:win

# 输出到独立目录，保留原来的安装包和解包目录
npm run dist:win -- -OutputDirectory dist/local-1.4.1

# macOS：dmg + zip（x64 / arm64）
# 必须在 macOS 上执行
npm run dist:mac
```

产物在 `dist/`。也可以 `npm run pack` 生成未打包目录。

macOS 构建默认**不提供 Developer ID 签名和公证**；首次打开如果被 Gatekeeper 拦住，右键 → 打开，或：

```bash
xattr -dr com.apple.quarantine "/Applications/Busy Magpie.app"
```

CI 配置包含 `windows-latest` 上的 Windows 安装包构建、`macos-latest` 上的 dmg / zip 构建，以及两个平台打包应用的业务更新、回退和重启保持测试。macOS 构建也会生成 `latest-mac.yml`。Windows 和 macOS 均支持签名业务包更新；运行环境的完整自动安装仅在 Windows 上可用，macOS 仍需手动安装。

### 通过 Action 发布

在 GitHub 的 **Actions → build → Run workflow** 中选择分支或标签，再选择 `release_mode`：

| 模式 | 结果 |
| --- | --- |
| `build` | 只构建、测试和校验产物，不修改 Release；这是默认模式 |
| `prerelease` | 两个平台全部通过后，自动上传附件并公开为预发布，不设为 Latest |
| `release` | 两个平台全部通过后，自动上传附件并设为正式 Latest |

Action 会运行 Windows、macOS 打包应用的真实业务升级与回退测试，汇总同一提交的产物，核对更新元数据、文件大小和哈希，再上传 Release。附件先进入草稿，全部上传并核对服务器摘要后才公开，不需要从 Actions 下载到本机再上传。

版本号取自 `package.json`。发布新版本前先更新版本并提交；如果 `v<版本号>` 标签已存在，必须指向本次提交。已正式发布的不同内容会被拒绝覆盖，应递增版本号。普通分支推送、标签推送和 PR 默认只构建，发布由上述手动模式明确选择。

## 安装路径

Windows 安装包是 **per-user** 安装（`nsis.perMachine: false`），默认目录是：

```text
%LOCALAPPDATA%\Programs\Busy Magpie\Busy Magpie.exe
```

这是 Windows 桌面软件的常见做法：程序放 `LOCALAPPDATA\Programs`，不需要管理员权限，也不会把可执行文件放进漫游配置。安装时仍可以改到其他目录。

用户配置和日志放在 **Roaming AppData**，因为它属于用户数据，不是程序本体：

```text
%APPDATA%\Busy Magpie\settings.json
%APPDATA%\Busy Magpie\busy-magpie.log
```

**不建议**把 `.exe` 装进 `%APPDATA%`（Roaming）：域账号或开启漫游配置时，几十 MB 的 Electron 程序会被同步到每台机器，启动和登录都会变慢。也不建议默认装进 `%ProgramFiles%`，那需要 UAC 提权，升级也更麻烦。

启动器插件的查找顺序：

1. `BUSY_MAGPIE_APP`
2. `%LOCALAPPDATA%\Programs\Busy Magpie`
3. `%LOCALAPPDATA%\Programs\busy-magpie` / `BusyMagpie`
4. `%LOCALAPPDATA%\Busy Magpie`
5. `%PROGRAMFILES%\Busy Magpie` / `%PROGRAMFILES(X86)%`
6. macOS `/Applications/Busy Magpie.app`、`~/Applications/Busy Magpie.app`

如果安装到了自定义目录，设置 `BUSY_MAGPIE_APP` 即可；默认路径下不需要配置。

macOS 自动安装使用 `~/Applications/Busy Magpie.app`；插件包仍由 magpie 管理，桌面应用单独安装。开发目录与发布包安装位置无关。

### 卸载插件时会发生什么

magpie 插件没有卸载生命周期钩子，所以**移除插件不会自动删除 Busy Magpie 桌面应用**。插件只是启动器；应用是单独安装的程序，卸载插件后它会继续留在：

```text
%LOCALAPPDATA%\Programs\Busy Magpie
```

要移除应用，使用 Windows「设置 → 应用」里的 Busy Magpie 卸载，或运行：

```text
%LOCALAPPDATA%\Programs\Busy Magpie\Uninstall Busy Magpie.exe
```

如果希望插件和桌面应用一起删，需要把应用改成插件目录内的便携版；当前版本没有这样做。

## 交互

### 操作菜单

右上角的 `···` 常驻显示，点击可打开设置、隐藏挂件或查看关于与更新。按 Esc、点击卡片空白处或切到其他窗口会收起菜单；面板始终阻挡鼠标点击。方向键可选择菜单项，Enter 执行。

首次启动直接显示卡片，不再弹出使用指南。

### 紧凑模式

菜单里的「紧凑模式」把窗口收为 `360×112` 的状态条，显示连接状态、活动请求数和当前用量。`↗` 恢复完整列表；点击 `···` 或打开设置时临时展开，关闭后回到原来的紧凑位置。完整视图的尺寸独立保留，紧凑状态不接受边框缩放。

### 移动

- **长按卡片顶部**（中间一排小圆点）约 0.15 秒即可拖动；松手停止移动。

### 调整大小

- 鼠标移到卡片**任意一条边框或四个角**，出现对应方向的缩放光标后直接拖动。
- 上边/左边拖动时会同时移动窗口，保持对面的边不动。
- 最小约 `632×432`（再小会按比例拉回），最大不超过当前屏幕可用区域。
- 尺寸会写入 `settings.json`，下次启动保持。
- 设置或托盘菜单里的「恢复默认位置和大小」可把挂件找回主屏。断开显示器或改变分辨率时，窗口会重新限制到现有屏幕的可用区域。

### 鼠标点击

整张面板都会阻挡鼠标点击，包括主视图、紧凑模式、设置和关于页面。以下区域保留对应操作：

- 顶部约 28px 的移动条
- 四条边的 7px 缩放带和四角的 14×14px 缩放区域
- 顶部中间的 token 胶囊
- 右上角的操作菜单、版本号或更新按钮

点击卡片空白处收起菜单时，该次点击不会再触发卡片上的其他操作；关闭菜单、设置或结束拖动、缩放后，面板仍会阻挡点击。

## 模型会话列表

卡片主视图只有这一张列表：按**服务供应商（Provider）**分组，每个组一个灰色组头，组头下面是该供应商最近服务过的模型，每个模型一行。

分组口径：

- 分组键是这次请求实际由哪个供应商的服务端接（trace 里 `order` 条目的 `provider`；没有时回退到请求自己的 `provider`）。组头显示供应商自己的名字（`OfficeAce`、`WorkBuddy` …）。
- 同一供应商下，同一个模型只占一行；模型名就是实际服务的模型（`served`）。
- 供应商按最近活动倒序，最活跃的组排在最上面；组内模型同样按最近活动倒序。

组头右侧是**额度进度条**：

```text
OFFICEACE                                  剩余 89%  ████████████░░░░
```

- 数据来自 trace 里账号条目的 `known` / `used` / `amount` / `limit` / `unit` / `renews`；供应商没报额度时**不画条**，只显示名字。
- 颜色按剩余量分档：≥ 50% 绿、20–49% 橙、< 20% 红；悬停组头看「已用 5755 / 9600 credits · 11/19 续期」。

每行五列，列宽固定，数字变长也不会让整行抖动：

```text
● glm-5.3                 6.5 秒    6.3s     42 tok/s   完成
● deepseek-v4.1-flash     1.2 秒    —        —          进行中
```

- 时长取该请求的 `route.ms`，首字节取 `ttft`，token/s 复用卡片一直在用的输出速度口径：整段返回或请求仍在流式时不猜速度。
- **缺失就是 `—`**：拿不到时长、首字节或输出速度时显示 `—`，不会用 `0ms` / `0 tok/s` 顶替。
- 状态三选一，按 `done` 与 `status` 判定：**错误**（红点，请求带错误或 HTTP 4xx / 5xx）、**进行中**（蓝点，请求还没结束）、**完成**（绿点）。
- **进行中的请求不会清空这一行**：只要同一个模型之前有完成的请求，时长、首字节与 token/s 继续显示上一次的值，只有状态变成「进行中」。
- 被改道过的行在末尾用小字标「改道 N 次」；`N` 是这条请求尝试过的不同模型数减 1，没改道就不显示。

### 悬停明细

行不可点击，悬停会给出这条请求的更多信息：账号（跟随「隐藏账号名称」打码）· 最近活动时间 · 改道次数 · tok/s 明细（`N token / Xs`，仅在可用时显示）。行内不显示账号；供应商已经在组头上。

设置里的「耗时拆解」（`showTiming`）控制列表三列耗时的显示；关掉时三列显示 `—`。明细优先显示输出速度 `tok/s`，没有可用速度时显示 `—`，不根据总耗时猜测输出速度。

### 汇总与空态

- 最多显示 6 **行**（组头不计入）；模型更多时最后一行是灰字的「+N 个模型」，`N` 是没显示出来的模型数，`N = 0` 时不显示。组要么整组显示、要么整组不显示，不会留下没有行的组头。
- 还没有任何 trace 数据时显示「等待 magpie 数据」。
- 读取失败或网关重启清表时，列表保留上一帧内容，并在状态位置标注「暂未刷新」，不会闪成空白。
- 列表随窗口等比缩放，整张卡片继续阻挡鼠标点击。

### 外观

卡片是一张**浅灰不透明**的圆角卡片（`#f5f5f7`），行是白色卡片，组头是灰色大写字，字号与列宽随窗口等比缩放。因为卡片已经不透明，「背景不透明度」设置项随之移除；窗口也不再需要 Windows 原生模糊或 macOS Vibrancy。

### 总 token

顶部 token 胶囊读取 magpie 的 `/v1/magpie/usage`，显示当前时间窗的 token。数字变化时逐位向上滚动（可在设置里关掉，改成直接替换）。悬停可查看输入、输出、缓存用量和缓存命中率。

**单击胶囊切换时间窗**：在设置里勾选的那几个窗口之间循环（默认 今日 → 近 7 天 → 近 30 天 → 全部），选择写进 `settings.json`，重启后保持。胶囊和右上角按钮接收鼠标点击，其余内容区域也会阻挡点击。

胶囊显示的数值可以在设置里切换：总 token（输入 + 输出 + 缓存读/写）、输入、输出、缓存读。

用量读取失败会保留上次成功的数据，并标注「暂未刷新」和时间。切换时间窗失败时，原有时间窗和数据保持不变。

## 设置

右上角 `···` →「设置」或托盘菜单 →「设置…」会把设置**铺在卡片上**：不另开窗口，也不改变窗口大小，关掉就原样回到卡片。进出的淡入淡出和卡片本身用的是同一块画布，所以缩放窗口时设置的字号也跟着变。

可以修改：

- 总在最前 / 隐藏账号名称
- 紧凑模式：切换完整列表和状态条
- 时间窗（多选：勾选的才会在单击胶囊时循环）、胶囊数值、数字滚动
- 耗时拆解（时长、首字延迟、输出 tok/s）、更新方式（空闲 / 提示 / 不检查）、保活
- 安静模式：一次停止数字滚动和其他装饰动画，仍持续刷新真实数据；也遵守系统「减少动态效果」偏好。
- 网关地址（留空自动检测）

设置保存后立即应用并写回 `settings.json`。保存失败时显示错误，并保留原有设置。

拖动四条边或四个角都可以改变窗口大小。卡片内容画在一块 600×400 的画布上，拖宽或拖高时，另一维度随之调整；文字、模型会话列表的列宽和胶囊一起等比缩放。

### settings.json

```json
{
  "topmost": true,
  "maskAccounts": true,
  "left": 1900,
  "top": 700,
  "width": 632,
  "height": 432,
  "gateway": null,
  "checkUpdates": true,
  "updateMode": "idle",
  "skippedUpdate": "",
  "usagePeriod": "30d",
  "enabledPeriods": ["today", "7d", "30d", "all"],
  "pillMetric": "total",
  "rollTokens": true,
  "showTiming": true,
  "keepAlive": true,
  "autostart": false
}
```

| 字段 | 含义 |
| --- | --- |
| `topmost` | 是否永远盖在其他窗口上方 |
| `maskAccounts` | 是否隐藏邮箱 / Key |
| `opacity` | （已移除）1.5.0 之前用来调背景不透明度；1.6.0 的卡片不透明，该设置连同它的滑条一起去掉，旧配置文件里残留的值会被忽略 |
| `left` / `top` | 窗口位置 |
| `width` / `height` | 窗口尺寸 |
| `gateway` | 固定网关；`null` 表示自动检测 |
| `checkUpdates` | 旧版开关，等价于 `updateMode !== "never"`；读旧配置时自动换算 |
| `updateMode` | 更新方式：`idle`（空闲装）/ `notice`（只提示）/ `never`（不检查） |
| `skippedUpdate` | 在「关于」里跳过的版本号 |
| `usagePeriod` | token 胶囊当前的时间窗：`today` / `7d` / `30d` / `all` |
| `enabledPeriods` | 单击胶囊时循环哪几个窗口；至少一个，选中的才参与滚动 |
| `pillMetric` | 胶囊数值：`total` / `input` / `output` / `cache` |
| `rollTokens` | 数字是否逐位滚动；`false` 直接替换 |
| `compact` | 是否使用紧凑模式；默认 `false` |
| `quietMotion` | 是否使用安静模式；默认 `false`，开启后仍刷新请求和用量数据 |
| `showTiming` | 列表里是否显示时长、首字延迟与输出速度；关掉时三列显示 `—` |
| `keepAlive` | 进程异常结束后，是否由后续网关请求重新启动；暂停期间和主动退出后不会自动拉起 |
| `autostart` | 是否登录时自动启动（托盘菜单切换） |

配置文件位置：

- Windows：`%APPDATA%\Busy Magpie\settings.json`
- macOS：`~/Library/Application Support/Busy Magpie/settings.json`

## magpie 重启了

卡片会自己接回去，不用点托盘里的「重新连接」：

- 读 trace 的长轮询失败后按 1 秒、2 秒、4 秒、5 秒退避重试，卡片右上角显示「重连中」；magpie 回来后几秒内自动恢复「实时」。
- 重启后的 magpie 是另一个进程（`pid` 变了），卡片会丢掉上一个进程留下的数据，重新取一份完整快照；断线期间列表保留上一帧并标注「暂未刷新」，不会把旧请求当成新数据。
- magpie 换了端口也能跟上：每次重试都会重新解析网关地址。
- 万一读 trace 的循环自己卡死或退出，每 15 秒一次的看门狗在 60 秒没有心跳时把它重建。

自动重连默认启用，没有开关，无需配置。

## 窗口不见了

挂件可能处于隐藏、暂停或退出状态。

**只是隐藏了**（托盘里的「隐藏桌面插件」，或者不小心点掉了）：

点击托盘图标（Windows），或在托盘菜单中选择「显示桌面插件」；双击托盘图标也切换显示。

**主动退出了**：右上角菜单或托盘里的「退出并停止自动拉起」会留下停止标记，后续请求不会再把挂件叫回来。重新打开桌面或开始菜单里的 Busy Magpie，会清除停止标记，恢复原来的保活偏好。

**暂停显示**：选择「暂停显示 1 小时」后暂时隐藏，到时自动恢复；点击托盘可提前恢复。暂停期间发生崩溃，新版启动器也会等到暂停结束再尝试恢复。

**进程崩溃或更新退出了**：可以从外面重新启动：

- 桌面或开始菜单里的「Busy Magpie」——安装包会创建这两个快捷方式；
- 在 magpie 里把 busy-magpie 插件**关掉再打开**（或改一次「选项」保存），插件重载会重新拉起桌面卡片；
- 下一次经过网关的请求会在保活开启、未暂停且未主动退出时重新拉起它；桌面卡片每 10 秒写一个心跳；
- 托盘菜单打开「开机自动启动」（需要安装版），登录进系统后它自己回来。

## 更新

从 1.4.0 起，Windows 和 macOS 应用把运行环境与业务包分开更新。界面和 JS 逻辑通过签名业务包更新，不改写 Windows 的 exe 或 macOS 的 `.app`；Electron 或原生依赖升级仍需完整安装包，Windows 可以在应用内安装，macOS 需手动安装。从 1.3.x 迁入需要先安装一次 1.4.0。

业务包先写入独立版本目录，通过签名、文件哈希和壳版本兼容性校验后，才由独立监督进程接管重启。新版完成窗口与 IPC 检查并持续报告健康状态后成为当前版本；启动失败或超时，会在确认候选业务已停止后恢复原设置并回退到上一可用版本。失败版本会被隔离，避免自动更新反复重试。

应用和启动器插件分开更新：

- **桌面应用**：点卡片右上角的版本号，打开「关于 Busy Magpie」的同时立刻查一次更新（面板里也会显示「正在检查更新…」），可以检查更新、直接更新，或跳过某个版本。应用启动 2.5 秒后查一次，之后运行期间每小时查一次。
- **一键更新**：有新版时，那个位置直接变成「更新 vX」按钮——业务包和 Windows 运行环境更新可直接完成下载、校验和重启，不用先打开「关于」；macOS 运行环境更新会打开发布页，需手动安装。下载期间按钮显示进度。这时版本号暂时让位，「关于」可以从托盘菜单打开。
- 下载时显示「已下载大小 / 文件总大小」，例如 `12.3 MB / 53.8 MB`；关于面板同时保留百分比。总大小未返回时明确显示「未知大小」。
- **启动器插件**：由 magpie 管理。到 magpie → Plugins → Busy Magpie 点 Update；不要在应用里直接覆盖插件文件。
- **更新方式**：设置里的「更新」三选一——
  - **空闲**（默认）：发现新版后先下载；连续 5 分钟没有请求、没有进行中的请求，也没有正在操作的面板时，再重启应用并切换版本。每分钟检查一次安装条件；
  - **提示**：只弹一次通知，更新留给你在「关于」里点；
  - **不检查**：关闭自动检查；打开「关于」或手动检查仍可查询新版。
- **版本不一致没关系**：当前业务版本写入用户配置目录下的 `version` 文件（Windows 为 `%APPDATA%\Busy Magpie\version`），插件版本由 magpie 插件目录决定，两者可以不同。

业务包构建、签名密钥和发布渠道见 [业务包更新](./docs/business-updates.md)。

## 网关地址

设置中的「测试连接」分别读取 trace 和 usage 接口，显示实际连接地址、地址来源和错误原因；测试不会保存输入。「复制诊断」生成不含账号和凭据的摘要。格式错误、接口路径或非本机地址会在保存前被拒绝，不再静默回退到默认端口。

按以下顺序解析：

1. `settings.json` 里的 `gateway`（设置面板里也能改）
2. `BUSY_MAGPIE_GATEWAY` 环境变量
3. `MAGPIE_ADDR` 环境变量
4. `~/.config/magpie/settings.json` 里的 `port`
5. `127.0.0.1:3425`

`MAGPIE_ADDR=0.0.0.0:3425` 这类监听地址会自动改连 `127.0.0.1:3425`。不想写环境变量时，直接固定：

```json
{
  "gateway": "http://127.0.0.1:3425"
}
```

## 它是怎么工作的

```text
magpie 本机网关 (:3425)
   │  GET /v1/magpie/trace   (long poll, 增量合并)
   │  GET /v1/magpie/usage   (总量)
   ▼
Electron 主进程
   │  IPC
   ▼
浅色不透明 BrowserWindow
   │
   ├─ 顶部：token 胶囊 / 右上角菜单与版本号
   └─ 主体：按服务供应商分组的模型会话列表（组头带额度进度条）
```

- trace 的 `after=seq` 返回的是**变化路由**，不是完整快照。主进程维护合并表，保证早开始、仍在执行的 Agent 不会从卡片消失。
- 渲染层没有 Node 权限，也不直接访问网络；所有请求都在主进程完成。
- 账号信息只在本地页面里展示；默认打码，不写日志。

## 开发

```bash
npm run dev                 # 打开开发者工具
npm start -- --layout       # 启动即进入调整位置模式
npm start -- --settings     # 启动即展开设置
npm start -- --preview      # 独立配置的本地预览，不自动更新、不修改登录启动项
```

开发实例和安装版共用 `%APPDATA%\Busy Magpie`，也就共用单实例锁：dev 那个开着的时候，安装版启动会静默退出（退出码 0、没有日志）。先关掉 dev 实例，再启动安装版。

`--preview` 默认改用 `%APPDATA%\Busy Magpie Preview`，可通过 `BUSY_MAGPIE_PREVIEW_DIR` 指定独立目录。它与正式实例互不替换，右上角标记「预览」。

本地模拟数据不需要真实请求：

```bash
# 单个模型
MOCK_COUNT=1 MOCK_START=1 python tools/mock_multi.py 3500
BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 npm start

# 多个模型并发
python tools/mock_multi.py 3500
BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 npm start
```

`mock_multi.py` 也提供 `/v1/magpie/usage`，所以 token 胶囊在模拟环境里同样可用；它给每条请求都写了 `tries`，列表按最后一次尝试的模型分组。

调试渲染层：

```bash
npx electron . --remote-debugging-port=9223
node tools/cdp.mjs eval "document.body.innerText"
node tools/cdp.mjs shot "artifacts/model-list.png"
```

截图（2x）：

```bash
CDP_SCALE=2 node tools/cdp.mjs shot "docs/screenshots/multi.png"
```

## 项目结构

```text
shell/bootstrap.cjs     稳定入口、选择业务版本与启动检查
shell/updater.cjs       业务 / 运行环境更新渠道与下载
shell/package.cjs       签名、哈希、路径与兼容性校验
shell/store.cjs         不覆盖当前文件的版本存储
shell/journal.cjs       当前 / 待确认 / 回退版本状态
shell/restart-worker.cjs 独立进程重启监督与设置恢复
shell/windows-blur.cjs  壳内 Windows 原生窗口能力
src/main.js             窗口、托盘、长轮询、usage、拖动/缩放、设置面板
src/preload.js          contextBridge 白名单
web/index.html          卡片结构（含设置 / 关于抽屉）
web/app.js              渲染、模型会话列表、数字滚动、设置交互
web/model-sessions.mjs  按服务供应商分组、取每模型最近一次请求、额度与 6 行上限
web/timing.mjs          速度与耗时口径（tok/s、首字、总耗时）
web/redact.mjs          诊断脱敏
web/presenter.js        只根据 trace 生成文案
web/brand-icons.mjs     加载随应用打包的品牌图标
web/styles.css          浅灰卡片、Provider 分组、额度进度条、动效
plugin/launch.hooks.mjs magpie 启动器插件（magpie.hooks 入口）
assets/                 magpie 标志、Agent / 服务商品牌图标、托盘/应用图标
tools/                  图标生成、模拟 trace、CDP 检查、Windows 打包
tests/                  逻辑回归与 Electron 界面检查
```

## 隐私

- 默认隐藏邮箱和 Key，只保留服务商名和模型名。
- 日志记录连接失败、usage 失败、崩溃和更新阶段，不记录请求内容、账号或 Key。
- trace 和 usage 都只从本机 magpie 读取，不发送到外部。
- 项目不包含遥测。

## 已知限制

- 只展示本机 magpie 网关；远程 magpie 的 trace 由 magpie 自身限制为本机读取。
- 窗口尺寸不自动增长；主视图最多显示 6 行，超过 6 个模型时最后一行汇总为「+N 个模型」，需要更大或更小时手动拖边框。
- 分组依赖 trace 里的账号条目 `provider`：拿不到供应商的请求归入「magpie」兜底组；额度条依赖账号条目的 `known` / `used`，供应商没报额度时只显示组名。
- 长轮询失败期间列表保留上一帧并标注「暂未刷新」；网关重启会清掉旧数据并重取快照。
- 系统开启「减少动态效果」或安静模式时，装饰动画不画，数据仍会持续刷新。
- macOS 版本需要在 macOS 上构建；默认不提供 Developer ID 签名和公证。
- 不修改 magpie，因此不会在 magpie 的「路由」页里增加额外入口；入口是托盘图标。

## License

[MIT](./LICENSE)




