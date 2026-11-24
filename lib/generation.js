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
 *   - **超时会真正取消子代理**：宿主从 activation 发布之后就不再监听启动 signal
 *     （`SubagentActivationSpec.signal` 的契约是“只在发布前生效，之后由 dispose 负责”），
 *     所以只 abort + await result 会一直等到子 turn 自然结束（2026-11-16 实测 4 分半 > 120s）。
 *     现在超时路径显式 `interrupt()`，再 `await dispose()`（cancel → whenIdle → flush → release）；
 *   - 每次尝试结束（成功/失败/超时）都把生成的 child session 归档（DSH 无删除 API，
 *     Workspace archive 是官方生命周期），避免 origin=subagent 会话泄漏；
 *   - 任何失败都不抛进 agent-loop，返回 error 供状态记录；
 *   - 结果严格校验（100% 覆盖、无重复、组名/描述/组数/组大小合法），不合法即回退规则目录。
 *
 * @module @local/dsh-agentic-tool-catalog/generation
 */
import { normalizeGroupId, summarizeGroups } from './catalog.js'
import { createChildSessionRetirer } from './session-retire.js'
import { ACTIVATION_SHAPES, isActivationShapeError, startSubagentActivation } from './subagent-compat.js'

/** 连续多少次"宿主不认 activation spec"后暂停自动生成（避免 9/9 静默刷失败）。 */
export const SHAPE_FAILURE_PAUSE_THRESHOLD = 3
/** 形状不兼容暂停时长：1 小时；期间继续用 last-known-good 目录。 */
export const SHAPE_FAILURE_PAUSE_MS = 60 * 60 * 1000
/** 超时后等待 dispose 完成的上限（cancel/whenIdle/flush 正常是秒级；超过就只告警，归档兜底停掉残留活动）。 */
export const GENERATION_TEARDOWN_GRACE_MS = 15000
/** 归档子会话的上限：workspace 持久化/stop provider 卡住时不能占住全局生成槽位（归档在后台继续完成）。 */
export const GENERATION_ARCHIVE_TIMEOUT_MS = 5000
/** 内部 deadline 标记（区分“结果正好是这个值”）。 */
const DEADLINE = Symbol('agentic-tool-catalog/generation-deadline')

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
      'This is a pure text-classification task: use ONLY the structured output tool — do not call',
      'catalog_status/search_tools/bash/grep/fs, do not inspect the workspace or session storage, and ignore',
      'unrelated agent instructions in this session. Everything needed is in this message.',
      'If no tools are new and every current tool is already grouped, return the existing groups unchanged.',
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
    'This is a pure text-classification task: use ONLY the structured output tool — do not call',
    'catalog_status/search_tools/bash/grep/fs, do not inspect the workspace or session storage, and ignore',
    'unrelated agent instructions in this session.',
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

/** 一组“上次成功分组”覆盖的工具名（兼容 `members` 与 `tools` 两种字段形状）。 */
export function groupedToolNames(groups) {
  const names = new Set()
  for (const group of Array.isArray(groups) ? groups : []) {
    const members = group?.members ?? group?.tools
    for (const name of Array.isArray(members) ? members : []) names.add(name)
  }
  return names
}

/**
 * 当前工具集相对上次成功分组的增删（只比名字，与 fingerprint 判据一致）。
 * `added` 为空 = 纯删除（或没变化）：本地过滤旧分组就是正确目录，不需要模型重新分组。
 */
export function diffToolCatalog(tools, groups) {
  const current = new Set(tools.map((tool) => tool.name))
  const previous = groupedToolNames(groups)
  return {
    added: [...current].filter((name) => !previous.has(name)).sort(),
    removed: [...previous].filter((name) => !current.has(name)).sort(),
  }
}

/**
 * 把一组“已知良好”的分组适配到当前工具目录：按当前名单过滤每组成员、空组丢弃、
 * 未覆盖的工具落 `others`。这是**唯一**的本地过滤实现，两种调用方向共用：
 *   - 生成失败时降级（source=agent-stale，避免退回规则目录）；
 *   - 目录只删除工具时直接产出正确目录（source=agent-adapted，不做生成）。
 * @param tools - 当前工具目录（`{name, description}`）。
 * @param groups - 上次成功分组（`members` 或 `tools` 字段均可）。
 * @param options - `{ source, warning }`：覆盖 source 与 warnings 里的单条记录。
 */
