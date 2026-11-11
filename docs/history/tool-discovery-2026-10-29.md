# 决策记录：撤掉 task presets，改走按需发现（tool search / 延迟 schema）

- 日期：2026-10-29
- 决策人：用户（"先把我们之前的方案全都撤掉，朝着业界经过验证的终局走"）
- 落地：`@local/dsh-task-presets` 已从 `desktop` profile 卸载；
  新插件 [`plugins/dsh-tool-discovery/`](../plugins/dsh-tool-discovery/) 已安装并实测。
- 相关文档：[`docs/06-能力装配与按需加载.md` §10](../docs/06-能力装配与按需加载.md)。

## 1. 问题（用户 2026-10-29 复述）

DSH 本身提供了 agent preset，我们当初的想法是：随着需求增长，工具（MCP server 等）会越来越多；
工具越多 → context 越大、成本越高、模型选工具/做任务的准确率越差。所以我们做了一个"按任务预分组工具"的方案。
实际用了几天后发现：**这个解法不好**，想找更好的。

## 2. 为什么撤掉（数据）

task-presets 于 2026-10-16 上线，10-29 撤除，期间（10-16 → 10-29）的实际使用：

| 指标 | 数字 |
|---|---|
| 顶层（人发起 / 探针）新建会话 | 209 |
| 其中 `standard` | 189 |
| 其中自定义 preset | 20 —— **18 条是我们自己的探针/验收，真正干活的只有 2 条** |
| 子会话/队友会话 | 82（43 条非 standard，由 agent 侧机制带上 preset，不是人选的） |

- 真实用到预设的 2 条：2026-10-19 voice-layer 调研（local-dev）、2026-10-27 Cloudflare 修复（cloudflare）。
- 连 fal-studio 这个专属工作区：10-16 后 28 条顶层会话里 **26 条是 standard**（另 2 条是验收探针）——
  实际创作全程跑在 standard 上。
- 收益大头来自与 preset 无关的动作：MCP 行搬出 profile 顶层 + 关掉 github——`standard` 从 84 个工具
  （43 原生 + 41 MCP）降到 42 个工具（0 MCP）。preset 只剩 fal-studio −13 个工具的边际收益，
  而那个 preset 的消费者是 agent 起的子会话。
- 成本：每次新建任务要看/选一次（10 个选项的 chip）；6 份自包含底座；App 升级要手工 diff
  （10-17 升级时 `{{cwd}}` 变更导致新建族会话首轮报错）；host 层能力还要另写一套 preset 门控。

**结论：preset 错在把"工具增长"解成了"人工选择 + 预分组维护"，而不是让工具按需出现。**

## 3. 新方案：dsh-tool-discovery（DSH 原生原语拼出的 tool search）

1. `cfapi` / `cfdocs` / `workspace` 三个 MCP server 常驻 profile 顶层（连接只起一次，进程开销固定）；
2. 插件在 `agent/created` 时，对匹配 `patterns`（默认 `mcp__*`）的工具
   `agent.ctx.tools.restrict({ deny })` —— 隐藏的工具**连 schema 一起**从模型请求消失；
3. 常驻工具 `search_tools(query, limit?)`：按工具名/描述打分，命中后把工具从 deny 集合放出；
4. 下一次请求就带上新工具，走 DSH 既有 `tool-addition` 投影
   （`deepseek-flash` 的 `toolUpdate: "addition-only"` + `mid-conversation-tool-changes-2026-07-01` beta）；
5. 系统提示加一条动态短提示（order 300）：有 N 个能力工具被延迟，用 `search_tools` 加载；
6. 只对当前 agent 生效，子会话各自发现（可接受的隔离；后续可做继承）。

对应业界终局：常驻少量核心工具 + 一个发现入口 + schema 按需加载；工具目录可以无限增长，
而请求里的 schema 数量有上限。

## 4. 实测证据（2026-10-29）

1. `install_bundle` 返回 `application: "applied"`、`warnings: []`；
   `Config.listConfigs` 可见 `mcp-cfapi` / `mcp-cfdocs` / `mcp-google-workspace` / `dsh-tool-discovery` 四行。
