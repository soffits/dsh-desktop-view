/**
 * Turns mouse, touch, wheel and keyboard events on the viewer into the
 * media plane's interactive input events (rcdp wire v2). Pointer positions
 * are normalized to the shown video (0..1), so the stream's size and the
 * screen's size never have to match.
 *
 * Touch: a tap clicks, a long press right-clicks, one finger dragged past a
 * few pixels drags with the left button, two fingers scroll.
 *
 * Keyboard: a hidden textarea holds focus, so the platform's own keyboard
 * machinery (layouts, dead keys, input methods, phone keyboards) produces
 * text, which is sent as committed text. Keys that are not text (Enter,
 * arrows, function keys) and shortcuts (with Ctrl, Alt or Meta) are sent as
 * key events, letters and digits of shortcuts by their physical key.
 */

const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'CapsLock', 'ContextMenu', 'PrintScreen', 'Pause',
  'ScrollLock', 'NumLock', 'Shift', 'Control', 'Alt', 'Meta',
])
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/
const BUTTONS = ['left', 'middle', 'right']
const LONG_PRESS_MS = 550
const TAP_SLOP_PX = 10
/** Pixels a wheel "line" or "page" step is worth. */
const WHEEL_LINE_PX = 40
const WHEEL_PAGE_PX = 400

/** Modifier names on the wire. */
export function modifiers(event) {
  const out = []
  if (event.shiftKey) out.push('shift')
  if (event.ctrlKey) out.push('control')
  if (event.altKey) out.push('option')
  if (event.metaKey) out.push('command')
  return out
}

/**
 * Map one keydown or keyup to a key event, or null when the textarea's text
 * input delivers it (or nothing should be sent).
 * @param {KeyboardEvent} event
 * @param {'down' | 'up'} state
 */
export function mapKey(event, state) {
  if (event.isComposing || event.keyCode === 229) return null
  if (event.key === 'Dead' || event.key === 'Unidentified' || event.key === 'Process' || event.key === 'AltGraph') return null
  const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')
  const repeat = state === 'down' && event.repeat === true
  if (NAMED_KEYS.has(event.key) || FUNCTION_KEY.test(event.key)) {
    const modifierKey = ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)
    return { kind: 'key', key: event.key.toLowerCase(), state, modifiers: modifierKey ? [] : modifiers(event), repeat }
  }
  if (!altGraph && (event.ctrlKey || event.metaKey || event.altKey)) {
    const letter = /^Key([A-Z])$/.exec(event.code)
    const digit = /^Digit([0-9])$/.exec(event.code)
    const key = letter ? letter[1].toLowerCase() : digit ? digit[1] : event.key === ' ' ? 'space' : event.key.toLowerCase()
    return { kind: 'key', key, state, modifiers: modifiers(event), repeat }
  }
  return null
}

/** Press and release one named key. */
function tapKey(key) {
  return [
    { kind: 'key', key, state: 'down', modifiers: [], repeat: false },
    { kind: 'key', key, state: 'up', modifiers: [], repeat: false },
  ]
}

/**
 * Where on the element the video is drawn: the canvas uses
 * `object-fit: contain`, so it is letterboxed inside the element's box.
 */
export function contentRect(rect, videoWidth, videoHeight) {
  if (!videoWidth || !videoHeight || !rect.width || !rect.height) return rect
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height }
}

const clamp = value => Math.min(1, Math.max(0, value))

/**
 * Attach input handling. Events are passed to `emit` only while `enabled()`.
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {HTMLTextAreaElement} options.keyboard - Hidden textarea that takes keyboard focus.
 * @param {() => boolean} options.enabled
 * @param {(event: object) => void} options.emit
 * @returns {() => void} detach
 */
