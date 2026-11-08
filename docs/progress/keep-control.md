# Progress: keep control while the Desktop tab is hidden (OWNER-3)

Goal: hiding the Desktop tab must not give control back; control lasts until Give back, idle timeout, or the view really closes.

## Done

- Chosen: keep the view (status socket, grant, control), unload only the viewer frame while hidden, reload it with the same grant when shown (CPU: no encoding or decoding for a hidden tab). Recorded in docs/decisions.md.
- `viewer/session.js`: `pause()` / `resume()`; grants that arrive while paused are shown on resume.
- `client.js`: tab type `keepMounted: true`; the view is created per mount, visibility only pauses/resumes.
- Tests: `test/session.test.js` (pause keeps the socket and control, resume shows the same grant, destroy closes with 1000), `test/client.test.js` asserts `keepMounted`.
- README, decisions, queue, CHANGELOG (Unreleased).

## Next

- Push, open PR, wait for CI, delete this file before the PR is final.
