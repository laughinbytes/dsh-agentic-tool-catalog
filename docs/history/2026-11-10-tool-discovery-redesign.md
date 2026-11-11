# 2026-11-10 · Tool Discovery v2：可评审重构方案（方向修订版）

> 状态：**设计提案 v2（零配合方向），待用户确认**（§11）。
> v1 提案（"工具自带声明"）被用户否掉：**不能假设任何第三方/官方插件配合**——那是不现实的。
> 本版把方向改成**"纯推断、零配合"**：无论机器上装了什么插件、谁的插件，discovery 都自动工作，
> 不需要别人改一行代码、不依赖任何新字段。
> 背景与现场：[`2026-11-10-tool-discovery-handoff.md`](2026-11-10-tool-discovery-handoff.md)、
> 第 1 节现状盘点。实施前不改代码。

---

## 0. TL;DR

- **硬前提（用户定的）**：不能要求任何其他插件配合。它们不会加字段、不会注册、不会改名字。
  → discovery 只能用它**运行时能看到的东西**工作。
- **discovery 能看到的只有**：工具名、工具描述、参数 schema、是否 MCP 命名、是否在注册表里。
  **看不到**"这个工具来自哪个插件"（DSH 0.2.2-rc.1 没有 origin/plugin id/metadata，§3.4）。
- **v2 的三条自动规则**（全部不需要配合）：
  1. **藏**：除"基础工具清单"外，所有工具默认从模型请求里移除（`restrict`），装完即生效；
  2. **归**：按**名字自动聚类**——MCP 按 server 约定成组；其余工具按共同词自动成组
     （`browser_*`→`browser`、`*_goal`→`goal`、`schedule_*`→`schedule`…）；组名/描述机器生成；
  3. **搜**：`search_tools` 按名字/描述/组名确定性打分，命中即加载；**query 精确等于组名时整组加载**
     （默认上限 30），解决 `browser` 25 个工具一次装不完的问题。
- **唯一需要人给的知识**：一张"永远可见"的基础工具清单（bash/read/write/…）。
  它在 discovery 配置里（有内置默认），**只含 DSH 官方基础工具，不含任何插件知识**。
- **代价（诚实说）**：组名/组描述没法定制，是机器起的（`dsh_*` 会归成 `dsh` 而不是 `dsh-host-ops`）；
  operator 的 browser 三层会合并成一组 `browser`（25 个）——整组加载补回速度，但分层带来的
  "先装 core 16 个"的注意力优化消失，需用 eval 验证是否可接受。
- **谁都不用改**：operator 不用改 provider、host-ops 不用发版、官方插件不用动；
  operator 之前打的临时补丁直接删掉即可（v2 自动归组，不需要替代物）。
- **目标不以现状为参照**：现状是"坏方案"的产物，只当噪声底线；验收按**业界参照 + oracle 上界**的
  绝对指标卡（能力选择准确率 ≥95%、遗漏率 0、setup 步数 P90 ≤1、context 降 ≥85%、任务成功率 100%/pass³ 等），
  数据与评测方案见 [`2026-11-10-discovery-metrics.md`](2026-11-10-discovery-metrics.md)。
- **可选增强（不阻塞上线）**：`§4.3 来源识别`——自动识别"工具来自哪个插件"，组名能变成插件名
  （`dsh-host-ops`、`operator-provider`）。不改任何插件，但要动运行时探测/静态扫描，复杂且可能不稳；
  建议作为 v2 上线后的独立评估，用户拍板是否值得。

---

## 1. 现状：怎么坏的（v1 = 当前线上版本）

### 1.1 机制回顾

`plugins/dsh-tool-discovery/lib/index.js`（504 行）：

1. `agent/created` / `tools/change` / 每次 search 前，从该 agent 可见 schema 收集目录；
2. 非常驻工具用 `agent.ctx.tools.restrict({ deny })` 从请求里连 schema 移除；
3. `search_tools(query)` 命中后从 deny 放出 → 下一次请求走官方 `tool-addition` 通道；
4. 系统提示加一条动态 note："哪些组被延迟了、各几个"。

机制是对的；**坏在"分组知识"和"常驻决策"被写死在 discovery 源码里**。

### 1.2 六个病灶（证据都在仓库里）

