# Decisions

Working choices, one line each, grouped by the part of the system they shape.
Product decisions (what users get, direction) belong in `docs/roadmap.md`; this
file records how it is built.

## Transport and relay

- The desktop is relayed from `cua-spacesd` through the Host's own web server under one prefix (`/desktop-view`), one prefix route plus one exact upgrade route, instead of a second port or subdomain: the browser only ever talks to the DSH origin, and the daemon's token stays in the Host.
- The relay opens every media session itself with `StreamService.OpenMedia` and the env token, instead of handing the page a ticket minted earlier: a ticket is bound to one media session and one policy, so opening it here is what lets the policy follow the socket's mode.
- Only `/media` is relayed, not the daemon's gRPC-Web or files endpoints: the viewer needs the media socket alone, so the rest of the daemon's API is not reachable through DSH at all.
- The daemon speaks binary proto only (Connect JSON and `grpc-web+json` answer 400), so `src/proto.js` hand-encodes the three messages used: a generated client would be larger than the code it serves.
- `ws` carries both upgrade ends (the browser-facing server and the daemon-facing client), because the Host cannot lend a plugin its private WebSocket implementation and `ws` is MIT with no build step.
- Media socket tickets are requested with a 30 s lifetime: long enough to attach, short enough that a ticket in a log means little.
- A browser whose send buffer passes 4 MiB gets dependent frames dropped and a keyframe requested: a phone on a weak link then recovers the picture instead of carrying minutes of stale video.

## Authentication and access

- Every page request and upgrade is admitted with DSH's own `connection.admit`, and only principal kind `owner` proceeds, plus the reverse proxy's OIDC gate in front of it: the plugin adds no second auth scheme to get wrong.
- A request refused because it is a cross-site navigation gets a page that reloads itself from this origin once, instead of a 401: DSH's cookie is `SameSite=Strict`, so a link opened from a chat app arrives without it and a reload fixes it.
- The viewer page is served `no-store`, `frame-ancestors 'none'`, `nosniff`, no referrer, and a CSP that allows only same-origin scripts, styles and the same-origin media socket.

## Control: who may act on the desktop

- Watching and control are enforced on the server, by the media session's own policy (`view_only` for watching, `allow_activation` for control) and by an allow-list of message types per mode: a modified page cannot send input on a watch socket, and the daemon refuses it if it tried to.
- One control socket at a time, newest wins, and the replaced one is closed with code 4100 and reason `replaced`: there is one mouse, so a second controller would only fight the first.
- Control ends on an explicit "give back", on the socket closing, or after `idleSeconds` without input; input from any other socket does not extend it.
- Control returns to watching rather than staying on: a user who walks away must not leave the desktop open to stray clicks.
- A control socket never reconnects as control by itself; after any disconnection the viewer comes back watching, because taking control is a decision the user makes.

## Control state the agent can see

- The state lives in a small JSON file (`stateFile`), written atomically at 0600 with `controller`, `since`, `sessionId`, `updatedAt` and, when free, `lastReason`: an agent's own script can check it without asking DSH for anything.
- The file sits in the temp directory by default (`/tmp/dsh-desktop-view/control.json`): it describes a live session, not history worth keeping.
- Taking control is queued with `agent.inject` and giving it back with `agent.steer`: an idle agent is not woken to be told to stop, but is woken to carry on once the owner is done.
- The notes carry this plugin's own message source kind (`desktop-view`) with form `notice`, which DSH's message source union allows producers to add: the transcript stays honest about who wrote them.

## Viewer

- The plugin ships its own small viewer on the open rcdp wire v2 protocol (WebCodecs H.264 onto a canvas) instead of embedding Cua's viewer: Cua's page is FSL-1.1-MIT (not an OSI licence, and not MIT until two years after each release), forbids framing, and calls several daemon services, which would widen the relay; a small viewer keeps the relay to `/media` alone.
- The same viewer module serves the sidebar tab and the full-screen page (`viewer/core.js`): two viewers would drift apart on the rules that matter most, input and reconnection.
- Keyboard input goes through a hidden textarea and commits text, with keys only for named keys and shortcuts, and shortcut letters taken from the physical key: layouts, dead keys, input methods and phone keyboards then behave as the user expects, and Ctrl+C is Ctrl+C on any layout.
- Touch input follows phone habits: a tap clicks, a long press right-clicks, a drag drags, two fingers scroll.
- A lost stream retries on its own with a growing delay and shows an honest status: the desktop may come back after a daemon restart, and the user should not have to reload the page.

## Web UI placement

- A right-sidebar tab type (also offered in the sidebar guide) plus a button in the session header's utilities, rather than a page: the desktop belongs beside the conversation that is driving it.
- The header button only opens or hides the tab, without a pressed state of its own: the sidebar exposes no subscription for its layout in 0.2.2-rc.1, and a polling indicator would cost more than it tells.
- The full-screen page is a plain server-rendered HTML page at `/desktop-view/`, not an iframe inside the app: an iframe would not receive the host's theme or locale, and a phone needs a page that fits the screen on its own.
- `?control=1` opens the page in control mode, and the flag is dropped from the URL on load: an agent can hand the owner a link that lands in control, and a reload later does not grab control again.
- The full-screen page picks English or Chinese from the browser's language, while the sidebar tab uses DSH's locale service: the page is outside the app and cannot read the app's language.

## Packaging and checks

- The package is an installable bundle with one Host row and one client half, MIT, author "Sakina": it is meant to be published as `dsh-desktop-view` and installed with the plugin manager like any other bundle.
- `node --test` covers the relay's auth and view-only rules, the control store, the HTTP handler, the notifier, the client registrations and the viewer's parsing and key mapping; the one check that needs the real daemon is `test/live.test.js`, which skips itself where `cua-spacesd` is absent.
