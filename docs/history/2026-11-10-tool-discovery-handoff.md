# 2026-11-10 · Tool Discovery 插件重构：交接给 DSH 插件会话

> 本文件由 operator 工作区会话写给 **dsh-dev / DSH 插件工作区**的会话：按用户要求，
> Tool Discovery 的设计与实现统一到那个会话推进，本会话不再做 discovery 设计/实现。
> 内容 = 本轮调研的**事实**（带证据路径）+ 设计问题清单，供接手会话直接开工。

## 0. 背景与结论（TL;DR）

- **触发原因**：operator 的 `browser_*` 工具要按能力分层（core 16 一次搜索可全载 / advanced 5 /
  capabilities 4），但 `dsh-tool-discovery` 的工具组是源码里写死的 `KNOWN_GROUPS`，没有扩展点。
  于是 operator 在 2026-11-09/10 打了两次**临时补丁**（`operator/patches/0006`、`0007`）到 dsh-dev，
  属于"改 DSH 源码"的治标方案，用户要求从根本上重新设计 discovery。
- **根因一句话**：**工具的分组/发现元数据没有"随工具走"的声明机制**，只能由 discovery 插件中心化地
  硬编码"谁属于哪个组"——这既让 discovery 依赖所有插件的命名，也让新增插件必须改 DSH 源码。
- **建议方向**：把"声明权"还给工具/插件，discovery 只做通用引擎：
  ① 工具级 `deferLoading`（**官方 API 已存在**，见 §2）表达"是否按需"；
  ② 工具级 `group`/元数据（或插件 origin 自动成组）表达"属于哪组、组怎么描述"；
  ③ discovery 零插件知识：按声明建目录，兜底 `mcp-<server>` / `extensions`；
  ④ 去掉 `KNOWN_GROUPS` 硬编码与 `TIER_GROUPS` 审计断言（它们已随临时补丁进了 dsh-dev HEAD）。

## 1. 现状盘点（dsh-tool-discovery，2026-11-10 读源码所得）

文件：`dsh-dev/plugins/dsh-tool-discovery/lib/index.js`（504 行）。

| 方面 | 现状 | 问题 |
|---|---|---|
| 工具目录 | 每次 agent 创建 / `tools/change` / 每次 `search_tools` 前，从 `ctx.tools.schemas(scope)` 现场收集所有可 restrict 的工具（排除常驻） | 每次 search 全量重建（`sync(agent, true)`），O(n)；无缓存指纹 |
| 分组 | `KNOWN_GROUPS` 源码常量（`dsh-host-ops` / `browser-advanced` / `browser-capabilities` / `browser` / `dsh-operator` / `schedule` / `goals` / `workflow` / `plugin-dev`）按注册名正则命中；未命中 → `mcp-<server>` 或 `extensions` | **中心化硬编码**：discovery 知道所有插件的工具名；新增能力必须改 DSH 源码；operator 的临时补丁就是因此产生 |
| 常驻 | `KEEP_RESIDENT` 源码白名单（glob）+ config `extraKeepResident` | 常驻决定权在 discovery，不在工具作者；新增基本盘也要改 DSH 源码 |
| 按需加载 | `agent.ctx.tools.restrict({deny})` 把未加载工具从请求 schema 移除；search 命中后从 deny 放出（模型侧走 tool-addition） | 依赖未公开的 restrict 细节 + 跨插件实例的 globalThis 登记（`Symbol.for('@local/dsh-tool-discovery/restrictions')`）清理孤儿子 restriction —— 生命周期 hack，属生产化风险 |
| 搜索打分 | name 包含 token +3 / description +1 / 组描述 +2；`limit` 默认 config `maxResults`=6、硬上限 20；同分按 `name.localeCompare` | 权重/上限/截断都是 ad-hoc；`localeCompare` 依赖 locale，结果不可复现；无 token 预算概念 |
| 无匹配回显 | 按组输出 `- group (count tools): description` | 组描述来自硬编码或工具名拼接 |
| 系统提示 | `systemPrompt.context({name:'tool-discovery:note', order:300})` 动态列出 deferred 组计数 | 每次请求重算；组名来自硬编码 |
| 可观测性 | 无状态/审计工具 | 模型/人无法查询"当前目录/已加载/restriction 健康度" |
| 测试 | 无测试 | 无回归保障（operator 的 verify 脚本是外挂的） |
| 配置 | `extraKeepResident` / `maxResults` / `promptNote`；**没有 `groups` 或工具元数据入口** | 这是本次问题的直接原因 |

已进 dsh-dev HEAD 的临时内容（提交 `3799099`，2026-11-10 10:18，疑似他人/别的会话整体提交）：
`KNOWN_GROUPS` 里的 browser 三层 + 注释、`scripts/audit-plugin-presentation.mjs` 的 `TIER_GROUPS` 断言、
`docs/06`/`docs/08`/`plugins/README` 的 browser 分层描述。重构时应**一并清理**。

