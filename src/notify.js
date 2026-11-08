/**
 * Tell the agent of the DSH session a view was opened from when the owner
 * takes or gives back control of the desktop, so it neither fights the owner
 * nor waits forever for a CAPTCHA that is already solved.
 *
 * - Taking control queues a note for the agent's next step without waking
 *   it (`agent.inject`): a busy agent sees it before it touches the desktop
 *   again, an idle one has nothing to stop.
 * - Giving control back (any way: button, idle timeout, closed tab) is sent
 *   as steering (`agent.steer`) with `notifyAgent: wake`: a running agent
 *   reads it at its next step, an idle one starts a turn. With `quiet` it is
 *   queued like the first note instead.
 *
 * The messages carry this plugin's own source kind, which DSH's message
 * source union allows producers to add (consumers fall through unknown kinds).
 */
import { randomUUID } from 'node:crypto'

export const NOTIFY_MODES = Object.freeze(['wake', 'quiet', 'off'])
export const SOURCE_KIND = 'desktop-view'

/** The model-facing text for one control change. */
export function noticeText(change, stateFile) {
  if (change.kind === 'taken') {
    return `The owner took control of the desktop from the live view. Do not use the mouse, keyboard or browser on the desktop until control is given back; ${stateFile} shows the current state.`
  }
  const why = {
    released: 'gave control back',
    idle: 'stopped using the desktop, so control returned after the idle timeout',
    disconnected: 'closed the live view',
    replaced: 'took control from another view',
    stopped: 'lost control because the desktop view plugin stopped',
  }[change.reason] ?? 'gave control back'
  const minutes = Math.max(1, Math.round((change.heldMs ?? 0) / 60_000))
  return `The owner ${why} after about ${minutes} min. You may use the desktop again; check its current state with a screenshot before continuing.`
}

/**
 * @param {object} options
 * @param {{ get: (name: string) => any }} options.ctx - Plugin context, for `agents` and `sessionController`.
 * @param {'wake' | 'quiet' | 'off'} options.mode
 * @param {string} options.stateFile
 * @param {{ warn: Function }} options.logger
 * @returns {(state: object, change: { kind: string, reason?: string, sessionId: string | null, heldMs?: number }) => Promise<void>}
 */
export function createNotifier({ ctx, mode, stateFile, logger }) {
  return async (_state, change) => {
    if (mode === 'off' || change.sessionId === null) return
    // Another view taking over is not a hand-back to the agent.
    if (change.kind === 'released' && change.reason === 'replaced') return
    const text = noticeText(change, stateFile)
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: change.kind === 'taken' ? 'Owner took control of the desktop' : 'Owner gave the desktop back' },
    }
    const wake = change.kind === 'released' && mode === 'wake'
    const deliver = async () => {
      const agent = ctx.get('agents')?.get(change.sessionId) ?? (wake ? await resolve(ctx, change.sessionId) : undefined)
      if (agent === undefined) return
      if (wake) agent.steer(message)
      else agent.inject(message)
    }
    try {
      // A socket callback has no initiating agent; say so explicitly, as DSH's schedule does.
      const agents = ctx.get('agents')
      await (agents === undefined ? deliver() : agents.withoutInitiator(deliver))
    } catch (error) {
      logger.warn('could not tell session %s about the desktop: %s', change.sessionId, error instanceof Error ? error.message : String(error))
    }
  }
}

/** Resume a session's agent, the way DSH's own schedule does. */
async function resolve(ctx, sessionId) {
  const controller = ctx.get('sessionController')
  if (controller === undefined) return undefined
  const resolved = await controller.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  return resolved.agent
}
