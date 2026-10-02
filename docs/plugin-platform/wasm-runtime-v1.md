# DIAN115 WASM runtime v1

插件包可以声明 `runtime.kind: "wasm"` 与 `runtime.protocol: "dian115:wasm@1"`。宿主在 DIAN115 容器内使用 wazero 托管模块，**只使用编译引擎**，没有解释器后备：同一段插件逻辑在任何部署上开销一致，不会因为宿主环境不同而慢一个数量级。宿主平台若无法运行编译引擎，加载插件会直接失败并给出明确原因，而不是悄悄降级。**每个插件使用自己的编译缓存**，插件被释放时缓存一起关闭——这是"空闲插件不占内存"能成立的前提；编译结果同时落盘，被释放的插件再次加载时读缓存而不是重新编译。模块没有宿主文件描述符、Socket、命令执行、环境密钥或预打开的宿主目录；需要文件、网络、通知、Telegram、状态和调度能力时，必须调用 Host API Broker。

## 模块 ABI

WASM 必须是 reactor（不能导出 `_start`），导出自己的线性内存 `memory`，以及以下函数：

```text
dian115_alloc(size: i32) -> i32
dian115_handle(ptr: i32, length: i32) -> i64
```

`dian115_alloc` 返回可写入请求的内存地址。`dian115_handle` 接收 JSON 请求，返回值高 32 位是响应地址、低 32 位是响应长度。请求和响应均受 16 MiB 宿主帧上限约束，地址必须位于 guest memory 内。模块应复用或回收自己的缓冲区，宿主不会把 guest 指针解释为宿主地址。

模块可选导入 `dian115.host_call(i32, i32) -> i32` 和 `dian115.host_read(i32, i32) -> i32`。前者提交 JSON-RPC Host API 请求并返回响应长度，后者把响应复制到 guest 提供的缓冲区；导入只能用于 `host.*` 方法。宿主会验证方法、安装权限、请求体、凭据引用、幂等键和输出大小。

帧上限不等于业务响应限额：页面 state/action 等运行时业务 JSON 仍限制为 256 KiB，Host Call 正文上限为 8 MiB。返回图片 data URL 时要计入 Base64 和 JSON 开销，不应把整张原图直接放进 action 结果。

Guest 可根据当前操作设置更小的本地响应预算；在 `host_call` 返回长度后先检查，超限时不分配大缓冲区、不调用 `host_read`，直接返回可恢复的业务失败。该本地预算无需添加 Host Call JSON 字段。宿主仍可能已完成有界下载；这项检查主要避免大响应再次复制、JSON 解码及 Base64 解码造成 guest 内存峰值。循环处理图片时，应及时释放旧输出和解码缓冲区；GC 软目标应低于清单的线性内存硬限额，并以连续调用和失败后续操作验证内存恢复。

## 调用封套

宿主调用模块时发送：

```json
{"method":"runtime.invoke","params":{"envelope":{"op":"action","invocation_id":"inv_x","payload":{}},"background":false}}
```

模块返回 JSON-RPC 封套：

```json
{"result":{"status":"succeeded"}}
```

或 `{"error":{"code":-32602,"message":"..."}}`。`op` 包括 `state`、`action`、`job` 和 `event`；事件的 topic 必须先在 manifest 声明并拥有 `events.subscribe` 能力。状态响应需要稳定的 `state_version` 和强 ETag，重复的 `invocation_id` 使用宿主持久化投递账本重放。

Action 的业务结果 `status` 仅允许 `succeeded`、`failed`、`accepted` 或 `skipped`；`ok` 不合法，会触发 `runtime_protocol_error`。定时 job 只接受 `accepted` 或 `skipped`，不能直接复用返回 `succeeded` 的 action 结果。JSON-RPC 封套成功不代表其中的业务结果已符合宿主协议。

大量排期或列表应在插件自己的 action 输入、输出中定义分页契约；宿主不会自动分页或截断业务 JSON。每页应留足封套余量，后续页携带同一数据版本，前端仅在完整版本读取成功后替换现有数据。不要在结果中重复附带已包含于 state 的同一批记录。

