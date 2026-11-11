/**
 * agent-groups.js —— 真 agent 参与归类（生产化版）：用 DSH 原生子代理生成工具分组。
 *
 * 与"一次性 LLM 调用"的区别（用户 2026-11-10 明确）：
 *   这里启动的是**真实 DSH 子代理**（ctx.get('subagents').startActivation，provider=spawn），
 *   它继承本机模型/preset，可多步推理，最后通过结构化输出提交 `{groups:[...]}`；
 *   我们只接收最终结构化结果、校验、缓存、失败回退 rules。
 *
 * 安全/稳定性：
 *   - 递归守卫在 index.js：子代理自身（session.header.origin === 'subagent'）不触发本层；
 *   - 超时 + dispose；任何失败都不抛进 agent-loop，返回 error 供状态记录；
 *   - 结果严格校验（100% 覆盖、无重复、组名/描述/组数/组大小合法），不合法即回退规则目录。
 *
 * @module @local/dsh-agentic-tool-catalog/generation
 */
import { normalizeGroupId, summarizeGroups } from './catalog.js'

export const AGENT_GROUP_DEFAULTS = {
  provider: 'spawn',
  timeoutMs: 120000,
  maxGroups: 24,
  minGroups: 6,
  maxGroupSize: 40,
  descriptionLimit: 120,
}

/** 结构化输出 schema：子代理必须提交 {groups:[{id,description,tools:[...]}]}。 */
export const AGENT_GROUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'description', 'tools'],
      },
    },
  },
  required: ['groups'],
}

const truncate = (text, limit) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** 生成子代理的任务 prompt（工具清单直接内联，子代理无需调工具）。 */
export function buildAgentGroupPrompt(tools, options = {}) {
  const feedback = options.feedback
  const limit = options.descriptionLimit ?? AGENT_GROUP_DEFAULTS.descriptionLimit
  const maxGroups = options.maxGroups ?? AGENT_GROUP_DEFAULTS.maxGroups
  const previous = Array.isArray(options.previousGroups) ? options.previousGroups : undefined
  // 组数下限受工具数约束：工具不足 6 个时不可能凑出 6 个非空组（空目录只能是 0 组）。
  const minGroups = Math.min(AGENT_GROUP_DEFAULTS.minGroups, tools.length)
  const allowedGroups = Math.min(maxGroups, tools.length)
  if (previous !== undefined && previous.length > 0) {
    // 增量模式：只给“上次成功分组 + 新工具描述”，要求保留稳定 id、最小改动。
    const known = new Set(tools.map((tool) => tool.name))
    const previousCompact = previous.map((group) => ({
      id: group.id,
      description: truncate(group.description, 160),
      tools: (group.members ?? group.tools ?? []).filter((name) => known.has(name)),
    })).filter((group) => group.tools.length > 0)
    const previousNames = new Set(previousCompact.flatMap((group) => group.tools))
    const newTools = tools.filter((tool) => !previousNames.has(tool.name))
    const inventory = JSON.stringify(newTools.map((tool) => ({ name: tool.name, description: truncate(tool.description, limit) })))
    return [
      'You are updating an existing agent tool-catalog grouping after a catalog change.',
      'Keep every existing group id/description and its tool membership unchanged unless the new tools clearly require',
      'adding to a group or a split/merge; prefer the smallest change. Then return the COMPLETE updated grouping.',
      '',
      `Constraints: between ${minGroups} and ${allowedGroups} groups; every current tool exactly once;`,
      'copy tool names exactly as given (including mcp__server__ prefixes); do not invent/omit tools;',
      'return the result via the structured output tool.',
      ...feedback === undefined ? [] : ['', `A previous attempt was rejected: ${feedback}. Fix exactly that and retry.`],
      '',
      'Existing groups (JSON, tool names only):',
      JSON.stringify(previousCompact),
      '',
      'New tools since last successful grouping (JSON):',
      inventory,
      '',
      'Current tool count: ' + tools.length + '; previous grouped tools: ' + previousNames.size,
    ].join('\n')
  }
  const inventory = JSON.stringify(tools.map((tool) => ({ name: tool.name, description: truncate(tool.description, limit) })))
  return [
    'You are organizing an agent\'s on-demand tool catalog into capability groups.',
    'The catalog below is the ONLY source of tools. Group every tool exactly once, by user intent/capability',
    '(not merely by name prefix or MCP server namespace). Prefer groups a model can pick by reading the group name.',
    '',
    `Constraints: between ${minGroups} and ${allowedGroups} groups; group id lowercase kebab-case and unique;`,
    'group description one short English sentence (<=160 chars) naming the capability; every tool exactly once;',
    'IMPORTANT: copy every tool name EXACTLY as given, character for character (including the full mcp__server__ prefix);',
    'never shorten, translate, or rename a tool; do not invent tool names; do not omit tools; each tool appears once.',
    'Return the result via the structured output tool.',
    ...feedback === undefined ? [] : ['', `A previous attempt was rejected: ${feedback}. Fix exactly that and retry.`],
    '',
    'Tool catalog (JSON):',
    inventory,
  ].join('\n')
}

