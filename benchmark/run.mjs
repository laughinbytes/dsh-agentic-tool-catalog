#!/usr/bin/env node
/**
 * run.mjs — 能力发现 benchmark 的编排器（两段式，同 operator/benchmark/eval 的做法）。
 *
 * 为什么两段式：创建 DSH 会话必须走 `dsh_session_manage`（agent 工具），node CLI 做不到；
 * 所以 CLI 负责"准备实验目录 + 打印 prompt"和"收数据 + 核验 + 落盘"，agent 负责建会话/等结束/归档。
 *
 * 用法：
 *   node benchmark/discovery/run.mjs arms                     # 查看 arms 与配置方法
 *   node benchmark/discovery/run.mjs tasks                    # 查看任务
 *   node benchmark/discovery/run.mjs begin --arm v1-production --task control-sum --rep 1
 *   node benchmark/discovery/run.mjs finish --run-id <runId> --session <sessionId>
 *   node benchmark/discovery/run.mjs report --file results/<a>.json --file results/<b>.json
 *
 * 约定：
 *   - 每个 run = 全新会话（`dsh_session_manage start`），cwd = 本次实验目录；
 *   - 每次跑完归档会话（`dsh_session_manage archive`）；
 *   - arm 切换 = 改变 discovery 配置；切换前后都要确认新会话首请求工具数符合预期（记录在 note 里）；
 *   - 不采信模型自述：pass/fail 只看 verify.mjs 的文件断言。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { analyzeSession, discoveryMetrics, findSessionLog, loadTasks } from './metrics.mjs'
import { verifyTask } from './verify.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
const ROOT = resolve(HERE, '../..')
const RUNS_DIR = join(HERE, 'runs')
const RESULTS_DIR = join(HERE, 'results')
const WORK_DIR = join(HERE, 'work')

/** 对照臂。status: ready = 现在就能跑；planned = 等 v2 引擎/对应实现落地。 */
export const ARMS = {
  'baseline-resident': {
    title: '数据卡 baseline：所有工具常驻上下文（等价“不用按需目录”）',
    status: 'ready',
    setup: '插件 config resident: ["*"]（全部常驻），目录为空；所有工具 schema 每次请求都发送。',
    restore: '删除 resident 覆盖并关→开一次。',
    expectations: '不加载目录、无 search_tools 需求；用于与 on-demand 组对照。',
  },
  'agent-catalog': {
    title: '数据卡 treatment：Agentic Tool Catalog（按需目录）',
    status: 'ready',
    setup: '生产配置（无 resident 覆盖）；目录由 agent 生成并缓存。',
    restore: '无需操作。',
    expectations: '只发送目录提示；工具按需加载。',
  },
  // P1 起：arm id = v2 引擎的 strategy 名（current.json 里的 strategy），语义直白。
  // `v1-production` 保留为 legacy 的历史别名（P0-lite 结果文件用的是它）。
  legacy: {
    title: 'legacy 策略（baseline：v1 硬编码 KNOWN_GROUPS，行为与线上一致）',
    status: 'ready',
    setup: '把 benchmark/discovery/arms/current.json 的 strategy 设为 legacy（改文件即热生效，新会话可见）。',
    restore: '无需操作。',
    expectations: '93 个按需工具按 legacy 9 组 + MCP 自动组划分。',
  },
  rules: {
    title: 'rules 策略（名字聚类 + others，零插件配合）',
    status: 'ready',
    setup: 'arms/current.json → strategy=rules；确认新会话 discovery_status.strategy=rules。',
    restore: '改回 legacy 或下一 arm。',
    expectations: '12 组 + 7 others；browser 28 一次整组加载。',
  },
  bm25: {
    title: 'BM25 关键词检索（业界验证基线；无分组）',
    status: 'ready',
    setup: 'arms/current.json → strategy=bm25；确认新会话 discovery_status.strategy=bm25、pendingGroups=[]。',
    restore: '改回 rules。',
    expectations: '检索质量基线；无组提示，考察"纯检索"能走到哪。',
  },
  'rules-bm25': {
    title: 'rules 分组 + BM25 检索（混合）',
    status: 'ready',
    setup: 'arms/current.json → strategy=rules-bm25；确认新会话 strategy=rules-bm25。',
    restore: '改回 rules。',
    expectations: '组目录（awareness）+ BM25 排序（精度）的组合，候选生产方案。',
  },
  'rules-jev-pre': {
    title: '组合别名：rules + Jev 预计算判组（= jev-precompute）',
    status: 'ready',
    setup: 'arms/current.json → strategy=jev-precompute。',
    restore: '写回 rules。',
    expectations: '等价 jev-precompute。',
  },
  'bm25-jev-online': {
    title: '组合：BM25 检索 + 低置信时 Jev 重排',
    status: 'ready',
    setup: 'arms/current.json → strategy=bm25-jev-online（需 external 可用）。',
    restore: '写回 rules。',
    expectations: '关键词精度 + 语义边界补足；只为低置信查询付一次 Jev。',
  },
  'full-combo': {
    title: '组合：结构 + rules + BM25 + Jev 判组 + 低置信重排',
    status: 'ready',
    setup: 'arms/current.json → strategy=full-combo（external 不可用时自动回退）。',
    restore: '写回 rules。',
    expectations: '理论最优组合；用于对照各单层贡献（消融）。',
  },
  'agent-auto': {
    title: '真 agent 自动分组（生产化：目录变化时插件自动生成 + 缓存）',
    status: 'ready',
    setup: '插件 config: strategy=agent-precompute（无需 arm 文件）；首次会话后台生成、缓存后即时命中。',
    restore: '改回 rules 并重载。',
    expectations: '与静态 agent 分组同质量；首次生成 ~70s/进程，之后零成本。',
  },
  'agent-precompute': {
    title: '真 agent 预计算分组（多步+用工具+自检；非一次性 LLM）',
    status: 'ready',
    setup: '先由真实子代理生成 benchmark/discovery/arms/agent-groups.json，再把 arms/current.json 设成 oracle 策略并嵌入该 groups（agent 生成目录 → 任务实测）。',
    restore: '写回 rules。',
    expectations: 'agent 生成的目录质量；测量多步 agent 分组相对 rules/oracle 的收益。',
  },
  'agent-online': {
    title: '真 agent 在线选工具（多步探索；待实现/评估）',
    status: 'planned',
    setup: '待插件通过 DSH subagent 服务在搜索时发起子代理选择；成本/延迟需单独评估。',
    restore: '写回 rules。',
    expectations: '高延迟/高成本；只在歧义/重要任务触发，失败回退规则排序。',
  },
  oracle: {
    title: 'oracle 尺子（人工最优分组，质量上界）',
    status: 'ready',
    setup: 'arms/current.json → strategy=oracle（带 oracle.groups）；如需调整先改 arms/oracle.json。',
    restore: '改回 legacy 或下一 arm。',
    expectations: '质量上界参考；衡量自动方案离"分组完美"差多少。',
  },
  minimal: {
    title: 'minimal 尺子（不分组，只有工具名清单）',
    status: 'ready',
    setup: 'arms/current.json → strategy=minimal；确认新会话 pendingGroups=[] 且 pendingOthers 很大。',
    restore: '改回 legacy 或下一 arm。',
    expectations: '验证"组"本身的价值（与 rules/legacy 对比）。',
  },
  'v1-production': {
    title: '现状 v1：硬编码 KNOWN_GROUPS + 规则搜索',
    status: 'ready',
    setup: '保持 Tool Discovery bundle 开启（默认形态）。',
    restore: '无需操作。',
    expectations: '首请求约 34 个常驻工具；搜索后按需加载。',
  },
  'full-load': {
    title: '对照：关闭按需发现（全部工具常驻）',
    status: 'ready',
    setup: 'Plugins 页把 Tool Discovery bundle 关掉（或 plugin_manager set_bundle enabled=false），并确认新会话首请求 tools 数明显变大。',
    restore: '重新打开 Tool Discovery bundle（关→开），确认 group note 恢复。',
    expectations: '首请求 = 全量工具；无 search_tools。用于量"信息上限/成本最差"。',
  },
  'rules-v2': {
    title: '历史别名：rules（v2 规则聚类）',
    status: 'ready',
    setup: 'arms/current.json → strategy=rules（与 rules 相同）。',
    restore: '写回 rules。',
    expectations: '等价 rules。',
  },
  'jev-precompute': {
    title: 'v2 + Jev 预计算判组（M11a）',
    status: 'ready',
    setup: 'arms/current.json → strategy=jev-precompute（需 external 凭据可用，否则自动回退 rules 并记降级）。',
    restore: '写回 rules。',
    expectations: '组归属更准（能读描述）；外部不可用 = 等价 rules。',
  },
  'jev-online': {
    title: 'v2 + Jev 在线选组/筛选（M11b）',
    status: 'ready',
    setup: 'arms/current.json → strategy=jev-online（需 external 可用；低置信/歧义时重排）。',
    restore: '写回 rules。',
    expectations: '一次命中率更高；每次 search +0.6–0.7s；失败回退原排序。',
  },
}

