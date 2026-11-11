# 2026-11-11 · Agentic Tool Catalog：改名、官方 Storage、接口统一

> 用户 2026-11-11 决策：名字定为 **Agentic Tool Catalog**（`@local/dsh-agentic-tool-catalog`）；
> 缓存**只走官方 Storage**（不保留自管文件缓存 / 不做双后端）；插件内外部接口**统一 catalog 词汇**；
> License = MIT；性能数据卡按"用 vs 不用（全量常驻）"做，不跟旧版本比。

## 1. 命名

- 包名：`@local/dsh-agentic-tool-catalog`（发布：`dsh-agentic-tool-catalog`，npm 404 可用）；
- 显示名：Agentic Tool Catalog / Agent 工具目录；行 id：`agentic-tool-catalog`；
- npm/GitHub 重名调研结论见 [`2026-11-11-plugin-naming-interface.md`](2026-11-11-plugin-naming-interface.md)：
  `tool-search`/`tool-index` 已被占用；竞品有 `dsh-tool-search`（多个实现）、`dsh-tool-activator`、
  `dsh-capability-catalog`、`dsh-mcp-lens` 等；**agent 自动生成目录**是抽样范围内未见竞品做的差异点。

## 2. 官方 Storage 迁移

- 删除 `node:fs` 自管 JSON 缓存；新增 `lib/store.js`：
  - `defineDomain({ name: 'agentic_tool_catalog', version: 1, tables: { catalogs, state } })`
    （DNS 规则：domain 名只允许 `[a-z][a-z0-9_]*`，故用下划线）；
  - `ctx.get('storageDomain').open(spec)`，`ctx.effect` 负责 close；hydrate 时把 `catalogs`/`lastGood`
    读进共享内存；写入 fire-and-forget（失败只记日志，不影响当前会话）；
  - **无 storage 服务 → 纯内存缓存**（`storage.mode=memory`），不写第二份文件。
- 实测：`~/.dsh/storages/agentic_tool_catalog.json`（15 KB，含 `unit/global/tables`）；
  `catalog_status.storage = {available:true, state:'ready'}`；
  reload 后 `catalogOrigin=storage`、`fresh`，= 跨实例/重载持久化生效。
- 首次从旧文件缓存切换没有迁移数据（有意）：旧文件是派生缓存，直接重新生成一次（92 工具/19 组）即可。

## 3. 接口/命名统一

- 模型工具：`search_tools`（保留）+ `catalog_status`（原 `discovery_status`）；
- 提示 section：`catalog:note`；状态 JSON 固定四块：`catalog` / `session` / `generation` / `storage` / `warnings`；
- Config：`catalogProvider` / `catalogTimeoutMs` / `catalogResetNonce`（原 `agentGroup*`），其余不变；
- 内部文件：`policy.js`→`catalog.js`、`agent-groups.js`→`generation.js`、新增 `store.js`；
- 目录 `catalog.strategy = 'agentic-tool-catalog'`；warnings kind 统一 `catalog-*`；
- 文档：README 双语（`README.md` + `README.zh.md`）、插件页 `docs/detail.md/.zh.md` 重写、MIT `LICENSE`；
- 回归脚本改名：`scripts/verify-agentic-tool-catalog.mjs`、`...-schema.mjs`；
- `docs/06` §10、`plugins/README.md`、`docs/08` canonical/说明已同步。

## 4. 迁移中发现并修复的问题

- **孤儿 restriction**：旧 bundle 被 `remove_bundle` 替换时，旧实例的 `tools.restrict` restriction 没被清掉，
  导致新插件启动后 agent 工具表只剩 5 个（旧 deny 残留）。修复：新插件 apply 时主动释放旧全局登记表
  `Symbol.for('@local/dsh-tool-discovery/restrictions')`。
- 重装后实测：工具表恢复（92 工具）、目录生成成功（19 组）、官方 Storage 落盘。

## 5. 门禁

- `node scripts/verify-agentic-tool-catalog.mjs` → 49/49
- `node scripts/verify-agentic-tool-catalog-schema.mjs` → 20/20（真实 dsh-tools/schemastery/storage-domain）
- `node scripts/audit-plugin-presentation.mjs` → 全部合规（8 个产品 bundle）
- `node scripts/verify-plugin-meta.mjs` → 8 个 bundle 的 title/description/icon 可解析

## 6. 数据卡 A/B 结果（2026-11-11 完成）

baseline（`resident:['*']`，全量 122 tools）vs treatment（按需目录，92 deferred/19 组），
5 任务 ×2 轮、同模型/同工具面/独立核验：

| 指标 | baseline | treatment | 变化 |
|---|---:|---:|---:|
| 通过率 | 100% (10/10) | 100% (10/10) | 持平 |
| 首请求 schema | 122 tools / 131,390 chars | 31 tools / 21,877 chars | **−83.3%** |
| 首请求 tokens（char/4） | ≈32,848 | ≈5,469 | **≈−27,378/请求** |
| 平均总 tokens/会话 | 452,463 | 268,551 | **−40.6%** |
| 平均步数 | 7.40 | 7.90 | +6.8% |
| 平均成本/会话 | $0.0112 | $0.0116 | +3.7%（≈持平） |
| 平均墙钟 | 37.0s | 33.3s | −9.9% |
| 平均 search_tools | 0.10 | 1.30 | +1.2/会话 |

