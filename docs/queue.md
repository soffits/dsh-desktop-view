# Queue

Known gaps and leftovers, newest first. Anything here is unfinished work, not a promise in a report.

- The "Desktop control" chat row relies on the chat's `user/message` node shape and exclusive claims of DSH 0.2.2-rc.1; other views of a session (exports, the trajectory view) still show the note's plain text.
- After a daemon restart or token rotation, the first viewer call with the old viewer ticket fails before the relay mints a new one; the viewer then reconnects on its own, but one error toast may show. A transparent retry of unary calls would hide it.
- The watch picture was not seen rendered in headless Chromium (the daemon's own viewer, unrelayed, stays on "Connecting" there too, so this is a headless limit, not the relay); control mode rendered through the relay. Confirm watch in a real browser.
- Sound stops while the Desktop tab is hidden, because the paused tab unloads the viewer. Keeping audio alone would need a second, audio-only stream.
- The header button has no pressed state and no keyboard shortcut. The sidebar exposes no layout subscription in 0.2.2-rc.1, so a shortcut and a pressed state wait for an API that reports the open tab.
- The full-screen page does not say which view took control over when it is replaced.
- `test/live.test.js` only runs where `cua-spacesd` and its token file exist; CI skips it. A CI job with the Cua image would close that gap.
- The relay does not check the daemon's version; if Cua changes the viewer's page or calls, the shim insertion fails loudly (502) and an unlisted method gets 403. A version check could say so up front.
