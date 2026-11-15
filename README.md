# dsh-desktop-view

Watch the desktop on the machine that runs your DeepSeek Harness agent, in real time through the Web UI, with audio, and step in when it needs help: a login via QR code, a CAPTCHA, or a dialog it wasn't ready for. Control also gives you the clipboard in both directions, along with file uploads and downloads.

The plugin passes the desktop stream along from cua-spacesd (the daemon that lives in Cua's desktop images) and from Cua's web viewer, using DSH's existing web server plus its login. No new port or subdomain is opened, and the daemon's credentials stay out of the browser.

## What you get

- **Desktop tab on the right sidebar.** You can launch it from the sidebar, or by clicking the session header's monitor button.
- **A page that fills the screen** at `/desktop-view/`, served from your DSH origin. It supports touch on a phone, and you can share a link to it. `?control=1` drops you right into control mode, so a stuck agent can send you one: it sends `/desktop-view/?control=1&help=1&session=<its session id>`, and once you give control back, the agent wakes up and keeps going.
- **By default, you watch.** You see the desktop and hear its audio, but clicks, keystrokes, clipboard, and files get blocked. "Take control" moves you in, and "Give back" puts you back in watch mode. Control also drops on its own after a stretch with no input, or if you close the view. If you only hide the Desktop tab (switch to another sidebar tab, collapse the sidebar, open another session), control stays with you; the stream goes quiet until you return.
- **The complete viewer once you take control**: mouse input, keyboard input, touch, an on-screen keyboard, clipboard sync, uploads by drag-and-drop, browsing and downloading files, display choice, scaling, and a microphone when the desktop has one.
- **The agent can tell when control is yours.** As long as you have it, the plugin drops a little JSON file for the agent to read before it works on the desktop, and each control change leaves a note in the session where the view was opened.

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
| `endpoint` | `http://127.0.0.1:3211` | Where cua-spacesd listens. Keep it on loopback, since this address receives the env token. |
| `tokenFile` | `/run/cua/env-token` | File containing the env token; it stays on the server at all times. |
| `maxFps` | `30` | Frame rate requested by the viewer. Reducing it lowers CPU and bandwidth use. |
| `clipboard` | `true` | Clipboard syncing while you hold control. |
| `filesRoot` | `~` | Desktop folder you can browse, upload to and download from while you hold control. Leaving it empty disables file transfer. |
| `microphone` | `true` | Let your microphone reach the desktop while you hold control, where the desktop supports it. |
| `idleSeconds` | `120` | After this many seconds with no input, control reverts to watching. |
| `stateFile` | `/tmp/dsh-desktop-view/control.json` | Where the plugin writes the control state that the agent reads. |
| `notifyAgent` | `wake` | Notify the session that opened the view whenever control changes: `wake` (returning control wakes the agent if it is running or sent the help link; otherwise the note waits), `quiet` (notes always wait for the agent's next step), `off`. |

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

When `notifyAgent` is on, the session that opened a view gets a short note each time someone takes control (queued; the agent is never woken for it) and each time control returns. The return note wakes the agent only when it has to carry on: it is still running, or the view came from its help link (`help=1`). Otherwise it waits quietly for the agent's next step, so no turn starts for nothing. In the chat the notes appear as a small "Desktop control" row.

## Security

- All requests aimed at the plugin's paths pass through DSH's admission checks: the Host/Origin fence first, blocking cross-site and DNS-rebinding requests, then the browser's signed cookie, and only the owner gets in.
- The env token of cua-spacesd, along with the viewer tickets minted from it by the plugin, never leave the Host process. The browser keeps only short-lived relay tickets, which only work through this relay together with your DSH sign-in, and only for as long as the view (and, for control, your control) persists.
- The server decides what the browser is allowed to do. Watching uses a view-only viewer ticket, so input, clipboard and files are refused by the daemon itself; beyond that, only the media messages and calls that the viewer requires in each mode are forwarded by the relay. Only one view holds control at a time, and control ends once that view disappears.
- The plugin's own pages go out with `no-store`, no referrer, and a content security policy that is strict and same-origin.

## Licensing

MIT. The desktop viewer displayed is [Cua](https://github.com/trycua/cua)'s web viewer, which your own cua-spacesd serves at runtime under Cua's FSL-1.1-MIT licence; the plugin here is independent of Cua and neither includes nor redistributes that viewer.
