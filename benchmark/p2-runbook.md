# P2 执行手册（全策略锦标赛：含 BM25 / Jev / Agent / 组合）

> 目标：把**所有候选策略**放到同一套任务上跑（粗筛 1 次 → 决赛 2–3 次），用数据选最优。
> 生产默认是 `rules`；P2 期间 `strategyFile` 钩子生效——**每批跑完必须把 arm 文件写回 `rules`**。
> 纪律：不改插件源码/其它配置/bundle；只允许 `read`、`bash`（run.mjs + 写 arm 文件 + cat/ls）、
> `dsh_session_manage`（start/wait/archive/cancel）、`search_tools`/`discovery_status`。

## 0. arm 文件格式

`benchmark/discovery/arms/current.json`（每次整份覆盖写，示例）：

```json
{ "strategy": "bm25", "note": "P2 screen: bm25" }
```

支持/已评估策略：
- ✅ 已测：`rules`（基线）、`bm25`、`rules-bm25`；
- ⛔ 外部线（本机环境不可用，结果归档到 `results/unavailable-external/`，不参与最终对比）：
  `jev-precompute` / `jev-online`（OpenRouter decisions 529 过载）、`llm-precompute` / `llm-online`（一次性 LLM 调用，用户已决策放弃）；
- 🧪 真 agent：`agent-precompute`（子代理生成目录 → oracle 策略消费后实测）；`agent-online`（待实现）；
- 其余：`full-combo`（Jev 层不可用时会退化为 rules+BM25）、`oracle`/`minimal` 尺子、`legacy`。

写入后：跑一两次 `search_tools` 或 `discovery_status`，确认 `strategy` 已变（同一 agent 在目录重建时读取文件）；
**任务会话都是全新会话，一定使用新 arm**。

## 1. P2 粗筛（每个 arm × 6 任务 × 1 次）

任务子集（省时、覆盖主要能力族）：

```
host-ops-session-list      # 宿主操作
docs-workers-limit         # Cloudflare 文档（MCP）
terminal-echo              # 持久终端
goal-set                   # 目标（可 cancel 解锁归档；避免 schedule 的 10 分钟阻塞）
session-search-count       # 会话搜索
workspace-calendar-count   # Google Workspace MCP（21 工具里找对）
```

每个 arm 的流程：

1. 写 arm 文件（整份覆盖）；
2. 跑 `search_tools`（query=`dsh session`, limit=5）→ 确认 `dsh_session_manage` 可用；
3. `discovery_status` 记录：`strategy`、`catalogTotal`、`pendingGroups` 数量、`external.stats`（有就记，用于判断外部层是否真的跑起来/降级）；
4. 对 6 个任务逐个跑：`bash` 跑 `node benchmark/discovery/run.mjs begin --arm <arm> --task <task> --rep 1` → 读 `<cwd>/PROMPT.txt` → `dsh_session_manage` start/wait（timeout 300000）→ `bash` finish → archive（schedule/goal 阻塞时 cancel 后 archive）；
5. 每任务记录一行指标（同 runbook.md §4）。
6. 该 arm 跑完，**写回 `rules`**（如果下一个 arm 紧接着跑，可以直接覆盖成下一个 arm，但每批结束必须是 rules）。

报告：每个 arm 一段（strategy 旁证 + 6 任务表 + 汇总 + invalid/降级说明）。

## 1.5 防跨 run 泄漏（2026-11-10 Batch A 发现）

- `run.mjs begin` 现在会先清空 `work/` 下的旧实验目录（只保留当前 run），避免任务会话读取其它 arm 的答案文件；
  证据仍保留在 `results/*.json`（含 prompt/指标/核验明细）。
- 任务会话仍可能读到 `results/` 里的元数据（没有答案），忽略即可；不要在 prompt 里提示其它目录。

## 2. 外部层（Jev / 大模型）的判读

- `discovery_status.external` 字段：
  - `decisions/chat = true` 只表示"配置了端点/模型"，**不代表 key 可用**；
  - `stats.enrichRuns / enrichCacheHits / enrichFallbacks / onlineCalls / onlineFallbacks` 才说明实际行为；
  - `warnings` 里有 `external-fallback` = 外部层失败已回退规则（**这是可测的降级，不是 arm 缺陷**，计入"降级次数"）。
- 若 `jev-precompute` 的 `stats.enrichFallbacks` 持续增长：说明 Jev 不可用/输出了不合法结果，照实记录；
  该 arm 指标等价于 rules（因为回退），报告里要写清楚。
- **禁止**任何读取凭据文件/打印 key 的操作；凭据只允许插件内部通过 `ctx.credentials` 使用。

## 3. 决赛（粗筛后由 Lead 决定）

- 取粗筛里质量不差、速度/成本最好的 2–3 个 arm（+ `rules` 基线），每个 × 10 任务 × 2 次重复；
- 指标按 `notes/2026-11-10-discovery-metrics.md` 的口径；报告要给"离 oracle 上界差距"与"每层边际贡献"。

## 4. 收尾（必须）

1. 把 `arms/current.json` 写回 `{"strategy":"rules",...}`；
2. 给 Lead 的报告里注明：每个 arm 的 strategy 旁证、任务表、汇总、invalid/降级、已归档会话数；
3. Lead 会在 P2 结束后删除插件 patch 里的 `strategyFile`/`llmModel` 并做一次关→开，恢复纯生产 `rules`。
