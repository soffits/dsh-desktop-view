import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { NOTIFY_MODES } from './notify.js'

export const DEFAULT_STATE_FILE = join(tmpdir(), 'dsh-desktop-view', 'control.json')

export const Config = z.object({
  endpoint: z.string().default('http://127.0.0.1:3211')
    .description('Address of cua-spacesd on this machine. Keep it on loopback: the relay sends the env token to it.'),
  tokenFile: z.string().default('/run/cua/env-token')
    .description('File holding the cua-spacesd env token. It is read for every stream, stays on the server and is never logged.'),
  display: z.string().default('primary')
    .description('Display to stream: a display id from cua-spacesd, or "primary".'),
  maxFps: z.natural().min(1).max(60).default(15)
    .description('Highest frame rate of the stream. Lower it to save CPU and bandwidth.'),
  maxDimension: z.natural().default(0)
    .description('Longest edge of the stream in pixels; 0 streams the native size.'),
  bitrateKbps: z.natural().default(0)
    .description('H.264 bitrate in kbit/s (250 to 100000); 0 uses the encoder default.'),
  idleSeconds: z.natural().min(10).default(120)
    .description('Control returns to watching after this many seconds without input.'),
  stateFile: z.string().default(DEFAULT_STATE_FILE)
    .description('JSON file showing who controls the desktop ("controller": "user" or null), for the agent\'s scripts to check before acting.'),
  notifyAgent: z.union(NOTIFY_MODES.map(mode => z.const(mode))).default('wake')
    .description('Tell the session the view was opened from when control changes. wake: giving control back wakes the agent; quiet: notes wait for its next step; off: no notes.'),
})
