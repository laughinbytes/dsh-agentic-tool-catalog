# benchmark/discovery — Tool Discovery「锦标赛」（能力发现 benchmark）

> 目标：**用真实模型在环 + 独立核验**，比较不同 discovery strategy（分组/检索/加载），
> 回答"哪一种最接近上界"，而不是"比现状好一点"。
> 指标定义与业界参照：[`notes/2026-11-10-discovery-metrics.md`](../../notes/2026-11-10-discovery-metrics.md)；
> 归类机制：[`notes/2026-11-10-discovery-grouping-design.md`](../../notes/2026-11-10-discovery-grouping-design.md)。

---

## 1. 比什么（与指标卡对齐）

| 维度 | 指标 | 来源 |
|---|---|---|
| 质量 | pass 率（独立核验）、目标能力命中（missed=0）、一次搜索命中率、误装率 | verify.mjs + metrics.mjs |
| 速度 | setup 搜索次数（首个目标工具前的 search 数）、总 steps、wallMs | 会话日志 |
| 成本 | 首请求工具 schema 字符数/token、总 token、成本估算 | 会话日志 |
| 机制 | 已加载但没用到的工具比例、search 命中后是否真被调用 | 会话日志（tool-addition + tool/call 配对） |

**不采信模型自述**：pass/fail 只看实验目录里的产出文件（`verify.mjs`）。

---

## 2. 对照臂（strategies）

| arm | 状态 | 说明 |
|---|---|---|
| `baseline-resident` | ✅ 数据卡 baseline | 插件 `resident: ['*']`：所有工具常驻上下文（等价"不用按需目录"）；用于"用 vs 不用"对照 |
| `agent-catalog` | ✅ 数据卡 treatment | 生产配置：Agentic Tool Catalog 按需目录；目录由 agent 生成/缓存 |
| `legacy` | ✅ 现在可跑 | v2 引擎的 legacy 策略 = 现状硬编码 `KNOWN_GROUPS`（`v1-production` 为历史别名） |
| `full-load` | ✅ 现在可跑 | 关闭按需发现（全部工具常驻）→ 信息上界/成本最差 |
| `rules`（历史） | ⛔ 已移除 | 旧策略，2026-11-11 起插件只保留 agent-curated；仅历史结果可读 |
| `bm25` | ✅ 引擎就绪 | BM25 关键词检索（无分组；业界验证基线）；`arms/bm25.json` |
| `rules-bm25` | ✅ 引擎就绪 | rules 分组 + BM25 排序（混合）；`arms/rules-bm25.json` |
| `jev-precompute` | ⏳ 待 v2 + Jev 客户端 | 目录变化时 Jev 用名字+描述判组、缓存、失败回退规则（M11a） |
| `jev-online` | ⏳ 待 v2 + Jev 客户端 | search 时 Jev 从候选里 Choice（M11b） |
| `oracle` | ✅ 现在可跑 | 人工最优分组 → 质量上界；`arms/oracle.json`（第一版基线 = v1 已知人工组） |
| `minimal` | ✅ 现在可跑 | 只有 search_tools + 工具名清单 → 验证"组"的价值；`arms/minimal.json` |

> 完整策略清单/业界依据/实现状态见
> [`notes/2026-11-10-strategy-matrix.md`](../../notes/2026-11-10-strategy-matrix.md)：
> 12 个候选策略（已测 4 + BM25 系 2 + Jev 系 2 + Agent 系 2 + embedding/结构 2 待评估）。
>
> arm 切换方式、预期和恢复步骤见 `node run.mjs arms`。
>
> **当前 arm 怎么切**：① `baseline-resident` = 临时给插件加 `resident: ['*']` 并关→开一次；
> ② `agent-catalog` = 生产配置（删掉 resident 覆盖）并关→开一次。旧策略 arm 已随插件代码移除，
> 本目录只保留历史结果文件供追溯。
> 注意：插件配置默认 `strategyFile: ""`；跑锦标赛前需要一次性把该配置指向
> `benchmark/discovery/arms/current.json`（用 `dsh_config_manage` 或插件配置表单），并做一次
> bundle 关→开让配置生效；此后切 arm 只改 JSON 内容。

---

## 3. 任务集（`tasks.json`）

- Prompt **只描述目标、不点工具名**；禁止项（如"不要用 bash"）由 `run.mjs` 自动附加，
  用于把模型逼到目标能力路径上（测的是发现，不是通用能力）。
