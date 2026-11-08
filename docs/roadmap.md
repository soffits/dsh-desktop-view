# Roadmap

Product decisions belong to the maintainers. This file records what was decided and what is open.

## v1 (decided)

- Live view of the agent machine's desktop inside the DSH Web UI, relayed from cua-spacesd behind DSH's own login. No new ports, subdomains or image changes.
- Watch by default; take control on demand; control returns to watching after a period without input and when the viewer disconnects. Enforced on the server.
- A session-header button and a right-sidebar tab (also in the sidebar guide), plus a full-screen page that works on a phone and can be linked directly, with an option that opens it in control mode.
- The agent can see who controls the desktop (a JSON state file) and is told when control is given back.

## v2 (decided)

- The owner confirmed v1's flow in the live UI and keeps it: watch by default, Take control / Give back, the status label.
- Add everything the desktop daemon offers: audio, clipboard both ways, file upload and download, displays and windows, scaling, presence.

## Not planned

- Sending links over Telegram (the agent sends links itself).

## Open

- Whether a later version should offer a quality selector for weak mobile links, after the first real phone test.
