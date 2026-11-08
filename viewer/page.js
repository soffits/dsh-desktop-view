/**
 * The full-screen viewer page: fits any screen, works with touch, and can be
 * linked directly. `?control=1` opens it straight in control mode (the
 * agent sends the owner such a link when it needs a hand); `?session=<id>`
 * names the DSH session to tell when control is given back.
 *
 * Text is in English or Chinese, following the browser's language. The
 * sidebar tab in the DSH Web UI has its own dictionary in client.js,
 * registered with DSH's locale service.
 */
import { createViewer, supported } from './core.js'

const TEXT = {
  en: {
    title: 'Desktop',
    connecting: 'Connecting…',
    watching: 'Watching',
    watchingOther: 'Watching · controlled in another view',
    control: 'You are in control',
    error: 'The desktop stream is unavailable. Retrying…',
    unsupported: 'This browser cannot decode the desktop stream (it needs WebCodecs H.264: a current Chrome, Edge, Firefox or Safari 17+).',
    take: 'Take control',
    give: 'Give back',
    keyboard: 'Keyboard',
    'ended.idle': 'Control returned to watching after a while without input.',
    'ended.replaced': 'Control moved to another view.',
    'ended.disconnected': 'The view disconnected, so control returned to watching.',
    'ended.stopped': 'The desktop view stopped.',
  },
  zh: {
    title: '桌面',
    connecting: '正在连接…',
    watching: '观看中',
    watchingOther: '观看中 · 另一个窗口正在控制',
    control: '你正在控制',
    error: '桌面画面暂时不可用，正在重试…',
    unsupported: '这个浏览器无法解码桌面画面（需要支持 WebCodecs H.264 的新版 Chrome、Edge、Firefox 或 Safari 17+）。',
    take: '接管控制',
    give: '交还控制',
    keyboard: '键盘',
    'ended.idle': '一段时间没有操作，已回到观看模式。',
    'ended.replaced': '控制已转到另一个窗口。',
    'ended.disconnected': '连接中断，已回到观看模式。',
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
const keyboardButton = document.getElementById('keyboard')
const stage = document.getElementById('stage')
const message = document.getElementById('message')
const coarse = matchMedia('(pointer: coarse)').matches

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

const showNote = (text) => {
  clearTimeout(noteTimer)
  message.textContent = text
  message.hidden = false
  noteTimer = setTimeout(() => { message.hidden = true }, NOTE_MS)
}

const render = (status) => {
  current = status.mode
  const inControl = status.mode === 'control' && status.mine
  let label = t('connecting')
  let tone = 'idle'
  if (status.phase === 'unsupported') {
    label = t('unsupported')
    tone = 'error'
  } else if (status.phase === 'error') {
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
  toggle.disabled = status.phase === 'unsupported'
  keyboardButton.hidden = !(coarse && inControl)
  stage.dataset.control = String(inControl)
  if (status.phase === 'unsupported') {
    message.textContent = t('unsupported')
    message.hidden = false
  } else if (status.ended !== shownEnded) {
    shownEnded = status.ended
    const note = status.ended === null ? undefined : TEXT[lang][`ended.${status.ended}`]
    if (note !== undefined) showNote(note)
  }
}

keyboardButton.textContent = t('keyboard')
const viewer = createViewer({
  canvas: document.getElementById('screen'),
  keyboard: document.getElementById('input'),
  base: new URL('./', location.href),
  sessionId: params.get('session'),
  mode: params.get('control') === '1' && supported() ? 'control' : 'watch',
  onStatus: render,
})
toggle.addEventListener('click', () => viewer.setMode(current === 'control' ? 'watch' : 'control'))
keyboardButton.addEventListener('click', () => viewer.focusKeyboard())
addEventListener('pagehide', () => viewer.destroy())
// A page restored from the back-forward cache has a destroyed viewer.
addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })
