# 2026-11-10 · Discovery 全部候选策略矩阵（要全部测完、选出最好的）

> 用户目标（2026-11-10 重申）：**把所有 strategy 都测完，看到底哪个最好**——包括
> ① System-1 决策模型（TypeSafe Jev）；② agent / 大模型参与；③ 业界已验证的检索方案。
> 本文件是"策略总清单 + 对照臂 + 评测计划"，随实现进展更新状态。
> 相关：[P1 结果](2026-11-10-p1-tournament.md)、[指标与评测](2026-11-10-discovery-metrics.md)、
> [归类设计](2026-11-10-discovery-grouping-design.md)、[benchmark](../benchmark/discovery/README.md)。

## 1. 策略总表

| # | strategy（arm） | 本质 | 业界依据 | 本机可用性 | 状态 | 额外成本/延迟 | 主要风险 |
|---|---|---|---|---|---|---|---|
| 1 | `legacy` | v1 中心硬编码组（9 组） | —（历史方案） | ✅ | **已测（P1）** | 0 | 维护病：新插件要改源码 |
| 2 | `rules` | 名字聚类 + `others`（零插件知识） | 接近 OpenAI namespace 的"自动版" | ✅ | **已测（P1）→ 当前生产默认** | 0 | 组名较粗；语义弱于人工 |
| 3 | `oracle` | 人工最优分组（上界尺子） | OpenAI "use namespaces" 的人工版 | ✅ | **已测（P1）** | 0（人工成本除外） | 不可自动维护 |
| 4 | `minimal` | 不分组（下界尺子） | — | ✅ | **已测（P1）** | 0 | 无目录页，模型更盲目 |
| 5 | `bm25` | BM25 关键词检索（无分组） | Anthropic Tool Search 默认检索之一；MCP 客户端最佳实践首推 | ✅ | **引擎就绪（待 P2 测）** | 每次 search 本地计算（<10ms） | 同义词/语义弱 |
| 6 | `rules-bm25` | rules 分组 + BM25 排序（混合） | 关键词检索 × 目录提示 | ✅ | **引擎就绪（待 P2 测）** | 同上 | 组合调参 |
| 7 | `jev-precompute` | 目录变化时，Jev（System-1 决策模型）用**工具描述语义**把工具判进候选组；缓存结果 | 小模型分类/判组（MCP best practice 的 subagent/classifier 变体）；Jev 在主题/意图分类上实测强（AG News 0.91、Banking77 0.87） | ⚠️ 代码可用、**本机环境不可测**（2026-11-10：OpenRouter decisions 返回 HTTP 529 `system_overloaded` + 多次 8–20s abort；凭据/契约本身正常，见探针记录） | ✅ 代码已实现 + 单测；⏳ 待服务恢复复测 | 每次目录变化一次调用；会话内 0 | 外部依赖/服务过载；需缓存与回退 |
| 8 | `jev-online` | search 时先规则取候选 → Jev Choice/Noul 选择/筛掉无关（或先判"是否需要外部能力"） | MCP best practice 的 subagent-based discovery 的轻量版 | ⚠️ 同 7（服务不可用，代码可回退） | ✅ 代码已实现 + 单测；⏳ 待服务恢复复测 | 每次 search +0.6–0.7s、≈$0.00002 | 外部依赖/过载；置信度需按任务标定 |
| 9 | ~~`llm-precompute`~~（原 agent-precompute） | 单次大模型调用生成组名/归属（**不是 agent**：一次 prompt→JSON） | 业界自定义 tool retrieval 的简单版 | ⚠️ OpenRouter chat 端点同样 529 过载 | ⛔ **用户决策：放弃，用真 agent 替代** | 一次性调用 | 非确定性；外部依赖 |
| 10 | ~~`llm-online`~~（原 agent-online） | 单次大模型调用从候选里选工具（**不是 agent**） | MCP subagent-based 的"一次性"简化版 | ⚠️ OpenRouter chat 529 过载 | ⛔ **用户决策：放弃，用真 agent 替代** | 每次 search 一次调用 | 成本/延迟；外部依赖 |
| 10a | **`agent-precompute`（真 agent）** | 目录变化时，由**DSH 原生子代理**多步巡检工具目录（读描述、查组、自检漏项/重叠、迭代）后产出分组目录；结果缓存 | MCP best practice 的 **subagent-based discovery**；Anthropic 的 tool search 本质也是主模型 agentic 检索 | ✅ 用 DSH 自己的模型（deepseek 账号），不依赖 OpenRouter | 🧪 实验中（benchmark：agent 生成分组文件 → oracle 策略消费后跑任务） | 每次目录变化一次子代理运行（多步、数十秒）；会话内 0 | 成本/延迟高于一次性调用；非确定性（缓存锁定） |
| 10b | **`agent-online`（真 agent）** | 搜索时由子代理多步探索候选、比较后返回选择（按歧义/重要性触发） | 同上 | ✅ 可走 DSH 原生 agent | ⏳ 待实现/评估（延迟与成本高，需成本上限） | 每次触发一次子代理运行（秒级~数十秒） | 高延迟/成本；需阈值触发与回退 |
| 11 | `embedding`（**本机不可用**） | 工具名/描述向量化 → 语义检索/聚类 | Anthropic 支持自定义 embedding search；MCP best practice 列出 | ❌ 本机无 embedding 服务/模型 | **记录待评估** | 需外部 embedding API 或本地模型 | 引入新依赖；隐私/成本 |
| 12 | `structure`（有则用） | 工具自带结构：MCP server 自动组（已有）、未来官方 `namespace`/origin 元数据 | OpenAI namespace / MCP server 分组 | ⚠️ MCP 已有；非 MCP 无来源（需上游 core API） | **MCP 自动组已在 rules 内生效；元数据待上游** | 0 | 依赖核心 API 演进 |