function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function repoHead() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function ensureDirs() {
  for (const dir of [RUNS_DIR, RESULTS_DIR, WORK_DIR]) mkdirSync(dir, { recursive: true })
}

function promptFor(task) {
  const forbid = (task.forbid ?? []).length > 0
    ? `\n\n注意：本任务禁止使用这些工具：${task.forbid.join('、')}。`
    : ''
  return `${task.prompt}${forbid}\n\n当前工作目录就是本次实验目录（所有输出文件都写在这里）。完成后简短说明你用了哪些能力，然后结束。`
}

function cmdArms() {
  for (const [id, arm] of Object.entries(ARMS)) {
    console.log(`\n[${arm.status}] ${id} — ${arm.title}`)
    console.log(`  切换：${arm.setup}`)
    console.log(`  恢复：${arm.restore}`)
    console.log(`  预期：${arm.expectations}`)
  }
}

function cmdTasks() {
  const db = loadTasks()
  for (const task of db.tasks) {
    console.log(`${task.id.padEnd(28)} family=${task.family.padEnd(14)} phase=${task.phase}  ${task.title}`)
  }
  console.log(`\n共 ${db.tasks.length} 个任务；family 定义见 tasks.json。`)
}

function cmdBegin(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const armId = get('--arm')
  const taskId = get('--task')
  const rep = Number(get('--rep') ?? 1)
  const note = get('--note') ?? ''
  if (!armId || !taskId) {
    console.error('用法：node benchmark/discovery/run.mjs begin --arm <arm> --task <taskId> [--rep 1] [--note "..."]')
    process.exit(2)
  }
  const arm = ARMS[armId]
  if (!arm) {
    console.error(`未知 arm：${armId}（可运行 arms 子命令查看）`)
    process.exit(2)
  }
  const db = loadTasks()
  const task = db.tasks.find((t) => t.id === taskId)
  if (!task) {
    console.error(`未知 task：${taskId}`)
    process.exit(2)
  }
  ensureDirs()
  const runId = `${armId}__${taskId}__r${rep}__${nowStamp()}`
  const workdir = join(WORK_DIR, runId)
  // 防跨 run 泄漏：新 run 开始前清掉 work/ 下的旧实验目录（results/ 里的证据 JSON 不受影响）。
  // 背景：P2 Batch A 发现任务会话曾读取其它 arm 的旧 sessions.txt 作参考（跨 arm 污染信号）。
  try {
    for (const entry of readdirSync(WORK_DIR)) {
      if (entry === runId) continue
      rmSync(join(WORK_DIR, entry), { recursive: true, force: true })
    }
  } catch {}
  mkdirSync(workdir, { recursive: true })
  for (const [name, content] of Object.entries(task.fixtures ?? {})) writeFileSync(join(workdir, name), content)
  const meta = {
    runId,
    arm: armId,
    armTitle: arm.title,
    armStatus: arm.status,
    taskId,
    taskTitle: task.title,
    family: task.family,
    rep,
    prompt: promptFor(task),
    workdir,
    createdAt: new Date().toISOString(),
    repoHead: repoHead(),
    note,
    sessionId: null,
  }
  writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(meta, null, 2))
  // 给"agent 编排器"直接读取的 prompt 文件（避免手工复制长 prompt）。
  writeFileSync(join(workdir, 'PROMPT.txt'), `${meta.prompt}\n`)
  console.log(`runId: ${runId}`)
  console.log(`arm:   ${armId}（${arm.title}）`)
  console.log(`task:  ${taskId}（family=${task.family}）`)
  console.log(`cwd:   ${workdir}`)
  console.log(`\n--- 发给新会话的 prompt ---\n${meta.prompt}\n--- end ---`)
  console.log('\n下一步（agent）：dsh_session_manage start（cwd 用上面的目录、prompt 用上面文本）→ wait 结束')
  console.log(`完成后：node benchmark/discovery/run.mjs finish --run-id ${runId} --session <sessionId>`)
  console.log('并归档会话：dsh_session_manage archive ' + '<sessionId>')
}

