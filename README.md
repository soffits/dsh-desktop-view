# dsh-desktop-view

From inside the Web UI, watch in real time the machine on which your DeepSeek Harness agent runs: follow what it does and lend a hand whenever help is needed (a QR-code sign-in, a CAPTCHA, a dialog it did not expect).

The viewer and the desktop stream produced by cua-spacesd (Cua's daemon inside the guest) travel by way of DSH's current authentication and web server. Nothing additional gets exposed: neither a port nor a subdomain is opened, and no token ever arrives in the browser.

## What you get

- **A Desktop tab in the right sidebar** that you can open from the sidebar guide or with a monitor button in the session header.
- **A full-screen page** at `/desktop-view/` on your DSH origin. It fits a phone display, takes touch input while control is yours, and can be linked to directly. With `?control=1` it starts straight in control mode, so an agent needing help can send you a link.
- **Watch mode is the default.** You can see the screen, but clicks and key presses are refused. Choosing "Take control" changes modes; "Give back" returns to watching. Control also ends by itself after a period without input or when the viewer disconnects.
- **The agent stays informed.** While you hold control, the plugin writes a small JSON file that the agent should read before it acts on the desktop, and every change of control notifies whichever session opened the view.

## Requirements

- DSH version 0.2.2-rc.1 or newer.
- `cua-spacesd` running on the same machine, and the DSH process must be able to reach the env token (in Cua's desktop image, this means `127.0.0.1:3211`, with the token located at `/run/cua/env-token`).
- A browser with WebCodecs H.264 decoding support: a current Chrome, Edge, or Firefox, plus Safari 17+. On phones, Safari for iOS and Chrome for Android both work.

## Installation

Straight from GitHub:

```bash
dsh plugin --profile web add github:soffits/dsh-desktop-view
```

You can also use the Web UI's plugin manager to add the bundle. Then restart DSH.

## Configuration

Each option shows up as a field on the `desktop-view` plugin row.

| Setting | Default | Description |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:3211` | The address cua-spacesd listens on. Keep it on loopback, since the env token is sent to this address. |
| `tokenFile` | `/run/cua/env-token` | The file holding the env token. It is read for each stream and never leaves the server. |
| `display` | `primary` | The display to stream. |
| `maxFps` | `15` | Maximum frame rate. Lowering it cuts CPU and bandwidth usage. |
| `maxDimension` | `0` | Longest dimension in pixels; `0` preserves the native size. |
| `bitrateKbps` | `0` | H.264 bitrate; `0` uses the encoder default. On mobile data, a phone works well at 1500. |
| `idleSeconds` | `120` | Control returns to watching after this many seconds without input. |
| `stateFile` | `/tmp/dsh-desktop-view/control.json` | Path where the plugin writes control state for the agent to read. |
| `notifyAgent` | `wake` | Tell whichever session opened the view when control changes: `wake` (giving control back wakes the agent), `quiet` (notes are held until the agent takes its next step), `off`. |

## What the agent sees

For instance, `stateFile` holds:

```json
{
  "controller": "user",
  "since": "2026-11-08T12:00:00.000Z",
  "sessionId": "01H…",
  "updatedAt": "2026-11-08T12:00:04.120Z"
}
```

While the owner holds control, `controller` reads `"user"`; at all other times it is `null`. In the `null` case, the file additionally notes why control ended most recently (`lastReason`: `released`, `idle`, `disconnected`, `replaced`, `stopped`). A script or skill used to drive the desktop ought to inspect it first and yield whenever the value differs from `null`.

With `notifyAgent` enabled, whichever session opened a view receives a short note whenever someone takes control (queued without waking the agent) and whenever control comes back (delivered as steering; this wakes an idle agent, letting it carry on).

## Security

- Every request that targets the plugin's paths is subject to DSH's admission checks: first the Host/Origin fence, which blocks DNS-rebinding and cross-site requests, then the signed cookie from the browser, and no principal other than the owner's is admitted.
- The viewer page is served with `no-store` and `frame-ancestors 'none'`, and it carries no referrer.
- cua-spacesd's env token stays inside the Host process. The browser gets only a short-lived media-session ticket.
- What the browser may do is decided by the server: a watching socket starts as `view_only`, so the daemon itself refuses input, and only message types used by the viewer are forwarded by the relay. Control sockets start as `allow_activation`, with a single socket at any moment.

## Licensing

MIT. The desktop stream comes from [cua](https://github.com/trycua/cua); this plugin is independent of it and uses its open wire protocol.
