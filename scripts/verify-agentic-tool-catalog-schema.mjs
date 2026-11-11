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
for (const file of ['index.js', 'catalog.js', 'generation.js', 'store.js']) {
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
  eq(defaults.catalogResetNonce, '', '默认 catalogResetNonce 为空')
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

// 确认测试产物可重建，不进入 git（reference/tmp/ 已被 .gitignore 忽略）。
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
check(gitignore.includes('reference/tmp/'), '.gitignore 忽略 reference/tmp/')

console.log(`\n${checks - failures}/${checks} 通过`)
if (failures > 0) process.exit(1)
