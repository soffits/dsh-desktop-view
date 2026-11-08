import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { NOTIFY_MODES } from './notify.js'

export const DEFAULT_STATE_FILE = join(tmpdir(), 'dsh-desktop-view', 'control.json')

export const Config = z.object({
  endpoint: z.string().default('http://127.0.0.1:3211')
    .description('Address of cua-spacesd on this machine. Keep it on loopback: the relay sends the env token to it.'),
  tokenFile: z.string().default('/run/cua/env-token')
    .description('File holding the cua-spacesd env token. It stays on the server and is never logged.'),
  maxFps: z.natural().min(1).max(60).default(30)
    .description('Highest frame rate the viewer asks for. Lower it to save CPU and bandwidth.'),
  clipboard: z.boolean().default(true)
    .description('While in control, sync the clipboard between your device and the desktop.'),
  filesRoot: z.string().default('~')
    .description('While in control, the desktop folder you may browse, upload to and download from ("~" is the desktop user\'s home). Empty turns file transfer off.'),
  microphone: z.boolean().default(true)
    .description('While in control, allow sending your microphone to the desktop (when the desktop supports it).'),
  idleSeconds: z.natural().min(10).default(120)
    .description('Control returns to watching after this many seconds without input.'),
  stateFile: z.string().default(DEFAULT_STATE_FILE)
    .description('JSON file showing who controls the desktop ("controller": "user" or null), for the agent\'s scripts to check before acting.'),
  notifyAgent: z.union(NOTIFY_MODES.map(mode => z.const(mode))).default('wake')
    .description('Tell the session the view was opened from when control changes. wake: giving control back wakes the agent when it is running or sent the help link (?help=1), otherwise the note waits; quiet: notes always wait for its next step; off: no notes.'),
})
