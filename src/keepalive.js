/**
 * Keep a browser-facing WebSocket alive through the proxies in front of
 * DSH, and notice when it is dead.
 *
 * The public path to DSH runs through proxies (a Cloudflare tunnel closes a
 * WebSocket after about 100 s without traffic). A view's status socket is
 * silent between control changes, and a media socket is silent while the
 * desktop does not change, so both were cut. The relay therefore pings every
 * browser socket on a fixed interval (browsers answer pings by themselves,
 * also in background tabs) and drops a socket that missed a whole interval's
 * pong, so a dead link is noticed in seconds rather than at the next send.
 */

/** Ping interval: well below the ~100 s idle limit of common proxies. */
export const PING_INTERVAL_MS = 25_000

/**
 * @param {import('ws').WebSocket} socket
 * @param {object} [options]
 * @param {number} [options.intervalMs]
 * @param {() => void} [options.beat] - Extra traffic sent with each ping (an app-level heartbeat).
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(timer: unknown) => void} [options.clearTimer]
 * @returns {() => void} stop
 */
export function keepAlive(socket, { intervalMs = PING_INTERVAL_MS, beat, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let answered = true
  const onPong = () => { answered = true }
  socket.on('pong', onPong)
  const timer = setTimer(() => {
    if (socket.readyState !== socket.OPEN) return
    if (!answered) {
      socket.terminate()
      return
    }
    answered = false
    socket.ping()
    beat?.()
  }, intervalMs)
  timer?.unref?.()
  const stop = () => {
    clearTimer(timer)
    socket.off('pong', onPong)
  }
  socket.once('close', stop)
  return stop
}
