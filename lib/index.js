/**
 * dsh-agentic-tool-catalog —— 由 agent 维护的按需工具目录。
 *
 * 核心：目录变化时由 DSH 原生子代理生成一次分组（agent-curated），插件严格校验后
 * 按目录指纹缓存到 **官方 Storage**（ctx.storageDomain），失败自动重试/沿用最近一次成功分组，
 * 生成完成前用扁平目录过渡；模型通过 `search_tools` 按需加载，`catalog_status` 只读观测。
 *
 * 机制要点（2026-11-10/11 对照 0.2.2-rc.1 源码核对）：
 *   - 目录来自 `ctx.tools.definitions(scope)`（公开 API）；
 *   - 用 `agent.ctx.tools.restrict({ deny })` 把未加载工具连 schema 从请求里移除；
 *   - restriction 变更会同步触发 `tools/change`，必须带重入守卫；
 *   - restriction 释放由插件实例 effect 持有（全局登记表跨实例清理）。
 *
 * @module @local/dsh-agentic-tool-catalog
 */
import { createHash } from 'node:crypto'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'

import { buildBootstrapCatalog, catalogSummary, noteText, pruneLoadedTools, rankTools, residentMatcher } from './catalog.js'
import { catalogFromAgentGroups, createAgentGrouper, resolveCatalogChange, validateAgentGroups } from './generation.js'
import { createGenerationQueue, SKIP_GENERATION } from './generation-queue.js'
import { createCatalogStore } from './store.js'

/** Cordis 插件名（Loader 行 id 用它）。 */
export const name = 'dsh-agentic-tool-catalog'

/** 需要工具注册表。 */
export const inject = ['tools']

/** 运行期配置。 */
export const Config = z.object({
  /** 一次普通 search 最多加载多少个工具。 */
  maxResults: z.number().default(6),
  /** 整组加载上限（query 精确等于组名时）。 */
  groupMaxResults: z.number().default(30),
  /** 是否在系统提示里加动态发现提示。 */
  promptNote: z.boolean().default(true),
  /** 覆盖内置常驻清单（空数组 = 用内置默认）。 */
  resident: z.array(z.string()).default([]),
  /** 往常驻清单追加 glob。 */
  extraKeepResident: z.array(z.string()).default([]),
  /** 强制按需（glob），优先于常驻。 */
  extraDeferred: z.array(z.string()).default([]),
  /** 生成子代理 provider（DSH subagent 服务里的注册名）。 */
  catalogProvider: z.string().default('spawn'),
  /** 单次生成超时（毫秒）：到点会取消并等待子代理真正结束，不再只是 abort。 */
  catalogTimeoutMs: z.number().default(120000),
  /** 进程级同时最多几个 catalog 生成子代理（跨 session 全局限流；默认 1，夹在 1..4）。 */
  catalogMaxConcurrentGenerations: z.number().default(1),
  /** 官方 Storage 里 `tables.catalogs` 最多保留多少个目录指纹（按 createdAt 淘汰最旧；默认 64）。 */
  catalogCacheMaxEntries: z.number().default(64),
  /** 是否自动归档每次生成创建的子会话（默认 true；排障时可关掉）。 */
  catalogArchiveChildSessions: z.boolean().default(true),
  /** 缓存命名空间：改这个值会让所有目录指纹失效、强制重新生成（运维/调试用）。 */
  catalogResetNonce: z.string().default(''),
})

/** 失败退避基数：第一次失败后 10 分钟再试，之后每次翻倍，最多 6 小时（避免定时 prompt 反复起子代理）。 */
const FAILURE_BACKOFF_BASE_MS = 10 * 60 * 1000
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
/** 兼容旧的内存写法（timestamp）与新的 `{ at, count }` 记录。 */
const failureAt = (entry) => (typeof entry === 'number' ? entry : entry?.at ?? 0)
const failureCount = (entry) => (typeof entry === 'number' ? 1 : Math.max(1, Math.trunc(entry?.count ?? 1)))
const failureBackoffMs = (entry) => Math.min(
  FAILURE_BACKOFF_BASE_MS * 2 ** (failureCount(entry) - 1),
  FAILURE_BACKOFF_MAX_MS,
)

