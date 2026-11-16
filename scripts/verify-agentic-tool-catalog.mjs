/**
 * verify-agentic-tool-catalog.mjs —— 回归测试（2026-11-10 用户决策后：只剩真 agent 策略）。
 *
 * 覆盖：常驻判定 / 名字规范化 / bootstrap 目录 / 确定性搜索 / note / 真 agent 分组校验与重试。
 * 旧策略（legacy/rules/bm25/...）已移除，不再测试。
 */
import { strict as assert } from 'node:assert'

import {
  DEFAULT_RESIDENT,
  buildBootstrapCatalog,
  catalogSummary,
  mcpInfo,
  normalizeGroupId,
  noteText,
  rankTools,
  residentMatcher,
  summarizeGroups,
  tokensOf,
} from '../lib/catalog.js'
import {
  AGENT_GROUP_SCHEMA,
  adaptAgentGroups,
  buildAgentGroupPrompt,
  catalogFromAgentGroups,
  createAgentGrouper,
  validateAgentGroups,
} from '../lib/generation.js'
import {
  ACTIVATION_SHAPES,
  buildSubagentActivationSpec,
  isActivationShapeError,
} from '../lib/subagent-compat.js'
import { createGenerationQueue, SKIP_GENERATION } from '../lib/generation-queue.js'