| # | 病灶 | 证据 |
|---|---|---|
| P1 | **中心化硬编码分组**：`KNOWN_GROUPS` 写死 9 个组和匹配模式（`dsh-host-ops`/`browser*`/`dsh-operator`/`schedule`/`goals`/`workflow`/`plugin-dev`） | `plugins/dsh-tool-discovery/lib/index.js:85-140` |
| P2 | **中心化常驻白名单**：`KEEP_RESIDENT` 写死约 30 个工具名 | 同文件 `44-79` |
| P3 | **"装插件要改 DSH 源码"的流程病**：operator 为 browser 分层打了 `.diff` + apply 脚本，改 dsh-dev 源码，随提交 `3799099` 进 HEAD | `operator/patches/0006`、`0007`；`operator/scripts/apply-*`；dsh-dev HEAD |
| P4 | **生命周期 hack**：restriction 归 agent scope，插件重载不自动清 → `globalThis` 登记表；重载后已加载工具 schema 会陈旧 | `lib/index.js:225-246`、`474-478`；host-ops `docs/changes-2026-11-09.md` |
| P5 | **无测试、无观测**：零单测；现状靠外挂 `scripts/tool-surface-audit.mjs` 读会话日志 | — |
| P6 | **搜索非确定性/无缓存**：`localeCompare` tie-break、limit 硬编码 20、每次 search 全量重建目录 | `lib/index.js:408-450` |

### 1.3 现场基线（2026-11-10 live 实测）

`search_tools("zzzznomatch")` 零命中清单 = 当前目录真值：**13 组 / 93 工具**：

```
extensions (23)     mcp-workspace (21)   browser (16)   browser-advanced (5)
mcp-cfapi (4)       browser-capabilities (4)   plugin-dev (4)   schedule (4)
dsh-operator (3)    dsh-host-ops (3)     goals (3)      mcp-cfdocs (2)   workflow (1)
```

其中 `dsh-host-ops (3)` 来自 **NPM 安装的 dsh-host-ops@0.1.0**，组名靠 discovery 源码里 3 个写死的工具名——
这正是"中心知识"最别扭的地方：包已经独立发布，身份却留在别人仓库。

---

## 2. 目标、约束与不变量（v2）

| 编号 | 约束/目标 | 含义 |
|---|---|---|
| G0 | **零配合（最高优先）** | 不假设任何插件（第三方/官方/我们自己的）会改代码或加字段。discovery 只能靠运行时可见信息工作 |
| G1 | **独立性** | discovery 不 import 任何插件；插件也不 import discovery；只通过 DSH core 公共 API 交互 |
| G2 | **自动协同** | 新装插件（npm/link/MCP）后，其工具自动被藏、自动可搜索、自动按名字归组；**永不改 discovery 源码** |
| G3 | 互不影响 | 一个插件的工具/重载/卸载不影响别的插件，也不拖垮 discovery |
| G4 | 生产级 | 契约（本方案的规则/阈值）版本化、异常降级、生命周期确定、可观测、可测试、可回滚 |
| G5 | 简洁优雅（硬约束） | 机制与策略分离；**中心零插件知识**；规则可一句话说完（§5.1） |
| G6 | 质量 > 速度 > 成本（同一取舍面） | 搜索命中率、首载步骤、token 同时看；任何简化不牺牲质量 |

约束：C1 本地不可改 DSH core（app.asar 只读）；C2 目标 DSH 0.2.2-rc.1；C3 纯 Host 插件热部署、不重启 App；
C4 dsh-dev 有他人未提交改动，只提交自己的文件；C5 operator 临时补丁在 v2 回归通过前保持现状。

---

## 3. 关键事实核查（决定"零配合"能做到什么）

> 方法：`scripts/dsh-asar-extract.mjs` 把 app.asar 里 `@deepseek-ai/*/lib/*.js` 全量抽到 `/tmp/dshpkg` 后核对；
> 官方 README 同路径抽取。均可复现。

### 3.1 discovery 运行时**能**拿到什么

- 工具名、描述、参数、`deferLoading`：`ctx.tools.schemas(scope)` / `definitions(scope)`（公开 API）；
- 可过滤工具名：`ctx.tools.view(scope).restrictableNames`（半内部，见 §10 上游提案 2）；
- 事件：`tools/change`、`agent/created`、`agent/disposed`、`agent-preset/selected`；
- 配置与系统提示注入口。

### 3.2 discovery 运行时**拿不到**什么

