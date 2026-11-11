# 2026-11-10 · P2 全策略锦标赛与生产化最终报告

> **历史存档（2026-11-10 晚更新）**：本报告记录淘汰旧策略前的完整评测；此后旧策略代码已全部移除，
> 生产只保留真 agent 分组。当前运行时请以插件 README 与 [生产化验收记录](2026-11-10-agent-strategy-production.md) 为准。
>
> 目标（用户定调）：把所有 strategy 都测完（规则/检索/System-1 决策模型/真 agent/混合），
> 用同一套 benchmark 选出**最优**并推进到生产；质量优先，其次速度/成本；组合必须有原理、可消融。
> 方法见 [P2 runbook](../benchmark/discovery/p2-runbook.md)、[指标卡](2026-11-10-discovery-metrics.md)；
> 数据：`benchmark/discovery/results/`（环境不可用的外部线归档于 `results/unavailable-external/`）。
> 生产化设计与验收记录：[agent-strategy-production](2026-11-10-agent-strategy-production.md)。

## 0. 结论（TL;DR）

1. **质量上所有本地策略打平**：每个 arm 全部 PASS、0 能力遗漏；差异在效率与成本。
2. **实测效率最好 = 真 agent 分组（`agent-precompute`）**，并已于 2026-11-10 晚通过可靠性验收后
   **切换为生产默认**（非阻塞、目录指纹缓存、跨重启磁盘缓存、失败自动回退 `rules`）。
3. `jev-precompute`（rules + Jev 判组）效果与 agent 分组同档，但依赖外部服务，作为备选；
   `full-combo`（层层叠加）实测更差，**不采用**。
4. `bm25` / `rules-bm25` 未胜过 rules；`legacy` 明显更差；`minimal` 证明"分组有价值"；`oracle`
   在本任务集未超过 rules，只作尺子。
5. 一次性 LLM 调用策略按用户决策**放弃**（不是 agent，被真 agent 取代）；Jev 外部线 2026-11-10
   晚恢复后已补测（见 §2）。

## 1. 本地策略决赛总表（同任务集，独立核验）

任务：host-ops-session-list / docs-workers-limit / terminal-echo / goal-set / session-search-count /
workspace-calendar-count（6 个，每次全新会话）。

| arm | n | pass | 平均搜索 | 平均步数 | 平均成本 | 平均墙钟 |
|---|---|---|---|---|---|---|
| **agent-precompute（真 agent 分组）** | 12 | 100% | **1.00** | **9.00** | **$0.016** | **58.3s** |
| jev-precompute（rules + Jev 判组，Jev 恢复后补测） | 6 | 100% | 1.00 | 9.17 | $0.017 | 65.9s |
| rules（原生产） | 12 | 100% | 1.17 | 10.67 | $0.021 | 86.5s |
| full-combo（rules+BM25+Jev 判组+在线重排） | 6 | 100% | 1.83 | 11.83 | $0.023 | 76.1s |

逐轮复现（agent vs rules）：r1 搜索 6 vs 7、成本 −20%、步数 −12.5%；r2 搜索 6 vs 7、成本 −23%、
步数 −18%。差异唯一稳定来源：docs 任务 rules 需 2 次搜索，agent 的 `cloudflare-api` 组合并
cfapi+cfdocs 后 1 次命中。

其他本地臂（代表 run，任务集略有差异，仅作方向参考）：legacy 14.0 步/$0.013、bm25 9.5 步/$0.021、
rules-bm25 10.7 步/$0.017、minimal 10.0 步/$0.010（利用率最低）、oracle 9.0 步/$0.009。

## 2. Jev（System-1 决策模型）与混合策略

- Jev 在 2026-11-10 白天因 OpenRouter **HTTP 529 system_overloaded** 不可测（已归档证据）；晚间恢复。
- 修复判组语义：**MCP 工具保持 server 自动组不动，只对非 MCP 工具用 Jev 判组**。
- 实测 `jev-precompute`（1 轮 6 任务）：搜索 1.00 / 步数 9.17 / 成本 $0.017，与 agent 分组同档、优于 rules；
  首次判组有一次性成本。
