# dsh-inject-context

一个**最小可用**的 DeepSeek Harness 上下文注入样本插件。

它只做一件事：在每一步模型请求之前，把**会话当前目录的 `dir` 输出**作为**一条独立的 `user` 消息**追加到本步消息列表末尾。

```
用户: 帮我看看这个项目
       ↓
[agent/pre-step]  dsh-inject-context 读 cwd → 渲染 dir 列表 → 追加一条 user 消息
       ↓
模型实际收到:  [用户消息] [runtime-context] [<directory-listing>…</directory-listing>]
                                              ↑ 本插件注入
```

---

## 契约（刻意收窄）

这个插件存在的主要目的，是示范**"如何在不惊动其它机制的前提下注入上下文"**。所以它的边界是刻意钉死的：

| # | 约束 |
|---|---|
| 1 | **只有一个挂载点** —— `agent/pre-step`（waterfall），不碰其它任何事件 |
| 2 | **只追加一条 `role: 'user'` 消息** —— 不替换、不改写、不删除任何既有消息 |
| 3 | **不注册任何 `systemPrompt` 贡献** —— 请求前缀（system prompt + 工具 schema）与不装本插件时**逐字节相同** |
| 4 | **不声明任何服务依赖**（`inject = []`）—— 不用 `systemPrompt` / `tools` / `session` / `fs` 服务 |
| 5 | **异常一律降级为"不注入"** —— 超时、`EACCES`、取消、畸形 payload 都不会打断这一轮对话 |

第 3 条是这个设计的最大好处：系统提示词注入会**每一步都在改请求前缀**，持续破坏提示词缓存；而消息尾部追加只影响请求末尾，前缀缓存完全不受影响。

---

## 为什么必须是 `agent/pre-step`

`@deepseek-ai/dsh-agent-loop` 的 `preStep()` 时序是：

```
906  claimed = inbox.claim(...)                     ← 本轮用户输入在这里
907  assembly = await systemPrompt.assemble(...)    ← 系统提示词在这一步就定稿了
911  decision = await waterfall('agent/pre-step')   ← 本插件在这里
...
1061 session.append('user/message', m)              ← 用户输入到这里才落盘
1063 buildRequest(...) → LLM
```

于是：

- `system-prompt/assemble` 跑在**前面**，而且此刻本轮用户消息**还没进 session log**（它是在第 1061 行才 append 的）—— 所以系统提示词通道**根本看不到本轮输入**。
- `agent/pre-step` 是**唯一**同时满足「拿得到本轮原始输入」和「被 await、且在模型请求之前」的位置。

这也是为什么"检索用户输入 → 注入 → 本轮立刻可见"只能走这条路。

---

## 安装

前提：这是一个**本地包**，需要让 profile 能解析到它。

### 方式 A —— 作为 bundle 安装（推荐）

在 profile 目录（`~/.dsh/profiles/<profile>`）里：

```sh
pnpm add "file:C:/path/to/dsh-inject-context"
```

然后把它加进 profile `package.json` 的 bundle 列表：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-inject-context"]
    }
  }
}
```

bundle 会让 harness 自动应用包内的 `cordis.patch.yml`，把插件条目插进 loader 树。

### 方式 B —— 直接写 profile 的 patch 层

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-inject-context
      name: dsh-inject-context
```

（`name` 是 module specifier，从 profile 目录解析，所以仍需要 `pnpm add` 让包可解析。）

无需构建步骤：`lib/index.js` 就是最终产物。

---

## 自检

不装进 harness 也能验证插件逻辑：

```sh
node test/smoke.mjs
```

它用一个 mock Cordis context 跑完 8 组用例，并且**把 harness 的持久化校验规则镜像了一份**（`assertMessageEventShape`）——注入出来的消息必须能通过这道校验，否则真实运行时会 `throw`。

覆盖的用例：