## 配额和生命周期

`memory_mb`（4–512 MiB）、`timeout_ms`（100–120000 毫秒）、`background_timeout_ms`（1000–3600000 毫秒）、`max_concurrency`（1–16）由 manifest 声明。`startup_timeout_ms` 和 `shutdown_timeout_ms` 均为 1000–60000 毫秒。前台 action 超时上限为 120 秒，后台 job 可单独设置更长预算；不要将后台预算写入 `timeout_ms`。越界清单会在安装时被拒绝，构包前应运行 `conformance/project-check.mjs`。

## 构建要求

宿主只接受用低占用工具链构建的模块：**Go 标准编译器被拒绝**，TinyGo / Rust / Zig / C 均可。原因是运行占用而不是审美——用同一份示例源码实测：

| 构建方式 | 模块体积 | 启动后提交的线性内存 |
| --- | --- | --- |
| Go 标准编译器（wasip1，`-s -w`） | 3.3 MiB | 8 MiB |
| TinyGo（`-target=wasi -buildmode=c-shared -opt=z`） | 0.6 MiB | 512 KiB |

被拒绝的模块会在安装和打包阶段给出点名原因，不会只说"超限"。除此之外还有 2 MiB 的兜底上限，防止非 Go 但同样过大的模块混进来。TinyGo 需要 `wasm-opt`（Binaryen）在 `PATH` 上，或通过 `WASMOPT` 指定。

**插件协议同时禁止链接 `encoding/json`。** 宿主会一直保留已加载插件的编译产物，所以一个重标准库的代价会乘到整个插件清单上：同一份示例源码用 `encoding/json` 时模块 1.4 MiB、每个加载中插件约 8 MiB，改用示例 SDK 里的 [pluginjson](examples/sdk/pluginjson/pluginjson.go) 做字段级读写后是 0.6 MiB / 3.5 MiB。宿主和 `project-check.mjs` 都会扫描模块并**按名字点名拒绝**，作者拿到的是"你链接了 encoding/json，请改用 pluginjson"，而不是一个体积超限。这项检查是开发者体验规则，不是安全边界；2 MiB 的兜底上限依然生效。TinyGo 需要 `wasm-opt`（Binaryen）在 `PATH` 上，或通过 `WASMOPT` 指定。

超时会取消 guest context。单次调用失败（包括 guest trap、非法 host 请求和无效响应封套）只向该次调用返回错误，不会终止模块；只有连续 8 次调用失败才判定模块状态损坏并交给监督器按 `restart_policy: on-failure` 重启。模块默认加载在宿主进程内，不再为每个插件启动独立进程；宿主按需加载模块，并在长时间无人调用（默认 15 分钟）后释放它，下一次调用会自动重新加载，因此插件不应把“进程一直存在”当作前提。

**不要依赖"进程一直在"来维持状态。** 定时 job、声明的事件订阅、文件监控和 Telegram 路由都由宿主持久化并驱动：到点、事件到达或消息匹配时，宿主才加载插件、调用、然后释放。所以这些插件都不需要常驻，宿主的插件内存占用跟着"同时活跃多少个"走，而不是"装了多少个"。**唯一**必须常驻的是声明了 `resident: true` 的插件——它自己在模块里跑后台循环，宿主无法在它没加载时替它做任何事。

宿主对加载和回收有四个可调项，默认值适用于大多数部署：同时加载的插件数量上限 `DIAN115_PLUGIN_WASM_MAX_LOADED`（默认 16，超出按最久未使用释放，设为 `0` 表示不限制）；模块编译的并发上限 `DIAN115_PLUGIN_WASM_MAX_LOADS`（默认 4）；插件被调用过之后多久释放 `DIAN115_PLUGIN_WASM_IDLE_TIMEOUT`（默认 15 分钟，设为 `0` 表示永不释放）；开机预热过但一次都没被调用的插件多久释放 `DIAN115_PLUGIN_WASM_UNUSED_TIMEOUT`（默认 2 分钟）。编译结果按内容缓存在数据库同目录的 `plugin-compiled/` 下（wazero 自己再按版本和架构分子目录），所以被释放的插件再次被用到时是读缓存而不是重新编译：实测示例模块的重新加载从约 117 毫秒降到约 40 毫秒。该目录只影响加载速度，服务停止时可以安全删除。

