/**
 * generation-queue.js —— 进程级目录生成调度器（全局限流 + 跨会话去重 + 预热节流）。
 *
 * 为什么需要（2026-11-16 实测）：一次生成是一个**真实 DSH 子代理会话**，成本是秒级到分钟级。
 * index.js 原来的单飞只按 fingerprint（`shared.inflight`）去重，而不同 session/preset/工具集
 * 会得到不同 fingerprint；工具集快速变化时，每个新 fingerprint 都立刻起一个子代理，
 * 现场出现 7 个 catalog generation 子代理并发、而且每个 session 各自预热一批。
 *
 * 语义：
 *   - 同一 key（fingerprint）的活动/排队请求合并，调用方共享同一个结果；
 *   - 全局最多 `maxConcurrent` 个活动生成（默认 1，进程级），超出的进入 pending；
 *   - pending 最多 `maxPending` 个（默认与 maxConcurrent 相同）：超出时**最新的请求保留**，
 *     最旧的 pending 以 {@link SKIP_GENERATION} 结束——调用方保持 needsEnrichment，等下一次
 *     prompt/search 再试，避免为过期工具集排出一长串子代理；
 *   - 预热（prewarm）只在空闲时启动；有活动/排队请求时直接 SKIP，恢复会话的首个 prompt/search
 *     会以按需（非 prewarm）方式补上。
 *
 * 调度器本身不执行生成、不抓错误：任务抛错时 request() 的 Promise reject，由调用方处理。
 *
 * @module @local/dsh-agentic-tool-catalog/generation-queue
 */

/** request() 的返回值：本次没有启动（全局忙/预热被节流/被更新的请求替换）。 */
export const SKIP_GENERATION = Symbol('agentic-tool-catalog/generation-skipped')

const clampInt = (value, fallback, min, max) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

/**
 * 创建（或热更配置）一个进程级生成调度器。
 * @param options - `{ maxConcurrent, maxPending }`；都会被夹到合理范围。
 * @returns 调度器：`request(key, run, options?)` / `configure()` / `status()`。
 */
export function createGenerationQueue(options = {}) {
  let maxConcurrent = clampInt(options.maxConcurrent, 1, 1, 4)
  let maxPending = clampInt(options.maxPending ?? maxConcurrent, maxConcurrent, 1, 8)
  /** key -> 正在跑的 job；Map 保持启动顺序，便于 status 观测。 */
  const active = new Map()
  /** key -> 等待中的 job；Map 保持 FIFO，溢出时淘汰最旧的。 */
  const pending = new Map()
  let started = 0
  let joined = 0
  let skipped = 0

  const settle = (job, outcome) => {
    if (active.get(job.key) === job) active.delete(job.key)
    if (outcome.ok) job.resolve(outcome.value)
    else job.reject(outcome.error)
    pump()
  }

  const start = (job) => {
    active.set(job.key, job)
    started += 1
    Promise.resolve()
      .then(job.run)
      .then((value) => settle(job, { ok: true, value }), (error) => settle(job, { ok: false, error }))
  }

  const pump = () => {
    while (active.size < maxConcurrent && pending.size > 0) {
      const [key, job] = pending.entries().next().value
      pending.delete(key)
      start(job)
    }
  }

  const dropOldestPending = () => {
    const oldestKey = pending.keys().next().value
    const dropped = pending.get(oldestKey)
    pending.delete(oldestKey)
    skipped += 1
    dropped.resolve(SKIP_GENERATION)
  }

  /**
   * 请求一次生成。
   * @param key - 去重键（index.js 用目录 fingerprint）。
   * @param run - 真正启动生成的函数（无参；返回值/异常原样透传给调用方）。
   * @param requestOptions - `{ prewarm }`；预热在全局忙时直接跳过。
   * @returns 生成本身的 Promise，或立即 resolve 为 {@link SKIP_GENERATION}。
   */
  const request = (key, run, requestOptions = {}) => {
    const running = active.get(key)
    if (running !== undefined) {
      joined += 1
      return running.promise
    }
    const queued = pending.get(key)
    if (queued !== undefined) {
      joined += 1
      return queued.promise
    }
    if (requestOptions.prewarm === true && (active.size > 0 || pending.size > 0)) {
      skipped += 1
      return Promise.resolve(SKIP_GENERATION)
    }
    const job = { key, run, promise: undefined, resolve: undefined, reject: undefined }
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    if (active.size < maxConcurrent && pending.size === 0) start(job)
    else {
      pending.set(key, job)
      while (pending.size > maxPending) dropOldestPending()
    }
    return job.promise
  }

  /** 热更限流配置（插件 HMR 后沿用同一个进程级队列；收紧时下一次 settle 生效）。 */
  const configure = (next = {}) => {
    maxConcurrent = clampInt(next.maxConcurrent, maxConcurrent, 1, 4)
    maxPending = clampInt(next.maxPending ?? maxPending, maxPending, 1, 8)
    pump()
  }

  /** 只读观测（catalog_status 的 generation.queue 字段）。 */
  const status = () => ({
    maxConcurrent,
    maxPending,
    active: [...active.keys()],
    pending: [...pending.keys()],
    started,
    joined,
    skipped,
  })

  return { request, configure, status }
}
