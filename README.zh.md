# Agentic Tool Catalog（Agent 工具目录）

**由 Agent 自动生成并维护工具目录：工具 schema 默认不占上下文，按需加载。**

[English](README.md) | [中文](README.zh.md)

DeepSeek Harness 默认把**每个可见工具的完整 schema** 放进**每一次**模型请求。接的 MCP/扩展插件一多，
上下文就会膨胀、请求变慢，工具超过几十个后模型选择准确率也会下降。

Agentic Tool Catalog 换一种做法：上下文里只保留一份**目录**。插件启动一个**真正的 DSH 子代理**，
读取当前工具清单、按用户意图分组、自检覆盖率，交回一份目录；插件严格校验后缓存到**官方 DSH Storage**，
每次请求只发几行目录文字，具体工具由 `search_tools` 在需要时加载。

## 你能得到什么

- **更小的请求**：未加载工具 schema 不进上下文（本机实测：91 个延迟工具 schema 合计约 109.6 KB ≈ 2.7 万 tokens，
  被 443 字符的目录提示替代）；
- **Agent 生成的语义分组**：按意图拆组（浏览器拆成操作/观察/判断；Google 按邮件/日历/登录拆；跨 server 能力合并），
  而不是按名字前缀；
- **零插件配合**：无需其他插件声明字段、元数据或改代码；装了就会被自动发现；
- **本地优先**：生成使用本机 DSH 模型，不需要外部服务；
- **可靠性**：严格校验、失败带反馈重试一次、同指纹单飞、官方 Storage 持久化、目录变化增量重生成；
  生成没完成时状态会显式标 `stale`（或使用扁平引导目录），**不会静默失败**；
- **可观测**：`catalog_status` 提供目录新鲜度/来源、分组、已加载、生成与存储健康状态。

## 工作机制

```
需要工具
  → 目录指纹（工具名 + 缓存命名空间）
  → 内存/官方 Storage 命中？ ── 是 → 直接使用
  → 否：用 DSH 子代理生成（有上次目录时优先增量）
        → 校验（100% 覆盖、无重复、组合理）
        → 写入官方 Storage 并应用目录（按需释放工具）
        → 失败：带错误反馈重试一次；仍失败 → 沿用最近一次成功分组
          （状态 stale + 显式告警 + 退避重试）或扁平引导目录
```

- **新会话**创建时立即预热生成；**恢复的旧会话**在第一条用户消息/搜索时才生成；**目录变化**立即重新生成（优先增量）；
- **生成由工具集决定，不是按时间**：同一份工具指纹只生成一次，结果缓存进官方 Storage，跨会话/重启复用；
  **没有定时刷新**——只有工具集真的变了（装/卸插件、MCP server 上下线、preset 变化等）才会重新生成。
- 工具用 `agent.ctx.tools.restrict({ deny })` 从模型请求中隐藏，`search_tools` 命中后通过 DSH 原生
  tool-addition 机制在会话中途释放；
- 缓存走官方 `ctx.storageDomain`（domain `agentic_tool_catalog`）；若 profile 没有 storage 服务，
  降级为纯内存缓存（功能可用、重启后重新生成一次），并在 `storage.mode` 明确报告 `memory`。

## 模型可见工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `search_tools` | `query: string`，`limit?: number` | 按意图/关键词搜索目录（名字、描述、组名/组描述）；query 精确等于组名时整组加载（≤`groupMaxResults`）；加载后本会话可直接调用 |
| `catalog_status` | — | 只读 JSON：`catalog`（来源/新鲜度/来源类型/总数/分组/others）、`session`（已加载/待加载/restriction）、`generation`（次数、缓存命中、失败、重试、去重、stale 次数、增量次数、last error/ok、实例）、`storage`（模式/状态）、`warnings` |

系统提示里有一个 `catalog:note` 段：列出延迟分组和数量；初始化中/刷新中会额外写明一行状态。

## 配置

