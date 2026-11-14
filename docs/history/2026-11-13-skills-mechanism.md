# 2026-11-13 · Skills 机制：从 provider 到会话目录

> 状态：**调研/决策记录，不是现行规范**。事实基线是记录当时的 Desktop profile、DSH `0.2.2-rc.2`、
> `cordis` preset；核对时安装版已到 `0.2.2-rc.3`，源码路径与行为可能变化，引用前按日期复核。
>
> 目的：在决定「把 skills 也纳入 catalog 管理」之前，先把 skills 的发现、合并、注入、加载、变更这五条链路讲清楚。
>
> 结论先行：**skills 的正文已经是按需加载的，常驻上下文里的只有一份扁平路由目录。** 因此「纳入 catalog」的真正难点不是「要不要管」，而是：**官方 skill 目录不归我们管，也几乎不能从插件侧过滤**——要么改写它的消息，要么接管它的消费面。
>
> 文末列了每条结论的源码/文档/实测出处。

---

## 0. 一句话版本

skills 不是「另一套 tools」。它是一条独立的能力族：

```
多个 provider（磁盘 / 随包 / 运行时）→ ctx.skills 注册表（分层合并）
  → dsh-tool-skill（官方消费方）
      ├─ 会话首步注入一份 <available_skills> 目录（name + description）
      ├─ skill(name) 工具按需加载正文
      └─ /name 手势把正文注入成一条 user message
  → Web 端 / 菜单（sessionSkillCatalog Remote）
```

目录里**只有 name 和 description**，没有正文、路径、source、whenToUse；正文只在 `skill(name)` 调用或 `/name` 手势时进入上下文。

---

## 1. 全景图

```
~/.agents/skills/*/SKILL.md ─────────┐
<project>/.dsh/skills ───────────────┤
preset 的 customSkillDirs ───────────┤   ┌──────────────────────────┐
dsh-skill-office（随包 assets）──────┼──▶│ ctx.skills（分层注册表） │
recommendation providers（随包）─────┤   │  global + preset 层       │
ctx.skills.register()（运行时）──────┘   └────────────┬─────────────┘
                                                      │ SkillSummary[]
                          ┌───────────────────────────┼───────────────────────────┐
                          ▼                           ▼                           ▼
                 dsh-tool-skill                /name 手势                 sessionSkillCatalog
                          │                           │                           │
             ┌────────────┴────────────┐              │                           │
             ▼                         ▼              ▼                           ▼
  会话目录消息（user）         skill(name) 工具   正文注入 user message      Web `/` 菜单
  <available_skills>          正文 + resourceBase   source: skill-invocation   （仅 user-invocable）
```

三个容易混淆的点，先钉死：

1. **它不是 system prompt section**。目录是 `agent/pre-step` 注入的一条 **durable user message**（`source.kind = "skill-catalog"`），会进会话历史。
2. **它不是每步重发**。目录有 digest 比对：内容不变就不动；内容变了才追加一条“替换目录”；旧目录消息不会被改写。
3. **它不是纯上下文**。加载 skill 可能**解锁工具**（office 三件套、action cards），所以“加载 skill”不能随便换成我们自己的工具。

---

## 2. 数据模型

一个 skill 由两部分组成，生命周期分开：

| 部分 | 形状 | 何时读取 |
|---|---|---|
| 目录项 | `SkillSummary`：`name`、`description`、`whenToUse?`、`path?`、`invocation`、`source`、`provider`、`resourceBase?` | 每次 `list()/snapshot()` |
| 正文 | `SkillDefinition.content`（Markdown），外加 `metadata` | 每次 `get(name)` 重新读文件 |

关键约束：

