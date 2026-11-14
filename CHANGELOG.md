# Changelog

## Unreleased

- The status bar (Watching / In control) can no longer be highlighted like selected page text.
- Giving control back wakes the agent only when it has to carry on: it is running, or the view came from its help link (`?help=1`); otherwise the note waits quietly. Taking control never starts a turn.
- Control notes show in the chat as a "Desktop control" row instead of the generic "Execution requested", and are shorter.
- Hiding the Desktop tab (another sidebar tab, a collapsed sidebar, another session) no longer gives control back: the view and its control stay, and the stream pauses until the tab is shown again.

## 0.2.0

- Live desktop view from cua-spacesd, relayed through DSH's own web server and login, shown with Cua's own web viewer.
- Watch by default, with sound; Take control and Give back; control returns after `idleSeconds` without input or when the view closes. Enforced on the server with per-mode daemon tickets and allow-lists.
- While in control: mouse, keyboard and touch, clipboard both ways, file upload and download (`filesRoot`), display choice, scaling, microphone where supported.
- Desktop tab in the right sidebar, a session-header button with a tooltip like its neighbours', and a full-screen page at `/desktop-view/` with `?control=1`.
- Control state file for the agent, and notes to the session the view was opened from when control changes.
