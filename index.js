/**
 * DeepSeek Harness Host plugin: relay the live desktop of this machine from
 * cua-spacesd (Cua's in-guest daemon) through DSH's own web server and
 * login. The browser never sees the daemon's env token: the relay opens each
 * media session itself, `view_only` for watching and `allow_activation` only
 * for the one socket that holds control (src/relay.js, src/control.js).
 *
 * The Web UI half (client.js) adds a session-header button and a right
 * sidebar tab; the full-screen page in viewer/ serves phones and direct links.
 */
import { WebSocketServer } from 'ws'
import { Config } from './src/config.js'
import { createControl, fileWriter } from './src/control.js'
import { MAX_CLIENT_MESSAGE_BYTES } from './src/filter.js'
import { MEDIA_PATH, PREFIX, admitOwner, createPageHandler, parseMediaQuery, refuseUpgrade } from './src/http.js'
import { createNotifier } from './src/notify.js'
import { relay } from './src/relay.js'
import { createSpacesd } from './src/spacesd.js'

export const name = 'dsh-desktop-view'
export const inject = ['webServer', 'connection']
export { Config }

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
  const media = { display: config.display, maxFps: config.maxFps, maxDimension: config.maxDimension, bitrateKbps: config.bitrateKbps }

  ctx.effect(() => {
    const unsubscribe = control.subscribe((state, change) => { notify(state, change) })
    const sockets = new Set()
    const server = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false })
    control.flush()

    const disposePage = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: createPageHandler({ connection: ctx.connection }),
    })
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: MEDIA_PATH,
      handler(req, socket, head) {
        const admitted = admitOwner(ctx.connection, req)
        if (!admitted.ok) return refuseUpgrade(socket, admitted.status)
        const query = parseMediaQuery(req.url)
        if (query === undefined) return refuseUpgrade(socket, 400)
        server.handleUpgrade(req, socket, head, (browser) => {
          const relayed = relay({ browser, ...query, spacesd, control, media, logger })
          sockets.add(relayed)
          browser.once('close', () => sockets.delete(relayed))
        })
      },
    })

    return async () => {
      disposeUpgrade()
      disposePage()
      for (const relayed of sockets) relayed.close(1001, 'stopped', 'stopped')
      server.close()
      unsubscribe()
      await control.flush()
    }
  }, 'desktop-view.relay()')
}