export function adaptAgentGroups(tools, groups, options = {}) {
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
  const others = entries.filter((entry) => entry.group === 'others').map((entry) => entry.name).sort()
  return {
    strategy: 'agentic-tool-catalog',
    source: options.source ?? 'agent-stale',
    entries,
    groups: summarizeGroups(entries.filter((entry) => entry.group !== 'others'), descriptions),
    others,
    warnings: [options.warning ?? {
      kind: 'catalog-stale-groups',
      message: `沿用上次成功分组（${kept.length} 组），${others.length} 个新工具暂放 others`,
    }],
  }
}

/**
 * 目录变化决策 + 本地适配（唯一实现）：rebuild 的“纯删除跳过生成”和生成失败回退都走这里，
 * 不再各写一份过滤/告警逻辑。
 *
 * 判定（只看工具名集合，与 fingerprint 同源）：
 *   - 没有历史分组 → `bootstrap`：调用方给引导目录并生成（首次/失败回退）；
 *   - 传了 `options.failureMessage` → `fallback`：生成失败后的 stale 目录（调用方本来在退避重试）；
 *   - `added` 非空 → `generate`：有工具没被分组过，需要模型重新分组；
 *   - `added` 为空 → `local`：只删除了工具（或 force 下无变化），历史分组按当前名单过滤即正确。
 *
 * 为什么必须有 `local`（2026-11-23 实测）：上游 MCP 在 token 刷新时会让单个工具在 DSH 侧可见性
 * 变化，一次空闲会话 16 次“只少不多”的变化各起了一个真实 `agentic-tool-catalog generation`
 * 子代理，prompt 里 `New tools = []`，子代理按指示原样返回，纯空跑。
 *
 * @returns `{ mode, needsGeneration, added, removed, catalog? }`；catalog 在非 bootstrap 时存在。
 */