- **工具来源**：`ToolsService` 没有 origin / plugin id，`schemas()` 投影只有四个字段（§3.4）；
- **工具分类/标签/关键词**：官方 Tool API 没有这些字段；
- **"哪些工具必须永远可见"**：无法从名字可靠判断（bash 与 browser_open 在 API 层没有区别）。

### 3.3 官方 `deferLoading` 与 `tool-addition`（可用，但不是本方案的核心）

- `defineTool({ deferLoading: true })` 存在，会被投影进请求（DeepSeek 适配器发 `defer_loading: true`）；
  但官方文档明确："**declaring a deferred tool does not activate it**"（`dsh-llm` README《Known Limitations》第 6 条），
  激活要靠 agent-loop 的 tool-addition 记录（`dsh-agent-loop` `buildRequest()` 按 header 工具集差集生成）。
- → v2 继续用 `restrict` + tool-addition 做**加载执行器**（所有 provider 可用、真省 schema token）；
  `deferLoading` 只作为作者自选行为，discovery 不依赖、不要求。**它不是分组/发现的载体。**

### 3.4 没有 origin 的直接证据

- `ToolsService.schemas()` = `definitions().map(projectToolSchema)`，projectToolSchema 只输出
  `{name, description, parameters, deferLoading}`；
- system-prompt `assemble()` 也只取这四个字段（`dsh-system-prompt/lib/index.js`）；
- `view()` 的 registration 只有 `{definition, when}`。
- → "按插件来源自动分组"（最干净的零配合方案）**今天拿不到官方数据**，必须靠推断（§4.3/§4.4）。

---

## 4. 路径对比（都在"零配合"前提下）

| 路径 | 做法 | 需要别人配合？ | 分组质量 | 复杂度/风险 | 结论 |
|---|---|---|---|---|---|
| 4.1 中心硬编码（现状） | discovery 里写 `KNOWN_GROUPS`/`KEEP_RESIDENT` | 否（但维护者要改源码） | 高（人工定制） | 低，但流程病（P1/P3） | 拒绝：没根治 |
| 4.2 声明契约（v1 提案） | 插件在工具定义/manifest 里声明组 | **是** | 高 | 低 | **拒绝（用户否决）** |
| 4.3 来源识别 | 自动判断工具来自哪个插件：运行时探测（注册拦截 + 调用栈）或静态扫描已装包源码 | 否 | 中高（组=插件，名字用插件展示名） | **高**：依赖内部行为，脆弱、难测 | 可选增强，不阻塞上线 |
| 4.4 **名字推断聚类（推荐）** | 按工具名自动聚类 + MCP 约定成组 | **否** | 中（组名自动；browser 三层合并） | 低；纯函数、可单测、确定性 | **v2 主线** |
| 4.5 不分组只搜索 | 只藏 + 搜，系统提示不列组 | 否 | 低（模型缺"有什么能力"的感知） | 最低 | 拒绝：质量降 |

**为什么 4.4 是当前最优**：它把"谁是哪个组"从"人工维护的知识"降级成"算法输出"，彻底消除 P1/P3；
分组质量下降有限（§5.2 实测：13 组 → 15 组，主要变化是 browser 三层合并、个别组名变粗）；
而"藏/搜/加载/生命周期/可观测"这些真正影响质量与稳定性的部分全部保留并加强。
4.3 若以后愿意投入可把组名升级成插件名，但**它不是 v2 的前提**。

---

## 5. 推荐方案 v2：纯推断引擎 + 一条可配置基础清单

### 5.1 规则总览

> **除"基础工具清单"外，全部默认藏起来；藏起来的工具按名字自动归类、可搜索、可按组整载。**

1. **藏**：不在常驻清单里的工具 → `restrict` 移除 schema；`search_tools` 命中后放出（官方 tool-addition 通道）；
2. **归**（分层降级，**零配合前提不变**）：
   - **结构线索（有则用）**：MCP server 天然按 `mcp__<server>__` 成组；我们自己的插件可自愿遵守命名/元数据规范；
     未来若 DSH 暴露工具来源/元数据，直接用；
   - **预计算模型（可选）**：目录变化时经 DSH `llm` 服务调一次**远端小模型**产出组名/描述/成员（不是本地模型），
     落盘缓存、失败回退规则；
   - **规则兜底（永远可用）**：按名字自动聚类（§5.2），组名/组描述机器生成；
3. **搜**：确定性打分 + 精确组名整组加载（§5.3）；
4. **常驻清单**：内置默认（DSH 官方基础工具）+ 配置可覆盖/追加（§5.6）；
5. **观测**：`discovery_status` 只读工具（§5.5）。

