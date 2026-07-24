# DEB OS — NEET 2027 Command System

A personal exam-prep command center for NEET 2027, built as a static site.

## Pages
- `index.html` — Landing page: PIN-gated entrance, live countdowns, theme toggle
- `command.html` — Command Center: daily tasks, trackers, subject pages, streaks
- `physics.html` / `chemistry.html` / `biology.html` — Subject dashboards: chapter progress, task creation

## Stack
Plain HTML/CSS/JS, no build step. Fonts via Google Fonts (Chakra Petch, JetBrains Mono).
Data persists in the browser via localStorage — single device, no backend.

## Live site
https://debmalya755.github.io/deb-os-neet-2027/

## JARVIS (voice control)

Hands-free control of the task list, active on every page except the landing screen.

- `jarvis.js` — voice engine: wake word, state machine, command grammar, indicator widget
- `jarvis-debos.js` — data-layer adapter: the only file that knows about `debos.tasks.<date>`

Say **"Jarvis"** (or "wake up, Jarvis"). JARVIS answers *"Yes, sir"*, the corner
indicator brightens, and you have 6 seconds to give a command:

| Say | Effect |
|---|---|
| "start L1" / "start lecture two" / "begin rotational motion" | task → In progress (pauses any other running task) |
| "mark complete" / "finish this" | running task → Completed (auto-flags a blowout if over the timer) |
| "log blowout physics" | flags the running Physics task, same as the Now card button |
| "shelve this" | running PYQ-50 set → Paused |
| "pause" / "cancel" | running task → Paused / reset to Not started |

Nothing said in the window → JARVIS goes quiet on its own. Something unrecognised
→ one short "didn't catch that" and a red flash.

**How it works:** browser-native Web Speech API only — no backend, no cloud
speech service, no AI/LLM call, no third-party SDK. Commands are matched by
explicit keyword patterns, so the same words always do the same thing. Nothing
listens after the tab is closed; no audio or transcript is ever stored.

**Requirements:** Google Chrome, on a computer. Needs microphone permission and
an HTTPS/localhost origin, which the GitHub Pages URL satisfies.

Other browsers do not work and say so instead of failing silently: Firefox has
no speech recognition at all, Brave blocks it by default, and mobile browsers
stop listening as soon as the tab loses focus. In each case JARVIS switches
itself off with a plain-language message and the rest of the site is unaffected.

**If nothing happens:** click the corner dot — it reports what the voice layer
is doing, or why it isn't, in one sentence. Add `?jarvisdebug=1` to the URL to
surface every recognition error in that same corner message, and
`JARVIS.report()` in the console dumps the full detail.

Test bench: `jarvis-demo.html` drives the whole state machine with buttons, no
microphone needed. `node jarvis.test.mjs` runs the headless suite.
