# dsh-inject-context

一个 DeepSeek Harness 上下文注入插件，**带 Plugins 页面上的设置页**。

在每一步模型请求之前，它拿**本轮用户输入**跑一遍**注入源（source）**：每个源返回一段可直接注入的文本，非空的结果各作为**一条独立的 `user` 消息**追加到本步消息列表末尾（**每源一条**）。

目前内置一个源 —— OpenViking（`ov`）：拿用户输入 `POST /api/v1/search/find`，把记忆包成 recall 块。**再加源只需往 `SOURCES` 注册一个适配器，并在 `Config` 里声明它的 `<id>.*` 配置项**，其余（触发闸门、去重、失败隔离、消息构造、设置页按前缀分组）全部共用。

连接参数、相似度阈值、条数、每条字符上限都在设置页里改 —— **密钥走 harness 的凭据域，不写进配置文件**。

配置按键分组：每个源一节，键名带源前缀（`ov.host`、`ov.scoreThreshold`…），第二个源就是与 `ov` 并列的兄弟键（`dir.root`…）。**用带点的平铺键而不是嵌套对象**是有意的 —— 设置页的 `SettingsFormModel` 只能寻址顶层字段，嵌套的 `sources.ov.host` 在卡片里读不到也写不进（详见「配置与设置页」）。

```
用户: 我的主题偏好是什么
       ↓
[agent/pre-step]  dsh-inject-context 取用户问题 → POST /api/v1/search/find → 包裹 recall 块 → 追加一条 user 消息
       ↓
模型实际收到:  [用户消息] [runtime-context] [【自动检索的候选记忆…】…【检索结束…】]
                                              ↑ 本插件注入
```

---

## 契约（刻意收窄）

这个插件存在的主要目的，是示范**"如何在不惊动其它机制的前提下注入上下文"**。所以它的边界是刻意钉死的：

| # | 约束 |
|---|---|
| 1 | **只有一个挂载点** —— `agent/pre-step`（waterfall），不碰其它任何事件 |
| 2 | **每个源只追加一条 `role: 'user'` 消息** —— 不替换、不改写、不删除任何既有消息 |
| 3 | **不注册任何 `systemPrompt` 贡献** —— 请求前缀（system prompt + 工具 schema）与不装本插件时**逐字节相同** |
| 4 | **不声明任何服务依赖**（`inject = []`）—— 不用 `systemPrompt` / `tools` / `session` / `fs` 服务 |
| 5 | **异常一律降级为"不注入"** —— 超时、HTTP 非 2xx、取消、畸形响应都不会打断这一轮对话 |

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
      config:
        scoreThreshold: 0.4
        limit: 3
