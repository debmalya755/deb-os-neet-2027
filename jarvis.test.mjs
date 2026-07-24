/**
 * jarvis.test.mjs — headless verification of the JARVIS state machine.
 * Run:  node jarvis.test.mjs
 *
 * Mocks SpeechRecognition + speechSynthesis + a minimal DOM so the whole voice
 * layer can be exercised with no browser and no microphone.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/* ---------- minimal DOM mock ---------- */
const byId = {};
function makeEl(tag) {
  const el = {
    tagName: tag, id: '', className: '', innerHTML: '', textContent: '',
    style: {}, children: [], offsetWidth: 1,
    classList: {
      s: new Set(),
      add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); },
      contains(c) { return this.s.has(c); }
    },
    appendChild(c) { this.children.push(c); if (c.id) byId[c.id] = c; return c; },
    querySelector() { return makeEl('span'); },
    addEventListener() {}
  };
  return el;
}
const docEvents = {};
const document = {
  readyState: 'complete', visibilityState: 'visible',
  head: makeEl('head'), documentElement: makeEl('html'), body: makeEl('body'),
  createElement: makeEl,
  getElementById: (id) => byId[id] || null,
  addEventListener: (t, f) => { (docEvents[t] = docEvents[t] || []).push(f); }
};

/* ---------- SpeechRecognition mock ---------- */
class MockSR {
  static instances = []; static startCount = 0; static abortCount = 0;
  constructor() { MockSR.instances.push(this); this.started = false; }
  start() {
    if (this.started) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
    this.started = true; MockSR.startCount++; this.onstart && this.onstart();
  }
  stop() { this.started = false; this.onend && this.onend(); }
  abort() { MockSR.abortCount++; const was = this.started; this.started = false; if (was) this.onend && this.onend(); }
  hear(text, isFinal = true) {
    const res = [{ transcript: text }]; res.isFinal = isFinal;
    this.onresult && this.onresult({ resultIndex: 0, results: [res] });
  }
  fail(code) { this.onerror && this.onerror({ error: code }); }
}

/* ---------- speechSynthesis mock ---------- */
const spoken = [];
class MockUtterance { constructor(t) { this.text = t; } }
const speechSynthesis = {
  speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); },
  cancel() {}, getVoices() { return []; }
};

/* ---------- fake DEB OS data layer ---------- */
const calls = [];
const TASKS = [
  { id: 'L1', name: 'Lecture 1', subject: 'Physics',   type: 'lecture', active: false, aliases: ['rotational motion'] },
  { id: 'L2', name: 'Lecture 2', subject: 'Chemistry', type: 'lecture', active: false, aliases: ['mole concept'] },
  { id: 'P1', name: 'PYQ Set 1', subject: 'Biology',   type: 'pyq',     active: false, aliases: ['genetics'] }
];
const setActive = (...i) => TASKS.forEach((t, idx) => { t.active = i.includes(idx); });
const DEBOS = {
  getCurrentTasks: () => TASKS,
  getTaskById: (id) => TASKS.find(t => t.id === id) || null,
  getActiveTasks: () => TASKS.filter(t => t.active),
  getActivePYQSet: () => TASKS.find(t => t.active && t.type === 'pyq') || null,
  startTask:    (id) => { calls.push(['startTask', id]); return true; },
  markComplete: (id) => { calls.push(['markComplete', id]); return true; },
  logBlowout:   (s, t) => { calls.push(['logBlowout', s, t]); return true; },
  shelvePYQSet: (id) => { calls.push(['shelvePYQSet', id]); return true; },
  pauseTask:    (id) => { calls.push(['pauseTask', id]); return true; },
  cancelTask:   (id) => { calls.push(['cancelTask', id]); return true; }
};

/* ---------- load the module ---------- */
const src = fs.readFileSync(path.join(import.meta.dirname, 'jarvis.js'), 'utf8');
const winEvents = {};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date,
  document, DEBOS,
  SpeechRecognition: MockSR, speechSynthesis, SpeechSynthesisUtterance: MockUtterance,
  addEventListener: (t, f) => { (winEvents[t] = winEvents[t] || []).push(f); }
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'jarvis.js' });
const J = sandbox.JARVIS;

/* ---------- tiny assertion harness ---------- */
let pass = 0, fail = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}
const sr = () => MockSR.instances[MockSR.instances.length - 1];
async function settled() {                 // wait until the recogniser is un-muted
  for (let i = 0; i < 80; i++) {
    if (!J.getState().muted) return;
    await sleep(25);
  }
}
function reset() { spoken.length = 0; calls.length = 0; }

/* ---------- tests ---------- */
J.config.awakeWindowMs = 600;              // keep the suite fast
J.config.postSpeechMuteMs = 20;

console.log('\nJARVIS v' + J.version + ' — headless verification\n');

console.log('boot');
ok(J.supported === true, 'feature detection: SpeechRecognition found');
ok(J.getState().state === 'PASSIVE', 'boots into PASSIVE');
ok(MockSR.startCount >= 1, 'recognition auto-started');

