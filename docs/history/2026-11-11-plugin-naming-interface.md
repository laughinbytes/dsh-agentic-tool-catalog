# 2026-11-11 · Tool Discovery：缓存持久化、接口契约、命名与规范梳理

> 状态：讨论稿（等用户拍板后执行）。当前生产插件名 `@local/dsh-tool-discovery`，display「Tool Discovery / 工具发现」。

## 1. 缓存持久化：现在用什么 vs 官方 Storage

**现在（未用官方）**：插件自管文件
- 路径：`$DSH_HOME/cache/tool-discovery/groups.json`（本机 `~/.dsh/cache/tool-discovery/`）
- 结构：`{ version, updatedAt, groups: { <sha256指纹>: [分组...] }, lastGood }`
- 机制：内存（globalThis 进程级）+ 磁盘；原子写（tmp+rename）；启动读取时用同一套校验重建；超过 16 个指纹/旧格式 key 自动清理。
- 定位：**派生缓存**（丢了只是重新生成一次 ~70s），不是用户数据。

**官方可选**：`ctx.storageDomain`（`@deepseek-ai/dsh-storage` + `dsh-storage-domain` + JSON backend）
- 本 profile **已挂载**（服务目录里有 `storage` / `storageDomain`，数据在 `~/.dsh/storages/`）。
- 用法：拥有方 `defineDomain({name,version,tables: zod schema})` 导出声明的 domain；消费者
  `const domain = await ctx.storageDomain.open(spec)`；同步读、写入在 backend 确认 durable 后 resolve，发 `domain/changed`；
  用 `ctx.effect` 负责 `domain.close()`。backend 路由由 storage-domain 插件配置决定（`backend` / `routes`）。
- 优点：官方生命周期/位置/备份、schema 校验与版本、写入串行化、变更事件、无裸文件写。
- 代价：多一层 composition 依赖（无 storage 的 profile 要优雅降级）、API 处于 0.2-rc、代码量增加、
  domain spec/表结构要维护；对"派生缓存"来说收益主要是规范性而非能力。

**建议（待拍板）**：
- 首选 **保持文件缓存**：它是派生数据、已有原子写/校验/裁剪/跨重启能力，简单且不绑 composition；
- 若发布规范要求走官方 storage：做一层 `CacheBackend` 小接口，优先 `ctx.storageDomain`，不可用则回退文件——
  但要接受"两套路径"的复杂度；不建议在发布前强行迁移（收益 < 风险）。
- 无论选哪种：把"缓存是派生的、可丢弃"写进文档，避免被当用户数据。

## 2. 插件如何工作 / 接口契约（现状）

### 2.1 插件面（Cordis）
- `name = 'dsh-tool-discovery'`；`inject = ['tools']`
- `apply(ctx, config)`：注册工具、监听事件、注入系统提示、持有实例 effect（卸载清理 restriction）
- `Config` 字段：
  `maxResults`(6) / `groupMaxResults`(30) / `promptNote`(true) / `resident[]` / `extraKeepResident[]` /
  `extraDeferred[]` / `agentGroupProvider`('spawn') / `agentGroupTimeoutMs`(120000) / `agentGroupResetNonce`('')

### 2.2 模型可见工具
| 工具 | 参数 | 行为 | 返回 |
|---|---|---|---|
| `search_tools` | `query:string`, `limit?:number` | 在按需目录里匹配（名字/描述/组名/组描述，确定性打分）；query 精确等于组名→整组加载（≤groupMaxResults）；加载=把工具从该 agent 的 deny 集合释放并加入 loaded | 文本：加载了哪些工具/组、剩余数量、零命中时的原因与下一步提示 |
| `discovery_status` | 无 | 只读观测：策略、目录来源/新鲜度、分组+计数、已加载、限制、生成统计（runs/cacheHits/failures/retries/deduped/staleUses/incrementalRuns/lastError/lastOkAt/instanceId/lastReload）、warnings | JSON 字符串 |

### 2.3 提示面
- `systemPrompt.context` 名 `tool-discovery:note`（order 300）：每组"能力+计数"一行；bootstrap 时提示初始化中；
  stale 时提示"正在使用最近一次成功分组"；加载后按 agent 的 loaded 动态变化。

### 2.4 内部事件/服务
- 消费事件：`agent/created`、`agent/inbox/claimed`、`agent-preset/selected`、`tools/change`、`agent/disposed`、
  `hmr/reload`、`plugin-manager/changed`、`app-boot/config-reload`
- 服务：`ctx.tools`（definitions/view/restrict/schemas）、`ctx.get('subagents')`、`ctx.get('systemPrompt')`、`ctx.get('agents')`
- 状态：per-agent（catalog/loaded/restriction/freshness/origin/enrichment）；进程级 shared（缓存、统计、inflight）
- 生命周期：restriction 由实例 effect + 全局登记表管理；agent 销毁清理

### 2.5 生成流程（一句话）
agent 需要 → 目录指纹 → 缓存（内存/磁盘）命中则直接用；未命中→生成（增量优先）→校验→缓存+替换目录；
失败→自动带反馈重试→仍失败沿用最近一次成功分组（状态 `stale`，显式提示/日志/退避重试）；从未成功→bootstrap。

## 3. 命名与规范统一（讨论）

### 3.1 现名的问题
"Tool Discovery"只描述了"发现"这一瞬间；插件实际长期做的是**维护一个按需工具目录 + 加载路由**（catalog + on-demand loading）。
名字不准确，也不利于发布叙事。

