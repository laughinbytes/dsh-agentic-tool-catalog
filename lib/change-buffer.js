/**
 * change-buffer.js —— `tools/change` 的稳定窗口去抖（stabilize window）。
 *
 * 背景（2026-11-24 现场实证）：一个 MCP 桥接插件（Google Workspace）每次 token 刷新会重连，
 * 重连期间把 22 个工具**逐个摘掉再逐个挂回**（约 1 秒）。DSH 因此连续发出大量 `tools/change`，
 * 目录 SSE 快照抓到 github 10→…→0、calendar 8→…→0、time 3→0 再恢复的完整序列。
 * 旧实现每个事件都 sync/生成，抓到的是中间状态：一天白跑了 21 个生成子代理
 * （16 次纯删除 + 5 次每次“多一个”）。纯删除跳过只解决其中一类；这里用“等清单稳定再算”
 * 覆盖任意桥接插件的瞬态抖动。
 *
 * 语义：
 *   - `schedule()` 收到变化事件后调用：距**最后一次**事件 windowMs 之后才触发 `onSettled()`；
 *   - 窗口期间再来事件就重置窗口；
 *   - 硬上限 maxMs：从**本批第一个事件**起算，持续抖动也必须到点结算一次（防饿死）；
 *   - 到达上限时同步结算（不再排 timer），保证上限是硬上限；
 *   - `onSettled()` 被调用时才重新读工具快照（调用方责任：不要在排期时捕获旧快照）；
 *   - `cancel()` 取消挂起窗口（插件卸载用），不结算；
 *   - 时钟与定时器可注入：单测用假时钟，生产用 `Date.now` / `setTimeout`。
 *
 * @module @local/dsh-agentic-tool-catalog/change-buffer
 */

/** 默认稳定窗口：2.5 秒（桥接插件重连抖动的典型量级是 ~1 秒，留出 DSH 侧事件落定的余量）。 */
export const DEFAULT_STABILIZE_MS = 2500
/** 默认硬上限：30 秒（持续抖动时最多等这么久必算一次，正常情况下到不了）。 */
export const DEFAULT_STABILIZE_MAX_MS = 30000

const clampInt = (value, fallback, min, max) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

/**
 * 创建稳定窗口去抖器。
 * @param options - `{ windowMs, maxMs, onSettled, now, setTimeout, clearTimeout }`。
 *   - windowMs：最后事件之后的等待窗口（毫秒）；生产上 <=0 由调用方直接禁用去抖。
 *   - maxMs：单批最长等待（毫秒），自动夹到 >= windowMs。
 *   - onSettled：窗口结算回调；调用方应在此刻重新读取工具集合（稳定快照）。
 * @returns `{ schedule, flush, cancel, status }`；`schedule()` 返回到下一次结算的毫秒数
 *   （0 表示已在本次调用里同步结算）。
 */
export function createChangeDebouncer(options = {}) {
  const windowMs = clampInt(options.windowMs, DEFAULT_STABILIZE_MS, 1, 120000)
  const maxMs = Math.max(windowMs, clampInt(options.maxMs, DEFAULT_STABILIZE_MAX_MS, windowMs, 600000))
  const onSettled = typeof options.onSettled === 'function' ? options.onSettled : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : (timer) => clearTimeout(timer)
  let timer
  let pendingSince
  let deadlineAt

  const clearPending = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    pendingSince = undefined
    deadlineAt = undefined
  }

  const settle = () => {
    clearPending()
    onSettled()
  }

  /**
   * 记录一次变化事件并重置窗口。
   * @returns 到下一次结算的毫秒数（0 = 已在本次调用内同步结算）。
   */
  const schedule = () => {
    const at = now()
    if (pendingSince === undefined) {
      pendingSince = at
      deadlineAt = at + maxMs
    }
    if (timer !== undefined) clearTimer(timer)
    const delay = Math.max(0, Math.min(windowMs, deadlineAt - at))
    if (delay === 0) {
      // 达到硬上限：同步结算，避免“事件不断、timer 永远排不上”导致饿死。
      settle()
      return 0
    }
    timer = setTimer(() => {
      // 防御：已被 cancel/flush 替换/取消的旧 timer 回调不应再结算。
      if (timer === undefined) return
      settle()
    }, delay)
    timer?.unref?.()
    return delay
  }

  /** 立即结算挂起窗口（没有挂起窗口时返回 false，不触发 onSettled）。 */
  const flush = () => {
    if (timer === undefined) return false
    settle()
    return true
  }

  /** 取消挂起窗口（不结算）；插件卸载/配置停用时调用。 */
  const cancel = () => clearPending()

  /** 只读状态（`catalog_status.generation.stabilize`）。 */
  const status = () => ({
    windowMs,
    maxMs,
    pending: timer !== undefined,
    pendingSince: pendingSince ?? null,
    deadlineAt: deadlineAt ?? null,
  })

  return { schedule, flush, cancel, status }
}