```yaml
- id: agentic-tool-catalog
  name: 'dsh-agentic-tool-catalog'
  config:
    maxResults: 6            # 一次普通搜索最多加载的工具数
    groupMaxResults: 30      # 按组名整组加载的上限
    promptNote: true         # 是否注入 catalog:note 提示
    resident: []             # 覆盖内置常驻清单（工具名/glob）
    extraKeepResident: []    # 追加"必须常驻"的 glob
    extraDeferred: []        # 强制按需的 glob
    catalogProvider: spawn   # 生成用子代理 provider
    catalogTimeoutMs: 120000 # 单次生成超时
    catalogResetNonce: ''    # 缓存命名空间；改它可强制重新生成
```

大多数情况下**不需要任何配置**；新装插件/MCP 在目录变化时自动收编；只有"某工具必须永远可见"时才需要
`extraKeepResident`。

## 安装

本地开发（本工作区）：

```bash
dsh plugin --profile web add dsh-agentic-tool-catalog
# 本地开发（本仓库）
dsh plugin --profile web add /path/to/dsh-agentic-tool-catalog
# 或在 DSH checkout 里
dsh plugin add /path/to/dsh-agentic-tool-catalog
```

发布包：`dsh-agentic-tool-catalog`（npm）；要求 DSH `>=0.2.1-rc.2 <0.3.0`，
已在 `0.2.2-rc.1` 与 `0.2.2-rc.2` 上验证（两种子代理激活 spec 形状都支持）。

## 性能（A/B：用 vs 不用）

5 个任务 × 每臂 2 轮独立会话，同模型、同工具面（122 tools，含 Google Workspace MCP），DSH 0.2.2-rc.1、`deepseek-flash`：

| 指标 | 不用（全量常驻） | 用本插件 | 变化 |
|---|---:|---:|---:|
| 任务通过率 | 100% (10/10) | 100% (10/10) | 持平 |
| 首请求工具 schema（载荷） | 122 tools / 131,390 chars | 31 tools / 21,877 chars | **−83.3%** |
| **首请求真实 prompt tokens**（usage） | **49,504** | **18,536** | **−62.6% / 每请求 −30,968** |
| 平均总 tokens/会话 | 452,463 | 268,551 | **−40.6%** |
| 平均步数 | 7.40 | 7.90 | +6.8% |
| 平均成本/会话 | $0.0112 | $0.0116 | +3.7%（≈持平） |
| 平均墙钟 | 37.0s | 33.3s | −9.9% |
| 平均 `search_tools` 调用 | 0.10 | 1.30 | +1.2/会话 |

一次性目录生成（后台、缓存到官方 DSH Storage）不计入上表任务指标；完整方法与边界见 [`docs/benchmark.md`](docs/benchmark.md) · 完整数据卡：[`docs/data-card.md`](docs/data-card.md)。

## 最小 UI（只读）

官方输入框下方是 **图标 + 一个极小的按需工具数**（hover 有摘要，hover/展开样式与官方 ContextMeter 一致）。
点击展开只读面板（照官方 ContextMeter 的尺寸/token 设计）：常驻/已加载/待加载分段条 + 三行图例 +
状态点/新鲜度 + 一行“分组 · 存储 · 更新时间”。没有目录名堆叠、没有配置项、没有长说明；
使用官方 slot/主题变量，自动跟随明暗主题。

## 验证

```bash
node scripts/verify-agentic-tool-catalog.mjs          # 模块/回归测试
node scripts/verify-agentic-tool-catalog-schema.mjs   # 真实 dsh-tools/schemastery/storage-domain 编译
node scripts/verify-presentation.mjs                 # 展示文件检查（locale/icon/detail）
```

Benchmark 方法/数据见 [`benchmark/`](../../benchmark/discovery/)；发布数据卡按**用 vs 不用插件**对照。

## 已知限制

- 缓存是**派生数据**：丢了最多重新生成一次（每个目录一次）；它不是用户数据，不做跨介质迁移；
- 冷启动首次没有目录时，会先用扁平引导目录，后台生成完成后自动替换；之后重启/目录变化走持久化/增量路径；
- 生成质量取决于配置的模型：插件会严格校验、重试并在状态里显式标注，但不会"偷偷把坏分组当成正常"；
- 暂无 UI 仪表盘（`catalog_status` 是观测入口）；目前只处理 tools（不含 skills）；数百个工具以上的规模尚未基准测试；
- 依赖公开的 `tools.definitions/restrict` 与官方 `storageDomain` API，遵循 DSH `0.2.x` 的稳定性边界。

## License

MIT。
