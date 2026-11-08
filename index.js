/**
 * DeepSeek Harness Host plugin: relay the live desktop of this machine from
 * cua-spacesd (Cua's in-guest daemon) through DSH's own web server and
 * login, with the daemon's own web viewer (video, audio, clipboard, files,
 * displays, presence).
 *
 * The approved flow stays the plugin's own: a view starts watching, "Take
 * control" and "Give back" go over its status socket, and the relay enforces
 * the difference. The daemon's env token and its viewer tickets stay on the
 * server; the browser only holds relay tickets that work through this relay
 * and only while their view (and, for control, its control) lasts.
 *
 * The Web UI half (client.js) adds a session-header button and a right
 * sidebar tab; the full-screen page in viewer/ serves phones and direct links.
 */
import WebSocket, { WebSocketServer } from 'ws'
import { Config } from './src/config.js'
import { createControl, fileWriter } from './src/control.js'
import { MAX_CLIENT_MESSAGE_BYTES } from './src/filter.js'
import { MEDIA_PATH, PREFIX, STATUS_PATH, admitOwner, createPageHandler, refuseUpgrade, statusQuery } from './src/http.js'
import { keepAlive } from './src/keepalive.js'
import { CLOSE, mediaTicketOf, pipeMedia } from './src/media.js'
import { createNotifier } from './src/notify.js'
import { createSpacesd } from './src/spacesd.js'
import { createViews } from './src/status.js'
import { createTicketBook } from './src/tickets.js'
import { createViewerProxy } from './src/viewer.js'

export const name = 'dsh-desktop-view'
export const inject = ['webServer', 'connection']
export { Config }

/** Largest message the viewer's media socket may send up (microphone audio, input). */
const MAX_MEDIA_MESSAGE_BYTES = 1024 * 1024

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/schemastery').default.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  const logger = ctx.logger('desktop-view')
  const spacesd = createSpacesd({ endpoint: config.endpoint, tokenFile: config.tokenFile })
  const write = fileWriter(config.stateFile)
  const control = createControl({
    idleMs: config.idleSeconds * 1000,
    persist: state => write(state).catch(error => logger.warn('could not write %s: %s', config.stateFile, error.message)),
  })
  const notify = createNotifier({ ctx, mode: config.notifyAgent, stateFile: config.stateFile, logger })
  const tickets = createTicketBook({
    spacesd,
    features: { clipboard: config.clipboard, filesRoot: config.filesRoot, microphone: config.microphone },
  })
  const mediaUrl = new URL('media', `${spacesd.base}/`)
  mediaUrl.protocol = mediaUrl.protocol === 'https:' ? 'wss:' : 'ws:'

  ctx.effect(() => {
    const unsubscribe = control.subscribe((state, change) => { notify(state, change) })
    const views = createViews({ control, tickets, viewer: { maxFps: config.maxFps }, logger })
    const media = new Map()
    const statusServer = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false })
    const mediaServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MEDIA_MESSAGE_BYTES,
      perMessageDeflate: false,
      handleProtocols: offered => (offered.has('rcdp.v2') ? 'rcdp.v2' : false),
    })
    control.flush()

    // A revoked relay ticket (control given back, view closed) closes the
    // media sockets it opened, so the input path ends with the control.
    const stopRevoke = tickets.onRevoke((token) => {
      for (const [piped, owner] of media) if (owner === token) piped.close(CLOSE.CONTROL_ENDED, 'control ended')
    })

    const viewer = createViewerProxy({ endpoint: config.endpoint, tickets, touch: id => control.touch(id), logger })
    const disposePage = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: createPageHandler({ connection: ctx.connection, viewer }),
    })

    const disposeStatus = ctx.webServer.registerUpgrade({
      path: STATUS_PATH,
      handler(req, socket, head) {
        const admitted = admitOwner(ctx.connection, req)
        if (!admitted.ok) return refuseUpgrade(socket, admitted.status)
        statusServer.handleUpgrade(req, socket, head, (browser) => {
          views.attach(browser, statusQuery(req.url))
        })
      },
    })

    const disposeMedia = ctx.webServer.registerUpgrade({
      path: MEDIA_PATH,
      handler(req, socket, head) {
        const admitted = admitOwner(ctx.connection, req)
        if (!admitted.ok) return refuseUpgrade(socket, admitted.status)
        const ticket = mediaTicketOf(req.url, req.headers['sec-websocket-protocol'])
        const binding = ticket === undefined ? undefined : tickets.media(ticket)
        if (binding === undefined) return refuseUpgrade(socket, 401)
        mediaServer.handleUpgrade(req, socket, head, (browser) => {
          const url = new URL(mediaUrl)
          url.searchParams.set('ticket', ticket)
          const piped = pipeMedia({
            browser,
            mode: binding.grant.mode,
            sessionId: binding.sessionId,
            onInput: () => control.touch(binding.grant.holderId),
            connect: () => new WebSocket(url, ['rcdp.v2'], { perMessageDeflate: false }),
            logger,
          })
          media.set(piped, binding.relayToken)
          keepAlive(browser)
          browser.once('close', () => media.delete(piped))
        })
      },
    })

    return async () => {
      disposeMedia()
      disposeStatus()
      disposePage()
      stopRevoke()
      views.closeAll()
      for (const piped of media.keys()) piped.close(1001, 'stopped')
      statusServer.close()
      mediaServer.close()
      unsubscribe()
      await control.flush()
    }
  }, 'desktop-view.relay()')
}
