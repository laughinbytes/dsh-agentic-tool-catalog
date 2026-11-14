/**
 * Agentic Tool Catalog —— Client 半边（v3，对齐官方 ContextMeter）。
 *
 * 座位：官方 `conversation.composer.dock`。
 * Trigger：glyph + 极小数字（按需工具数），无状态点；hover/展开使用官方
 *   `--dsw-alias-interactive-bg-hover`，尺寸/字体与官方 ContextMeter 同一套 token。
 * 面板：portal 到 body 的 fixed 浮层，样式照官方 ContextMeter：264px、12px 内边距、
 *   `--dsw-specific-menu` + `--dsw-elevation-prominent`、12/20 字号；内容只有信号——
 *   常驻/已加载/待加载三段条 + 三行图例 + 一行存储/更新时间；没有目录名堆叠、没有长文案。
 *
 * 数据：Host 只读路由 `/plugins/agentic-tool-catalog/snapshot?sessionId=<id>`。
 *
 * @module @local/dsh-agentic-tool-catalog/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-agentic-tool-catalog',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ReactDOM = (() => {
      try {
        return require('react-dom')
      } catch {
        return undefined
      }
    })()
    const NS = 'agentic-tool-catalog'
    const SNAPSHOT_ROUTE = '/plugins/agentic-tool-catalog/snapshot'
    const EVENTS_ROUTE = '/plugins/agentic-tool-catalog/events'

    const EN = {
      'dock.label': 'Agentic Tool Catalog',
      'dock.tip': 'Catalog · {freshness} · {groups} groups · {tools} on-demand tools',
      'panel.title': 'Catalog',
      'panel.close': 'Close',
      'panel.fresh.fresh': 'ready',
      'panel.fresh.refreshing': 'refreshing',
      'panel.fresh.stale': 'stale',
      'panel.fresh.bootstrap': 'initializing',
      'panel.fresh.none': 'unavailable',
      'panel.always': 'Always available',
      'panel.loaded': 'Loaded',
      'panel.pending': 'On demand',
      'panel.groups': 'groups',
      'panel.storage.storage': 'Official Storage',
      'panel.storage.memory': 'Memory only',
      'panel.storage.unavailable': 'Unavailable',
      'panel.generated': 'Catalog generated {time}',
      'panel.never': 'Catalog not generated yet',
      'panel.minutes': '{minutes}m ago',
      'panel.hours': '{hours}h ago',
      'panel.days': '{days}d ago',
      'panel.unavailable': 'Catalog status unavailable.',
    }

    const ZH = {
      'dock.label': 'Agent 工具目录',
      'dock.tip': '目录 · {freshness} · {groups} 组 · {tools} 个按需工具',
      'panel.title': '工具目录',
      'panel.close': '关闭',
      'panel.fresh.fresh': 'ready',
      'panel.fresh.refreshing': '刷新中',
      'panel.fresh.stale': '待刷新',
      'panel.fresh.bootstrap': '初始化中',
      'panel.fresh.none': '不可用',
      'panel.always': '常驻',
      'panel.loaded': '已加载',
      'panel.pending': '待加载',
      'panel.groups': '组',
      'panel.storage.storage': '官方 Storage',
      'panel.storage.memory': '仅内存',
      'panel.storage.unavailable': '不可用',
      'panel.generated': '目录生成于 {time}',
      'panel.never': '目录尚未生成',
      'panel.minutes': '{minutes} 分钟前',
      'panel.hours': '{hours} 小时前',
      'panel.days': '{days} 天前',
      'panel.unavailable': '无法读取目录状态。',
    }

    /**
     * 样式逐条对齐官方 ContextMeter.module.css（trigger / panel / bar / swatch / row）：
     * 半径、内边距、字体、行高、颜色变量都不自定义。
     */
    const CSS = [
      '.atc-root{flex:none;display:inline-flex;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.atc-trigger{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:1px 8px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer;flex:none}',
      '.atc-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '@media (hover:hover){.atc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
      '.atc-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.atc-glyph{flex:none;width:14px;height:14px;display:block}',
      '.atc-count{font-variant-numeric:tabular-nums;color:inherit}',
      '.atc-panel{position:fixed;z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(264px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);border:0;padding:12px;font-size:12px;line-height:20px;overflow:hidden auto}',
      '.atc-head{display:flex;align-items:center;gap:6px}',
      '.atc-title{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.atc-fresh{color:var(--dsw-alias-label-tertiary)}',
      '.atc-fresh[data-state="refreshing"]{color:var(--dsw-alias-state-warn-primary)}',
      '.atc-fresh[data-state="stale"]{color:var(--dsw-alias-state-warn-primary)}',
      '.atc-error{color:var(--dsw-alias-label-tertiary)}',
      '.atc-figures{margin-left:auto;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}',
      '.atc-close{flex:none;display:flex;align-items:center;justify-content:center;width:20px;height:20px;margin-left:2px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:15px;line-height:1;cursor:pointer}',
      '@media (hover:hover){.atc-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
      '.atc-bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}',
      '.atc-segment{flex:none;min-width:2px;height:100%;border-radius:1px;background:var(--meter-tint,var(--dsw-alias-label-tertiary))}',
      '.atc-colorAlways{--meter-tint:var(--dsw-alias-label-tertiary);opacity:.55}',
      '.atc-colorLoaded{--meter-tint:var(--dsw-static-blue-450)}',
      '.atc-colorPending{--meter-tint:var(--dsw-alias-border-l3)}',
      '.atc-rows{margin:6px 0 0}',
      '.atc-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:2px 0}',
      '.atc-rowLabel{color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;min-width:0}',
      '.atc-swatch{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:2px;vertical-align:baseline;background:var(--meter-tint)}',
      '.atc-rowValue{margin:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.atc-meta{display:flex;align-items:center;gap:0;margin-top:8px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@keyframes atc-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
    ].join('')

    function StyleTag() {
      return h('style', { key: 'atc-css' }, CSS)
    }

    const num = (value) => Number(value ?? 0)

    /** 目录 glyph：带索引行的卡片 + 右上角 agent spark；与插件 icon 同一套形状。 */
    function glyph() {
      return h(
        'svg',
        { className: 'atc-glyph', viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M1.6 3.6h6.9M1.6 6.9h6.9M1.6 10.2h4.5' }),
        h('path', { d: 'M11.3 1.3l.62 1.56 1.56.62-1.56.62-.62 1.56-.62-1.56L9.12 3.48l1.56-.62z', fill: 'currentColor', stroke: 'none', opacity: 0.95 }),
      )
    }

    function ago(ms, t) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return t('panel.never')
      const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000))
      if (minutes < 60) return t('panel.minutes', { minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('panel.hours', { hours })
      return t('panel.days', { days: Math.floor(hours / 24) })
    }

    function statusLabel(snapshot, t) {
      const kind = snapshot?.catalog?.freshness ?? 'none'
      const key = `panel.fresh.${kind}`
      const value = t(key)
      return value === key ? kind : value
    }


    function CatalogDock(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const [open, setOpen] = React.useState(false)
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const readSnapshot = React.useCallback(async () => {
        if (sessionId === undefined) return
        try {
          const response = await fetch(`${SNAPSHOT_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`http ${response.status}`)
          const body = await response.json()
          setSnapshot(body?.snapshot ?? null)
          setError(false)
        } catch {
          setError(true)
        }
      }, [sessionId])

      // 首屏只取一次（dock 的工具数/状态）；之后由 SSE 推送，不做轮询。
      React.useEffect(() => {
        if (sessionId !== undefined) readSnapshot()
      }, [sessionId, readSnapshot])

      // 面板打开时建立 SSE：Host 在目录/会话状态变化时推送完整快照；关闭即断开。
      React.useEffect(() => {
        if (!open || sessionId === undefined) return undefined
        let source
        try {
          source = new EventSource(`${EVENTS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)
        } catch {
          readSnapshot()
          return undefined
        }
        const onSnapshot = (event) => {
          try {
            const body = JSON.parse(event.data)
            setSnapshot(body?.snapshot ?? null)
            setError(false)
          } catch {}
        }
        source.addEventListener('snapshot', onSnapshot)
        source.onerror = () => {
          // SSE 断开：关闭连接并退化为一次普通快照读取（不恢复轮询）。
          try { source.close() } catch {}
          setError(true)
          readSnapshot()
        }
        return () => {
          source.removeEventListener('snapshot', onSnapshot)
          try { source.close() } catch {}
        }
      }, [open, sessionId, readSnapshot])

      const reposition = React.useCallback(() => {
        const el = triggerRef.current
        if (el === null) return
        const rect = el.getBoundingClientRect()
        const width = 264
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
        setAnchor({ left, bottom: Math.max(8, window.innerHeight - rect.top + 8) })
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        reposition()
        const onDown = (event) => {
          const target = event.target
          if (triggerRef.current?.contains(target) === true) return
          if (panelRef.current?.contains(target) === true) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey)
        window.addEventListener('resize', reposition)
        return () => {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', reposition)
        }
      }, [open, reposition])

      if (sessionId === undefined || (snapshot === null && !error)) return null

      const catalog = snapshot?.catalog
      const tools = num(catalog?.total)
      const resident = num(catalog?.resident)
      const groups = Array.isArray(catalog?.groups) ? catalog.groups.length : 0
      const loaded = Array.isArray(snapshot?.session?.loaded) ? snapshot.session.loaded.length : 0
      const pending = Math.max(0, tools - loaded)
      const freshness = error ? 'none' : (catalog?.freshness ?? 'none')
      const tip = error
        ? t('panel.unavailable')
        : t('dock.tip', { freshness: statusLabel(snapshot, t), groups, tools })
      const trigger = h(
        'button',
        {
          ref: triggerRef,
          type: 'button',
          className: 'atc-trigger',
          'aria-label': t('dock.label'),
          'aria-expanded': open,
          title: tip,
          onClick: () => setOpen((value) => !value),
        },
        glyph(),
        h('span', { className: 'atc-count' }, error ? '!' : String(tools)),
      )

      if (!open) {
        return h('div', { className: 'atc-root' }, h(StyleTag, { key: 'style' }), trigger)
      }

      const total = Math.max(1, resident + tools)
      const percent = (value) => `${(value / total) * 100}%`
      const panel = h(
        'div',
        {
          ref: panelRef,
          className: 'atc-panel',
          role: 'dialog',
          'aria-label': t('panel.title'),
          style: anchor === null ? { visibility: 'hidden', left: 8, bottom: 8 } : { left: anchor.left, bottom: anchor.bottom },
        },
        h(
          'div',
          { className: 'atc-head' },
          h('span', { className: 'atc-title' }, t('panel.title')),
          h('span', { className: 'atc-fresh', 'data-state': freshness }, statusLabel(snapshot, t)),
          h('span', { className: 'atc-figures' }, `${groups} ${t('panel.groups')}`),
          h('button', { type: 'button', className: 'atc-close', 'aria-label': t('panel.close'), onClick: () => setOpen(false) }, '×'),
        ),
        error
          ? h('div', { className: 'atc-error' }, t('panel.unavailable'))
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'atc-bar', role: 'img', 'aria-label': `${resident} ${t('panel.always')} · ${loaded} ${t('panel.loaded')} · ${pending} ${t('panel.pending')}` },
                resident > 0 ? h('div', { className: 'atc-segment atc-colorAlways', style: { width: percent(resident) } }) : null,
                loaded > 0 ? h('div', { className: 'atc-segment atc-colorLoaded', style: { width: percent(loaded) } }) : null,
                pending > 0 ? h('div', { className: 'atc-segment atc-colorPending', style: { width: percent(pending) } }) : null,
              ),
              h(
                'dl',
                { className: 'atc-rows' },
                h('div', { className: 'atc-row' }, h('dt', { className: 'atc-rowLabel' }, h('i', { className: 'atc-swatch atc-colorAlways' }), t('panel.always')), h('dd', { className: 'atc-rowValue' }, String(resident))),
                h('div', { className: 'atc-row' }, h('dt', { className: 'atc-rowLabel' }, h('i', { className: 'atc-swatch atc-colorLoaded' }), t('panel.loaded')), h('dd', { className: 'atc-rowValue' }, String(loaded))),
                h('div', { className: 'atc-row' }, h('dt', { className: 'atc-rowLabel' }, h('i', { className: 'atc-swatch atc-colorPending' }), t('panel.pending')), h('dd', { className: 'atc-rowValue' }, String(pending))),
              ),
              h(
                'div',
                { className: 'atc-meta' },
                typeof snapshot?.generation?.lastOkAt === 'number' && Number.isFinite(snapshot.generation.lastOkAt)
                  ? t('panel.generated', { time: ago(snapshot.generation.lastOkAt, t) })
                  : t('panel.never'),
              ),
            ),
      )

      if (ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function') {
        return h(React.Fragment, null, h(StyleTag, { key: 'style' }), h('div', { className: 'atc-root' }, trigger), ReactDOM.createPortal(panel, document.body))
      }
      return h(
        'div',
        { className: 'atc-root', style: { position: 'relative' } },
        h(StyleTag, { key: 'style' }),
        trigger,
        h('div', { style: { position: 'absolute', right: 0, bottom: 'calc(100% + 8px)' } }, panel),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'agentic-tool-catalog: dictionaries')
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'agentic-tool-catalog-status',
              order: 20,
              locale: NS,
            },
            CatalogDock,
          ),
        )
      } catch (error) {
        try {
          console.error('[agentic-tool-catalog] client apply failed (degraded, boot kept healthy):', error)
        } catch {}
      }
    }

    return { inject, apply }
  },
})