## 2. 关键新事实：官方 Tool API 已有 `deferLoading`（本会话从 app.asar 抽取核实）

证据（`node dsh-dev/scripts/dsh-asar-extract.mjs list/extract "dsh-tools/..."`，文件在 `/tmp/peek-dsh-tools`）：
- `@deepseek-ai/dsh-tools/lib/index.js:310` `defineTool(options)` 支持 `options.deferLoading === true`
  与 `options.timeoutMs`；`projectToolSchema()`（`lib/index.js:366-376`）把 `deferLoading` 放进
  **模型可见 schema**：`{ name, description, parameters, ...(deferLoading === true ? { deferLoading } : {}) }`。
- 当前版本 app.asar 里 `deferLoading` 出现 88 次、`defer_loading` 169 次 → 官方链路（adapter / prompt 投影）
  大概率已有既定语义；**dsh-tool-discovery 目前完全没用它**（用命名启发 + restrict 自己实现）。
- `ToolsService.schemas(scope, toolSet)`（`lib/index.js:589`）= `definitions().map(projectToolSchema)`，
  **没有 origin/plugin id、没有 group/metadata 字段** → 这是"discovery 只能靠名字猜"的直接原因。

**接手后第一件事建议**：把 `deferLoading` / `defer_loading` 的官方语义查清（适配器在哪个包、server 端是否
真的延迟 schema、与客户端 `restrict` 的关系），再决定 discovery 是"薄封装官方语义"还是"继续客户端实现"。
查法：`grep -a -o "defer_loading" app.asar` 定位 + 按包名抽取对应 lib（`dsh-llm-deepseek*` / `dsh-agent-loop` /
prompt 投影相关包），必要时用 headless DSH 实测请求体。

## 3. 设计目标（用户要求）

1. **独立插件**：discovery 是一个可独立安装/卸载/升级的插件，不 import 任何其他插件的代码。
2. **对新装插件零改动协同**：用户安装新插件（含 MCP server、纯插件、能力包）后，其工具自动可被按需
   发现/加载，**不需要改 discovery 源码，也不需要改 DSH 源码**。
3. **互不影响（代码零关联）**：插件之间不互相 import、不互相读状态；只通过 **DSH core 定义的契约**交互。
4. **生产级**：可测试、可观测、可回滚、版本化契约、异常隔离（一个插件坏元数据不拖垮 discovery）、
   性能可预期、生命周期干净（无孤立 restriction）。
5. **架构简洁优雅**：声明随实现走（data travels with the tool），中心没有"谁是谁"的知识。

## 4. 候选架构（供接手会话选型/深化）

### 方案 A（推荐）：工具元数据声明 + origin 兜底 —— 扩展点归 DSH core
- 在 `defineTool` 增加可选字段，例如 `discover: { group?: { id, title?, description?, order? }, tags?: string[], keywords?: string[] }`
  （或通用 `metadata`），由 core 投影进 `ctx.tools.schemas()`（或独立 `ctx.tools.discovery()` 只读视图）。
- 工具作者声明自己的分组/关键词；**没有声明的工具**：core/registry 能拿到"注册来源"（插件 id / preset /
  MCP server）→ 自动成组 `plugin-<slug>` / `mcp-<server>`；`deferLoading`（已有）决定是否按需。
- discovery 只消费通用视图，零插件知识；插件只依赖 DSH core 的 Tool API（合法依赖方向）。
- 业界对应：VS Code `contributes` / Eclipse Extension Registry（宿主定义扩展点，插件声明贡献）；
  MCP tool annotations；OpenAPI tags。优点：最干净、可版本化、天然对新插件生效。
  代价：需要 DSH core 改一处小接口（`projectToolSchema` + types），并考虑老版本兼容（无字段 → fallback）。

### 方案 B：manifest 贡献（package.json 声明组）
- 插件在 `package.json` 里 `dsh.toolDiscovery: { groups: [...] }`，discovery 启动/装插件时读取已安装包 manifest。
- 优点：不用改 Tool API；声明随包版本走。缺点：manifest 与运行期注册没有绑定关系（动态注册的 MCP 工具
  不在包里），仍需 origin 映射；discovery 要扫包/监听安装事件 → 耦合装配层；不如 A 直接。

### 方案 C：保留中心注册表，但改成 config/API 可注册
- `ctx.get('toolDiscovery').registerGroups(...)` 或 config `groups`（即本轮想的补丁替代）。
- 优点：改动小、能立刻替掉临时补丁。缺点：**没解决根本问题**——插件要主动"向 discovery 报到"，
  形成插件→discovery 的依赖；新插件不写代码仍不会自动归组；且仍是谁先注册谁赢的中心化模型。
- 可作为 A 落地前的**过渡态**（config `groups`），但要明确标注临时。