### 5.2 分组算法（确定性、可单测、无插件知识）

> **分组是"可替换的展示层派生策略"**：`Catalog（工具）/ GroupView（分组）/ Search / Loader / Note`
> 分开，搜索与加载不依赖具体分组策略；将来若 DSH 暴露工具来源，换一个 strategy 即可、其它模块零改动。
> 细化设计（问题清单/边界决策/接口契约/测试与评估）见
> [`2026-11-10-discovery-grouping-design.md`](2026-11-10-discovery-grouping-design.md)。

输入：本 agent 可过滤、非常驻的工具列表；输出：`{groups（≥2 个工具的具名组）, others（单工具/无法归组，按名字列出）, warnings}`。

```
① MCP 约定：mcp__<server>__<tool> → 组 mcp-<server>
② 名字聚类（两遍）：
   第一遍：组键 = 工具名的第一个词（非通用动作词、且该词在目录里出现 ≥2 次）
           例：browser_* → browser；schedule_* → schedule；session_* → session；terminal_* → terminal
   第二遍：剩下的工具，找"任一非通用动作词、出现 ≥2 次"的词作为组键
           例：create_goal / get_goal / update_goal → goal；cordis_inspect_* → cordis
③ 单工具 / 无共同词工具：不硬塞组 → 进 `others`（note 里**逐个列名字**，模型看得到、可直接搜）
④ 永不丢工具：任何解析失败/异常 → others；组数超上限时最小组合并进 others
```

- 组数上限（初定 30）与 **停用词表**（get/set/list/create/update/read/write/search/open/close/…，
  通用英文工具词汇、不含插件名）都在 policy 常量里，可单测、可调；审计脚本保证 discovery 源码
  除基础常驻清单外没有任何插件/工具名。
- 组 id 规范化：小写 kebab（字母数字 `-`），冲突时确定性归并；组描述 = `Tools: name1, name2, …`（不编造）。
- 组顺序：工具数降序 → 组 id 码点升序（确定性，不用 locale）。
- **实测（2026-11-10，用本机 87 个可确认的当前工具名跑原型算法，含"单工具不建组"版本）**：

```
12 个具名组：browser (25)  mcp-workspace (21)  terminal (6)  session (5)
             dsh (4)  mcp-cfapi (4)  schedule (4)  goal (3)  operator (3)
             cordis (2)  mcp-cfdocs (2)  plugin (2)
others (6)：ralph, workflow, propose_action, run_code, channel_workers, create_worktree …
```

对比现状 13 组：browser 三层合并为 1 组、`dsh-host-ops` 变成 `dsh`（与其它 `dsh_*` 同组）、
plugin-dev 拆成 plugin/cordis、goal 自动成型；差异全部可解释、无任何硬编码。

### 5.3 搜索与加载（确定性、可测）

- token 化：小写 + 按非字母数字切；打分（整数）：

| 命中位置 | 分 |
|---|---|
| 工具名包含 token | +6 |
| 工具描述包含 token | +2 |
| 组 id 包含 token | +4 |
| 组描述包含 token | +2 |

  （无声明关键词字段——零配合；搜索质量靠工具自身描述，desc 权重 +2 保留）
- tie-break：分降序 → 工具名码点升序 → 组 id 码点升序（不依赖 locale，可复现）；
- **整组加载**：query（trim+小写）精确等于某组 id → 加载该组全部工具，上限 `groupMaxResults`（默认 30，
  保证 browser 25 一次装完）；普通搜索上限 `maxResults`（默认 6，最大 20）；
- 零命中：返回组清单（组 + 计数 + 自动描述）；
- 输出：`Loaded N tool(s) for this session — call them directly now:` + 每行名 + 截断描述；
  有多命中时提示可缩窄 query / 提高 limit。

### 5.4 引擎与生命周期

| 模块 | 职责 |
|---|---|
| `lib/policy.js` | 纯函数：分组聚类、常驻判定、打分排序、note 生成、目录指纹 |
| `lib/index.js` | 装配：注册工具、监听事件、每 agent 状态、restriction 收敛、系统提示 note |

- **目录构建**：同一同步 tick 内先释放本实例 restriction → `definitions(scope)` 读全量 → 重建目录 → 重装 restriction；
  目录按"工具表指纹"（name/description/deferLoading 稳定哈希）缓存，指纹不变不重建；search 不再全量重建（治 P6）；