| 用例 | 断言 |
|---|---|
| 1 | 带真实用户输入的 step → 恰好追加 1 条，既有消息原样透传 |
| 2 | 工具续跑的 step（claim 为空）→ 不注入 |
| 3 | 新 turn、输入与列表都没变、旧消息仍在 surface 上 → 去重不注入 |
| 3b | 旧消息已被压缩掉 → **必须重新注入** |
| 3c | session 形状读不出来 → **安全兜底：注入**（宁可多发几个 token，也不能把模型饿死） |
| 3d | 目录内容变了 → 重新注入 |
| 4 | 别的插件的注入（`source.kind !== 'user'`）不会被误当作用户输入 |
| 5 | 目录读不到 → 降级为不注入 + 记 warning |
| 6 | turn 已取消 → 不注入 |
| 7 | `apply()` 返回的 disposer 能摘掉监听 |

---

## 配置

本包**不带 Config schema**（保持零依赖）。`cordis.patch.yml` 里的 `config:` 会原样传给 `apply(ctx, config)`，未提供的走默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `maxEntries` | `100` | 最多列出多少项，超出显示 `... (N more not shown)` |
| `maxChars` | `6000` | 注入文本的硬上限 |
| `timeoutMs` | `3000` | 目录读取超时。**强制项**：pre-step 是被 await 的，卡住多少就加多少首字节延迟 |
| `dedupeUnchanged` | `true` | 列表未变且旧副本仍在 surface 上时跳过 |
| `includeHidden` | `false` | 是否包含点开头的条目 |
| `cwdOverride` | – | 强制指定目录（调试用）；否则用 `agent.session.header.cwd` |

想加 Config schema，用 `@deepseek-ai/schemastery` 或 profile 里可解析的 `zod`，然后 `export const Config = ...`。

---

## 落盘与影响

注入的消息**必然是 durable** 的 —— `step()` 会把它 `session.append('user/message', …)` 写进会话日志。这不是可以关掉的副作用，而是注入生效的唯一途径（原因见下一节）。

| 影响 | 说明 |
|---|---|
| 进对话记录 | 在 Web UI 里渲染为一条带 `dsh-inject-context` 标签的**注入上下文行**，不是用户气泡 |
| 占上下文 | 计入 token，参与压缩、上下文压力、会话导出 |
| 可审计 | 带 `source.kind` / `provider` / `cwd`，能和真人输入区分 |
| 不会重放 | 恢复会话时不会重新生成（消息已在历史里） |
| 压缩后能自愈 | 旧副本被压缩掉后，下一次注入会自动补回 |
| 不碰系统提示词 | 请求前缀逐字节不变，前缀缓存不受影响 |
| 不干扰 harness 自带的动态上下文 | `source.kind` 不同，`RuntimeContextProjection` 的比对/替换链追踪不受影响 |

### 消息为什么必须长这样

```js
{
  id: randomUUID(),                                  // ← 必填
  role: 'user',
  source: { kind: 'dsh-inject-context', form: 'snapshot', provider: 'dir', cwd },
  content: [{ type: 'text', text }],
}
```

- **`id` 必填**：`@deepseek-ai/dsh-session` 的 `assertMessageEventShape` 会拒绝没有非空字符串 `id` 的消息 —— 少写就是运行时 `throw`。
- **`source.kind` 可以用自定义值**：该校验只对 `system` / `assistant` / `tool` 的 kind 做枚举约束，`user/message` 的 kind 是开放的（harness 自己的动态上下文就用了 `'runtime-context'` 这个不在类型表里的值）。
- **`source.kind` 决定 UI 怎么渲染**（见下节）。
- **不要复用 `'runtime-context'`**：那个 kind 被 `RuntimeContextProjection` 用来做快照比对和替换链追踪，复用会被误清。
- **content 只能是 text / image / file 块**：`tool-addition` / `tool-removal` 块在非 developer 角色上会被拒绝。

---

## 入库不是副作用，入库就是注入机制本身

这是设计上最需要理解的一点：**没有任何办法把内容送进模型请求而不落盘**。

链路是单向的：

```
pre-step 的 decision.messages
   ↓  step() L1061
session.append('user/message', message, { surfaceOp: 'append' })   ← 入库
   ↓  成为 session surface 上的一个节点
session.deriveMessages()  ←  L1554：遍历 surface.nodes，从日志派生消息
   ↓  buildRequest() L1262
request.messages                                                            ← 模型真正收到的
```

`buildRequest()` 里的 messages **完全来自 `session.deriveMessages()`**，不接收任何外部传入的消息表。而且这条捷径也被堵死了：

