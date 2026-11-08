# dsh-desktop-view

Watch, live from the Web UI, the machine your DeepSeek Harness agent is running on: hear and see what it does, and step in whenever assistance is required (a QR-code login, a CAPTCHA, an unexpected dialog). While you hold control, two-way clipboard access plus file upload and download are available as well.

The desktop stream that cua-spacesd (Cua's in-guest daemon) generates, together with Cua's web viewer, is carried over DSH's existing auth and web server. Nothing extra is exposed: no port or subdomain is opened, and no daemon credential ever reaches the browser.

## What you get

- **A Desktop tab on the right sidebar**, reachable either through the sidebar guide or via the monitor button in the session header.
- **A full-screen page** at `/desktop-view/`, served from your DSH origin. It adapts to a phone screen, supports touch, and supports direct linking. Adding `?control=1` makes it open directly in control mode, letting an agent that needs help send you a link.
- **Watching is the default mode.** You see and hear the desktop, while clicks, keystrokes, clipboard and files are refused. Picking "Take control" switches modes; "Give back" returns you to watching. Control likewise ends on its own after a stretch with no input, or if the view is closed or hidden.
- **All the desktop viewer's features while you hold control**: mouse, keyboard and touch input, an on-screen keyboard, clipboard syncing, drag-and-drop file uploads, file browsing and downloads, display selection, scaling, and the microphone wherever the desktop supports one.
- **The agent is kept informed.** For as long as you hold control, a small JSON file is written by the plugin; the agent ought to read it before acting on the desktop, and each control change notifies the session that opened the view.

## Requirements

- DSH 0.2.2-rc.1 or later.
- `cua-spacesd` 0.12 or later on the same machine, with the DSH process able to reach the env token (on Cua's desktop image that means `127.0.0.1:3211`, the token being at `/run/cua/env-token`).
- An up-to-date browser: Chrome, Edge, Firefox or Safari 17+. On mobile, both Safari for iOS and Chrome for Android are supported.

## Installation

Directly from GitHub:

```bash
dsh plugin --profile web add github:soffits/dsh-desktop-view
```

Alternatively, add the bundle through the Web UI's plugin manager. Restart DSH afterwards.

## Configuration

Every option appears as a field in the `desktop-view` plugin row.

| Setting | Default | Description |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:3211` | Address on which cua-spacesd listens. Leave it on loopback, as this address receives the env token. |
| `tokenFile` | `/run/cua/env-token` | File containing the env token; it stays on the server at all times. |
| `maxFps` | `30` | Frame rate requested by the viewer. Reducing it lowers CPU and bandwidth use. |
| `clipboard` | `true` | Clipboard syncing while you hold control. |
| `filesRoot` | `~` | Desktop folder you can browse, upload to and download from while you hold control. Leaving it empty disables file transfer. |
| `microphone` | `true` | Permit sending your microphone to the desktop while you hold control, where the desktop supports it. |
| `idleSeconds` | `120` | After this many seconds with no input, control reverts to watching. |
| `stateFile` | `/tmp/dsh-desktop-view/control.json` | Path at which the plugin writes the control state that the agent reads. |
| `notifyAgent` | `wake` | Notify the session that opened the view whenever control changes: `wake` (returning control wakes the agent), `quiet` (notes are queued until the agent's next step), `off`. |

## What the agent can see

As an example, `stateFile` contains:

```json
{
  "controller": "user",
  "since": "2026-11-08T12:00:00.000Z",
  "sessionId": "01H…",
  "updatedAt": "2026-11-08T12:00:04.120Z"
}
```

When the owner holds control, `controller` is `"user"`; otherwise it is `null`. In the `null` case, the file also records the most recent reason control ended (`lastReason`: `released`, `idle`, `disconnected`, `replaced`, `stopped`). Any script or skill that drives the desktop should check it first and yield whenever the value is not `null`.

When `notifyAgent` is on, the session that opened a view gets a short note each time someone takes control (queued, and the agent is not woken) and each time control returns (delivered as steering; this wakes an idle agent so it can continue).

## Security

- All requests aimed at the plugin's paths pass through DSH's admission checks: the Host/Origin fence first, blocking cross-site and DNS-rebinding requests, then the browser's signed cookie, and no principal but the owner's is let in.
- The env token of cua-spacesd, along with the viewer tickets minted from it by the plugin, never leave the Host process. The browser keeps only short-lived relay tickets, which function through this relay together with your DSH sign-in, and only for as long as the view (and, for control, your control) persists.
- The server decides what the browser is allowed to do. Watching uses a view-only viewer ticket, so input, clipboard and files are refused by the daemon itself; beyond that, only the media messages and calls that the viewer requires in each mode are forwarded by the relay. Only one view holds control at a time, and control ends once that view disappears.
- The plugin's own pages go out with `no-store`, no referrer, and a content security policy that is strict and same-origin.

## Licensing

MIT. The desktop viewer displayed is [Cua](https://github.com/trycua/cua)'s web viewer, which your own cua-spacesd serves at runtime under Cua's FSL-1.1-MIT licence; the plugin here is independent of Cua and neither includes nor redistributes that viewer.
