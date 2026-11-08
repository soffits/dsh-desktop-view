/**
 * Who controls the desktop. At most one control socket holds control at a
 * time; a newer one replaces it. Control ends when the holder gives it back,
 * when its socket closes, or after `idleMs` without input, and the desktop
 * then returns to watching for everyone.
 *
 * Every change is written to a small JSON file so the agent's own scripts
 * can check it before acting on the desktop:
 *
 *   { "controller": "user", "since": "...", "sessionId": "...", "updatedAt": "..." }
 *   { "controller": null, "since": null, "sessionId": null, "updatedAt": "...", "lastReason": "idle" }
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Why control ended; also the WebSocket close reason the browser sees. */
export const RELEASE_REASONS = Object.freeze(['released', 'idle', 'disconnected', 'replaced', 'stopped'])

/**
 * @param {object} options
 * @param {number} options.idleMs - Return to watching after this long without input.
 * @param {(state: object) => Promise<void>} options.persist - Writes the state file.
 * @param {() => number} [options.now]
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(timer: unknown) => void} [options.clearTimer]
 */
export function createControl({ idleMs, persist, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @type {{ id: string, sessionId: string | null, since: number, lastInput: number, end: (reason: string) => void } | null} */
  let holder = null
  let timer
  let lastReason = null
  const listeners = new Set()
  let writing = Promise.resolve()

  const snapshot = () => ({
    controller: holder === null ? null : 'user',
    since: holder === null ? null : new Date(holder.since).toISOString(),
    sessionId: holder?.sessionId ?? null,
    updatedAt: new Date(now()).toISOString(),
    ...(holder === null && lastReason !== null ? { lastReason } : {}),
  })

  const publish = (change) => {
    const state = snapshot()
    writing = writing.then(() => persist(state)).catch(() => {})
    for (const listener of listeners) listener(state, change)
  }

  const arm = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    if (holder === null) return
    const due = holder.lastInput + idleMs - now()
    timer = setTimer(() => {
      timer = undefined
      if (holder === null) return
      if (now() - holder.lastInput >= idleMs) end(holder.id, 'idle')
      else arm()
    }, Math.max(due, 0))
    timer?.unref?.()
  }

  function end(id, reason) {
    if (holder === null || holder.id !== id) return false
    const previous = holder
    holder = null
    lastReason = reason
    arm()
    previous.end(reason)
    publish({ kind: 'released', reason, sessionId: previous.sessionId, heldMs: now() - previous.since })
    return true
  }

  return {
    /** The current state, as written to the file. */
    state: snapshot,

    /** Whether this socket holds control now. */
    holds: id => holder?.id === id,

    /**
     * Give control to one socket, ending any other holder's control.
     * @param {{ id: string, sessionId: string | null, end: (reason: string) => void }} claim
     */
    take(claim) {
      if (holder !== null) end(holder.id, 'replaced')
      const at = now()
      holder = { ...claim, since: at, lastInput: at }
      arm()
      publish({ kind: 'taken', sessionId: claim.sessionId })
    },

    /** Record input from the holder, which keeps control from going idle. */
    touch(id) {
      if (holder?.id === id) holder.lastInput = now()
    },

    /**
     * End control if this socket holds it.
     * @param {string} id
     * @param {typeof RELEASE_REASONS[number]} reason
     * @returns {boolean} whether it held control
     */
    release: end,

    /** Follow every change; returns the unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Write the current state (startup), and wait for queued writes. */
    async flush() {
      const state = snapshot()
      writing = writing.then(() => persist(state)).catch(() => {})
      await writing
    },
  }
}

/**
 * Write the state file atomically (temp file, then rename), creating its
 * directory, readable by the agent's user only.
 * @param {string} path
 */
export function fileWriter(path) {
  return async (state) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, path)
  }
}
