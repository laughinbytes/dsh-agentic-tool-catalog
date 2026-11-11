#!/usr/bin/env node
/**
 * card.mjs —— 生成"性能数据卡"对照：baseline（全量常驻）vs agent-catalog（按需目录）。
 *
 * 只读取 results/ 下的结果 JSON；不跑会话。口径：
 *   - 同一任务集、同一模型、独立核验；按 (arm, task, rep) 去重（后写覆盖）；
 *   - 首请求 schema 体量 = metrics.firstRequestTools.chars（官方 session 指标）；
 *   - token 节省按 char/4 粗估（在输出里注明）。
 *
 * 用法：node benchmark/discovery/card.mjs [--baseline baseline-resident] [--treatment agent-catalog] [--markdown]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const HERE = new URL('.', import.meta.url).pathname
const RESULTS = join(HERE, 'results')

const args = process.argv.slice(2)
const getArg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback }
const baselineArm = getArg('--baseline', 'baseline-resident')
const treatmentArm = getArg('--treatment', 'agent-catalog')
const taskFilter = (getArg('--tasks', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
const markdown = args.includes('--markdown')

function load() {
  const runs = new Map()
  const files = readdirSync(RESULTS).sort((a, b) => statSync(join(RESULTS, a)).mtimeMs - statSync(join(RESULTS, b)).mtimeMs)
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let data
    try { data = JSON.parse(readFileSync(join(RESULTS, file), 'utf8')) } catch { continue }
    if (data === null || typeof data !== 'object' || data.metrics === undefined) continue
    if (data.arm !== baselineArm && data.arm !== treatmentArm) continue
    if (taskFilter.length > 0 && !taskFilter.includes(data.taskId)) continue
    runs.set(`${data.arm}\u0000${data.taskId}\u0000${data.rep}`, data)
  }
  return [...runs.values()]
}

const mean = (values) => values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
const sum = (values) => values.reduce((a, b) => a + b, 0)

function summarize(runs) {
  const tasks = [...new Set(runs.map((r) => r.taskId))]
  const pass = runs.filter((r) => r.verify?.ok === true).length
  const firstChars = runs.map((r) => r.metrics?.firstRequestTools?.chars ?? 0)
  const firstCounts = runs.map((r) => r.metrics?.firstRequestTools?.count ?? 0)
  const maxChars = runs.map((r) => r.metrics?.maxRequestTools?.chars ?? 0)
  const inputTokens = runs.map((r) => r.metrics?.tokens?.inputTokens ?? 0)
  const totalTokens = runs.map((r) => (r.metrics?.tokens?.inputTokens ?? 0) + (r.metrics?.tokens?.cacheReadTokens ?? 0) + (r.metrics?.tokens?.outputTokens ?? 0))
  const steps = runs.map((r) => r.metrics?.steps ?? 0)
  const cost = runs.map((r) => r.metrics?.costUsd ?? 0)
  const wall = runs.map((r) => r.metrics?.wallMs ?? 0)
  const searchCalls = runs.map((r) => Array.isArray(r.metrics?.searchCalls) ? r.metrics.searchCalls.length : (r.metrics?.searchCalls ?? 0))
  return {
    arm: runs[0]?.arm ?? '?',
    runs: runs.length,
    tasks: tasks.length,
    pass,
    passRate: runs.length === 0 ? 0 : pass / runs.length,
    firstRequestChars: mean(firstChars),
    firstRequestTools: mean(firstCounts),
    maxRequestChars: mean(maxChars),
    inputTokens: mean(inputTokens),
    totalTokens: mean(totalTokens),
    steps: mean(steps),
    cost: mean(cost),
    wallMs: mean(wall),
    searchCalls: mean(searchCalls),
    costTotal: sum(cost),
  }
}

const runs = load()
const baseline = summarize(runs.filter((r) => r.arm === baselineArm))
const treatment = summarize(runs.filter((r) => r.arm === treatmentArm))

const diff = (a, b) => {
  const ratio = a === 0 ? null : (b - a) / a
  return { baseline: a, treatment: b, delta: b - a, pct: ratio === null ? null : `${(ratio * 100).toFixed(1)}%` }
}

const rows = [
  ['runs (n)', baseline.runs, treatment.runs],
  ['任务数', baseline.tasks, treatment.tasks],
  ['通过率', `${(baseline.passRate * 100).toFixed(0)}%`, `${(treatment.passRate * 100).toFixed(0)}%`],
  ['首请求工具数', baseline.firstRequestTools.toFixed(1), treatment.firstRequestTools.toFixed(1)],
  ['首请求 schema 字符', baseline.firstRequestChars.toFixed(0), treatment.firstRequestChars.toFixed(0)],
  ['首请求 tokens（char/4 估算）', (baseline.firstRequestChars / 4).toFixed(0), (treatment.firstRequestChars / 4).toFixed(0)],
  ['最大请求 schema 字符', baseline.maxRequestChars.toFixed(0), treatment.maxRequestChars.toFixed(0)],
  ['平均输入 tokens/会话', baseline.inputTokens.toFixed(0), treatment.inputTokens.toFixed(0)],
  ['平均总 tokens/会话', baseline.totalTokens.toFixed(0), treatment.totalTokens.toFixed(0)],
  ['平均步数', baseline.steps.toFixed(2), treatment.steps.toFixed(2)],
  ['平均成本 USD', baseline.cost.toFixed(4), treatment.cost.toFixed(4)],
  ['平均墙钟 ms', baseline.wallMs.toFixed(0), treatment.wallMs.toFixed(0)],
  ['平均 search_tools 调用', baseline.searchCalls.toFixed(2), treatment.searchCalls.toFixed(2)],
]

if (markdown) {
  console.log(`| 指标 | baseline（${baselineArm}） | treatment（${treatmentArm}） |`)
  console.log('|---|---:|---:|')
  for (const [label, a, b] of rows) console.log(`| ${label} | ${a} | ${b} |`)
  if (baseline.firstRequestChars > 0) {
    const savedChars = baseline.firstRequestChars - treatment.firstRequestChars
    console.log(`\n首请求 schema 节省：${savedChars.toFixed(0)} 字符 ≈ ${(savedChars / 4).toFixed(0)} tokens（char/4 估算），相对 baseline ${((savedChars / baseline.firstRequestChars) * 100).toFixed(1)}%。`)
  }
} else {
  console.log(JSON.stringify({ baseline, treatment, rows }, null, 2))
}
