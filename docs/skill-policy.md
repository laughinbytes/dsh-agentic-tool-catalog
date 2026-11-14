# Skill 安装与放置规范

> 基线：适用于本机所有 agent 客户端与宿主；最后核对 2026-11-14。

适用范围：本机所有 agent 客户端与所有 skill，不针对某个产品或某个仓库。  
Cloudflare 只是文末的一个案例，不是特例；任何 skill 都按同一套规则处理。

## 0. 五条硬规则

1. **先定归属，再安装**：先回答「谁用、用在哪、跟谁共享」，再决定目录。
2. **一个 scope 一份 canonical copy**：同一 scope 不维护两份同名 skill，不建软链农场。
3. **单客户端 skill 不进共享目录**：共享目录是显式例外，不是默认。
4. **不用通用第三方 skill 安装器**：只用客户端官方插件市场，或从官方源固定版本直接落盘。
5. **每次安装留下一份安装记录**（本机运维约定，不是 Agent Skills 或 DSH 的加载要求）：source、ref、scope、skill 列表、方式、时间。

## 1. 放置决策树

```text
这个 skill 只服务一个仓库吗？
├─ 是 → 项目级
│   ├─ 只给 DSH          → <repo>/.dsh/skills/<name>/
│   └─ 确实要给多个客户端 → <repo>/.agents/skills/<name>/   # 提交进仓库
└─ 否 → 用户级
    ├─ 只给 DSH           → ~/.dsh/skills/<name>/
    ├─ 只给 Claude Code   → ~/.claude/skills/<name>/
    ├─ 只给 Codex         → ~/.codex/skills/<name>/
    ├─ 只给 Cursor        → ~/.cursor/skills/<name>/
    ├─ 只给 Gemini CLI    → ~/.gemini/skills/<name>/
    ├─ 多客户端确实共享   → ~/.agents/skills/<name>/        # 默认避免
    └─ 随插件/包分发       → 包内 skills/<name>/，由 provider 或 customSkillDirs 加载
```

### 对照表

| 位置 | 归属 | 典型用途 | 默认建议 |
|---|---|---|---|
| `<repo>/.dsh/skills` | 项目 / DSH | 项目专用流程、项目内约定 | 优先 |
| `<repo>/.agents/skills` | 项目 / 多客户端 | 团队共享、随仓库提交 | 仅显式共享时 |
| `~/.dsh/skills` | 用户 / DSH | 跨项目、只给 DSH | 优先 |
| `~/.agents/skills` | 用户 / 多客户端 | Codex、Cline、Warp 等共享 | **默认避免** |
| `~/.claude/skills` | 用户 / Claude Code | Claude 专属 | 客户端自己管 |
| `~/.codex/skills` | 用户 / Codex | Codex 专属 | 客户端自己管 |
| 客户端其他目录 | 用户 / 单客户端 | Cursor、Gemini、Copilot 等 | 按客户端文档 |
| 包内 `skills/` | 插件/包 | 与插件同生命周期的能力 | 随包分发时 |
| runtime 注册 | 进程/插件 | 动态集成说明，不是批量内容 | 仅少量、动态 |

## 2. DSH 的优先级与含义

同层同名时按 rank 小者优先；不同 scope 以「最近层」为准。