- `request` 对象被 `Object.freeze()`，`messages` 数组也被冻结（`Object.freeze(boundaryMessages)`）；
- `llm/stream` 的签名是 `(options, next: () => AsyncIterable<StreamChunk>)` —— `next` 不接受参数，无法替换 `options`。

**所以："入库"和"让模型看到"是同一件事，不是两个可选动作。** 这也意味着 harness 自己的 `runtime-context` 快照同样是一条落盘的 `user/message` —— 本插件的行为和它完全一致。

因为入库，注入内容自动获得：会话回放、参与压缩与裁剪、会话导出、`sessionQuery` 全文检索、`dsh-context` 的 Context Browser / Context Events 可见、进程重启后仍在。

### UI 呈现

`dsh-client-ui-chat` 对每一条落盘的 `user/message` 按 `source.kind` 分流：

```js
// client.js
/** User, steering, and injected-context message classification Definition. */
if (event.data.source.kind !== "user") {
  return { ...contextMessage(event, event.data), waking: ... }   // → kind: 'context'
}
// source.kind === 'user' → kind: 'user' 或 'steering'
```

```js
/** Context presentation shared by user-role injections and developer messages. */
function contextMessage(event, message) {
  return { kind: 'context', producer: contextProducer(message.source), form: contextForm(message.source), ... }
}
```

- `contextProducer()` 对未知 kind 走 default 分支 → `{ role: 'inject', label: kind }`，所以这一行的标签就是 **`dsh-inject-context`**。
- `contextForm()` 只认 `instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall`，其余（含缺省）留给不透明呈现。目录列表用 `'snapshot'`。

结论：**注入消息在对话里渲染成一条带来源标签的"注入上下文"行，不是用户气泡。** 不需要额外写 client 半。

---

## 去重

两层，都在插件内存里：

| 闸门 | 键 | 挡住什么 |
|---|---|---|
| Gate 2 | `(sessionId, turn, queryHash)` | 同一个 turn 内多步（工具调用往复）重复注入 |
| Gate 4 | `textHash` 未变 **且** 旧副本仍在 `session.surface.nodes` 上 | 跨 turn 的重复注入 |

Gate 4 的第二个条件是必需的：内容没变不等于模型还看得到它 —— 压缩可能已经把它挤掉了。判不出来时**一律不跳过**（宁可多发几个 token，也不能让模型丢上下文）。

局限：不跨进程/重启；不做内容级 chunk 去重（对目录列表没意义，换 RAG 才需要）；不跨 session。

---

## 已知限制

1. **读目录走 `node:fs`，绕过了 harness 的 `fs` 服务**，因此不受文件沙箱策略约束。样本图的是短；生产版本应当改用 `ctx.fs.resolve()` + `ctx.fs.listDir()`。
2. **`stillOnSurface()` 会调用 `session.snapshotEvents()` 扫日志**，长会话上是 O(n)。它只在「文本未变、需要判断是否跳过」时才跑，但生产版本应当换成 session projection，而不是扫全量日志。
3. **单进程内存台账**：`ledger` 按 sessionId 存，`agent/disposed` 时清。跨进程/重启不保留（重启后第一次会重新注入，这是正确行为）。
4. **`agent.session` 是内部形状**。`Agent` 的公开接口只保证 `id`；这里读的 `session.header.cwd` / `session.snapshotEvents()` / `session.surface.nodes` 都是 harness 内部约定，跨大版本可能需要适配。surface 判定失败时会安全降级为「照常注入」。

---

## 换成别的注入源

把 `renderDirListing()` 换成你自己的内容源即可，其余部分（触发闸门、幂等、去重、失败隔离、消息构造）都不需要动：

```js
// 例如：调一个检索服务
const text = await withTimeout(
  fetchFromRetrievalService(query, payload.signal).then(renderChunks),
  config.timeoutMs,
  'retrieval',
)
```

真正需要保留的只有三件事：

1. 在 `agent/pre-step` 里，**先 `await next()` 再追加**，并用 `{ prepend: true }` 注册成最外层 —— 其它插件完全感知不到你的消息；
2. 消息必须自备 `id`，并用私有的 `source.kind`；
3. 一切失败都 `return decision` 原样放行。

## License

MIT
