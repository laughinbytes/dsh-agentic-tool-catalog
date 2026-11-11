# 性能数据卡：Agentic Tool Catalog（用 vs 不用）

> 目标：用**同一批任务、同一模型、同一工具面**回答一个问题——
> **装上 Agentic Tool Catalog，和"所有工具常驻上下文"相比，付多少、得多少？**

## 1. 对照设置

| | baseline（不用插件） | treatment（用插件） |
|---|---|---|
| 上下文形态 | 所有工具常驻：每次请求带全部 122 个工具 schema | 31 个常驻工具 + 一小段目录提示；延迟工具 schema 不进请求 |
| 配置 | 插件 `resident: ['*']`（目录为空，不搜索） | 生产配置（目录由 agent 生成并缓存，`fresh`） |
| 工具面 | 122 tools（含 Google Workspace MCP 22 个） | deferred 92 tools / 19 组，`catalog_status.storage=ready` |
| 模型 / 环境 | `deepseek-flash`（provider `deepseek-account`）、DSH `0.2.2-rc.1`、同一桌面 profile | 同左 |

- 任务集（5 个，每任务 2 轮独立会话，共 10+10 run）：
  `host-ops-session-list`、`docs-workers-limit`、`terminal-echo`、`goal-set`、`docs-d1-storage`；
- 所有任务由 `benchmark/discovery/run.mjs` 记录，`verify` 独立核验文件/结果；
- `workspace-calendar-count` 未纳入主表：它依赖 Google Workspace MCP 的可用性，属环境敏感任务；
- 指标来自 DSH 会话日志：首请求工具 schema 字符（官方 `metrics.firstRequestTools`）、tokens、成本、步数、墙钟、
  `search_tools` 调用次数。

## 2. 结果（10 + 10 run，全部有效）

| 指标 | baseline（全量常驻） | treatment（按需目录） | 变化 |
|---|---:|---:|---:|
| 任务通过率 | **100%** (10/10) | **100%** (10/10) | 持平 |
| 首请求工具数 | 122 | 31 | **−74.6%** |
| 首请求工具 schema 字符（纯 schema 载荷） | 131,390 | 21,877 | **−83.3%** |
| **首请求真实 prompt tokens**（会话日志 usage，非估算） | **49,504** | **18,536** | **−62.6%（−30,968 tokens/请求）** |
| 最大请求 schema 字符（任务全程） | 131,390 | 34,785 | **−73.5%** |
| 平均总 tokens / 会话 | 452,463 | 268,551 | **−40.6%** |
| 平均步数 | 7.40 | 7.90 | +6.8% |
| 平均成本 / 会话 | $0.0112 | $0.0116 | +3.7%（≈持平） |
| 平均墙钟 | 37.0s | 33.3s | −9.9% |
| 平均 `search_tools` 调用 | 0.10 | 1.30 | +1.2 次/会话 |

**一句话**：任务成功率不变，**首请求工具 schema 载荷降 83.3%，首请求真实 prompt tokens 从 49,504 降到 18,536（−62.6%，约 −31k tokens/请求）**，会话总 tokens 降约 41%；
代价是每会话多约 1.2 次目录搜索、步数 +7%；成本与墙钟在噪声范围内（成本 +3.7%、墙钟 −9.9%）。


## 3. 质量指标（同一批结果的 discovery 输出）

| 指标 | baseline（全量常驻） | treatment（按需目录） |
|---|---:|---:|
| 目标能力命中（targetToolCalled） | 10/10 | 10/10 |
| missedCapability | 0 | 0 |
| 搜索次数 / 会话 | 0.10 | 1.30 |
| 目标工具调用前的 setup 搜索 | 0 | 1.20 |
| 每次搜索平均加载工具数 | — | 9.2 |
| 加载后实际使用工具数 | — | 1.9 |
| loadedUsedRatio（加载后使用率） | — | **0.289** |
| 工具调用失败（环境摩擦，非插件失败） | 6 | 2 |

诚实解读：目录让模型"多看少带"——每次搜索会加载约 9 个工具、实际用到约 2 个；
**加载后使用率 0.289 说明搜索返回偏宽**，这是下一步可优化项（收紧 maxResults/排序或按组加载），
不是数据卡要掩盖的点。目标能力 10/10 命中、0 missed，说明"该找的工具都找到了"。

### 逐任务首请求 prompt tokens（真实 usage）

| 任务 | baseline | treatment | 变化 |
|---|---:|---:|---:|
| host-ops-session-list | 49,511 | 18,543 | −62.5% |
| docs-workers-limit | 49,516 | 18,548 | −62.5% |
| terminal-echo | 49,483 | 18,515 | −62.6% |
| goal-set | 49,477 | 18,509 | −62.6% |
| docs-d1-storage | 49,533 | 18,565 | −62.5% |

## 4. 一次性成本与持久化（不混入上表）

- 目录生成由 DSH 子代理完成，**每个目录版本一次**（后台，不阻塞任务）；本机 92 工具目录的实测生成约 60–75s、
  约 6–7 万 tokens 量级（≈ 一次生成），完成后按目录指纹缓存到**官方 DSH Storage**；
- 之后的会话/重启走缓存（`catalogOrigin=storage`），**零生成**；目录变化时增量重生成；
- 数据卡上表不含生成成本；生成失败不会静默：状态标 `stale`/`refreshing`，自动带反馈重试并从上次成功分组继续。

## 5. 可靠性与观测（同期验证）

- A/B 的 10 个 treatment run：首请求全部 `31 tools / 21,877 chars`，无 bootstrap/error/stale；
- 目录与缓存：`catalog_status` 显示 `fresh`、`origin=storage`、`storage.state=ready`；
- 一次真实故障演练（开发期 Google Workspace MCP 抖动）中，生成校验失败 4 次、按预期走重试/
  最近一次成功分组（`staleUses=5`），**没有静默隐藏工具**；MCP 恢复后目录继续 `fresh`。

## 6. 边界与复现

- 收益主要来自"延迟工具 schema 不进每次请求"；工具越多、MCP/扩展越多，收益越大；工具很少（<10）时收益有限；
- 对照依赖同一工具面：需要 Google Workspace MCP 在线（本卡 122 工具面）；MCP 掉线会改变首请求工具数，
  本卡使用的是工具面一致的 10–4x 批次；
- 首请求 tokens 来自会话日志真实 usage（非 chars/4 估算）；schema 字符是载荷指标。成本/墙钟受模型与网络影响，应看多轮重复；
- 复现：`node benchmark/discovery/card.mjs --baseline baseline-resident --treatment agent-catalog --tasks host-ops-session-list,docs-workers-limit,terminal-echo,goal-set,docs-d1-storage --markdown`
  原始结果在 [`results/`](results/)，方法说明 [`benchmark/discovery/README.md`](README.md)。

## 7. 和竞品怎么比

- 竞品（`dsh-tool-search`、`dsh-tool-activator`、`dsh-capability-catalog`、`dsh-mcp-lens` 等）多数以
  **搜索/手动激活/人工登记**组织工具；本插件差异是 **agent 自动生成并维护语义目录**，
  本卡只回答"用 vs 不用"，不做无法公平对齐的跨插件数字对比；定性差异与竞品调研见
  [`notes/2026-11-11-plugin-naming-interface.md`](../../notes/2026-11-11-plugin-naming-interface.md)。