```

（`name` 是 module specifier，从 profile 目录解析，所以仍需要 `pnpm add` 让包可解析。）

无需构建步骤：`lib/index.js`（宿主半）和 `lib/client.js`（浏览器半）都是最终产物。浏览器半是手写的 `window.__ModuleLoader__.load({ id, factory })` 包装，`require` 由运行时 loader 注入 —— 不需要打包器。

### 为什么插件能 `import '@deepseek-ai/schemastery'`

`@deepseek-ai/*` 包**并不在 profile 的 `node_modules` 里**（profile 用 `nodeLinker: hoisted`，只会平铺 profile 自己声明的依赖）。所以本包把它声明成 `peerDependencies`：

```json
"peerDependencies": { "@deepseek-ai/schemastery": "^3.18.2" }
```

`dsh-app-boot` 会装一个 **profile 解析引导**（`lib/worker/profile-resolution-bootstrap.js`），劫持 Node 的 ESM 与 CJS 解析器：它沿插件文件向上找 `package.json`、读其中的 `peerDependencies`，命中就把这个 import **路由到 harness 自己的那份副本**。dsh-context 能用 `@deepseek-ai/schemastery` 正是同一机制 —— 这也是为什么 profile 的 `pnpm-workspace.yaml` 故意写着 `autoInstallPeers: false`。

同一份声明也进了 `devDependencies`，只为了让 `node test/smoke.mjs` 在没有 harness 的环境里也能用真实 schemastery 跑起来；生产安装不会拉它（pnpm 不装被依赖包的 devDependencies）。

---

## 自检

不装进 harness 也能验证插件逻辑：

```sh
node test/smoke.mjs
```

它用真实 `@deepseek-ai/schemastery` 校验 `Config`，用一个 mock Cordis context 跑宿主半、`find` 请求换成 stub，并用一个 Client module loader 的替身**把浏览器半真的加载起来**验证设置页接线 —— 否则那部分只能靠开网页手点。另外**把 harness 的持久化校验规则镜像了一份**（`assertMessageEventShape`）：注入出来的消息必须能通过这道校验，否则真实运行时会 `throw`。

覆盖的用例：

| 用例 | 断言 |
|---|---|
| 1 | `Config` 有 9 个 `.volatile()` 字段（`enabled` + `ov.*`）、`ov.apiKeyEnv` 的 role 是 `credential-ref`、无 secret 字面量；volatile 字段是 `.get()` 引用、普通字段是普通值 |
| 2 | 首个 step 恰好追加 1 条，既有消息原样透传；`find` 的 URL / 请求头 / `query` / `score_threshold` / `limit` 全部正确；重 uri 去重、按分数降序、超长 abstract 在 `abstractChars` 处截断并标记 |
| 3 | 工具续跑的 step（claim 为空）→ 不检索也不注入 |
| 4 | 结果未变且旧副本仍在 surface 上 → 跳过；已被压缩掉 → **必须补回**；session 形状读不出来 → **兜底注入** |
| 5 | 别的插件的注入（`source.kind !== 'user'`）不会被误当作用户输入 |
| 6 | `enabled: false` → 完全不碰网络 |
| 7 | `ov.host` 留空 → 该源不注入不请求 |
| 8 | host 里自带 `https://` 和端口也能正确拼接 |
| 8b | `ov.abstractChars: 0` → 不截断 |
| 9 | 401 / 500 / 非 JSON 响应 / 网络错误 / 超时 → 告警 + 降级不注入；**空结果是正常情况，静默** |
| 10 | turn 已取消 → 不注入 |
| 11 | 配置按轮读取（live ref），设置页改动下一轮生效 |
| 12 | `apply()` 返回的 disposer 摘掉全部两个监听 |
| 13 | 浏览器半注册 `plugins.bundle.config`，**key 等于包名**；语言包齐备；summary 视图可用 |
| 14 | 注册第二个源后，两个源**各追加一条**消息、各带自己的 `provider`/`form`，走同一条通道 |

---

## 配置与设置页

插件的配置分成两类，这个划分是整个设置体系的关键：

| 类别 | 声明方式 | 在哪改 | 用途 |
|---|---|---|---|
| **设置页字段** | 加 `.volatile()` | Plugins 页面 → 本 bundle 的页面 → 配置区 | 用户面向的连接与检索调参 |
| **普通配置** | 不加修饰 | profile 的 Cordis patch | 运维级旋钮，不需要表单 |

`@deepseek-ai/dsh-settings` 说得很直接：**表单只暴露 `.volatile()` 字段**（"Forms expose only volatile fields from active, uniquely addressed profile entries"）。普通字段在设置页里根本不出现。

还有一条容易踩的：**没有任何内置客户端会按 schema 自动建页**。同一份 README 写着 `autoGenerate` 是"for clients that build pages from the schema; **no shipped client does so yet**"，我在 asar 里核对过 —— `autoGenerate` 的消费者只有 `dsh-api-remotes` / `dsh-api-settings-controller` / `dsh-settings`，**零个 `dsh-client-ui-*`**。所以 `lib/client.js` 是必须写的，它把卡片注册进 `plugins.bundle.config` 槽（key = 包名）。

### 设置页字段

设置页按源分组：字段名带源前缀，`ov.*` 是 OpenViking 一组；再加的源会是同级的另一组。**注意用平铺的点号键**（`ov.host`）而非嵌套对象，见文首说明与「已知限制」。

| 配置键 | 控件 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | 启用注入（开关） | `on` | 关掉后所有源都不跑 |
| `ov.host` | OV · 主机 | （空） | 留空 = 停用该源。可写 `host`、`host:port` 或 `https://host:port`；端口并入 host（缺省 `1933`） |
| `ov.user` | OV · 用户 | （空） | `X-OpenViking-User` |
| `ov.account` | OV · 账号 | `default` | `X-OpenViking-Account` |
| `ov.peer` | OV · 对端 | `default` | `X-OpenViking-Peer` |
| 写only控件 | OV · **API Key** | （空） | **写进凭据域**，不落配置文件 |
| `ov.apiKeyEnv` | OV · 凭据引用名 | `OPENVIKING_API_KEY` | 密钥存在哪个名字下 |
| `ov.scoreThreshold` | OV · 相似度阈值 | `0.4` | 见下方实测 |
| `ov.limit` | OV · 最多条数 | `3` | 每轮请求多少条 |
| `ov.abstractChars` | OV · 每条字符上限 | `1200` | 0 = 不截断 |

### 普通配置（profile patch）

| 键 | 默认 | 说明 |
|---|---|---|
| `maxChars` | `6000` | 注入块整体的字符硬上限 |
| `timeoutMs` | `3000` | 检索超时。**强制**：pre-step 被 await，卡住多少就加多少首字节延迟 |
| `dedupeUnchanged` | `true` | 结果未变且旧副本仍在 surface 上时跳过 |

### 密钥为什么不进配置

`ov.apiKeyEnv` 是一个**凭据引用名**（`role('credential-ref')`），真正的密文由 harness 的凭据域持有，落在 `~/.dsh/.credentials.yaml`。设置页只拿到 `{configured, writable}`，**永远读不到密文原文**；Host 半用 `ctx.credentials.resolve(ref)` 取用。

这样配置文件里没有秘密，仓库里也没有 —— 对一个公开仓库是必需的。

### 实测：OpenViking `find` 的真实返回

对本机部署实测 `POST /api/v1/search/find`，原始响应体是：

```json
{ "status": "ok",
  "result": { "memories": [ { "context_type": "memory", "uri": "viking://…",
                              "level": 2, "score": 0.4566, "abstract": "…", "tags": [] } ],
              "resources": [], "skills": [], "total": 5 } }
```

对调参有用的几条结论：

- **`score_threshold` 是服务端过滤的**，`limit` 也生效（实测阈值 0.8 / 0.95 都返回 0 条）。
- **相似度分数被压缩在很窄的区间**：

  | 查询 | top-5 分数 |
  |---|---|
  | `DeepSeek 上下文缓存优化`（强相关） | **0.683** 0.637 0.604 0.584 0.582 |
  | `Flutter 文件工具接入`（相关） | **0.626** 0.573 0.542 0.505 0.491 |
  | `上下文注入插件`（弱相关） | 0.457 0.424 0.395 0.393 0.391 |
  | `zzzz qwertyuiop`（噪声） | 0.406 0.330 0.328 0.327 0.325 |
  | `今天天气怎么样`（无关） | 0.278 0.273 0.263 0.258 0.253 |

  强相关能到 0.6+，噪声上限约 0.41。**默认 0.4 是个合理的分界**：挡掉大多数噪声，又不至于把弱相关记忆一起丢掉。想更保守可以提到 0.45，代价是弱相关记忆也会被砍掉。
- **`abstract` 可以长到约 1.6k 字符**，不是几百字。所以每条字符上限默认给到 `1200` —— 早期固定截 300 字符的写法会把最有价值的记忆砍掉八成。分数字段也因此打印三位小数，两位会把不同排名压成同一个数字。
- **空 query 会得到 HTTP 400**，插件的 `query.length === 0` 守卫因此是有效的。

---

## 落盘与影响

注入的消息**必然是 durable** 的 —— `step()` 会把它 `session.append('user/message', …)` 写进会话日志。这不是可以关掉的副作用，而是注入生效的唯一途径（原因见下一节）。

| 影响 | 说明 |
|---|---|
| 进对话记录 | 在 Web UI 里渲染为一条带 `dsh-inject-context` 标签的**注入上下文行**，不是用户气泡 |
| 占上下文 | 计入 token，参与压缩、上下文压力、会话导出 |
| 可审计 | 带 `source.kind` / `provider`（`openviking`），能和真人输入区分 |
| 不会重放 | 恢复会话时不会重新生成（消息已在历史里） |
| 压缩后能自愈 | 旧副本被压缩掉后，下一次注入会自动补回 |
| 不碰系统提示词 | 请求前缀逐字节不变，前缀缓存不受影响 |
| 不干扰 harness 自带的动态上下文 | `source.kind` 不同，`RuntimeContextProjection` 的比对/替换链追踪不受影响 |

### 消息为什么必须长这样

```js
{
  id: randomUUID(),                                  // ← 必填
  role: 'user',
  source: { kind: 'dsh-inject-context', form: 'recall', provider: 'openviking' },
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
- `contextForm()` 只认 `instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall`，其余（含缺省）留给不透明呈现。**检索到的记忆用 `'recall'`。**

结论：**注入消息在对话里渲染成一条带来源标签的"注入上下文"行，不是用户气泡。** 不需要额外写 client 半。

---

## 去重

两层，都在插件内存里：

| 闸门 | 键 | 挡住什么 |
|---|---|---|
| Gate 2 | `(sessionId, turn, queryHash)` | 同一个 turn 内多步（工具调用往复）重复注入 |
| Gate 4 | `textHash` 未变 **且** 旧副本仍在 `session.surface.nodes` 上 | 跨 turn 的重复注入 |

Gate 4 的第二个条件是必需的：内容没变不等于模型还看得到它 —— 压缩可能已经把它挤掉了。判不出来时**一律不跳过**（宁可多发几个 token，也不能让模型丢上下文）。

局限：不跨进程/重启；不做内容级 chunk 去重（换 RAG 做 chunk 级召回时才需要）；不跨 session。

---

## 已知限制

1. **直接用全局 `fetch`**：未经过 harness 的网络代理/沙箱策略；超时靠 `timeoutMs` 兜底。
2. **只实现 `find`**：OpenViking 还有 `search`（带会话上下文）等接口，本插件只用了无上下文的向量 `find`。
3. **`stillOnSurface()` 会调用 `session.snapshotEvents()` 扫日志**，长会话上是 O(n)。它只在「文本未变、需要判断是否跳过」时才跑，但生产版本应当换成 session projection，而不是扫全量日志。
4. **单进程内存台账**：`ledger` 按 sessionId 存，`agent/disposed` 时清。跨进程/重启不保留（重启后第一次会重新注入，这是正确行为）。
5. **`agent.session` 是内部形状**。`Agent` 的公开接口只保证 `id`；这里读的 `session.snapshotEvents()` / `session.surface.nodes` 都是 harness 内部约定，跨大版本可能需要适配。surface 判定失败时会安全降级为「照常注入」。
6. **表单控件只能用 primitives 提供的那几种**。`@deepseek-ai/dsh-client-ui-primitives` 的 settings-form 只导出 `SettingsForm` / `SettingsFormModel` / `settingsTextField` / `settingsNumberField` / `SettingsValueField` / `SettingsSecretField` —— **没有布尔字段**。本插件的"启用"开关是靠自定义一个 `on`/`off` 的字段 spec 配 `Switch` primitive 实现的（见 `lib/client.js` 的 `settingsBooleanField`），因为 `SettingsFormModel` 的字段 spec 本质上只是 `format`/`parse` 一对函数，可以自己写。
7. **源配置用带点的平铺键分组，而非嵌套对象**。设置页的 `SettingsFormModel` 只能寻址顶层字段（读 `value[field]`、写 `path: [field]`），所以源分组落成字面量点号顶层键 `ov.host`；真嵌套的 `sources.ov.host` 在卡片里读不到、写不进。（host 侧 `dsh-settings` 的 `volatileForm`/`isVolatilePath` 本身支持嵌套与多段路径，但现有手写卡片发不出多段路径。）

---

## 添加一个注入源

通道是可插拔的：注册一个适配器即可，其余全部共用。

1. 在 `Config` 里声明该源的配置项，键名带源前缀（与 `ov.*` 并列），用户面向的字段加 `.volatile()`：

   ```js
   'dir.root': z.string().default('').volatile(),
   ```

2. 实现适配器并注册进 `SOURCES`：

   ```js
   export const dirSource = {
     id: 'dir',          // 同时作为配置前缀：`dir.*`
     provider: 'dir',    // → source.provider
     form: 'snapshot',   // → source.form，客户端认得的形态之一
     enabled: (config) => String(readConfig(config, 'dir.root', '')).length > 0,
     collect: async (ctx, { query, config, signal }) => {
       // 返回已包好的可注入文本，或 ''（无需注入）；可抛异常，通道会捕获并只降级该源
       return renderDirListing(rootOf(config), query)
     },
   }
   SOURCES.push(dirSource)
   ```

3. 想让它出现在设置页，就在 `lib/client.js` 里照葫芦画瓢加一组字段（spec 用 `'dir.root'` 这种顶层键名），并加一个分组标题。

通道统一负责：只对真实用户输入触发、每 `(session, turn, source, input)` 注入一次、`textHash` + surface 判定的跨轮去重、每源独立超时与失败隔离、`maxChars` 截断、消息构造（`id` / `source.kind` / `provider` / `form`）。

无论加多少源，硬性不变的是这三条：

1. 在 `agent/pre-step` 里，**先 `await next()` 再追加**，并用 `{ prepend: true }` 注册成最外层 —— 其它插件完全感知不到你的消息；
2. 消息必须自备 `id`，并用私有的 `source.kind`；
3. 一切失败都只影响该源，`return decision` 原样放行。

## License

MIT