2. 安装瞬间本会话（已存在的 agent）的 tool schema 里 `mcp__*` 全部消失（27 个被延迟），
   多出 `search_tools`，系统提示出现 "Some capability tools are deferred and not loaded (27 tool(s))…"。
3. 本会话调用 `search_tools({ query: "cloudflare documentation search", limit: 2 })` → 下一次请求
   出现 `mcp__cfdocs__search_cloudflare_documentation` 与 `mcp__cfapi__search`；
   调用 `mcp__cfapi__search` 返回真实数据（`totalPaths: 2364`）。
4. **新会话探针**（`probe-tool-discovery`，已归档）：
   - 首请求 `request/header.tools` = **46 个，0 个 MCP**，含 `search_tools`；
   - 模型在只被告知任务（查 Cloudflare D1 存储上限）、**没有被点名工具**的情况下，
     自主调用 `search_tools({ query: "cloudflare docs d1 limits storage", limit: 10 })`；
   - 下一请求 = **52 个工具（+6 MCP）**，随后调用
     `mcp__cfdocs__search_cloudflare_documentation` 并给出正确结论；
   - `turn/end: completed`。

4. **子会话门控**：新建 subagent（`819904e1…`）首请求 = **40 tools / 0 MCP / 有 `search_tools`**
   —— 门控对子会话同样生效（每个 agent 各自发现）。
4b. **运行中的 agent 也会被收口**：安装时正在跑的调研子代理，其下一请求从 36 tools 变成
   40 tools（多出 `search_tools`，MCP 仍为 0）——restriction 对已存在 agent 的下一份请求生效。

### 4.1 源码核对（2026-10-29，逐行核对 0.2.1-rc.3 解包源码）

- `tools.restrict({ allow?, deny? })`：**名字数组、不是谓词**；必须 scoped（`agent.ctx`）；
  返回精确 disposer；多次调用取**交集**；dispose 后视图立即恢复（下一请求生效）；
  **未知名字在调用时即抛**（所以 `deny` 对"之后才注册的工具"无效，必须在 `tools/change` 上重装
  ——我们的实现就是这样；`allow` 天然覆盖未来名字，但会连未来新增的 host 工具一起挡掉）。
- 工具注册表**没有 list/definitions API**；唯一公开枚举是 `ctx.tools.schemas(scope?)`
  （只给可见集）——本插件用它构建搜索目录。`tools/change` 事件 payload 是 `void`。
- 会话中途工具集变化：agent-loop 在 `buildRequest` 里 diff `request/header` → 写
  `developer/message`（`source.kind = "tool-registry"`，additions 带 `headerSeq`）→
  DeepSeek Messages 适配器转成 system 角色 `tool_addition` / `tool_removal`，并带
  `anthropic-beta: mid-conversation-tool-changes-2026-07-01`。
  **只有 `deepseek-flash` 声明 `toolUpdate: "addition-only"`**；`deepseek-v4-pro` 未声明 →
  工具变化会强制新 request series（功能正确，但前缀缓存失效）。
- **`defer_loading` 不是本地懒加载**：注册表从不读它，schema 仍会完整发出；真正把 schema
  从请求里拿掉的是 `restrict`。MCP 工具**无法**设置 `deferLoading`（MCP client 的 Config 没有该字段）。
  → 本方案用的是 `restrict`，不要把它宣传成 `defer_loading`/provider 侧延迟。
- MCP 工具必须挂在**全局/祖先层**才能被 agent 的 `restrict` 隐藏；挂在 `agent.ctx` 下的
  own-layer 注册会免疫同 scope 的 restrict（本方案把 MCP 行放 profile 顶层，正确）。

## 5. 工具增长的长期原则（从这次失败里留下的纪律）

1. 新能力优先做成 **CLI / skill**（0 schema 或渐进披露），而不是新 MCP tool；
   成功先例：github MCP 14 个工具 → `gh` CLI。
2. MCP 必须有：先用 server 端 toolset 裁剪；放不进 discovery 的按需模式就别加。
3. 定期按 `request/header.tools` 复盘"从未调用"的工具，删掉比分组收益大。
4. 工具量级真的很大时，DSH 原生 PTC（`run_code` + SDK）是另一条 schema 恒定路线。

## 6. 最终范围落地（2026-10-29，Phase 1 + Phase 2 + 自动分组）