function cmdFinish(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const runId = get('--run-id')
  const sessionId = get('--session')
  if (!runId || !sessionId) {
    console.error('用法：node benchmark/discovery/run.mjs finish --run-id <runId> --session <sessionId>')
    process.exit(2)
  }
  const metaPath = join(RUNS_DIR, `${runId}.json`)
  if (!existsSync(metaPath)) {
    console.error(`找不到 run meta：${metaPath}`)
    process.exit(2)
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const log = findSessionLog(sessionId)
  if (!log) {
    console.error(`找不到会话日志：${sessionId}（会话是否已建？）`)
    process.exit(2)
  }
  const db = loadTasks()
  const task = db.tasks.find((t) => t.id === meta.taskId)
  const metrics = analyzeSession(log)
  const discovery = discoveryMetrics(metrics, task, db.families)
  const verification = verifyTask(task, meta.workdir)
  const result = {
    ...meta,
    sessionId,
    finishedAt: new Date().toISOString(),
    verify: verification,
    metrics,
    discovery,
  }
  ensureDirs()
  const outPath = join(RESULTS_DIR, `${runId}.json`)
  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`结果已写入：${outPath}`)
  console.log(`核验：${verification.ok ? 'PASS' : 'FAIL'}`)
  for (const c of verification.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
  console.log(`发现指标：searches=${discovery.searchCount} setupSearches=${discovery.setupSearchCount} ` +
    `targetTool=${discovery.firstTargetTool ?? 'NONE'} missed=${discovery.missedCapability} ` +
    `loaded=${discovery.loadedToolCount} usedRatio=${discovery.loadedUsedRatio}`)
  console.log(`会话：steps=${metrics.steps} tokens=${metrics.tokens.inputTokens + metrics.tokens.cacheReadTokens + metrics.tokens.outputTokens} ` +
    `wallMs=${metrics.wallMs} firstTools=${metrics.firstRequestTools?.count ?? '?'} costUsd≈${metrics.costUsd.toFixed(4)}`)
  console.log(`\n记得归档会话：dsh_session_manage archive ${sessionId}`)
}

function loadResultFiles(argv) {
  const files = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') files.push(argv[i + 1])
  }
  if (files.length === 0) {
    if (!existsSync(RESULTS_DIR)) return []
    return readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')).map((f) => join(RESULTS_DIR, f))
  }
  return files.map((f) => resolve(f))
}

