# Queue

Known gaps and leftovers, newest first. Anything here is unfinished work, not a promise in a report.

- The header button has no pressed state and no keyboard shortcut. The sidebar exposes no layout subscription in 0.2.2-rc.1, so a shortcut (`workspace.desktop`) and a guide-entry command id wait for an API that reports the open tab.
- The viewer has no audio, clipboard sync, or quality selector. Audio is out of v1 scope; a quality selector should follow the first real phone test (the `bitrateKbps` and `maxDimension` settings cover the same ground more slowly).
- The full-screen page and the sidebar tab cannot share control; opening a second one takes control from the first with reason `replaced`. That is deliberate (one mouse), but the page does not yet say who took it over.
- `test/live.test.js` only runs where `cua-spacesd` and its token file exist; CI skips it. A CI job with the Cua image would close that gap.
- The daemon reports `build_revision` 0.13.0 while the container ships cua-spacesd 0.12.7; the relay reads neither, but a version check could turn "the wire changed" into a clear error instead of a blank picture.
- Nothing has been exercised in the real DSH Web UI yet: the sidebar tab, the header button, the guide card and the full-screen page are unverified beyond unit tests, because installing the bundle changes the shared profile and needs the owner's approval.
