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
- `jarvis-offline.js` — replacement ear for browsers that block browser speech (Brave, Firefox)

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

**How it works:** no backend and no LLM anywhere. Commands are matched by
explicit keyword patterns, so the same words always do the same thing. Nothing
listens after the tab is closed, and no audio or transcript is stored — the text
goes straight to the state machine and is discarded. Recognition itself comes
from the browser in Chrome, or from a local model in Brave/Firefox (below).

**Requirements:** microphone permission and an HTTPS/localhost origin, which the
GitHub Pages URL satisfies. Chrome uses its built-in recognition and needs
nothing else.

### Brave and Firefox — the offline engine

Brave deliberately blocks browser speech recognition (Google's speech service is
licensed to Chrome only, and Brave won't send your audio to it); Firefox never
implemented it. There is no setting to turn on in either.

So in those browsers JARVIS swaps its ear for `jarvis-offline.js`, which listens
to the microphone directly and transcribes with a small speech model
(Whisper tiny, English) running inside the page. Tap the corner dot once to
switch it on. What that costs, plainly:

- a one-time ~40MB model download per browser, then it works with no internet at all
- slower: transcription starts when you stop speaking, and takes ~0.3–2s
- more battery, since the model runs on your own CPU (or GPU where WebGPU exists)
- a bit less accurate than Chrome on unusual words

Nothing is ever uploaded — the audio never leaves the machine, which is more
private than Chrome's cloud recognition. Wake word, commands and actions are
identical either way; only the ear changes. It stays completely dormant in
Chrome, so Chrome users download nothing.

Mobile browsers stop listening as soon as the tab loses focus. Nothing can be
done about that from a web page.

**If nothing happens:** click the corner dot — it reports what the voice layer
is doing, or why it isn't, in one sentence. Add `?jarvisdebug=1` to the URL to
surface every recognition error in that same corner message, and
`JARVIS.report()` in the console dumps the full detail.

Test bench: `jarvis-demo.html` drives the whole state machine with buttons, no
microphone needed. Headless suites (163 assertions, no browser required):

```
node jarvis.test.mjs           # engine: wake word, states, grammar, failure paths
node jarvis-debos.test.mjs     # integration: what actually lands in localStorage
node jarvis-offline.test.mjs   # offline engine: VAD segmenter, junk filter, ear swap
```
