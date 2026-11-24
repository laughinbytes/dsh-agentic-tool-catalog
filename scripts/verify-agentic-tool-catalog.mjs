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
  descriptionKeyOf,
  mcpInfo,
  normalizeGroupId,
  noteText,
  pruneLoadedTools,
  rankTools,
  refreshToolDescriptions,
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
  diffToolCatalog,
  groupedToolNames,
  resolveCatalogChange,
  validateAgentGroups,
} from '../lib/generation.js'
import {
  ACTIVATION_SHAPES,
  buildSubagentActivationSpec,
  isActivationShapeError,
} from '../lib/subagent-compat.js'
import { createGenerationQueue, SKIP_GENERATION } from '../lib/generation-queue.js'
import { createChangeDebouncer, DEFAULT_STABILIZE_MAX_MS, DEFAULT_STABILIZE_MS } from '../lib/change-buffer.js'

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

console.log('== 目录变化判定：纯删除不触发重新分组 ==')
{
  // 2026-11-23 的现场：上游 MCP token 刷新让单个工具消失，旧实现只要 fingerprint 变了就起
  // 真实子代理；prompt 里 New tools=[]，sub-agent 原样返回 —— 16 次纯删除 = 16 次空跑。
  const history = [
    tool('mcp__workspace__calendar_list'),
    tool('mcp__workspace__gmail_send'),
    tool('mcp__workspace__gmail_list'),
    tool('dsh_session_manage'),
    tool('browser_open'),
    tool('schedule_create'),
  ]
  // 上次成功分组：calendar 组只有一个成员，删除后该组应整组消失。
  const previousGroups = [
    { id: 'workspace-calendar', description: 'Calendar tools', tools: ['mcp__workspace__calendar_list'] },
    { id: 'workspace-gmail', description: 'Gmail tools', tools: ['mcp__workspace__gmail_send', 'mcp__workspace__gmail_list'] },
    { id: 'session-admin', description: 'Session administration', members: ['dsh_session_manage'] },
    { id: 'browser', description: 'Browser tools', tools: ['browser_open'] },
    { id: 'schedule', description: 'Scheduled tasks', tools: ['schedule_create'] },
  ]
  const withoutCalendar = history.filter((entry) => entry.name !== 'mcp__workspace__calendar_list')
  const removal = resolveCatalogChange(withoutCalendar, previousGroups)
  check(removal.mode === 'local', `纯删除：判定为本地适配而非生成（实际 ${removal.mode}）`)
  eq(removal.needsGeneration, false, '纯删除：不允许启动生成')
  eq(removal.added.join(','), '', '纯删除：added 为空')
  eq(removal.removed.join(','), 'mcp__workspace__calendar_list', '纯删除：removed 含被移除工具')
  eq(removal.catalog.groups.map((group) => group.id).sort().join(','), 'browser,schedule,session-admin,workspace-gmail', '纯删除：删空的组被丢弃，其余组保留')
  check(removal.catalog.entries.every((entry) => entry.name !== 'mcp__workspace__calendar_list'), '纯删除：目录里不再有被移除工具')
  eq(removal.catalog.others.length, 0, '纯删除：没有工具落 others（全部仍在旧组里）')
  eq(removal.catalog.source, 'agent-adapted', '纯删除：source=agent-adapted（不冒充生成结果）')
  check(
    removal.catalog.warnings.some((warning) => warning.kind === 'catalog-removal-only' && warning.message.includes('mcp__workspace__calendar_list')),
    '纯删除：warning 记录被移除的工具名（可观测）',
  )
  check(!removal.catalog.warnings.some((warning) => warning.kind === 'catalog-generated'), '纯删除：不写成 catalog-generated 成功')

  const addedTool = tool('mcp__workspace__drive_list')
  const addition = resolveCatalogChange([...history, addedTool], previousGroups)
  eq(addition.mode, 'generate', '新增：仍触发生成')
  eq(addition.needsGeneration, true, '新增：needsGeneration=true')
  eq(addition.added.join(','), 'mcp__workspace__drive_list', '新增：added 含新工具')
  eq(addition.removed.join(','), '', '新增：removed 为空')

  const mixed = resolveCatalogChange([...withoutCalendar, addedTool], previousGroups)
  eq(mixed.mode, 'generate', '增删同时出现：有新增就必须生成')
  eq(mixed.needsGeneration, true, '增删同时出现：needsGeneration=true')
  eq(mixed.added.join(','), 'mcp__workspace__drive_list', '增删同时出现：added 正确')
  eq(mixed.removed.join(','), 'mcp__workspace__calendar_list', '增删同时出现：removed 正确')
  check(mixed.catalog.warnings.some((warning) => warning.kind === 'catalog-stale-groups'), '增删同时出现：保持 stale 告警（后台生成）')

  eq(resolveCatalogChange(withoutCalendar, undefined).mode, 'bootstrap', '无历史分组：走生成（bootstrap）')
  eq(resolveCatalogChange(withoutCalendar, []).mode, 'bootstrap', '空历史分组：走生成（bootstrap）')
  eq(resolveCatalogChange(withoutCalendar, undefined).needsGeneration, true, '无历史分组：needsGeneration=true')

  const unchanged = resolveCatalogChange(history, previousGroups)
  eq(unchanged.mode, 'local', '无增删（force 重建）：本地适配，不重复生成')
  check(unchanged.catalog.warnings.some((warning) => warning.kind === 'catalog-removal-only' && warning.message.includes('没有新增')), '无增删：warning 说明未重新分组')

  const fallback = resolveCatalogChange(withoutCalendar, previousGroups, { failureMessage: '本次生成未成功，暂用最近一次成功分组' })
  eq(fallback.mode, 'fallback', '生成失败回退：mode=fallback')
  eq(fallback.needsGeneration, false, '生成失败回退：不立刻再生成（调用方退避）')
  eq(fallback.catalog.source, 'agent-stale', '生成失败回退：source=agent-stale')
  check(
    fallback.catalog.warnings.some((warning) => warning.kind === 'catalog-stale-groups' && warning.message.includes('生成未成功')),
    '生成失败回退：告警透传失败原因（与纯删除共用同一个适配函数）',
  )

  eq(groupedToolNames(previousGroups).size, 6, 'groupedToolNames 兼容 members / tools 两种字段')
  const diff = diffToolCatalog([...withoutCalendar, addedTool], previousGroups)
  eq(diff.added.join(','), 'mcp__workspace__drive_list', 'diffToolCatalog：added')
  eq(diff.removed.join(','), 'mcp__workspace__calendar_list', 'diffToolCatalog：removed')

  // 被移除工具如果在 loaded 里：清掉残影（否则 pending / “全部已加载”判断会漂）。
  const loaded = new Set(['mcp__workspace__calendar_list', 'dsh_session_manage', 'gone_tool'])
  const pruned = pruneLoadedTools(loaded, withoutCalendar.map((entry) => entry.name))
  eq(pruned.join(','), 'gone_tool,mcp__workspace__calendar_list', 'loaded 清理：剔除已被上游移除的工具')
  check(!loaded.has('mcp__workspace__calendar_list') && loaded.has('dsh_session_manage'), 'loaded 清理：原地更新并保留仍在表中的工具')
  check(removal.catalog.entries.every((entry) => entry.name !== 'mcp__workspace__calendar_list'), 'restriction 的 deny 由目录派生：不会残留“永远 deny 的不存在工具”')
}