| Rank | source | 根 |
|---:|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills`，默认 `~/.dsh/skills` |
| 500 | `user-agents` | `<agentsHome>/skills`，默认 `~/.agents/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` / `DSH_BUNDLED_SKILL_DIR` |
| 250 | `runtime` | `ctx.skills.register()`，不是文件目录 |

由此得到三条实际结论：

- **项目覆盖用户**：项目 `.dsh/skills` 或 `.agents/skills` 可以覆盖用户级同名 skill。
- **runtime 不适合批量内容**：runtime rank 250 会高于 `custom` 300 和 `user-dsh` 400；把一批官方 skill 全注册成 runtime，会盖住用户手放的版本。runtime 只用于「这个集成在当前进程里怎么用」这类动态说明。
- **bundled 最低**：随包 skill 为 rank 600，适合做默认值，让项目/用户覆盖。

## 3. 来源、版本与清单

### 3.1 来源优先级

1. 产品官方仓库 / 官方插件市场
2. 官方发布的包（npm、PyPI 等）
3. 经审查的内部仓库
4. 个人手写

不直接从博客、聊天记录、网盘压缩包安装 skill。

### 3.2 固定版本

- Git 源固定到 **tag 或 commit**，不用 `main` / `latest` 作为长期状态。
- 包源固定版本号。
- 客户端插件市场无法固定 commit 时，记录市场、仓库和安装日期；升级前看 changelog。
- 更新前先 diff；不要在未读变更的情况下整体覆盖。

### 3.3 清单

每个 scope 可以有一份安装记录（清单），放在**被扫描的 skills 根目录之外**，例如 `~/.dsh/skills.lock.json`。

> **这不是 Agent Skills 规范或 DSH 的加载要求。** Agent Skills 规范只规定每个 skill 的
> `SKILL.md`；DSH 只负责发现这些文件。Vercel `skills` 的 `skills-lock.json` 属于那个安装器，
> 也不是通用标准。这里的“清单”是本机为了可复现、可更新、可移除而采用的运维约定。
>
> DSH 只识别两种 skill：`<root>/<name>/SKILL.md`（目录型）和 `<root>/<name>.md`（flat 型）。
> `.json` 不会被识别；把 `skills.lock.json` 放进根目录不会变成 skill，但会破坏“根目录只放
> skill”的约定。Markdown 清单若放在根目录，会被当成 flat skill 候选；没有合法 frontmatter
> 会警告并忽略，有 frontmatter 才可能成为一个技能。

示例：

```json
{
  "scope": "user-dsh",
  "source": "https://github.com/owner/repo",
  "ref": "0123456789abcdef",
  "method": "vendored-copy",
  "installedAt": "YYYY-MM-DD",
  "skills": ["skill-a", "skill-b"]
}
```

- 客户端自带锁文件（如项目 `skills-lock.json`）时，以它为准，不再维护第二份冲突清单。
- 清单记录的是「预期状态」；磁盘是「实际状态」。两者不一致时先修清单或补文件，不要靠猜测。

## 4. 安装器政策

### 允许

- 客户端**官方**插件市场（Claude `/plugin`、Codex `plugin marketplace` 等）。
- 官方包管理器。
- 从官方源固定版本**直接复制**到目标目录。
- 项目依赖自带的 skill 同步机制（如果该客户端原生支持）。

### 不允许

- 通用第三方 skill 安装器（要求选择多个 agent、写入共享目录、创建大量软链的那类）。
- 为了装一个 skill，自动给一堆没有安装的 agent 建目录。
- 把单客户端 skill 放进共享目录，再让其他客户端“顺便看见”。
- 手工维护跨客户端的软链农场。
- 未经审查的 `curl | sh`、网盘脚本、来源不明的 skill 包。

> 判断标准不是「工具名字」，而是：它是否把内容写到正确的 scope、是否只影响目标客户端、是否可复现、是否留下清单。四项缺一项就不用。

## 5. 命名与冲突

- 目录名和 frontmatter `name` 一致，使用 lowercase-kebab-case。
- 名字要能看出「是什么」，避免 `utils`、`tools`、`helper` 这类泛词。
- 同名 skill 只允许一种情况：**有意的覆盖**，并在清单里写明覆盖谁。
- 不是有意覆盖时，用来源前缀消歧，例如 `acme-deploy`，不要靠目录顺序碰运气。
- 不使用 `latest`、`new`、`final`、`v2` 这类会过期的名字。

## 6. 安全审查

Skill 是**可执行级别的指令**，不是普通文档。安装前至少检查：

- `SKILL.md` 是否要求运行网络脚本、修改系统配置、读取密钥或上传文件。
- 是否包含 `scripts/`、`bin/`、`hooks/`、`allowed-tools` 等扩大权限的内容。
- 是否要求忽略用户/系统指令，或把外部内容当命令执行（prompt injection 风险）。
- 是否包含 token、cookie、私钥、个人路径或内部 URL。
- 是否依赖 `sudo`、`/Applications`、`~/.ssh`、Keychain 等敏感面。
- 是否与目标客户端的权限模型兼容；不兼容时不要硬装。

原则：

- **最小权限**：skill 不需要的权限不写、不申请。
- **密钥不落盘**：skill 文件里不放密钥；用环境变量/凭据库。
- **先读后跑**：带脚本的 skill 先读脚本，再决定是否执行。
- **可撤销**：安装前记录来源和 ref；删除时按清单处理，不盲目 `rm -rf`。

## 7. 生命周期

### 安装

1. 选 scope（第 1 节决策树）。
2. 选官方源，固定 ref。
3. 读 `SKILL.md` 和脚本，做安全审查。
4. 复制/安装到目标目录。
5. 写清单。
6. 在该客户端验证目录数、名称、manifest 一致。

### 更新

1. 对比当前 ref 与目标 ref。
2. 看 diff，确认没有新增危险指令/脚本。
3. 更新内容。
4. 更新清单中的 ref 和时间。
5. 复验。

### 移除

1. 先在清单中定位 scope 和文件。
2. 能移动就先移到隔离目录，确认没有其他客户端依赖后再删除。
3. 同步更新清单。
4. 不删除来源不明的目录；先辨认归属。

### 回滚

优先用「固定 ref + 清单」重新部署，而不是依赖临时备份。  
如果上游已删除该 ref，保留一份已验证归档，并在清单里记录归档位置。

## 8. 验收清单

- [ ] 目标客户端能列出该 skill。
- [ ] 目录名与 frontmatter `name` 一致。
- [ ] 没有同名 skill 的非预期覆盖。
- [ ] 清单数量 = 磁盘数量。
- [ ] 没有断链、没有指向共享目录的隐式软链。
- [ ] 没有把单客户端 skill 写进 `~/.agents` 等共享路径。
- [ ] 至少实际加载一次，确认正文可读、资源路径可解析。
- [ ] 更新/移除后，其他客户端目录未被波及。

## 9. 例外

例外必须同时满足：

1. 有明确原因（例如团队确实要求跨客户端共享）。
2. 只落在**一个**共享 scope，不复制到多个客户端目录。
3. 清单里写明「共享」以及受影响的客户端。
4. 升级前评估所有受影响客户端。

没有这四条，不走共享目录。

## 10. 案例（非规范）

本机 Cloudflare 的处理只是套用上面的规则：

- 22 个官方 Cloudflare skill 是用户级、只给 DSH → `~/.dsh/skills`。
- 来源固定到官方仓库 commit，清单放 `~/.dsh/skills.lock.json`。
- 不使用通用第三方安装器。
- Codex / Claude 的 Cloudflare 能力由各自官方插件市场安装，留在各自目录。
- 旧的 `~/.agents` 共享副本移除，避免单客户端内容污染共享 scope。

换作任何其他产品，按第 1 节重新选 scope 即可，不需要为某个产品另立一套规则。