/**
 * 校验子代理返回的分组。
 * @returns { groups: [{id, description, members}] } 或 { error: {code,message} }
 */
export function validateAgentGroups(tools, raw, options = {}) {
  const maxGroups = options.maxGroups ?? AGENT_GROUP_DEFAULTS.maxGroups
  const minGroups = options.minGroups ?? AGENT_GROUP_DEFAULTS.minGroups
  const maxGroupSize = options.maxGroupSize ?? AGENT_GROUP_DEFAULTS.maxGroupSize
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.groups)) {
    return { error: { code: 'INVALID_SHAPE', message: 'agent output has no groups array' } }
  }
  const known = new Map(tools.map((tool) => [tool.name, tool]))
  // 空目录：没有任何可分组对象，唯一合法的输出就是 0 组（否则生成永远卡在 TOO_FEW_GROUPS）。
  if (tools.length === 0) {
    if (raw.groups.length === 0) return { groups: [] }
    return { error: { code: 'UNEXPECTED_GROUPS', message: `catalog is empty but agent returned ${raw.groups.length} group(s)` } }
  }
  // 组数下限受工具数约束：工具不足 minGroups 个时，凑满 minGroups 个非空组是不可能的。
  const requiredMinGroups = Math.min(minGroups, tools.length)

  /** 模型常把 mcp__workspace__calendar_list 简写/补全错；唯一后缀匹配可安全修正。 */
  const resolveName = (raw) => {
    if (typeof raw !== 'string' || raw === '') return undefined
    if (known.has(raw)) return raw
    const suffix = `__${raw}`
    const matches = [...known.keys()].filter((name) => name.endsWith(suffix) || name === raw)
    return matches.length === 1 ? matches[0] : undefined
  }
  const seen = new Map() // toolName -> groupId
  const groups = []
  const ids = new Set()
  for (const entry of raw.groups) {
    if (entry === null || typeof entry !== 'object') return { error: { code: 'INVALID_SHAPE', message: 'group entry is not an object' } }
    if (typeof entry.id !== 'string' || entry.id.trim() === '') return { error: { code: 'INVALID_GROUP', message: 'group id missing' } }
    const id = normalizeGroupId(entry.id)
    if (ids.has(id)) return { error: { code: 'DUPLICATE_GROUP', message: `duplicate group id ${id}` } }
    ids.add(id)
    const description = truncate(entry.description, 200)
    if (description === '') return { error: { code: 'INVALID_GROUP', message: `group ${id} has no description` } }
    const members = []
    for (const rawName of Array.isArray(entry.tools) ? entry.tools : []) {
      const name = resolveName(rawName)
      if (name === undefined) return { error: { code: 'UNKNOWN_TOOL', message: `group ${id} references unknown tool ${String(rawName).slice(0, 80)}` } }
      if (seen.has(name)) return { error: { code: 'DUPLICATE_TOOL', message: `tool ${name} appears in multiple groups` } }
      seen.set(name, id)
      members.push(name)
    }
    if (members.length === 0) return { error: { code: 'EMPTY_GROUP', message: `group ${id} has no tools` } }
    if (members.length > maxGroupSize) return { error: { code: 'GROUP_TOO_LARGE', message: `group ${id} has ${members.length} tools (>${maxGroupSize})` } }
    groups.push({ id, description, members: members.sort() })
  }
  if (groups.length < requiredMinGroups) return { error: { code: 'TOO_FEW_GROUPS', message: `agent output ${groups.length} groups (<${requiredMinGroups})` } }
  if (groups.length > maxGroups) return { error: { code: 'TOO_MANY_GROUPS', message: `agent output ${groups.length} groups (>${maxGroups})` } }
  const missing = tools.map((tool) => tool.name).filter((name) => !seen.has(name))
  if (missing.length > 0) {
    return { error: { code: 'MISSING_TOOLS', message: `agent output misses ${missing.length} tool(s): ${missing.slice(0, 5).join(', ')}` } }
  }
  return { groups }
}

/** 把一组“已知良好”的分组适配到当前工具目录（用于生成失败时的降级，避免退回规则目录）。 */
export function adaptAgentGroups(tools, groups) {
  const known = new Set(tools.map((tool) => tool.name))
  const memberOf = new Map()
  const descriptions = new Map()
  const kept = []
  for (const group of groups) {
    const members = (group.members ?? group.tools ?? []).filter((name) => known.has(name))
    if (members.length === 0) continue
    const id = normalizeGroupId(group.id)
    descriptions.set(id, truncate(group.description, 200))
    for (const name of members) if (!memberOf.has(name)) memberOf.set(name, id)
    kept.push({ id, description: truncate(group.description, 200), members })
  }
  const entries = tools.map((tool) => ({ ...tool, group: memberOf.get(tool.name) ?? 'others' }))
  return {
    strategy: 'agentic-tool-catalog',
    source: 'agent-stale',
    entries,
    groups: summarizeGroups(entries.filter((entry) => entry.group !== 'others'), descriptions),
    others: entries.filter((entry) => entry.group === 'others').map((entry) => entry.name).sort(),
    warnings: [{ kind: 'catalog-stale-groups', message: `沿用上次成功分组（${kept.length} 组），${entries.filter((e) => e.group === 'others').length} 个新工具暂放 others` }],
  }
}

