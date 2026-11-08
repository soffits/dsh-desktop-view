# Changelog

## Unreleased

- Live desktop view from cua-spacesd, relayed through DSH's own web server and login.
- Watch by default; take control and give it back; control returns after `idleSeconds` without input or when the viewer disconnects. Enforced on the server.
- Desktop tab in the right sidebar, a session-header button, and a full-screen page at `/desktop-view/` with touch input and `?control=1`.
- Control state file for the agent, and notes to the session the view was opened from when control changes.
