#!/usr/bin/env node
/**
 * metrics.mjs — 从 DSH 会话日志提取「能力发现 benchmark」指标（只读）。
 *
 * 数据真源：`~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`
 * （连续 zstd 帧；Node 只解第一帧，必须走外部 `zstd -dc`）。
 *
 * 用法：
 *   node benchmark/discovery/metrics.mjs --session <session-id>
 *   node benchmark/discovery/metrics.mjs --session <session-id> --task docs-workers-limit --text
 *   node benchmark/discovery/metrics.mjs --file <session.v4.jsonl.zstd> --text
 *
 * 口径（与 notes/2026-11-10-discovery-metrics.md 对齐）：
 *   - steps = 带 usage 的 assistant/message 条数（= API 请求数）
 *   - searchCalls = 名为 search_tools 的 tool/call 数；setupSearchCount = 首个目标能力工具调用之前的 search 次数
 *   - loadedTools = tool-addition 事件并集（以及每次 search 结果里 "Loaded N tool(s)" 解析出的工具名）
 *   - 目标能力命中 = 任务 family 的 toolPatterns 命中的 tool/call
 *   - tokens / cost：provider 返回的真值；成本按 deepseek-flash 峰/谷价估算（仅参考）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)
export const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** deepseek-flash 官方价（USD / 1M tokens），来源 dsh-dev/scripts/audit-cost.mjs；仅用于成本参考。 */
const PRICE = {
  peak: { hit: 0.006, miss: 0.3, out: 1.2 },
  off: { hit: 0.003, miss: 0.15, out: 0.6 },
}
const PEAK_WINDOWS = [{ from: 1, to: 4 }, { from: 6, to: 10 }]

const num = (n) => Number(n ?? 0)
const pct = (arr, p) => {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}
const isPeak = (ms) => {
  const d = new Date(ms)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = d.getUTCHours()
  return PEAK_WINDOWS.some((w) => h >= w.from && h < w.to)
}