用户决策：**统一策略，不按工作区做例外**；核心基本盘常驻，其余默认按需。
**分组不再需要维护**（2026-10-29 定稿）：插件在 agent 创建 / 工具表变化 / 每次 search 前，按注册名
自动推导 group：

- 命中内置常驻白名单 → 永远可见；
- `mcp__<server>__<tool>` → 自动组 `mcp-<server>`（**新装 MCP server 自动成组，零配置**）；
- 非 MCP 命中内置已知组（`dsh-ops` / `browser` / `schedule` / `goals` / `workflow`）→ 已知组名；
- 其余 → `extensions` 兜底（仍可被搜索到）。

实测（新标准会话首请求）：**34 tools / ≈6.3K token / 0 个 MCP**（改前 83 / ≈22.7K，−72%）；
系统提示自动列出 `mcp-workspace (21), browser (10), dsh-ops (4), mcp-cfapi (4), schedule (4), goals (3), mcp-cfdocs (2), workflow (1)`
（前三个 MCP 组全部是现场从工具名推导的）；`search_tools("gmail")` 命中 6 个工具 → 下一请求 40 tools。
Phase 1（host 面）与 Phase 2（agent 面，`ctx.tools.schemas(scopeOf(agent.ctx))`）都覆盖。

维护模型：只保留两类动作——① 某工具必须永远可见时往 `extraKeepResident` 加一行（罕见）；
② 可选的质量调优（给 `extensions` 里某类工具补一个已知组描述）。新增 MCP/插件工具本身**不需要任何配置**。
审计：`node scripts/tool-surface-audit.mjs`（只读）输出常驻工具/体积 + 按需组与数量，用来发现"有没有东西偷偷常驻"。

## 6.1 已知限制（必须知道）

- **Agent Teams（spawn_teammate / wait_agent / team_task_*）不能延迟**：实验插件通过 `agent.ctx`
  注册进 agent **own-layer**，而 `restrict` 只过滤继承层（global + 祖先），把这些名字放进 deny 会让
  整个 restriction 抛 unknown、一条都装不上。
  **决策（2026-10-29，用户拍板）：这 6 个工具直接常驻**（≈1.0K token），不为它们再做额外机制——
  Team 工具是团队流程入口，常驻比"省 1K token 但模型要搜"更简单也更安全；Phase 3 取消。
- **插件重载会留孤儿子 restriction**：restriction effect 归 agent scope，bundle 关→开不会自动清；
  本版用 `globalThis` 登记表 + 卸载时 cleanup 兜住。但**修复之前**已打开且仍活着的会话可能残留
  旧实例的 restriction（表现为 search_tools 只能看到一部分能力）；重启 App 一次即可彻底清掉，
  新 agent 不受影响。
- 子会话不继承父会话已加载集合（每个 agent 自己 search）。
- MCP 工具异步注册：每次 `search_tools` 前会重建目录兜底（reset）。

## 6.2 可选的下一步

- ~~Phase 3：assembly 过滤解决 Agent Teams own-layer 的延迟~~ —— **已取消**（Agent Teams 直接常驻）。
- ~~surface 维护~~ —— **已解决（自动分组）**：新增 MCP/插件工具零配置；唯一的常驻白名单
  （`extraKeepResident`）只在"必须永远可见"时加一行；审计脚本兜底发现异常。
- 子会话继承：在 `agent/created` 读父会话的已加载集合（省一次搜索）。
- 评测：5 个真实任务 A/B（cloudflare / gmail / 会话管理 / 调研 / 发帖），看额外 search step 数与完成率。

## 7. 回滚（历史记录）

- task presets 方案已于 2026-10-29 撤销、2026-10-30 彻底清理（bundle、一次性脚本与备份均已删除），
  **不再保留恢复路径**；此节只存档当时的回滚思路。
- 回退到"全量 MCP 常驻"：把 `dsh-tool-discovery` patch 里 `patterns` 改成 `[]`（或卸载该 bundle，
  改由各集成 bundle 常驻自己的 MCP 行）。
