# pi-kiro-api-fork

> **Kiro API Key provider for Pi — fork of [`satiyap/pi-kiro-api`](https://github.com/satiyap/pi-kiro-api)**
>
> 本项目为 `pi-kiro-api` 的个人 fork，目标是在 **Pi Coding Agent** 中通过 `KIRO_API_KEY` 使用 Kiro 模型，并持续同步 Kiro Runtime / tool-use 兼容性修复。
>
> 当前 fork 重点解决：
>
> * 使用 `KIRO_API_KEY` 进行非交互式 / headless 认证
> * 启动时按 API Key 动态发现可用模型
> * 在 Pi 中注册 Kiro provider
> * 兼容 Kiro Runtime 的 tool-use / tool-result 历史格式
> * 规范化跨 provider 的 Tool Call ID
> * 修复并发工具执行导致的历史交错问题
> * 尽量保持原项目的 API-key 认证方式不变

---

## 项目定位

本项目不是 Kiro 官方客户端，也不是 Kiro API 的重新实现。

它是一个 **Pi provider adapter**：

```text
Pi
 │
 │ Extension Provider
 ▼
pi-kiro-api-fork
 │
 ├─ KIRO_API_KEY
 ├─ Model Discovery
 ├─ Message / Tool Transformation
 ├─ Kiro History Validation / Repair
 └─ Kiro Runtime Request
 │
 ▼
Kiro service
```

Pi 仍负责：

* 会话管理
* Agent / Subagent
* 工具执行
* Thinking / Compaction
* `/model`
* `/resume`
* Skills
* UI / TUI

本项目只负责把 Pi 的消息和工具结构转换成 Kiro 能接受的请求格式，并将 Kiro 的响应转换回 Pi 的消息流。

---

# 与原项目的关系

上游项目：

* [satiyap/pi-kiro-api](https://github.com/satiyap/pi-kiro-api)

本项目：

* 基于上游项目的 API-key provider 设计
* 保留 `KIRO_API_KEY` 认证方式
* 对 Kiro Runtime 的历史消息、Tool Use / Tool Result 和当前请求做兼容性修复
* 根据 Kiro Runtime 行为持续调整 provider 层适配

本 fork 不保证与 Kiro 服务端长期兼容。

Kiro 服务端属于持续演进的远程服务，接口、模型目录、认证规则、模型 entitlement、tool-use validation 和 runtime 行为都可能发生变化。

---

# 主要功能

## 1. KIRO_API_KEY 认证

使用：

```bash
export KIRO_API_KEY="ksk_xxxxxxxxx"
```

启动 Pi 后，provider 使用 API Key 向 Kiro 请求模型目录及推理服务。

API Key 属于敏感凭证：

* 不要提交到 Git
* 不要写入项目配置文件
* 不要打印完整 key
* 不要发送给普通子代理
* 建议通过 shell 环境变量、secret manager 或受控运行环境提供

---

## 2. 动态模型发现

provider 不依赖长期固定的模型列表。

启动时会查询 Kiro 当前可用模型，并根据 API Key / account entitlement 返回可用模型。

整体流程：

```text
KIRO_API_KEY
    │
    ▼
Kiro Model Discovery
    │
    ▼
当前账号可用模型
    │
    ▼
Pi Model Registry
    │
    ▼
/model
```

这样可以避免长期维护一个容易过期的静态模型清单。

需要注意：

> 模型发现依赖 Kiro 当前服务端接口。若 discovery 请求失败，本 provider 默认采用 fail-closed 行为，而不是自动伪造一个静态模型列表。

因此：

```text
Discovery Failed
      ↓
Provider 不注册 / 模型不可用
```

这是为了避免 Pi 展示用户实际上无法使用的模型。

---

# 3. Kiro Runtime 请求

模型发现和实际推理属于两个不同阶段：

```text
Model Discovery
      ↓
Pi model registry
      ↓
GenerateAssistantResponse
```

provider 会根据当前模型和运行区域构造 Kiro Runtime 请求。

运行区域可以通过：

```bash
export KIRO_API_REGION="us-east-1"
```

进行配置。

未设置时使用：

```text
us-east-1
```

---

# 4. Tool Use 兼容

Kiro 对 Tool Use / Tool Result 的结构和 ID 存在较严格的验证。

Pi 中不同 provider 产生的 tool ID 不一定符合 Kiro 的限制，例如：

```text
call_xxx|fc_xxx
```

或过长的 ID。

因此 provider 会对 Tool Use ID 做规范化。

基本策略：

```text
合法且长度符合要求
        ↓
原样保留

不合法 / 超长
        ↓
SHA-256
        ↓
pi_<digest>
```

这样可以避免部分：

```text
REQUEST_BODY_INVALID
Invalid tool use format
```

问题。

同时 Tool Use 和 Tool Result 必须使用相同的转换规则。

---

# 5. Tool Result 重新排序

Pi 内部多个工具可能并行执行。

理论上的逻辑关系：

```text
assistant
 ├─ tool A
 └─ tool B

tool result A
tool result B
```

在并行执行时，实际写入会话历史的顺序可能发生交错。

例如：

```text
assistant(tool A)
user(...)
assistant(tool B)
toolResult(A)
```

而 Kiro Runtime 对 Tool Use / Tool Result 的配对关系更严格。

因此 provider 在发送请求前会进行：

```text
Pi messages
     ↓
normalize
     ↓
relocate displaced tool results
     ↓
Kiro history
```

目标是保持：

```text
assistant(toolUse)
        ↓
对应 toolResult
```

的可验证对应关系。

---

# 6. Kiro History Validation / Repair

provider 对发送给 Kiro 的历史执行结构检查。

主要关注：

```text
user / assistant 交替关系
tool use / tool result 配对
tool result 是否存在孤立 ID
空 user message
历史消息顺序
当前 message 与 history 的边界
```

必要时进行最小结构修复。

原则是：

> 修复结构，不伪造业务结果。

例如：

```text
toolResult(A)
```

不会被当成：

```text
toolResult(B)
```

也不会使用默认值掩盖真实工具失败。

---

# 7. Thinking / Reasoning 兼容

Pi 的内部消息可能包含：

```text
thinking
text
toolCall
```

Kiro history 并不等价于 Pi transcript。

因此 provider 不会简单地把内部：

```text
<thinking>...</thinking>
```

直接塞进 Kiro assistant 文本历史。

目标是：

```text
Pi internal representation
        ↓
Kiro-compatible representation
```

避免因为 reasoning 文本被错误注入 history 而触发 Runtime validation 或产生上下文污染。

---

# 安装

## 从 Git 安装

推荐：

```bash
pi install git:github.com/<YOUR_GITHUB_USER>/pi-kiro-api
```

例如：

```bash
pi install git:github.com/C-git-qok/pi-kiro-api
```

安装后查看：

```bash
pi list
```

确认 provider 已安装。

---

## 本地开发安装

```bash
git clone https://github.com/<YOUR_GITHUB_USER>/pi-kiro-api.git
cd pi-kiro-api

bun install

pi install file:.
```

也可以直接开发加载：

```bash
pi -e ./extension.ts
```

---

# 配置 Kiro API Key

Linux / macOS：

```bash
export KIRO_API_KEY="ksk_xxxxxxxxx"
```

例如写入：

```bash
~/.bashrc
```

或：

```bash
~/.zshrc
```

然后重新打开终端。

---

## Windows / PowerShell

```powershell
$env:KIRO_API_KEY="ksk_xxxxxxxxx"
```

持久环境变量建议通过系统环境变量管理，不要把 key 写入项目文件。

---

# 配置区域

默认：

```text
us-east-1
```

也可以：

```bash
export KIRO_API_REGION="eu-central-1"
```

注意：

> API Key 的管理面区域与 Runtime 区域不一定是同一个概念。不要因为当前环境位于某个区域，就自动推断所有 Kiro endpoint 都应使用同一个区域。

---

# 验证安装

首先确认环境变量：

```bash
printf '%s\n' "${KIRO_API_KEY:0:4}..."
```

不要输出完整 key。

然后：

```bash
pi --list-models
```

寻找类似：

```text
Kiro (API Key)
```

或者 provider：

```text
kiro-api-key
```

---

# Debug

provider 支持：

```bash
export KIRO_LOG=debug
```

也可以把日志保存到文件：

```bash
export KIRO_LOG=debug
export KIRO_LOG_FILE=/tmp/kiro.log
```

然后运行：

```bash
pi --list-models
```

检查：

```bash
cat /tmp/kiro.log
```

---

# Debug 日志应该关注什么

## 模型发现

正常流程应该能看到类似：

```text
discover.request
...
discover.ok
```

如果出现：

```text
Kiro model discovery failed
```

优先检查：

```text
KIRO_API_KEY
KIRO_API_REGION
Kiro model entitlement
当前 provider 版本
Kiro server-side API 变化
```

---

## Runtime 请求

可以关注：

```text
request.init
request.send
response.error
```

尤其需要确认：

```text
endpoint
model
kiroModelId
historyLen
currentContentLen
toolResultCount
hasProfileArn
```

敏感信息绝对不要写入日志：

```text
KIRO_API_KEY
完整 credential
完整 authorization header
secret
private env value
```

---

# 常见问题

## Pi 中没有 Kiro 模型

首先执行：

```bash
pi --list-models
```

然后：

```bash
export KIRO_LOG=debug
export KIRO_LOG_FILE=/tmp/kiro.log
```

再次启动 Pi。

重点看：

```text
discover.request
discover.error
discover.ok
```

因为本 provider 的模型发现是 fail-closed：

```text
Discovery Failed
     ↓
Provider 不注册
```

所以“Pi 中完全没有 Kiro 模型”通常首先应从 discovery 排查，而不是 Tool Use。

---

## 出现 `Invalid tool use format`

典型错误：

```text
400 Bad Request

Invalid tool use format.
REQUEST_BODY_INVALID
```

优先检查：

```text
Tool Use ID
Tool Result ID
Tool Use / Tool Result 顺序
当前 message 与 history 边界
Kiro Runtime request shape
```

本 fork 已经包含：

```text
Tool ID normalization
+
Tool Result relocation
+
History validation / repair
```

但 Kiro 服务端的 validation 仍可能变化。

---

## 出现 403

例如：

```text
403 Forbidden
```

检查：

```bash
echo "${KIRO_API_KEY:0:4}"
echo "$KIRO_API_REGION"
```

不要把完整 key 输出到终端。

同时确认：

* API Key 是否仍有效
* 账号是否有对应模型 entitlement
* 当前区域是否支持该 key
* provider 是否使用了正确的 Kiro endpoint

---

## 出现 429

429 通常是服务端限流、配额或模型容量问题。

不要简单通过无限重试解决。

对于容量型错误，可以采用有限次数、指数退避：

```text
attempt 1
   ↓
backoff
   ↓
attempt 2
   ↓
backoff
   ↓
attempt 3
```

对于明确的认证、参数或 schema 错误，不应无限重试。

---

# Provider 架构

项目大致结构：

```text
pi-kiro-api/
├── extension.ts
├── package.json
└── src/
    └── kiro/
        ├── debug.ts
        ├── discover.ts
        ├── event-parser.ts
        ├── history-validator.ts
        ├── models.ts
        ├── stream.ts
        ├── thinking-parser.ts
        ├── tokenizer.ts
        └── transform.ts
```

---

## `extension.ts`

负责：

```text
读取 KIRO_API_KEY
        ↓
启动 model discovery
        ↓
registerProvider()
```

---

## `discover.ts`

负责：

```text
Kiro model discovery
        ↓
Pi model metadata
        ↓
provider registry
```

这是启动阶段排查模型消失问题的第一入口。

---

## `models.ts`

负责：

```text
Kiro model metadata
```

包括：

```text
model id
context window
reasoning
input modality
max output tokens
runtime metadata
```

---

## `transform.ts`

负责：

```text
Pi Message[]
       ↓
Kiro history format
```

包括：

```text
Tool ID normalization
Tool Result conversion
Tool Result relocation
Image conversion
Tool specification conversion
History construction
```

---

## `history-validator.ts`

负责：

```text
Kiro history validation
+
minimal structural repair
```

不负责：

```text
业务数据生成
工具执行
默认结果填充
```

---

## `stream.ts`

负责：

```text
Pi streamSimple
       ↓
Kiro Runtime request
       ↓
Kiro event stream
       ↓
Pi AssistantMessageEventStream
```

---

## `event-parser.ts`

负责解析 Kiro 返回的事件流。

---

## `thinking-parser.ts`

负责把 Kiro 返回中的 reasoning / thinking 信息映射到 Pi 的消息结构。

---

## `tokenizer.ts`

用于上下文 / token 相关处理。

---

# 设计原则

## Reality First

provider 不应因为：

```text
静态模型列表
旧文档
fixture
mock
Agent 自述
```

就认为模型或 Runtime 当前可用。

当前服务端返回和当前请求结果优先。

---

## 不把未知变成成功

禁止：

```text
error → []
error → 0
error → default
error → fake success
```

尤其是：

```text
Tool Result
Model entitlement
Runtime status
```

必须保持真实状态。

---

## Tool Use 不等于 Tool Result

必须严格区分：

```text
Tool Use
Tool Result
```

并保持：

```text
toolUseId
      ↕
toolResult.toolUseId
```

的对应关系。

---

## History repair 不等于业务修复

History repair 只能处理：

```text
结构
顺序
ID
空消息
配对关系
```

不能：

```text
猜测工具结果
修改真实业务结果
隐藏真实异常
```

---

# 与 Pi 的兼容边界

本项目依赖 Pi provider API。

建议使用与项目实际测试相匹配的 Pi 版本。

当 Pi 发生以下变化时，可能需要同步调整：

```text
Provider API
Model schema
AssistantMessage
ToolCall
ToolResult
Stream event
Context structure
Thinking structure
Session behavior
```

---

# 与 Kiro 的兼容边界

Kiro 属于远程服务。

以下内容不能视为永久稳定合同：

```text
模型 ID
模型 entitlement
模型 context window
Runtime endpoint
Request schema
Tool validation
Header
错误码
限制
区域
计费 / 配额
```

因此本项目应持续通过：

```text
当前服务行为
当前官方文档
当前 provider 实测
```

进行重新验证。

---

# 安全注意事项

本项目需要处理：

```text
KIRO_API_KEY
```

因此：

* 不要提交 `.env`
* 不要把 key 写到 README
* 不要把 key 写入 AGENTS.md
* 不要让子代理读取完整 key
* 不要将完整 Authorization header 写入 debug log
* 不要将 key 放进 issue / PR / commit
* 不要将生产 credential 复制到测试环境

推荐：

```bash
export KIRO_API_KEY=...
```

由执行环境注入。

---

# 开发

安装依赖：

```bash
bun install
```

类型检查：

```bash
bunx tsc --noEmit
```

开发加载：

```bash
pi -e ./extension.ts
```

查看当前 Git 状态：

```bash
git status
```

查看 diff：

```bash
git diff --check
git diff
```

---

# 最小端到端测试

建议按照以下顺序测试。

## 1. Model Discovery

```bash
pi --list-models
```

目标：

```text
Kiro provider
+
至少一个当前账号可用模型
```

---

## 2. Plain Text

选择 Kiro 模型后：

```text
Reply exactly: TEST_OK
```

目标：

```text
HTTP 200
正常返回文本
```

---

## 3. Tool Calling

测试：

```text
调用一个无参数工具
```

目标：

```text
assistant(toolUse)
        ↓
toolResult
        ↓
assistant
```

---

## 4. Multiple Tools

同时注册多个工具：

```text
tool A
tool B
tool C
```

确认：

```text
Tool ID 唯一
Tool Result 正确匹配
history 合法
```

---

## 5. Parallel Tools

测试多个工具并行执行。

重点观察：

```text
Tool Result 是否交错
provider 是否重新排序
Kiro 是否接受 history
```

---

# 当前状态

这是一个个人维护 fork，而不是 Kiro 官方项目。

推荐把兼容性状态理解为：

```text
Pi
 │
 ├── Provider API
 │
 ├── Message / Tool transformation
 │
 ├── Kiro Runtime compatibility
 │
 └── Kiro server-side changes
```

任何一层变化都可能需要更新 provider。

因此：

> **能在当前环境正常运行，不代表未来 Kiro server 或 Pi 更新后仍保持兼容。**

---

# Credits

Original project:

* [satiyap/pi-kiro-api](https://github.com/satiyap/pi-kiro-api)

Pi:

* [Pi Coding Agent](https://pi.dev)

Kiro:

* [Kiro](https://kiro.dev)

部分 Runtime / tool-use 兼容思路参考了其他 Kiro-compatible provider 的公开实现，并根据当前 Pi 与 Kiro 的实际行为进行适配。

---

# License

本项目延续原项目的 MIT License。

请同时遵守：

* 原项目许可证
* Kiro 服务条款
* 所使用模型和相关服务的适用条款

本 fork 不代表 Kiro、AWS 或 Pi 官方。

---

# Disclaimer

本项目：

* 不是 Kiro 官方插件
* 不是 AWS 官方 SDK
* 不提供 Kiro API 的稳定性保证
* 不保证所有模型和账号 entitlement 都可用
* 不保证未来 Kiro Runtime 变化后无需修改
* 不保证任何未实际验证的模型、区域或能力

请以当前 Kiro 服务端行为和官方资料为准。