空闲实例还会收到 `runtime.ping` 活性探测，由宿主直接应答，插件无需实现。永久性的启动失败（入口缺失、ABI 不支持、拒绝初始化）不消耗重启预算；彻底失败的实例冷却 30 分钟后会自动获得一次新的重试机会。关闭时先发送 `runtime.shutdown`，超时后卸载模块。模块只读挂载插件 package，持久化数据通过 Host Storage 保存。

## Telegram 入站消息

插件在 manifest 的 `telegram` 段声明最多 3 个命令和 3 个关键词；宿主在安装和启用时登记这些路由，**不需要加载插件**。运行时注册（`host.telegram.register`）已不再支持。宿主先处理内置命令和已识别的链接，剩余文本按声明的路由匹配一个插件，然后按需加载该插件并发送 `telegram.message` 事件。事件只包含 `update_id`、`date`、`message_id`、`message_thread_id`、`chat_id`、`chat_type`、`user_id` 和文本，以及脱敏的匹配信息；Bot Token、原始 Update、用户名和附件不会进入插件。插件可返回纯文本或 HTML 回复、HTTPS 图片和受限按钮。按钮支持 `url` 或 `callback_data`（二选一）；携带 `callback_data` 的按钮被点击后，宿主向该安装实例投递 `telegram.callback` 事件，插件以 `answer`/`alert`/`reply` 应答，详见 host-call-v2.md 第 12 节。

当前公开的入站交互渠道是 Telegram。`/api/notifications/plugin` 是插件发起的出站通知接口，不会把系统通知伪装成用户入站消息；新增渠道必须先定义独立的脱敏事件投影、身份范围、幂等键和回复校验。

出站通知不受这条限制：宿主会把插件通知投递到**所有已配置的通道**（Telegram、企业微信、微信 ClawBot），但各通道能承载的能力不同。响应里的 `channels` 字段会报告每条通道保留和丢弃了什么——特别是 `callback_buttons`：只有 Telegram 能把按钮点击送回插件，另两条通道会丢弃它。**插件必须检查这个字段再决定交互方式**，不要假设按钮在所有通道都可用，详见 host-call-v2.md 第 2.4 节。

## 网络地址

manifest 中的 `permissions.network` 是安装时的用途和代理偏好说明，不是永久 allowlist。安装后插件页面可以通过 Host Storage 保存用户输入的 HTTP/HTTPS 地址并调用网络 Broker；未声明地址默认跟随宿主系统代理。Broker 仍执行 URL、重定向、凭据过滤、响应上限和审计，插件不能直接打开 Socket。用户应自行承担其添加的目标服务、凭据和数据风险。

## 常驻模块（resident）

manifest 声明 `"runtime": {"kind": "wasm", "resident": true}` 后，宿主会在服务模块之外用同一编译产物实例化第二个模块，并向它发起一次不限时的后台调用：

```json
{"op": "resident", "invocation_id": "resident", "payload": {}}
```

插件在这个调用里运行自己的主循环（定时器、轮询、长驻任务），通过 `host_call`/`host_read` 正常使用全部宿主能力，行为等同本机常驻模块，而不是"用户点击才运行"的沙箱。常驻调用返回错误视为崩溃，整个运行时被卸载并由监督器按 `restart_policy` 重启；正常返回只结束常驻循环，服务模块继续应答普通调用。常驻插件不会被空闲释放。

宿主调用状态按模块实例隔离，常驻模块与服务模块可以并发发起 `host_call`，互不干扰。