function avg(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  return nums.length === 0 ? null : Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3))
}

function cmdReport(argv) {
  const results = loadResultFiles(argv).map((f) => JSON.parse(readFileSync(f, 'utf8')))
  // 历史别名：P0-lite 的 v1-production 结果 = legacy 臂。
  for (const r of results) if (r.arm === 'v1-production') r.arm = 'legacy'
  if (results.length === 0) {
    console.log('还没有结果文件。先跑 begin + finish。')
    return
  }
  const byArm = new Map()
  for (const r of results) {
    const key = r.arm
    if (!byArm.has(key)) byArm.set(key, [])
    byArm.get(key).push(r)
  }
  console.log('arm\t n\t pass\t searches\tsetupS\tmissed\tusedRatio\tfirstTools\tsteps\tcostUsd\twallMs')
  for (const [arm, runs] of [...byArm.entries()].sort()) {
    const d = runs.map((r) => r.discovery ?? {})
    const m = runs.map((r) => r.metrics ?? {})
    const passRate = avg(runs.map((r) => (r.verify?.ok ? 1 : 0)))
    console.log([
      arm,
      runs.length,
      passRate,
      avg(d.map((x) => x.searchCount)),
      avg(d.map((x) => x.setupSearchCount)),
      avg(d.map((x) => (x.missedCapability ? 1 : 0))),
      avg(d.map((x) => x.loadedUsedRatio)),
      avg(m.map((x) => x.firstRequestTools?.count)),
      avg(m.map((x) => x.steps)),
      avg(m.map((x) => x.costUsd)),
      avg(m.map((x) => x.wallMs)),
    ].join('\t'))
  }
  console.log(`\n共 ${results.length} 个 run；对照臂定义见 arms 子命令。`)
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  ensureDirs()
  switch (cmd) {
    case 'arms': cmdArms(); break
    case 'tasks': cmdTasks(); break
    case 'begin': cmdBegin(rest); break
    case 'finish': cmdFinish(rest); break
    case 'report': cmdReport(rest); break
    default:
      console.log('用法：run.mjs <arms|tasks|begin|finish|report> [参数]；细节见文件头注释。')
      process.exit(2)
  }
}

if (process.argv[1] && process.argv[1].endsWith('run.mjs')) main()
