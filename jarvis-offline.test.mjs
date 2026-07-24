/**
 * jarvis-offline.test.mjs — tests for the offline speech engine's logic.
 * Run:  node jarvis-offline.test.mjs
 *
 * WHAT THIS CAN AND CANNOT PROVE
 * ------------------------------
 * Testable here, and tested: the voice-activity segmenter (where an utterance
 * starts and stops), the hallucination filter that stops Whisper's invented
 * text reaching the command matcher, the decision about whether this engine is
 * needed at all, and the engine-swap plumbing in jarvis.js — including that a
 * fake external recogniser can drive real commands end to end and that the
 * microphone is released on tab close.
 *
 * NOT testable here: the microphone, AudioWorklet, WebGPU/WASM, the model
 * download, and Whisper's actual accuracy. Those need a real browser with a
 * real mic. They must be checked by hand in Brave.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const DIR = import.meta.dirname;
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- load jarvis-offline.js in a Node-ish context ----------
 * No document/navigator, so it stops right after exporting its pure logic —
 * which is itself the first thing worth asserting: the file must not explode
 * outside a browser.                                                        */
const offlineSrc = fs.readFileSync(path.join(DIR, 'jarvis-offline.js'), 'utf8');
const pure = { console, setTimeout, clearTimeout, Math, Object, String, Number, Float32Array, JSON };
pure.window = pure; pure.globalThis = pure;
vm.createContext(pure);
let threw = null;
try { vm.runInContext(offlineSrc, pure, { filename: 'jarvis-offline.js' }); } catch (e) { threw = e; }

console.log('\nJARVIS offline engine — logic tests\n');
console.log('loading');
ok(!threw, 'loads without a browser present (exports pure logic only)', threw && threw.message);
const { Segmenter, cleanTranscript, CFG } = pure.JARVIS_OFFLINE_INTERNALS || {};
ok(typeof Segmenter === 'function' && typeof cleanTranscript === 'function',
   'exposes Segmenter + cleanTranscript for testing');

/* ================= voice activity segmentation ========================= */
console.log('\nsegmenter (finding utterances in a stream of frame energies)');
{
  const cfg = Object.assign({}, CFG, { frameMs: 32 });
  const quiet = 0.002, loud = 0.09;

  // helper: run a script of [level, frames] pairs through the segmenter
  function run(script, c = cfg) {
    const segs = [];
    const seg = new Segmenter(c, (s) => segs.push(s));
    let idx = 0;
    for (const [level, frames] of script) {
      for (let i = 0; i < frames; i++) seg.push(level, idx++);
    }
    return { segs, frames: idx, seg };
  }

  // 1s room noise, then ~600ms of speech, then 800ms silence
  let r = run([[quiet, 31], [loud, 19], [quiet, 25]]);
  ok(r.segs.length === 1, 'one utterance detected', 'got ' + r.segs.length);
  ok(r.segs[0].reason === 'silence', '  → ended by the silence hangover');
  ok(r.segs[0].durationMs >= 600, '  → includes pre-roll so the first word isn’t clipped',
     r.segs[0].durationMs + 'ms');

  // Silence only — nothing should ever be emitted.
  r = run([[quiet, 200]]);
  ok(r.segs.length === 0, 'pure silence produces nothing');

  // A single loud blip (a cough / door slam) is below startFrames.
  r = run([[quiet, 30], [loud, 2], [quiet, 40]]);
  ok(r.segs.length === 0, 'a 64ms blip is ignored, not transcribed');

  // Two sentences separated by a clear pause → two utterances.
  r = run([[quiet, 31], [loud, 15], [quiet, 25], [loud, 15], [quiet, 25]]);
  ok(r.segs.length === 2, 'two sentences with a pause between → two utterances',
     'got ' + r.segs.length);

  // Someone rambling past the cap gets cut at maxUtteranceMs. Real speech has
  // micro-pauses, so this script dips quiet for one frame now and then.
  const rambling = [[quiet, 31]];
  for (let i = 0; i < 20; i++) { rambling.push([loud, 20]); rambling.push([quiet, 1]); }
  r = run(rambling);
  ok(r.segs.length >= 1 && r.segs[0].reason === 'max-length',
     'endless speech is force-cut at the max length');
  ok(r.segs[0].durationMs <= CFG.maxUtteranceMs + CFG.preRollMs + 400,
     '  → and the clip stays within the model’s comfort zone', r.segs[0].durationMs + 'ms');

  // A noisy room should raise the bar rather than fire constantly.
  const noisy = 0.02;
  r = run([[noisy, 120]]);
  ok(r.segs.length === 0, 'steady background noise adapts the threshold instead of triggering');
  ok(r.seg.threshold() > noisy, '  → noise floor learned during warm-up',
     r.seg.threshold().toFixed(4));

  // ...but real speech above that noise still registers.
  r = run([[noisy, 60], [noisy * 8, 20], [noisy, 30]]);
  ok(r.segs.length === 1, 'speech louder than the noise floor still gets through',
     'got ' + r.segs.length);

  // Machinery: energy that never once pauses is not a person, and must not be
  // handed to the model every nine seconds forever.
  r = run([[quiet, 31], [0.05, 400]]);
  ok(r.segs.length === 0, 'unbroken continuous noise is discarded, not transcribed');
  ok(r.seg.threshold() > 0.05, '  → and the floor relearns from it so it stops registering',
     r.seg.threshold().toFixed(4));
}