/** 在 ~/.dsh/sessions/** 下按 session-id 找日志。 */
export function findSessionLog(sessionId) {
  if (!existsSync(SESSIONS_ROOT)) return null
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    const wsDir = join(SESSIONS_ROOT, ws)
    if (!statSync(wsDir).isDirectory()) continue
    const candidate = join(wsDir, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 解压并解析会话日志为事件数组。 */
export function readEvents(file) {
  const raw = execFileSync('zstd', ['-dc', '--no-progress', '--', file], {
    maxBuffer: 1024 * 1024 * 512,
    encoding: 'utf8',
  })
  const events = []
  let bad = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { bad += 1 }
  }
  return { events, bad }
}

const textOfContent = (content) => {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('')
}

/** 从 search_tools 的返回文本里解析 "Loaded N tool(s)" 与工具名。 */
export function parseSearchResult(text) {
  const loaded = []
  const lines = String(text ?? '').split('\n')
  for (const line of lines) {
    const m = /^-\s+([A-Za-z0-9_.-]+):\s/.exec(line.trim())
    if (m) loaded.push(m[1])
  }
  const m = /Loaded\s+(\d+)\s+tool/.exec(String(text ?? ''))
  return { loadedCount: m ? Number(m[1]) : null, loaded }
}

/** 分析一个会话日志文件，返回指标对象。 */
export function analyzeSession(file) {
  const { events, bad } = readEvents(file)
  const sessionId = basename(dirname(file))
  const m = {
    sessionId,
    logFile: file,
    badLines: bad,
    cwd: null,
    origin: null,
    model: null,
    provider: null,
    reasoningEffort: null,
    turns: 0,
    steps: 0,
    tokens: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    firstRequestTools: null,
    maxRequestTools: null,
    addedTools: [],
    toolAdditionEvents: [],
    searchCalls: [],
    loadedTools: [],
    toolCalls: [],
    toolCallsByName: {},
    failures: [],
    turnsEndReason: null,
    finalAnswer: '',
    signal: {},
  }
  let firstHeader = null
  let maxHeader = null
  let lastAssistantText = ''
  const callById = new Map()
  const searchCallIds = new Set()
  let firstEventTime = null
  let lastEventTime = null

  for (const ev of events) {
    const t = ev.time
    if (typeof t === 'number') {
      if (firstEventTime === null || t < firstEventTime) firstEventTime = t
      if (lastEventTime === null || t > lastEventTime) lastEventTime = t
    }
    switch (ev.type) {
      case 'session':
        m.cwd = ev.cwd ?? m.cwd
        m.origin = ev.origin ?? m.origin
        break
      case 'turn/start':
        m.turns += 1
        break
      case 'turn/end':
        m.turnsEndReason = ev.data?.reason?.kind ?? m.turnsEndReason
        break
      case 'request/header': {
        const cfg = ev.data?.header?.config
        if (cfg) {
          m.model = cfg.model ?? m.model
          m.provider = cfg.provider ?? m.provider
          m.reasoningEffort = cfg.reasoningEffort ?? m.reasoningEffort
        }
        const tools = ev.data?.header?.tools
        if (Array.isArray(tools)) {
          const snapshot = { count: tools.length, chars: JSON.stringify(tools).length, names: tools.map((x) => x.name) }
          if (!firstHeader) firstHeader = snapshot
          if (!maxHeader || snapshot.count > maxHeader.count) maxHeader = snapshot
        }
        break
      }
      case 'assistant/message': {
        const u = ev.data?.usage
        const text = textOfContent(ev.data?.message?.content)
        if (text.trim()) lastAssistantText = text
        if (!u) break
        m.steps += 1
        m.tokens.inputTokens += num(u.inputTokens)
        m.tokens.cacheReadTokens += num(u.cacheReadTokens)
        m.tokens.outputTokens += num(u.outputTokens)
        m.tokens.cacheWriteTokens += num(u.cacheWriteTokens)
        const p = isPeak(t) ? PRICE.peak : PRICE.off
        m.costUsd += (num(u.inputTokens) * p.miss + num(u.cacheReadTokens) * p.hit + num(u.outputTokens) * p.out) / 1e6
        break
      }
      case 'tool/call': {
        const name = ev.data?.name ?? '<unknown>'
        const call = {
          callId: ev.data?.callId ?? null,
          name,
          arguments: ev.data?.arguments ?? '',
          time: t,
          durationMs: null,
          ok: null,
          resultChars: 0,
          resultText: '',
        }
        m.toolCalls.push(call)
        if (call.callId) callById.set(call.callId, call)
        if (name === 'search_tools') searchCallIds.add(call.callId)
        m.toolCallsByName[name] = (m.toolCallsByName[name] ?? 0) + 1
        break
      }
      case 'tool/result': {
        const cid = ev.data?.toolCallId ?? ev.data?.message?.toolCallId
        const call = cid ? callById.get(cid) : null
        const msg = ev.data?.message
        const content = msg?.content
        const text = textOfContent(content)
        if (!call) break
        call.durationMs = typeof t === 'number' && typeof call.time === 'number' ? t - call.time : null
        call.resultChars = text.length
        call.resultText = text.slice(0, 20000)
        call.ok = msg?.isError !== true
        if (msg?.isError === true) m.failures.push({ name: call.name, message: text.slice(0, 300) })
        break
      }
      case 'developer/message': {
        const blocks = ev.data?.message?.content
        if (!Array.isArray(blocks)) break
        for (const b of blocks) if (b && b.type === 'tool-addition' && b.toolName) m.toolAdditionEvents.push(b.toolName)
        break
      }
      default:
        break
    }
  }

  m.firstRequestTools = firstHeader ? { count: firstHeader.count, chars: firstHeader.chars } : null
  m.maxRequestTools = maxHeader ? { count: maxHeader.count, chars: maxHeader.chars } : null
  if (firstHeader && maxHeader) {
    const firstNames = new Set(firstHeader.names ?? [])
    m.addedTools = (maxHeader.names ?? []).filter((n) => !firstNames.has(n))
  }
  m.loadedTools = [...new Set(m.toolAdditionEvents)]
  m.searchCalls = m.toolCalls
    .filter((c) => c.name === 'search_tools')
    .map((c) => {
      let args = {}
      try { args = JSON.parse(c.arguments || '{}') } catch { args = {} }
      const parsed = parseSearchResult(c.resultText)
      return {
        query: args.query ?? '',
        limit: args.limit ?? null,
        resultChars: c.resultChars,
        loadedCount: parsed.loadedCount,
        loadedTools: parsed.loaded,
        ok: c.ok,
      }
    })
  if (m.searchCalls.length === 0) m.searchCalls = []
  for (const sc of m.searchCalls) for (const name of sc.loadedTools) if (!m.loadedTools.includes(name)) m.loadedTools.push(name)

  const durations = m.toolCalls.map((c) => c.durationMs).filter((d) => typeof d === 'number')
  m.latency = {
    toolCallsWithResult: durations.length,
    toolP50Ms: pct(durations, 50),
    toolP95Ms: pct(durations, 95),
    toolWallMsTotal: durations.reduce((a, b) => a + b, 0),
  }
  m.startedAt = firstEventTime
  m.finishedAt = lastEventTime
  m.wallMs = firstEventTime !== null && lastEventTime !== null ? lastEventTime - firstEventTime : null
  m.finalAnswer = lastAssistantText
  return m
}

/** 任务 family 的工具名模式（tasks.json → families）。 */
export function loadTasks(tasksPath = join(HERE, 'tasks.json')) {
  return JSON.parse(readFileSync(tasksPath, 'utf8'))
}

const compilePattern = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
const matchesAny = (name, patterns) => patterns.some((p) => compilePattern(p).test(name))

/**
 * 把通用会话指标与"目标能力"结合，得到发现类指标。
 * @param m - analyzeSession 的返回。
 * @param task - tasks.json 里的任务对象。
 * @param families - tasks.json 里的 families。
 */
export function discoveryMetrics(m, task, families) {
  const patterns = families[task.family]?.toolPatterns ?? []
  const targetNames = new Set(m.toolCalls.filter((c) => matchesAny(c.name, patterns)).map((c) => c.name))
  const firstTargetIndex = m.toolCalls.findIndex((c) => matchesAny(c.name, patterns))
  const searchesBeforeFirstTarget = firstTargetIndex < 0
    ? m.searchCalls.length
    : m.toolCalls.slice(0, firstTargetIndex).filter((c) => c.name === 'search_tools').length
  const usedLoaded = m.loadedTools.filter((name) => m.toolCalls.some((c) => c.name === name))
  return {
    taskId: task.id,
    family: task.family,
    searchCount: m.searchCalls.length,
    setupSearchCount: searchesBeforeFirstTarget,
    firstTargetTool: firstTargetIndex < 0 ? null : m.toolCalls[firstTargetIndex].name,
    firstTargetToolStep: firstTargetIndex < 0 ? null : firstTargetIndex,
    targetToolCalls: [...targetNames],
    targetToolCalled: firstTargetIndex >= 0,
    missedCapability: firstTargetIndex < 0,
    loadedToolCount: m.loadedTools.length,
    usedLoadedToolCount: usedLoaded.length,
    loadedUsedRatio: m.loadedTools.length === 0 ? null : Number((usedLoaded.length / m.loadedTools.length).toFixed(3)),
    firstRequestToolCount: m.firstRequestTools?.count ?? null,
    firstRequestToolChars: m.firstRequestTools?.chars ?? null,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2)
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const text = argv.includes('--text')
  const fileArg = get('--file')
  const sessionArg = get('--session')
  const taskId = get('--task')
  let file = fileArg ?? null
  if (!file && sessionArg) file = findSessionLog(sessionArg)
  if (!file) {
    console.error('用法：node benchmark/discovery/metrics.mjs --session <session-id> [--task <task-id>] [--text]')
    process.exit(2)
  }
  const result = analyzeSession(file)
  if (taskId) {
    const db = loadTasks()
    const task = db.tasks.find((t) => t.id === taskId)
    if (!task) {
      console.error(`tasks.json 里没有任务：${taskId}`)
      process.exit(2)
    }
    result.discovery = discoveryMetrics(result, task, db.families)
  }
  if (text) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && process.argv[1].endsWith('metrics.mjs')) main()