- 实测 `full-combo`：搜索 1.83 / 步数 11.83 / 成本 $0.023，**比 rules 更差**（外部调用风暴 + 组切换抖动），
  证明"组合不是越多越好"。
- 一次性 LLM 调用（`llm-*`）按用户决策放弃。

## 3. agent 分组的机制

- **不是每次实时调用**：目录变化（工具增删/MCP 重连/新会话）且缓存未命中时，后台启动一次**真 DSH 子代理**
  （`ctx.get('subagents').startActivation`，provider=spawn），它多步推理后用结构化输出提交分组方案；
- 插件严格校验（100% 覆盖、无重复、组名/描述/组数/组大小合法），失败/超时/不合法→**自动回退 rules**；
- 按目录指纹（sha256 工具名）缓存；进程级共享 + 磁盘持久化（`~/.dsh/cache/tool-discovery/groups.json`），
  跨 App 重启保留；同一指纹多会话并发时**单飞**（只生成一次）；
- 校验失败自动带错误反馈重试一次（如 `UNKNOWN_TOOL: calendar_list` 简写会被纠正）；
- **递归守卫**：子代理自身不生成（只可命中缓存），避免套娃；
- 非阻塞：首请求先用 rules 目录，生成完成自动升级；生产默认 `agentGroupBlocking=false`。

## 4. 可靠性验收（2026-11-10 晚，通过）

生产式配置（`strategy=agent-precompute`）下跑 6 任务 ×2 轮 = 12 会话：

- **分组分发零故障**：`agentGen runs=2 / cacheHits 1→29 / failures=0 / retries=0 / deduped=11 /
  lastError=null`；`instanceId=1`、`lastReload` 未变化（无实例重置）；磁盘缓存 2 个指纹全程未被重写；
- 12/12 会话首请求工具数恒为 34，每任务 1 次 setup search 即命中目标工具（missed 全 false）；
- 10/12 PASS；2 条 FAIL 是 `session-search-count` 的环境性 timeout（session_search 30s 超时、索引抖动，
  `missed=false`，非分组故障），已在报告中单列；
- 排除该环境异常后（n=10）：agent-auto 搜索 1.10 / 步数 8.20 / 成本 $0.0065 / 墙钟 35.7s；
  rules 同口径 1.20 / 7.70 / $0.0117 / 34.2s ⇒ **搜索更少、成本 −44%、耗时持平**；
- 生成成本：一次约 71s / 66.8k tokens（每进程一次；磁盘缓存后跨重启免生成），折算几厘钱。

## 5. 生产状态与回退

- **生产默认 = `agent-precompute`**（patch 显式配置；代码默认仍 rules 作为兜底）；
- 回退：把 `plugins/dsh-tool-discovery/cordis.patch.yml` 的 `strategy` 改为 `rules`（或删除该行用代码默认），
  做一次 bundle 关→开；已生成的磁盘缓存不影响 rules 使用；
- 已知限制：① 工具目录变化后的"重新生成"路径本次验收未覆盖（本批全缓存命中），上线后需观察
  `agentGen.failures/retries`；② 实验性 inspector 曾在 17:38 崩溃（`source state exceeds source-frame
  byte limit`，当前 inspector 行 inactive），未再复现；③ benchmark harness 的实验目录未注册为 workspace，
  `dsh_host_ops`/`session_search` 类任务会绕路（两个 arm 同等受影响，不改变相对结论）；
④ `session-search-count` 类长尾任务需 >600s 超时。

## 6. 复现

```bash
# 决赛表（同一任务集、多轮）
node benchmark/discovery/analyze.mjs --arms rules,agent-precompute --common --all-reps \
  --since '2026-11-10T15:00:00+08:00'
# 全量方向表
node benchmark/discovery/analyze.mjs
# agent 生成的分组产物（静态样本）与随机对照
benchmark/discovery/arms/agent-groups.json
```
