# dsh-desktop-view

A DeepSeek Harness (DSH) plugin that shows the agent machine's live desktop inside the DSH Web UI and lets the signed-in user take control. It relays the desktop stream and viewer of `cua-spacesd` (Cua's in-guest daemon) through DSH's own web server and login; the daemon's env token stays on the server.

## Working on the project

- Everything in the repo (code, docs, commits) is English, except translations and files deliberately in another language.
- Ordinary implementation choices are yours: decide, write the choice and its one-line reason under the right system group of `docs/decisions.md` (replacing any line it supersedes, no dates), and mention it in your report. Product decisions (what players get, direction, scope, taste) belong to the maintainers and live in `docs/roadmap.md` only; ask about those.
- If a requested approach looks weaker than an alternative, say so with the reason before building it.
- Report each state separately: implemented, tested (which checks, which real run), committed, pushed, CI. Say plainly what was not verified.
- Commit on a branch as you go. Merge to `main`, tag, release or publish only when the task asks for it.
- Work only in this checkout, on the current branch. Make no folders or worktrees outside it; builds people test come from the build's own output folder, given by path. Temporary files go under the build folder or a git-ignored path and are removed when done.

## Delegating to subagents

Do the work yourself, in your own session, by default: design, code, fixes and review. A subagent starts cold, re-reads what you already know and hands back a summary you must check, so it usually costs more than it saves. Hand off only work that is simple and would burn your context for little (a mechanical sweep over many files, a long log to search, a bulk rename), to a smaller, cheaper model that fits the job.

- A brief says what and why, not how: the goal, the decisions that apply, the non-obvious constraints, which files it owns, the checks that decide "done", and a progress file to write early and update after each step. Leave out methods nobody chose, so a capable model can find a better way.
- When you do hand off, parallel subagents only on disjoint files. Each shared helper has one owner; tell the others to use it or wait for it.
- A subagent's summary is a claim. Read its diff and rerun the checks before building on it.
- If a review is asked for, the reviewer is at least as strong as the writer (a weaker reviewer makes strong code worse) and marks each finding *likely* (hits ordinary use: data loss, crash, wrong result) or *rare* (hostile input, odd timing, limits nobody reaches). Fix the likely ones with a regression test; put rare ones in `docs/queue.md` unless the fix is cheap and local.

## Long work

- Any run can be cut off (limits, restarts, context compaction). For work longer than a few steps, keep `docs/progress/<task>.md`: the goal, what is done, decisions, what is next. Update it after each meaningful step so a fresh session resumes without redoing work. End it with `## Final` (what was done, checked, left over). It is a working note: when the work merges, move what lasts into the decisions and queue docs and delete the file.
- Finish the whole goal in one run. Don't end your turn to "wait" for something while work remains you can do.
- Leftovers and known bugs go into `docs/queue.md` the moment you find them, not into a promise in your report.

## Before building

- Before writing any non-trivial component, search the community and current research for maintained libraries and better approaches. Check the licence (MIT/Apache/BSD/CC0 to ship; GPL, non-commercial and unlicensed work only as ideas, reimplemented), upkeep, and that it runs on our versions. Adopt, adapt or write our own, and record why in `docs/decisions.md`.
- Take versions of languages, tools, frameworks and dependencies from current official sources, not memory; they change faster than training data.

## Code

- No backward compatibility while the project has no users: when a format or name changes, change it everywhere and delete the old one.
- Few general mechanisms, no special cases. When something breaks, fix the shared layer or the data, not the one call site. No hard-coded lists of names, no matching on error text, hostnames or model names as a substitute for a real signal.
- Define each list, limit or constant once and derive variants from it.
- Reproduce a bug before fixing it; a confident guess from reading code is often wrong. If two fixes built on one assumption fail, the assumption is the bug.
- CI is where tests run. Locally, compile and run only a quick check you need while writing; push the branch and let CI run the suites.
- Keep CI time low. CI runs on pull requests and `main`, not on every branch push. One release is one branch and one pull request (no stacked PRs per feature). Commit locally as often as you like; push and open the PR when the first sizeable part compiles, keep working on the same branch, and push the next batch when ready (a newer push cancels the older run). Don't sit watching a run (no sleep-and-poll loops): keep working and check its result between steps; when nothing but the CI result is left, say so in your report and end the turn. Never wait on a test run: if a local run is truly needed (a failure CI can't explain), run it in the background, keep writing code, and fix what it reports when it ends. Write each check once, at the cheapest level that can see it (unit test when no running game or server is needed, an integration or game test only for what needs one, a client or screenshot test only for what needs the screen), and extend an existing test before adding one that repeats its setup. Docs-only changes start no run (`paths-ignore` on both triggers), but GitHub judges a pull request by its whole diff, so push docs and progress notes together with the next code batch, never alone to a PR that has code.
- If a test can't pass, explain why in the progress file. Never loosen or move an assertion to make it green.
- Split a file by responsibility before it grows past about 500 lines (generated code and static data excepted).
- No dead code, commented-out code or bare `TODO`; unfinished work is in `docs/queue.md`.
- README and other public docs are for users. Notes for maintainers and agents go here or in `docs/`.

## Git

- Conventional Commits, one-line subjects, a body only when the why isn't obvious. The repo's local author identity is set on purpose; never override it.
- Squash merges by default. Whoever merges a branch deletes it, local and remote, in the same step (`gh pr merge --squash --delete-branch`), removes its worktree and runs `git fetch --prune`; only `main` and the current release branch stay.
- In GitHub Actions, reference well-known actions by major tag (`@v5`), not by commit SHA.
- Releases: move the `Unreleased` part of `CHANGELOG.md` under the new version's heading (English), bump the version, squash-merge to `main` with a Conventional Commit subject (`feat: <summary> (vX.Y.Z)`), and once CI is green on that commit push the tag `vX.Y.Z`; the release workflow builds and publishes with that section as the description, without rerunning tests. Don't name a working branch exactly like the tag: `git push origin vX.Y.Z` then fails as ambiguous (use `refs/tags/vX.Y.Z`).