/** 截断长描述，避免搜索结果膨胀。 */
function truncate(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** 跨插件实例的 restriction 登记（清理 HMR/重载遗留；兼容 v1 WeakMap）。 */
const REGISTRY = Symbol.for('@local/dsh-agentic-tool-catalog/restrictions')
/** 旧插件身份（重命名迁移用）：清理旧实例/旧 bundle 留下的 restriction，避免工具表残缺。 */
const LEGACY_REGISTRY = Symbol.for('@local/dsh-tool-discovery/restrictions')

function restrictionRegistry() {
  const existing = globalThis[REGISTRY]
  if (existing instanceof Map) return existing
  const registry = new Map()
  globalThis[REGISTRY] = registry
  return registry
}

function disposeEntry(entry) {
  try {
    if (typeof entry === 'function') entry()
    else if (entry !== null && typeof entry === 'object' && typeof entry.dispose === 'function') entry.dispose()
  } catch {}
}

const SHARED = Symbol.for('@local/dsh-agentic-tool-catalog/shared-v1')

/** 进程级共享状态：HMR 换插件实例时缓存/统计不丢（globalThis 跨模块实例保留）。 */
function sharedState() {
  let shared = globalThis[SHARED]
  if (shared === undefined) {
    shared = {
      instanceSeq: 0,
      agentStats: {
        runs: 0,
        cacheHits: 0,
        failures: 0,
        retries: 0,
        deduped: 0,
        staleUses: 0,
        incrementalRuns: 0,
        // 纯删除（added 为空）跳过生成的次数：这是“工具只是变少”的观测计数，不刷新 lastOkAt。
        removalOnlySkips: 0,
        // 上游移除工具后从会话 loaded 集合里清掉的残影工具数。
        loadedPruned: 0,
        lastError: null,
        lastOkAt: null,
      },
      catalogCache: new Map(), // fingerprint -> 已构建目录（热路径）
      groups: new Map(), // fingerprint -> 原始分组（来自官方 Storage / 本进程生成）
      catalogTimes: new Map(), // fingerprint -> createdAt（Storage 淘汰用）
      lastGood: null, // { fingerprint, groups, at }
      failures: new Map(), // fingerprint -> { at, count }（指数退避）
      inflight: new Map(), // fingerprint -> Promise<目录|null>（单飞）
      generationQueue: undefined, // 进程级生成调度器（跨 session 限流/去重；HMR 后沿用）
      lastReload: null,
    }
    globalThis[SHARED] = shared
  }
  return shared
}

/**
 * 注册 search_tools / catalog_status，并按 agent 维护"常驻 + 按需"两类工具。
 * @param ctx - 带 `tools` 服务的 profile 上下文。
 * @param config - patch 行提供的配置。
 */
export function apply(ctx, config) {
  const instance = Symbol('instance')
  const shared = sharedState()
  const instanceId = ++shared.instanceSeq
  // 新实例 = 新代码：不继承上一版留下的退避/暂停，否则热修后还要等 10 分钟才重试。
  shared.failures.clear()
  delete shared.agentStats.paused
  const registry = restrictionRegistry()
  const logger = ctx.logger
  const bootAt = Date.now() // 区分“进程启动后新建会话”（预热）与“恢复会话”（按需）

  for (const [agent, entry] of [...registry.entries()]) {
    if (entry !== null && typeof entry === 'object' && entry.instance === instance) continue
    disposeEntry(entry)
    registry.delete(agent)
  }
  // 重命名迁移：旧 bundle 被 remove/替换时，其 restriction 可能没被旧实例 effect 清掉（实测孤儿限制），
  // 这里主动释放旧全局登记表，避免新会话工具表只剩少数工具。
  const legacy = globalThis[LEGACY_REGISTRY]
  if (legacy instanceof Map) {
    for (const [, entry] of [...legacy.entries()]) disposeEntry(entry)
    legacy.clear()
  }

  const isResident = residentMatcher(config)
  const maxResults = Math.max(1, Math.min(20, config.maxResults ?? 6))
  const groupMaxResults = Math.max(1, config.groupMaxResults ?? 30)
  const agentGrouper = createAgentGrouper(ctx, config, logger, shared.agentStats)
  const store = createCatalogStore(ctx, shared, logger, { maxEntries: config.catalogCacheMaxEntries })
  const resetNonce = typeof config.catalogResetNonce === 'string' ? config.catalogResetNonce : ''
  shared.catalogTimes ??= new Map()
  // 进程级生成调度：全局限流 + 同 fingerprint 跨 session 去重 + 预热节流。HMR 后沿用同一个队列。
  if (shared.generationQueue === undefined) {
    shared.generationQueue = createGenerationQueue({ maxConcurrent: config.catalogMaxConcurrentGenerations })
  } else {
    shared.generationQueue.configure({ maxConcurrent: config.catalogMaxConcurrentGenerations })
  }
  const generationQueue = shared.generationQueue

  /** SSE 订阅：sessionId → Set<ServerResponse>；只承载目录/会话状态快照，不推送正文。 */
  const subscribers = new Map()
  /** 每个 SSE 连接最后发送的 payload：相同快照不重复推送。 */
  const lastEventPayload = new WeakMap()
  /** 由 snapshotFor 注入；applyRestriction/rebuild 在运行时调用。 */
  let publishSnapshot = () => {}
  const sendEvent = (res, payload) => {
    if (lastEventPayload.get(res) === payload) return
    lastEventPayload.set(res, payload)
    try { res.write(payload) } catch {}
  }

  const states = new WeakMap()
  const stateOf = (agent) => {
    let state = states.get(agent)
    if (state === undefined) {
      state = {
        catalog: null,
        loaded: new Set(),
        denier: undefined,
        denyKey: '',
        warnings: [],
        fingerprint: '',
        source: 'bootstrap',
        cacheOrigin: 'none',
        activated: false,
        needsEnrichment: false,
        deferred: [],
        resident: [],
        enrichment: { pending: undefined, active: false, dirty: false },
      }
      states.set(agent, state)
    }
    return state
  }

  const disposeRestriction = (agent, state = states.get(agent)) => {
    if (state?.denier !== undefined) {
      try { state.denier() } catch {}
      state.denier = undefined
      state.denyKey = ''
    }
    const entry = registry.get(agent)
    if (entry !== undefined) {
      disposeEntry(entry)
      registry.delete(agent)
    }
  }

  /** 该 agent 可被 restriction 过滤的工具名（继承层；own-layer 不可过滤）。 */
  const restrictableNamesOf = (agent) => {
    const scope = scopeOf(agent.ctx)
    if (scope !== undefined) {
      try {
        const view = ctx.tools.view(scope)
        if (view?.restrictableNames instanceof Set) return view.restrictableNames
      } catch {}
    }
    try { return new Set(ctx.tools.schemas().map((s) => s.name)) } catch { return new Set() }
  }

  /** 该 agent 自己的可见工具定义（含 preset 组合）。 */
  const definitionsOf = (agent) => {
    const scope = scopeOf(agent.ctx)
    if (scope === undefined) return []
    try {
      if (typeof ctx.tools.definitions === 'function') return ctx.tools.definitions(scope)
      return ctx.tools.schemas(scope)
    } catch (error) {
      logger?.warn?.(`dsh-agentic-tool-catalog: 读取 agent 工具表失败：${String(error?.message ?? error)}`)
      return []
    }
  }

  /** 目录指纹 = sha256(排序后的工具名 + 缓存命名空间)。只依赖名字，不依赖描述。 */
  const fingerprintOf = (tools) => {
    const names = tools.map((tool) => tool.name).sort().join('\n')
    return createHash('sha256').update(`${resetNonce}\u0000${names}`).digest('hex')
  }

  /** 收敛可见工具集：deny = 目录 − 已加载。 */
  const applyRestriction = (agent, state) => {
    if (state.catalog === null) return
    const catalog = state.catalog
    const hidden = catalog.entries.map((e) => e.name).filter((toolName) => !state.loaded.has(toolName))
    const key = hidden.slice().sort().join('\n')
    if (key === state.denyKey) {
      publishSnapshot(agent)
      return
    }
    if (hidden.length === 0) {
      disposeRestriction(agent, state)
      publishSnapshot(agent)
      return
    }
    try {
      mutating = true
      const dispose = agent.ctx.tools.restrict({ deny: hidden })
      disposeRestriction(agent, state)
      state.denier = dispose
      state.denyKey = key
      registry.set(agent, { instance, dispose })
      mutating = false
    } catch (error) {
      mutating = false
      state.denyKey = ''
      logger?.warn?.(`dsh-agentic-tool-catalog: 收敛可见工具集失败（稍后重试）：${String(error?.message ?? error)}`)
    }
    publishSnapshot(agent)
  }

  /** 由原始分组构建目录（并缓存到热路径）。 */
  const catalogFor = (fingerprint, deferred, rawGroups, origin) => {
    const cached = shared.catalogCache.get(fingerprint)
    if (cached !== undefined) return cached
    const checked = validateAgentGroups(deferred, { groups: rawGroups })
    if (checked.error !== undefined) return undefined
    const catalog = catalogFromAgentGroups(deferred, checked.groups)
    catalog.source = 'agent'
    shared.catalogCache.set(fingerprint, catalog)
    return catalog
  }

  /**
   * 目录增强：真子代理生成。目录变化时跑一次、按指纹缓存；
   * 失败 → 自动重试（由 grouper 负责）→ 上次成功分组 → 扁平引导目录。
   */
  const startEnrichment = (agent, state, deferred, fingerprint, options = {}) => {
    const allowGenerate = options.allowGenerate !== false
    if (state.enrichment.active) return
    if (deferred.length === 0) {
      // 没有可分组的工具：不启动子代理（防御性，正常由 rebuild 的空目录分支拦下）。
      state.needsEnrichment = false
      return
    }
    const cacheKey = fingerprint
    const isSubAgent = agent.session?.header?.origin === 'subagent'
    if (isSubAgent && !shared.groups.has(cacheKey)) return

    const applyCatalog = (enriched, origin = 'generated') => {
      if (enriched === undefined) {
        shared.agentStats.staleUses += 1
        const lastGood = shared.lastGood
        if (lastGood !== null && Array.isArray(lastGood.groups) && lastGood.groups.length > 0) {
          // 与 rebuild 的“纯删除本地适配”共用同一个过滤/告警实现，只把告警换成失败原因。
          const change = resolveCatalogChange(deferred, lastGood.groups, {
            failureMessage: `本次生成未成功，暂用最近一次成功分组（fingerprint ${String(lastGood.fingerprint).slice(0, 12)}）；后台会退避重试，详见 generation.lastError`,
          })
          if (state.fingerprint !== fingerprint) return
          state.catalog = change.catalog
          state.source = change.catalog.source
          state.warnings = [...(change.catalog.warnings ?? [])]
          applyRestriction(agent, state)
          logger?.warn?.(`dsh-agentic-tool-catalog: 生成未成功，暂用最近一次成功分组（${shared.agentStats.lastError?.code ?? 'UNKNOWN'}）`)
          return
        }
        state.source = 'bootstrap'
        state.warnings = [...(state.catalog?.warnings ?? []), { kind: 'catalog-bootstrap', message: '生成未成功且无历史分组，暂用扁平目录；详见 generation.lastError' }]
        return
      }
      if (state.fingerprint !== fingerprint) return
      state.catalog = enriched
      state.source = enriched.source ?? 'agent'
      state.cacheOrigin = origin
      state.warnings = [...(enriched.warnings ?? [])]
      state.needsEnrichment = false
      if (enriched.groups.length > 0) {
        const lastGood = {
          fingerprint,
          groups: enriched.groups.map((group) => ({ id: group.id, description: group.description, tools: group.members })),
          at: Date.now(),
        }
        store.saveLastGood(lastGood)
      }
      applyRestriction(agent, state)
      publishSnapshot(agent)
    }

    // 1) 热路径缓存
    const hot = shared.catalogCache.get(cacheKey)
    if (hot !== undefined) {
      shared.agentStats.cacheHits += 1
      applyCatalog(hot, 'memory')
      return
    }
    // 2) 官方 Storage hydrate 的原始分组
    const raw = shared.groups.get(cacheKey)
    if (raw !== undefined) {
      const catalog = catalogFor(cacheKey, deferred, raw, 'storage')
      if (catalog !== undefined) {
        shared.agentStats.cacheHits += 1
        applyCatalog(catalog, 'storage')
        return
      }
      shared.groups.delete(cacheKey)
      shared.catalogTimes?.delete(cacheKey)
    }
    // Storage 还在 hydrate：先不生成，等 ready 后统一 syncAll
    if (store.info.state === 'opening') {
      state.needsEnrichment = true
      return
    }
    // 软闸门：宿主连续拒绝 activation spec 后暂停自动生成，继续用 last-known-good；
    // 到期由 generate() 自动解除，插件重装也会清掉（见 apply 顶部）。
    const paused = shared.agentStats.paused
    if (paused !== undefined && Date.now() < paused.retryAt) {
      state.needsEnrichment = true
      if (!state.warnings.some((entry) => entry.kind === 'catalog-generation-paused')) {
        state.warnings = [...state.warnings, { kind: 'catalog-generation-paused', message: paused.message }]
      }
      return
    }
    const failure = shared.failures.get(cacheKey)
    if (failure !== undefined && Date.now() - failureAt(failure) < failureBackoffMs(failure)) return

    if (!allowGenerate) {
      state.needsEnrichment = true
      return
    }

    state.enrichment.active = true
    publishSnapshot(agent)
    const run = async () => {
      // 增量 prompt 必须用**同一指纹**的分组：跨会话拿 shared.lastGood 会把别的目录的
      // 组/工具混进来（2026-11-16 实测导致生成子代理反复核对目录、拖到超时）。
      const previousGroups = shared.groups.get(cacheKey) ?? shared.lastGood?.groups
      const outcome = await generationQueue.request(
        cacheKey,
        () => agentGrouper.generate({ agent, tools: deferred, previousGroups }),
        { prewarm: options.prewarm === true },
      )
      if (outcome === SKIP_GENERATION) return SKIP_GENERATION
      const generated = outcome
      if (generated.groups === undefined) {
        const previous = shared.failures.get(cacheKey)
        shared.failures.set(cacheKey, { at: Date.now(), count: failureCount(previous) + 1 })
        return null
      }
      const catalog = catalogFromAgentGroups(deferred, generated.groups)
      catalog.source = 'agent'
      shared.catalogCache.set(cacheKey, catalog)
      shared.failures.delete(cacheKey)
      store.saveGroups(cacheKey, generated.groups.map((group) => ({ id: group.id, description: group.description, tools: group.members })))
      return catalog
    }
    let generation = shared.inflight.get(cacheKey)
    if (generation === undefined) {
      generation = run()
      shared.inflight.set(cacheKey, generation)
      generation.finally(() => shared.inflight.delete(cacheKey)).catch(() => {})
    } else {
      shared.agentStats.deduped += 1
    }
    const settle = (enriched) => {
      state.enrichment.active = false
      state.enrichment.pending = undefined
      publishSnapshot(agent)
      if (enriched === SKIP_GENERATION) {
        // 全局生成槽位忙 / 预热被节流：不用 stale 告警刷屏；保持 needsEnrichment，
        // 恢复会话的下一次 prompt/search 会以按需方式补上（此时不再走 prewarm）。
        shared.agentStats.generationSkipped = (shared.agentStats.generationSkipped ?? 0) + 1
        // 指纹在飞行期间已变化时不要复活 needsEnrichment：新增工具由 dirty 触发重跑，
        // 纯删除（本地适配）已经不需要生成（2026-11-23 的 16 次空跑子代理由这里兜底）。
        if (state.fingerprint === fingerprint) state.needsEnrichment = true
      } else {
        applyCatalog(enriched ?? undefined)
      }
      const dirty = state.enrichment.dirty === true
      state.enrichment.dirty = false
      if (dirty && state.fingerprint !== '' && state.fingerprint !== fingerprint) {
        startEnrichment(agent, state, state.deferred, state.fingerprint, { allowGenerate: true })
      }
    }
    state.enrichment.pending = generation.then(
      (enriched) => { settle(enriched); return enriched },
      (error) => {
        // 兜底：run() 内部已把业务失败变成 null；这里只处理真正的意外异常。
        // 仍记一次指数退避，避免每次 prompt 都因同一个 bug 立刻重起子代理。
        const previous = shared.failures.get(cacheKey)
        shared.failures.set(cacheKey, { at: Date.now(), count: failureCount(previous) + 1 })
        logger?.warn?.(`dsh-agentic-tool-catalog: catalog generation pipeline failed: ${String(error?.message ?? error).slice(0, 160)}`)
        settle(undefined)
        return undefined
      },
    )
  }

  /**
   * 重建该 agent 的目录：释放旧 restriction → 读全量定义 → 引导目录/上次成功分组 → 缓存/生成。
   *
   * 生成与否由**工具名集合的增删**决定（resolveCatalogChange）：
   *   - 有新增（added 非空）或没有历史分组 → 启动真实生成（增量 prompt）；
   *   - 只有删除（added 为空）→ 本地过滤上次成功分组，产出新目录并跳过生成；
   *   - deferred 为空 → 空目录分支。
   * 纯删除跳过生成是 2026-11-23 的修复：上游 MCP token 刷新会让单个工具可见性变化，
   * 旧实现只要 fingerprint 变了就起子代理，16 次纯删除等于 16 次空跑。
   */
  const rebuild = (agent, force = false) => {
    const state = stateOf(agent)
    mutating = true
    disposeRestriction(agent, state)
    mutating = false
    const restrictable = restrictableNamesOf(agent)
    const definitions = definitionsOf(agent)
    const deferred = definitions
      .filter((definition) => restrictable.has(definition.name))
      .filter((definition) => !isResident(definition.name))
      .map((definition) => ({ name: definition.name, description: String(definition.description ?? '') }))
    const deferredNames = new Set(deferred.map((definition) => definition.name))
    state.resident = definitions
      .filter((definition) => !deferredNames.has(definition.name))
      .map((definition) => definition.name)
    // 上游可能把工具从表里移除：loaded 不能留下不存在的工具（否则 pending 计数漂移）。
    // deny 由目录条目派生，已移除工具不会进入新 deny，因此不会留下“永远 deny 的不存在工具”。
    const prunedLoaded = pruneLoadedTools(state.loaded, definitions.map((definition) => definition.name))
    if (prunedLoaded.length > 0) {
      shared.agentStats.loadedPruned += prunedLoaded.length
      logger?.info?.(`dsh-agentic-tool-catalog: 工具已不在当前工具表，从 loaded 清理 ${prunedLoaded.length} 个：${prunedLoaded.slice(0, 5).join(', ')}`)
    }
    const fingerprint = fingerprintOf(deferred)
    if (!force && state.catalog !== null && state.fingerprint === fingerprint) {
      applyRestriction(agent, state)
      publishSnapshot(agent)
      return
    }
    if (deferred.length === 0) {
      // 空目录（工具全部常驻/已加载）：没有可分组的对象，直接给空目录并跳过生成。
      // 否则每次都会启动子代理去分 0 个工具，必然失败在 TOO_FEW_GROUPS / EMPTY_GROUP（2026-11-11 实测）。
      if (state.enrichment.active && state.fingerprint !== fingerprint) state.enrichment.dirty = true
      state.catalog = { strategy: 'agentic-tool-catalog', source: 'agent', entries: [], groups: [], others: [], warnings: [] }
      state.source = 'agent'
      state.warnings = []
      state.fingerprint = fingerprint
      state.deferred = []
      state.needsEnrichment = false
      applyRestriction(agent, state)
      return
    }
    // 变化判定基准：优先该 agent 上一版工具集（指纹）的成功分组，其次进程最近一次成功分组。
    // 两者都只包含“生成成功”的分组，不存在把失败/引导目录当基准的问题。
    const previousGroups = shared.groups.get(state.fingerprint) ?? shared.lastGood?.groups
    const change = resolveCatalogChange(deferred, previousGroups)
    // 当前指纹已有缓存（热路径或官方 Storage hydrate）：这是缓存命中，不是“纯删除跳过”，
    // 交给 startEnrichment 的 raw/hot 路径应用（source=agent、origin=storage/memory）。
    const cachedCatalog = shared.catalogCache.has(fingerprint) || shared.groups.has(fingerprint)
    let catalog
    if (change.mode === 'bootstrap') {
      catalog = buildBootstrapCatalog(deferred)
    } else {
      catalog = change.catalog
      if (change.mode === 'generate') {
        catalog.warnings = [...(catalog.warnings ?? []), { kind: 'catalog-refreshing', message: `目录变化（新增 ${change.added.length} 个工具）：暂用上次成功分组并后台重新生成` }]
      }
    }
    state.catalog = catalog
    state.source = catalog.source ?? 'bootstrap'
    state.cacheOrigin = change.mode === 'local' ? 'adapted' : 'none'
    state.warnings = [...(catalog.warnings ?? [])]
    const removalOnlySkip = change.mode === 'local' && !cachedCatalog
    if (removalOnlySkip) {
      // 纯删除（或 force 下无新增）：本地过滤上次成功分组就是正确目录，不启动生成。
      // 不写 catalog-generated、不刷新 lastGood/lastOkAt（本次没有发生生成），只留可观测计数与告警。
      shared.agentStats.removalOnlySkips += 1
    }
    if (state.enrichment.active && state.fingerprint !== fingerprint && change.needsGeneration) {
      state.enrichment.dirty = true
    }
    state.fingerprint = fingerprint
    state.deferred = deferred
    applyRestriction(agent, state)
    const isNewSession = (agent.session?.header?.createdAt ?? 0) >= bootAt
    const eager = isNewSession || state.activated
    // 缓存命中时也要进 startEnrichment（它先查 hot/raw 再谈生成）；纯删除跳过的路径才完全不进。
    state.needsEnrichment = change.needsGeneration || cachedCatalog
    if (change.needsGeneration || cachedCatalog) {
      startEnrichment(agent, state, deferred, fingerprint, {
        allowGenerate: eager,
        // 预热是刻意设计，但只在全局空闲时启动；忙时留给首个 prompt/search（按需）。
        prewarm: isNewSession && !state.activated,
      })
    }
    publishSnapshot(agent)
  }

  /** 真正需要时才触发生成（恢复会话的首个请求/搜索；新会话在创建时已预热）。 */
  const ensureEnrichment = (agent) => {
    const state = states.get(agent)
    if (state === undefined) return
    state.activated = true
    if (state.catalog === null) return
    if (state.enrichment.active) return
    if (state.needsEnrichment) startEnrichment(agent, state, state.deferred, state.fingerprint, { allowGenerate: true })
  }

  let applying = false
  let mutating = false
  const isMutating = () => applying || mutating
  const sync = (agent, force = false) => {
    if (isMutating()) return
    applying = true
    try { rebuild(agent, force) } finally { applying = false }
  }
  const syncAll = (force = false) => {
    const agents = ctx.get('agents')
    if (agents === undefined) return
    for (const agent of agents.list()) sync(agent, force)
  }

  // Storage hydrate 完成后，把缓存目录应用到所有 agent（首次启动的磁盘命中在这里生效）。
  store.whenReady().then((ok) => {
    if (!ok) return
    shared.catalogCache.clear()
    syncAll(true)
  }).catch(() => {})

  // ── 只读状态快照（catalog_status 工具 + Client dock 共用） ─────────────────
  const snapshotFor = (agent, state, options = {}) => {
    const catalog = state?.catalog
    const loaded = state === undefined ? new Set() : state.loaded
    const groups = (catalog?.groups ?? [])
      .map((group) => {
        const entry = { id: group.id, count: group.members.filter((name) => !loaded.has(name)).length }
        if (options.withDescriptions === true) entry.description = truncate(group.description, 160)
        return entry
      })
      .filter((group) => group.count > 0)
    const pendingOthers = (catalog?.others ?? []).filter((name) => !loaded.has(name)).length
    const active = state?.enrichment?.active === true
    const freshness = state === undefined
      ? 'none'
      : state.source === 'bootstrap'
        ? (active ? 'refreshing' : 'bootstrap')
        : state.source === 'agent-stale'
          ? (active ? 'refreshing' : 'stale')
          : (active ? 'refreshing' : 'fresh')
    return {
      plugin: 'agentic-tool-catalog',
      catalog: {
        source: state?.source ?? 'none',
        freshness,
        origin: state?.cacheOrigin ?? 'none',
        total: catalog?.entries.length ?? 0,
        resident: state?.resident?.length ?? 0,
        groups,
        others: pendingOthers,
      },
      session: {
        loaded: [...loaded].sort(),
        pending: catalog === null || state === undefined ? null : catalog.entries.length - loaded.size,
        restriction: state === undefined
          ? 'no-agent'
          : state.denier === undefined ? 'none' : `deny ${(state.denyKey ?? '').split('\n').filter(Boolean).length} tools`,
        resident: `${(config.resident?.length ?? 0) > 0 ? `${config.resident.length} (override)` : 'builtin'} + ${config.extraKeepResident?.length ?? 0} extra`,
      },
      generation: {
        provider: agentGrouper.provider,
        enabled: agentGrouper.enabled(),
        activationShapes: agentGrouper.activationShapes,
        state: active ? 'running' : 'idle',
        ...shared.agentStats,
        queue: generationQueue.status(),
        instanceId,
        lastReload: shared.lastReload,
      },
      storage: store.status(),
      warnings: state?.warnings ?? [],
    }
  }

  // ── search_tools：唯一的常驻入口 ─────────────────────────────────────────
  const description = [
    'Search the agent-curated on-demand tool catalog and load matching tools for this session.',
    'Most integration and management tools are NOT loaded by default (MCP servers, DSH self-management, browser automation, reminders, goals, workflows, and other extensions).',
    'Before using one of those capabilities, search here with an intent or keywords; matching tools become callable for the rest of this session (directly, or as tools.<name> inside run_code).',
    'If the query exactly matches a catalog group name, the whole group loads at once (up to the configured group limit).',
  ].join(' ')

  ctx.tools.register(defineTool({
    name: 'search_tools',
    description,
    parameters: {
      query: {
        type: 'string',
        description: 'What capability you need, or keywords from a tool name/description (e.g. "cloudflare dns", "gmail send", "archive session", "browser screenshot", "reminder"), or an exact catalog group name.',
      },
      limit: {
        type: 'number',
        description: `Maximum number of tools to load; defaults to ${maxResults}, capped at 20.`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // 并发与原子性：从读 state 到 applyRestriction 之间必须零 await——这段的原子性就是全部的并发保护。
    // 不要在 defineTool 上声明 isConcurrencySafe：这个工具会改可见集。
    // 需要异步的前置工作（校验、遥测）请放在读 state 之前。
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) return 'search_tools can only run inside an agent session.'
      sync(agent)
      ensureEnrichment(agent)
      const state = stateOf(agent)
      const catalog = state.catalog
      if (catalog === null || catalog.entries.length === 0) {
        return 'No on-demand capability tools are registered for this session.'
      }
      const pending = catalog.entries.length - state.loaded.size
      if (pending <= 0) {
        return 'All on-demand capability tools are already loaded for this session. Call them (directly, or from inside run_code), or use catalog_status to inspect the catalog.'
      }
      const query = String(args.query ?? '').trim()
      const limit = Math.max(1, Math.min(20, Math.trunc(args.limit ?? maxResults)))
      const result = rankTools(catalog, query, { limit, groupMaxResults, loaded: state.loaded })
      if (result.loaded.length === 0) {
        return `No deferred tool matches "${query}". ${state.warnings.map((w) => w.message).join('; ')}\nSearch again with keywords from the on-demand groups, or use catalog_status for details.`
      }
      for (const toolName of result.loaded) state.loaded.add(toolName)
      applyRestriction(agent, state)
      const byName = new Map(catalog.entries.map((e) => [e.name, e]))
      const lines = result.loaded.map((toolName) => `- ${toolName}: ${truncate(byName.get(toolName)?.description, 240)}`)
      const head = result.groupLoad
        ? `Loaded ${result.loaded.length} tool(s) from group "${result.groupId}" for this session — callable from your next step (directly, or as tools.<name> inside run_code):`
        : `Loaded ${result.loaded.length} tool(s) for this session — callable from your next step (directly, or as tools.<name> inside run_code):`
      const remaining = result.remainingInGroup > 0
        ? `\n${result.remainingInGroup} more tool(s) in this group did not fit (groupMaxResults=${groupMaxResults}); search again with narrower keywords to load them.`
        : ''
      const more = result.more > 0
        ? `\n${result.more} more tool(s) matched; search again with a narrower query (or a higher limit) to load them.`
        : ''
      return `${head}\n${lines.join('\n')}${remaining}${more}`
    },
  }))

  // ── catalog_status：只读观测入口 ─────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'catalog_status',
    description: 'Read-only status of the agent-curated on-demand tool catalog: catalog freshness/origin, groups, loaded tools, generation/cache health, storage mode, warnings and restriction health. Use when debugging why a capability cannot be found or loaded.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      const state = agent === undefined ? undefined : states.get(agent)
      return JSON.stringify(snapshotFor(agent, state), null, 2)
    },
  }))

  // ── SSE：目录/会话状态变化事件驱动推送（面板不再轮询） ────────────────────
  const EVENTS_ROUTE = '/plugins/agentic-tool-catalog/events'
  publishSnapshot = (agent) => {
    const sessionId = agent?.session?.header?.id ?? agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const set = subscribers.get(sessionId)
    if (set === undefined || set.size === 0) return
    let payload
    try {
      payload = `event: snapshot\ndata: ${JSON.stringify({ v: 1, snapshot: snapshotFor(agent, states.get(agent), { withDescriptions: true }) })}\n\n`
    } catch { return }
    for (const res of [...set]) {
      sendEvent(res, payload)
    }
  }

  // ── Client dock 只读状态路由（可选 webServer；CLI/profile 无页面时静默跳过） ──
  const STATUS_ROUTE = '/plugins/agentic-tool-catalog/snapshot'
  const isTrustedRequest = (req) => {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
    try {
      const url = new URL(origin)
      if (url.protocol === 'dsh-app:') return true
      const host = req.headers.host
      return host !== undefined && url.host === host
    } catch { return false }
  }
  try {
    ctx.inject(['webServer'], (scope) => {
      const disposeRoute = scope.webServer.register({
        kind: 'exact',
        path: STATUS_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ v: 1, error: 'method-not-allowed' }))
            return
          }
          if (!isTrustedRequest(req)) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ v: 1, error: 'forbidden' }))
            return
          }
          let sessionId = ''
          try { sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? '' } catch {}
          if (sessionId === '') {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ v: 1, error: 'missing-session-id' }))
            return
          }
          const agents = ctx.get('agents')
          const agent = agents?.list?.().find((candidate) => (candidate.session?.header?.id ?? candidate.session?.id) === sessionId)
          if (agent === undefined) {
            res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ v: 1, error: 'session-not-found' }))
            return
          }
          const snapshot = snapshotFor(agent, states.get(agent), { withDescriptions: true })
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ v: 1, snapshot }))
        },
      })
      scope.effect(() => () => {
        try { disposeRoute() } catch {}
      }, 'agentic-tool-catalog: snapshot route')

      const disposeEvents = scope.webServer.register({
        kind: 'exact',
        path: EVENTS_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ v: 1, error: 'method-not-allowed' }))
            return
          }
          if (!isTrustedRequest(req)) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ v: 1, error: 'forbidden' }))
            return
          }
          let sessionId = ''
          try { sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? '' } catch {}
          const agents = ctx.get('agents')
          const agent = agents?.list?.().find((candidate) => (candidate.session?.header?.id ?? candidate.session?.id) === sessionId)
          if (sessionId === '' || agent === undefined) {
            res.writeHead(sessionId === '' ? 400 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ v: 1, error: sessionId === '' ? 'missing-session-id' : 'session-not-found' }))
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          res.write(': connected\n\n')
          try {
            sendEvent(res, `event: snapshot\ndata: ${JSON.stringify({ v: 1, snapshot: snapshotFor(agent, states.get(agent), { withDescriptions: true }) })}\n\n`)
          } catch {}
          let set = subscribers.get(sessionId)
          if (set === undefined) {
            set = new Set()
            subscribers.set(sessionId, set)
          }
          set.add(res)
          const heartbeat = setInterval(() => {
            try { res.write(': ping\n\n') } catch {}
          }, 25000)
          res.on('close', () => {
            clearInterval(heartbeat)
            set.delete(res)
            if (set.size === 0) subscribers.delete(sessionId)
          })
        },
      })
      scope.effect(() => () => {
        try { disposeEvents() } catch {}
        for (const [sessionId, set] of [...subscribers.entries()]) {
          for (const res of [...set]) {
            try { res.end() } catch {}
          }
          subscribers.delete(sessionId)
        }
      }, 'agentic-tool-catalog: events route')
    })
  } catch (error) {
    logger?.warn?.(`dsh-agentic-tool-catalog: status route unavailable (${String(error?.message ?? error)})`)
  }

  // ── 重载观测 ────────────────────────────────────────────────────────────
  for (const event of ['hmr/reload', 'plugin-manager/changed', 'app-boot/config-reload']) {
    try { ctx.on(event, () => { shared.lastReload = { event, at: Date.now() } }) } catch {}
  }

  // ── 按 agent 收敛可见工具集 ──────────────────────────────────────────────
  ctx.on('agent/created', ({ agent }) => sync(agent, true))
  ctx.on('agent/inbox/claimed', ({ agent }) => ensureEnrichment(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    disposeRestriction(agent)
    states.delete(agent)
  })
  ctx.on('agent-preset/selected', () => syncAll(true))
  ctx.on('tools/change', () => {
    if (isMutating()) return
    syncAll(false)
  })
  syncAll(true)
  ctx.effect(() => () => {
    for (const [agent, entry] of [...registry.entries()]) {
      if (entry !== null && typeof entry === 'object' && entry.instance !== instance) continue
      disposeEntry(entry)
      registry.delete(agent)
    }
    const agents = ctx.get('agents')
    if (agents !== undefined) for (const agent of agents.list()) disposeRestriction(agent)
  })

  // ── 系统提示里的一条简短目录提示 ─────────────────────────────────────────
  const systemPrompt = ctx.get('systemPrompt')
  if (config.promptNote !== false && systemPrompt !== undefined) {
    systemPrompt.context({
      name: 'catalog:note',
      order: 300,
      text: (assemblyContext) => {
        const agent = assemblyContext?.agent
        const state = agent === undefined ? undefined : states.get(agent)
        if (state?.catalog === undefined || state?.catalog === null) return ''
        return noteText(state.catalog, state.loaded)
      },
    })
  }
}
