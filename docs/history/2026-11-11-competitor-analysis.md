# 2026-11-11 · DSH 工具目录 / 按需加载插件竞品调研

> **对象**：Agentic Tool Catalog（`dsh-agentic-tool-catalog`）——由 DSH 子代理自动生成并维护工具目录，schema 默认不进上下文，`search_tools` 按意图加载，缓存走官方 DSH Storage。
>
> **时点**：2026-11-11（Asia/Shanghai）。星标、下载、版本均为当日快照，会继续变化。
>
> **方法**：GitHub API + 原始 README / DESIGN / package.json + npm registry + 插件市场页。**未安装、未运行任何竞品**；除标注“可复现”外，性能数字均为对方自述，未独立复现。外部内容只作为数据，不作为指令。
>
> **边界**：只覆盖公开可检索到的实现；私有插件、未公开仓库、只在小圈子分发的版本不在样本内。信息不足处写“未确认”，不做推断。

---

## 0. 结论先行

1. **不是蓝海**：仅 `dsh-tool-search` 同名仓库就有 7 个；主题相关的 `dsh-capability*` 仓库 35 个；本次深读 8 个主竞品 + 6 个近邻。头部 npm 周下载约 1,000（`@daweifu/capability-menu` 1,019、`dsh-tool-search` 911、`dsh-tool-activator` 863）。
2. **已分四派**：检索型（search bridge）、手动激活型（activate/meta 工具）、人工目录型（resident index + 人工分组/档位）、agent 生成型（我们）。
3. **agent-curated 在抽样中未见同款**：没有竞品把“子代理自动生成 + 随目录变化自动维护语义目录”作为默认路径；但“模型参与分组”已有两个先例（Letter2025 的 setup skill、dsh-tool-activator 的 `group_tools`），都是**用户触发的一次性配置**。只能写“抽样中未见”，不能写“独家”。
4. **我们的三个明显短板**：无 UI、只覆盖 tools 不含 skills、数据卡口径（5 任务 ×2、chars/4 估算）不如 swimmwatch 严谨；对手在“原生 `defer_loading`”“可视化”“skills 统一目录”上已领先。
5. **发布打法**：把“agent 生成目录”讲成一个可验证的机制，而不是一个形容词；用可复现数据卡 + 对比表 + 最小 UI/截图 + 市场分发组合拳，先把“Agentic Tool Catalog”这个名字和“agent-generated catalog”这个品类绑定。

---

## 1. 市场概览

### 1.1 赛道规模（抽样）