- **卸载的已知副作用（2026-10-29 实测）**：历史会话日志里记录的 preset ID 在卸载后失效，App 重启后再打开
  这些会话会报 `Unknown agent preset: <id>`（外层 `gateway/internal`），无法 resume。本次已用日志迁移
  修好 87 条（含最早的 `f54bf058`），方法与验证记录见
  [`session-preset-missing-repair-2026-10-29.md`](session-preset-missing-repair-2026-10-29.md)。

## 8. 效果实测（2026-10-29 20:44，6 个真实任务）

方式：全部新标准会话（默认 preset，不给 search_tools 提示），中文任务描述；指标全部从会话日志取；测完归档。

| 任务 | 首请求 schema | search 次数 | 命中组 | steps | 结果 |
|---|---|---|---|---|---|
| Cloudflare（查 cfapi D1 建库接口） | 34 tools / ≈6.1K | 1 | mcp-cfapi ✅ | 3 | ✅ 完成 |
| Google Workspace（最近日历事件） | 同上 | 1 | mcp-workspace ✅ | 6 | ✅ 完成（迭代了日历列表，多 3 步） |
| DSH 运维（列最近会话标题） | 同上 | 1 | dsh-ops ✅ | 22/7（两次都未收敛） | ⚠️ 发现正常但用不对：模型改去 bash 翻 storages，被取消 |
| 提醒（创建→确认→删除） | 同上 | 1 | schedule ✅ | 6 | ✅ 完成 |
| 浏览器（打开 example.com） | 同上 | 1 | browser ✅ | 4 | ❌ operator_open 超时 180s（operator 扩展自身问题，非发现层） |
| 对照组（网上查 DSH 是什么） | 同上 | 0 | — | 3 | ✅ 完成（不需要搜就没有额外步骤） |

结论：
- **常驻 schema 一致 34 tools / ≈6.1K token**（全常驻对照值 83 / ≈22.7K）。
- **发现 5/5 命中**：需要延迟能力的 5 个任务都只搜了 1 次就命中正确组（模型自动把中文任务翻成英文关键词）。
- **执行成功 3/5**：Cloudflare / Google / 提醒完成且调用正确；浏览器失败于外部 operator 超时；
  DSH 运维任务发现没问题，但 `dsh_session_manage list` 不带 workspaceId 返回 520 条全量会话，
  模型转去 bash 翻 `~/.dsh/storages`，两次都没收敛（工具 UX/行为问题，不是发现层）。
- **额外开销**：需要延迟能力的任务基本 +1 个 search step；对照组零开销。

后续（可选）：
1. `dsh_session_manage list` 无 workspaceId 时返回按工作区分组摘要（或要求/提示传 workspaceId），减少模型乱翻；
   或在 `dsh-ops` 组描述里加一句使用提示。
2. 单独排查 operator 扩展：`operator_open` 180s 超时（与 discovery 无关）。
3. 修完后重跑第 3 个任务；如需要再跑"全常驻 vs 按需"的 A/B。

## 9. dsh-ops 易用性修复（2026-10-29 晚，已生效并复测）

问题：§8 第 3 个任务（列最近会话标题）两次都跑偏——`dsh_session_manage list` 不带 scope 返回全量 520 条，
模型不知道要传 workspaceId，转去 bash 翻 storages，22 步未收敛。

修复（子会话完成，Lead 复核 diff + 跑测试 + 重组 bundle）：
- `list` 不带 workspaceId/cwd 时 → 按工作区分组摘要（每区一行：标题、短+完整 id、会话数、未归档数、最近一条），
  末尾提示"传 workspaceId 或 cwd"；传 scope 时保持扁平列表、默认 limit 50、表头带工作区标题，且支持 `cwd` 反查；
- `dsh-tool-discovery` 的 `dsh-ops` 组描述补上使用提示；
- 测试：`verify-dsh-workbench.mjs` 287/287（+28）、check-plugins 8 bundle 全通过、schema 39/39。

复测（`perf-3d-dshops`，修复生效后新会话）：
- 首请求 34 tools / 0 MCP（与基准一致）；
- calls：`search_tools` → `dsh_session_manage{action:'list', cwd:'.../dsh-dev', limit:10}`；
- **3 steps / 2 calls 完成**，直接取前 5 条标题（修复前：22 steps 未收敛）。
- 结论：dsh-ops 任务从"跑偏"变为"一次搜索 + 一次 list 收敛"。
