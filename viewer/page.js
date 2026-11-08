/**
 * The full-screen page: the same status bar as the sidebar tab (status,
 * Take control / Give back) over the relayed desktop viewer. It fits any
 * screen and can be linked directly. `?control=1` opens it straight in
 * control mode (the agent sends the owner such a link when it needs a
 * hand); `?session=<id>` names the DSH session to tell when control changes.
 *
 * Text is in English or Chinese, following the browser's language. The
 * sidebar tab in the DSH Web UI has its own dictionary in client.js,
 * registered with DSH's locale service.
 */
import { createDesktopSession } from './session.js'

const TEXT = {
  en: {
    title: 'Desktop',
    connecting: 'Connecting…',
    watching: 'Watching',
    watchingOther: 'Watching · controlled in another view',
    control: 'You are in control',
    error: 'The desktop is unavailable. Retrying…',
    take: 'Take control',
    give: 'Give back',
    retry: 'Retry',
    'ended.idle': 'Control returned to watching after a while without input.',
    'ended.replaced': 'Control moved to another view.',
    'ended.stopped': 'The desktop view stopped.',
  },
  zh: {
    title: '桌面',
    connecting: '正在连接…',
    watching: '观看中',
    watchingOther: '观看中 · 另一个窗口正在控制',
    control: '你正在控制',
    error: '桌面暂时不可用，正在重试…',
    take: '接管控制',
    give: '交还控制',
    retry: '重试',
    'ended.idle': '一段时间没有操作，已回到观看模式。',
    'ended.replaced': '控制已转到另一个窗口。',
    'ended.stopped': '桌面查看器已停止。',
  },
}

const lang = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
const t = key => TEXT[lang][key] ?? TEXT.en[key] ?? key
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
document.title = t('title')

const params = new URLSearchParams(location.search)
const statusEl = document.getElementById('status')
const toggle = document.getElementById('toggle')
const retry = document.getElementById('retry')
const stage = document.getElementById('stage')
const message = document.getElementById('message')

// Drop the one-off parameters so a reload does not take control again.
if (params.has('control') || params.has('bounced')) {
  const clean = new URLSearchParams(params)
  clean.delete('control')
  clean.delete('bounced')
  history.replaceState(null, '', `${location.pathname}${clean.size > 0 ? `?${clean}` : ''}`)
}

/** How long a note about control ending stays on screen. */
const NOTE_MS = 6000
let current = 'watch'
let shownEnded = null
let noteTimer

const render = (status) => {
  current = status.mode
  const inControl = status.mode === 'control' && status.mine
  let label = t('connecting')
  let tone = 'idle'
  if (status.phase === 'error') {
    label = t('error')
    tone = 'error'
  } else if (status.phase === 'live') {
    label = inControl ? t('control') : status.controller !== null ? t('watchingOther') : t('watching')
    tone = inControl ? 'control' : 'live'
  }
  statusEl.textContent = label
  statusEl.dataset.tone = tone
  toggle.textContent = status.mode === 'control' ? t('give') : t('take')
  toggle.dataset.control = String(status.mode === 'control')
  retry.hidden = status.phase !== 'error'
  stage.dataset.control = String(inControl)
  if (status.ended !== shownEnded) {
    shownEnded = status.ended
    const note = status.ended === null ? undefined : TEXT[lang][`ended.${status.ended}`]
    if (note !== undefined) {
      clearTimeout(noteTimer)
      message.textContent = note
      message.hidden = false
      noteTimer = setTimeout(() => { message.hidden = true }, NOTE_MS)
    }
  }
}

retry.textContent = t('retry')
const session = createDesktopSession({
  frame: document.getElementById('viewer'),
  base: new URL('./', location.href),
  sessionId: params.get('session'),
  mode: params.get('control') === '1' ? 'control' : 'watch',
  onStatus: render,
})
toggle.addEventListener('click', () => session.setMode(current === 'control' ? 'watch' : 'control'))
retry.addEventListener('click', () => session.retry())
addEventListener('pagehide', () => session.destroy())
// A page restored from the back-forward cache has a closed session.
addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })
