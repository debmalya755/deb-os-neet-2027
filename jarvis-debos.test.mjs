/**
 * jarvis-debos.test.mjs — end-to-end check of the DEB OS integration.
 * Run:  node jarvis-debos.test.mjs
 *
 * Loads jarvis-debos.js + jarvis.js together over a mocked localStorage and
 * Web Speech API, then drives real spoken phrases through the state machine and
 * asserts what actually lands in `debos.tasks.<today>`.
 *
 * Covers both execution contexts:
 *   A. subject pages  — no in-memory task array, adapter writes storage
 *   B. command.html   — window.DEBOS_BRIDGE present, adapter must defer to it
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const DIR = import.meta.dirname;
const TODAY = new Date().toISOString().slice(0, 10);
const KEY = 'debos.tasks.' + TODAY;

/* ---------- mocks ---------- */
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear()
  };
}
function makeEl() {
  return {
    id: '', className: '', innerHTML: '', textContent: '', style: {}, children: [], offsetWidth: 1,
    classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeEl(); },
    getAttribute() { return null; },
    addEventListener() {}
  };
}
class MockSR {
  static last = null;
  constructor() { MockSR.last = this; this.started = false; }
  start() { if (this.started) { const e = new Error('x'); e.name = 'InvalidStateError'; throw e; } this.started = true; this.onstart && this.onstart(); }
  stop() { this.started = false; this.onend && this.onend(); }
  abort() { const w = this.started; this.started = false; if (w) this.onend && this.onend(); }
  hear(text) { const r = [{ transcript: text }]; r.isFinal = true; this.onresult && this.onresult({ resultIndex: 0, results: [r] }); }
}

function boot({ withBridge } = { withBridge: false }) {
  const spoken = [];
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  sessionStorage.setItem('debos.session.unlocked', '1');   // past the PIN gate

  const seed = [
    { id: 't1', name: 'L1 Kinematics',   unit: 'Lecture',    subject: 'Physics',   topic: 'Kinematics',    assignedMin: 60, actualMin: 0, status: 'not-started', blowout: false, startedAt: 0, deadline: TODAY, completedAt: null },
    { id: 't2', name: 'Mole Concept L2', unit: 'Single DPP', subject: 'Chemistry', topic: 'Mole Concept',  assignedMin: 45, actualMin: 0, status: 'not-started', blowout: false, startedAt: 0, deadline: TODAY, completedAt: null },
    { id: 't3', name: 'PYQ Genetics',    unit: 'PYQ-50',     subject: 'Biology',   topic: 'Genetics',      assignedMin: 50, actualMin: 0, status: 'not-started', blowout: false, startedAt: 0, deadline: TODAY, completedAt: null }
  ];
  localStorage.setItem(KEY, JSON.stringify(seed));

  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Object, Math, String, Array, RegExp,
    localStorage, sessionStorage,
    document: {
      readyState: 'complete', visibilityState: 'visible',
      head: makeEl(), documentElement: makeEl(), body: makeEl(),
      createElement: makeEl, getElementById: () => null, addEventListener() {}
    },
    SpeechRecognition: MockSR,
    speechSynthesis: { speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); }, cancel() {}, getVoices: () => [] },
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    addEventListener() {}
  };
  sb.window = sb; sb.globalThis = sb;

  // command.html's bridge: the page owns the array and its own mutators.
  const bridgeCalls = [];
  if (withBridge) {
    let tasks = JSON.parse(localStorage.getItem(KEY));
    const persist = () => localStorage.setItem(KEY, JSON.stringify(tasks));
    sb.DEBOS_BRIDGE = {
      getTasks: () => tasks,
      setTaskStatus: (id, next) => {
        bridgeCalls.push(['setTaskStatus', id, next]);
        const t = tasks.find(x => x.id === id);
        if (t) {
          if (next === 'in-progress') { tasks.forEach(x => { if (x !== t && x.status === 'in-progress') { x.status = 'paused'; x.startedAt = 0; } }); t.startedAt = Date.now(); }
          if (next === 'paused' || next === 'not-started') t.startedAt = 0;
          if (next === 'not-started') { t.actualMin = 0; t.blowout = false; }
          t.status = next;
        }
        persist();
      },
      markCompleted: (id) => {
        bridgeCalls.push(['markCompleted', id]);
        const t = tasks.find(x => x.id === id);
        if (t) { if (t.actualMin > t.assignedMin) t.blowout = true; t.status = 'completed'; t.startedAt = 0; t.completedAt = TODAY; }
        persist();
      },
      toggleTimer: (id) => bridgeCalls.push(['toggleTimer', id]),
      refresh: () => { bridgeCalls.push(['refresh']); persist(); }
    };
  }

  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'jarvis-debos.js'), 'utf8'), sb, { filename: 'jarvis-debos.js' });
  vm.runInContext(fs.readFileSync(path.join(DIR, 'jarvis.js'), 'utf8'), sb, { filename: 'jarvis.js' });

  sb.JARVIS.config.awakeWindowMs = 500;
  sb.JARVIS.config.postSpeechMuteMs = 15;

  return { sb, spoken, localStorage, sessionStorage, bridgeCalls };
}

