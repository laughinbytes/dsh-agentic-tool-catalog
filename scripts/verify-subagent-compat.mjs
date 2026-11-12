#!/usr/bin/env node
/**
 * verify-subagent-compat.mjs —— 用**真实的** `@deepseek-ai/dsh-subagent` 0.2.2-rc.1 / 0.2.2-rc.2
 * 验证 `lib/subagent-compat.js` 产出的 activation spec 能被两种宿主形状接受。
 *
 * 为什么需要：0.2.2-rc.2 把 SubagentActivationSpec 拍平，0.3.1 因此 9/9 次
 * `AGENT_FAILED: Cannot read properties of undefined (reading 'id')`。
 * 单元测试只能模拟宿主；这里直接调用两个真实版本的 `SubagentRuntime.prototype.startActivation`，
 * 证明：
 *   - 适配器同时满足 rc.1（读 spec.request）与 rc.2（读 spec.parent）；
 *   - 只有旧嵌套形状 / 只有新平铺形状时，对应版本会失败（回归锚点）；
 *   - rc.2 看不到不可枚举的 request（外部 provider 展开不会泄漏）；
 *   - 两个版本的能力检查都能看到 outputSchema（旧写法在 rc.2 下会被静默跳过）。
 *
 * 依赖：npm（首次运行安装两个版本到 reference/tmp/subagent-compat/，gitignored，可复用）。
 * 用法：node scripts/verify-subagent-compat.mjs [--refresh]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AGENT_GROUP_SCHEMA } from '../lib/generation.js'
import {
  ACTIVATION_SHAPES,
  buildSubagentActivationSpec,
  isActivationShapeError,
  startSubagentActivation,
} from '../lib/subagent-compat.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WORK = join(ROOT, 'reference', 'tmp', 'subagent-compat')
const REFRESH = process.argv.includes('--refresh')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** 兼容矩阵：键用于目录名，值是真实宿主版本。新增支持版本时在这里加一行。 */
const HOSTS = [
  { key: 'rc1', version: '0.2.2-rc.1' },
  { key: 'rc2', version: '0.2.2-rc.2' },
]

let passed = 0
let failed = 0
function check(condition, message) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

/** 安装（或复用）一个真实宿主版本的依赖树。 */
function ensureHost(host) {
  const dir = join(WORK, host.key)
  const pkgFile = join(dir, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'package.json')
  if (REFRESH) rmSync(dir, { recursive: true, force: true })
  if (existsSync(pkgFile)) {
    const installed = JSON.parse(readFileSync(pkgFile, 'utf8')).version
    if (installed === host.version) return dir
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })
  console.log(`安装真实宿主 @deepseek-ai/dsh-subagent@${host.version} → ${dir}`)
  const result = spawnSync(
    NPM,
    ['install', '--prefix', dir, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', `@deepseek-ai/dsh-subagent@${host.version}`],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    console.error(result.stdout ?? '')
    console.error(result.stderr ?? '')
    throw new Error(`npm install 失败（@deepseek-ai/dsh-subagent@${host.version}）；需要网络，或先手动准备 ${dir}`)
  }
  const installed = JSON.parse(readFileSync(pkgFile, 'utf8')).version
  if (installed !== host.version) throw new Error(`安装版本不符：期望 ${host.version}，实际 ${installed}`)
  return dir
}

/**
 * 构造一个只暴露 `startActivation` 所需字段的真实 SubagentRuntime 外壳。
 * 不启动 Cordis，也不执行 `apply`；只让真实的 startActivation 走完入参校验并落到 manager。
 */
function makeRuntime(RuntimeClass, agent, capabilityOverrides = {}) {
  const runtime = Object.create(RuntimeClass.prototype)
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true, ...capabilityOverrides },
    inheritsParentContext: false,
    prepareContinuable: async () => ({}),
  }
  const calls = []
  runtime.providers = new Map([['spawn', provider]])
  runtime.manager = {
    startLocal(spec) {
      calls.push({ kind: 'local', spec })
      return Promise.resolve({ kind: 'local' })
    },
    startExternal(spec) {
      calls.push({ kind: 'external', spec })
      return Promise.resolve({ kind: 'external' })
    },
  }
  runtime.ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => (id === agent.id ? agent : undefined) }
      return undefined
    },
  }
  return { runtime, calls }
}