console.log('== 工具说明变化：本地静默刷新（不重新分组）==')
{
  // 稳妥版：工具名字不变、只有说明变化时，只更新目录条目里的说明；不重新分组、
  // 不叫模型、不写生成成功、不加告警，但 search_tools 能按新说明命中。
  const before = [tool('browser_open', 'Open a browser page'), tool('dsh_session_manage', 'Manage sessions')]
  const groups = [
    { id: 'browser', description: 'Browser tools', members: ['browser_open'] },
    { id: 'session', description: 'Session tools', members: ['dsh_session_manage'] },
  ]
  const catalog = catalogFromAgentGroups(before, groups)
  const keyBefore = descriptionKeyOf(before)
  check(keyBefore === descriptionKeyOf([...before].reverse()), '说明指纹：与工具顺序无关')
  const after = [tool('browser_open', 'Open a browser page in kiosk mode'), before[1]]
  check(descriptionKeyOf(after) !== keyBefore, '说明指纹：随说明变化')

  const refreshed = refreshToolDescriptions(catalog, after)
  eq(refreshed.changed, 1, '说明刷新：只更新实际变化的条目')
  eq(refreshed.catalog.entries.find((entry) => entry.name === 'browser_open')?.description, 'Open a browser page in kiosk mode', '说明刷新：条目说明已更新')
  eq(refreshed.catalog.entries.find((entry) => entry.name === 'browser_open')?.group, 'browser', '说明刷新：分组保持不变')
  eq(refreshed.catalog.groups.map((group) => group.id).join(','), catalog.groups.map((group) => group.id).join(','), '说明刷新：组结构不变')
  eq(refreshed.catalog.source, catalog.source, '说明刷新：来源不变（不冒充生成）')
  eq(refreshed.catalog.warnings.map((warning) => warning.kind).join(','), catalog.warnings.map((warning) => warning.kind).join(','), '说明刷新：不新增告警')
  check(rankTools(refreshed.catalog, 'kiosk').loaded.includes('browser_open'), '说明刷新后：search 能按新说明命中')
  const noop = refreshToolDescriptions(catalog, before)
  check(noop.changed === 0 && noop.catalog === catalog, '说明没变：返回原目录、零改动')
  eq(refreshToolDescriptions(null, before).changed, 0, '空目录：说明刷新安全返回 0')
}