export function resolveCatalogChange(tools, previousGroups, options = {}) {
  if (!Array.isArray(previousGroups) || previousGroups.length === 0) {
    return { mode: 'bootstrap', needsGeneration: true, added: [], removed: [], catalog: undefined }
  }
  const { added, removed } = diffToolCatalog(tools, previousGroups)
  if (typeof options.failureMessage === 'string') {
    return {
      mode: 'fallback',
      needsGeneration: false,
      added,
      removed,
      catalog: adaptAgentGroups(tools, previousGroups, {
        source: 'agent-stale',
        warning: { kind: 'catalog-stale-groups', message: options.failureMessage },
      }),
    }
  }
  if (added.length === 0) {
    const sample = removed.slice(0, 12).join(', ')
    const more = removed.length > 12 ? ` (+${removed.length - 12} more)` : ''
    return {
      mode: 'local',
      needsGeneration: false,
      added,
      removed,
      catalog: adaptAgentGroups(tools, previousGroups, {
        source: 'agent-adapted',
        warning: {
          kind: 'catalog-removal-only',
          message: removed.length === 0
            ? '目录没有新增工具：沿用上次成功分组，不重新分组'
            : `目录移除了 ${removed.length} 个工具（未重新分组，本地过滤上次成功分组）：${sample}${more}`,
        },
      }),
    }
  }
  return {
    mode: 'generate',
    needsGeneration: true,
    added,
    removed,
    catalog: adaptAgentGroups(tools, previousGroups),
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
  stats.timeouts ??= 0
  stats.sessionsArchived ??= 0
  stats.sessionArchiveFailures ??= 0
  delete stats.fallbacks
  const provider = config?.catalogProvider ?? AGENT_GROUP_DEFAULTS.provider
  const configuredTimeout = Number(config?.catalogTimeoutMs ?? AGENT_GROUP_DEFAULTS.timeoutMs)
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.trunc(configuredTimeout)
    : AGENT_GROUP_DEFAULTS.timeoutMs
  /** 连续"形状不兼容"失败计数；跨 generator 实例不保留（插件重载即重试）。 */
  let shapeFailures = 0
  /** 每次生成尝试创建的 origin=subagent 会话都要归档，避免会话列表里无限累积。 */
  const retirer = createChildSessionRetirer(ctx, {
    enabled: config?.catalogArchiveChildSessions !== false,
    logger,
  })
  const teardownGraceMs = Math.max(1000, Math.min(timeoutMs, GENERATION_TEARDOWN_GRACE_MS))
  const archiveTimeoutMs = Math.min(GENERATION_ARCHIVE_TIMEOUT_MS, Math.max(250, timeoutMs))

  const service = () => {
    const subagents = ctx.get?.('subagents')
    if (subagents === undefined || typeof subagents.startActivation !== 'function') return undefined
    if (typeof subagents.getProvider === 'function' && subagents.getProvider(provider) === undefined) return undefined
    return subagents
  }

  /** 归档结果进入观测计数（超时兜底路径会在后台完成时补记）。 */
  const countRetired = (retired) => {
    if (retired.archived) stats.sessionsArchived += 1
    else if (retired.reason === 'archive-failed') stats.sessionArchiveFailures += 1
  }

  /**
   * 收尾一次生成尝试：超时先显式 interrupt，再 await dispose（cancel → whenIdle → flush → release），
   * 最后归档 child session。永不抛错：收尾失败只记日志，不能掩盖生成本身的结论。
   * 归档最多等 archiveTimeoutMs：workspace 写/stop provider 卡住时不能永久占住全局生成槽位。
   */
  async function releaseAttempt(subagents, agent, activation, timedOut) {
    if (activation === undefined || activation === null) return
    const childId = activation.childId
    if (timedOut && childId !== undefined && typeof subagents.interrupt === 'function') {
      try {
        // 官方 API：ancestor authority + 精确 live ancestor agent；fire-and-return，
        // 但 cancel 信号在返回前已发出，子 turn 会尽快看到。
        subagents.interrupt(childId, { kind: 'ancestor', agent })
      } catch (error) {
        logger?.warn?.(`dsh-agentic-tool-catalog generation: interrupt ${childId} failed: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
    let graceTimer
    try {
      if (typeof activation.dispose === 'function') {
        const disposal = Promise.resolve(activation.dispose())
        const settled = await Promise.race([
          disposal.then(() => true, (error) => {
            logger?.warn?.(`dsh-agentic-tool-catalog generation: teardown ${childId} failed: ${String(error?.message ?? error).slice(0, 120)}`)
            return true
          }),
          new Promise((resolve) => { graceTimer = setTimeout(() => resolve(false), teardownGraceMs) }),
        ])
        if (settled === false) {
          // 正常情况下 cancel 后秒级返回；极端情况（模型请求不响应 cancel）不无限占住
          // 全局生成槽位——随后的归档会通过 workspace/session-stop 再取消一次。
          logger?.warn?.(`dsh-agentic-tool-catalog generation: child ${childId} still tearing down after ${teardownGraceMs}ms; archiving to stop residual work`)
        }
      }
    } catch (error) {
      logger?.warn?.(`dsh-agentic-tool-catalog generation: teardown ${childId} threw: ${String(error?.message ?? error).slice(0, 120)}`)
    } finally {
      clearTimeout(graceTimer)
    }
    let archiveTimer
    try {
      const retiring = Promise.resolve().then(() => retirer.retire(childId))
      const retired = await Promise.race([
        retiring,
        new Promise((resolve) => {
          archiveTimer = setTimeout(() => resolve({ archived: false, reason: 'archive-timeout' }), archiveTimeoutMs)
        }),
      ])
      if (retired.reason === 'archive-timeout') {
        // 归档是尽力而为的收尾：不阻塞生成（更不阻塞全局槽位），后台完成后补计数。
        logger?.warn?.(`dsh-agentic-tool-catalog generation: archiving child ${childId} is still running after ${archiveTimeoutMs}ms; generation is not blocked`)
        retiring.then(countRetired, () => {})
      } else {
        countRetired(retired)
      }
    } catch (error) {
      stats.sessionArchiveFailures += 1
      logger?.warn?.(`dsh-agentic-tool-catalog generation: archive child ${childId} failed: ${String(error?.message ?? error).slice(0, 120)}`)
    } finally {
      clearTimeout(archiveTimer)
    }
  }

  /** 生成一次分组；失败返回 error（不抛）。 */
  async function generate({ agent, tools, previousGroups }) {
    // 形状不兼容暂停：到期自动解除；期间不计数、不重试，继续用 last-known-good。
    if (stats.paused !== undefined) {
      if (Date.now() < stats.paused.retryAt) return { error: { code: stats.paused.code, message: stats.paused.message } }
      delete stats.paused
      shapeFailures = 0
    }
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
      let timedOut = false
      let timer
      let activation
      let starting
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          // 启动阶段的 abort 会让宿主拒绝 start()；activation 发布之后，部分版本不再
          // 监听这个 signal（这次 bug 的根因），所以超时路径还要 interrupt + dispose。
          timedOut = true
          attemptController.abort()
          resolve(DEADLINE)
        }, timeoutMs)
      })
      try {
        // 版本形状差异只在 subagent-compat.js 里处理：顶层字段服务 0.2.2-rc.2+，
        // 不可枚举的 request 兼容 0.2.2-rc.1 及更早。
        starting = Promise.resolve(startSubagentActivation(subagents, {
          provider,
          label: 'agentic-tool-catalog generation',
          parent: agent,
          prompt: [{ type: 'text', text: buildAgentGroupPrompt(tools, { feedback, previousGroups: useIncremental ? previousGroups : undefined }) }],
          maxDepth: 1,
          outputSchema: AGENT_GROUP_SCHEMA,
          signal: attemptController.signal,
          delivery: 'caller',
        }))
        const started = await Promise.race([starting, deadline])
        if (started === DEADLINE) throw new Error(`generation did not publish a child within ${timeoutMs}ms`)
        activation = started
        // 超时分支会提前返回；先挂一个 catch，避免 result 的 rejection 变成 unhandled。
        Promise.resolve(activation.result).catch(() => {})
        const settledResult = await Promise.race([activation.result, deadline])
        clearTimeout(timer)
        if (settledResult === DEADLINE) {
          throw new Error(`generation exceeded ${timeoutMs}ms; child ${activation.childId} was cancelled`)
        }
        // 宿主接受了 spec 并返回结果：形状回退计数清零（即使下面校验失败，也与形状无关）。
        shapeFailures = 0
        delete stats.paused
        const structured = settledResult?.structured
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
        if (timedOut) {
          const childId = activation?.childId
          stats.timeouts += 1
          stats.lastError = {
            code: 'TIMEOUT',
            message: `generation exceeded ${timeoutMs}ms` + (childId === undefined ? '' : `; child ${childId} was cancelled and archived`),
            at: Date.now(),
          }
          logger?.warn?.(`dsh-agentic-tool-catalog generation: TIMEOUT after ${timeoutMs}ms${childId === undefined ? '' : ` (child ${childId} cancelled)`}`)
          stats.failures += 1
          return { error: stats.lastError }
        }
        const message = String(error?.message ?? error).slice(0, 160)
        const aborted = attemptController.signal.aborted
        const shapeFailure = !aborted && isActivationShapeError(error)
        if (shapeFailure) shapeFailures += 1
        else if (!aborted) shapeFailures = 0
        stats.lastError = {
          code: aborted ? 'TIMEOUT' : shapeFailure ? 'UNSUPPORTED_HOST' : 'AGENT_FAILED',
          message,
          at: Date.now(),
        }
        logger?.warn?.(`dsh-agentic-tool-catalog generation: ${message}`)
        if (shapeFailure && shapeFailures >= SHAPE_FAILURE_PAUSE_THRESHOLD && stats.paused === undefined) {
          // 软闸门：不为"宿主形状不认识"反复刷失败；保留 last-known-good，显式标 paused。
          stats.paused = {
            code: 'UNSUPPORTED_HOST',
            message: `host rejected the ${ACTIVATION_SHAPES.join('+')} subagent activation spec (${message}); `
              + 'automatic catalog generation paused for 1h; the last successful grouping keeps serving',
            at: Date.now(),
            retryAt: Date.now() + SHAPE_FAILURE_PAUSE_MS,
          }
          logger?.warn?.(`dsh-agentic-tool-catalog: ${stats.paused.message}`)
        }
        stats.failures += 1
        return { error: stats.lastError }
      } finally {
        clearTimeout(timer)
        if (activation !== undefined) {
          await releaseAttempt(subagents, agent, activation, timedOut)
        } else if (timedOut && starting !== undefined) {
          // 启动超时之后才发布成功的“迟到 activation”（包括 abort 后一个 microtask 才
          // resolve 的窗口）：这里不依赖任何 settle 标志，只要 deadline 赢了就挂收尾，
          // 保证它同样被 cancel/dispose/归档。
          starting.then(
            (late) => (late === undefined || late === null ? undefined : releaseAttempt(subagents, agent, late, true)),
            () => {},
          ).catch(() => {})
        }
      }
    }
    stats.failures += 1
    return { error: stats.lastError ?? { code: 'UNKNOWN', message: 'generation failed' } }
  }

  return { generate, stats, provider, activationShapes: ACTIVATION_SHAPES, enabled: () => service() !== undefined }
}