/** 插件真实使用的扁平请求。 */
function pluginRequest(agent) {
  return {
    provider: 'spawn',
    label: 'agentic-tool-catalog generation',
    parent: agent,
    prompt: [{ type: 'text', text: 'catalog grouping test' }],
    maxDepth: 1,
    outputSchema: AGENT_GROUP_SCHEMA,
    signal: new AbortController().signal,
    delivery: 'caller',
  }
}

const agent = { id: 'session-parent-test' }

console.log('== 准备真实宿主版本 ==')
const runtimes = new Map()
for (const host of HOSTS) {
  const dir = ensureHost(host)
  const module = await import(pathToFileURL(join(dir, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'index.js')).href)
  check(typeof module.SubagentRuntime === 'function', `${host.version} 导出真实 SubagentRuntime`)
  runtimes.set(host.key, { version: host.version, Runtime: module.SubagentRuntime })
}

console.log(`== 适配器形状（${ACTIVATION_SHAPES.join(' + ')}）==`)
check(ACTIVATION_SHAPES.join('+') === 'flat+nested', '适配器声明 flat+nested 两种形状')
for (const [key, { version, Runtime }] of runtimes) {
  const { runtime, calls } = makeRuntime(Runtime, agent)
  const fakeService = {
    startActivation: (activationSpec) => Runtime.prototype.startActivation.call(runtime, activationSpec),
  }
  let result
  try {
    result = await startSubagentActivation(fakeService, pluginRequest(agent))
  } catch (error) {
    check(false, `${version} 接受适配器 spec：${error.message}`)
    continue
  }
  check(result?.kind === 'local' && calls.length === 1, `${version} 接受适配器 spec 并进入 manager.startLocal`)
  const forwarded = calls[0]?.spec
  if (key === 'rc1') {
    check(forwarded?.request?.parent === agent, '0.2.2-rc.1 从 spec.request 读到 parent')
    check(forwarded?.request?.maxDepth === 1 && forwarded?.request?.outputSchema === AGENT_GROUP_SCHEMA, '0.2.2-rc.1 从 spec.request 读到 maxDepth/outputSchema')
  } else {
    check(forwarded?.parent === agent, '0.2.2-rc.2 从 spec.parent 读到 parent')
    check(forwarded?.maxDepth === 1 && forwarded?.outputSchema === AGENT_GROUP_SCHEMA, '0.2.2-rc.2 从顶层读到 maxDepth/outputSchema')
    check(!Object.keys(forwarded).includes('request'), '0.2.2-rc.2 的 spec 顶层没有可枚举 request（外部 provider 不会收到它）')
    check(forwarded?.request?.parent === agent, '0.2.2-rc.2 仍可属性读取 spec.request（旧版兼容面保留）')
  }
}

console.log('== 回归锚点：单一形状在另一版本上必须失败 ==')
for (const [key, { version, Runtime }] of runtimes) {
  const flatOnly = { ...pluginRequest(agent) }
  delete flatOnly.request
  const nestedOnly = {
    provider: 'spawn',
    label: 'nested-only',
    request: {
      parent: agent,
      prompt: [{ type: 'text', text: 'x' }],
      maxDepth: 1,
      outputSchema: AGENT_GROUP_SCHEMA,
    },
    signal: new AbortController().signal,
    delivery: 'caller',
  }
  const candidate = key === 'rc1' ? flatOnly : nestedOnly
  const { runtime } = makeRuntime(Runtime, agent)
  try {
    await Runtime.prototype.startActivation.call(runtime, candidate)
    check(false, `${version} 对单一形状不应成功（说明回归锚点失效）`)
  } catch (error) {
    check(isActivationShapeError(error), `${version} 对单一形状抛出可识别的形状错误：${error.message}`)
  }
}

console.log('== 能力检查覆盖（outputSchema）==')
for (const [key, { version, Runtime }] of runtimes) {
  const { runtime } = makeRuntime(Runtime, agent, { outputSchema: false })
  try {
    await Runtime.prototype.startActivation.call(runtime, buildSubagentActivationSpec(pluginRequest(agent)))
    check(false, `${version} 应在 provider 缺少 outputSchema 能力时拒绝`)
  } catch (error) {
    check(String(error?.code ?? '') === 'UNSUPPORTED_CAPABILITY', `${version} 在 provider 缺少 outputSchema 能力时拒绝`)
  }
}

console.log(`\n${passed}/${passed + failed} 通过`)
if (failed > 0) {
  console.error('兼容矩阵未通过；不要把该版本发出去。')
  process.exit(1)
}