console.log('== tools/change 稳定窗口（去抖）==')
{
  // 假时钟：可精确推进时间，验证窗口/硬上限语义（生产用 Date.now + setTimeout）。
  const createFakeClock = (start = 0) => {
    let now = start
    let nextId = 0
    const timers = new Map()
    return {
      now: () => now,
      setTimeout: (fn, delay) => {
        const id = ++nextId
        timers.set(id, { at: now + Math.max(0, delay), fn })
        return { id }
      },
      clearTimeout: (timer) => {
        if (timer !== undefined) timers.delete(timer.id)
      },
      advance(ms) {
        const target = now + ms
        for (;;) {
          const due = [...timers.entries()]
            .filter(([, timer]) => timer.at <= target)
            .sort((a, b) => a[1].at - b[1].at)[0]
          if (due === undefined) break
          timers.delete(due[0])
          now = due[1].at
          due[1].fn()
        }
        now = target
      },
      /** 只移动时间、不触发 timer（模拟事件循环被拖住，新事件先到）。 */
      jump(ms) { now += ms },
      pending: () => timers.size,
    }
  }
  const clockOptions = (clock) => ({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })

  eq(DEFAULT_STABILIZE_MS, 2500, '稳定窗口：默认窗口 2500ms')
  eq(DEFAULT_STABILIZE_MAX_MS, 30000, '稳定窗口：默认硬上限 30000ms')
  eq(createChangeDebouncer({ windowMs: 500, maxMs: 10 }).status().maxMs, 500, '稳定窗口：硬上限自动夹到 >= 窗口长度')

  // 1) 连续两次变化只结算（生成）一次；稳定后再变化正常触发下一批。
  {
    const clock = createFakeClock()
    let settled = 0
    let settledAt = -1
    const debouncer = createChangeDebouncer({
      windowMs: 100,
      maxMs: 500,
      onSettled: () => { settled += 1; settledAt = clock.now() },
      ...clockOptions(clock),
    })
    eq(debouncer.schedule(), 100, '稳定窗口：首次事件等待完整窗口')
    clock.advance(50)
    eq(debouncer.schedule(), 100, '稳定窗口：新事件重置窗口')
    clock.advance(99)
    eq(settled, 0, '稳定窗口：窗口未满不结算')
    eq(debouncer.status().pending, true, '稳定窗口：pending 可观测')
    eq(debouncer.status().windowMs, 100, '稳定窗口：status.windowMs')
    eq(debouncer.status().maxMs, 500, '稳定窗口：status.maxMs')
    eq(debouncer.status().pendingSince, 0, '稳定窗口：pendingSince 是批次首事件时刻')
    eq(debouncer.status().deadlineAt, 500, '稳定窗口：deadlineAt = 首事件 + 硬上限')
    clock.advance(1)
    eq(settled, 1, '稳定窗口：连续两次变化只结算（生成）一次')
    eq(settledAt, 150, '稳定窗口：在最后一次事件后满窗口结算')
    eq(debouncer.status().pending, false, '稳定窗口：结算后 pending=false')
    clock.advance(1000)
    eq(settled, 1, '稳定窗口：结算后不再重复触发')
    debouncer.schedule()
    clock.advance(100)
    eq(settled, 2, '稳定窗口：稳定后的新变化正常触发下一批（新增工具仍会生成）')
  }

  // 2) 持续抖动：窗口一直被重置，但硬上限到点必须结算一次（防饿死）。
  {
    const clock = createFakeClock()
    const settledAt = []
    const debouncer = createChangeDebouncer({
      windowMs: 100,
      maxMs: 250,
      onSettled: () => settledAt.push(clock.now()),
      ...clockOptions(clock),
    })
    for (let elapsed = 0; elapsed <= 240; elapsed += 20) {
      debouncer.schedule()
      clock.advance(20)
    }
    eq(settledAt.join(','), '250', '稳定窗口：持续抖动在硬上限处结算一次（不饿死）')
    eq(debouncer.status().pending, false, '稳定窗口：硬上限结算后没有挂起窗口')
    clock.advance(1000)
    eq(settledAt.join(','), '250', '稳定窗口：硬上限结算后不再重复触发')
  }

  // 3) 事件循环被拖住（timer 没来得及跑）时，到达上限的新事件同步结算。
  {
    const clock = createFakeClock()
    const settledAt = []
    const debouncer = createChangeDebouncer({
      windowMs: 100,
      maxMs: 150,
      onSettled: () => settledAt.push(clock.now()),
      ...clockOptions(clock),
    })
    debouncer.schedule()
    clock.jump(200)
    eq(debouncer.schedule(), 0, '稳定窗口：到达硬上限后的事件同步结算（返回 0）')
    eq(settledAt.join(','), '200', '稳定窗口：硬上限同步结算，不等 timer（防饿死兜底）')
  }

  // 4) cancel 不结算（插件卸载），flush 立即结算。
  {
    const clock = createFakeClock()
    let settled = 0
    const debouncer = createChangeDebouncer({
      windowMs: 100,
      maxMs: 500,
      onSettled: () => { settled += 1 },
      ...clockOptions(clock),
    })
    debouncer.schedule()
    debouncer.cancel()
    clock.advance(1000)
    eq(settled, 0, '稳定窗口：cancel 后不结算（插件卸载不触发重建）')
    eq(debouncer.status().pending, false, '稳定窗口：cancel 后 pending=false')
    debouncer.schedule()
    eq(debouncer.flush(), true, '稳定窗口：flush 立即结算挂起窗口')
    eq(settled, 1, '稳定窗口：flush 触发一次结算')
    eq(debouncer.flush(), false, '稳定窗口：没有挂起窗口时 flush 不重复结算')
  }
}

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
