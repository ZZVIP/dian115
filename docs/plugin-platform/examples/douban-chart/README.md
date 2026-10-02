# 豆瓣最新榜单订阅（示例插件）

一个"取外部数据 → 缓存 → 定时复查 → 有变化才通知"的订阅型插件，用来演示这类插件在
DIAN115 上应该怎么落地。它和 `complete-plugin` 的区别在于：那个示例展示所有能力，
这个示例只做一件事，并把平台强制的取舍写在明面上。

## 它做什么

- 榜单来源：豆瓣移动端的公开合集接口
  `https://m.douban.com/rexxar/api/v2/subject_collection/<collection>/items`。
  可选榜单：正在上映、一周口碑榜、新片榜、华语口碑剧集榜、全球口碑剧集榜。
- 用户在插件页面选榜、点"立即刷新"看当前榜单，点"订阅"开始跟踪。
- 订阅后由**宿主**按 manifest 声明的时间表调用插件的 `poll` 任务：拉取榜单、和上次
  快照比对，只把**新增**条目通过宿主通知推给用户；没有变化时不打扰。
- 订阅状态、已推送过的条目都存在 Host Storage，插件被释放也不会丢。

## 平台强制的几个取舍

这些都是写这个插件时真正踩到的约束，不是风格建议：

| 约束 | 这个插件怎么应对 |
|---|---|
| 插件没有 Socket，出网必须经 Host Broker | 所有请求走 `host.call` 到绝对 URL，并声明 `permissions.network` 的 origin |
| 插件空闲会被宿主释放 | 定时复查用 manifest 的 `jobs`，插件**不自己跑循环**；释放后由宿主在到点时再唤醒 |
| 不能链接 `encoding/json`（体积规则） | 用示例 SDK 的 `pluginjson` 做字段级读写，模块 560 KB |
| 必须声明用到的 Host API 与网络目的 | `permissions` 里逐条写明用途，安装时由管理员确认 |
| 必须用 TinyGo 等低占用工具链 | 见下方构建章节 |

## 目录

```
manifest.template.json     插件清单（含 jobs 与 permissions 声明）
market-entry.template.json 市场条目模板
runtime/main.go            插件运行时：抓取、比对、持久化、通知
（运行时通过示例 SDK `../sdk` 共享体积友好的 JSON 读写）
src/AppPage.vue            Federation 页面：选榜单、看条目、订阅
src/main.ts                本地预览入口（不是发布内容）
scripts/build-runtime.mjs  用 TinyGo 编译运行时
scripts/package.mjs        生成完整性清单、签名并打包 .d115p
go.mod
```

## 构建与校验

前置条件：Node.js 20+、npm，以及 TinyGo 0.4x（`wasm-opt` 需在 `PATH` 上或由
`WASMOPT` 指定）。**构建机不需要 Go 工具链**，宿主也不接受 Go 标准编译器产出的模块。

一条命令跑完构建、契约校验和签名打包：

```bash
npm install
npm run release
```

首次需要生成一个本地开发密钥（不入版本库）：

```bash
npm run package -- --generate-key
```

插件逻辑端到端验证在宿主侧：`internal/api/plugin_example_douban_test.go` 用假的
Broker 响应把插件装进宿主，验证"首次建立基线 → 订阅 → 出现新条目只推新增的一条 →
重复复查不重复通知 → 出网确实走 Broker 且带上豆瓣要求的 Referer"。

## 实测结果

| 项目 | 数值 |
|---|---|
| 编译模块 | 573,166 字节（560 KB），上限 2 MiB |
| 签名包 `.d115p` | 202,149 字节（197 KB） |
| 构建产物 | `build/runtime/plugin.wasm`、`build/frontend/dist/assets/`、`releases/*.d115p` |

签名私钥、`build/`、`releases/`、`node_modules/` 都在 `.gitignore` 里：这些是本地产物，
不应进入版本库。

## 需要注意的第三方依赖

豆瓣没有面向第三方的正式榜单 API，这里用的是移动端页面自身在用的公开接口。它可能随
豆瓣改版失效，也可能对频率敏感——所以默认复查周期是**每小时一次**，并且只在榜单真的
出现新条目时才发通知。以发布者身份使用这类接口时，请自行确认对方的条款与频率限制。
