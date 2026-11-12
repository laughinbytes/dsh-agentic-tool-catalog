/**
 * policy.js —— Tool Discovery 的非策略底座（2026-11-10 用户决策：只保留真 agent 策略）。
 *
 * legacy/rules/bm25/oracle/minimal/Jev/LLM/full-combo 等旧策略已全部移除。
 * 保留：常驻判定、工具名规范化、引导目录（bootstrap）、确定性搜索、note/摘要。
 * 真正的分组由 `agent-groups.js` 的真子代理生成；生成完成前用 bootstrap 扁平目录过渡。
 *
 * @module @local/dsh-tool-discovery/policy
 */
export const DEFAULT_RESIDENT = [
  // 执行基本盘
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image',
  'ask_user_question', 'todo_write', 'skill', 'job_*', 'web_search', 'web_fetch',
  'working_directory', 'load_workspace_dependencies', 'exit_plan_mode', 'present',
  // 委派 / 通信
  'subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent',
  // MCP 资源读取
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  // discovery 自己的入口
  'search_tools', 'catalog_status',
  // Agent Teams（own-layer，实际也不可 restrict；显式列出表达"就是常驻"）
  'spawn_teammate', 'wait_agent', 'team_task_*',
]

export function compileGlob(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export function tokensOf(name) {
  return String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

export function normalizeGroupId(raw) {
  const id = String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return id.length > 0 ? id : 'extensions'
}

export function mcpInfo(name) {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice('mcp__'.length)
  const separator = rest.indexOf('__')
  if (separator <= 0) return undefined
  const server = rest.slice(0, separator)
  return { server, id: `mcp-${normalizeGroupId(server)}` }
}

export function residentMatcher(config = {}) {
  const override = Array.isArray(config.resident) && config.resident.length > 0 ? config.resident : undefined
  const base = override ?? DEFAULT_RESIDENT
  const patterns = [...base, ...(config.extraKeepResident ?? [])].map(compileGlob)
  const deferred = (config.extraDeferred ?? []).map(compileGlob)
  return (name) => {
    if (deferred.some((re) => re.test(name))) return false
    return patterns.some((re) => re.test(name))
  }
}

function membersDescription(id, members, limit = 200) {
  const names = members.map((m) => m.name)
  const sample = names.slice(0, 8).join(', ')
  const more = names.length > 8 ? ` (+${names.length - 8} more)` : ''
  const prefix = id.startsWith('mcp-') ? `MCP server "${id.slice('mcp-'.length)}" tools: ` : 'Tools: '
  const text = `${prefix}${sample}${more}.`
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

export function summarizeGroups(entries, descriptions = new Map()) {
  const byGroup = new Map()
  for (const entry of entries) {
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, [])
    byGroup.get(entry.group).push(entry)
  }
  return [...byGroup.entries()]
    .map(([id, members]) => ({
      id,
      description: descriptions.get(id) ?? membersDescription(id, members),
      count: members.length,
      members: members.map((m) => m.name).sort(),
    }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 引导目录：agent 分组尚未就绪时的最小目录（不假装是分组策略）。 */
export function buildBootstrapCatalog(tools) {
  const entries = tools.map((tool) => ({ ...tool, group: 'others' }))
  return {
    strategy: 'agentic-tool-catalog',
    source: 'bootstrap',
    entries,
    groups: [],
    others: entries.map((entry) => entry.name).sort(),
    warnings: [{ kind: 'catalog-bootstrap', message: `agent 分组尚未就绪：${tools.length} 个工具暂以扁平目录提供` }],
  }
}

export const SCORE = { name: 6, description: 2, groupId: 4, groupDescription: 2 }

export const QUERY_STOPWORDS = new Set([
  'get', 'set', 'list', 'create', 'update', 'delete', 'remove', 'read', 'write',
  'add', 'edit', 'run', 'query', 'status', 'manage', 'execute', 'copy', 'move',
])

export function singularize(token) {
  const t = String(token).toLowerCase()
  if (t.length <= 3) return t
  if (t.endsWith('ies')) return `${t.slice(0, -3)}y`
  if (t.endsWith('es')) return t.slice(0, -2)
  if (t.endsWith('s')) return t.slice(0, -1)
  return t
}

export function queryTokens(query) {
  const raw = String(query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const meaningful = raw.filter((t) => !QUERY_STOPWORDS.has(t) && !QUERY_STOPWORDS.has(singularize(t)))
  const base = meaningful.length > 0 ? meaningful : raw
  const out = new Set()
  for (const token of base) {
    out.add(token)
    out.add(singularize(token))
  }
  return [...out]
}

export function rankTools(catalog, query, options = {}) {
  const limit = Math.max(1, Math.min(20, options.limit ?? 6))
  const groupMax = Math.max(1, options.groupMaxResults ?? 30)
  const loadedSet = options.loaded instanceof Set ? options.loaded : new Set(options.loaded ?? [])
  const raw = String(query ?? '').trim().toLowerCase()
  const groupById = new Map(catalog.groups.map((g) => [g.id.toLowerCase(), g]))
  const exact = groupById.get(raw)
  if (exact !== undefined) {
    const members = exact.members.filter((name) => !loadedSet.has(name))
    const loaded = members.slice(0, groupMax)
    return { loaded, more: 0, groupLoad: true, groupId: exact.id, remainingInGroup: members.length - loaded.length }
  }
  const tokens = queryTokens(raw)
  if (tokens.length === 0) return { loaded: [], more: 0, groupLoad: false, groupId: null, remainingInGroup: 0 }
  const groupText = new Map(catalog.groups.map((g) => [g.id, `${g.id} ${g.description}`.toLowerCase()]))
  const scored = []
  for (const entry of catalog.entries) {
    if (loadedSet.has(entry.name)) continue
    const name = entry.name.toLowerCase()
    const description = String(entry.description ?? '').toLowerCase()
    const gid = entry.group.toLowerCase()
    const gtext = groupText.get(entry.group) ?? ''
    let score = 0
    for (const token of tokens) {
      if (name.includes(token)) score += SCORE.name
      if (description.includes(token)) score += SCORE.description
      if (gid.includes(token)) score += SCORE.groupId
      if (gtext.includes(token)) score += SCORE.groupDescription
    }
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score || (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0))
  const picked = scored.slice(0, limit)
  return {
    loaded: picked.map((p) => p.entry.name),
    more: scored.length - picked.length,
    groupLoad: false,
    groupId: null,
    remainingInGroup: 0,
  }
}

/** 系统提示 note：组 + 计数；rules 策略附带 others 名字（上限 maxOtherNames）。 */

export function noteText(catalog, loaded, options = {}) {
  const maxOtherNames = options.maxOtherNames ?? 20
  const loadedSet = loaded instanceof Set ? loaded : new Set(loaded ?? [])
  const groupCounts = new Map()
  for (const entry of catalog.entries) {
    if (loadedSet.has(entry.name)) continue
    if (entry.group === 'others') continue
    groupCounts.set(entry.group, (groupCounts.get(entry.group) ?? 0) + 1)
  }
  const groups = [...groupCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const others = catalog.others.filter((name) => !loadedSet.has(name))
  if (groups.length === 0 && others.length === 0) return ''
  const groupText = groups.map((g) => `${g.id} (${g.count})`).join(', ')
  const shownOthers = others.slice(0, maxOtherNames)
  const moreOthers = others.length - shownOthers.length
  const othersText = shownOthers.length === 0
    ? ''
    : ` Others: ${shownOthers.join(', ')}${moreOthers > 0 ? ` (+${moreOthers} more)` : ''}.`
  const head = groups.length > 0 ? `Some capability tools are deferred and not loaded: ${groupText}.` : 'Some capability tools are deferred and not loaded.'
  const prefix = catalog.source === 'bootstrap'
    ? `Tool catalog is initializing: ${catalog.entries.length} capabilities are searchable by name; grouping completes in the background. `
    : catalog.source === 'agent-stale'
      ? 'Note: using the most recent successful grouping while the catalog refreshes. '
      : ''
  return `${prefix}${head}${othersText} Load what you need with search_tools (or tools.search_tools inside run_code) before using it.`
}

/** 零命中时的目录页：组 + 描述；others 单列。 */

export function catalogSummary(catalog, limit = 200) {
  const lines = catalog.groups.map((g) => `- ${g.id} (${g.count} tools): ${String(g.description).slice(0, limit)}`)
  if (catalog.others.length > 0) {
    const sample = catalog.others.slice(0, 30).join(', ')
    const more = catalog.others.length > 30 ? ` (+${catalog.others.length - 30} more)` : ''
    lines.push(`- others (${catalog.others.length} tools): ${sample}${more}`)
  }
  return lines.join('\n')
}
