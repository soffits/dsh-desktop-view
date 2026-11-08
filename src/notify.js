/**
 * Tell the agent of the DSH session a view was opened from when the owner
 * takes or gives back control of the desktop, so it neither fights the owner
 * nor waits forever for a CAPTCHA that is already solved, without starting
 * turns nobody needs.
 *
 * - Taking control never starts a turn: the note is queued for the agent's
 *   next step (`agent.inject`), so a busy agent sees it before it touches the
 *   desktop again, and an idle one has nothing to stop.
 * - Giving control back (any way: button, idle timeout, closed view) is sent
 *   as steering (`agent.steer`) only when the agent has to carry on: it is
 *   running, or the view was opened from a help link the agent sent
 *   (`?help=1`), so it is waiting for the owner. Otherwise the note is queued
 *   quietly like the first one. With `quiet` nothing ever wakes the agent.
 *
 * The messages carry this plugin's own source kind, which DSH's message
 * source union allows producers to add; the Web UI half shows them as a
 * "Desktop control" row (client.js).
 */
import { randomUUID } from 'node:crypto'

export const NOTIFY_MODES = Object.freeze(['wake', 'quiet', 'off'])
export const SOURCE_KIND = 'desktop-view'

/** Short wording of why control ended, for the agent. */
const RELEASE_WORDING = Object.freeze({
  released: 'gave the desktop back',
  idle: 'stopped using the desktop (idle timeout)',
  disconnected: 'closed the desktop view',
  stopped: 'lost control (the desktop view stopped)',
})

/** The model-facing text for one control change. Kept short: it lands in the agent's context. */
export function noticeText(change, stateFile) {
  if (change.kind === 'taken') {
    return `The owner took control of the desktop. Leave the mouse, keyboard and browser alone until it is given back (state: ${stateFile}).`
  }
  return `The owner ${RELEASE_WORDING[change.reason] ?? RELEASE_WORDING.released}. You may use the desktop again; take a screenshot first.`
}

/** The one-line summary the chat row shows. */
export function noticeSummary(change) {
  return change.kind === 'taken' ? 'Owner took control' : 'Owner gave control back'
}

/**
 * Whether a control change should wake the agent.
 * @param {{ kind: string, help?: boolean }} change
 * @param {'wake' | 'quiet' | 'off'} mode
 * @param {{ status?: string } | undefined} agent - The live agent, when there is one.
 */
export function shouldWake(change, mode, agent) {
  if (mode !== 'wake' || change.kind !== 'released') return false
  return change.help === true || (agent?.status !== undefined && agent.status !== 'idle')
}

/**
 * @param {object} options
 * @param {{ get: (name: string) => any }} options.ctx - Plugin context, for `agents` and `sessionController`.
 * @param {'wake' | 'quiet' | 'off'} options.mode
 * @param {string} options.stateFile
 * @param {{ warn: Function }} options.logger
 * @returns {(state: object, change: { kind: string, reason?: string, sessionId: string | null, help?: boolean }) => Promise<void>}
 */
export function createNotifier({ ctx, mode, stateFile, logger }) {
  return async (_state, change) => {
    if (mode === 'off' || change.sessionId === null) return
    // Another view taking over is not a hand-back to the agent.
    if (change.kind === 'released' && change.reason === 'replaced') return
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: noticeText(change, stateFile) }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: noticeSummary(change), change: change.kind },
    }
    const deliver = async () => {
      const live = ctx.get('agents')?.get(change.sessionId)
      const wake = shouldWake(change, mode, live)
      // A session the owner asked for help from is resumed if needed; any
      // other note waits for a live agent's next step.
      const agent = live ?? (wake ? await resolve(ctx, change.sessionId) : undefined)
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