export function attachInput({ canvas, keyboard, enabled, emit }) {
  const held = new Map()
  const touches = new Map()
  let touch = null
  let pressed = null

  const point = (event) => {
    const rect = contentRect(canvas.getBoundingClientRect(), canvas.width, canvas.height)
    return { x_normalized: clamp((event.clientX - rect.left) / rect.width), y_normalized: clamp((event.clientY - rect.top) / rect.height) }
  }
  const pointer = (phase, button, at, event) => emit({ kind: 'pointer', phase, button, ...at, modifiers: event ? modifiers(event) : [] })
  const scroll = (at, dx, dy, precise) => emit({ kind: 'scroll', ...at, delta_x: dx, delta_y: dy, phase: 'none', momentum_phase: 'none', precise })

  const releaseHeld = () => {
    for (const [code, mapped] of held) emit({ ...mapped, state: 'up', repeat: false })
    held.clear()
    if (pressed !== null) {
      emit({ kind: 'pointer', phase: 'cancel', button: pressed, x_normalized: 0, y_normalized: 0, modifiers: [] })
      pressed = null
    }
  }

  const onPointerDown = (event) => {
    if (!enabled()) return
    event.preventDefault()
    if (event.pointerType === 'touch') return touchDown(event)
    canvas.setPointerCapture?.(event.pointerId)
    keyboard.focus({ preventScroll: true })
    pressed = BUTTONS[event.button] ?? 'left'
    pointer('down', pressed, point(event), event)
  }
  const onPointerMove = (event) => {
    if (!enabled()) return
    if (event.pointerType === 'touch') return touchMove(event)
    pointer('move', pressed, point(event), event)
  }
  const onPointerUp = (event) => {
    if (!enabled()) return
    if (event.pointerType === 'touch') return touchUp(event)
    const button = BUTTONS[event.button] ?? 'left'
    pointer(event.type === 'pointercancel' ? 'cancel' : 'up', button, point(event), event)
    pressed = null
  }

  const touchDown = (event) => {
    canvas.setPointerCapture?.(event.pointerId)
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (touches.size === 1) {
      const at = point(event)
      touch = { mode: 'pending', startX: event.clientX, startY: event.clientY, at, timer: setTimeout(() => {
        if (touch?.mode !== 'pending') return
        touch.mode = 'done'
        pointer('move', null, at)
        pointer('down', 'right', at)
        pointer('up', 'right', at)
      }, LONG_PRESS_MS) }
    } else if (touches.size === 2 && touch !== null) {
      clearTimeout(touch.timer)
      if (touch.mode === 'drag') pointer('up', 'left', touch.at)
      touch.mode = 'scroll'
    }
  }
  const touchMove = (event) => {
    const last = touches.get(event.pointerId)
    if (last === undefined || touch === null) return
    const dx = event.clientX - last.x
    const dy = event.clientY - last.y
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (touch.mode === 'pending' && Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) > TAP_SLOP_PX) {
      clearTimeout(touch.timer)
      touch.mode = 'drag'
      pointer('move', null, touch.at)
      pointer('down', 'left', touch.at)
    }
    if (touch.mode === 'drag') {
      touch.at = point(event)
      pointer('move', 'left', touch.at)
    } else if (touch.mode === 'scroll') {
      // Natural scrolling: the content follows the fingers. Two fingers
      // each report half of the movement.
      scroll(point(event), -dx / 2, -dy / 2, true)
    }
  }
  const touchUp = (event) => {
    touches.delete(event.pointerId)
    if (touch === null) return
    if (touch.mode === 'pending') {
      clearTimeout(touch.timer)
      pointer('move', null, touch.at)
      pointer('down', 'left', touch.at)
      pointer('up', 'left', touch.at)
      touch.mode = 'done'
    } else if (touch.mode === 'drag') {
      pointer(event.type === 'pointercancel' ? 'cancel' : 'up', 'left', touch.at)
      touch.mode = 'done'
    }
    if (touches.size === 0) touch = null
  }

  const onWheel = (event) => {
    if (!enabled()) return
    event.preventDefault()
    const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1
    scroll(point(event), event.deltaX * scale, event.deltaY * scale, event.deltaMode === 0)
  }

  const onKeyDown = (event) => {
    if (!enabled()) return
    const mapped = mapKey(event, 'down')
    if (mapped === null) return
    event.preventDefault()
    held.set(event.code || mapped.key, mapped)
    emit(mapped)
  }
  const onKeyUp = (event) => {
    if (!enabled()) return
    const key = event.code || event.key
    const down = held.get(key)
    if (down === undefined) return
    event.preventDefault()
    held.delete(key)
    emit({ ...down, state: 'up', repeat: false })
  }
  // Phone keyboards and input methods report edits here, often without
  // usable keydown events.
  const onBeforeInput = (event) => {
    if (!enabled()) return
    switch (event.inputType) {
      case 'insertText':
      case 'insertReplacementText':
      case 'insertFromComposition':
      case 'insertFromPaste':
        if (event.data) emit({ kind: 'text_commit', text: event.data })
        break
      case 'insertLineBreak':
      case 'insertParagraph':
        tapKey('enter').forEach(emit)
        break
      case 'deleteContentBackward':
        tapKey('backspace').forEach(emit)
        break
      case 'deleteContentForward':
        tapKey('delete').forEach(emit)
        break
      default:
        return
    }
    event.preventDefault()
  }
  // Text the browser inserted anyway (some input methods cannot be
  // prevented) is sent once and cleared.
  const onInput = () => {
    if (keyboard.value === '') return
    if (enabled()) emit({ kind: 'text_commit', text: keyboard.value })
    keyboard.value = ''
  }
  const onContextMenu = (event) => { if (enabled()) event.preventDefault() }

  const listeners = [
    [canvas, 'pointerdown', onPointerDown],
    [canvas, 'pointermove', onPointerMove],
    [canvas, 'pointerup', onPointerUp],
    [canvas, 'pointercancel', onPointerUp],
    [canvas, 'wheel', onWheel, { passive: false }],
    [canvas, 'contextmenu', onContextMenu],
    [keyboard, 'keydown', onKeyDown],
    [keyboard, 'keyup', onKeyUp],
    [keyboard, 'beforeinput', onBeforeInput],
    [keyboard, 'input', onInput],
    [keyboard, 'blur', releaseHeld],
  ]
  for (const [target, type, handler, options] of listeners) target.addEventListener(type, handler, options)
  return () => {
    releaseHeld()
    if (touch !== null) clearTimeout(touch.timer)
    for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options)
  }
}