- **name**：kebab-case，`^[a-z0-9]+(?:-[a-z0-9]+)*$`。
- **description**：模型目录里会做空白归一化，默认截断到 **500 字符**（`catalogDescriptionMaxLength`，最小 3）。
- **whenToUse**：会被 provider 解析进 `SkillSummary`，但**官方模型目录不渲染它**。这是“目录信息量”的一个天然缺口。
- **invocation**：两个独立布尔值，来自 frontmatter：
  - `disable-model-invocation: true` → `modelInvocable: false`：不进模型目录、`skill` 工具也拒绝；只能由用户 `/name` 触发。
  - `user-invocable: false` → `userInvocable: false`：不进 `/` 菜单，但模型仍可加载。
  - 两者都 `false`：只对可信的 `ctx.skills.get()` 调用方可见。
- **source**（来源桶，不是优先级本身）：`project-dsh` / `project-agents` / `custom` / `user-dsh` / `user-agents` / `bundled` / `runtime`。
- **scope 分层**：注册落在调用方 context 的 scope 层。宿主插件进全局层，preset 常驻组合进该 preset 层；**最近层的同名 skill 直接赢**，rank 只在同层内裁决重名。

---

## 3. 发现与合并

### 3.1 注册表 `ctx.skills`

- provider 在 `apply()` 里同步 `registerProvider()`；`list()` 里可以 await 远程发现。
- 运行时 skill 用 `ctx.skills.register()`，落在 `runtime` provider，rank 250。
- 同层重名：rank 小者赢 → provider 注册顺序 → provider 内部顺序。
- 读取合并 global 层 + 观察 scope 的链；排序按 name。
- 发现缓存按 **cwd × scope 链 × revision** 键控；provider 调 `invalidate()` 或运行时注册/释放会 bump revision，并发出 **不带 diff** 的 `skills/change` 事件。
- `snapshot()` 返回 `{ skills, complete }`；**incomplete 不缓存**，下一次读取会重试。provider 失败会被记录并从观测中省略，但其他 provider 的候选仍可用。

### 3.2 文件系统 provider 的根与优先级

| Rank | source | 根 |
|---:|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills`（跳过 `.system`） |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` / `DSH_BUNDLED_SKILL_DIR` |

