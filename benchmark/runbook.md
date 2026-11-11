# P1 执行手册（给"编排子代理"）

> 目标：跑完**一个 arm** 的全部 discovery 任务（每次新会话），产出 `benchmark/discovery/results/*.json`。
> Lead 已把 `arms/current.json` 切到该 arm；你**不要**改任何文件/配置/其它 bundle，只建会话、跑任务、收数据、归档。

## 0. 前置检查（必须做，不匹配就停）

> **生产默认已是 `rules`，且生产插件 patch 不再配置 `strategyFile`。**
> 跑 benchmark 需要热切 arm 时：临时在 `plugins/dsh-tool-discovery/cordis.patch.yml` 的 config 里加回
> `strategyFile: <repo>/benchmark/discovery/arms/current.json`，并做一次 bundle 关→开；
> 跑完删除该行、再关→开一次恢复生产默认（`rules`）。

```bash
cd /Users/chuang/Documents/deepseek-harness/dsh-dev
node benchmark/discovery/run.mjs arms
cat benchmark/discovery/arms/current.json     # 必须是 {"strategy":"<你负责的 arm>", ...}
```

- `current.json` 里的 `strategy` 必须等于你负责的 arm（`legacy` / `rules` / `oracle` / `minimal` 之一）。
- arm id 与 strategy 同名（2026-11-10 起）；`v1-production` 是 `legacy` 的历史别名（P0 数据用），新跑一律用 strategy 名。
- 如果不等：**停止**并报告"arm 文件不匹配，未执行"，不要自己改。
- 你的新会话里先确认 discovery 正常：`search_tools`（query=`dsh session`, limit=5）应加载 `dsh_session_manage`；
  同时用 `discovery_status` 记录 `strategy` 与 `catalogTotal` 作为旁证。

## 1. 任务清单（7 个）

```
host-ops-session-list
docs-workers-limit
terminal-echo
schedule-reminder
goal-set
session-search-count
docs-d1-storage
```

## 2. 每个任务的标准流程（逐条执行）

设为 `TASK=<任务 id>`：

```bash
# ① 准备（CLI）：拿 runId 和 cwd
node benchmark/discovery/run.mjs begin --arm <你的arm> --task $TASK --rep 1
#   输出前两行形如：
#   runId: <arm>__<task>__r1__<ts>
#   cwd:   /Users/.../benchmark/discovery/work/<runId>
```

② 用 `read` 工具读取 `<cwd>/PROMPT.txt`（整段就是要发给新会话的 prompt）。

③ 调用 `dsh_session_manage`：
- action=`start`
- cwd=`<上一步输出的 cwd>`
- prompt=`PROMPT.txt` 的完整内容（原样，不要改写/截断）
- title=`P1 <arm> <task>`

④ 调用 `dsh_session_manage`：
- action=`wait`
- sessionId=`<③ 返回的 sessionId>`
- until=`done`
- timeoutMs=`300000`

若超时/未结束：再 wait 一次（timeoutMs=300000）。仍不结束则记 `invalid: timeout`，跳到 ⑥（finish 仍要跑，便于留证据）。

⑤ 收数据（CLI）：

```bash
node benchmark/discovery/run.mjs finish --run-id <runId> --session <sessionId>
# 输出含：核验 PASS/FAIL、发现指标（searches/setupSearches/targetTool/missed/loaded/usedRatio）、steps/tokens/wall/cost
```

⑥ 归档会话（必须）：

- `dsh_session_manage` action=`archive`，sessionId=`<sessionId>`

⑦ 记录一行结果：`task | PASS/FAIL | searches | setupSearches | targetTool | missed | steps | cost | wall`。

## 3. 规则 / 纪律

- **每个 run 必须全新会话**；不要复用会话、不要在一个会话里跑多个任务。
- **不 toggle bundle、不改 profile/config、不改 benchmark 文件**；只许：`run.mjs begin/finish`、`dsh_session_manage`、`read`、`bash`（仅跑上述命令）。
- 一个任务失败最多重试 **1 次**（重新 begin → 新会话）；再失败记 `invalid` 并继续下一个。
- 跑完记得把该 arm 的 7 个 `results/*.json` 已生成并归档全部会话。
- 若 `search_tools`/`dsh_session_manage` 不可用或 discovery 明显异常（如 `discovery_status` 的 `catalogTotal` 为 0），
  立即停止并报告（可能是重载/事故残留，不要自己修复）。

## 4. 最终报告格式

```
arm: <arm>
strategy 旁证: <discovery_status 的 strategy/catalogTotal>
表格：task | 核验 | searches | setupSearches | targetTool | missed | loadedUsedRatio | steps | costUsd | wallMs
汇总：pass rate / 平均 searches / missed 数 / 平均 steps / 平均 cost / 平均 wall
异常与 invalid run：...
已归档会话数：...
```