console.log('\npassive state ignores non-wake speech');
for (const junk of ['i should probably revise thermodynamics tonight',
                    'captain']) {          // old wake word is retired
  reset();
  sr().hear(junk);
  ok(J.getState().state === 'PASSIVE', `"${junk}" leaves it PASSIVE`);
  ok(spoken.length === 0, '  → says nothing');
}

console.log('\nwake words');
for (const phrase of ['jarvis', 'wake up jarvis', 'wake up, jarvis', 'Jarvis!', 'hey travis']) {
  reset();
  sr().hear(phrase);
  ok(J.getState().state === 'AWAKENED' && spoken[0] === 'Yes, sir', `"${phrase}" → AWAKENED + "Yes, sir"`);
  await settled();
  await sleep(J.config.awakeWindowMs + 60);      // let the window lapse
  ok(J.getState().state === 'PASSIVE', `  → silent timeout back to PASSIVE`);
  ok(spoken.length === 1, '  → no timeout voice line');
}

console.log('\nself-hearing guard');
reset();
sr().hear('jarvis');
sr().hear('start L1');                            // arrives while still speaking
ok(calls.length === 0, 'transcripts during synthesis are dropped');
await settled();
sr().hear('Yes, sir');                            // echo of its own voice
ok(calls.length === 0, 'echo of own voice is dropped');
await sleep(J.config.awakeWindowMs + 60);

console.log('\nre-trigger guard');
reset();
sr().hear('jarvis');
await settled();
sr().hear('jarvis jarvis');
ok(spoken.filter(s => s === 'Yes, sir').length === 1, 'extra wake words do not restart the cycle');
await sleep(J.config.awakeWindowMs + 60);

console.log('\ncommands');
const cases = [
  ['start the L1 task',                    ['startTask', 'L1'],                       /Starting Lecture 1/],
  ['start lecture two',                    ['startTask', 'L2'],                       /Starting Lecture 2/],
  ['begin rotational motion',              ['startTask', 'L1'],                       /Starting/],
  ['log blowout physics rotational motion',['logBlowout', 'Physics', 'rotational motion'], /Logged, Physics blowout/],
  ['blowout chemistry',                    ['logBlowout', 'Chemistry', null],         /Logged, Chemistry blowout/],
  ['log a blowout for biology',            ['logBlowout', 'Biology', null],           /Logged, Biology blowout/],
  ['physics blowout',                      ['logBlowout', 'Physics', null],           /Logged, Physics blowout/]
];
for (const [utterance, expected, saidRe] of cases) {
  reset(); setActive();
  sr().hear('jarvis'); await settled();
  sr().hear(utterance); await sleep(60); await settled();
  const c = calls[0] || [];
  ok(JSON.stringify(c) === JSON.stringify(expected),
     `"${utterance}" → ${expected[0]}(${expected.slice(1).join(', ')})` +
     (JSON.stringify(c) === JSON.stringify(expected) ? '' : `  got ${JSON.stringify(c)}`));
  ok(saidRe.test(spoken.join(' | ')), `  → confirmation "${spoken[spoken.length - 1]}"`);
  await sleep(80);
  ok(J.getState().state === 'PASSIVE', '  → returns to PASSIVE');
}

console.log('\ntarget inference');
reset(); setActive(0);
sr().hear('jarvis'); await settled();
sr().hear('mark complete'); await sleep(60); await settled();
ok(JSON.stringify(calls[0]) === JSON.stringify(['markComplete', 'L1']), 'single active task inferred for "mark complete"');
await sleep(80);

reset(); setActive(2);
sr().hear('jarvis'); await settled();
sr().hear('shelve this'); await sleep(60); await settled();
ok(JSON.stringify(calls[0]) === JSON.stringify(['shelvePYQSet', 'P1']), 'active PYQ set inferred for "shelve this"');
await sleep(80);

reset(); setActive();
sr().hear('jarvis'); await settled();
sr().hear('finish this'); await sleep(60); await settled();
ok(calls.length === 0 && /Nothing is active/.test(spoken.join(' ')), 'no active task → "Nothing is active, sir"');
await sleep(80);

console.log('\nclarification when ambiguous');
reset(); setActive(0, 1);
sr().hear('jarvis'); await settled();
sr().hear('mark complete'); await sleep(60); await settled();
ok(/Which one, sir/.test(spoken.join(' ')), 'two active tasks → asks which one');
ok(calls.length === 0, 'nothing executed before the answer');
sr().hear('the second one'); await sleep(60); await settled();
ok(JSON.stringify(calls[0]) === JSON.stringify(['markComplete', 'L2']), 'ordinal answer resolves to L2');
await sleep(120);

reset(); setActive(0, 1);
sr().hear('jarvis'); await settled();
sr().hear('pause'); await sleep(60); await settled();
sr().hear('lecture one'); await sleep(60); await settled();
ok(JSON.stringify(calls[0]) === JSON.stringify(['pauseTask', 'L1']), 'name answer resolves to L1');
await sleep(120);