- 完整方法/边界/复现：[`benchmark/discovery/data-card.md`](../benchmark/discovery/data-card.md)；
- 插件内摘要：[`plugins/dsh-agentic-tool-catalog/docs/benchmark.md`](../plugins/dsh-agentic-tool-catalog/docs/benchmark.md)；
- `workspace-calendar-count` 因 MCP 环境敏感未入主表；开发期 MCP 抖动导致生成校验失败/重试，
  插件按设计显式 stale/重试/沿用最近成功分组，无静默隐藏。

## 7. 最小 UI（Client 半边，2026-11-11 完成）

- 官方 `conversation.composer.dock` 座位：一行只读状态 `工具目录 · 19 组 / 92 个 · fresh`（状态点绿/黄/灰）；
- 点击展开只读面板：工具/分组/已加载/待加载、存储模式（官方 Storage/内存）、最近生成时间、
  分组列表（名称+数量+一句描述）、告警、`search_tools` 使用提示；
- **无任何配置项**；使用官方 slot/primitives/主题 token（`--dsw-alias-*` / `--dsh-content-font-*`），双语 locale；
- 数据来源：Host 只读 HTTP 路由 `/plugins/agentic-tool-catalog/status?sessionId=...`（同源校验，无凭据）；
- **UI v2（2026-11-11 晚，用户反馈后重做）**：
  - dock = glyph + 极小数字（按需工具数），**无状态点、无文字**；hover 用官方 Tooltip；
  - 状态点移到展开面板里（fresh/refreshing/stale/bootstrap 语义明确）；
  - **UI v3（2026-11-11 12:2x，用户要求对齐官方 ContextMeter）**：
    - Trigger 逐条对齐官方 ContextMeter：gap 6 / padding 1px 8px / radius `--dsw-radius-sm` /
      font 13px / line-height 20px+delta / `--dsw-alias-interactive-bg-hover` hover 与 expanded 态；
    - 面板照 ContextMeter 的尺寸/材质：264px、`--dsw-specific-menu`、`--dsw-elevation-prominent`、
      12px 内边距、12/20 字；内容 = 常驻/已加载/待加载三段条 + 三行图例（不是 chips 堆叠）；
      分组名称不在 UI 平铺；状态点只在面板标题行；
    - 图标重设计：目录卡片 + 索引行 + 右上角 agent spark（36px icon 与 14px glyph 同一形状）；
    - Host 只读路由改 `/plugins/agentic-tool-catalog/snapshot`，注册时持 disposer 防止 reload 后旧路由泄漏；
    - **"常驻显示 0"根因**：旧 `/status` 路由在多次 reload 中未被释放（每次 register 返回的 disposer 未挂 effect），
      新实例注册被旧路由遮蔽，页面读到旧快照（无 resident 字段）。改为新路径 + disposer 后，生产快照返回
      `resident: 32`（31 常驻 + 1 own-layer? 以实时为准），面板正确显示；
    - 图标重设计为"目录卡片 + 索引行 + agent spark"（36px `icon.svg` 与 14px dock glyph 同形），
      通过展示审计（渐变 id 前缀/调色板校验）；
    - 证据：`ui-dock-v3.png`、`ui-panel-v3.png`、`ui-panel-v3-dark.png`；
  - Host snapshot 增加 `catalog.resident`，面板能区分常驻与按需；
  - 验证：
    - 真实 profile 路由 `GET /plugins/agentic-tool-catalog/status?sessionId=...` → 200（fresh/92/19/storage ready）；
    - 隔离实例 quiet-verify：portal=true、inBody=true、dot=bootstrap、legend=`25 常驻 / 10 按需 / 0 已加载`；
      浅色/暗色截图 `ui-dock-v2.png`、`ui-panel-v2.png`、`ui-panel-v2-dark.png`；
    - `application:"applied"`、无 restartReason → 热生效，无需重启；
- 测试：schema 27/27（含 client 半边/路由/client asset 检查）、host 55/55、presentation audit 全合规。

## 8. 数据卡 v2：真实 usage tokens（零新增成本）

复用现有 20 个 A/B 会话日志，按真实 `usage` 统计首请求 prompt tokens：

| 指标 | baseline | treatment | 变化 |
|---|---:|---:|---:|
| 首请求工具 schema 载荷 | 131,390 chars | 21,877 chars | **−83.3%** |
| **首请求真实 prompt tokens** | **49,504** | **18,536** | **−62.6%（−30,968/请求）** |
| 平均总 tokens/会话 | 452,463 | 268,551 | **−40.6%** |
| 通过率 | 100% | 100% | 持平 |
| 步数 / 成本 / 墙钟 | 7.40 / $0.0112 / 37.0s | 7.90 / $0.0116 / 33.3s | +6.8% / +3.7% / −9.9% |

已写回 `benchmark/discovery/data-card.md`、`plugins/.../docs/benchmark.md`、双语 README。
**没有重跑任何会话。**

## 9. 待办（发布）

- [ ] CI 门禁、npm 发布说明、插件市场索引；
- [ ] 竞品深挖（用户要求）：`dsh-tool-search`、`dsh-tool-activator`、`dsh-capability-catalog`、`dsh-mcp-lens`、`dsh-capability-menu` 的物料/数据卡/营销方式。