let passed = 0
let failed = 0
function check(condition, message) {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`) }
  else { failed += 1; console.error(`  ✗ ${message}`) }
}
function eq(actual, expected, message) {
  check(Object.is(actual, expected), `${message}（期望 ${String(expected)}，实际 ${String(actual)}）`)
}

const tool = (name, description = `${name} 工具`) => ({ name, description })
const toolNames = [
  'browser_open', 'browser_click', 'browser_type', 'browser_screenshot',
  'dsh_session_manage', 'dsh_workspace_manage', 'dsh_config_manage',
  'schedule_create', 'schedule_list', 'create_goal', 'get_goal', 'update_goal',
  'terminal_open', 'terminal_send', 'session_search', 'session_event_search',
  'mcp__cfapi__docs', 'mcp__cfapi__execute', 'mcp__workspace__calendar_list',
  'mcp__workspace__gmail_send', 'plugin_manager', 'cordis_inspect_list', 'workflow',
].map((name) => tool(name))

console.log('== 基础函数 ==')
check(DEFAULT_RESIDENT.includes('bash'), '默认常驻包含 bash')
check(DEFAULT_RESIDENT.includes('search_tools'), '默认常驻包含 search_tools')
check(DEFAULT_RESIDENT.includes('catalog_status'), '默认常驻包含 catalog_status')
check(mcpInfo('mcp__cfapi__search')?.server === 'cfapi', 'mcpInfo server')
check(mcpInfo('mcp__cfapi__search')?.id === 'mcp-cfapi', 'mcpInfo id')
check(mcpInfo('browser_click') === undefined, 'mcpInfo 非 MCP')
check(tokensOf('browser_click_at').join(',') === 'browser,click,at', 'tokensOf 切词')
eq(normalizeGroupId('Browser Advanced!!'), 'browser-advanced', 'normalizeGroupId kebab')
eq(normalizeGroupId('***'), 'extensions', 'normalizeGroupId 兜底')
const residentDefault = residentMatcher({})
check(residentDefault('bash'), '常驻默认：bash')
check(residentDefault('search_tools'), '常驻默认：search_tools')
check(!residentDefault('browser_open'), '非常驻：browser_open')
const residentOverride = residentMatcher({ resident: ['browser_open'] })
check(residentOverride('browser_open') && !residentOverride('bash'), 'resident 覆盖内置清单')
const residentExtra = residentMatcher({ extraKeepResident: ['session_*'], extraDeferred: ['dsh_*'] })
check(residentExtra('session_search') && !residentExtra('dsh_session_manage'), 'extraKeepResident / extraDeferred')

console.log('== bootstrap 目录 / 搜索 ==')
const bootstrap = buildBootstrapCatalog(toolNames)
eq(bootstrap.entries.length, toolNames.length, 'bootstrap 条目数')
eq(bootstrap.groups.length, 0, 'bootstrap 无分组')
eq(bootstrap.others.length, toolNames.length, 'bootstrap others 全覆盖')
check(bootstrap.warnings.some((w) => w.kind === 'catalog-bootstrap'), 'bootstrap 显式告警（不静默）')
const found = rankTools(bootstrap, 'session search', { limit: 3 })
check(found.loaded.includes('session_search'), 'bootstrap 搜索按名字命中')
const foundDesc = rankTools(bootstrap, 'calendar', { limit: 3 })
check(foundDesc.loaded.includes('mcp__workspace__calendar_list'), 'bootstrap 搜索按描述命中')
const noMatch = rankTools(bootstrap, 'zzzznomatch', { limit: 3 })
eq(noMatch.loaded.length, 0, 'bootstrap 零命中')
const loadedSome = new Set(['session_search'])
const excluded = rankTools(bootstrap, 'session search', { limit: 3, loaded: loadedSome })
check(!excluded.loaded.includes('session_search'), '搜索排除已加载工具')

console.log('== 分组目录 / 整组加载 ==')
const groupedEntries = toolNames.map((t, i) => ({ ...t, group: i < 3 ? 'browser' : 'others' }))
const groupedCatalog = {
  entries: groupedEntries,
  groups: summarizeGroups(groupedEntries.filter((e) => e.group !== 'others')),
  others: groupedEntries.filter((e) => e.group === 'others').map((e) => e.name).sort(),
}
eq(groupedCatalog.groups.length, 1, 'summarizeGroups 聚组')
const groupLoad = rankTools(groupedCatalog, 'browser', { limit: 2, groupMaxResults: 2 })
check(groupLoad.groupLoad === true && groupLoad.loaded.length === 2 && groupLoad.remainingInGroup === 1, '组名精确加载（受 groupMaxResults 限制）')
const note = noteText(groupedCatalog, new Set())
check(note.includes('browser') && note.includes('search_tools'), 'note 含组与入口提示')
const summary = catalogSummary(groupedCatalog)
check(summary.includes('browser') && summary.includes('others'), 'catalogSummary 含组与 others')

console.log('== 真 agent 分组：校验 ==')
check(AGENT_GROUP_SCHEMA?.properties?.groups !== undefined, '分组输出 schema 存在')
const agentTools = toolNames.map((entry) => tool(entry.name, entry.description))
const makeGroups = (count = 6) => {
  const buckets = Array.from({ length: count }, () => [])
  agentTools.forEach((entry, index) => buckets[index % count].push(entry.name))
  return buckets.map((members, index) => ({ id: `agent-group-${index + 1}`, description: `Group ${index + 1}`, tools: members }))
}
const validGroups = { groups: makeGroups() }
const validated = validateAgentGroups(agentTools, validGroups, { minGroups: 3 })
check(validated.error === undefined && validated.groups.length === 6, '合法输出通过校验')
const catalog = catalogFromAgentGroups(agentTools, validated.groups)
eq(catalog.others.length, 0, 'agent 目录全覆盖（others 为空）')
eq(catalog.groups.length, 6, 'agent 目录组数一致')
eq(catalog.entries.length, agentTools.length, 'agent 目录条目数一致')
const missing = structuredClone(validGroups); missing.groups[0].tools.pop()
check(validateAgentGroups(agentTools, missing, { minGroups: 3 }).error?.code === 'MISSING_TOOLS', '漏工具 → MISSING_TOOLS')
const dup = structuredClone(validGroups); dup.groups[1].tools.push(dup.groups[0].tools[0])
check(validateAgentGroups(agentTools, dup, { minGroups: 3 }).error?.code === 'DUPLICATE_TOOL', '重复工具 → DUPLICATE_TOOL')
const unknown = structuredClone(validGroups); unknown.groups[0].tools[0] = 'not_a_real_tool'
check(validateAgentGroups(agentTools, unknown, { minGroups: 3 }).error?.code === 'UNKNOWN_TOOL', '未知工具 → UNKNOWN_TOOL')
const shortRaw = { groups: [{ id: 'calendar', description: 'Calendar', tools: ['calendar_list'] }] }
check(validateAgentGroups([tool('mcp__workspace__calendar_list')], shortRaw, { minGroups: 1 }).groups?.[0].members[0] === 'mcp__workspace__calendar_list', '工具名简写自动修复（唯一后缀）')
check(validateAgentGroups(agentTools, { groups: [] }, { minGroups: 3 }).error?.code === 'TOO_FEW_GROUPS', '组太少 → TOO_FEW_GROUPS')
// 空目录（全部工具常驻/已加载）时没有可分组对象：唯一合法输出是 0 组，不能再判 TOO_FEW_GROUPS。
check(validateAgentGroups([], { groups: [] }).error === undefined, '空目录 → 接受 0 组')
check(validateAgentGroups([], { groups: [{ id: 'anything', description: 'Anything', tools: [] }] }).error?.code === 'UNEXPECTED_GROUPS', '空目录却给了组 → UNEXPECTED_GROUPS')
check(buildAgentGroupPrompt([]).includes('between 0 and 0 groups'), '空目录 prompt 组数区间为 0..0')
// 小目录：组数下限收敛到工具数（3 个工具不可能凑出 6 个非空组）。
const threeTools = [tool('alpha_one'), tool('beta_two'), tool('gamma_three')]
const threeGroups = threeTools.map((entry, index) => ({ id: `small-${index + 1}`, description: `Group ${index + 1}`, tools: [entry.name] }))
check(validateAgentGroups(threeTools, { groups: threeGroups }).groups?.length === 3, '小目录：3 工具 → 3 组通过')
check(validateAgentGroups(threeTools, { groups: threeGroups.slice(0, 2) }).error?.code === 'TOO_FEW_GROUPS', '小目录：2 组仍判 TOO_FEW_GROUPS')
check(buildAgentGroupPrompt(threeTools).includes('between 3 and 3 groups'), '小目录 prompt 组数区间收敛')
check(typeof buildAgentGroupPrompt(agentTools) === 'string' && buildAgentGroupPrompt(agentTools).includes('Tool catalog'), '分组 prompt 含工具目录')
const incrementalPrompt = buildAgentGroupPrompt(agentTools, { previousGroups: validated.groups })
check(incrementalPrompt.includes('Existing groups') && incrementalPrompt.includes('New tools'), '增量 prompt 含旧分组与新工具段')
check(noteText({ ...groupedCatalog, source: 'bootstrap' }, new Set()).startsWith('Tool catalog is initializing:'), 'bootstrap note 含初始化提示')
check(noteText({ ...groupedCatalog, source: 'agent-stale' }, new Set()).startsWith('Note: using the most recent successful grouping'), 'stale note 含待刷新提示')

console.log('== 真 agent 分组：降级与子代理客户端 ==')
const newerTools = [...agentTools, tool('brand_new_tool')]
const adapted = adaptAgentGroups(newerTools, validated.groups)
check(adapted.others.includes('brand_new_tool'), '降级适配：新工具进 others')
check(adapted.warnings.some((w) => w.kind === 'catalog-stale-groups'), '降级适配：显式 stale 告警')
const fakeAgent = { session: { header: { origin: 'main' } } }
let activationSpec
const fakeSubagents = {
  startActivation: async (spec) => {
    activationSpec = spec
    return { result: Promise.resolve({ structured: validGroups }), dispose: async () => {} }
  },
  getProvider: () => ({ name: 'spawn' }),
}
const grouper = createAgentGrouper({ get: (name) => (name === 'subagents' ? fakeSubagents : undefined) }, { catalogProvider: 'spawn', catalogTimeoutMs: 5000 })
check(grouper.enabled() === true, '子代理客户端：服务可用')
const generated = await grouper.generate({ agent: fakeAgent, tools: agentTools })
check(generated.groups !== undefined && generated.groups.length === 6, '子代理客户端：返回合法分组')
// 2026-11-12 回归：0.2.2-rc.2 把 SubagentActivationSpec 拍平（parent/prompt/maxDepth/outputSchema
// 在顶层），旧插件只传 spec.request，rc.2 读 spec.parent.id 直接抛 TypeError。
check(activationSpec?.parent === fakeAgent, '激活 spec：parent 在顶层（rc.2 契约）')
check(activationSpec?.request?.parent === fakeAgent, '激活 spec：request.parent 保留（rc.1 兼容）')
check(activationSpec?.outputSchema === AGENT_GROUP_SCHEMA && activationSpec?.maxDepth === 1, '激活 spec：outputSchema/maxDepth 在顶层')
check(Array.isArray(activationSpec?.prompt) && activationSpec.prompt[0]?.type === 'text', '激活 spec：prompt 在顶层')
check(activationSpec?.provider === 'spawn' && activationSpec?.delivery === 'caller', '激活 spec：provider/delivery 不变')
// 直接模拟 rc.2 服务端的校验路径：只认 spec.parent，不认 spec.request.parent。
const flatOnly = {
  startActivation: async (spec) => {
    if (spec.parent === undefined) throw new TypeError("Cannot read properties of undefined (reading 'id')")
    return { result: Promise.resolve({ structured: validGroups }), dispose: async () => {} }
  },
  getProvider: () => ({ name: 'spawn' }),
}
const flatGrouper = createAgentGrouper({ get: (name) => (name === 'subagents' ? flatOnly : undefined) }, {})
const flatResult = await flatGrouper.generate({ agent: fakeAgent, tools: agentTools })
check(flatResult.groups !== undefined && flatGrouper.stats.failures === 0, '激活 spec 回归：rc.2 扁平契约下不再 AGENT_FAILED')
const failGrouper = createAgentGrouper({ get: (name) => (name === 'subagents' ? {
  startActivation: async () => ({ result: Promise.resolve({ structured: { groups: [] } }), dispose: async () => {} }),
  getProvider: () => ({ name: 'spawn' }),
} : undefined) }, {}, undefined, { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, fallbacks: 0, lastError: null, lastOkAt: null })
const failedGeneration = await failGrouper.generate({ agent: fakeAgent, tools: agentTools })
check(failedGeneration.error?.code === 'TOO_FEW_GROUPS' && failGrouper.stats.failures === 1, '子代理客户端：不合法输出失败并计数')
let calls = 0
const retryGrouper = createAgentGrouper({ get: (name) => (name === 'subagents' ? {
  startActivation: async () => {
    calls += 1
    return { result: Promise.resolve({ structured: calls === 1 ? { groups: [] } : validGroups }), dispose: async () => {} }
  },
  getProvider: () => ({ name: 'spawn' }),
} : undefined) }, {}, undefined, { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, fallbacks: 0, lastError: null, lastOkAt: null })
const retried = await retryGrouper.generate({ agent: fakeAgent, tools: agentTools })
check(retried.groups !== undefined && retryGrouper.stats.retries === 1, '子代理客户端：失败后带反馈重试一次成功')
const noService = createAgentGrouper({ get: () => undefined }, {})
check(noService.enabled() === false, '子代理客户端：无服务时 disabled')
check((await noService.generate({ agent: fakeAgent, tools: agentTools })).error?.code === 'NO_SUBAGENT_SERVICE', '子代理客户端：无服务返回错误')
check(noService.stats.failures === 1 && noService.stats.lastError?.code === 'NO_SUBAGENT_SERVICE', '子代理客户端：provider 不可用也计入 failures/lastError（观测缺口已修）')

console.log('== 激活 spec 适配器（subagent-compat）==')
{
  const parent = { id: 'session-parent-test' }
  const schema = { type: 'object', properties: { groups: { type: 'array' } }, required: ['groups'] }
  const spec = buildSubagentActivationSpec({
    provider: 'spawn',
    label: 'test',
    parent,
    prompt: [{ type: 'text', text: 'hi' }],
    maxDepth: 1,
    outputSchema: schema,
    signal: new AbortController().signal,
    delivery: 'caller',
  })
  check(spec.parent === parent && spec.outputSchema === schema && spec.maxDepth === 1, '适配器：顶层字段（0.2.2-rc.2+）')
  check(spec.request?.parent === parent && spec.request?.outputSchema === schema, '适配器：request 字段（0.2.1-rc.2 … 0.2.2-rc.1）')
  check(!Object.keys(spec).includes('request'), '适配器：request 不可枚举（rc.2 外部 provider 展开时不会泄漏）')
  check(
    Object.keys(spec).sort().join(',') === 'delivery,label,maxDepth,outputSchema,parent,prompt,provider,signal',
    '适配器：顶层键集合恰好是宿主认识的字段',
  )
  check(ACTIVATION_SHAPES.join('+') === 'flat+nested', '适配器：声明支持的两种形状')
  check(isActivationShapeError(new TypeError("Cannot read properties of undefined (reading 'id')")), '形状错误识别：rc.2 的 id')
  check(isActivationShapeError(new TypeError("Cannot read properties of undefined (reading 'maxDepth')")), '形状错误识别：rc.1 的 maxDepth')
  check(!isActivationShapeError(new Error('boom')), '形状错误识别：普通 Error 不误判')
  check(!isActivationShapeError(new TypeError('something else')), '形状错误识别：无关 TypeError 不误判')
}

console.log('== 软闸门（连续形状失败 → 暂停 → 到期恢复）==')
{
  const pauseStats = { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, staleUses: 0, incrementalRuns: 0, lastError: null, lastOkAt: null }
  let shapeCalls = 0
  const shapeFailer = createAgentGrouper({ get: (name) => (name === 'subagents' ? {
    startActivation: async () => {
      shapeCalls += 1
      throw new TypeError("Cannot read properties of undefined (reading 'id')")
    },
    getProvider: () => ({ name: 'spawn' }),
  } : undefined) }, {}, undefined, pauseStats)
  for (let index = 0; index < 3; index += 1) {
    const failed = await shapeFailer.generate({ agent: fakeAgent, tools: agentTools })
    check(failed.error?.code === 'UNSUPPORTED_HOST', `软闸门：第 ${index + 1} 次形状失败标为 UNSUPPORTED_HOST`)
  }
  check(shapeCalls === 3 && pauseStats.paused?.code === 'UNSUPPORTED_HOST', '软闸门：连续 3 次后进入暂停')
  const runsAtPause = pauseStats.runs
  const paused = await shapeFailer.generate({ agent: fakeAgent, tools: agentTools })
  check(paused.error?.code === 'UNSUPPORTED_HOST' && pauseStats.runs === runsAtPause && shapeCalls === 3, '软闸门：暂停期间不启动子代理、不刷计数')
  check(typeof pauseStats.paused?.retryAt === 'number' && pauseStats.paused.retryAt > Date.now(), '软闸门：暂停带 retryAt')
  pauseStats.paused.retryAt = Date.now() - 1
  await shapeFailer.generate({ agent: fakeAgent, tools: agentTools })
  check(shapeCalls === 4 && pauseStats.paused === undefined, '软闸门：到期后自动恢复尝试')
}


console.log('== 生成生命周期：超时真正取消子代理 + 子会话归档 ==')
{
  // 真实宿主语义（dsh-subagent 0.2.2-rc.3 类型契约）：activation 发布之后启动 signal 不再
  // 终止子 turn，dispose() 才是 cancel + whenIdle + flush + release。旧实现只 abort 然后
  // await result，于是 120s 超时后仍等子 turn 自然结束（实测 4 分半）；这里用“结果永不自然
  // settle”的假宿主把该语义固化成回归测试。
  const state = { running: false, starts: 0, disposed: 0, interrupted: 0, archived: [] }
  const host = {
    startActivation: async () => {
      state.starts += 1
      state.running = true
      const result = Promise.withResolvers()
      return {
        childId: 'child-timeout-1',
        result: result.promise,
        dispose: async () => {
          state.disposed += 1
          state.running = false
          result.resolve({ output: [], stopReason: 'aborted' })
        },
      }
    },
    interrupt: (childId, authority) => {
      state.interrupted += 1
      state.interrupt = { childId, authority }
    },
    getProvider: () => ({ name: 'spawn' }),
  }
  const timeoutCtx = {
    get(name) {
      if (name === 'subagents') return host
      if (name === 'workspaceRegistry') {
        return { archiveSession: async (childId, options) => { state.archived.push({ childId, options }) } }
      }
      return undefined
    },
  }
  const timeoutStats = { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, staleUses: 0, incrementalRuns: 0, lastError: null, lastOkAt: null }
  const timeoutGrouper = createAgentGrouper(timeoutCtx, { catalogTimeoutMs: 40 }, undefined, timeoutStats)
  const startedAt = Date.now()
  const timedOut = await timeoutGrouper.generate({ agent: fakeAgent, tools: agentTools })
  const elapsed = Date.now() - startedAt
  check(timedOut.error?.code === 'TIMEOUT', `超时返回 TIMEOUT（实际 ${timedOut.error?.code}）`)
  check(elapsed < 1500, `超时在收尾预算内返回（${elapsed}ms；旧实现会一直等子 turn 自然结束）`)
  check(state.running === false, '返回时子代理已停止运行（dispose 已 cancel 并等 whenIdle）')
  check(state.interrupted === 1 && state.disposed === 1, '超时路径先显式 interrupt、再 dispose（各一次）')
  check(state.interrupt?.childId === 'child-timeout-1' && state.interrupt?.authority?.kind === 'ancestor', 'interrupt 使用 childId + ancestor authority')
  check(state.archived.length === 1 && state.archived[0].childId === 'child-timeout-1' && state.archived[0].options?.stopActivity === true, '超时后归档子会话（archiveSession + stopActivity）')
  check(timeoutStats.timeouts === 1 && timeoutStats.lastError?.code === 'TIMEOUT' && timeoutStats.failures === 1, '超时计入 stats.timeouts/lastError/failures')
  check(state.starts === 1, '超时不重试（只启动一个子代理）')
}
{
  const lifecycle = { disposed: 0, starts: 0, archived: [] }
  const host = {
    startActivation: async () => {
      lifecycle.starts += 1
      const childId = `child-ok-${lifecycle.starts}`
      return {
        childId,
        result: Promise.resolve({ structured: validGroups }),
        dispose: async () => { lifecycle.disposed += 1 },
      }
    },
    getProvider: () => ({ name: 'spawn' }),
  }
  const ctx = {
    get(name) {
      if (name === 'subagents') return host
      if (name === 'workspaceRegistry') {
        return { archiveSession: async (childId, options) => { lifecycle.archived.push({ childId, options }) } }
      }
      return undefined
    },
  }
  const successStats = { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, staleUses: 0, incrementalRuns: 0, lastError: null, lastOkAt: null }
  const successGrouper = createAgentGrouper(ctx, {}, undefined, successStats)
  const success = await successGrouper.generate({ agent: fakeAgent, tools: agentTools })
  check(success.groups?.length === 6 && lifecycle.disposed === 1, '成功生成后 dispose 一次')
  check(lifecycle.archived.length === 1 && lifecycle.archived[0].childId === 'child-ok-1', '成功后也归档子会话（不残留在会话列表）')
  check(successStats.sessionsArchived === 1 && successStats.sessionArchiveFailures === 0, '归档计数进 stats.sessionsArchived')
}
{
  const lifecycle = { starts: 0, archived: [] }
  const host = {
    startActivation: async () => {
      lifecycle.starts += 1
      const childId = `child-fail-${lifecycle.starts}`
      return {
        childId,
        result: Promise.resolve({ structured: { groups: [] } }),
        dispose: async () => {},
      }
    },
    getProvider: () => ({ name: 'spawn' }),
  }
  const ctx = {
    get(name) {
      if (name === 'subagents') return host
      if (name === 'workspaceRegistry') {
        return { archiveSession: async (childId) => { lifecycle.archived.push(childId) } }
      }
      return undefined
    },
  }
  const failStats = { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, staleUses: 0, incrementalRuns: 0, lastError: null, lastOkAt: null }
  const failingGrouper = createAgentGrouper(ctx, {}, undefined, failStats)
  const failed = await failingGrouper.generate({ agent: fakeAgent, tools: agentTools })
  check(failed.error?.code === 'TOO_FEW_GROUPS' && lifecycle.starts === 2, '校验失败重试一次（共两次 attempt）')
  check(lifecycle.archived.join(',') === 'child-fail-1,child-fail-2', '每次 attempt 的子会话都归档（重试也不泄漏）')
}


{
  // 启动阶段就卡住（宿主迟迟不返回 activation）：超时必须返回，且迟到 activation 也要被取消/归档。
  const state = { disposed: false, archived: [] }
  let releaseLate
  const host = {
    startActivation: () => new Promise((resolve) => { releaseLate = resolve }),
    getProvider: () => ({ name: 'spawn' }),
  }
  const ctx = {
    get(name) {
      if (name === 'subagents') return host
      if (name === 'workspaceRegistry') {
        return { archiveSession: async (childId) => { state.archived.push(childId) } }
      }
      return undefined
    },
  }
  const lateStats = { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, staleUses: 0, incrementalRuns: 0, lastError: null, lastOkAt: null }
  const lateGrouper = createAgentGrouper(ctx, { catalogTimeoutMs: 40 }, undefined, lateStats)
  const startedAt = Date.now()
  const out = await lateGrouper.generate({ agent: fakeAgent, tools: agentTools })
  check(out.error?.code === 'TIMEOUT' && Date.now() - startedAt < 1500, '启动阶段超时也按 TIMEOUT 返回（不悬挂）')
  const result = Promise.withResolvers()
  releaseLate({
    childId: 'child-late-1',
    result: result.promise,
    dispose: async () => {
      state.disposed = true
      result.resolve({ output: [], stopReason: 'aborted' })
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(state.disposed === true, '超时后才发布的迟到 activation 也会被 dispose')
  check(state.archived.join(',') === 'child-late-1', '迟到 activation 的子会话也会被归档（不泄漏）')
}


{
  // 审查回归：abort 后“一个 microtask 才 resolve activation”的窗口。若用 start promise
  // 是否 settle 判断是否挂迟到收尾，就会在此窗口漏掉 dispose/归档（修复前实测 leaked）。
  const state = { disposed: 0, archived: [] }
  const host = {
    startActivation: (spec) => new Promise((resolve) => {
      spec.signal.addEventListener('abort', () => {
        queueMicrotask(() => resolve({
          childId: 'child-micro-1',
          result: new Promise(() => {}),
          dispose: async () => { state.disposed += 1 },
        }))
      })
    }),
    getProvider: () => ({ name: 'spawn' }),
  }
  const ctx = {
    get(name) {
      if (name === 'subagents') return host
      if (name === 'workspaceRegistry') {
        return { archiveSession: async (childId) => { state.archived.push(childId) } }
      }
      return undefined
    },
  }
  const microStats = { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, staleUses: 0, incrementalRuns: 0, lastError: null, lastOkAt: null }
  const microGrouper = createAgentGrouper(ctx, { catalogTimeoutMs: 40 }, undefined, microStats)
  const out = await microGrouper.generate({ agent: fakeAgent, tools: agentTools })
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(out.error?.code === 'TIMEOUT', 'abort 后 microtask 才发布 activation：仍按 TIMEOUT 返回')
  check(state.disposed === 1 && state.archived.join(',') === 'child-micro-1', 'microtask 迟到 activation 也被 dispose + 归档（审查 BUG-1 回归）')
}
{
  // 审查回归：archiveSession 永不 settle 时不能永久占住 generate（全局队列槽位只有 1 个）。
  const host = {
    startActivation: async () => ({ childId: 'child-ok', result: Promise.resolve({ structured: validGroups }), dispose: async () => {} }),
    getProvider: () => ({ name: 'spawn' }),
  }
  const ctx = {
    get(name) {
      if (name === 'subagents') return host
      if (name === 'workspaceRegistry') return { archiveSession: () => new Promise(() => {}) }
      return undefined
    },
  }
  const stuckStats = { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, staleUses: 0, incrementalRuns: 0, lastError: null, lastOkAt: null }
  const stuckGrouper = createAgentGrouper(ctx, { catalogTimeoutMs: 40 }, undefined, stuckStats)
  const startedAt = Date.now()
  const out = await stuckGrouper.generate({ agent: fakeAgent, tools: agentTools })
  const elapsed = Date.now() - startedAt
  check(out.groups?.length === 6, '归档卡住不影响生成结果')
  check(elapsed < 1500, `归档卡住时 generate 仍在收尾预算内返回（${elapsed}ms，审查 BUG-2 回归）`)
}

console.log('== 全局生成队列：同 fingerprint 单飞 / 全局限流 / 预热节流 ==')
{
  const queue = createGenerationQueue({ maxConcurrent: 1, maxPending: 1 })
  const gate = Promise.withResolvers()
  let calls = 0
  const first = queue.request('fp-same', async () => {
    calls += 1
    return gate.promise
  })
  const second = queue.request('fp-same', async () => {
    calls += 1
    return 'second-run'
  })
  gate.resolve('generated-once')
  check(await first === 'generated-once' && await second === 'generated-once', '同一 fingerprint 的两个请求共享一次生成结果')
  check(calls === 1 && queue.status().joined === 1, '同一 fingerprint 只启动一次子代理（不再每 session 一份）')
}
{
  const queue = createGenerationQueue({ maxConcurrent: 1 })
  const order = []
  const gate = Promise.withResolvers()
  const first = queue.request('fp-a', async () => {
    order.push('start-a')
    const value = await gate.promise
    order.push('end-a')
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = queue.request('fp-b', async () => {
    order.push('start-b')
    return 'b'
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(order.join(',') === 'start-a', '不同 fingerprint 在第一个结束前不启动（全局 maxConcurrent=1）')
  gate.resolve('a')
  check(await first === 'a' && await second === 'b', '排队请求依次完成')
  check(order.join(',') === 'start-a,end-a,start-b', '全局串行执行生成')
}
{
  const queue = createGenerationQueue({ maxConcurrent: 1 })
  const gate = Promise.withResolvers()
  const active = queue.request('fp-x', async () => gate.promise)
  let prewarmRan = false
  const skipped = await queue.request('fp-y', async () => { prewarmRan = true }, { prewarm: true })
  check(skipped === SKIP_GENERATION && prewarmRan === false, '预热在全局忙时直接 SKIP（不再每个新会话各起一批）')
  gate.resolve('x')
  await active
  const idlePrewarm = await queue.request('fp-z', async () => 'prewarmed', { prewarm: true })
  check(idlePrewarm === 'prewarmed', '空闲时的预热仍正常启动（保留原设计）')
}
{
  const queue = createGenerationQueue({ maxConcurrent: 1, maxPending: 1 })
  const gate = Promise.withResolvers()
  const running = queue.request('fp-old', async () => {
    await gate.promise
    return 'old'
  })
  const stale = queue.request('fp-stale', async () => 'stale')
  const newest = queue.request('fp-new', async () => 'new')
  check(await stale === SKIP_GENERATION, 'pending 溢出时淘汰最旧请求（最新工具集优先）')
  gate.resolve('old')
  check(await running === 'old' && await newest === 'new', '活动与最新 pending 都完成')
  check(queue.status().skipped >= 1, '队列 skipped 计数可观测')
}

console.log(`\n${passed}/${passed + failed} 通过`)
if (failed > 0) process.exit(1)