/** 由校验后的分组构造目录对象（与 policy.buildCatalog 同形）。 */
export function catalogFromAgentGroups(tools, groups) {
  const memberOf = new Map()
  const descriptions = new Map()
  for (const group of groups) {
    descriptions.set(group.id, group.description)
    for (const name of group.members) memberOf.set(name, group.id)
  }
  const entries = tools.map((tool) => ({ ...tool, group: memberOf.get(tool.name) ?? 'others' }))
  const catalog = {
    strategy: 'agentic-tool-catalog',
    source: 'agent',
    entries,
    groups: summarizeGroups(entries.filter((entry) => entry.group !== 'others'), descriptions),
    others: entries.filter((entry) => entry.group === 'others').map((entry) => entry.name).sort(),
    warnings: [{ kind: 'catalog-generated', message: `agent curated ${memberOf.size}/${tools.length} tools into ${groups.length} groups` }],
  }
  return catalog
}

/**
 * 创建"子代理分组器"。
 * @param ctx - 插件 ctx（需要 ctx.get('subagents')）。
 * @param config - 插件 config（catalogProvider / catalogTimeoutMs）。
 * @param logger - 可选 logger。
 */
export function createAgentGrouper(ctx, config, logger, sharedStats = undefined) {
  // stats 可由插件实例之外的共享对象提供：HMR 换实例后仍能看到累计成功/失败/重试次数。
  const stats = sharedStats ?? { runs: 0, cacheHits: 0, failures: 0, retries: 0, deduped: 0, staleUses: 0, incrementalRuns: 0, lastError: null, lastOkAt: null }
  stats.retries ??= 0
  stats.deduped ??= 0
  stats.staleUses ??= 0
  delete stats.fallbacks
  const provider = config?.catalogProvider ?? AGENT_GROUP_DEFAULTS.provider
  const timeoutMs = config?.catalogTimeoutMs ?? AGENT_GROUP_DEFAULTS.timeoutMs

  const service = () => {
    const subagents = ctx.get?.('subagents')
    if (subagents === undefined || typeof subagents.startActivation !== 'function') return undefined
    if (typeof subagents.getProvider === 'function' && subagents.getProvider(provider) === undefined) return undefined
    return subagents
  }

  /** 生成一次分组；失败返回 error（不抛）。 */
  async function generate({ agent, tools, previousGroups }) {
    const subagents = service()
    if (subagents === undefined) {
      // 观测缺口修复：provider 不可用也计入 failures / lastError（否则状态里看不到真实失败原因）。
      const error = { code: 'NO_SUBAGENT_SERVICE', message: `subagent provider ${provider} unavailable` }
      stats.failures += 1
      stats.lastError = { ...error, at: Date.now() }
      return { error }
    }
    stats.runs += 1
    let feedback
    const canIncremental = Array.isArray(previousGroups) && previousGroups.length > 0
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const useIncremental = canIncremental && attempt === 0
      if (useIncremental) stats.incrementalRuns = (stats.incrementalRuns ?? 0) + 1
      const attemptController = new AbortController()
      const attemptTimer = setTimeout(() => attemptController.abort(), timeoutMs)
      let activation
      try {
        activation = await subagents.startActivation({
          provider,
          label: 'agentic-tool-catalog generation',
          request: {
            parent: agent,
            prompt: [{ type: 'text', text: buildAgentGroupPrompt(tools, { feedback, previousGroups: useIncremental ? previousGroups : undefined }) }],
            maxDepth: 1,
            outputSchema: AGENT_GROUP_SCHEMA,
          },
          signal: attemptController.signal,
          delivery: 'caller',
        })
        const result = await activation.result
        const structured = result?.structured
        const validated = validateAgentGroups(tools, structured)
        if (validated.error === undefined) {
          stats.lastOkAt = Date.now()
          return { groups: validated.groups }
        }
        stats.lastError = { ...validated.error, at: Date.now() }
        if (attempt === 0) {
          // 校验失败：带错误摘要重试一次（模型大多能把漏/错的名字改对）
          stats.retries += 1
          feedback = `${validated.error.code}: ${validated.error.message}`.slice(0, 200)
          logger?.warn?.(`dsh-agentic-tool-catalog generation: retry after ${validated.error.code}`)
          continue
        }
        stats.failures += 1
        return { error: validated.error }
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 160)
        stats.lastError = { code: attemptController.signal.aborted ? 'TIMEOUT' : 'AGENT_FAILED', message, at: Date.now() }
        logger?.warn?.(`dsh-agentic-tool-catalog generation: ${message}`)
        stats.failures += 1
        return { error: stats.lastError }
      } finally {
        clearTimeout(attemptTimer)
        if (activation !== undefined) {
          try { await activation.dispose() } catch {}
        }
      }
    }
    stats.failures += 1
    return { error: stats.lastError ?? { code: 'UNKNOWN', message: 'generation failed' } }
  }

  return { generate, stats, provider, enabled: () => service() !== undefined }
}