- **加载执行器**：`deny = 按需目录 − 已加载`；新 restriction 装好再拆旧的（防"全可见窗口"）；
- **生命周期**：restriction 由插件实例 effect 持有（替代 `globalThis` hack，治 P4）；`agent/disposed` 释放；
  `tools/change` / preset 切换重建；插件卸载/重载确定性释放；
- **错误降级**：元数据/工具名异常、restriction 失败（未知名字/own-layer）→ 剔除重试，仍失败则降级为"该批保持可见"
  + 状态工具告警，**绝不把错误抛进 agent-loop**；
- **own-layer 工具**（Agent Teams 等）不可 restrict → 自动排除、保持常驻（现状语义）；
- 已知约束：`restrictableNames` 目前只有半内部 `view()` 能拿（§10 上游提案）。

### 5.5 可观测性

新增常驻工具 `discovery_status`（只读、纯文本）：

- 当前目录：组 id / 工具数 / 是否 MCP 组 / 聚类键；
- 当前 agent：已加载工具、剩余按需数、restriction 健康（deny 数/最近错误）；
- 配置摘要（resident 清单来源、maxResults、groupMaxResults、promptNote）；
- 告警：无法解析/无法 restrict 的工具名；自动归组失败的兜底清单。

> 现有 `scripts/tool-surface-audit.mjs`（读会话日志的独立视角）保留。

### 5.6 配置（只保留一个"知识入口"）

```yaml
- id: tool-discovery
  name: '@local/dsh-tool-discovery'
  config:
    resident: null            # null = 内置默认基础清单；传数组则整体覆盖
    extraKeepResident: []     # 追加常驻（glob）
    extraDeferred: []         # 强制按需（glob）
    maxResults: 6             # 普通搜索上限（默认 6，最大 20）
    groupMaxResults: 30       # 整组加载上限（默认 30，覆盖 browser 25）
    promptNote: true          # 系统提示动态 note 开关
```

- **基础清单**是唯一保留在插件里的"知识"，只含 DSH 官方基础工具
  （bash/read/write/edit/glob/grep/read_image/ask/todo/skill/job/web/…/subagent/send_message/mcp 资源/Agent Teams）；
  不进任何第三方/自有插件的工具名。
- 清单做成配置而非硬编码：DSH 升级若新增基础工具，用户/我们不用改插件源码，改配置即可；
- 插件版本 `0.2.0`；无 client 半边 → 不重启 App，bundle 关→开生效。

### 5.7 已知限制（诚实清单）

- 组名/组描述不可定制（机器生成）；`dsh_*` 类前缀会得到较粗的组名（如 `dsh`）；
- operator 的 browser 三层分层消失（合并为一组 25 个）——整组加载保速度，但"先装 core 16"的注意力优化消失，
  需用 operator eval 验证；
- 单工具/无共同词工具不进组，在 note 里以名字列出（`others`），系统提示会多一行小字；
- 通用动作词表是启发式，个别工具可能落 `extensions`（仍可搜到，只是组名不具语义）。

---

## 6. 迁移（v2 上线要动的东西）

### 6.1 dsh-dev（本会话负责）

1. 重写 `plugins/dsh-tool-discovery/lib/`（index + policy + 测试入口）；
2. **删除** `KNOWN_GROUPS` 全部中心知识；`KEEP_RESIDENT` 变成配置默认值 `DEFAULT_RESIDENT`；
3. 删除 dsh-dev HEAD 里 operator 临时补丁的连带内容：`scripts/audit-plugin-presentation.mjs` 的
   `TIER_GROUPS` 断言、`docs/06`/`docs/08`/`plugins/README` 的 browser 分层描述（改为 v2 机制描述）；
4. 新增 `scripts/verify-tool-discovery.mjs`（纯函数 + 假 ctx 行为测）、
   `scripts/verify-tool-discovery-schema.mjs`（用真实 `@deepseek-ai/dsh-tools` 编译工具定义，模式同 host-ops）；
5. 审计脚本新规则：**discovery 源码不得出现任何插件工具名**（基础清单项必须命中官方工具白名单）
   —— 反过来把"中心知识为零"变成可执行断言；
6. 更新 `docs/06` §10、`plugins/README.md`、插件页 `locale/*.json` + `docs/detail*.md`。

### 6.2 operator（另一工作区）

