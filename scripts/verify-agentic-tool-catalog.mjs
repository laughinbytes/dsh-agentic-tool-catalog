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
const fakeSubagents = {
  startActivation: async () => ({ result: Promise.resolve({ structured: validGroups }), dispose: async () => {} }),
  getProvider: () => ({ name: 'spawn' }),
}
const grouper = createAgentGrouper({ get: (name) => (name === 'subagents' ? fakeSubagents : undefined) }, { catalogProvider: 'spawn', catalogTimeoutMs: 5000 })
check(grouper.enabled() === true, '子代理客户端：服务可用')
const generated = await grouper.generate({ agent: fakeAgent, tools: agentTools })
check(generated.groups !== undefined && generated.groups.length === 6, '子代理客户端：返回合法分组')
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

console.log(`\n${passed}/${passed + failed} 通过`)
if (failed > 0) process.exit(1)