- family 用来从会话日志判断"走了哪条能力路径"，**不参与 pass/fail**。
- 目前 9 个任务：2 个基础对照（control，常驻工具即可）+ 7 个发现任务
  （dsh-host-ops / terminal / cfdocs ×2 / schedule / goals / session-search）。
- `browser` family 先禁用（需要 operator 扩展在线，Phase 2 再开）。
- 新增任务：在 `tasks.json` 加对象（fixtures / prompt / forbid / verify.files），无需改代码。

```bash
node run.mjs tasks      # 列任务
```

---

## 4. 一次 run 的流程（两段式）

CLI 不能创建 DSH 会话（必须走 agent 工具），所以：

```bash
# ① 准备（CLI）：建实验目录 + 写 fixtures + 打印 prompt
node benchmark/discovery/run.mjs begin --arm v1-production --task host-ops-session-list --rep 1

# ② agent：在新会话里执行
#    dsh_session_manage start（cwd = ①打印的目录；prompt = ①打印的文本）
#    dsh_session_manage wait（等 turn 结束）

# ③ 收数据（CLI）：解析会话日志 + 独立核验 + 落盘
node benchmark/discovery/run.mjs finish --run-id <runId> --session <sessionId>

# ④ agent：归档会话
#    dsh_session_manage archive <sessionId>
```

**规则**：
- 每个 run 必须**全新会话**（benchmark 天然规避"旧 agent 可能带孤儿 restriction"的历史问题）；
- 同一任务重复 k 次（默认 3，Phase 0 可 1 次）；
- 一轮内不切换其它 bundle/配置（避免污染日志）；
- arm 切换前后记录"新会话首请求工具数"到 `--note`，作为 arm 生效的旁证；
- 失败/环境异常（扩展离线、MCP 连接失败、会话日志缺失）记 `invalid`，不进分母。

---

## 4.5 部署状态与 arm 切换（2026-11-10）

- v2 引擎已部署到 profile（bundle 关→开一次）；**2026-11-10 P1 后生产默认策略 = `rules`**；
- 生产插件 patch **不配置** `strategyFile`；跑 benchmark 需要热切 arm 时，临时加回
  `strategyFile` 指向 `benchmark/discovery/arms/current.json` 并做一次 bundle 关→开（跑完删除、再 toggle 恢复）：
  - 换 arm = 改这个 JSON 的内容（`strategy`：`legacy` / `rules` / `oracle` / `minimal`；oracle 另带 `oracle.groups`）；
  - **新会话立即可见**；旧 agent 在下次目录重建（tools/change 或 search_tools）时生效；
- 事故提醒：如果切换过程撞上重组合失败，旧 agent 可能保留孤儿 restriction → 用新会话继续（见
  [`notes/2026-11-10-hmr-registry-incident.md`](../../notes/2026-11-10-hmr-registry-incident.md)）。

---

## 5. 分阶段计划与预算

| 阶段 | 内容 | run 数（估） | 预算（估） | 目的 |
|---|---|---|---|---|
| **P0 harness 验证** | 2 个 control 任务 × 2 arms（v1 / full-load）× 1 rep ≈ 4–6 会话 | 4–6 | <$0.1 | 确认两段式流程、指标解析、核验都可靠 |
| **P1 便宜臂** | 9 任务 × {v1, full-load, rules-v2, jev-precompute} × 1–2 rep ≈ 36–72 | 36–72 | ~$0.3–0.7 | 找出离 oracle 最近的可落地 strategy |
| **P2 上界 + 贵臂** | + oracle / minimal / jev-online；只对前两名补 3 rep | 40–80 | ~$0.5–1 | 定质量上界、验证在线 Jev 是否值得 |
| **P3 held-out** | 未参与调参的任务 × 最终 1–2 个候选 | 10–20 | ~$0.2 | 防过拟合的最终验收 |

（单价按 operator eval 实测 ≈$0.005–0.01/任务估；实际以 finish 输出的 costUsd 为准。）

---

## 6. 决策规则（怎么选出 strategy）