- **代码零改动**（v2 自动把 `browser_*` 归成 `browser` 组）；
- 清理临时物：删 `patches/0006`、`0007`、`scripts/apply-tool-discovery-browser-*.sh`、
  `scripts/verify-tool-discovery-browser-tiers.mjs`，notes 顶部标注"已由 v2 取代"；
- v2 部署后跑一轮 eval（首载 search 次数目标 ≤ 现状、7 任务成功率不退化）；若质量有退化，再讨论是否
  用 §4.3 来源识别或其他补偿（不在 v2 范围内）。

### 6.3 dsh-host-ops（NPM）

- **零改动**：0.1.0 继续用；v2 会把 3 个工具自动归成 `dsh` 组（与其它 `dsh_*` 同组）。
- 若以后做 §4.3 来源识别，它会自动变成 `dsh-host-ops` 组，仍然不需要 host-ops 改代码。

### 6.4 官方/第三方插件

- 零改动、零感知。它们的新工具在下次 `tools/change` 自动进入目录与分组。

---

## 7. 测试与验收

| 层 | 内容 |
|---|---|
| 纯函数单测 | 聚类（含 MCP/两遍/单词名/兜底）、锚定 golden（用 §5.2 真实名字做固定输出）、打分排序、指纹、note 格式 |
| 假 ctx 行为测 | 目录构建/restriction 收敛/加载/生命周期（agent 生命周期、tools/change、重载清理、错误降级、整组加载） |
| schema 测 | `search_tools` / `discovery_status` 用真实 dsh-tools 编译（防装上去才炸） |
| 契约审计 | discovery 源码零插件名；基础清单项只含官方工具 |
| 端到端 | scratch profile 装"哑插件"（2 个工具，无任何声明）→ 自动被藏 + 自动归组 + 可搜索加载；bundle 关→开无陈旧 schema；卸载后工具恢复可见 |
| 质量/速度 | **新写能力发现 benchmark**（见 [目标指标与评测](2026-11-10-discovery-metrics.md)）：任务不点工具名、独立核验、k=3 重复；对照臂含 **oracle 分组（质量上界）** 与 **全量加载（成本下界）**；从会话日志抽 search 次数/加载集合/后续调用/token/步数/墙钟 |

**验收标准**（**不以现状为参照物**；现状 v1 只作噪声底线）：

- [ ] discovery 源码中没有任何插件/工具名（基础清单项经白名单审计）；
- [ ] 新装哑插件（零配合）→ 工具自动被按需加载、自动归组、可搜索；discovery 零改动；
- [ ] **质量**：能力选择准确率 ≥95%、能力遗漏率 0、一次搜索命中率 ≥95%、误装率 ≤10%、任务成功率 100% 且 pass^3=100%；
- [ ] **速度**：setup 步数 P90 ≤1（简单任务 0）；任务墙钟与 oracle 上界差 ≤15%；
- [ ] **成本**：首请求 schema token 对比全量加载降 ≥85%；常驻工具 ≤14 个/≤4K tokens；总 token 对比 oracle ≤+10%；
- [ ] **可维护/正确**：零硬编码插件名、100% 新插件自动归组、100% 确定性、重载/卸载 0 残留；
- [ ] 结论按"离 oracle 上界差多少"表述，不写"比现状好";
- [ ] 单元/假 ctx/schema/审计全绿；docs 同步；回滚演练通过。

---

## 8. 里程碑

| 里程碑 | 内容 | 估算 |
|---|---|---|
| M0 验证 | ① 建"能力发现 benchmark"骨架（任务不点工具名 + 独立核验 + 会话日志抽指标）——**已就位**（`benchmark/discovery/`）；② 跑 P0 冒烟 + **oracle 分组 / 全量加载** 两个上界臂定目标线；③ scratch profile 探针：名字聚类输出确认、bundle 关→开生命周期 | 1 天 |
| M1 内核 | 重写 discovery（policy/index）+ 配置 + `discovery_status` + 三层测试 | 1–1.5 天 |
| M2 清理迁移 | dsh-dev 删临时补丁连带内容；operator 删临时物（协调）；文档/审计 | 0.5 天 |
| M3 回归上线 | operator eval、tool-surface-audit、桌面热部署、回滚演练 | 0.5 天 |
| （可选）M4 增强 | §4.3 来源识别可行性实验（不改插件），评估后决定是否纳入 | 另议 |

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| R1 聚类不理想（组名粗/个别落 extensions） | 算法纯函数 + golden 单测；停用词表可调；质量由 eval 守门；必要时再做 §4.3 |
| R2 browser 分层消失导致 operator 质量/速度退化 | 整组加载 cap 30 保速度；跑 operator eval 实测，数据说话 |
| R3 基础清单随 DSH 升级漂移 | 清单放配置、默认值可覆盖；状态工具显示实际常驻项 |
| R4 生命周期（重载/卸载）残留 restriction | 插件实例 effect 所有权 + tools/change 重建 + M0 实测 |
| R5 首请求 token 变化 | 常驻集合不变、note 同量级；验收门禁量化 |