## 1.5 组合策略（C 系：不穷举，测有代表性的 4 个 + 消融）

> 用户 2026-11-10：单策略之外，是否有"组合起来更好"的方案？——**有，且业界本身就是混合用法**：
> MCP Client Best Practices 明确列 "Hybrid"（关键词 + embedding + 子模型组合）；Anthropic Tool Search 支持
> regex / BM25 / 自定义检索并存；OpenAI 用 namespace（结构）+ tool search（检索）配合。
> 但组合不能乱堆：每个组分都要能回答"它到底贡献了什么"，所以用**消融（ablation）**测。

| # | 组合 arm | = 哪几层 | 设计意图 | 成本控制 |
|---|---|---|---|---|
| C1 | `rules-bm25`（已实现） | rules 分组 + BM25 排序 | 目录提示（awareness）× 关键词精度（precision） | 纯本地，0 额外 |
| C2 | `rules-jev-pre` | rules 分组 + Jev **预计算判组**（用工具描述语义纠偏/细分） | 分组更准（尤其名字看不出语义的工具） | 每次目录变化 1 次 Jev，缓存 |
| C3 | `bm25-jev-online` | BM25 检索 + **仅在"分不清"时**问 Jev（top 分差小 / 宽 query） | 用决策模型补语义边界，但不为每次搜索付钱 | 每次 search 最多 1 次 Jev，且只在低置信时 |
| C4 | `full-combo` | 结构（MCP server 自动组；非 MCP 走 rules）+ BM25 检索 + Jev 预计算判组 + 低置信 Jev 在线重排 + 规则兜底 | 全家桶：结构免费拿、检索用 BM25、语义用 Jev、失败全回退 | 预计算 1 次/目录变化；在线 Jev 只在低置信 |

**消融计划**（回答"每块贡献多少"）：`rules`（基线）→ `rules-bm25` → `rules-bm25 + jev-pre` → `full-combo`；
每一步只加一块，看质量/速度/成本变化；若某块无贡献就从最终组合里删掉（简洁优雅硬约束）。

### 1.6 "有意义的组合"原则（用户 2026-11-10 要求固化）

用户明确：**hybrid 不能瞎组合**，必须有原理、有意义，否则只是浪费资源、把结论搞乱。
把这条写成硬规则（P2 前先"预注册"，避免事后找理由）：

1. **假设先于实现**：每个 hybrid 先写清"它要解决哪个单策略的失败模式 + 预期哪个指标变化"；
   写不出假设的组合不做。
