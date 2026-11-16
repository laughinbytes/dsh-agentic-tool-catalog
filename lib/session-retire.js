/**
 * session-retire.js —— 生成子会话的生命周期收尾。
 *
 * 背景（2026-11-16 实测）：`ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller' })`
 * 会创建一个**真实持久化的 origin=subagent 会话**；插件此前从不清理，dsh-dev 下累积了数百个
 * catalog generation 子会话（一次观察 919 个，归档 11 个后又涨到 944 个）。
 *
 * DSH 没有删除会话的公开 API；官方生命周期是 Workspace archive：
 *   `ctx.get('workspaceRegistry').archiveSession(sessionId, { stopActivity: true })`
 * 它把会话写进全局 archive 集（从所有会话列表/分组中隐藏），并广播
 * `workspace/session-stop` 停掉残留的 turn。会话日志仍保留在磁盘（审计/排障），
 * 所以这是“收起”而不是“删除”。
 *
 * 设计约束：
 *   - 只做尽力而为：没有 workspaceRegistry、或归档失败，都不影响目录生成本身；
 *   - 不抛错进 agent-loop，只记日志并计数（由调用方汇总到 catalog_status）；
 *   - 只归档**本次生成拿到的 childId**，不猜测、不批量清理历史会话。
 *
 * @module @local/dsh-agentic-tool-catalog/session-retire
 */

/**
 * 创建生成子会话的归档器。
 * @param ctx - 插件 ctx（需要 `ctx.get('workspaceRegistry')`）。
 * @param options - `{ enabled, logger }`；`enabled=false` 时保留子会话（排障用）。
 * @returns `{ retire(childId), enabled() }`。
 */
export function createChildSessionRetirer(ctx, options = {}) {
  const enabled = options.enabled !== false
  const logger = options.logger
  let unavailableWarned = false
  let archived = 0
  let failures = 0

  const workspaceRegistry = () => {
    try {
      return ctx.get?.('workspaceRegistry')
    } catch {
      return undefined
    }
  }

  /**
   * 归档一个生成子会话。
   * @param childId - activation.childId（DSH SessionId，字符串）。
   * @returns `{ archived: boolean, reason: string }`；永不抛错。
   */
  async function retire(childId) {
    if (!enabled) return { archived: false, reason: 'disabled' }
    if (typeof childId !== 'string' || childId === '') return { archived: false, reason: 'no-child-id' }
    const registry = workspaceRegistry()
    if (registry === undefined || typeof registry.archiveSession !== 'function') {
      if (!unavailableWarned) {
        unavailableWarned = true
        logger?.warn?.('dsh-agentic-tool-catalog: workspaceRegistry.archiveSession unavailable; '
          + 'catalog generation child sessions will stay visible in session lists')
      }
      return { archived: false, reason: 'archive-unavailable' }
    }
    try {
      await registry.archiveSession(childId, { stopActivity: true })
      archived += 1
      return { archived: true, reason: 'archived' }
    } catch (error) {
      failures += 1
      logger?.warn?.(`dsh-agentic-tool-catalog: failed to archive generation child session ${childId}: `
        + String(error?.message ?? error).slice(0, 160))
      return { archived: false, reason: 'archive-failed' }
    }
  }

  return { retire, enabled: () => enabled, stats: () => ({ archived, failures }) }
}