| 产品 | 仓库 | npm 周下载 | Stars | 一句话定位 |
|---|---|---:|---:|---|
| `dsh-tool-search`（Letter2025） | [GitHub](https://github.com/Letter2025/dsh-tool-search) · [npm](https://www.npmjs.com/package/dsh-tool-search) | 911 | 14 | Hermes 风格渐进披露 + rerank 语义搜索 |
| `@swimmwatch/dsh-tool-search` | [GitHub](https://github.com/swimmwatch/dsh-tool-search) · [npm](https://www.npmjs.com/package/@swimmwatch/dsh-tool-search) · [插件页](https://www.dshplugin.store/plugin/swimmwatch/dsh-tool-search) | 264 | 1 | BM25 + 可选 Ollama/OpenAI embedding 的工具搜索 |
| `@anionex/dsh-tool-search` | [GitHub](https://github.com/Anionex/dsh-tool-search) · [npm](https://www.npmjs.com/package/@anionex/dsh-tool-search) · [插件页](https://dshmp.com/en/plugins/anionex-dsh-tool-search) | 13 | 0 | Codex 风格延迟加载 + 本地 BM25 |
| `dsh-tool-search`（lordqyxz） | [GitHub](https://github.com/lordqyxz/dsh-tool-search) · [插件页](https://dpharness.com/plugin/lordqyxz/dsh-tool-search) | 无独立包 | 0 | 厂商式延迟加载：名称/用途常驻，schema 按需 |
| `dsh-tool-activator`（Tranquillitatis-Lab） | [GitHub](https://github.com/Tranquillitatis-Lab/dsh-tool-activator) · [npm](https://www.npmjs.com/package/dsh-tool-activator) | 863 | 12 | 基础工具常驻 + `activate_tools` + `<available_tools>` 目录 |
| `dsh-mcp-lens`（labmimors） | [GitHub](https://github.com/labmimors/dsh-mcp-lens) · [npm](https://www.npmjs.com/package/dsh-mcp-lens) · [计算器](https://labmimors.github.io/dsh-mcp-lens/) | 290 | 12 | 1,000 个 MCP 工具藏在 `mcp_search` / `mcp_call` 两个接口后 |
| `@kirkchinese/dsh-capability-catalog` | [GitHub](https://github.com/kirkchinese/dsh-capability-catalog) · [npm](https://www.npmjs.com/package/@kirkchinese/dsh-capability-catalog) | 531 | 5 | MCP + skills 的统一懒加载能力目录 |
| `@daweifu/capability-menu`（PKUfudawei） | [GitHub](https://github.com/PKUfudawei/dsh-capability-menu) · [npm](https://www.npmjs.com/package/@daweifu/capability-menu) · [插件页](https://dshbase.com/plugins/dsh-capability-menu/) | 1,019 | 120 | tools/skills 三档暴露策略 + 按需检索调用 |

**近邻（未逐一深读，仅凭仓库描述）**：`degraw4/dsh-tool-discovery`（22★，PTC 渐进式参数文档 + 78 工具评估）、`everclear077/dsh-progressive-tools`（13★，稳定小表面 + 可搜索目录）、`Yan-Zero/dsh-progressive-tools`（4★，presentation-only）、`KouzakiUmi/dsh-tool-discovery`（3★，`tool_list`/`tool_search`/`tool_load`）、`pan17/dsh-tool-manager`（按 preset 开关/分组）、`vibeinging/dsh-tool-search`（1★，per-agent 按需发现）。

**规模判断**：真正有文档、有发布、有下载的同类约 **8–10 个**；把同名/近名/换皮仓库都算上，仅 `dsh-tool-search` 名称就有 7 个（Letter2025、swimmwatch、LAKSPROVI、lordqyxz、vibeinging、Anionex、ZHIRUOANHAO 的修复版）。`dsh-capability*` 名称 35 个，但主题更宽（开关、面板、审计、路由、网关都有），不能全部算作本赛道。

### 1.2 四个派别

| 派别 | 解决的问题 | 发现方式 | 目录/分组来源 | 代表 |
|---|---|---|---|---|
| **检索型** | 模型不知道有哪些长尾工具 | `search` 桥接工具，按 query 返回命中 | 从实时注册表建索引；分组多为可选的人工配置 | Letter2025、swimmwatch、Anionex、lordqyxz、mcp-lens |
| **手动激活型** | 模型先知道名字，再决定是否加载 | `<available_tools>` 清单 + `activate_tools` / `meta_invoke` | 配置里的常驻/按需/禁用档位 | dsh-tool-activator、PKU capability-menu |
| **人工目录型** | 想让模型“知道有什么”，但不想全量塞 schema | 常驻一段人整理/模式归类的索引 | 人工能力族、名称模式、server `_meta`、always-available 列表 | kirkchinese、PKU、swimmwatch（部分） |
| **agent 生成型** | 人工分组维护不动，且不想引入外部检索服务 | 常驻目录 + `search_tools` 按意图加载 | **DSH 子代理读取工具表、按意图写组**，校验后持久化并增量维护 | **我们（Agentic Tool Catalog）** |

> 边界不硬：kirkchinese 同时有 resident 索引和 BM25 检索；PKU 同时有档位和 `meta_search`；swimmwatch 同时有 always-available 列表和 BM25/embedding。上表按“主机制”归类。

### 1.3 三个结构性事实

1. **命名与包名碰撞严重**。npm 的 `dsh-tool-search` 归 Letter2025；swimmwatch 被迫改用 scope 并在 README 里专门警告“unscoped 包属于另一个项目”；lordqyxz 的仓库 `package.json` 也叫 `dsh-tool-search@0.1.0`，但 npm 同名包已归别人，dpharness 直接标注“装到的可能不是本插件”，实装验证未通过。**新插件必须用 scope 或唯一名。**
2. **DSH 版本分裂成两代**。Anionex 只支持 `0.1.1-rc.1`–`0.1.5-rc.1`，mcp-lens 的 npm rc.9 面向 `0.1.0-rc.6`；kirkchinese 只支持 `0.2.1-rc.2`–`<0.2.2`，swimmwatch 要求 `0.2.1-rc.2`，我们在 `0.2.2-rc.1`。版本兼容性本身就是卖点，也是淘汰对手的硬门槛。
3. **营销成熟度差异极大**。kirkchinese 有 60 秒宣传片、token 图、对比表；mcp-lens 有交互式计算器；swimmwatch 有 201 用例的基准方法学；Letter2025（下载 911/周）几乎只有 README + 徽章。**下载量不完全跟物料成正比**，但物料决定“能不能被引用/转发”。

---

## 2. 竞品卡片

### 2.1 `dsh-tool-search`（Letter2025）— Hermes 式渐进披露

- **链接**：[GitHub](https://github.com/Letter2025/dsh-tool-search) · [npm](https://www.npmjs.com/package/dsh-tool-search) · [DESIGN.md](https://github.com/Letter2025/dsh-tool-search/blob/main/DESIGN.md)
- **一句话**：把长尾工具折叠到 `tool_search` / `tool_describe` / `tool_call` 三个桥接工具后，核心工具保持直通，用配置的 rerank 模型做语义搜索。
- **机制**：每轮在 `system-prompt/assemble` 瀑布里按目录大小选 Tier 0–3；Tier 1 给“桥 + 分组名称/描述清单”，Tier 2 只给名称，Tier 3 只给每组一行摘要。预算 = `min(thresholdPct% × contextWindow, listingMaxTokens)`。搜索/描述/调用会命中工具“warm”进会话可见集（LRU 上限 8），下一轮起直接可见。
- **上下文策略**：清单挂 `runtime context`（不是 section），避免被 complete prompt 覆盖；桥接工具、`skill`、管理工具永远 eager；PTC 作用域重渲染 `tools:sdk`，不改宿主工具表。
- **目录/缓存**：分组、matcher、preload、core 存在 `~/.dsh/dsh-tool-search.json` 或 `<workspace>/.dsh/dsh-tool-search.json`（按 mtime 热重载）；**没有目录缓存**，每轮从 `ctx.tools.schemas()` 重建。
- **覆盖/UI/skill**：覆盖所有注册工具（含 MCP）；有 `tool-slimmer-setup` 技能（对话式分组 + rerank 配置）；**无 UI**（DESIGN 把 Web UI 状态显示列在 v0.2.0）。
- **安装/License**：`dsh plugin --profile web add dsh-tool-search`；MIT；适配 DSH `0.2.2-rc.1`（README 记录 rc.3–rc.1 的接缝变化）。
- **物料**：README 徽章 + 中英双语 + DESIGN.md；仓库无 `assets/`，README 无截图、无视频、无数据图表。
- **数据声明**：**没有自测数据卡**。DESIGN 只引用 Hermes 的案例（“Cloudflare 单个 MCP 的纯名称约 32K token”），不是本插件实测；也没有 token/质量对比表。
- **优点**：分级披露是竞品里最完整的（目录越大越省）；语义检索走 rerank，理论上比 BM25 更抗词汇差异；桥接调用走真实工具名，审批/守卫/事件不串味；支持项目级配置；有对话式 setup skill；下载量第二（911/周，仅次于 PKU 的 1,019），曝光度较高。
- **弱点**：强依赖外部 rerank 端点与 API key（成本、隐私、可用性）；无 matcher 时退化为关键词，DESIGN 写“不做本地 BM25，用户判定效果差”；无 UI、无基准、无目录缓存；分组是“模型提案 + 用户确认”的一次性配置，不随工具变化自动维护。

### 2.2 `@swimmwatch/dsh-tool-search` — BM25 + 可选 embedding 的工程派

- **链接**：[GitHub](https://github.com/swimmwatch/dsh-tool-search) · [npm](https://www.npmjs.com/package/@swimmwatch/dsh-tool-search) · [插件页](https://www.dshplugin.store/plugin/swimmwatch/dsh-tool-search)
- **一句话**：保留一小撮 always-available 工具，其余用 `tool_search` 发现、`tool_unload` 卸载；默认 BM25，可选 Ollama/OpenAI 兼容 embedding。
- **机制**：`tool_search`（默认 hybrid、3 条、最多 5 条）从内置/插件/MCP 工具中检索；命中后“下一个模型 step”拿到原始 schema；`tool_unload` 移除；每个 agent 最多额外加载 16 个。空 query 返回紧凑清单；精确名搜索不走向量。
- **上下文策略**：常驻可配置（默认 39 个文件/工作流/后台/调度/目标/agent 工具）+ 两个固定工具；加载是“下一步生效”，不是本轮替换；支持 native 与 PTC preset。
- **目录/缓存**：无分组/无目录；向量缓存存 `$DSH_HOME/cache/dsh-tool-search`（只存 hash + 向量，不存 query/原始目录/key）。
- **覆盖/UI/skill**：内置 + 插件 + MCP 工具；**有设置页**（always-available 列表、embedding provider/model/key）；无 skill。
- **安装/License**：`dsh plugin --profile web add @swimmwatch/dsh-tool-search@latest`；Apache-2.0；要求 DSH `0.2.1-rc.2`、Node 24；支持从 GitHub Release 下 `.tgz` + SHA256 校验。
- **物料**：`assets/settings-light.png` 设置页截图；`benchmarks/` 完整方法学；`docs/reference.md`、`public-contract.md`；`screenshots.json`；无视频、无数据图表。
- **数据声明**：**最严谨的一个**。201 用例 / 17 fixtures / 5,000 工具规模；quality、metamorphic、scale、native、PTC、retrieval-contracts 六套；2,000 ms 首查预算；报告写明“不推断整任务 token/成本节省，需要单独的匹配评估”；可 `npm run benchmark` 复现，但明确是检索基准、不是完整模型对话。
- **优点**：工程化最强（CI、CodeQL、secret scan、SemVer、Keep a Changelog、迁移指南、SHA256）；诚实声明边界，反而更可信；BM25 全本地、无外部依赖；embedding 可选；设置页成熟；Apache-2.0 对企业友好。
- **弱点**：没有目录/分组，模型不知道“有哪些”，只能搜；默认 39 个常驻工具偏多；每个 agent 16 个上限可能不够；语义检索要用户自己装 Ollama 模型或配 API；无 skills 覆盖；下载 264/周，声量小于 Letter2025。

### 2.3 `@anionex/dsh-tool-search` — Codex 式延迟加载

- **链接**：[GitHub](https://github.com/Anionex/dsh-tool-search) · [npm](https://www.npmjs.com/package/@anionex/dsh-tool-search) · [插件页](https://dshmp.com/en/plugins/anionex-dsh-tool-search)
- **一句话**：Codex 风格的 deferred tool loading：核心工具 + `tool_search`，本地 BM25 Top-5，选中后下一轮拿到完整原生 schema。
- **机制**：默认核心约 20 个（`apply_patch`、`bash`、`subagent`、`workflow` 等）；其余可搜索但初始不显示；`neverSearch` 同时隐藏初始面与搜索语料；搜索文档 = 工具名、下划线转空格、描述、递归 schema 描述；BM25 `k1=1.2, b=0.75` + 英文停用词 + Porter2；精确名固定第一；每 agent 的已选集合单调增长，resume/fork 从历史恢复。
- **上下文策略**：只过滤 `assembly.tools` 和 `tool:<name>` 指引段，不注销、不 `restrict`；native/PTC/both 三种展示都处理，PTC 下重生成 `tools:sdk`。
- **目录/缓存**：无目录；索引从 scoped registry 构建，注册表变化让缓存失效。
- **覆盖/UI/skill**：内置 + 插件 + MCP 工具；**有 Web 设置页**（结果数、常驻白名单、搜索黑名单、可筛选的实时工具表 + 逐工具策略）；无 skill。
- **安装/License**：`dsh plugin --profile web add @anionex/dsh-tool-search`；MIT；**只支持 DSH `0.1.1-rc.1`–`0.1.5-rc.1`**，不兼容 0.2.x。
- **物料**：README 中英双语 + `docs/benchmark-results.json`；README 无截图/视频；插件页标 “Verified / Web UI”。
- **数据声明**：token 表（10/30/50/100 个延迟工具，初始减少 94.3%–99.4%，加载 Top-5 后 1,013 tokens）；用 `gpt-tokenizer` `o200k_base`；JSON 记录包版本、生成器/语料 SHA-256、fixture、tokenizer；**明确说明应用总量还要加核心 schema 与系统提示**；可复现（`scripts/benchmark.mjs`）。
- **优点**：对 Codex 的对照做得最细（字段顺序、递归 schema、BM25 参数、差异表）；确定性、无外部依赖；每 agent 隔离、resume/fork 恢复考虑周全；PTC 处理细致；有设置 UI；token 数据可复现。
- **弱点**：**版本停在 0.1.x，当前 DSH 0.2.x 用不了**（最大硬伤）；纯英文 BM25，无语义/多语言；无目录、无 skills；下载 13/周、0 star，社区反馈很少；搜索结果不含 schema，必须多一轮才能调用。

### 2.4 `dsh-tool-search`（lordqyxz）— 厂商式延迟加载

- **链接**：[GitHub](https://github.com/lordqyxz/dsh-tool-search) · [插件页](https://dpharness.com/plugin/lordqyxz/dsh-tool-search)
- **一句话**：复刻“提供商托管工具搜索”的延迟加载：每个工具只常驻“名称 + 截断用途”，`tool_search` 返回完整 schema，发现后直接调用。
- **机制**：系统提示里每个可延迟工具一行；`tool_search` 用精确名加权 + 紧凑 BM25（支持 CJK 二元分词）；一次搜索只解锁返回的工具名，不解锁整族；`requireDiscovery` 守卫拒绝未发现工具的直接调用并提示先搜索；可延迟工具数低于阈值（默认 15）时完全惰性。
- **上下文策略**：常驻目录区按“注册表不变则字节稳定”设计；`run_code` 传输豁免延迟和守卫；发现状态事件溯源（搜索结果 presentation meta 携带累积发现列表），重建 agent 时从会话日志恢复。
- **目录/缓存**：无持久目录/无磁盘缓存；状态在会话事件里。
- **覆盖/UI/skill**：所有注册工具；**无 UI、无 skill**。
- **安装/License**：`package.json` 名为 `dsh-tool-search@0.1.0`，但 npm 同名包归 Letter2025，**不能按 npm 名安装**；dpharness 显示“从 GitHub 源安装”，实装验证未通过（unknown）；MIT；未声明 `dsh` 版本约束。
- **物料**：README + `bench/run-benchmark.mjs` + `tests/efficiency.spec.ts`；README 无截图/视频；无 UI。
- **数据声明**：15/30/60/120 个合成工具，常驻节省 67.8%–76.6%；单次搜索 755–756 tokens；**1 次搜索回本**；Top-1（精确名）100%、R@5（同义改写）100%；搜索延迟 108–986 µs；可用 `pnpm run bench` 复现，但语料是合成的、只测词法检索。
- **优点**：中文分词（CJK bigram）在竞品里少见；常驻目录“字节稳定”对前缀缓存友好；事件溯源恢复；守卫设计能防“未发现直接调用”；数据表小而完整，有回本分析。
- **弱点**：无 UI/无 skill/无缓存；只支持词法，同义改写靠描述质量；与 npm 包重名导致安装体验差；dpharness 实装验证失败；最近提交 2026-09-30；0 star、无社区。

### 2.5 `dsh-tool-activator`（Tranquillitatis-Lab）— 手动激活派的代表

- **链接**：[GitHub](https://github.com/Tranquillitatis-Lab/dsh-tool-activator) · [npm](https://www.npmjs.com/package/dsh-tool-activator)
- **一句话**：默认只加载 8 个基础工具，其余用 `activate_tools` 按需激活；模型始终能看到 `<available_tools>` 简述目录。
- **机制**：基础工具 `read/glob/grep/write/edit/skill/ask_user_question/todo_write`（可关，但 `activate_tools` 不可关）；其余工具以 `<available_tools>` 注入（identifier/name/一句描述）；已激活的只保留 identifier + 成员名；`autoGroupMcp` 把 `mcp__server__tool` 聚成 `mcp.server`；`requireApproval` 控制审批。
- **上下文策略**：路由支持对话中途变更工具时（`deepseek-flash` 等，模型目录的 `toolUpdate`），把**全部**工具一次性声明、其余标 `defer_loading`，激活只追加 `tool_addition`，**不重写请求头**，前缀缓存保持有效；不支持的路由退回“按激活状态过滤声明列表”。
- **目录/缓存**：分组写在插件配置的 `groups` 字段，与配置页“工具分组”同一份文档；`group_tools` 可让模型增/改/删分组，但**只在用户明确要求时**调用；激活状态随标准会话日志和 seed 恢复。
- **覆盖/UI/skill**：所有工具，含 MCP 聚合；**有配置页**（默认激活/按需开关、`requireApproval`、`autoGroupMcp`、分组结构化编辑器）；无 skill；无检索。
- **安装/License**：`dsh plugin --profile web add dsh-tool-activator`；MIT；要求 DSH ≥ `0.2.0-rc.2`、Node ≥ 22.19；npm 元数据仍指向 `hairyf/dsh-tool-activator`，GitHub 会把该地址重定向到 `Tranquillitatis-Lab/dsh-tool-activator`（账号/仓库改名）。
- **物料**：`public/hero.png`、README 内嵌配置页截图、`docs/verification.md`、`icon.svg`；无视频、无数据图表。
- **数据声明**：**无性能数据**；只写“12 个文件、304 个用例全部通过；lint/类型/Build 通过”，并自述“真实 GUI E2E、打包发布及真实 profile 验证未做”。
- **优点**：最“原生”的一条路——用 `defer_loading` + `tool_addition`，激活不破坏前缀缓存；配置 UI 和分组编辑器完整；MCP 聚合实用；`group_tools` 让模型参与整理（用户触发）；304 个用例、类型/构建齐全；下载 863/周。
- **弱点**：没有检索，工具多时 `<available_tools>` 本身会膨胀，模型要“先读清单再点名”；激活需要额外一次工具调用；分组默认人工维护/用户触发，不自动；无 skills 目录；README 自述 GUI E2E/打包未验证；无性能数据。

### 2.6 `dsh-mcp-lens`（labmimors）— 1,000 个 MCP 工具，两个接口

- **链接**：[GitHub](https://github.com/labmimors/dsh-mcp-lens) · [npm](https://www.npmjs.com/package/dsh-mcp-lens) · [Schema 计算器](https://labmimors.github.io/dsh-mcp-lens/) · [DSH Directory](https://dsh.directory/plugins/labmimors/dsh-mcp-lens)
- **一句话**：`mcp_search` 找工具并返回精确 input schema，`mcp_call` 调用 `server/tool` 并保留结构化结果；两个工具定义固定 1,114 字节。
- **机制**：只覆盖 MCP；按需建立连接、缓存目录（`cachePath`，TTL 24h）、`allowTools`/`denyTools` 通配、分页/超时/字节上限齐全；搜索命中后 schema 进入对话；重复搜索复用索引；失败刷新保留上一份可用目录，单 server 故障不影响其他 server。
- **上下文策略**：常驻只有两个 schema（1,114 B），与目录大小无关；远程 schema 在 search 返回时才进入上下文；空闲 5 分钟断开连接。
- **目录/缓存**：`servers` 配置 + `cachePath` 目录 JSON；`cacheNamespace` 隔离账号/权限；无分组/无 skills。
- **覆盖/UI/skill**：**MCP only**（native 工具不覆盖）；无 DSH UI；有独立 Web “schema calculator”（可粘贴工具定义、算常驻体积、生成分享链接/Markdown/卡片）。
- **安装/License**：npm `dsh-mcp-lens@0.1.0-rc.9`（面向 DSH `0.1.0-rc.6`），rc.10 需从源码 build；要求 Harness `0.1.2-rc.1`；MIT + 单独 EULA（明确不缩小 MIT）+ PRIVACY/SECURITY/SUPPORT。
- **物料**：`assets/mcp-lens-overview.svg` 概览图、交互式计算器、`docs/PRODUCT_TESTS.md`、`docs/LIVE_DEEPSEEK_PILOT.md`、`docs/RETRIEVAL_EVALUATION.md`；无视频。
- **数据声明**：1,000 工具 fixture：直接客户端定义 647,962 B vs Lens 1,114 B；数据流任务 12/12（修复前 10/12）；3 个 Codex 任务 16 工具：Lens 3/3 vs 官方直连 2/3；178 个自动测试；有产品测试文档和复现命令。**口径是字节数与合成/真实 MCP 任务，不是通用模型 benchmark。**
- **优点**：最会“做物料”——计算器让用户用自己的目录算账；字节数对比极强；MCP 连接管理/缓存/限额做得深；结构化结果保留（多步工作流）是真实痛点；文档/法务/安全齐备。
- **弱点**：只做 MCP，native/插件工具完全不管；npm 版本停留在 0.1.x，安装要 build，体验差；无分组/无 skills/无 DSH 内 UI；自己管 MCP 连接，和官方 MCP 客户端是竞争关系；OAuth/Resources/Prompts 未实现；检索算法未在 README 说明（未确认）。

### 2.7 `@kirkchinese/dsh-capability-catalog` — MCP + skills 的懒加载目录

- **链接**：[GitHub](https://github.com/kirkchinese/dsh-capability-catalog) · [npm](https://www.npmjs.com/package/@kirkchinese/dsh-capability-catalog)
- **一句话**：常驻一份几 KB 的分组索引，MCP 工具与 skills 共用 `capability_search` / `capability_describe` / `capability_call` + `skill`。
- **机制**：系统提示里 `## Capability catalog` 按“来源 → 能力族 → 数量 + 代表名称”列索引；`capability_search` 用 BM25（拆 snake_case、中文二元组）或 `family` 浏览；`capability_describe` 对 >6 KB 的 schema 返回紧凑签名 + JSON Pointer，用 `path` 展开；`capability_call` 用原始 schema（Ajv，2020-12）校验后转发 MCP；skill 目录被接管，原生目录不再逐会话发送。
- **上下文策略**：索引逐字节稳定、前缀缓存友好；工具数组整场会话不变（避开“会话中途追加工具导致 400”）；MCP 工具清单落盘，启动不拉起 server，`capability_call` 才连接，空闲 5 分钟断开。
- **目录/缓存**：`mcp-<name>.json`（键为命令/参数/环境/URL 哈希）、`toggles.json`（最多 500 会话覆盖）、`cacheDir`；人工 `families` + 未匹配按名称自动分组 + server `_meta.family`。
- **覆盖/UI/skill**：MCP + skills；**有设置卡片 + 输入框左侧“能力”按钮**（会话级默认/开/关，徽标显示关闭数）；无插件工具（路线图）。
- **安装/License**：`dsh plugin --profile web add @kirkchinese/dsh-capability-catalog`（或 `@kirkchinese/dsh-re-kit` 整合包）；MIT；要求 DSH `>=0.2.1-rc.2 <0.2.2-0`、Node `^22.19 || >=24`。
- **物料**：banner、**60 秒 1080p 宣传片**（GitHub Release）、`token-chart.svg`、浅/深色设置截图、会话弹窗截图、social preview、**对比表**（直连 vs PTC vs mcp-lens/progressive-tools vs 自己）；README 结构完整（为什么 → 原理 → 界面 → 安装 → 配置 → 实测 → 对比 → 路线图 → FAQ）。
- **数据声明**：REA MCP 207 工具 / 约 668 KB schema：首请求 249,653 → 8,404 tokens（**−96.6%**）；常驻从约 668 KB 降到约 3 KB；单个 166 KB schema 先给约 8 KB 签名；13 项 E2E、22 项单测；隔离 DSH 实例 + DeepSeek 官方 API。**口径是单场景（REA），README 未给原始数据文件/脚本链接**（未确认是否在别处提供）。
- **优点**：目前“物料 + 功能”最完整：视频、图、对比表、FAQ 全有；覆盖 MCP + skills，正好打中我们的 skills 缺口；超大 schema 的 JSON Pointer 切片是差异化；会话级开关 + 原生 UI 体验好；索引字节稳定、前缀缓存友好；有路线图（原生 `defer_loading`、混合检索、插件工具）。
- **弱点**：BM25 关键词检索，中文查英文工具描述会弱（作者自己在 FAQ 承认）；能力族主要靠人工配置；只支持 0.2.1 一个窄版本；审批粒度是 `capability_call` 一个工具，不是每个 MCP 工具；无插件工具；下载 531/周、5 star，声量还在爬坡。

### 2.8 `@daweifu/capability-menu`（PKUfudawei）— 三档暴露策略 + UI

- **链接**：[GitHub](https://github.com/PKUfudawei/dsh-capability-menu) · [npm](https://www.npmjs.com/package/@daweifu/capability-menu) · [插件页](https://dshbase.com/plugins/dsh-capability-menu/)
- **一句话**：给 tools 和 skills 建统一能力目录 `ctx.capability`，用“常驻 / 按需 / 禁用”三档管理暴露与调用，模型通过 `meta_search` + `meta_invoke` 使用按需能力。
- **机制**：`capability` 是上位概念（tool / skill 两种 kind）；`meta_search` 搜索候选项，列表摘要用于筛选，详情返回完整 schema/技能提示；`meta_invoke` 统一执行面（工具走完整 `ctx.tools` 管线，skill 加载 `SKILL.md`）；策略规则按“禁用精确 > 禁用通配 > 常驻精确 > 按需精确 > 常驻通配 > 按需通配 > 默认常驻”匹配。
- **上下文策略**：常驻工具始终随请求；按需工具不提供定义；skill 按需不显示在 `<available_skills>`；`run_code` 作为 Code Mode 保留工具不进目录；另有 `catalogFile`（默认 `~/.dsh/capability-catalog.yaml`）把按需能力物化成 YAML，模型可用 `grep`/`read` 或 `meta_search` 查。
- **目录/缓存**：策略写在 `capability-menu-policy` 的 config（默认 `~/.dsh/cordis.patch.yml`），UI 点选防抖 1.5 s 写回；目录 YAML 自动更新；无独立缓存层。
- **覆盖/UI/skill**：MCP + 内置工具 + skills；**有完整 Settings 页面**（Tools / Skills 两页、档位圆点、过滤/正则、详情预览、注册 MCP/Skill、GitHub skill 导入）；无视频。
- **安装/License**：`dsh plugin --profile web add @daweifu/capability-menu`（或 `github:PKUfudawei/dsh-capability-menu`）；Apache-2.0；支持 DSH `0.1.5-rc.2` 与 `0.2.0-rc.1`。
- **物料**：`assets/screenshot-tools.png`、`screenshot-skills.png`、`screenshots.json`、dshbase “install-tested” 页、awesome 列表收录；README 中英双语、配置表/优先级表完整；无数据图表/视频。
- **数据声明**：**没有性能基准/数据卡**；只有 CI、3 contributors、dshbase 安装测试（“能装并启动”，不代表功能）。GitHub 120 star，是本次抽样里 star 最高的。
- **优点**：三档模型直观，UI 最像“产品”；覆盖 tools + skills + MCP；注册 MCP/Skill、GitHub 导入降低使用门槛；策略优先级清晰；Apache-2.0；star/下载都高（120★、1,019/周），社区认知强。
- **弱点**：分类靠人工点选（或初始全常驻），工具多时维护成本高；`meta_search` 的检索算法未在 README 说明（未确认，可能只是关键词）；按需内置工具要两步（search → invoke）；审批粒度是 `meta_invoke` 一个工具；`catalogFile` 是扁平清单，没有语义分组；无基准数据。

---

## 3. 横向对比表

### 3.1 机制 / 目录 / 上下文 / 缓存 / 覆盖

| 产品 | 核心机制 | 目录/分组来源 | 上下文策略 | 缓存/存储 | 覆盖 |
|---|---|---|---|---|---|
| Letter2025 | 3 桥接工具 + rerank 搜索 + warm LRU | 人工/对话式分组（JSON） | Tier 0–3 分级清单；清单挂 runtime context | 仅配置文件；无目录缓存 | tools（含 MCP） |
| swimmwatch | `tool_search` + `tool_unload`；BM25/embedding | 无目录；always-available 列表 | 常驻 39 + 按需下一步加载；PTC 支持 | 向量缓存 `$DSH_HOME/cache` | tools（含 MCP） |
| Anionex | `tool_search` + 本地 BM25 Top-5 | 无目录；核心工具白名单 | 过滤 assembly + `tools:sdk` 重生成 | 无磁盘缓存；注册表失效重建 | tools（含 MCP） |
| lordqyxz | `tool_search` + BM25/CJK + 发现守卫 | 无目录；名称+用途常驻 | 常驻一行/工具；发现后直接调用 | 会话事件溯源 | tools（含 MCP） |
| activator | `activate_tools` + `<available_tools>` | 配置 `groups`；`group_tools` 用户触发 | 原生 `defer_loading` + `tool_addition`；不重写请求头 | 配置 + 会话日志 | tools（含 MCP 聚合） |
| mcp-lens | `mcp_search` + `mcp_call` | MCP server 发现；无分组 | 2 个 schema 常驻；schema 命中才进 | 目录 JSON `cachePath`，TTL 24h | MCP only |
| kirkchinese | 常驻索引 + BM25 + `describe`/`call` + `skill` | 人工 families + 名称自动组 + server `_meta` | 分组索引常驻；工具数组不变；skill 接管 | `mcp-*.json`、`toggles.json` | MCP + skills |
| PKU menu | 三档策略 + `meta_search`/`meta_invoke` | 人工档位 + 自动物化 YAML | 常驻/按需/禁用；catalog YAML 可 grep | 策略 config + catalog YAML | tools + skills |
| **我们** | 目录 + `search_tools` + `catalog_status` | **DSH 子代理按意图生成/维护** | `catalog:note` 几行目录；schema 默认隐藏 | **官方 DSH Storage** + 内存降级 | tools（暂不含 skills） |

### 3.2 工程 / UI / License / 数据 / 物料

| 产品 | 安装 | UI | License | 数据声明（口径） | 物料 |
|---|---|---|---|---|---|
| Letter2025 | `dsh plugin add dsh-tool-search` | 无（v0.2.0 计划） | MIT | 无自测；仅引用 Hermes 案例 | README + 徽章 + DESIGN |
| swimmwatch | npm scope + release tgz/SHA256 | 设置页 | Apache-2.0 | 201 用例/5,000 工具；检索基准；**不推断整任务节省** | 设置截图 + 基准方法学 |
| Anionex | npm scope | 设置页 + 工具表 | MIT | 10–100 工具：−94.3%–99.4%；JSON 可复现 | 基准 JSON |
| lordqyxz | GitHub 源（npm 名冲突） | 无 | MIT | 15–120 工具：−67.8%–76.6%；1 次回本；可复现 | bench + 数据表 |
| activator | `dsh plugin add dsh-tool-activator` | 配置页 + 分组编辑器 | MIT | 无性能；304 用例 | hero + 配置截图 + 验证文档 |
| mcp-lens | npm rc.9 / 源码 build rc.10 | 独立 Web 计算器 | MIT + EULA | 1,114 B vs 647,962 B；12/12 vs 10/12 | 概览图 + 计算器 + 产品测试 |
| kirkchinese | npm scope / re-kit | 设置卡片 + 会话弹窗 | MIT | REA 单场景 −96.6%；13 E2E/22 单测 | 视频 + token 图 + 对比表 |
| PKU menu | npm scope / GitHub 源 | 完整 Settings 页 | Apache-2.0 | 无基准；仅 CI/安装测试 | 双页截图 + dshbase 页 |
| **我们** | `dsh-agentic-tool-catalog`（npm 待发布） | **暂无**（仅 `catalog_status`） | MIT | 122→31 工具；schema −83.3%；总 token −40.6%；5 任务×2；chars/4 估算 | 数据卡 + benchmark.md |

---

## 4. agent-curated 是否独有？

### 4.1 结论

**在本次抽样（8 个主竞品 + 6 个近邻，截至 2026-11-11 的公开 README/文档/源码文件）中，没有看到把“DSH 子代理自动读取工具表 → 生成语义分组 → 校验 → 持久化 → 随工具变化增量维护”作为默认路径的实现。** 因此可以写“抽样中未见同款”，**不能写“独家”**。

### 4.2 证据：谁在“生成/整理目录”

| 产品 | 目录/分组怎么来 | 谁触发 | 是否随工具变化自动维护 |
|---|---|---|---|
| Letter2025 | `tool-slimmer-setup` 技能读目录、提案分组、用户确认、写 JSON | 用户说“帮我配置…” | 否；配置是静态的，工具变了要重新跑 |
| activator | 配置页手工分组；或 `group_tools` 让模型增/改/删 | 用户点选 / 用户明确要求整理 | 否；写在 `groups` 配置里 |
| kirkchinese | 人工 `families` + 未匹配按名称自动分组 + server `_meta.family` | 人工配置 | 部分自动（按名称/元数据），但不是语义生成 |
| PKU | 人工三档策略；`catalogFile` 自动物化 | 人工点选 | 目录文件随能力变化更新，但描述/分组来自元数据，不是 LLM |
| swimmwatch / Anionex / lordqyxz | 无目录；检索实时注册表 | 无 | 不适用 |
| mcp-lens | MCP discovery，无分组 | 自动发现 | 不适用 |
| **我们** | 子代理读工具表、按意图写组、自检覆盖率；校验后写 Storage；目录指纹变化增量重生成 | **插件自动（会话创建/目录变化）** | **是** |

### 4.3 谨慎措辞与抽样偏差

- 这是 **README/文档级** 调研，不是逐行代码审计；不排除某个竞品在源码里有未写进 README 的“自动分组”实验。
- 样本不含私有插件、未上架的实现、以及只在小范围分发的版本。
- “模型参与分组”已经出现两次（Letter2025、activator），说明**技术门槛不高**；我们的差异是“默认自动 + 自动维护 + 目录即缓存”，不是“只有我们能做”。
- 官方 DSH 文档里另有一个 [Tool Schema Catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md)（自动生成的工具 schema 文档页），和我们的“Catalog”不是一回事，但**名字容易混**，见 §6.2。

---

## 5. 我们能借鉴的发布 / 营销做法

1. **一个可复述的数字 + 明确口径**。kirkchinese 用“−96.6% 首请求 tokens（REA 207 工具，单场景）”；mcp-lens 用“1,114 B vs 647,962 B”；Anionex 用“−99.4%（100 工具，含核心/系统提示时更低）”。我们的“−83.3% schema / −40.6% 总 tokens / 100% 通过率”要连口径一起写在第一屏，避免被拿去和不同 baseline 对比。
2. **公开方法学，主动说“不证明什么”**。swimmwatch 的 `benchmarks/README.md` 明确写“不推断整任务 token/成本节省”；Anionex 写“百分比取决于实际工具集”。这不会削弱说服力，反而让数据可被引用。我们的数据卡应补：原始结果文件、任务清单、模型/DSH 版本、chars/4 估算边界、一次性生成成本单列。
3. **做交互式计算器**。mcp-lens 的 schema calculator 让用户粘贴自己的工具定义、算常驻体积、生成分享链接/Markdown/卡片——这是最好的 lead magnet。我们可以做“目录节省估算器”（输入工具数/平均 schema 大小，输出首请求节省与回本搜索次数）。
4. **视觉证据**。kirkchinese 有 60 秒 1080p 视频 + token 图 + 浅/深色截图 + 会话弹窗；PKU 有 Tools/Skills 双页截图；swimmwatch 有设置页截图；activator 有 hero + 配置页。我们至少要有：`catalog:note` 在真实会话里的样子、`search_tools` 加载前后对比、`catalog_status` 面板、浅/深色各一张。
5. **对比表要“打擂台”**。kirkchinese 直接列“直连 / PTC / mcp-lens+progressive-tools / 自己”；Anionex 列“Codex vs 本插件”的差异表。我们也应有一张“检索型 / 手动激活型 / 人工目录型 / agent 生成型”对比表，把“目录来源”作为主维度。
6. **安装体验**。swimmwatch 做得最好：scope 包名、`@latest`/`@next`、Release `.tgz` + SHA256、升级/迁移指南、明确“不要 `npm install -g`”。我们要避免 lordqyxz 的重名坑：发布前确认 npm 名、用 scope、README 第一屏给一条可复制命令。
7. **市场分发组合拳**。awesome-dsh-plugin、dshbase（install-tested 徽章）、dshplugin.store、dpharness、dsh.directory、npm keywords；kirkchinese/PKU/mcp-lens/swimmwatch 都至少上了 1–2 个。我们发布时应同时提交 awesome list 与 2–3 个市场。
8. **README/插件页结构**。kirkchinese 的“为什么 → 原理 → 界面 → 安装 → 配置 → 实测 → 对比 → 路线图 → FAQ → License”是当前最成熟的模板；我们的 README 已有“你能得到什么 → 机制 → 工具 → 配置 → 安装 → 性能 → 验证 → 限制”，缺“界面/对比/FAQ”，插件页 `detail.zh.md` 应另写用户向内容（不混 README）。
9. **诚实写限制**。swimmwatch 列隐私/局限；Anionex 列 6 条已知限制；kirkchinese 用 FAQ 处理“多一步会不会变慢/变笨”“中文搜不到英文”。我们的“无 UI、只处理 tools、数百工具未压测”应主动写，而不是等用户发现。
10. **安全/隐私/法务文档**。mcp-lens 有 EULA/PRIVACY/SECURITY/SUPPORT；swimmwatch 有 SECURITY/CODE_OF_CONDUCT/凭据处理说明。插件会读工具描述、可能接触 MCP 凭据，发布时至少要有 SECURITY.md 和“数据去哪”的一段。

---

## 6. 我们的差异化与风险

### 6.1 差异化（相对四派）

| 维度 | 检索型 | 手动激活型 | 人工目录型 | 我们 |
|---|---|---|---|---|
| 目录来源 | 实时注册表索引 | 配置档位 | 人工族/名称模式 | **子代理生成 + 自动维护** |
| 语义来源 | rerank/BM25/embedding | 无（靠名字） | 人工描述/族名 | **agent 写的组名 + 组描述 + 意图归类** |
| 用户配置 | 分组/常驻列表 | 常驻/按需/禁用 | 族/档位 | **默认零配置** |
| 运行时依赖 | 外部 rerank 或本地索引 | 无 | 无 | **DSH 子代理（本机模型）** |
| 持久化 | 配置文件 | 配置/会话日志 | 磁盘缓存 | **官方 Storage** |
| 覆盖 | tools | tools | tools+skills | tools（暂） |

**一句话定位**：不是“又一个 tool search”，而是“**让 agent 先读懂工具，再写一份目录；检索只是目录的入口**”。语义在目录里，不在检索算法里——所以不需要外部 rerank/embedding，也能按意图分组（浏览器拆操作/观察/判断、Google 按邮件/日历/登录拆、跨 server 合并）。

### 6.2 风险

1. **快速跟进**。Letter2025 已有“读目录 + 写配置”的 setup skill，activator 已有 `group_tools`；把“用户触发”改成“自动触发”并不难。kirkchinese 的路线图已写“混合检索/更多来源”，PKU 有 UI 和策略层——任何一家加一个“AI 整理”按钮，我们的差异就会被压缩。
2. **原生 `defer_loading` 路线可能改写默认**。activator 用 `defer_loading` + `tool_addition`，激活不重写请求头、前缀缓存不失效；kirkchinese 也实测官方端点支持 `defer_loading`/`tool_reference`。如果 DSH 适配器原生支持“按需工具声明不计 token”，那么“目录 + 搜索”可能从默认方案变成可选方案。我们依赖 `tools.restrict` + tool-addition，要盯上游 API 变化。
3. **UI 缺口**。8 个主竞品里 5 个有 DSH 内 UI（swimmwatch、Anionex、activator、kirkchinese、PKU）；我们只有 `catalog_status` JSON。用户会默认“没 UI = 不成熟”，也会缺少截图/视频素材。
4. **skills / MCP 覆盖缺口**。kirkchinese 和 PKU 已覆盖 skills；mcp-lens 把 MCP 连接管理做得更深。我们只处理 tools，面对“skills 很多”的用户，节省故事不完整。
5. **数据卡口径会被挑战**。5 任务 ×2、chars/4 估算、单模型、单 profile；成本 +3.7%、步数 +6.8%、搜索 +1.2/会话都是真实代价。swimmwatch 的方法学（201 用例、5,000 工具、明确不推断整任务）会把我们的“−40.6%”显得单薄。需要补原始数据、第二模型、更多任务，以及一次性生成成本/延迟。
6. **命名辨识度**。`dsh-tool-search` 已有 7 个同名仓库；`dsh-capability*` 35 个；官方还有 [Tool Schema Catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md)。"Agentic Tool Catalog" 里的 "Agentic" 容易被读成“给 agent 用的”，而不是“agent 生成的”；"Catalog" 又和官方文档页撞词。建议固定副标题：**“Agent-generated tool catalog（子代理生成，不是检索索引）”**，并在 README 第一段解释与 Tool Schema Catalog 的区别。
7. **依赖上游 API**。`tools.definitions/restrict`、tool-addition、`storageDomain` 都是 0.2.x 的公开接缝，但仍在 rc 阶段；竞品已经踩过 `tools.restrict` 隐藏后 dispatch `UNKNOWN_TOOL` 的坑（Letter2025 DESIGN 明确写“不能用 restrict 做瘦身”）。我们的实现要持续回归。
8. **生成成本/失败模式**。子代理生成是一次性 LLM 调用，有延迟、失败、超时、模型质量波动；竞品的检索是本地 µs 级。数据卡把生成排除在任务指标外是合理的，但发布时必须单独给“首次生成耗时/成本/失败率”，否则会被质疑“把成本藏起来了”。
9. **检索质量依赖目录质量**。我们的 `search_tools` 是名字/描述/组名的关键词匹配，语义来自 agent 写的目录；没有 BM25 的词频/IDF，也没有 rerank/embedding 兜底。目录写得不好，搜索就会漏。需要更多“目录质量差”的失败案例与兜底策略（精确组名整组加载是现有缓解）。
10. **名字/包名可用性**。`dsh-agentic-tool-catalog` 之前查过 npm 404 可用，但发布前要再确认；GitHub 组织/仓库名、插件市场 title 也要查重。

### 6.3 定位建议

- 对外一句话：**“Agent 先读工具，再写目录；目录常驻，schema 按需。”**
- 对开发者一句话：**“不是 BM25/embedding 检索，也不是手动激活——目录由 DSH 子代理生成并维护，缓存走官方 Storage。”**
- 对比表主维度用“目录来源”，不要用“检索算法”；否则会被拖进 Letter2025/swimmwatch/Anionex 的赛道，我们的优势讲不清。
- 承认边界：v1 只做 tools；skills/MCP 连接管理是路线图，不抢 kirkchinese/mcp-lens 的活。

---

## 7. 建议的下一步（发布前 3–5 个动作）

1. **数据卡 v2：从“一个结果”升级为“可复现实验包”**
   - 补第二模型（至少 `deepseek-flash` + 一个非 flash 路由）、10+ 任务、每臂 ≥3 轮；
   - 首请求 tokens 尽量用 API usage 实测（不只 chars/4），同时保留 chars/4 作为估算口径；
   - 单独报告“首次目录生成耗时/成本/失败率/重试率”，不混进任务指标；
   - 发布 `results/*.json` + 任务清单 + 复现脚本；学 swimmwatch 写“本数据不证明什么”。
   - **验收**：外部读者能按 README 在干净 profile 复现主表。

2. **最小 UI + 视觉物料（发布前必须有）**
   - 设置页/侧边面板：目录分组列表、新鲜度、`storage.mode`、最近生成时间、失败原因、“重新生成”按钮；
   - 截图：`catalog:note` 真实会话、`search_tools` 前后对比、`catalog_status`、浅/深色各一张；录 20–30 秒 GIF（生成 → 搜索 → 调用）；
   - 插件页 `detail.zh.md` 按官方产品页风格重写，放截图，不放安装命令。
   - **验收**：Plugins 页有图、有状态、有“重新生成”，用户不用读 README 就能理解。

3. **补 skills 覆盖，或把“只做 tools”讲成选择**
   - 方案 A（推荐）：v1.1 把 skills 纳入目录（与 kirkchinese 正面竞争）；
   - 方案 B：明确“v1 只做 tools，skills 在路线图”，并在 README/对比表写清楚，避免用户误购；
   - 无论 A/B，都补一条“MCP 工具已覆盖（通过 tools 注册表），MCP 连接管理不做”。
   - **验收**：对比表里“覆盖”一列不再是我们唯一的空白。

4. **分发组合拳（发布周执行）**
   - npm 发布 + GitHub Release（tag、CHANGELOG、LICENSE、icon）；
   - 提交 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)、dshbase、dshplugin.store、dpharness、dsh.directory；
   - README 第一屏放“安装一条命令 + 数据卡 + 对比表 + 30 秒 GIF”；
   - 用 scope 包名避免 `dsh-tool-search` 重名坑；确认 `dsh-agentic-tool-catalog` 可用。
   - **验收**：至少 2 个市场可搜到；awesome 列表有条目；`dsh plugin add` 一次成功。

5. **命名与信息架构收口**
   - 固定副标题“Agent-generated tool catalog”，在所有物料统一；
   - README 加一段“与 Tool Schema Catalog / capability catalog / tool search 的区别”；
   - 对比表用“目录来源”主维度，避免被拖进检索算法比较；
   - 发布前再查 npm/GitHub/市场 title 重名。
   - **验收**：一个新用户 30 秒内能说出“它和 dsh-tool-search 有什么不同”。

---

## 附录 A：数据快照（2026-11-11）

| 产品 | Stars | Forks | npm 周下载 | 最新版 | License | 最近 push |
|---|---:|---:|---:|---|---|---|
| Letter2025/dsh-tool-search | 14 | 5 | 911 | 0.1.10 | MIT | 2026-11-05 |
| swimmwatch/dsh-tool-search | 1 | 0 | 264 | 1.0.0 | Apache-2.0 | 2026-11-04 |
| Anionex/dsh-tool-search | 0 | 0 | 13 | 0.1.2 | MIT | 2026-09-12 |
| lordqyxz/dsh-tool-search | 0 | 1 | 无独立包 | 0.1.0（仓库） | MIT | 2026-09-30 |
| Tranquillitatis-Lab/dsh-tool-activator | 12 | 3 | 863 | 0.5.0 | MIT | 2026-11-08 |
| labmimors/dsh-mcp-lens | 12 | 3 | 290 | 0.1.0-rc.9 | MIT | 2026-09-11 |
| kirkchinese/dsh-capability-catalog | 5 | 1 | 531 | 0.1.6 | MIT | 2026-11-03 |
| PKUfudawei/dsh-capability-menu | 120 | 5 | 1,019 | 0.1.9 | Apache-2.0 | 2026-11-05 |

> Stars/Forks 来自 GitHub API；下载来自 `api.npmjs.org` 的 last-week；版本来自 npm `dist-tags.latest`（lordqyxz 无独立 npm 包，取仓库 `package.json`）。数据会变，引用时保留日期。

## 附录 B：未确认 / 未做

- 未安装、未运行任何竞品；所有行为描述来自 README/源码文件，未做运行时验证。
- Letter2025 无公开基准；其 rerank 实际效果、无 matcher 时的召回率未测。
- Anionex 只支持 0.1.x，未在 0.2.x 上验证是否可强行安装。
- lordqyxz 的 dpharness 实装验证失败（unknown），未确认是环境差异还是包本身问题。
- mcp-lens 的检索算法未在 README 说明；`docs/RETRIEVAL_EVALUATION.md` 未细读。
- kirkchinese 的 −96.6% 是单场景（REA 207 工具），README 未给原始数据文件链接；未独立复现。
- PKU 的 `meta_search` 检索算法未在 README 说明；dshbase 页显示 94★、GitHub API 显示 120★，未核实时点差异。
- 我们的数据卡是 5 任务 ×2、chars/4 估算；未做第二模型、未做 100+ 工具规模压测。
- 未评估各竞品在 DSH 0.2.2-rc.1 上的真实兼容性（除 README 声明外）。
