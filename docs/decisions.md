# Decisions

Working choices, one line each, grouped by the part of the system they shape.
Product decisions (what users get, direction) belong in `docs/roadmap.md`; this
file records how it is built.

## Transport and relay

- The desktop is relayed from `cua-spacesd` through the Host's own web server under one prefix (`/desktop-view`): one prefix route plus two exact upgrade routes (`status`, `d/media`), instead of a second port or subdomain: the browser only ever talks to the DSH origin, and the daemon's credentials stay in the Host.
- The relayed viewer lives under one fixed base, `/desktop-view/d/`, because DSH upgrade routes are exact paths and the viewer resolves its media socket from its base; which mode a request belongs to comes from its relay ticket, not its path.
- The relay mints the daemon's own scoped viewer tickets (`SystemService.CreateViewerTicket`) server-side, one per mode, and swaps them in per request: watch gets `view_only` with no clipboard, files or microphone; control gets `allow_activation`, clipboard, `filesRoot` and the microphone. The daemon enforces that scope even if the relay had a bug.
- The browser holds only relay tickets (random 256-bit, in the frame's URL fragment and the viewer's sessionStorage): they work only through this relay with DSH's cookie, and a control one is revoked the moment control ends.
- A media socket is accepted only when one of the relay's own tickets opened its media session (read from the proxied OpenMedia answer), and it is judged by that ticket's mode.
- gRPC-Web calls pass an allow-list per mode of exactly the methods the viewer calls; nothing else of the daemon's API (processes, shell, signed file URLs, viewer-ticket minting) is reachable through DSH.
- The daemon speaks binary proto only (Connect JSON and `grpc-web+json` answer 400), so `src/proto.js` hand-encodes the few messages the relay itself reads and writes: a generated client would be larger than the code it serves.
- `ws` carries both upgrade ends (the browser-facing server and the daemon-facing client), because the Host cannot lend a plugin its private WebSocket implementation and `ws` is MIT with no build step.
- A browser whose send buffer passes 4 MiB gets dependent frames dropped and a keyframe requested: a phone on a weak link then recovers the picture instead of carrying minutes of stale video.
- Every browser-facing socket (status and media) gets a WebSocket ping every 25 s, and the status socket also a small JSON heartbeat; a socket that misses a whole interval's pong is dropped: Cloudflare's tunnel closes WebSockets after about 100 s without traffic, and both sockets can be silent that long (no control change, an unchanging desktop). The daemon already pings the relay's own leg every 20 s.
- Viewer tickets are minted for an hour and refreshed with ten minutes left; a daemon answer of "unauthenticated" drops the cached one so the next call mints anew (a rotated env token heals by itself).

## Authentication and access

- Every page request and upgrade is admitted with DSH's own `connection.admit`, and only principal kind `owner` proceeds, plus the reverse proxy's OIDC gate in front of it: the plugin adds no second auth scheme to get wrong.
- A request refused because it is a cross-site navigation gets a page that reloads itself from this origin once, instead of a 401: DSH's cookie is `SameSite=Strict`, so a link opened from a chat app arrives without it and a reload fixes it.
- The plugin's own pages are served `no-store`, `nosniff`, no referrer, and a CSP that allows only same-origin scripts, styles, sockets and frames, framed only by this origin; the relayed viewer page keeps the daemon's own CSP with `frame-ancestors 'self'`.

## Control: who may act on the desktop

- Watching and control are enforced on the server, three times over: by the daemon's viewer ticket scope, by the media session's policy that scope caps, and by the relay's allow-lists of RPCs and media message types per mode: a modified page cannot send input, read the clipboard or touch files while watching.
- One controlling view at a time, newest wins; the replaced view is told (`ended: replaced`) and its control streams are closed with code 4100: there is one mouse, so a second controller would only fight the first.
- Control ends on an explicit "Give back", when the view's status socket closes (tab hidden or closed, page left), or after `idleSeconds` without input; input means input batches on the control stream and user actions (paste into the desktop, file transfers), not the viewer's own polling.
- Control returns to watching rather than staying on: a user who walks away must not leave the desktop open to stray clicks.
- A view outlives a cut status socket by 30 s: the page reconnects with the view's resume token and gets the same grant back, so its viewer keeps running and control is kept; only a view closed on purpose (code 1000) or not back in time ends. A proxy hiccup must not throw the owner out of control or reload her stream.
- Control belongs to a view's status socket, not to a stream: the stream may reconnect, and after any status disconnection the view comes back watching, because taking control is a decision the user makes.

