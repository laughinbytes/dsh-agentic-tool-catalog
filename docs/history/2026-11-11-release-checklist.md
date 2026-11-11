# 2026-11-11 · Agentic Tool Catalog 发布清单

> 状态：**发布准备就绪，等待用户批准后再执行对外动作（npm publish / GitHub Release / 市场提交）**。
> 插件：`@local/dsh-agentic-tool-catalog` v0.3.0（本地）；计划对外包名：`dsh-agentic-tool-catalog`（npm 404 可用，待发布前再确认一次）。

## 1. 发布前检查（已完成）

| 项 | 状态 |
|---|---|
| 包内容（`npm pack --dry-run`） | ✅ 19 个文件（lib/docs/locale/README/LICENSE/CHANGELOG/icon） |
| `./scripts/check-plugins.sh` | ✅ 全部通过（10 个 bundle） |
| `verify-agentic-tool-catalog.mjs` | ✅ 55/55 |
| `verify-agentic-tool-catalog-schema.mjs` | ✅ 29/29（含 client/SSE/路由） |
| `audit-plugin-presentation.mjs` | ✅ 9 个产品 bundle 全合规 |
| `verify-plugin-meta.mjs` | ✅ 9 个 bundle title/description/icon 可解析 |
| 双语文档 | ✅ README.md / README.zh.md、docs/detail.md/.zh.md、locale en/zh |
| License | ✅ MIT（LICENSE 已打包） |
| CHANGELOG | ✅ 0.3.0 记录 rename/storage/UI/迁移修复 |
| 数据卡 | ✅ with vs without（−83.3% schema、−62.6% 首请求 tokens、−40.6% 总 tokens、100% 通过率）+ 质量指标 |
| UI 截图 | ✅ `docs/assets/ui-panel.png` / `ui-dock.png`，README 引用 |
| 生产安装/热重载 | ✅ bundle installed/enabled，client graph 含 UI，无需重启 |

## 2. 发布动作（待批准后执行）

1. **版本决策**（建议）：对外首发用 **0.1.0**（公开线从零开始），或沿用 **0.3.0**（体现内部迭代成熟度）。
   当前 package.json 是 0.3.0；若选 0.1.0，更新 package.json + CHANGELOG 标题即可。
2. npm：
   ```bash
   cd plugins/dsh-agentic-tool-catalog
   npm publish --access public
   ```
   发布前最后确认 `dsh-agentic-tool-catalog` 在 npm 仍 404。
3. GitHub：
   - tag（建议 `agentic-tool-catalog-v0.3.0`）；
   - Release notes 使用 CHANGELOG 顶部 + 数据卡关键数字；
   - 确认 README 首屏（截图/安装/数字）渲染正常。
4. DSH 安装验证（干净 profile）：
   ```bash
   dsh plugin --profile web add dsh-agentic-tool-catalog
   ```
   确认 `application:"applied"`、工具数/目录生成正常、composer dock 出现。
5. 市场收录（提交材料已备）：
   - [awesome-dsh-plugin](https://github.com/LingHXiao/awesome-dsh-plugin)（PR）
   - dshbase / dshplugin.store / dpharness / dsh.directory
   - 统一一句话（en/zh）：
     - EN: *An agent builds and maintains your tool catalog. Schemas stay out of context until `search_tools` loads them; works with any plugin/MCP tool with zero cooperation; cached in official DSH Storage.*
     - ZH: *由 Agent 自动生成并维护工具目录：工具 schema 默认不占上下文，按需加载；任何插件/MCP 工具零配合接入；缓存走官方 DSH Storage。*
6. 发布后观察：
   - 安装/启动失败率、首次生成耗时/失败率；
   - 目录质量反馈（组名/搜索命中）；
   - 数据卡 v2.1（第二模型/更多任务）只有在外部关注度足够时再做，不预先烧钱。

## 3. 对外必须写明的边界（已写入 README/docs）

- 只覆盖 tools（skills 走原生 progressive disclosure，v1.1 评估统一发现）；
- 不声称"省钱"（成本 ≈ 持平；省的是上下文/tokens）；
- 5 任务 ×2 轮、单模型、单 profile，不外推；
- 生成是一次性背景成本，未混入任务指标；精确计费列为后续；
- Agent Teams 常驻工具是其 scoped 注册机制导致，第三方无法 restrict；Team profile 下接受现状；
- 无设置页；catalog 自动维护；UI 只读（状态/分组/存储/刷新时间）。

## 4. 发布前需要用户决定

1. **对外版本号**：0.1.0（推荐首发）还是 0.3.0；
2. 是否现在就 **npm publish + GitHub Release + 市场提交**，还是先只做 npm 灰度；
3. GitHub 仓库/tag 命名（当前工作区是多插件单仓）。