2. **只组合"不同阶段/不同失败模式"的层**，不堆同质能力：
   - 目录提示层（rules）：解决"模型不知道有哪些能力"（awareness）；
   - 检索排序层（BM25）：解决"知道能力但搜不准"（precision）；
   - 语义判定层（Jev 预计算/低置信重排）：解决"名字看不出语义 / 关键词错过同义词"；
   - 结构层（MCP server / 未来 namespace）：免费的来源分组，能用就用；
   - 兜底层（规则/失败回退）：保证外部依赖挂了也能工作。
3. **消融阶梯必须能证明每层的边际贡献**：`rules → +BM25 → +Jev 预计算 → +低置信重排 → full`；
   某层带来不了可测收益（质量/速度/成本任一维）就**从最终方案删除**（架构简洁硬约束）。
4. **每层可关闭、可回退、有成本上限**：外部调用失败/超时→回退规则；Jev 在线只在低置信时触发；
   预计算按目录指纹缓存（目录不变就零调用）。
5. **预先定义判定标准**（写进 P2 报告开头）：哪些指标、重复几次、什么算"显著更好"、
   质量门槛是什么；不达标不进下一步比较。
6. **最终报告格式**：每种策略/hybrid 的 n、重复次数、质量/速度/成本指标、置信区间、离 oracle 差距；
   加"每层边际贡献"和"失败/降级次数"；结论必须能由表里的数字直接推出。

**组合的固有风险**：复杂度上升、外部调用失败面变大（必须每层可降级）、非确定性来源变多（缓存/固定参数）、
调试成本上升。评测里必须单列"降级次数/外部失败次数/输出稳定性"，不能只看均值。

**说明**：
- "业界已验证"里，**BM25/关键词检索**是成本最低、公开验证最充分的一条（Anthropic Tool Search 默认用 regex/BM25）；
  **subagent-based 选择**（我们的 `agent-online`/`jev-online`）是 MCP 官方点名策略；
  **namespace/结构分组**（OpenAI）在"有结构"时最好，但我们拿不到第三方插件的结构，只能对 MCP 自动生效。
- **embedding 方案暂不可用**：本机没有 embedding 服务/模型；引入外部 API 会新增依赖与隐私面，
  先记录，等其它策略数据出来再评估是否值得。
- 所有带外部调用的策略（7–10）都必须：可开关、失败/超时**回退规则**、结果**缓存**（按目录指纹）、
  并在 `discovery_status` 里暴露 health/降级原因。

## 2. 第二轮锦标赛（P2）计划

- arms：`rules`（当前生产）、`bm25`、`rules-bm25`、`jev-precompute`、`jev-online`、`agent-precompute`、
  `agent-online`、**组合系 `rules-jev-pre` / `bm25-jev-online` / `full-combo`**（embedding 先不进；
  oracle/minimal 作为尺子保留参考）；
- 任务：P1 的 7 个 + 新增 `workspace-calendar-count`（21 个 MCP 工具里找对的那个）；
  若 browser-use 扩展稳定在线，再加 1 个浏览器任务（28 工具场景）；
- 重复：每个 arm × 任务 **2–3 次**（压缩方差）；粗筛用 1 次、决赛用 3 次；
- 指标：质量门槛（pass/missed/一次命中/误装）→ 速度（setup、步数、墙钟）→ 成本（token/$）→
  外加"外部依赖健康度/降级次数/确定性"；
- 决策：质量优先选 Pareto 前沿最优，并按"离 oracle 上界差多少"报告。

## 3. 实现顺序（本会话）

1. ✅ BM25 + rules-bm25（纯函数，已实现 + 单测）；
2. ✅ 外部层客户端：`lib/external.js`（Jev decisions + OpenRouter chat；凭据只走 DSH `ctx.credentials`，
   key 不落盘/不打印；失败一律回退）+ `lib/enrich.js`（预计算判组/分组、在线重排、歧义判定）；
3. ✅ 策略层接线：`lib/policy.js` 的 `STRATEGY_LAYERS` + `lib/index.js` 的异步增强/缓存/降级/状态观测；
   单测 110/110、真实包 schema 冒烟 30/30 通过（外部层用 fake client 测，不联网）；