- 项目根 = 最近的含 `.git` 祖先；没有就用 cwd。
- 只认**一层**：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`；不递归 `**/SKILL.md`。
- Chokidar 监视已存在的根（depth 1）；缺失的根从最近存在的祖先逐段建立 `fs.watchFile`。
- 目录变化（bundle/flat 条目增删、直属 `SKILL.md` 变更）会让 provider `invalidate()`；**bundle 下的资源文件变化不算目录变化**。
- 正文每次 `get()` 重读，所以改正文不需要失效目录；也不会改写已加载的旧 tool result。

### 3.3 preset 的挂载方式（本机关键事实）

- `dsh-base` 有宿主级 `skill-filesystem` + `tool-skill` 行，但 `dsh-web-app` 把它们**禁用**了。
- 每个 preset（`cordis` / `standard` / `ptc`）在自己的常驻组合里重新挂 `skill-filesystem` + `tool-skill`。
- `dsh-doc` 不是独立插件，是 preset 的 `customSkillDirs` 指向 `@deepseek-ai/dsh-agent-preset/skills` 发现的。
- 结果：**模型目录与 `skill` 工具都落在每个 agent 的 preset scope 层**——这直接决定了我们的插件能不能过滤它们（见 §7）。

---

## 4. 本机这 21 个 skill 到底从哪来

同一个扁平列表，背后是 **6 条注册路径**：

| 来源 | 数量 | 名字 |
|---|---:|---|
| `user-agents`（`~/.agents/skills`） | 13 | agents-sdk, cloudflare, cloudflare-email-service, cloudflare-one, cloudflare-one-migrations, durable-objects, sandbox-migrate-to-next, sandbox-next, sandbox-stable, turnstile-spin, web-perf, workers-best-practices, wrangler |
| preset `custom`（agent-preset/skills） | 1 | dsh-doc |
| `dsh-skill-office`（随包 provider） | 4 | office, office-docx, office-pptx, office-xlsx |
| `dsh-personalized-pages`（随包 provider，model-only） | 1 | personalized-pages |
| `dsh-official-plugins`（随包 provider，model-only） | 1 | official-plugins |
| `ctx.skills.register()`（@local/dsh-cloudflare 运行时） | 1 | cloudflare-integration |

合计 21 个，全部 `modelInvocable: true`；其中 `personalized-pages`、`official-plugins` 是 `userInvocable: false`（`/` 菜单不显示）。

> 这就是“感觉混乱”的根源：**一个列表，六种装法**。磁盘目录、preset 的 custom 目录、随包 provider、运行时注册，最终在注册表里长得一模一样，只有 `source` 字段不同。

---

## 5. 会话里的生命周期

### 5.1 首步：注入目录

`dsh-tool-skill` 在 live session 的第一个 `agent/pre-step` 注入：

```
<system-reminder>
A skill is a reusable set of task-specific instructions. ...
<available_skills>
- `name`: description
...
</available_skills>
...
</system-reminder>
```

- **前置条件**：`ctx.tools.get('skill', agent)` 必须**按定义身份**等于 tool-skill 自己注册的那个 `skill` 工具。被 scoped 同名工具影子掉、或工具不可见，就**不注入目录**（同时 `skill` 工具也不在）。
- 条目只取 `isModelInvocable`；name + 归一化/截断后的 description。
- 发现不完整时，目录仍发布已确认的子集，并带一条 `incomplete` 警告。
- 目录消息带结构化 `source.entries`，UI/其它消费方可以读条目，不必解析 `<available_skills>` 文本。

### 5.2 后续步：digest 比对与替换

- 每一步都会 `snapshot()`，把 `entries + complete` 做 sha256 digest。
- 与“会话里最新的、可见的目录消息”比对：
  - 相同 → 不动；如果当前批里被重新加进来，会把它移除，避免重复。
  - 不同 → **追加**一条“替换目录”（`update: true`），声明它替换之前所有目录；旧消息留在历史里。
  - 全部 skill 消失且此前发布过 → 追加一条显式空目录。
- compaction 把历史目录消息都藏掉后，下一次观测会重新建立目录。
- **没有 TTL、没有定时刷新**：目录只在 provider 失效（watcher / `skills/change`）后，在下一个 step 重新计算。

### 5.3 `skill(name)` 工具

- 校验 name → 在目录里找 summary → 检查 `isModelInvocable` → `ctx.skills.get()` 重读正文 → 再检查一次 policy。
- 返回 `<skill_content>` + `<skill_resources>` + `<skill_instructions>`；`resourceBase` 只用于让模型按需解析相对资源，**不会枚举目录**。
- 加载失败/已消失 → 明确报错，不会静默给旧正文。
- 加载结果是一条普通 tool result，会留在会话历史里；之后改正文只影响后续调用。

### 5.4 `/name` 手势

- 只扫描 **直接用户输入**（`source.kind === "user"`）的文本块，正则 `(^|\s)/(name)(?=\s|$)`。
- 命中 user-invocable skill → 把完整正文作为一条 user message 注入（`source.kind = "skill-invocation"`，`form = "instructions"`），并排在所有其它注入之后（最靠近模型回答）。
- 这是 `disable-model-invocation` skill 的**唯一**入口。
- 未知名字不报错，保持普通文本。

### 5.5 Web `/` 菜单

- 走 `ctx.sessionSkillCatalog` 的 `skills/list` Remote，列出 user-invocable 条目（name、description、whenToUse、model 可用性标记）。
- 客户端 `dsh-client-ui-skill` 负责 `/` 补全和 `skill` 调用卡片。
- 这条链路**不依赖** `dsh-tool-skill` 的目录消息，所以即便模型目录被接管，`/` 菜单仍应继续工作。

### 5.6 加载 skill 会解锁工具（容易忽略）

- `dsh-tool-office`（standard / ptc preset 挂了它；当前 `cordis` preset 没挂）：监听 `tools/result` 中 `exec.name === "skill"` 且 name ∈ `activationSkills`，或 `session/event` 里 `source.kind === "skill-invocation"` 的同名 skill；命中后该 agent 的 office 三件套才在后续步被声明。它还把“上一次请求头里已有 office 工具”作为恢复条件。
- action cards：`propose_action` 只对“加载过对应 card kind 的 skill”的 agent 声明。
- 含义：**skill 加载路径不是纯上下文**。如果我们用自己的 `search_tools` 直接把正文塞进结果，绕过 `skill` 工具，这些下游激活会断。

---

## 6. 成本实测（本机）

### 6.1 常驻目录

对当前 `cordis` 会话的 `skill-catalog` 消息做实测：

| 指标 | 数值 |
|---|---:|
| skill 数 | 21 |
| 目录消息总字符 | **7,974** |
| 其中逐条 `- name: desc` | 7,291 |
| 固定头/尾（说明文字） | ~685 |
| 只列 name（含分隔符） | **341** |
| 粗估 token（chars/4） | **~2.0k** |

对照组：本插件在同 profile 的工具目录把首请求从 49,504 tokens 降到 18,536 tokens（README 的 A/B）。**skills 的常驻成本约为工具节省量的 6%**，量级完全不同。

### 6.2 替换目录会累积

官方实现是“追加替换消息”，不是“改写旧消息”。本机一个长会话里出现过 **5 条** skill 目录消息：

```
seq 11    20 条  6,487 chars   (initial)
seq 3038  20 条  6,350 chars   (update)
seq 6693  20 条  6,350 chars   (update)
seq 7981  21 条  6,755 chars   (update)
seq 8046  22 条  7,084 chars   (update)
合计 33,026 chars
```

（该会话有 27 次 `compaction/prune`，旧消息可能被裁掉；但没有 compaction 的会话里，这些消息会一直留在历史中。）

这带来一个独立于“分组”的改进点：**目录变更的写入策略**。如果由我们管理，可以用 system-prompt context 或“就地替换”避免重复正文。

---

## 7. 与 `dsh-agentic-tool-catalog` 的交叉点

### 7.1 现状

- 本插件按 agent 用 `agent.ctx.tools.restrict({ deny })` 收敛**全局工具**；常驻列表里包含 `skill`（`lib/catalog.js:13`），所以官方目录目前正常注入。
- 本插件自己的目录提示 `catalog:note` 是 **system-prompt context**，每步按目录状态渲染，不写会话历史。
- 本插件不读 `ctx.skills`，所以 skills 既不出现在 `catalog_status`，也不出现在面板。

### 7.2 硬约束（这是整套设计的真正边界）

1. **`tools.restrict` 管不了 `skill` 工具。**
   `ToolRestriction` 只作用于“继承来的全局工具”；scope 自己的注册（preset 的 `skill` 就是）**明确豁免**，而且传 scope-local 名字会直接失败。
   → 我们**不能**通过“把 `skill` 工具 deny 掉”来让官方目录消失。

2. **`dsh-tool-skill` 没有 allow/deny/list 过滤配置。**
   它只有 `catalogDescriptionMaxLength` 一个旋钮。
   → 不接管消息，就无法改变“哪些 skill 出现在模型目录里”。

3. **注册表没有给消费方的过滤视图。**
   `ctx.skills.list/snapshot` 只接受 `cwd`、`signal`、`scope`；没有 `include/exclude`。
   → 我们只能“加” skill，不能“藏” skill。唯一的偏门是注册更高 rank 的同名 runtime skill 去 shadow，但那要求我们同时接管正文与 resourceBase，且对 preset / 随包来源无效——不是可维护方案。

4. **目录与 `skill` 工具是绑定的。**
   目录注入的前置条件是 `skill` 工具按身份可见；反过来说，只要 `skill` 在，目录就在。
   → 想只留工具、去掉目录，也没有官方开关。

5. **加载路径有下游副作用。**
   office / action cards 依赖 `exec.name === "skill"` 或 `skill-invocation` source。
   → 统一搜索可以把“名字和描述”给模型，但**加载仍应走官方 `skill(name)`**。

### 7.3 结论

在不改动官方实现的条件下，本插件能做到的是：

- 读 `ctx.skills.snapshot({ scope: agent, cwd })`，把 skills 加进 `catalog_status`、面板、`search_tools` 的结果；
- 但**不能**减少官方那 7,974 字符的目录，也不能按会话隐藏某个 skill。

要“真正管理”skills，只有两条路：

- **A. 改写官方 pre-step 消息**：保留 `source.entries`、只改渲染文本（或直接过滤掉），把目录换成分组目录；
- **B. 接管消费面**：preset 不挂 `tool-skill`，由本插件实现目录 + `skill` 工具 + 手势 + 相容的 UI 语义。

两条路都要维护对官方内部契约的兼容性；B 还要处理 preset 组合、`/name`、office/card 激活、Web `/` 菜单。

---

## 8. 为什么 skills ≠ tools（决定 ROI 的关键）

| 维度 | tools（本插件现状） | skills |
|---|---|---|
| 常驻内容 | 每个工具的完整 JSON Schema | 每个 skill 的 name + description |
| 按需加载的东西 | schema + 可执行定义 | 正文（Markdown） |
| 官方是否已经按需 | 否（默认全量） | **是**（正文本来就不常驻） |
| 目录的用途 | 让模型知道“有哪些工具可以解锁” | 让模型**在调用前**判断该不该加载 |
| 隐藏目录的代价 | 多一次 `search_tools` | 多一次搜索，且**路由信息变少** |
| 加载的副作用 | 解锁后可调用 | 可能解锁工具（office/action cards） |

所以：

- tools 的目录是“省 schema”，收益巨大；
- skills 的目录是“省路由描述”，收益约 2k tokens，但**路由描述本身就是选择 skill 的依据**。把它藏进搜索，等于把一次判断换成一次往返，可能反而更贵、更容易选错。

这不是说 skills 不该管，而是说：**它的卖点更可能是“统一 UX / 按需可见性 / 目录写入卫生”，而不是“省 token”。**

---

## 9. 四条路线（按侵入性排序）

| # | 路线 | 模型看到什么 | 省多少 | 主要风险 | 适合 |
|---|---|---|---|---|---|
| 0 | 只读整合 | 官方目录不变；`catalog_status`/面板多一块 skills | 0 | 极低 | 先做，建立事实 |
| 1 | 统一搜索 | 官方目录不变；`search_tools` 同时返回 skill 候选，提示 `call skill(name)` | 0 | 低；结果多几行 | 提升发现性，验证需求 |
| 2 | 目录改写/抑制 | 官方目录被替换成分组目录；`search_tools` 补位 | ~7 KB/请求 | 中高：依赖官方消息契约；多一次搜索；路由质量 | 有 A/B 数据后 |
| 3 | 完全接管 | 本插件实现目录 + 工具 + 手势 | 同 2，且可加 whenToUse/分组/策略 | 高：preset、手势、office/card、UI 兼容 | 产品级长期方案 |

补充两条“非接管”选项：

- **组合层拆分**：把 cloudflare / office 这类大簇 skills 移到专用 preset，只让相关会话看见。零代码风险，直接解决“无关 skill”问题。
- **只调官方描述上限**：`catalogDescriptionMaxLength` 是 preset 组合里的配置，本插件无法按 agent 改；强行改 preset 不属于插件行为。

### 路线 2 的两个实现细节

- **抑制**：在 `agent/pre-step` 里过滤掉 `source.kind === "skill-catalog"` 的消息。官方监听器会在每一步重新计算并再次注入（因为它的消息从未 commit，`history.published` 一直为 false），我们每步都要再过滤一次。CPU 可接受，但属于“和官方抢消息”。
- **改写**：保留官方 `source.entries`（digest 不变，官方不会重复追加），只替换 content 文本为分组目录。更省 CPU，但更依赖消息结构；且 UI/其他消费方读 `source.entries` 与文本可能不一致。

两种都建立在一个未文档化的假设上：**官方目录消息的形状与生命周期保持稳定**。对一个要发布到 npm 的插件，这是需要写进兼容性策略的风险。

---

## 10. 建议的下一步

1. **先做 0 + 1（零风险）**：`catalog_status`、面板、`search_tools` 纳入 skills；观察真实会话里 skill 加载频率、目录变更频率、`search_tools` 是否被用于找 skill。
2. **量化再决定 2**：用 A/B 比较“官方扁平目录” vs “分组目录 + 搜索”在 skill 选择准确率、额外调用数、每请求 token 上的差异。没有这个数据，路线 2 只是用路由质量换 ~2k tokens。
3. **把“目录写入卫生”当成独立收益**：如果接管，替换目录不应无限追加；这是官方实现目前的一个真实成本（实测单会话 5 条 / 33 KB）。
4. **不要绕过官方 `skill` 加载**：office / action cards 的激活依赖它；统一搜索只负责发现，加载仍走 `skill(name)`。

### 需要你拍板的三件事

1. **目标排序**：省 token / 选对 skill / 统一面板与搜索 / 按会话控制可见性——哪个是第一目标？
2. **可接受的信息损失**：模型只看“分组摘要 + 搜索”而不是每个 skill 的完整 500 字描述，你能接受吗？
3. **可接受的耦合**：只做官方扩展点以内（0/1），还是允许改写官方目录消息（2），甚至接管消费面（3）？

---

## 11. 证据索引

**源码 / 文档（DSH `0.2.2-rc.2`，Desktop app.asar）**

- `@deepseek-ai/dsh-tool-skill/src/index.ts`
  - 目录可见性身份检查：`apply()` 内 `toolVisible = ctx.tools.get(skillTool.name, agent) === skillTool`
  - 初始/替换目录渲染：`renderCatalogMessage` / `renderCatalogUpdate`
  - digest 与历史扫描：`digestCatalogEntries` / `catalogHistory`
  - 500 字符上限：`DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH`
  - `/name` 手势：`invokedSkillNames` / `SKILL_GESTURE`
- `@deepseek-ai/dsh/docs/subsystems/skills.md`（注册表、provider 契约、rank、invocation、session catalog）
- `@deepseek-ai/dsh/docs/subsystems/tools.md` §`ToolRestriction`（restriction 只作用于继承的全局工具，scope 自己的注册豁免）
- `@deepseek-ai/dsh-skill-filesystem/src/index.ts`（根与 rank：100–600；watcher）
- `@deepseek-ai/dsh-skill/src/index.ts`（`RUNTIME_RANK = 250`、`BUNDLED_SKILL_RANK = 600`、分层合并）
- `@deepseek-ai/dsh-skill-office/src/index.ts`（随包 provider；资产目录；`complete` 语义）
- `@deepseek-ai/dsh-tool-office/src/index.ts`（`skill` 成功调用 / `skill-invocation` 事件解锁 office 工具）
- `@deepseek-ai/dsh-creation-recommendations/src/skill.ts`、`@deepseek-ai/dsh-plugin-recommendations/src/skill.ts`（随包 provider、model-only）
- `@deepseek-ai/dsh-agent-preset/skills/dsh-doc/SKILL.md`（preset `customSkillDirs`）
- `@deepseek-ai/dsh-web-app/presets/{cordis,standard,ptc}.patch.yml`（每个 preset 各自挂 `skill-filesystem` + `tool-skill`）
- `@deepseek-ai/dsh-web-app/cordis.patch.yml`（宿主级 `skill-filesystem` 行禁用，preset 接管）
- `@local/dsh-cloudflare/index.js`（`ctx.skills.register({ name: "cloudflare-integration" })`）

**本机实测**

- 当前会话的 `skill-catalog` 事件：seq 11，21 条，7,974 字符（从 `session.v4.jsonl.zstd` 解出）。
- 长会话 5 条目录消息：6,487 + 6,350 + 6,350 + 6,755 + 7,084 = 33,026 字符。
- 本插件 `catalog_status`：93 个工具、30 常驻、18 组；常驻列表含 `skill`。

**未验证 / 需要实测**

- 路线 2 对 skill 选择准确率的影响（需要 benchmark，不是静态推断）。
- 官方目录消息形状在后续 DSH 版本中的稳定性。
- `agentPresets.register()` 能否让第三方 bundle 提供“不挂 tool-skill”的 preset（`agentPresets` 服务存在 `register(definition)`，但 preset 组合的完整语义尚未验证）。

---

## 附录 A：本机 21 个 skill 清单

统计：21 条；目录消息 7,974 字符；正文行 7,291；平均每条约 347 字符。Cloudflare 簇 14 条，正文行 5,285 字符，占 **72%**。

### A.1 Cloudflare 簇（14 条）

| skill | 来源 | 作用 |
|---|---|---|
| `agents-sdk` | user-agents | 用 Agents SDK 在 Workers 上构建有状态 agent（Workflows、WebSocket、RPC、定时任务、MCP、语音、浏览器自动化）。 |
| `cloudflare` | user-agents | Cloudflare 平台总览：Workers/Pages、KV/D1/R2、Workers AI/Vectorize、Tunnel/Spectrum、WAF/DDoS、Terraform/Pulumi。 |
| `cloudflare-email-service` | user-agents | 收发事务邮件：Email Sending/Routing、SPF/DKIM/DMARC、wrangler email 配置。 |
| `cloudflare-integration` | runtime（@local/dsh-cloudflare） | 本 Harness 的 Cloudflare 集成怎么用：OAuth、Code Mode MCP search/execute、权限范围、何时改用 wrangler/cf CLI。 |
| `cloudflare-one` | user-agents | Zero Trust / SASE：Access、Gateway、WARP、Tunnel、WAN、DLP、CASB、设备姿态。 |
| `cloudflare-one-migrations` | user-agents | 从 Zscaler ZIA/ZPA、Palo Alto、旧 VPN/SWG/SASE 迁移到 Cloudflare One。 |
| `durable-objects` | user-agents | Durable Objects：有状态协调、RPC、SQLite 存储、alarms、WebSocket。 |
| `sandbox-migrate-to-next` | user-agents | 把 Sandbox 应用从 stable `@cloudflare/sandbox` 迁到 `@next`（1.0 preview）。 |
| `sandbox-next` | user-agents | 用 `@cloudflare/sandbox@next` 构建：代码执行、AI runner、CI 任务、终端、文件、mount、tunnel。 |
| `sandbox-stable` | user-agents | 用稳定版 `@cloudflare/sandbox` 构建：commands、sessions、files、ports、tunnels、terminals。 |
| `turnstile-spin` | user-agents | 端到端接入 Turnstile：建 widget、嵌入、服务端 siteverify、验证并持久化。 |
| `web-perf` | user-agents | 用 Chrome DevTools MCP 做 Web 性能审计（LCP/INP/CLS 等 Core Web Vitals）。 |
| `workers-best-practices` | user-agents | 按生产最佳实践审查/编写 Workers 代码（streaming、floating promises、secrets、bindings、observability）。 |
| `wrangler` | user-agents | Cloudflare CLI：部署、开发、管理 KV/R2/D1/Vectorize/Hyperdrive/Queues/Workflows 等。 |

### A.2 DSH 自身（3 条）

| skill | 来源 | 作用 |
|---|---|---|
| `dsh-doc` | preset custom（agent-preset/skills） | DSH 自身：功能、设置、插件、preset、工具、Cordis API；开发/调试 DSH 插件或升级时加载。 |
| `official-plugins` | recommendation provider（model-only） | 用户问“DSH 能不能做 X / 有没有某功能”时，查官方可选插件；不进 `/` 菜单。 |
| `personalized-pages` | recommendation provider（model-only） | 用户要页面/面板/小工具时，规划并提交页面方案；不进 `/` 菜单。 |

### A.3 Office（4 条）

| skill | 来源 | 作用 |
|---|---|---|
| `office` | office provider | 创建/编辑 Office 文件、检查 Office/PDF；加载后下一步解锁 `office_render`/`office_convert`/`office_recalculate`。 |
| `office-docx` | office provider | Word（.docx）创建、读取、编辑、校验。 |
| `office-pptx` | office provider | PowerPoint（.pptx）创建、读取、编辑、校验。 |
| `office-xlsx` | office provider | Excel（.xlsx）读取、创建、编辑、校验，含公式。 |

> 备注：`office` 这类 skill 不只是“读一段说明”，它会解锁工具；`personalized-pages` / `official-plugins` 是 model-only，所以 `/` 菜单里看不到。

---

## 附录 B：竞品的 skills 功能到底在解决什么

> 以下基于本仓库 2026-11-11 的竞品分析（README/文档/公开数据），不是对它们源码的独立验证；它们也都没有公布“skills 单独”的 benchmark。

### B.1 `@kirkchinese/dsh-capability-catalog`

- **做法**：系统提示里常驻一份 `## Capability catalog`，按“来源 → 能力族 → 数量 + 代表名称”列索引；`capability_search`（BM25）、`capability_describe`、`capability_call`；**skill 目录被接管，原生目录不再逐会话发送**；会话级开关 + 输入框左侧能力按钮。
- **公开数据**：REA MCP 207 工具 / 668 KB schema → 索引约 3 KB；首请求 249,653 → 8,404 tokens（−96.6%）。
- **实际意义**：这个数字几乎全部来自 **MCP 工具 schema**，不是 skills。skills 在这里是“第二种 capability”，解决的是“统一发现 + 统一入口 + 少发一点目录”，在 skill 很多时才有明显体感。

