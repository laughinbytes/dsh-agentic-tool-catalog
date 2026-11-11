# 2026-11-10 · P1 锦标赛结果（四臂：legacy / rules / oracle / minimal）

> 目的：用真实模型在环 + 独立核验，比较 discovery v2 的四种策略，决定线上用哪种。
> 协议：[`benchmark/discovery/README.md`](../benchmark/discovery/README.md) + [`runbook.md`](../benchmark/discovery/runbook.md)；
> 任务集：[`tasks.json`](../benchmark/discovery/tasks.json)（v2，含 D1 验收修正）。
> 结果原始数据：[`benchmark/discovery/results/`](../benchmark/discovery/results/)（30 个代表 run / 33 个 raw run）。
> 指标口径：能力选择/遗漏、一次搜索命中、已加载工具利用率、setup 搜索数、步数、token/成本、墙钟。
> **不采信模型自述**：pass/FAIL 只看产出文件断言。

## 0. 协议与规模

- arms：`legacy`（v1 兼容硬编码组）、`rules`（名字聚类 + others）、`oracle`（人工最优组，上界尺子）、`minimal`（不分组，下界对照）；
- 任务：7 个发现类任务（host-ops 会话列表 / Cloudflare 文档 ×2 / 持久终端 / 提醒 / 目标 / 会话搜索），
  每个任务 **全新会话**、prompt 不点工具名、按 forbid 约束禁用 bash 等捷径；
- 每 arm 每任务 1 次（单次重复；重试/验收修正的 run 由 `analyze.mjs` 按"优先 PASS"归一）；
- 环境：DSH 0.2.2-rc.1，deepseek-flash，browser-use 迁移后环境（93 个可延迟工具）。

## 1. 结果

| arm | n | pass% | 平均搜索 | setup 搜索 | missed% | 已加载利用率 | 平均步数 | 平均成本 | 平均墙钟 |
|---|---|---|---|---|---|---|---|---|---|
| legacy | 7 | 100 | **1.14** | 1.14 | 0 | 0.336 | 14.0 | $0.0130 | 126s |
| rules | 7 | 100 | 1.29 | 1.29 | 0 | **0.405** | **9.0** | **$0.0089** | **75s** |
| oracle | 7 | 100 | 1.57 | 1.43 | 0 | 0.321 | 9.0 | $0.0085 | **59s** |
| minimal | 7 | 100 | 1.57 | 1.29 | 0 | 0.193 | 10.0 | $0.0101 | 75s |

**离 oracle（上界）的差距**：rules 的搜索次数比 oracle 少 0.29 次、步数/成本持平；legacy 步数 +5、成本 +53%；
minimal 步数与 rules 同档、但已加载利用率最低（0.19，说明没有组时模型会多装无关工具）。

## 2. 结论

1. **质量不是区分项**：四臂 7/7 PASS、missed=0、invalid=0（oracle 有一次超时重试；D1 首次 FAIL 是验收 bug，已修正重跑）。
2. **legacy 明显更慢更贵**：平均步数 14 vs 9–10、成本 +30–53%、墙钟 126s vs 59–75s；
   差距主要来自两个重型任务的长尾（host-ops 会话列表 29 步/285s、会话搜索 40 步/501s）。
3. **rules 已贴住 oracle**：质量相同、搜索比 oracle 少、步数/成本持平——说明"自动名字聚类"没有牺牲上界表现。
4. **minimal 揭示组的作用**：不分组也能完成任务，但已加载利用率最低（0.19；rules 0.405、oracle 0.32），
   即"没有目录页时，模型更容易多装无关工具、搜索更盲目"（如 session-search 用了 4 次搜索）。
5. 搜索次数本身不是瓶颈（各臂 1.1–1.6 次），**真正的差距在搜索之后的步数/成本** → 与"分组的提示质量"和"长尾任务"相关。

## 3. 局限（必须随结论一起引用）

- **样本小**：7 个任务 × 单次重复；两个重型任务主导均值，方差大（同一任务 legacy 与 rules 相差 3–5 倍步数）。
- 任务集**未覆盖**浏览器（28 个工具、分层最明显的场景）与 workspace MCP（21 个工具）；这两类是分组收益最大的场景。
- browser-use 迁移期（12:04）环境有变动（browser 19→28 个工具），但四臂跑在同一环境。
- `minimal` 的 groups 为空导致系统提示 note 只列 others 名单；它与 rules 的差异部分来自"提示信息量"，不完全是分组本身。

## 4. 建议

- **候选：把默认策略从 legacy 切到 rules**（零插件知识、质量不掉、速度/成本优于 legacy、贴住 oracle）；
  同时保留 `oracle`/`minimal` 作为回归尺子，观测窗口内继续收集真实会话数据。
- 若要对"rules vs oracle/minimal"下更强结论：补一轮**重复实验**（两个重型任务 ×3 reps + 加浏览器/workspace 任务），预算约 $0.2–0.4。
- 切换成本：改默认策略后需要一次 bundle 关→开（HMR，2 秒内；**不重启 App**），并把 `strategyFile`/benchmark 配置从生产插件行移除。

## 4.5 决策与部署（2026-11-10）

用户拍板：**切 `rules` 上线**。落地内容：

- `plugins/dsh-tool-discovery/lib/index.js` 默认策略 `legacy → rules`；插件版本 0.2.0；
- 生产插件 patch **移除** `strategyFile`（不再依赖 benchmark 文件）；
- `legacy` 策略保留为回退/基准（`lib/policy.js` 的 `LEGACY_GROUPS` 不再是生产路径）；
- docs/06 §10、docs/08 §1/§3/§8、plugins/README、插件 README 同步为 rules 架构；
- 审计脚本改为断言"默认策略 rules + LEGACY_GROUPS 只作回退表 + 策略代码中心零插件知识"；
- 生效方式：bundle 关→开（HMR，2 秒内，**不重启 App**）。
- **2026-11-10 已切换并验证**：新 agent 实测 `strategy=rules`、`catalogTotal=93`、12 组 + `others=7`、
  `warnings=[]`；`search_tools("browser")` 一次整组加载 **28** 个工具（pending 93→65、restriction 同步 93→65）。

后续观察：真实会话里继续看 setup 搜索数/步数/成本；若要更强结论，补重型任务重复实验 + 浏览器/workspace MCP 任务。

## 5. 复现

```bash
node benchmark/discovery/analyze.mjs            # 四臂总表
node benchmark/discovery/analyze.mjs --markdown # 写报告用
# 原始：benchmark/discovery/results/*.json
```