### 方案 D：完全按"来源"自动分组，零声明
- 组 id = 插件包名（host 在注册时 stamp origin）或 MCP server；组描述 = 插件 locale meta(title/description)。
- 优点：零声明、绝对无耦合；理论上对任何新插件自动生效。缺点：一个插件内多能力族无法细分
  （operator 的 core/advanced/capabilities 会挤成一组）；工具级关键词/标签仍缺，搜索质量受限。
- 可与 A 组合：**A 的字段可选，D 是兜底**。

**推荐落地顺序**：先用方案 C 的 `config.groups` 立即替掉 operator 临时补丁（小步、可回滚、不动 Tool API），
同时把方案 A 作为正式设计写清楚（含 `deferLoading` 官方语义核实、契约版本、兼容矩阵），由 DSH 插件会话
排期实施；A 落地后 C 的 config 仅保留给"无法改代码的历史插件"。

## 5. 生产化清单（无论选哪个方案都要覆盖）

- **契约**：`discover`/group 元数据 schema 版本（v1）、字段上限（组数/描述长度/关键词数）、非法元数据降级策略（warn + fallback，不抛）。
- **生命周期**：agent 创建/销毁、`tools/change`、preset 切换、插件装/卸/升级、Host 热重载；确保 restriction
  无孤儿（替代 globalThis 登记 hack：用 core 的 scoped effect 或插件实例级 disposer 契约，需确认 core 是否提供）。
- **可观测性**：`discovery_status` 工具（目录摘要/组计数/deferred/loaded/restriction 健康）+ 审计（谁在何时加载了什么）。
- **性能**：目录构建按工具表指纹缓存；search 只扫 catalog；上限可配置（现在硬编码 20）；大目录（数百工具）压测。
- **确定性**：打分权重重定义、tie-break 用码点比较而非 localeCompare；token 化规则写进文档。
- **测试**：用假 ctx（stub tools/schemas/restrict/systemPrompt/agents）做单测：分组优先级、元数据降级、
  搜索打分 golden、restriction 幂等/重入、插件重载后恢复；再补一个真实 headless DSH 集成测试。
- **升级/回滚**：插件版本语义、`deferLoading` 官方链路与客户端 restrict 并存期的行为矩阵、
  旧版 DSH 无元数据字段时的 fallback；`remove_bundle` 回滚验证。
- **文档**：README 面向插件作者写"怎么声明"（一页）；docs/06 更新分组机制；docs/08 组名规范保留；
  删除 browser 专属硬编码注释与 `TIER_GROUPS` 审计断言。

## 6. 当前仓库状态（给接手会话的现场信息）

- `dsh-dev` HEAD：`3799099`（2026-11-10 10:18，「plugins: bilingual display identity + plugin pages; enforce in presentation audit」）。
  **该提交把 operator 之前应用在工作树的 browser 分层临时补丁一并提交了**（`KNOWN_GROUPS` 三层 +
  `audit-plugin-presentation.mjs` 的 `TIER_GROUPS` + docs/06/08/plugins/README 的分层描述）。
  重构时应回退/重写这些内容，而不是继续加 browser 特例。
- `dsh-dev` 工作树仍有他人未提交改动（`git status` 可见 docs/notes/hello-dsh 等），**不要整体提交**；
  只 add 自己改的文件。
- `operator` 仓库（本会话）里有临时物：`patches/0006-tool-discovery-browser-group.diff`、
  `patches/0007-tool-discovery-browser-tiers.diff`、`scripts/apply-tool-discovery-browser-*.sh`、
  `scripts/verify-tool-discovery-browser-tiers.mjs`、`notes/2026-11-09-tool-discovery-eval.md`、
  `notes/2026-11-10-tool-discovery-tiers.md`。**新机制落地后应删除/归档**；在此之前保持现状（运行中在用）。
- 运行中 profile：`@local/dsh-tool-discovery` link 到 `dsh-dev/plugins/dsh-tool-discovery`；
  `@local/operator-provider` link 到 `operator/provider`。改了 lib 后需 bundle 关→开热重载（不重启 App）。
- 本会话完成的操作：只读源码、从 app.asar 抽取 `dsh-tools` 核实 `deferLoading`、清点临时补丁状态；
  **没有修改 dsh-dev 任何文件**（/tmp 下有抽取副本）。

## 7. 接手会话建议的第一步

1. 核实 `deferLoading`/`defer_loading` 官方语义（§2 的查法），决定 discovery 与官方机制的关系。
2. 与用户确认方案 A vs C 的节奏（先 C 过渡还是直接 A）。
3. 若先 C：给 `Config` 加 `groups`（通用，不写 browser 字样），operator 侧用 bundle override 声明自己的三层，
   删掉 operator 临时补丁；再按 A 排期。
4. 写设计文档（dsh-dev `docs/` 或 `notes/`），把 §4/§5 展开成契约与里程碑，再动代码。