**回滚**：git 保留 v1 源码（HEAD `3799099`），`plugin_manager` 关→开装回 v1；无 client 变更不重启；
operator 临时补丁在验收通过前不删（回滚 = 重新应用，脚本幂等）。

---

## 10. 上游提案（可选，不阻塞）

1. `ToolsService` 暴露**工具 origin**（注册来源插件 id/包名）→ 零配合的分组可升级为"插件级"（§4.3 的正规形态）；
2. 公开 **`restrictableNames`**（现在只有半内部 `view()`）→ discovery 判定可延迟集合不再依赖内部结构；
3. （长期）官方 tool-search / 激活原语 + `defer_loading` 服务端语义 → 请求前缀稳定、KV cache 更友好。

---

## 11. 当前状态与待定事项

用户 2026-11-10 明确：**先把 discovery 自己的机制设计透，再谈具体取舍**；operator 正在重构、与本设计解耦；
因此以下要等"分组机制 + 测试/模拟数据"就绪后再拍板，不在设计阶段提问：

1. `maxGroups` / `others` 名单长度 / note 是否保留 others 名单（token ↔ 可发现性）；
2. `groupMaxResults` 默认值（30 是否覆盖大多数族）；
3. 停用词表初版范围；是否需要"可选配置覆盖组"（给想定制的人后路，不要求插件配合）；
4. 是否在 v2 后评估 §4.3"来源识别"增强（组名变插件名；不改插件但复杂/可能不稳）。

已确定、无需再议的约束：零配合（不要求任何插件改代码/加字段）、discovery 独立插件、
分组是展示层派生策略（可替换）、基础常驻清单可配置。

---

## 附录 A：原型算法实测输出（本机当前工具名，2026-11-10）

```
browser (25)        mcp-workspace (21)   terminal (6)      session (5)
dsh (4)             extensions (4)       mcp-cfapi (4)     schedule (4)
goal (3)            operator (3)         cordis (2)        mcp-cfdocs (2)
plugin (2)          ralph (1)            workflow (1)
```

说明：取自本机会话日志可确认的 87 个当前工具名（另有 6 个 extensions 工具名未采到，不影响示例）；
`dsh` 组 = dsh-host-ops 3 个 + hello-dsh 的 1 个（后者是测试插件，正好演示"零配置自动收编"）。

## 附录 B：证据索引

- 现状源码：[`plugins/dsh-tool-discovery/lib/index.js`](../plugins/dsh-tool-discovery/lib/index.js)
- 官方 Tool API / 投影：app.asar → `dsh-tools/lib/index.js`（`defineTool`/`projectToolSchema`/`register`/`definitions`）、
  `dsh-system-prompt/lib/index.js`（`assemble()`）、`dsh-scope/lib/index.js`（`NamedEntries` "Values are borrowed"）
- 官方 `deferLoading` / tool-addition：`dsh-tools/README.md`、`dsh-llm/README.md`（Known Limitations 第 6 条）、
  `dsh-llm-deepseek/README.md`、`dsh-llm-deepseek/lib/index.js`（`defer_loading` 投影）、
  `dsh-agent-loop/lib/index.js`（`buildRequest()`）
- 交接文档：[`2026-11-10-tool-discovery-handoff.md`](2026-11-10-tool-discovery-handoff.md)
- 现状机制文档：[`docs/06-能力装配与按需加载.md`](../docs/06-能力装配与按需加载.md) §10、
  [`plugins/dsh-tool-discovery/README.md`](../plugins/dsh-tool-discovery/README.md)
- operator 临时补丁/评测：`/Users/chuang/Documents/deepseek-harness/operator/patches/0006*`、`0007*`、
  `operator/notes/2026-11-10-tool-discovery-tiers.md`、`operator/notes/2026-11-10-quality-speed.md`