4. ⏳ **P2 锦标赛**（`benchmark/discovery/p2-runbook.md`：8 个 arm × 6 任务粗筛 → 决赛 2–3 次重复）；
5. ⏳ 汇总 → 决策最优策略（可能是 hybrid）→ 回到生产配置 → 收尾文档；
6. ⏳（可选）embedding 评估、上游 namespace/origin API 提案。

## 3.6 决策更新（2026-11-10，用户）

- **用户决策：有 agent 后不再做"一次性 LLM 调用"策略**（`llm-precompute`/`llm-online` 已放弃）——一次 prompt→JSON 不配叫 agent。
- 真 agent 策略 = 多步 + 用工具 + 自检迭代：`agent-precompute`（先做）/ `agent-online`（成本与延迟评估后做）。
- 已归档的外部线数据（Jev 系、一次性 LLM 系）移到 `benchmark/discovery/results/unavailable-external/`，**不进入最终对比表**。

## 3.5 环境事件（2026-11-10）

- **Jev（OpenRouter decisions alpha）在本机复测中不可用**：HTTP **529 `system_overloaded`** + 多次 abort（8s/20s 超时）；
  契约层曾成功返回（`answers` 数组、字段 `type/choice/probabilities/confidence`），失败属服务侧过载。
- 因此 P2 中 Jev 两臂**不作效果结论**（代码已实现、单测覆盖、失败自动回退规则）；报告里标注"环境限制，待复测"。
- 继续测与外部无关或走标准 chat 端点的策略：agent 系两臂、full-combo（Jev 层不可用时自动退化为 rules+BM25 混合）、
  rules 基线复跑。

## 4. 状态更新规则

每实现一个策略：更新本表状态 → 跑单测 → 跑 P2 对应 arm → 把结果写进 P2 报告；
最终报告只保留"数据 + 结论 + 局限"，不保留未实现项的猜测。


## 5. P2 实测结论（2026-11-10，详见 [P2 最终报告](2026-11-10-p2-tournament.md)）

| 策略 | 状态 |
|---|---|
| `legacy` | ❌ 淘汰（步数/成本最差 + 维护病） |
| `rules` | ✅ **生产兜底/回退**（质量 100%、零外部依赖、自动适应新插件；agent 分组失败时自动使用） |
| `bm25` | ❌ 未胜过 rules（业界基线对照使命完成） |
| `rules-bm25` | ❌ 组合无边际收益 |
| `minimal` | ❌ 只作下界尺子（组确实有价值） |
| `oracle` | ⚪ 只作尺子（本任务集未超过 rules） |
| 真 agent 分组 `agent-precompute` | 🥇 **实测最优 → 2026-11-10 晚通过可靠性验收并切换为生产默认**（搜索 −14%、步数 −16%、成本 −24%；12 会话生成 0 失败、缓存稳定、无实例重置；非阻塞+磁盘缓存+失败回退 rules） |
| `jev-precompute`（rules+Jev 判组） | ✅ **已实测（Jev 恢复后，1 轮）**：搜索 1.00/步数 9.17/成本 $0.017 ≈ agent 档，优于 rules；外部依赖 + 首判成本；可作备选 |
| `full-combo`（全家桶） | ❌ **已实测，不建议**：搜索 1.83/步数 11.83/成本 $0.023，比 rules 差（外部风暴 + 组切换抖动） |
| Jev `jev-online`（单独） | ⏳ 仅作为 full-combo 组件验证过 1 次（成功）；单独效果待评估 |
| 一次性 LLM 系 `llm-*` | ⛔ 用户决策放弃（非 agent，已被真 agent 取代） |
| `agent-online` | ⏳ 待实现/评估（成本与延迟高，需阈值触发与上限） |
| 组合/全家桶 | ⏸ 外部层不可用时等价 rules-bm25，未单独跑 |


## 6. 最终收敛（2026-11-10 晚，用户决策）

- **只保留真 agent 策略**：`legacy` / `rules` / `bm25` / `rules-bm25` / `oracle` / `minimal` /
  `jev-precompute` / `jev-online` / `llm-*` / `full-combo` / `agent-online` 的代码与配置**全部移除**；
- 冷启动/生成完成前用 **bootstrap 扁平目录**兜底（不是旧策略）；生成失败沿用 **last-known-good** 并显式告警；
- 本文件其余章节保留为**历史评测记录**（用于解释为什么选 agent、以及当时各策略的数据）。