/* ================= hallucination filter ================================ */
console.log('\ntranscript cleanup (Whisper invents text when given noise)');
{
  const dropped = ['[BLANK_AUDIO]', '(silence)', 'Thank you.', 'Thanks for watching!',
                   'you', '*coughs*', '  ', 'Ok', 'um', '.', 'Music'];
  for (const junk of dropped) {
    ok(cleanTranscript(junk) === '', `drops ${JSON.stringify(junk)}`);
  }
  const kept = [
    ['Jarvis', 'Jarvis'],
    ['jarvis.', 'jarvis.'],
    ['Start the L1 task.', 'Start the L1 task.'],
    ['[noise] mark complete', 'mark complete'],
    ['log blowout physics', 'log blowout physics']
  ];
  for (const [input, expected] of kept) {
    ok(cleanTranscript(input) === expected, `keeps ${JSON.stringify(input)}`,
       'got ' + JSON.stringify(cleanTranscript(input)));
  }
}

/* ================= engine swap inside jarvis.js ======================== */
console.log('\nengine swap (jarvis.js driven by an external recogniser)');
{
  const byId = {};
  function makeEl() {
    const el = {
      id: '', className: '', innerHTML: '', textContent: '', style: {}, children: [], offsetWidth: 1,
      classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
      appendChild(c) { this.children.push(c); if (c.id) byId[c.id] = c; return c; },
      querySelector() { return makeEl(); }, getAttribute() { return null; },
      addEventListener(t, f) { (this.handlers = this.handlers || {})[t] = f; }
    };
    return el;
  }
  const indicator = makeEl();
  const document = {
    readyState: 'complete', visibilityState: 'visible',
    head: makeEl(), documentElement: makeEl(), body: makeEl(),
    createElement: makeEl,
    getElementById: (id) => (id === 'jarvis-indicator' ? indicator : null),
    addEventListener() {}
  };

  // Brave's exact failure shape: the API object exists, navigator.brave is set.
  class InertSR {
    static made = 0;
    constructor() { InertSR.made++; }
    start() { throw new Error('should never be started in Brave'); }
    abort() {} stop() {}
  }

  const spoken = [];
  const actions = [];
  const winEvents = {};
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    document,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36', brave: { isBrave() {} } },
    SpeechRecognition: InertSR,
    speechSynthesis: { speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); }, cancel() {}, getVoices: () => [] },
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    DEBOS: {
      getCurrentTasks: () => [{ id: 'L1', name: 'Lecture 1', subject: 'Physics', type: 'lecture', active: true, aliases: [] }],
      getActiveTasks: () => [{ id: 'L1', name: 'Lecture 1', subject: 'Physics', type: 'lecture', active: true, aliases: [] }],
      getActivePYQSet: () => null,
      getTaskById: (id) => ({ id, name: 'Lecture 1' }),
      startTask: (id) => { actions.push(['startTask', id]); return true; },
      markComplete: (id) => { actions.push(['markComplete', id]); return true; },
      logBlowout: (s, t) => { actions.push(['logBlowout', s, t]); return true; },
      shelvePYQSet: (id) => { actions.push(['shelvePYQSet', id]); return true; },
      pauseTask: (id) => { actions.push(['pauseTask', id]); return true; },
      cancelTask: (id) => { actions.push(['cancelTask', id]); return true; }
    },
    addEventListener: (t, f) => { (winEvents[t] = winEvents[t] || []).push(f); }
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'jarvis.js'), 'utf8'), sb, { filename: 'jarvis.js' });
  const J = sb.JARVIS;
  J.config.awakeWindowMs = 400;
  J.config.postSpeechMuteMs = 15;

  ok(InertSR.made === 0, 'Brave detected → the inert built-in recogniser is never started');
  ok(/offline voice engine/i.test(J.diagnose()), 'while waiting, it says the offline engine is starting',
     J.diagnose());

  // A stand-in for jarvis-offline.js.
  let started = 0, stopped = 0, enabled = 0, ready = false;
  const fakeEngine = {
    name: 'test-engine',
    start() { started++; return true; },
    stop() { stopped++; return true; },
    enable() { enabled++; ready = true; },
    status() { return { ready, loading: false, message: ready ? null : 'Tap to enable.' }; }
  };
  ok(J.useExternalRecognizer(fakeEngine) === true, 'external recogniser installs');
  ok(J.getState().state === 'PASSIVE', '  → JARVIS comes out of limbo into PASSIVE');
  ok(J.report().engine === 'test-engine', '  → report() names the engine in use');

  // The dot is the enable gesture (mic + download are opt-in).
  indicator.handlers.click();
  ok(enabled === 1, 'tapping the indicator asks the engine to enable itself');

  J.start();
  ok(started >= 1, 'JARVIS.start() drives the external engine, not the built-in one');

  // Now the real point: transcripts from the engine must work exactly like
  // browser recognition did.
  await (async () => {
    J.ingest('jarvis');
    ok(J.getState().state === 'AWAKENED' && spoken[0] === 'Yes, sir',
       'ingested wake word wakes it and it answers');
    for (let i = 0; i < 40 && J.getState().muted; i++) await sleep(20);
    J.ingest('mark complete');
    await sleep(60);
    ok(JSON.stringify(actions[0]) === JSON.stringify(['markComplete', 'L1']),
       'ingested command runs the real action', JSON.stringify(actions));
  })();

  // Self-hearing guard must apply to the offline path too.
  spoken.length = 0; actions.length = 0;
  J.ingest('jarvis');
  ok(J.ingest('start lecture 1') === false, 'transcripts arriving while it speaks are refused');
  ok(actions.length === 0, '  → nothing executed from its own voice');

  // Tab close must release the microphone the engine holds.
  const before = stopped;
  (winEvents.beforeunload || []).forEach(f => f());
  ok(stopped > before, 'tab close stops the external engine (releases the mic)');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