/* ---------- harness ---------- */
let pass = 0, fail = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}

async function unmuted(sb) {
  for (let i = 0; i < 60; i++) { if (!sb.JARVIS.getState().muted) return; await sleep(20); }
}
// Speak a wake word, then a command, then wait for the cycle to finish.
async function say(env, command) {
  const sr = MockSR.last;
  sr.hear('captain');
  await unmuted(env.sb);
  sr.hear(command);
  await sleep(60);
  await unmuted(env.sb);
  await sleep(40);
}
const store = (env) => JSON.parse(env.localStorage.getItem(KEY));
const task = (env, id) => store(env).find(t => t.id === id);
const said = (env) => env.spoken.join(' | ');

/* ========================= A. subject-page context ====================== */
console.log('\nA · subject page (no in-memory array — adapter writes storage)\n');
{
  const env = boot({ withBridge: false });
  ok(env.sb.JARVIS.getState().state === 'PASSIVE', 'JARVIS boots (session unlocked)');
  ok(typeof env.sb.DEBOS.getCurrentTasks === 'function', 'adapter defined window.DEBOS');
  ok(env.sb.DEBOS.getCurrentTasks().length === 3, 'sees today’s 3 open tasks');
  ok(env.sb.DEBOS.getCurrentTasks()[0].aliases.includes('l1'), '"L1 Kinematics" gets alias "l1"');
  ok(env.sb.DEBOS.getCurrentTasks()[2].type === 'pyq', 'PYQ-50 unit maps to type "pyq"');

  env.spoken.length = 0;
  await say(env, 'start l1');
  ok(task(env, 't1').status === 'in-progress', '"start l1" → status in-progress', JSON.stringify(task(env, 't1')));
  ok(task(env, 't1').startedAt > 0, '  → timer startedAt set');
  ok(/Starting/.test(said(env)), '  → spoken: "' + env.spoken[env.spoken.length - 1] + '"');

  env.spoken.length = 0;
  await say(env, 'log blowout physics');
  ok(task(env, 't1').blowout === true, '"log blowout physics" → flags the running Physics task');
  ok(/Logged, Physics blowout on L1 Kinematics/.test(said(env)), '  → names the task it flagged');

  env.spoken.length = 0;
  await say(env, 'blowout chemistry');
  ok(task(env, 't2').blowout === false, 'no Chemistry task running → nothing flagged');
  ok(/No Chemistry task is running/.test(said(env)), '  → refuses instead of guessing: "' + env.spoken[env.spoken.length - 1] + '"');

  env.spoken.length = 0;
  await say(env, 'start mole concept');
  ok(task(env, 't2').status === 'in-progress', '"start mole concept" → Chemistry task runs');
  ok(task(env, 't1').status === 'paused', '  → previously running task auto-paused (one-at-a-time)');

  env.spoken.length = 0;
  await say(env, 'mark complete');
  ok(task(env, 't2').status === 'completed', '"mark complete" → single running task completed');
  ok(task(env, 't2').completedAt === TODAY, '  → completedAt stamped with today');
  ok(env.sb.DEBOS.getCurrentTasks().length === 2, '  → completed task drops out of voice scope');

  env.spoken.length = 0;
  await say(env, 'start pyq genetics');
  await say(env, 'shelve this');
  ok(task(env, 't3').status === 'paused', '"shelve this" → running PYQ-50 set paused (owner’s choice)');
  ok(task(env, 't3').shelved === undefined, '  → no new flag written');
  ok(Object.keys(JSON.parse(JSON.stringify(task(env, 't3')))).length === 12, '  → task shape unchanged (12 fields)');

  env.spoken.length = 0;
  await say(env, 'pause');
  ok(/isn’t running|Nothing is active/.test(said(env)), '"pause" with nothing running → declines: "' + env.spoken[env.spoken.length - 1] + '"');

  env.spoken.length = 0;
  await say(env, 'start l1');
  await say(env, 'cancel');
  ok(task(env, 't1').status === 'not-started' && task(env, 't1').actualMin === 0 && task(env, 't1').blowout === false,
     '"cancel" → reset to not-started, time and blowout cleared');

  env.spoken.length = 0;
  await say(env, 'start the l7 task');
  // A failed match is announced when the 6s window closes, not eagerly — that
  // is what lets a command arrive split across recognition chunks.
  await sleep(env.sb.JARVIS.config.awakeWindowMs + 120);
  await unmuted(env.sb);
  ok(/didn’t catch which task|didn’t catch a valid command/.test(said(env)),
     'unknown task name → no guess, no write', 'said: ' + said(env));
  ok(store(env).filter(t => t.status === 'in-progress').length === 0, '  → nothing started');
}

