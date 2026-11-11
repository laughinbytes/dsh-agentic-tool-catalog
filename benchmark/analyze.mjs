#!/usr/bin/env node
/**
 * analyze.mjs — P1 锦标赛汇总（按 arm × task 去重后比较；不采信模型自述）。
 *
 * 规则：
 *   - 同一 (arm, task) 有多次 run（重试/验收规则修正）时，**优先使用 PASS 的一次**；
 *     全部 FAIL 则记为该项失败（取最后一次）。
 *   - 控制任务（family=control）默认不计入发现类指标（它们不测发现能力），单独标注。
 *   - 输出：每个 arm 的 pass 率、平均 searches / setupSearches / missed 率 / 已加载工具利用率 /
 *     steps / cost / wall；以及离 oracle 的差距（若 oracle arm 存在）。
 *
 * 用法：
 *   node benchmark/discovery/analyze.mjs                 # 读 results/ 全部
 *   node benchmark/discovery/analyze.mjs --markdown      # 输出 markdown 表
 *   node benchmark/discovery/analyze.mjs --json          # 输出 JSON
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)
const RESULTS_DIR = join(HERE, 'results')

const ARM_ALIAS = { 'v1-production': 'legacy' }
const TASK_ORDER = [
  'host-ops-session-list',
  'docs-workers-limit',
  'terminal-echo',
  'schedule-reminder',
  'goal-set',
  'session-search-count',
  'docs-d1-storage',
]

function loadResults() {
  if (!existsSync(RESULTS_DIR)) return []
  return readdirSync(RESULTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(RESULTS_DIR, file), 'utf8')))
    .map((run) => ({ ...run, arm: ARM_ALIAS[run.arm] ?? run.arm }))
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const mean = (values) => {
  const list = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  return list.length === 0 ? null : Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(3))
}
const pct = (values) => {
  const list = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (list.length === 0) return null
  return Number(((list.filter((v) => v > 0).length / list.length) * 100).toFixed(1))
}

/** 每个 (arm, task) 选一条代表 run：优先 PASS；否则取最后一次。 */
function pickRepresentative(runs) {
  const byKey = new Map()
  for (const run of runs) {
    const key = `${run.arm}\u0000${run.taskId}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(run)
  }
  const picked = []
  for (const group of byKey.values()) {
    const passing = group.filter((run) => run.verify?.ok === true)
    if (passing.length > 0) picked.push(passing[passing.length - 1])
    else picked.push(group[group.length - 1])
  }
  return picked
}

function summarize(runs) {
  const reps = allReps ? runs : pickRepresentative(runs)
  const discoveryRuns = reps.filter((run) => run.family !== 'control')
  const byArm = new Map()
  for (const run of discoveryRuns) {
    if (!byArm.has(run.arm)) byArm.set(run.arm, [])
    byArm.get(run.arm).push(run)
  }
  const arms = [...byArm.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([arm, armRuns]) => {
    const d = armRuns.map((run) => run.discovery ?? {})
    const m = armRuns.map((run) => run.metrics ?? {})
    return {
      arm,
      tasks: armRuns.length,
      passRate: pct(armRuns.map((run) => (run.verify?.ok ? 1 : 0))),
      searchCount: mean(d.map((x) => num(x.searchCount))),
      setupSearchCount: mean(d.map((x) => num(x.setupSearchCount))),
      missedRate: pct(d.map((x) => (x.missedCapability ? 1 : 0))),
      loadedUsedRatio: mean(d.map((x) => x.loadedUsedRatio)),
      steps: mean(m.map((x) => num(x.steps))),
      costUsd: mean(m.map((x) => num(x.costUsd))),
      wallMs: mean(m.map((x) => num(x.wallMs))),
      perTask: armRuns.map((run) => ({
        task: run.taskId,
        pass: run.verify?.ok === true,
        searches: run.discovery?.searchCount,
        setupSearches: run.discovery?.setupSearchCount,
        targetTool: run.discovery?.firstTargetTool,
        missed: run.discovery?.missedCapability,
        loadedUsedRatio: run.discovery?.loadedUsedRatio,
        steps: run.metrics?.steps,
        costUsd: run.metrics?.costUsd,
        wallMs: run.metrics?.wallMs,
      })).sort((a, b) => TASK_ORDER.indexOf(a.task) - TASK_ORDER.indexOf(b.task)),
    }
  })
  return { arms, representativeRuns: reps.length, rawRuns: runs.length, allReps }
}

function gapFromOracle(summary) {
  const oracle = summary.arms.find((arm) => arm.arm === 'oracle')
  if (oracle === undefined) return []
  return summary.arms
    .filter((arm) => arm.arm !== 'oracle')
    .map((arm) => ({
      arm: arm.arm,
      passGap: oracle.passRate !== null && arm.passRate !== null ? Number((oracle.passRate - arm.passRate).toFixed(1)) : null,
      searchGap: oracle.searchCount !== null && arm.searchCount !== null ? Number((arm.searchCount - oracle.searchCount).toFixed(3)) : null,
      stepGap: oracle.steps !== null && arm.steps !== null ? Number((arm.steps - oracle.steps).toFixed(2)) : null,
    }))
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const asMarkdown = args.includes('--markdown')
const onlyCommon = args.includes('--common')
const allReps = args.includes('--all-reps')
const armFilterIndex = args.indexOf('--arms')
const armFilter = armFilterIndex >= 0 && args[armFilterIndex + 1] ? new Set(args[armFilterIndex + 1].split(',')) : null
const sinceIndex = args.indexOf('--since')
const since = sinceIndex >= 0 && args[sinceIndex + 1] ? Date.parse(args[sinceIndex + 1]) : null
let results = loadResults()
if (armFilter !== null) results = results.filter((run) => armFilter.has(run.arm))
if (since !== null && Number.isFinite(since)) results = results.filter((run) => Date.parse(run.createdAt ?? 0) >= since)
if (results.length === 0) {
  console.error('没有 results；先跑 P1。')
  process.exit(2)
}
if (onlyCommon) {
  // 只保留"每个非 control arm 都跑过"的任务，保证 arm 间可比较（不同批次任务子集可能不同）。
  const armsForCommon = new Set(results.filter((run) => run.family !== 'control').map((run) => run.arm))
  const taskSets = new Map()
  for (const run of results) {
    if (run.family === 'control') continue
    if (!taskSets.has(run.arm)) taskSets.set(run.arm, new Set())
    taskSets.get(run.arm).add(run.taskId)
  }
  const allSets = [...taskSets.values()]
  const common = new Set(allSets[0] ?? [])
  for (const set of allSets.slice(1)) for (const task of [...common]) if (!set.has(task)) common.delete(task)
  results = results.filter((run) => run.family === 'control' || common.has(run.taskId))
  console.log(`--common：只比较 ${common.size} 个共同任务（${[...common].sort().join(', ')}）\n`)
}
const summary = summarize(results)
const gaps = gapFromOracle(summary)

if (asJson) {
  console.log(JSON.stringify({ ...summary, gaps }, null, 2))
  process.exit(0)
}

const header = ['arm', 'n', 'pass%', 'searches', 'setupS', 'missed%', 'usedRatio', 'steps', 'costUsd', 'wallMs']
if (asMarkdown) {
  console.log(`| ${header.join(' | ')} |`)
  console.log(`|${header.map(() => '---').join('|')}|`)
  for (const arm of summary.arms) {
    console.log(`| ${arm.arm} | ${arm.tasks} | ${arm.passRate} | ${arm.searchCount} | ${arm.setupSearchCount} | ${arm.missedRate} | ${arm.loadedUsedRatio} | ${arm.steps} | ${arm.costUsd} | ${arm.wallMs} |`)
  }
  if (gaps.length > 0) {
    console.log('\n离 oracle 的差距（正 = 比 oracle 差）：')
    console.log('| arm | passGap(pp) | searchGap | stepGap |')
    console.log('|---|---|---|---|')
    for (const g of gaps) console.log(`| ${g.arm} | ${g.passGap} | ${g.searchGap} | ${g.stepGap} |`)
  }
} else {
  console.log(header.join('\t'))
  for (const arm of summary.arms) {
    console.log([arm.arm, arm.tasks, arm.passRate, arm.searchCount, arm.setupSearchCount, arm.missedRate, arm.loadedUsedRatio, arm.steps, arm.costUsd, arm.wallMs].join('\t'))
  }
  console.log(`\nrepresentative runs: ${summary.representativeRuns} / raw runs: ${summary.rawRuns}`)
  for (const arm of summary.arms) {
    console.log(`\n[${arm.arm}] per task:`)
    for (const t of arm.perTask) {
      console.log(`  ${t.pass ? '✓' : '✗'} ${t.task.padEnd(24)} searches=${t.searches} setup=${t.setupSearches} target=${t.targetTool ?? 'NONE'} missed=${t.missed} ratio=${t.loadedUsedRatio} steps=${t.steps} cost=${t.costUsd} wall=${t.wallMs}`)
    }
  }
  if (gaps.length > 0) {
    console.log('\n离 oracle 的差距（正 = 比 oracle 差）：')
    for (const g of gaps) console.log(`  ${g.arm}: passGap=${g.passGap}pp searchGap=${g.searchGap} stepGap=${g.stepGap}`)
  }
}