1. **质量门槛先行**：pass 率、missed=0、一次搜索命中率、误装率不达标 → 该 arm 淘汰（不进入速度/成本比较）；
2. 通过门槛的 arm 画 **质量-速度-成本 Pareto 前沿**，选"离 oracle 上界最近"的；
3. 同分时优先：零外部依赖 > 可离线 > 可解释 > 成本低；
4. held-out 任务上不达标的，不得上线；
5. 任何结论必须注明"样本数 / 重复次数 / 环境（DSH 版本、模型、arms 配置）"。

---

## 7. 文件

| 文件 | 作用 |
|---|---|
| `tasks.json` | 任务集 + family 定义 + 独立核验规则 |
| `run.mjs` | 编排：arms/tasks/begin/finish/report |
| `analyze.mjs` | P1 汇总：按 (arm,task) 去重（优先 PASS）、质量/速度/成本表、离 oracle 差距 |
| `runbook.md` | 给"编排子代理"的单臂执行手册（含纪律与报告格式） |
| `p2-runbook.md` | **P2 全策略锦标赛**手册：8 个 arm（含 BM25/Jev/Agent/组合）× 任务子集、arm 切换与收尾规则 |
| `metrics.mjs` | 从会话日志提取指标（search 次数/加载集合/工具调用/token/耗时） |
| `verify.mjs` | 独立核验（文件断言），不采信模型自述 |
| `runs/` | 每个 run 的 meta（prompt、arm、目录、环境） |
| `work/` | 实验目录（产物文件；`.gitignore`） |
| `results/` | 每个 run 的指标 + 核验结果（可提交） |

---

## 8. 当前状态（2026-11-10）

- ✅ 任务集、两段式编排、指标解析、独立核验已就位（本目录）；
- ✅ 现状 arm（`v1-production`）与对照 arm（`full-load`）现在就能跑；
- ✅ **P0-lite 实测完成（2026-11-10）**：2 个 control 任务 × v1 arm 全链路跑通，
  2/2 核验 PASS、setup 搜索 0 次、平均 4.5 步 / 6.5s / ≈$0.004/任务、首请求 33 个工具；
  结果文件在 `results/`（两个 run），会话已归档；
- ✅ v2 引擎已实现（策略可切换、默认 legacy；纯函数单测 78/78、真实包 schema 冒烟 22/22）；
  尚未部署到 profile（部署 = bundle 关→开一次，在安静窗口做）；
- ⏳ 待办：`jev-precompute` / `jev-online` 两个 arm（需要 Jev 客户端）；
- ✅ **P1 首轮锦标赛完成（2026-11-10）**：四臂（legacy / rules / oracle / minimal）× 7 任务，
  全部 100% PASS、0 missed；rules 步数/成本/墙钟优于 legacy 并贴住 oracle。
  报告：[`notes/2026-11-10-p1-tournament.md`](../../notes/2026-11-10-p1-tournament.md)；
  汇总：`node benchmark/discovery/analyze.mjs`；
- ⚠️ **2026-11-10 晚起旧策略全部移除**：`legacy/rules/bm25/rules-bm25/oracle/minimal/Jev/LLM/full-combo`
  的 arm 已不可运行；`results/` 中它们的数据是**历史证据**（用于解释选型），当前可跑的 arm 只有 `agent-auto`。
- ✅ **benchmark 长尾任务修复**：`session-search-count` 标注 `timeoutMs=900000` + `invalidOnTimeout`
  （环境性 session_search 超时按 invalid 记，不记策略失败；根因是 benchmark 子目录未注册为 workspace）。
- ✅ **agent-precompute 已通过可靠性验收并成为生产默认（2026-11-10 晚）**：12 会话生成 0 失败、
  缓存命中稳定、无实例重置、磁盘缓存持久化；验收记录见
  [`notes/2026-11-10-agent-strategy-production.md`](../../notes/2026-11-10-agent-strategy-production.md)；
- ✅ **P2 锦标赛完成（2026-11-10）**：本地策略全部测完（rules/bm25/rules-bm25/真 agent 分组/oracle/minimal）；
  真 agent 生成的分组在质量持平下搜索 −14%、步数 −16%、成本 −24%（2 轮复现），为实测最优候选；
  生产默认仍 `rules`（agent 分组待生产化）。Jev/一次性 LLM 因 OpenRouter 529 不可测（归档证据）。
  最终报告：[`notes/2026-11-10-p2-tournament.md`](../../notes/2026-11-10-p2-tournament.md)；
- ⏳ `full-load` arm 仍需临时关→开 Tool Discovery（安静窗口）。