console.log('\nfailed matches (reported when the window closes, not eagerly)');
const junkCases = [
  ['make me a sandwich', /didn’t catch a valid command/],
  ['what is the time',   /didn’t catch a valid command/],
  ['start',              /didn’t catch which task/],
  ['blow out',           /Which subject/]
];
for (const [junk, re] of junkCases) {
  reset(); setActive();
  sr().hear('jarvis'); await settled();
  sr().hear(junk);
  await sleep(J.config.awakeWindowMs + 80); await settled();
  const said = spoken.join(' | ');
  ok(calls.length === 0, `"${junk}" executes nothing`);
  ok(re.test(said), `  → spoken: "${spoken[spoken.length - 1]}"`);
  await sleep(120);
  ok(J.getState().state === 'PASSIVE', '  → back to PASSIVE');
}

console.log('\ncommand split across two recognition chunks');
reset(); setActive();
sr().hear('jarvis'); await settled();
sr().hear('start');            await sleep(30);
sr().hear('the l1 task');      await sleep(60); await settled();
ok(JSON.stringify(calls[0]) === JSON.stringify(['startTask', 'L1']), 'buffer accumulates within the window');
await sleep(120);

console.log('\nauto-restart loop');
const before = MockSR.startCount;
sr().stop();                                   // simulate Chrome's silent stop
await sleep(J.config.restartDelayMs + 400);
ok(MockSR.startCount > before, 'recognition restarts itself after onend');

console.log('\ntab lifecycle');
const beforeVis = MockSR.startCount;
document.visibilityState = 'hidden';
(docEvents.visibilitychange || []).forEach(f => f());
ok(J.getState().listening === true, 'visibilitychange does NOT stop recognition');
ok(MockSR.startCount === beforeVis, 'and does not need a restart while healthy');

console.log('\nmicrophone denied');
reset();
sr().fail('not-allowed');
await sleep(30);
ok(J.getState().state === 'DISABLED', 'permission denied → DISABLED');
ok(byId['jarvis-notice'] && /microphone permission/i.test(byId['jarvis-notice'].textContent),
   'non-blocking notice explains the mic in plain language (no alert/popup)');
ok(/Microphone permission was refused/i.test(J.diagnose()),
   'diagnose() reports the reason for a click on the dot');
const afterDenied = MockSR.startCount;
await sleep(J.config.watchdogIntervalMs > 500 ? 600 : 600);
ok(MockSR.startCount === afterDenied, 'no restart storm after denial');

console.log('\ntab unload');
const abortsBefore = MockSR.abortCount;
(winEvents.beforeunload || []).forEach(f => f());
ok(MockSR.abortCount > abortsBefore || J.getState().listening === false, 'recognition aborted on unload');
sr().hear('jarvis');
ok(J.getState().state !== 'AWAKENED', 'no listening state survives unload');

console.log('\nrepeated network failures (Brave-style blocked speech service)');
{
  // Fresh context so the earlier permission denial doesn't mask this path.
  const sb2 = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date,
                document, DEBOS, SpeechRecognition: MockSR, speechSynthesis,
                SpeechSynthesisUtterance: MockUtterance, addEventListener: () => {} };
  sb2.window = sb2; sb2.globalThis = sb2;
  vm.createContext(sb2);
  vm.runInContext(src, sb2, { filename: 'jarvis.js' });
  const r = MockSR.instances[MockSR.instances.length - 1];
  r.fail('network'); r.fail('network');
  ok(sb2.JARVIS.getState().state !== 'DISABLED', 'one or two network blips are tolerated');
  r.fail('network');
  ok(sb2.JARVIS.getState().state === 'DISABLED', 'a run of them disables with an explanation');
  ok(/Chrome|internet connection/.test(sb2.JARVIS.diagnose()) ||
     /Chrome|internet connection/.test(byId['jarvis-notice'].textContent),
     '  → message points at the browser or the connection');
  sb2.JARVIS.stop();
}

console.log('\nunsupported browser (separate context)');
{
  const sb = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, document,
               addEventListener: () => {} };            // no SpeechRecognition at all
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  let threw = null;
  try { vm.runInContext(src, sb, { filename: 'jarvis.js' }); } catch (e) { threw = e; }
  ok(!threw, 'module loads without throwing');
  ok(sb.JARVIS.supported === false, 'reports no support');
  ok(sb.JARVIS.getState().listening === false, 'never starts a recogniser it cannot use');
  // It now waits a moment in case jarvis-offline.js registers a replacement ear
  // (that's how Brave and Firefox get voice at all), then explains itself.
  ok(sb.JARVIS.getState().state !== 'DISABLED',
     'holds a grace window before declaring defeat');
  ok(/Chrome|speech recognition/i.test(sb.JARVIS.diagnose()),
     '  → and can already explain itself if asked', sb.JARVIS.diagnose());
  await sleep(3300);
  ok(sb.JARVIS.getState().state === 'DISABLED',
     'no engine arrived → disables cleanly instead of breaking the page');
  ok(/Chrome/.test(byId['jarvis-notice'].textContent),
     '  → and points the user at Chrome');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