### 3.2 候选名（英文名/中文显示名 / 包名 / 行 id）
| 候选 | 英文显示 | 中文 | 包名 | 行 id | 评价 |
|---|---|---|---|---|---|
| A（推荐） | **Tool Catalog** | 工具目录 | `@local/dsh-tool-catalog` | `tool-catalog` | 准确描述稳态：目录+按需加载；简短 |
| B | **Tool Index** | 工具索引 | `@local/dsh-tool-index` | `tool-index` | 更强调搜索；易被理解成纯索引 |
| C | **Capability Catalog** | 能力目录 | `@local/dsh-capability-catalog` | `capability-catalog` | 更宽的能力叙事；略长 |
| D | 保留 Tool Discovery | 工具发现 | 现名 | `tool-discovery` | 已用于 P0/P1 文档/缓存路径，改动小但语义弱 |

### 3.3 统一后的术语与接口（若改名）
- 插件/包/行 id/缓存目录/提示 section/状态工具统一用 **catalog** 词汇：
  - `systemPrompt` section：`catalog:note`
  - 状态工具：`discovery_status` → **`catalog_status`**（或保留兼容别名一段时间）
  - 缓存目录：`~/.dsh/cache/tool-catalog/`
  - 内部配置前缀 `catalogGeneration*`（可选；也可保留 `agentGroup*` 以减小 diff）
- **接口契约文档**：新增 `docs/interface.md`（+ `docs/interface.zh.md`）：工具 schema、status JSON 字段契约、Config 表、
  事件/服务依赖、生命周期、失败语义、版本与兼容策略。
- **README/插件页规范化**：与 docs/08 对齐——双语 README（中/英）、双语 detail、locale 双语、icon、
  canonical 表更新、审计脚本/回归脚本/`check-plugins.sh` 路径同步。
- **LICENSE**：当前插件目录没有 LICENSE；发布前需选一个（建议 MIT；需用户确认）。
- **迁移清单**（改名时）：目录/包名 → locale → docs/detail → README → cordis.patch.yml 行 id → profile
  bundle 移除/重装（plugin_manager）→ 缓存目录（可保留旧目录兼容读取一次）→ benchmark/notes/scripts 引用 →
  审计/回归跑通 → 真机重启验证。

## 3.4 命名调研（2026-11-11，外部可用性/冲突已核）

**方法修正**：之前只查了工作区文档/已装插件，**不足以判断发布命名**；这次补了：
npm registry 精确名、GitHub 仓库名、DSH 官方文档、DSH 生态列表（awesome-dsh-plugin / dshbase / dshhub / GitHub Discussions）。
（本机 `plugin_market` 未配置索引源，无法直接查官方市场；后续可让用户加 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 作为索引源。）

**npm 占用情况**：
- 已占用：`dsh-tool-search`（社区插件）、`dsh-tool-index`；
- 可用（404）：`dsh-tool-catalog`、`dsh-tool-directory`、`dsh-tool-curator`、`dsh-deferred-tools`、`dsh-on-demand-tools`、`dsh-capability-catalog`（包名可用，但 GitHub 已有同名插件 `kirkchinese/dsh-capability-catalog`）。

**DSH 生态已有同类（直接竞品，后续竞品分析对象）**：
| 插件 | 定位 |
|---|---|
| `dsh-tool-search`（Letter2025 等，多个实现） | Tool search & slimming；Hermes 风格渐进披露 / Codex 风格 deferred loading / BM25 等 |
| `dsh-tool-activator`（Tranquillitatis-Lab） | 默认只加载基础工具，其余用 `activate_tools` 激活；注入 `<available_tools>` 目录 |
| `dsh-mcp-lens`（labmimors） | 1000 个 MCP 工具藏到 2 个面向 MCP 的 schema 后，按需加载精确 schema |
| `dsh-capability-catalog`（kirkchinese） | Lazy capability catalog：MCP 工具与 skills 统一入口 |
| `dsh-capability-menu`（PKUfudawei） | 管理工具/技能暴露策略，按需检索调用 |
| `@swimmwatch/dsh-tool-search` | 原生 tool search：BM25 / 可选语义 embedding |

**官方文档冲突点**：DSH 官方 reference 有 **"Tool Schema Catalog"** 页面（自动生成的工具 schema 参考），
与 `tool-catalog` 同词但不同概念，需要在描述里明确区分（我们的目录是“agent 维护的按需目录”，不是官方 schema 参考页）。

**结论建议**：
- **`dsh-tool-catalog`（Tool Catalog / 工具目录）**：npm/GitHub 均无同名插件；名词准确、简短；
  唯一顾虑是与官方 reference 的 “Tool Schema Catalog” 同词，需要 tagline 明确“on-demand / agent-curated”。
- 备选：`dsh-tool-directory`（避开官方同词，但 directory 容易被理解成文件目录）；
  `dsh-tool-curator`（突出 agent 维护/策展，但略像拟人化命名）。

## 4. 待用户决策
1. 缓存：**文件缓存（推荐）** vs 官方 storageDomain vs 适配层双后端；
2. 插件名：A `tool-catalog`（推荐）/ B `tool-index` / C `capability-catalog` / D 保留；
3. 接口工具：`discovery_status` 是否随名字改为 `catalog_status`（或保留兼容别名）；
4. License：MIT / 其他；
5. README/插件页是否按双语规范重写（推荐是，发布前必做）。
