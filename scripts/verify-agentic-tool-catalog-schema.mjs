#!/usr/bin/env node
/**
 * verify-agentic-tool-catalog-schema.mjs —— 用**真实的** `@deepseek-ai/dsh-tools` / `schemastery`
 * 验证 dsh-agentic-tool-catalog v2 插件的模块面：
 *   - 导出（name/inject/apply/Config）与 Config schema（默认值、未知字段拒绝）；
 *   - `apply(fakeCtx, config)` 能真实编译并注册 search_tools / discovery_status 两个 defineTool；
 *   - discovery_status 的 execute 能跑通并输出合法 JSON；
 *   - 插件实例 effect 返回 disposer。
 *
 * 为什么需要：定义/schema 写错会**在加载时**才炸（整个插件挂不上）。这里把真实包从 app.asar
 * 抽到 `reference/tmp/tool-discovery-schema/`（gitignored、可再生），在 Node 里直接 import 验证。
 *
 * 用法：node scripts/verify-agentic-tool-catalog-schema.mjs [--refresh]
 *
 * 覆盖的**不是**：真实 Cordis/tools 服务上的 restrict 行为与生命周期（那由部署后的
 * benchmark/真实会话验证）。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path, { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGIN = ROOT
const WORK = join(ROOT, 'reference', 'tmp', 'agentic-tool-catalog-schema')
const NODE_MODULES = join(WORK, 'node_modules')
const PLUGIN_DIR = join(WORK, 'plugin')
const MARKER = join(WORK, '.extracted')
const ASAR = process.env.DSH_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

let checks = 0
let failures = 0
function check(cond, label, detail) {
  checks += 1
  if (cond) return
  failures += 1
  console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)

if (!existsSync(ASAR)) {
  console.error(`找不到 app.asar：${ASAR}`)
  process.exit(2)
}

const NEED_ZOD = !existsSync(join(NODE_MODULES, 'zod', 'package.json'))
if (process.argv.includes('--refresh') || !existsSync(MARKER)) {
  mkdirSync(NODE_MODULES, { recursive: true })
  console.log(`抽取官方包到 ${NODE_MODULES} …`)
  const result = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'dsh-asar-extract.mjs'),
    'extract',
    'dsh/node_modules/@deepseek-ai/[^/]+/(package\.json|lib/.*)',
    '--out', NODE_MODULES,
    '--strip', 'dsh/node_modules/',
  ], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('抽取失败')
    process.exit(2)
  }
  writeFileSync(MARKER, new Date().toISOString())
}
if (NEED_ZOD) {
  // storage-domain 的 zod 依赖：同样抽取到测试 node_modules，供插件模块加载。
  const zodResult = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'dsh-asar-extract.mjs'),
    'extract',
    'dsh/node_modules/zod/',
    '--out', NODE_MODULES,
    '--strip', 'dsh/node_modules/',
  ], { stdio: 'inherit' })
  if (zodResult.status !== 0) {
    console.error('抽取 zod 失败')
    process.exit(2)
  }
}

mkdirSync(PLUGIN_DIR, { recursive: true })
for (const file of ['index.js', 'catalog.js', 'change-buffer.js', 'generation.js', 'generation-queue.js', 'session-retire.js', 'store.js', 'subagent-compat.js']) {
  cpSync(join(PLUGIN, 'lib', file), join(PLUGIN_DIR, file))
}

console.log('== 模块导出 ==')
const plugin = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href)
eq(plugin.name, 'dsh-agentic-tool-catalog', 'export name')
eq(plugin.inject, ['tools'], 'export inject')
check(typeof plugin.apply === 'function', 'export apply')
check(typeof plugin.Config === 'function' || typeof plugin.Config === 'object', 'export Config')

console.log('== Client 半边与只读路由 ==')
{
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  check(manifest.dsh?.client?.platform === 'web', 'package.json 声明 dsh.client.platform=web')
  check((manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-conversation'), 'client inject 包含 conversation UI')
  check(manifest.exports?.['./client'] === './lib/client.js', 'exports 暴露 ./client')
  const clientSource = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
  check(clientSource.includes('conversation.composer.dock'), 'client 注册 composer dock 座位')
  check(clientSource.includes('/plugins/agentic-tool-catalog/snapshot'), 'client 从只读状态路由取数')
  check(clientSource.includes('/plugins/agentic-tool-catalog/events') && clientSource.includes('EventSource'), 'client 使用 SSE 事件流（非轮询）')
  const hostSource = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8')
  check(hostSource.includes('/plugins/agentic-tool-catalog/snapshot'), 'host 注册只读状态路由')
  check(hostSource.includes('generationQueue') && hostSource.includes('catalogMaxConcurrentGenerations'), 'host 接入进程级生成调度（全局限流）')
  const generationSource = readFileSync(join(PLUGIN, 'lib', 'generation.js'), 'utf8')
  check(generationSource.includes('interrupt(') && generationSource.includes('GENERATION_TEARDOWN_GRACE_MS'), 'generation 超时路径显式 interrupt + await dispose')
  check(generationSource.includes('createChildSessionRetirer'), 'generation 每次尝试后归档子会话')
  check(hostSource.includes('/plugins/agentic-tool-catalog/events') && hostSource.includes('text/event-stream'), 'host 注册 SSE 事件流')
  check(hostSource.includes('withDescriptions: true'), '状态路由返回分组描述（面板展示用）')
}

console.log('== Config schema（真实 schemastery）==')
let defaults
try {
  defaults = plugin.Config({})
} catch (error) {
  check(false, 'Config({}) 验证', error.message)
}
if (defaults) {
  eq(defaults.maxResults, 6, '默认 maxResults=6')
  eq(defaults.groupMaxResults, 30, '默认 groupMaxResults=30')
  eq(defaults.promptNote, true, '默认 promptNote=true')
  eq(defaults.extraDeferred, [], '默认 extraDeferred=[]')
  eq(defaults.catalogProvider, 'spawn', '默认 catalogProvider=spawn')
  eq(defaults.catalogTimeoutMs, 120000, '默认 catalogTimeoutMs=120000')
  eq(defaults.catalogMaxConcurrentGenerations, 1, '默认 catalogMaxConcurrentGenerations=1（全局单飞）')
  eq(defaults.catalogCacheMaxEntries, 64, '默认 catalogCacheMaxEntries=64')
  eq(defaults.catalogArchiveChildSessions, true, '默认 catalogArchiveChildSessions=true')
  eq(defaults.catalogResetNonce, '', '默认 catalogResetNonce 为空')
  eq(defaults.catalogStabilizeMs, 2500, '默认 catalogStabilizeMs=2500（tools/change 稳定窗口开）')
  eq(defaults.catalogStabilizeMaxMs, 30000, '默认 catalogStabilizeMaxMs=30000（硬上限）')
  check(!('strategy' in defaults), 'Config 无 strategy 字段')
  check(!('strategyFile' in defaults), 'Config 无 strategyFile')
}
// 注意：schemastery 对未知字段是透传而非报错，故不做“拒绝未知字段”断言；
// 旧策略配置已不存在于 Config，生产 patch 只能配置这里声明的字段。

console.log('== apply + defineTool（真实 dsh-tools 编译）==')
const registered = []
let disposer
const fakeCtx = {
  tools: { register(definition) { registered.push(definition) } },
  get() { return undefined },
  on() {},
  effect(fn) { disposer = fn() },
  logger: { warn() {} },
}
try {
  plugin.apply(fakeCtx, plugin.Config({}))
  check(true, 'apply() 不抛错')
} catch (error) {
  check(false, 'apply() 不抛错', error.message)
}
eq(registered.map((d) => d.name).sort(), ['catalog_status', 'search_tools'], '注册 search_tools + catalog_status')
const statusTool = registered.find((d) => d.name === 'catalog_status')
if (statusTool) {
  const raw = await statusTool.execute({}, { agent: undefined })
  let parsed
  try {
    parsed = JSON.parse(raw)
    check(true, 'catalog_status 返回合法 JSON')
  } catch {
    check(false, 'catalog_status 返回合法 JSON', String(raw).slice(0, 120))
  }
  if (parsed) {
    eq(parsed.plugin, 'agentic-tool-catalog', 'catalog_status 报告插件身份')
    eq(parsed.session?.restriction, 'no-agent', '无 agent 时 restriction=no-agent')
  }
}
check(typeof disposer === 'function', '插件实例 effect 返回 disposer')

console.log('== 目录变化：纯删除不启动第二个生成（真实 apply + 假宿主）==')
{
  // 用真实 dsh-tools 编译过的 apply() 跑完整 rebuild 路径：首次生成 → 上游移除一个工具 →
  // tools/change 触发 rebuild。纯删除必须走本地适配：
  //   不启动第二个子代理 / 删空的组消失 / loaded 残影被清理 / lastOkAt 不刷新 /
  //   removalOnlySkips 与 catalog-removal-only 告警可观测；
  // 之后再新增一个工具，生成必须重新启动（added 非空）。
  // 这是一个空转子代理 bug（2026-11-23：16 次纯删除 = 16 次空跑）的端到端回归。
  const SHARED_KEY = Symbol.for('@local/dsh-agentic-tool-catalog/shared-v1')
  const REGISTRY_KEY = Symbol.for('@local/dsh-agentic-tool-catalog/restrictions')
  delete globalThis[SHARED_KEY]
  delete globalThis[REGISTRY_KEY]

  let toolDefs = [
    ['mcp__workspace__calendar_list', 'List calendar events'],
    ['mcp__workspace__gmail_send', 'Send a gmail message'],
    ['mcp__workspace__gmail_list', 'List gmail messages'],
    ['mcp__workspace__drive_list', 'List drive files'],
    ['dsh_session_manage', 'Manage sessions'],
    ['browser_open', 'Open a browser page'],
    ['schedule_create', 'Create a schedule'],
  ].map(([name, description]) => ({ name, description }))

  // 6 组：前 6 个工具各成一组，多余工具并入第 2 组；calendar 是 capability-0 的唯一成员，
  // 删除它之后该组必须整组消失（本地适配的“空组丢弃”）。
  const groupsFor = (defs) => {
    const names = defs.map((entry) => entry.name)
    const buckets = Array.from({ length: 6 }, (_, index) => (index < names.length ? [names[index]] : []))
    for (let index = 6; index < names.length; index += 1) buckets[1 + ((index - 6) % 5)].push(names[index])
    return buckets.map((members, index) => ({ id: `capability-${index}`, description: `Capability group ${index}`, tools: members }))
  }

  let generationStarts = 0
  const host = {
    startActivation: async () => {
      generationStarts += 1
      return {
        childId: `child-removal-${generationStarts}`,
        result: Promise.resolve({ structured: { groups: groupsFor(toolDefs) } }),
        dispose: async () => {},
      }
    },
    getProvider: () => ({ name: 'spawn' }),
  }

  // 假 agent：scopeOf(agent.ctx) 读一个 symbol 属性，返回任意 tag 即可让 view/definitions 分支生效。
  const restrictionLog = []
  const agentCtx = new Proxy({
    tools: {
      restrict: ({ deny }) => {
        restrictionLog.push([...deny])
        return () => {}
      },
    },
  }, {
    get(target, property) {
      if (typeof property === 'symbol') return 'fake-scope'
      return target[property]
    },
  })
  const agent = {
    session: { header: { id: 'session-removal-test', origin: 'main', createdAt: Date.now() + 1000 } },
    ctx: agentCtx,
  }
  // 恢复会话（createdAt 早于插件启动）：用于验证“窗口内首次 prompt 被推迟、结算后补生成”。
  const restoredAgent = {
    session: { header: { id: 'session-restored-test', origin: 'main', createdAt: 1 } },
    ctx: agentCtx,
  }
  const agentsList = [agent, restoredAgent]

  const registrations = []
  const handlers = new Map()
  const removalCtx = {
    tools: {
      register(definition) { registrations.push(definition) },
      view() { return { restrictableNames: new Set(toolDefs.map((entry) => entry.name)) } },
      definitions() { return toolDefs },
      schemas() { return toolDefs },
    },
    get(name) {
      if (name === 'agents') return { list: () => agentsList }
      if (name === 'subagents') return host
      return undefined
    },
    on(event, listener) {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : undefined
    },
    inject() {},
    logger: { warn() {} },
  }
  plugin.apply(removalCtx, plugin.Config({
    catalogTimeoutMs: 5000,
    catalogProvider: 'spawn',
    // 稳定窗口调小以便测试：窗口 60ms、硬上限 150ms。
    catalogStabilizeMs: 60,
    catalogStabilizeMaxMs: 150,
  }))
  const emit = (event, target = agent) => {
    for (const listener of handlers.get(event) ?? []) listener({ agent: target })
  }
  const removalStatus = registrations.find((definition) => definition.name === 'catalog_status')
  const removalSearch = registrations.find((definition) => definition.name === 'search_tools')
  const snapshot = async () => JSON.parse(await removalStatus.execute({}, { agent }))
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (await predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`等待超时：${label}`)
  }
  const waitSettled = () => waitFor(async () => !(await snapshot()).generation.stabilize.pending, '稳定窗口结算')

  await waitFor(async () => (await snapshot()).generation.lastOkAt !== null, '首次生成完成')
  const generated = await snapshot()
  eq(generated.catalog.source, 'agent', '初始：首次生成产出 agent 目录')
  eq(generated.catalog.total, 7, '初始：目录 7 个按需工具')
  eq(generationStarts, 1, '初始：启动一次生成子代理')

  // 按公开路径加载一个工具（会把名字记进 state.loaded）。
  await removalSearch.execute({ query: 'calendar list' }, { agent })
  const loadedBefore = await snapshot()
  check(loadedBefore.session.loaded.includes('mcp__workspace__calendar_list'), '加载：search_tools 把 calendar 工具记入 loaded')

  // ── 场景 1：纯删除走稳定窗口 → 本地适配，不生成 ─────────────────────────
  const beforeRemoval = await snapshot()
  toolDefs = toolDefs.filter((entry) => entry.name !== 'mcp__workspace__calendar_list')
  emit('tools/change')
  const pendingRemoval = await snapshot()
  eq(pendingRemoval.generation.stabilize.pending, true, '稳定窗口：tools/change 后进入等待（pending）')
  eq(pendingRemoval.generation.stabilize.windowMs, 60, '稳定窗口：使用配置的窗口长度')
  eq(pendingRemoval.generation.stabilize.maxMs, 150, '稳定窗口：使用配置的硬上限')
  eq(pendingRemoval.catalog.total, beforeRemoval.catalog.total, '稳定窗口：窗口内不重建目录（仍是上一版）')
  emit('agent/inbox/claimed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  eq(generationStarts, 1, '稳定窗口：窗口内的 prompt 不会启动生成')
  await waitSettled()
  const afterRemoval = await snapshot()
  eq(afterRemoval.generation.stabilize.pending, false, '稳定窗口：结算后 pending 清零')
  eq(generationStarts, 1, '纯删除：没有启动第二个生成子代理（真实 apply 路径）')
  eq(afterRemoval.generation.runs, beforeRemoval.generation.runs, '纯删除：generation.runs 不增加')
  eq(afterRemoval.generation.lastOkAt, beforeRemoval.generation.lastOkAt, '纯删除：lastOkAt 不被刷新（本次没有生成）')
  eq(afterRemoval.generation.removalOnlySkips, 2, '纯删除：removalOnlySkips 计数（两个会话各一次本地适配）')
  eq(afterRemoval.catalog.source, 'agent-adapted', '纯删除：source=agent-adapted（不冒充生成结果）')
  eq(afterRemoval.catalog.freshness, 'fresh', '纯删除：没有“刷新中/待刷新”状态（本来不需要生成）')
  eq(afterRemoval.catalog.total, 6, '纯删除：目录条目数跟随工具表')
  check(!afterRemoval.catalog.groups.some((group) => group.id === 'capability-0'), '纯删除：删空的组从目录消失')
  eq(afterRemoval.catalog.groups.length, 5, '纯删除：其余 5 组保留')
  check(!afterRemoval.session.loaded.includes('mcp__workspace__calendar_list'), '纯删除：loaded 里已移除的工具被清理')
  eq(afterRemoval.generation.loadedPruned, 1, '纯删除：loadedPruned 计数（清理了 1 个已不存在的工具）')
  check(afterRemoval.warnings.some((warning) => warning.kind === 'catalog-removal-only' && warning.message.includes('mcp__workspace__calendar_list')), '纯删除：catalog-removal-only 告警带工具名')
  check(!afterRemoval.warnings.some((warning) => warning.kind === 'catalog-generated'), '纯删除：没有 catalog-generated 成功记录')
  const lastDeny = restrictionLog.at(-1) ?? []
  check(!lastDeny.includes('mcp__workspace__calendar_list'), '纯删除：restriction 的 deny 不残留已移除工具')
  // 空闲会话的下一次 prompt 是现场触发点（agent/inbox/claimed → ensureEnrichment）：
  // needsEnrichment 必须已是 false，不能把生成补起来（否则 50 分钟一次的 prompt 会继续空跑）。
  emit('agent/inbox/claimed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  eq(generationStarts, 1, '纯删除后下一次 prompt 不会补起生成（needsEnrichment=false）')

  // ── 场景 2：连续两次变化（两次 tools/change）只生成一次，且用稳定快照 ────────
  toolDefs = [...toolDefs, { name: 'mcp__workspace__tasks_list', description: 'List tasks' }]
  emit('tools/change')
  toolDefs = [...toolDefs, { name: 'mcp__workspace__tasks_create', description: 'Create a task' }]
  emit('tools/change')
  const pendingAddition = await snapshot()
  eq(pendingAddition.generation.stabilize.pending, true, '连续变化：两次事件合并到同一稳定窗口')
  eq(pendingAddition.catalog.total, 6, '连续变化：窗口内目录仍是上一版')
  const duringAdditionSearch = await removalSearch.execute({ query: 'tasks' }, { agent })
  check(String(duringAdditionSearch).startsWith('No deferred tool matches'), '稳定窗口：窗口内 search_tools 搜不到新工具（已评估的可接受副作用）')
  await waitFor(async () => (await snapshot()).generation.runs >= 2 && (await snapshot()).catalog.source === 'agent', '稳定后新增生成完成')
  const afterAddition = await snapshot()
  eq(generationStarts, 2, '连续两次变化：只启动一次生成（合并批次）')
  eq(afterAddition.catalog.source, 'agent', '新增：生成成功后 source=agent')
  eq(afterAddition.catalog.total, 8, '新增：稳定快照含两次变化的两个新工具（8 个工具）')
  eq(afterAddition.catalog.groups.length, 6, '新增：分组覆盖两个新工具')

  // ── 场景 3：说明变化也在窗口结算后静默刷新 ───────────────────────────────
  const beforeDescription = await snapshot()
  toolDefs = toolDefs.map((entry) => (entry.name === 'browser_open'
    ? { ...entry, description: 'Open a browser page in kiosk mode' }
    : entry))
  emit('tools/change')
  const pendingDescription = await snapshot()
  eq(pendingDescription.generation.stabilize.pending, true, '说明变化：同样走稳定窗口')
  const duringDescriptionSearch = await removalSearch.execute({ query: 'kiosk' }, { agent })
  check(String(duringDescriptionSearch).startsWith('No deferred tool matches'), '稳定窗口：说明刷新前按新说明搜不到（已评估的可接受副作用）')
  await waitSettled()
  const afterDescription = await snapshot()
  eq(generationStarts, 2, '说明变化：不启动生成')
  eq(afterDescription.generation.runs, beforeDescription.generation.runs, '说明变化：generation.runs 不增加')
  eq(afterDescription.generation.lastOkAt, beforeDescription.generation.lastOkAt, '说明变化：lastOkAt 不变')
  eq(afterDescription.generation.descriptionRefreshes, beforeDescription.generation.descriptionRefreshes + 2, '说明变化：两个会话各静默刷新一次（descriptionRefreshes +2）')
  eq(afterDescription.generation.removalOnlySkips, beforeDescription.generation.removalOnlySkips, '说明变化：不计为纯删除跳过')
  eq(afterDescription.catalog.source, beforeDescription.catalog.source, '说明变化：目录来源不变')
  check(!afterDescription.warnings.some((warning) => warning.kind === 'catalog-removal-only'), '说明变化：不新增 removal-only 告警')
  const kioskResult = await removalSearch.execute({ query: 'kiosk' }, { agent })
  check(String(kioskResult).includes('browser_open'), '说明变化：结算后 search_tools 能按新说明命中工具')

  // 恢复会话（未激活、needsEnrichment）在稳定窗口结算后被补上同指纹缓存目录——
  // 这是 resumeDeferredEnrichment 的回归：没有它，结算后的 rebuild 会走早退分支而错过补发。
  const restoredSnapshot = JSON.parse(await removalStatus.execute({}, { agent: restoredAgent }))
  eq(restoredSnapshot.catalog.source, 'agent', '结算后补发：恢复会话拿到同指纹缓存目录（source=agent）')
  eq(generationStarts, 2, '结算后补发：复用缓存，不额外生成')

  delete globalThis[SHARED_KEY]
  delete globalThis[REGISTRY_KEY]
}


console.log('== 目录缓存淘汰（catalogs 条数上限）==')
{
  const { createCatalogStore } = await import(pathToFileURL(join(PLUGIN_DIR, 'store.js')).href)
  const tables = { catalogs: new Map(), state: new Map() }
  const fakeDomain = {
    table(name) {
      const records = tables[name]
      if (records === undefined) throw new Error(`unknown table ${name}`)
      return {
        entries: () => records.entries(),
        get: (key) => records.get(key),
        put: async (key, value) => { records.set(key, value) },
        delete: async (key) => { records.delete(key) },
      }
    },
    close() {},
  }
  const makeCtx = () => ({
    get(name) { return name === 'storageDomain' ? { open: async () => fakeDomain } : undefined },
    effect(fn) { fn() },
    logger: { warn() {} },
  })
  const makeShared = () => ({ groups: new Map(), catalogTimes: new Map(), catalogCache: new Map(), lastGood: null, failures: new Map() })
  const shared = makeShared()
  const store = createCatalogStore(makeCtx(), shared, { warn() {} }, { maxEntries: 3 })
  eq(await store.whenReady(), true, 'fake storageDomain 打开成功')
  for (let index = 0; index < 5; index += 1) {
    store.saveGroups(`fp-${index}`, [{ id: `group-${index}`, description: 'g', tools: [] }])
  }
  await new Promise((resolve) => setTimeout(resolve, 30))
  eq([...shared.groups.keys()].sort().join(','), 'fp-2,fp-3,fp-4', '内存 groups 按 createdAt 只保留最新 maxEntries 个')
  eq([...tables.catalogs.keys()].sort().join(','), 'fp-2,fp-3,fp-4', '官方 Storage catalogs 同步淘汰最旧指纹')
  eq(store.info.evicted, 2, 'evicted 计数')
  eq(store.status().entries, 3, 'status.entries 报告当前条数')
  eq(store.status().maxEntries, 3, 'status.maxEntries 报告上限')
  const sharedAfterRestart = makeShared()
  const reopened = createCatalogStore(makeCtx(), sharedAfterRestart, { warn() {} }, { maxEntries: 3 })
  await reopened.whenReady()
  eq([...sharedAfterRestart.groups.keys()].sort().join(','), 'fp-2,fp-3,fp-4', '重启 hydrate 后仍不超过上限')
  eq(sharedAfterRestart.catalogTimes.size, 3, 'hydrate 恢复 createdAt（后续淘汰仍然有效）')
}

// 确认测试产物可重建，不进入 git（reference/tmp/ 已被 .gitignore 忽略）。
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
check(gitignore.includes('reference/tmp/'), '.gitignore 忽略 reference/tmp/')

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exit(1)
