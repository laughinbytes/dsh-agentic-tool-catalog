/**
 * store.js —— 目录持久化：只使用 DSH 官方 Storage（storageDomain）。
 *
 * 数据是派生缓存（丢了重新生成一次即可），但按用户决策统一走官方持久化：
 *   - 声明 domain `agentic-tool-catalog`（version 1）：`catalogs` 表按目录指纹存原始分组，
 *     `state` 表存最近一次成功分组（lastGood）；
 *   - 没有 `storageDomain` 服务的 profile → 纯内存缓存（功能可用，重启重新生成一次），
 *     **不做第二份文件后端**；
 *   - 写入 fire-and-forget：失败只记日志，不影响当前会话；读取在启动时 hydrate 到共享内存。
 *
 * @module @local/dsh-agentic-tool-catalog/store
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** 一个分组（模型输出的原始形状，tools 为工具名；读取时复用 generation.validateAgentGroups 校验）。 */
const groupRecord = z.object({
  id: z.string(),
  description: z.string(),
  tools: z.array(z.string()),
})

/** 按目录指纹存的一版分组。 */
const catalogRecord = z.object({
  fingerprint: z.string(),
  groups: z.array(groupRecord),
  createdAt: z.number(),
})

/** 最近一次成功分组（生成失败时保持目录连续；状态会显式标 stale，不静默）。 */
const lastGoodRecord = z.object({
  fingerprint: z.string(),
  groups: z.array(groupRecord),
  at: z.number(),
})

/** 我们的存储 domain：唯一身份/版本/schema 来源。 */
export const CATALOG_DOMAIN = defineDomain({
  name: 'agentic_tool_catalog',
  version: 1,
  tables: {
    catalogs: domainTable(catalogRecord),
    state: domainTable(lastGoodRecord),
  },
})

/**
 * 创建目录存储。
 * @param ctx - 插件 ctx（需要 `ctx.get('storageDomain')` 与 effect 生命周期）。
 * @param shared - 进程级共享状态（`groups` Map / `lastGood`）。
 * @param logger - 可选 logger。
 */
export function createCatalogStore(ctx, shared, logger) {
  const storageDomain = ctx.get?.('storageDomain')
  const info = { available: false, state: storageDomain === undefined ? 'unavailable' : 'opening', lastError: null }
  let domain
  let ready = Promise.resolve(false)

  const log = (message) => logger?.warn?.(`dsh-agentic-tool-catalog: ${message}`)

  if (storageDomain !== undefined) {
    ready = (async () => {
      try {
        domain = await storageDomain.open(CATALOG_DOMAIN)
        ctx.effect(() => () => domain.close())
        for (const [fingerprint, record] of domain.table('catalogs').entries()) {
          if (record !== undefined && Array.isArray(record.groups)) shared.groups.set(fingerprint, record.groups)
        }
        const lastGood = domain.table('state').get('lastGood')
        if (lastGood !== undefined && Array.isArray(lastGood.groups)) shared.lastGood = lastGood
        info.available = true
        info.state = 'ready'
        return true
      } catch (error) {
        info.available = false
        info.state = 'failed'
        info.lastError = String(error?.message ?? error).slice(0, 200)
        log(`官方 Storage 打开失败，使用纯内存缓存：${info.lastError}`)
        return false
      }
    })()
  }

  /** 启动时 hydrate 完成（true=官方存储可用；false=内存模式）。 */
  const whenReady = () => ready
  const available = () => info.available
  const status = () => ({ ...info })

  /** 保存一版目录分组（fire-and-forget；失败只记日志）。 */
  const saveGroups = (fingerprint, groups) => {
    shared.groups.set(fingerprint, groups)
    if (!info.available) return
    Promise.resolve()
      .then(() => domain.table('catalogs').put(fingerprint, { fingerprint, groups, createdAt: Date.now() }))
      .catch((error) => log(`目录缓存写入失败（不影响当前会话）：${String(error?.message ?? error).slice(0, 160)}`))
  }

  /** 保存最近一次成功分组（fire-and-forget）。 */
  const saveLastGood = (lastGood) => {
    shared.lastGood = lastGood
    if (!info.available) return
    Promise.resolve()
      .then(() => domain.table('state').put('lastGood', lastGood))
      .catch((error) => log(`最近成功分组写入失败（不影响当前会话）：${String(error?.message ?? error).slice(0, 160)}`))
  }

  return { whenReady, available, status, saveGroups, saveLastGood, info }
}
