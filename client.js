/*
 * Browser half of dsh-desktop-view: a "Desktop" tab in the right sidebar
 * (also offered in the sidebar's guide) and a button in the session header
 * that opens and closes it.
 *
 * Plain JavaScript in DSH's Client module format (no build step). React
 * comes from the page's module table. The stream itself is handled by the
 * viewer module the Host half serves at desktop-view/core.js, the same one
 * the full-screen page uses; it is loaded when a tab first becomes visible.
 * Styles use only the host theme tokens (--dsw-*).
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
      'guide.description': 'Watch the agent\'s computer live and take control when it needs a hand.',
      'header.toggle': 'Show or hide the agent\'s desktop',
      'status.connecting': 'Connecting…',
      'status.watching': 'Watching',
      'status.watchingOther': 'Watching · controlled in another view',
      'status.control': 'You are in control',
      'status.error': 'Desktop stream unavailable',
      'status.unsupported': 'This browser cannot decode the desktop stream (it needs WebCodecs H.264).',
      'action.take': 'Take control',
      'action.give': 'Give back',
      'action.keyboard': 'Keyboard',
      'action.fullscreen': 'Open full screen',
      'action.retry': 'Retry',
      'ended.idle': 'Control returned to watching after a while without input.',
      'ended.replaced': 'Control moved to another view.',
      'ended.disconnected': 'The view disconnected, so control returned to watching.',
      'ended.stopped': 'The desktop view stopped.',
    }
    const zh = {
      title: '桌面',
      'guide.description': '实时查看智能体的电脑，需要时接管控制。',
      'header.toggle': '显示或隐藏智能体的桌面',
      'status.connecting': '正在连接…',
      'status.watching': '观看中',
      'status.watchingOther': '观看中 · 另一个窗口正在控制',
      'status.control': '你正在控制',
      'status.error': '桌面画面暂时不可用',
      'status.unsupported': '这个浏览器无法解码桌面画面（需要 WebCodecs H.264）。',
      'action.take': '接管控制',
      'action.give': '交还控制',
      'action.keyboard': '键盘',
      'action.fullscreen': '全屏打开',
      'action.retry': '重试',
      'ended.idle': '一段时间没有操作，已回到观看模式。',
      'ended.replaced': '控制已转到另一个窗口。',
      'ended.disconnected': '连接中断，已回到观看模式。',
      'ended.stopped': '桌面查看器已停止。',
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
.ddv-stage[data-control=true]{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-warning-primary,#d29922)}
.ddv-canvas{width:100%;height:100%;display:block;object-fit:contain;touch-action:none;user-select:none;-webkit-user-select:none}
.ddv-keyboard{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;font-size:16px}
.ddv-note{position:absolute;left:12px;right:12px;bottom:12px;margin:0;padding:8px 12px;border-radius:10px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px}
.ddv-message{margin:auto;padding:16px;max-width:28em;text-align:center;color:#c8c8cc}
.ddv-header{width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
@media (hover:hover){.ddv-header:hover{background:var(--dsw-alias-interactive-bg-hover)}}
`

    /** The shared viewer module, loaded once on first use. */
    let viewerModule
    const loadViewer = () => {
      viewerModule ??= import(new URL(`${PREFIX}core.js`, document.baseURI).href)
      return viewerModule
    }

    const NOTE_MS = 6000

    function DesktopTab(props) {
      const { t, sessionId, useTabInfo } = props
      const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
      const visible = info?.tab?.visible !== false
      const canvas = useRef(null)
      const keyboard = useRef(null)
      const viewer = useRef(null)
      const [status, setStatus] = useState({ phase: 'connecting', mode: 'watch', controller: null, mine: false, ended: null })
      const [note, setNote] = useState(null)
      const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

      // Stream only while the tab is on screen; a hidden tab costs nothing.
      useEffect(() => {
        if (!visible) return undefined
        let cancelled = false
        loadViewer().then((module) => {
          if (cancelled || canvas.current === null) return
          viewer.current = module.createViewer({
            canvas: canvas.current,
            keyboard: keyboard.current,
            base: new URL(PREFIX, document.baseURI),
            sessionId: sessionId ?? null,
            onStatus: setStatus,
          })
        }, () => { if (!cancelled) setStatus(current => ({ ...current, phase: 'error' })) })
        return () => {
          cancelled = true
          viewer.current?.destroy()
          viewer.current = null
        }
      }, [visible, sessionId])

      useEffect(() => {
        if (status.ended === null) return undefined
        setNote(t(`ended.${status.ended}`))
        const timer = setTimeout(() => setNote(null), NOTE_MS)
        return () => clearTimeout(timer)
      }, [status.ended])

      const inControl = status.mode === 'control' && status.mine
      let label = t('status.connecting')
      let tone = 'idle'
      if (status.phase === 'unsupported' || status.phase === 'error') {
        label = t(`status.${status.phase}`)
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
            status.phase === 'error' && h('button', { type: 'button', className: 'ddv-btn', onClick: () => viewer.current?.retry() }, t('action.retry')),
            coarse && inControl && h('button', { type: 'button', className: 'ddv-btn', onClick: () => viewer.current?.focusKeyboard() }, t('action.keyboard')),
            h('a', { className: 'ddv-btn', href: fullscreen, target: '_blank', rel: 'noopener noreferrer' }, t('action.fullscreen')),
            h('button', {
              type: 'button',
              className: status.mode === 'control' ? 'ddv-btn' : 'ddv-btn ddv-primary',
              disabled: status.phase === 'unsupported',
              onClick: () => viewer.current?.setMode(status.mode === 'control' ? 'watch' : 'control'),
            }, status.mode === 'control' ? t('action.give') : t('action.take')))),
        h('div', { className: 'ddv-stage', 'data-control': String(inControl) },
          status.phase === 'unsupported' && h('p', { className: 'ddv-message' }, t('status.unsupported')),
          h('canvas', { ref: canvas, className: 'ddv-canvas', hidden: status.phase === 'unsupported' }),
          h('textarea', {
            ref: keyboard, className: 'ddv-keyboard', tabIndex: -1, 'aria-hidden': true,
            autoCapitalize: 'off', autoComplete: 'off', autoCorrect: 'off', spellCheck: false,
          }),
          note && h('p', { className: 'ddv-note', role: 'status' }, note)))
    }

    /** Opens the Desktop tab, or hides it when it is the one showing. */
    function HeaderButton({ t, sidebar }) {
      return h('button', {
        type: 'button',
        className: 'ddv-header',
        'aria-label': t('header.toggle'),
        title: t('header.toggle'),
        onClick: () => {
          const active = sidebar.active()
          if (sidebar.isExpanded() && active?.kind === KIND) sidebar.hide(active.id)
          else sidebar.openTab(KIND)
        },
      }, h(IconDesktop, { size: 16 }))
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