## Control state the agent can see

- The state lives in a small JSON file (`stateFile`), written atomically at 0600 with `controller`, `since`, `sessionId`, `updatedAt` and, when free, `lastReason`: an agent's own script can check it without asking DSH for anything.
- The file sits in the temp directory by default (`/tmp/dsh-desktop-view/control.json`): it describes a live session, not history worth keeping.
- Taking control is queued with `agent.inject` and giving it back with `agent.steer`: an idle agent is not woken to be told to stop, but is woken to carry on once the owner is done.
- The notes carry this plugin's own message source kind (`desktop-view`) with form `notice`, which DSH's message source union allows producers to add: the transcript stays honest about who wrote them.

## Viewer

- v2 relays Cua's own web viewer (served by the daemon at `/viewer/`) instead of growing the plugin's v1 viewer: it already does audio (Opus), clipboard both ways, file upload and download, folder sync, display choice, scaling, presence and touch, on the same open wire protocol, so the plugin keeps only the parts that are its own (login, relay, watch/control rules, agent awareness). v1's own WebCodecs viewer was removed rather than kept beside it.
- The viewer is FSL-1.1-MIT. Running it for the owner's own use is a Permitted Purpose ("internal use and access"); the plugin ships none of its code (the daemon serves it) and changes none of its files: the relay only inserts one script tag of its own into the page and relaxes `frame-ancestors` to `'self'`.
- The inserted shim forces the viewer's fetches to send same-origin cookies (it uses `credentials: "omit"`): DSH's own login and the OIDC proxy in front of it both need them, and wrapping `fetch` survives viewer updates that a patch of its minified code would not.
- The viewer runs in a same-origin frame below the plugin's status bar, in the sidebar tab and on the full-screen page: its interface is its own, and a frame keeps it out of the DSH page's DOM and styles; being same-origin is what lets the DSH cookies reach it. It could reach the parent page; that is accepted because its code comes from the trusted local daemon.
- Watching passes `view_only=1` to the viewer, so its interface hides input, clipboard and file controls; the daemon's view-only ticket enforces the same.
- The viewer asks for `maxFps` (default 30, not the viewer's own 60): the machine is small and shared, and 30 frames are plenty for a desktop.

## Web UI placement

- A right-sidebar tab type (also offered in the sidebar guide) plus a button in the session header's utilities, rather than a page: the desktop belongs beside the conversation that is driving it.
- The header button only opens or hides the tab, without a pressed state of its own: the sidebar exposes no subscription for its layout in 0.2.2-rc.1, and a polling indicator would cost more than it tells.
- The header button's tooltip is rebuilt in the plugin from the host's Tooltip primitive (bottom, centred, 500 ms hover delay, immediate on keyboard focus, hidden on leave, blur, click and touch, same tokens and sizes), because plugins may not load the primitives package; the button keeps an `aria-label` and no native `title`, so there is one tooltip, like its neighbours'.
- The tab and the full-screen page share `viewer/session.js` (status socket and frame): the Take control / Give back flow then behaves the same in both.
- The full-screen page is a plain HTML page of the plugin's at `/desktop-view/` (status bar plus the viewer frame), not the DSH app: a phone needs a page that fits the screen on its own.
- `?control=1` opens the page in control mode, and the flag is dropped from the URL on load: an agent can hand the owner a link that lands in control, and a reload later does not grab control again.
- The full-screen page picks English or Chinese from the browser's language, while the sidebar tab uses DSH's locale service: the page is outside the app and cannot read the app's language.

## Packaging and checks

- The package is an installable bundle with one Host row and one client half, MIT, author "Sakina": it is meant to be published as `dsh-desktop-view` and installed with the plugin manager like any other bundle.
- `node --test` covers admission, the per-mode RPC and media allow-lists, ticket swapping and revocation, the status flow, the control store, the notifier and the client registrations; `test/live.test.js` runs watch, take control and give back through the real routes against the real daemon and skips itself where `cua-spacesd` is absent.
