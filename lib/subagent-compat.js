/**
 * subagent-compat.js —— 唯一知道宿主 `ctx.subagents.startActivation()` 入参形状的地方。
 *
 * 背景（2026-11-12 实测）：
 *   - DSH 0.2.1-rc.2 … 0.2.2-rc.1：请求字段装在 `spec.request` 里
 *     （`{ provider, label, request: { parent, prompt, maxDepth, outputSchema, ... }, signal, delivery }`）；
 *   - DSH 0.2.2-rc.2+：同一组字段被拍平到 spec 顶层，`startActivation` 直接读 `spec.parent.id`。
 *
 * 兼容策略：同时发送两种形状。
 *   - 顶层字段服务 0.2.2-rc.2+；
 *   - 不可枚举的 `request` 属性服务旧版（旧版只做属性读取 `spec.request`，仍可访问）；
 *   - 不可枚举很重要：rc.2 的外部 provider 路径会把 spec 的剩余字段展开进 provider 请求，
 *     可枚举的 `request` 会泄漏过去；不可枚举属性不会被展开。
 *   - 两个版本的实现都只读自己认识的字段、不校验未知字段，因此并集是安全的。
 *
 * 这里是**唯一**允许出现版本形状差异的文件；其余代码只调用 `startSubagentActivation()`。
 * 契约由 `scripts/verify-subagent-compat.mjs` 用真实的
 * `@deepseek-ai/dsh-subagent@0.2.2-rc.1` / `@0.2.2-rc.2` 实现验证。
 *
 * @module @local/dsh-agentic-tool-catalog/subagent-compat
 */

/** 适配器同时支持的激活 spec 形状（用于状态观测；不代表宿主版本）。 */
export const ACTIVATION_SHAPES = Object.freeze(['flat', 'nested'])

/** 属于 `SubagentStartRequest`（随版本在顶层 / request 之间搬家的字段）。 */
export const ACTIVATION_REQUEST_FIELDS = Object.freeze([
  'cwd',
  'agentPreset',
  'prompt',
  'parent',
  'agentOptions',
  'outputSchema',
  'maxDepth',
])

/**
 * 把扁平请求构造成两种宿主都能读的 activation spec。
 * @param spec - 扁平请求（含 provider / label / signal / delivery 与 request 字段）。
 * @returns 可直接传给 `ctx.subagents.startActivation()` 的 spec。
 */
export function buildSubagentActivationSpec(spec) {
  const request = {}
  for (const key of ACTIVATION_REQUEST_FIELDS) {
    if (spec[key] !== undefined) request[key] = spec[key]
  }
  const activationSpec = {
    provider: spec.provider,
    label: spec.label,
    ...(spec.name === undefined ? {} : { name: spec.name }),
    ...(spec.childId === undefined ? {} : { childId: spec.childId }),
    // 0.2.2-rc.2+：字段在顶层。
    ...request,
    signal: spec.signal,
    delivery: spec.delivery,
  }
  // 0.2.1-rc.2 … 0.2.2-rc.1：字段在 request 里。不可枚举，避免 rc.2 的外部 provider 展开时泄漏。
  Object.defineProperty(activationSpec, 'request', {
    value: request,
    enumerable: false,
    configurable: true,
    writable: false,
  })
  return activationSpec
}

/**
 * 启动一个子代理激活，自动适配宿主的 spec 形状。
 * @param subagents - `ctx.get('subagents')` 得到的服务。
 * @param spec - 扁平请求（见 {@link ACTIVATION_REQUEST_FIELDS}）。
 * @returns `startActivation()` 的原样结果。
 */
export function startSubagentActivation(subagents, spec) {
  return subagents.startActivation(buildSubagentActivationSpec(spec))
}

/**
 * 判断一个失败是否像"宿主不认识 activation spec 形状"（而非业务/模型失败）。
 * 仅用于观测与软闸门：形状错误发生在创建子代理之前，无副作用。
 * @param error - 捕获到的错误。
 * @returns 是否匹配各版本读取缺失字段时的 TypeError。
 */
export function isActivationShapeError(error) {
  if (!(error instanceof TypeError)) return false
  const message = String(error.message ?? '')
  return /Cannot read properties of undefined \(reading '(?:id|parent|prompt|request|maxDepth|outputSchema|cwd|agentPreset|agentOptions)'\)/.test(message)
}