### B.2 `@daweifu/capability-menu`（PKUfudawei）

- **做法**：`capability` 是上位概念（tool / skill 两种 kind）；“常驻 / 按需 / 禁用”三档；`meta_search` + `meta_invoke`；按需 skill 不显示在 `<available_skills>`；另有 `catalogFile` YAML；Settings 里 Tools / Skills 两页，可注册 MCP/Skill、从 GitHub 导入。
- **公开数据**：无性能基准；120 star、约 1,019 周下载，是抽样里社区认知最高的。
- **实际意义**：卖点主要是 **“管理”**——让用户看见、分级、开关、导入 skill，而不是省 token。官方 DSH 目前没有这套 UI/策略，所以它填的是产品空白；但“分类靠人工点选”也带来维护成本。

### B.3 共同点与判断

- 两家都把 skills 放进“能力目录”，和 tools/MCP 并列；**skills 是完整性的一环，不是主要节省来源**。
- 真正让这类产品有体感的场景是：**几十到几百个 skill、几十个 MCP 工具、需要按会话控制可见性**。
- 在我们现在 **21 个 skill / 约 2k tokens** 的规模上：
  - 纯省 token：意义不大；而且描述本身就是选 skill 的依据，藏进搜索可能更差。
  - 统一 UI/搜索/可见性：有意义，但那是“管理面板”价值，不是“目录压缩”价值。
  - 竞品对比：这是“功能完整度/定位”问题，不是“性能”问题。把它讲成性能收益会误导用户。

### B.4 规模阈值（按当前平均值粗估）

| skill 数 | 目录约字符 | 约 token（chars/4） | 接管目录的收益 |
|---:|---:|---:|---|
| 21（现状） | 7,974 | ~2.0k | 小；且有路由质量风险 |
| 50 | ~17.5k | ~4.4k | 开始值得考虑 |
| 100 | ~35k | ~8.7k | 分组/搜索的收益明显 |
| 200 | ~70k | ~17k | 值得做目录接管 |

> 结论：**“管 skills 有没有意义”取决于目标用户有多少 skill，以及要的是省 token 还是管理/可见性。** 以我们现在的 21 个，主要价值在后者；如果要做前者，先等规模或先做 A/B。