/* ========================= B. command.html context ===================== */
console.log('\nB · command.html (bridge present — must defer to the page)\n');
{
  const env = boot({ withBridge: true });
  await say(env, 'start l1');
  ok(env.bridgeCalls.some(c => c[0] === 'setTaskStatus' && c[1] === 't1' && c[2] === 'in-progress'),
     '"start l1" routed through DEBOS_BRIDGE.setTaskStatus');
  ok(task(env, 't1').status === 'in-progress', '  → page state + storage agree');

  env.bridgeCalls.length = 0;
  await say(env, 'finish this');
  ok(env.bridgeCalls.some(c => c[0] === 'markCompleted' && c[1] === 't1'),
     '"finish this" routed through DEBOS_BRIDGE.markCompleted (page’s own logic)');
  ok(task(env, 't1').status === 'completed', '  → task completed');

  env.bridgeCalls.length = 0; env.spoken.length = 0;
  await say(env, 'start pyq genetics');
  await say(env, 'log blowout biology');
  ok(task(env, 't3').blowout === true, 'blowout flag written on the live array');
  ok(env.bridgeCalls.some(c => c[0] === 'refresh'), '  → page asked to re-render (bridge.refresh)');
}

/* ========================= C. locked session =========================== */
console.log('\nC · PIN gate not passed\n');
{
  const spoken = [];
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Object, Math, String, Array, RegExp,
    localStorage: makeStorage(), sessionStorage: makeStorage(),   // no unlock flag
    document: { readyState: 'complete', visibilityState: 'visible', head: makeEl(), documentElement: makeEl(), body: makeEl(), createElement: makeEl, getElementById: () => null, addEventListener() {} },
    SpeechRecognition: MockSR,
    speechSynthesis: { speak(u) { spoken.push(u.text); }, cancel() {}, getVoices: () => [] },
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    addEventListener() {}
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'jarvis-debos.js'), 'utf8'), sb, { filename: 'jarvis-debos.js' });
  vm.runInContext(fs.readFileSync(path.join(DIR, 'jarvis.js'), 'utf8'), sb, { filename: 'jarvis.js' });
  ok(sb.JARVIS_DISABLED === 1, 'adapter sets JARVIS_DISABLED when session is locked');
  ok(sb.JARVIS.getState().state === 'DISABLED', 'engine stays off — no mic prompt before the PIN gate');
  ok(sb.JARVIS.getState().listening === false, 'recognition never started');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
