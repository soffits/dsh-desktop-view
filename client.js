/*
 * Browser half of dsh-desktop-view: a "Desktop" tab in the right sidebar
 * (also offered in the sidebar's guide) and a button in the session header
 * that opens and closes it.
 *
 * Plain JavaScript in DSH's Client module format (no build step). React
 * comes from the page's module table. The tab shows the status bar (status,
 * Take control / Give back) over a frame with the relayed Cua viewer; the
 * status socket and the frame are driven by desktop-view/session.js, which
 * the Host half serves and the full-screen page uses too. It is loaded when
 * a tab first becomes visible. Styles use only the host theme tokens
 * (--dsw-*), except the viewer's own dark stage.
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-view',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const NS = 'dsh-desktop-view'
    const TAB_ID = 'dsh-desktop-view'
    const KIND = 'desktop-view'
    const STYLE_ID = 'dsh-desktop-view'
    // Relative to the page, like DSH's own requests, so a sub-path deployment works.
    const PREFIX = 'desktop-view/'

    const en = {
      title: 'Desktop',
      'guide.description': 'Watch the agent\'s computer live, with sound, and take control when it needs a hand.',
      'header.toggle': 'Agent\'s desktop',
      'status.connecting': 'Connecting…',
      'status.watching': 'Watching',
      'status.watchingOther': 'Watching · controlled in another view',
      'status.control': 'You are in control',
      'status.error': 'Desktop unavailable',
      'action.take': 'Take control',
      'action.give': 'Give back',
      'action.fullscreen': 'Open full screen',
      'action.retry': 'Retry',
      'ended.idle': 'Control returned to watching after a while without input.',
      'ended.replaced': 'Control moved to another view.',
      'ended.disconnected': 'The view disconnected, so control returned to watching.',
      'ended.stopped': 'The desktop view stopped.',
      'time.locale': 'en-US',
      'notice.title': 'Desktop control',
      'notice.taken': 'You took control',
      'notice.released': 'You gave control back',
    }
    const zh = {
      title: '桌面',
      'guide.description': '实时查看智能体的电脑（含声音），需要时接管控制。',
      'header.toggle': '智能体的桌面',
      'status.connecting': '正在连接…',
      'status.watching': '观看中',
      'status.watchingOther': '观看中 · 另一个窗口正在控制',
      'status.control': '你正在控制',
      'status.error': '桌面暂时不可用',
      'action.take': '接管控制',
      'action.give': '交还控制',
      'action.fullscreen': '全屏打开',
      'action.retry': '重试',
      'ended.idle': '一段时间没有操作，已回到观看模式。',
      'ended.replaced': '控制已转到另一个窗口。',
      'ended.disconnected': '连接中断，已回到观看模式。',
      'ended.stopped': '桌面查看器已停止。',
      'time.locale': 'zh-CN',
      'notice.title': '桌面控制',
      'notice.taken': '你接管了控制',
      'notice.released': '你交还了控制',
    }

    // A monitor with a play mark: drawn for this plugin.
    function IconDesktop({ size = 16, className }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', className, 'aria-hidden': true, focusable: 'false' },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 9, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
        h('path', { d: 'M5.5 14H10.5M8 11.5V14', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
        h('path', { d: 'M6.75 5.25V8.75L9.75 7L6.75 5.25Z', fill: 'currentColor' }))
    }

    const CSS = `
.ddv-tab{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.ddv-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;flex-wrap:wrap}
.ddv-status{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary)}
.ddv-status:before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.ddv-status[data-tone=live]:before{background:var(--dsw-alias-state-success-primary,#3fb950)}
.ddv-status[data-tone=control]{color:var(--dsw-alias-state-warning-primary,#d29922)}
.ddv-status[data-tone=control]:before{background:var(--dsw-alias-state-warning-primary,#d29922)}
.ddv-status[data-tone=error]:before{background:var(--dsw-alias-state-error-primary)}
.ddv-actions{display:inline-flex;gap:6px;flex:none}
.ddv-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3));text-decoration:none}
.ddv-btn:disabled{cursor:not-allowed;opacity:.4}
@media (hover:hover){.ddv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.ddv-primary{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color,#fff);box-shadow:none}
@media (hover:hover){.ddv-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);opacity:.9}}
.ddv-stage{position:relative;flex:1;min-height:0;display:flex;background:#000}
.ddv-stage[data-control=true]{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-warning-primary,#d29922);padding:2px}
.ddv-frame{flex:1;width:100%;height:100%;border:0;display:block;background:#000}
.ddv-note{position:absolute;left:12px;right:12px;bottom:12px;margin:0;padding:8px 12px;border-radius:10px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px}
.ddv-header{box-sizing:border-box;width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px}
.ddv-header svg{width:15px;height:15px}
.ddv-header:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ddv-header:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.ddv-tooltip{display:inline-flex;align-items:safe center;gap:8px;position:fixed;z-index:100;width:max-content;box-sizing:border-box;max-width:min(50vw,calc(100vw - 24px));padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;transform:translate(-50%);animation:ddv-tooltip-in .15s var(--ds-ease-in-out)}
@keyframes ddv-tooltip-in{0%{opacity:0}}
.ddv-notice{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-turn-trigger-bg,var(--dsw-alias-markdown-code-block));color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:10px;padding:12px 16px;min-width:0}
.ddv-notice-icon{flex:none;display:inline-flex}
.ddv-notice-title{flex:none;font-size:var(--dsh-content-font-size,14px)}
.ddv-notice-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-12)}
.ddv-notice-time{flex:none;margin-left:auto;font:var(--dsw-font-xxs-12)}
@media (prefers-reduced-motion:reduce){.ddv-tooltip{animation:none}}
`

    /** The shared session module (status socket + viewer frame), loaded once on first use. */
    let sessionModule
    const loadSession = () => {
      sessionModule ??= import(new URL(`${PREFIX}session.js`, document.baseURI).href)
      return sessionModule
    }

    const NOTE_MS = 6000

    function DesktopTab(props) {
      const { t, sessionId, useTabInfo } = props
      const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
      const visible = info?.tab?.visible !== false
      const frame = useRef(null)
      const session = useRef(null)
      const [status, setStatus] = useState({ phase: 'connecting', mode: 'watch', controller: null, mine: false, ended: null })
      const [note, setNote] = useState(null)

      // The view (status socket, grant, control) lives as long as the tab
      // does; while the tab is hidden only the viewer frame is unloaded, so
      // a hidden tab streams and decodes nothing but keeps control.
      const visibleRef = useRef(visible)
      visibleRef.current = visible
      useEffect(() => {
        let cancelled = false
        loadSession().then((module) => {
          if (cancelled || frame.current === null) return
          session.current = module.createDesktopSession({
            frame: frame.current,
            base: new URL(PREFIX, document.baseURI),
            sessionId: sessionId ?? null,
            onStatus: setStatus,
          })
          if (!visibleRef.current) session.current.pause()
        }, () => { if (!cancelled) setStatus(current => ({ ...current, phase: 'error' })) })
        return () => {
          cancelled = true
          session.current?.destroy()
          session.current = null
        }
      }, [sessionId])

      useEffect(() => {
        if (visible) session.current?.resume()
        else session.current?.pause()
      }, [visible])

      useEffect(() => {
        if (status.ended === null) return undefined
        setNote(t(`ended.${status.ended}`))
        const timer = setTimeout(() => setNote(null), NOTE_MS)
        return () => clearTimeout(timer)
      }, [status.ended])

      const inControl = status.mode === 'control' && status.mine
      let label = t('status.connecting')
      let tone = 'idle'
      if (status.phase === 'error') {
        label = t('status.error')
        tone = 'error'
      } else if (status.phase === 'live') {
        label = inControl ? t('status.control') : status.controller !== null ? t('status.watchingOther') : t('status.watching')
        tone = inControl ? 'control' : 'live'
      }
      const fullscreen = new URL(`${PREFIX}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`, document.baseURI).href

      return h('section', { className: 'ddv-tab', 'aria-label': t('title') },
        h('div', { className: 'ddv-bar' },
          h('span', { className: 'ddv-status', 'data-tone': tone, role: 'status', 'aria-live': 'polite' }, label),
          h('span', { className: 'ddv-actions' },
            status.phase === 'error' && h('button', { type: 'button', className: 'ddv-btn', onClick: () => session.current?.retry() }, t('action.retry')),
            h('a', { className: 'ddv-btn', href: fullscreen, target: '_blank', rel: 'noopener noreferrer' }, t('action.fullscreen')),
            h('button', {
              type: 'button',
              className: status.mode === 'control' ? 'ddv-btn' : 'ddv-btn ddv-primary',
              onClick: () => session.current?.setMode(status.mode === 'control' ? 'watch' : 'control'),
            }, status.mode === 'control' ? t('action.give') : t('action.take')))),
        h('div', { className: 'ddv-stage', 'data-control': String(inControl) },
          h('iframe', { ref: frame, className: 'ddv-frame', title: t('title') }),
          note && h('p', { className: 'ddv-note', role: 'status' }, note)))
    }

    /**
     * The host's tooltip, rebuilt from its behaviour (the shared primitive
     * is not a module plugins may load): below its anchor, centred, after
     * 500 ms of mouse hover or at once on keyboard focus, hidden on leave,
     * blur, click and touch.
     */
    const TOOLTIP_DELAY_MS = 500
    const TOOLTIP_GAP_PX = 8
    const VIEWPORT_MARGIN_PX = 12
    function useTooltip(label) {
      const anchor = useRef(null)
      const timer = useRef(null)
      const [at, setAt] = useState(null)
      const clear = () => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = null
      }
      const show = () => {
        const element = anchor.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        setAt({ left: rect.left + rect.width / 2, top: rect.bottom + TOOLTIP_GAP_PX })
      }
      const hide = () => {
        clear()
        setAt(null)
      }
      useEffect(() => clear, [])
      const bubble = useRef(null)
      // Keep the bubble inside the viewport once its width is known.
      useEffect(() => {
        const element = bubble.current
        if (at === null || element === null) return
        const half = element.offsetWidth / 2
        const left = Math.min(Math.max(at.left, half + VIEWPORT_MARGIN_PX), window.innerWidth - half - VIEWPORT_MARGIN_PX)
        element.style.left = `${left}px`
        element.style.visibility = 'visible'
      }, [at])
      const handlers = {
        ref: anchor,
        onPointerEnter: (event) => {
          if (event.pointerType === 'touch') return
          if (event.pointerType === 'mouse' && !window.matchMedia('(any-hover: hover)').matches) return
          clear()
          timer.current = setTimeout(() => { timer.current = null; show() }, TOOLTIP_DELAY_MS)
        },
        onPointerLeave: hide,
        onPointerDown: (event) => { if (event.pointerType === 'touch') hide() },
        onFocus: (event) => { if (event.currentTarget.matches(':focus-visible')) show() },
        onBlur: hide,
      }
      const tip = at === null ? null : h('span', {
        ref: bubble,
        className: 'ddv-tooltip',
        role: 'tooltip',
        'data-side': 'bottom',
        style: { left: at.left, top: at.top, visibility: 'hidden' },
      }, label)
      return { handlers, tip, hide }
    }

    /** Source kind of the notes the Host half sends the agent (src/notify.js). */
    const NOTICE_SOURCE = 'desktop-view'
    const NOTICE_NODE = 'desktop-view-notice'

    /**
     * The chat row for a control note: what it is ("Desktop control"), what
     * happened, and when. It replaces the generic row DSH would show for an
     * unknown message source.
     */
    function DesktopNoticeNode({ node, t }) {
      const data = node?.data ?? {}
      const date = new Date(data.time)
      const valid = !Number.isNaN(date.getTime())
      return h('section', { className: 'ddv-notice', 'data-desktop-view-notice': data.change ?? true },
        h('span', { className: 'ddv-notice-icon', 'aria-hidden': true }, h(IconDesktop, { size: 14 })),
        h('span', { className: 'ddv-notice-title' }, t('notice.title')),
        h('span', { className: 'ddv-notice-summary' }, t(data.change === 'taken' ? 'notice.taken' : 'notice.released')),
        valid && h('time', { className: 'ddv-notice-time', dateTime: date.toISOString() },
          new Intl.DateTimeFormat(t('time.locale'), { hour: '2-digit', minute: '2-digit' }).format(date)))
    }

    /**
     * Claims the plugin's own notes in the chat timeline (exclusively, so the
     * generic input-message definition does not also render them) and turns
     * them into one `desktop-view-notice` node each.
     */
    const noticeDefinition = {
      kind: NOTICE_NODE,
      target: 'chat',
      match: event => event.type === 'user/message' && event.surfaceOp === 'append' && event.data?.source?.kind === NOTICE_SOURCE
        ? { id: String(event.data.id), role: 'start', exclusive: true }
        : null,
      start: (_context, match) => ({
        seq: match.event.seq,
        time: match.event.time,
        change: match.event.data.source.change === 'taken' ? 'taken' : 'released',
      }),
      update: context => context.state,
      buildViewNode: context => context.state === undefined ? null : {
        key: context.key,
        kind: NOTICE_NODE,
        id: context.id,
        target: 'chat',
        anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        data: context.state,
      },
    }

    /** Opens the Desktop tab, or hides it when it is the one showing. */
    function HeaderButton({ t, sidebar }) {
      const label = t('header.toggle')
      const { handlers, tip, hide } = useTooltip(label)
      return h(React.Fragment, null,
        h('button', {
          ...handlers,
          type: 'button',
          className: 'ddv-header',
          'aria-label': label,
          onClick: () => {
            hide()
            const active = sidebar.active()
            if (sidebar.isExpanded() && active?.kind === KIND) sidebar.hide(active.id)
            else sidebar.openTab(KIND)
          },
        }, h(IconDesktop, { size: 16 })),
        tip)
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [ctx.locale.register(NS, 'en', en), ctx.locale.register(NS, 'zh', zh)]
          return () => { for (const dispose of disposers) dispose() }
        }, 'desktop-view: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {}
          const tag = document.createElement('style')
          tag.id = STYLE_ID
          tag.dataset.plugin = 'dsh-desktop-view'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'desktop-view: styles')

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          priority: 'extension',
          // Hiding the tab (another tab, a collapsed sidebar, another session)
          // must not end the view: control lasts until Give back, idle or close.
          keepMounted: true,
          title: () => t('title'),
          guide: [{
            id: 'desktop',
            order: 40,
            title: () => t('title'),
            description: () => t('guide.description'),
            icon: IconDesktop,
          }],
        }), 'desktop-view: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: sessionId => ({ t, sessionId }),
        }, DesktopTab))

        // Chat rows for the control notes; absent in hosts without the Conversation layer.
        ctx.inject(['uiConversation'], (sub) => {
          sub.effect(() => sub.uiConversation.events.register(noticeDefinition), 'desktop-view: notice rows')
        })
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node',
          key: NOTICE_NODE,
          locale: NS,
          inject: () => ({ t }),
        }, DesktopNoticeNode))

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'desktop-view',
          order: 20,
          locale: NS,
          inject: () => ({ t, sidebar: ctx.sidebarRight }),
        }, HeaderButton))
      },
    }
  },
})
