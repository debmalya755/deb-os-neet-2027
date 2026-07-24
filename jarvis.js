/*!
 * ============================================================================
 *  jarvis.js  —  JARVIS voice assistant module for DEB OS
 *  v1.0.0  ·  standalone, dependency-free, browser-only
 * ============================================================================
 *
 *  WHAT THIS IS
 *  ------------
 *  A self-contained voice-control layer for the DEB OS static site. Drop it in
 *  with a single <script> tag. It touches nothing in the host page except:
 *    - one optional placeholder <div id="jarvis-indicator"></div>
 *      (auto-created if absent)
 *    - one injected <style id="jarvis-styles"> block
 *    - window.JARVIS  (public API)
 *    - window.DEBOS   (integration stub namespace; alias window.DevOS)
 *
 *  INTEGRATION (minimal host-page change)
 *  --------------------------------------
 *      <div id="jarvis-indicator"></div>          <!-- optional -->
 *      <script src="jarvis.js"></script>
 *
 *  If the host page defines window.DEBOS (or window.DevOS) with real data-layer
 *  functions BEFORE this script loads, those implementations win and the stubs
 *  below are skipped. Otherwise every action console.logs its intent.
 *
 *  In this repo that wiring lives in jarvis-debos.js, which is included first:
 *
 *      <div id="jarvis-indicator"></div>
 *      <script src="jarvis-debos.js"></script>   <!-- data layer adapter -->
 *      <script src="jarvis.js"></script>         <!-- this engine          -->
 *
 *  Keeping the two apart means the voice engine never needs to change when the
 *  site's storage model does — only the adapter does.
 *
 *  TECHNOLOGY / SCOPE BOUNDARIES (deliberate, non-negotiable)
 *  ----------------------------------------------------------
 *  - Web Speech API only: SpeechRecognition / webkitSpeechRecognition for STT,
 *    speechSynthesis + SpeechSynthesisUtterance for TTS.
 *  - NO third-party voice SDK, NO cloud speech service, NO paid API.
 *  - NO AI/LLM call anywhere. Command matching is 100% deterministic pattern
 *    matching (see SECTION 5 / SECTION 10). Predictable binary rules by design.
 *  - NO wake-word library, NO ML model.
 *  - NO service worker, NO background script, NO persistence of listening state.
 *    Everything dies with the tab. Nothing listens after the tab closes.
 *  - NO storage of raw audio or transcripts. Transcript text lives in a single
 *    in-memory buffer that is wiped at the end of every wake cycle.
 *
 *  BROWSER SUPPORT NOTE (known + accepted limitation, not a bug to fix)
 *  -------------------------------------------------------------------
 *  Chrome is the primary target: it keeps SpeechRecognition alive most reliably
 *  while its tab is backgrounded ("Meet-style" persistence). Other browsers
 *  (Safari, Firefox, some Chromium forks) may throttle, suspend, or outright
 *  drop recognition when the tab loses focus, or may not implement
 *  SpeechRecognition at all. That is expected. The module feature-detects and
 *  disables itself cleanly rather than trying to work around it.
 * ============================================================================
 */

(function (global) {
  'use strict';

  /* =========================================================================
   * SECTION 1 — GUARD + CONFIG
   * =======================================================================*/

  // Idempotent include: if the script is somehow loaded twice, do nothing.
  if (global.JARVIS && global.JARVIS.__initialized) return;

  var VERSION = '1.0.0';

  var CONFIG = {
    /* Wake cycle -------------------------------------------------------- */
    // Length of the AWAKENED window. Spec range 5–8s; 6s is the chosen default.
    awakeWindowMs: 6000,

    /* Recognition ------------------------------------------------------- */
    lang: 'en-IN',            // en-IN handles Indian-English task/subject names
                              // better than en-US; change to 'en-US' if needed.
    continuous: true,
    // interimResults=false per spec. Consequence: a command must be *finalised*
    // by Chrome inside the 6s window. Chrome finalises a segment shortly after
    // a speech pause, so speaking promptly after "Yes, sir" works. Flip to true
    // only for debugging / if you find the window too tight — the matcher runs
    // on an accumulating buffer either way, so both modes behave identically.
    interimResults: false,
    maxAlternatives: 1,

    /* Auto-restart loop ------------------------------------------------- */
    restartDelayMs: 250,      // base delay before re-.start() after onend
    maxRestartDelayMs: 4000,  // ceiling for exponential backoff on hard errors
    watchdogIntervalMs: 5000, // safety net if onend never fires (background tab)

    /* Matching ---------------------------------------------------------- */
    proximityWords: 6,        // "verb followed within a few words by a target"
    fuzzyThreshold: 0.72,     // Levenshtein similarity floor for target names

    /* Speech synthesis -------------------------------------------------- */
    speechRate: 1.02,
    speechPitch: 0.85,
    speechVolume: 1.0,
    preferredVoices: ['Google UK English Male', 'Daniel', 'Microsoft Ryan',
                      'Google US English'],
    // Extra grace period after synthesis ends before the recogniser is
    // un-muted, so the tail of JARVIS's own voice is never transcribed.
    postSpeechMuteMs: 300,

    /* UI ---------------------------------------------------------------- */
    indicatorId: 'jarvis-indicator',
    // Which screen corner the indicator sits in: 'bottom-right' (default),
    // 'bottom-left', 'top-right' or 'top-left'. Per-page override lives on the
    // placeholder element: <div id="jarvis-indicator" data-corner="bottom-left">
    // — needed on the DEB OS subject pages, where the "New task" FAB and the
    // toast already occupy bottom-right.
    corner: 'bottom-right',
    // Styles are injected by default so integration is one <script> tag.
    // Set window.JARVIS_NO_INJECT = 1 before this file loads (or link
    // jarvis.css, which carries id="jarvis-styles") to opt out.
    injectStyles: !global.JARVIS_NO_INJECT,
    showLabel: true,

    /* Misc -------------------------------------------------------------- */
    autoStart: true,
    debug: false              // console tracing of state transitions only
  };

  /* =========================================================================
   * SECTION 2 — FEATURE DETECTION
   * =======================================================================*/

  var SR = global.SpeechRecognition || global.webkitSpeechRecognition || null;
  var SYNTH = global.speechSynthesis || null;
  var Utterance = global.SpeechSynthesisUtterance || null;

  var SUPPORTED = !!SR;                       // hard requirement
  var SYNTH_SUPPORTED = !!(SYNTH && Utterance); // soft: JARVIS goes mute-only

  /* -------------------------------------------------------------------------
   * Browser sniffing, kept to what actually changes behaviour here.
   *
   * Only real Chrome (and Chromium proper) runs continuous recognition
   * dependably. Everything else fails in its own way, and each failure needs a
   * different sentence in plain English:
   *   Firefox  — no SpeechRecognition object at all.
   *   Brave    — the object exists but the speech service is blocked by the
   *              browser's shields, so every attempt dies with a 'network' error.
   *   Edge/Opera — usually work, occasionally throttle; treated as "probably OK".
   * ---------------------------------------------------------------------- */
  var UA = (global.navigator && global.navigator.userAgent) || '';
  var BROWSER = {
    isEdge:   /\bEdg\//.test(UA),
    isOpera:  /\bOPR\//.test(UA),
    isBrave:  !!(global.navigator && global.navigator.brave),
    isFirefox: /\bFirefox\//.test(UA),
    isSafari: /^((?!chrome|android|crios|edg).)*safari/i.test(UA),
    isMobile: /Android|iPhone|iPad|iPod/i.test(UA)
  };
  BROWSER.isRealChrome = /\bChrome\//.test(UA) &&
    !BROWSER.isEdge && !BROWSER.isOpera && !BROWSER.isBrave;

  // Diagnostics — enough to explain a silent failure without a dev console.
  var DIAG = {
    lastError: null,      // last SpeechRecognition error code
    errorCount: 0,
    networkErrors: 0,
    everStarted: false,   // did onstart ever fire?
    everHeard: false,     // did onresult ever fire?
    startAttempts: 0
  };

  // ?jarvisdebug=1 anywhere in the URL turns on tracing and surfaces every
  // recognition error as a corner message, so a non-technical user can read
  // out what's wrong instead of opening devtools.
  var VERBOSE = false;
  try {
    VERBOSE = !!(global.location && /jarvisdebug/.test(global.location.search || ''));
  } catch (e) {}

  /* =========================================================================
   * SECTION 3 — INTEGRATION STUBS  (the ONLY place DEB OS wiring happens)
   * -------------------------------------------------------------------------
   * Every stub below is replaceable from the host page:
   *
   *    window.DEBOS = {
   *      getCurrentTasks: () => myStore.tasks.map(t => ({id:t.id, name:t.title})),
   *      startTask:       (id) => myStore.start(id),
   *      ...
   *    };
   *    <script src="jarvis.js"></script>
   *
   * Read stubs must return data synchronously.
   * Write stubs may return a value, a boolean, or a Promise — both are handled.
   * =======================================================================*/

  var DEBOS = global.DEBOS || global.DevOS || {};
  global.DEBOS = DEBOS;
  global.DevOS = DEBOS; // alias: the spec sketched stubs as DevOS.startTask(...)

  function stub(name, fn) {
    if (typeof DEBOS[name] !== 'function') DEBOS[name] = fn;
  }

  // ---- READ SIDE (data source) -------------------------------------------
  // Shape expected: [{ id:'L1', name:'Lecture 1 — Rotational Motion',
  //                    subject:'Physics', type:'lecture'|'pyq'|...,
  //                    active:true|false, aliases:['rotation'] }, ...]

  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('getCurrentTasks', function () {
    console.log('[DEBOS stub] getCurrentTasks() — returning demo task list');
    return [
      { id: 'L1', name: 'Lecture 1', subject: 'Physics',   type: 'lecture', active: false, aliases: ['rotational motion'] },
      { id: 'L2', name: 'Lecture 2', subject: 'Chemistry', type: 'lecture', active: false, aliases: ['mole concept'] },
      { id: 'P1', name: 'PYQ Set 1', subject: 'Biology',   type: 'pyq',     active: false, aliases: ['genetics pyq'] }
    ];
  });

  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('getTaskById', function (taskId) {
    console.log('[DEBOS stub] getTaskById(' + taskId + ')');
    var all = safeArray(DEBOS.getCurrentTasks());
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].id).toLowerCase() === String(taskId).toLowerCase()) return all[i];
    }
    return null;
  });

  // Tasks currently in progress. Used to infer the target of "finish this".
  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('getActiveTasks', function () {
    console.log('[DEBOS stub] getActiveTasks()');
    return safeArray(DEBOS.getCurrentTasks()).filter(function (t) { return !!t.active; });
  });

  // The PYQ set currently open — target of "shelve this".
  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('getActivePYQSet', function () {
    console.log('[DEBOS stub] getActivePYQSet()');
    var act = safeArray(DEBOS.getActiveTasks()).filter(function (t) { return t.type === 'pyq'; });
    return act.length ? act[0] : null;
  });

  // ---- WRITE SIDE (actions) ----------------------------------------------

  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('startTask', function (taskId) {
    console.log('[DEBOS stub] startTask(' + taskId + ') — would flip task to in-progress');
    return true;
  });

  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('markComplete', function (taskId) {
    console.log('[DEBOS stub] markComplete(' + taskId + ') — would mark task complete');
    return true;
  });

  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('logBlowout', function (subject, topic) {
    console.log('[DEBOS stub] logBlowout(' + subject + ', ' + (topic || '—') +
                ') — would push an entry onto the Blowout Wall');
    return true;
  });

  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('shelvePYQSet', function (setId) {
    console.log('[DEBOS stub] shelvePYQSet(' + setId + ') — would append to the PYQ shelving log');
    return true;
  });

  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('pauseTask', function (taskId) {
    console.log('[DEBOS stub] pauseTask(' + taskId + ') — would pause the running timer');
    return true;
  });

  // TODO: wire to actual data layer once site's DB/storage is finalized
  stub('cancelTask', function (taskId) {
    console.log('[DEBOS stub] cancelTask(' + taskId + ') — would abandon/reset the task');
    return true;
  });

  /* =========================================================================
   * SECTION 4 — SMALL UTILITIES (normalisation + fuzzy string matching)
   * =======================================================================*/

  function safeArray(v) { return Array.isArray(v) ? v : []; }

  function log() {
    if (!CONFIG.debug) return;
    var a = Array.prototype.slice.call(arguments);
    a.unshift('[JARVIS]');
    console.log.apply(console, a);
  }

  // Lowercase, strip punctuation, collapse whitespace.
  function normalize(raw) {
    return String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var NUMBER_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20
  };

  // Canonicalise the shorthand DEB OS uses, so that all of
  // "lecture one", "L 1", "el one", "lecture 1" collapse to "l1".
  function canonicalize(text) {
    var s = ' ' + text + ' ';
    Object.keys(NUMBER_WORDS).forEach(function (w) {
      s = s.replace(new RegExp('\\b' + w + '\\b', 'g'), String(NUMBER_WORDS[w]));
    });
    s = s.replace(/\blect?u?r?e?\b/g, 'l');   // lecture / lectur / lect -> l
    s = s.replace(/\bel\b/g, 'l');            // "el one" -> "l 1"
    s = s.replace(/\bset\b/g, '');            // "pyq set 1" -> "pyq 1"
    s = s.replace(/\b([a-z])\s+(\d+)\b/g, '$1$2'); // "l 1" -> "l1"
    return s.replace(/\s+/g, ' ').trim();
  }

  function prep(raw) { return canonicalize(normalize(raw)); }

  // Classic Levenshtein distance (iterative, single row) — no library needed.
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1), i, j, tmp, cost;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      tmp = prev[0]; prev[0] = i;
      for (j = 1; j <= b.length; j++) {
        cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var next = Math.min(prev[j] + 1, prev[j - 1] + 1, tmp + cost);
        tmp = prev[j]; prev[j] = next;
      }
    }
    return prev[b.length];
  }

  // 0..1 similarity. Simple, explainable, deterministic — the only "fuzziness"
  // in the whole module, and only ever applied to TARGET names (never verbs).
  function similarity(a, b) {
    if (!a || !b) return 0;
    var max = Math.max(a.length, b.length);
    return max === 0 ? 1 : 1 - (levenshtein(a, b) / max);
  }

  // Slide a window of the candidate's token-length across the segment and take
  // the best similarity; also compare against the whole segment.
  function bestWindowSimilarity(segment, candidate) {
    // Verbatim containment is always a perfect hit ("l1" inside "the l1 task").
    var contained = (' ' + segment + ' ').indexOf(' ' + candidate + ' ') !== -1;
    if (contained) return 1;

    // Short candidates ("l1", "bio", "chem") are matched EXACTLY only. Edit
    // distance on 2–4 characters is meaningless and produces false positives
    // (e.g. "them" ~ "chem"), which is unacceptable for actions that must be
    // deterministic.
    if (candidate.length <= 4) return 0;

    var sw = segment.split(' '), cw = candidate.split(' '), n = cw.length;
    var best = similarity(segment, candidate);
    for (var i = 0; i + n <= sw.length; i++) {
      best = Math.max(best, similarity(sw.slice(i, i + n).join(' '), candidate));
    }
    return best;
  }

  // Locate an exact word-sequence inside a token array. Verbs are matched
  // exactly on purpose: an intent must never be inferred probabilistically.
  function findPhrase(words, phrase) {
    var p = phrase.split(' ');
    for (var i = 0; i + p.length <= words.length; i++) {
      var ok = true;
      for (var j = 0; j < p.length; j++) {
        if (words[i + j] !== p[j]) { ok = false; break; }
      }
      if (ok) return { start: i, end: i + p.length - 1 };
    }
    return null;
  }

  /* =========================================================================
   * SECTION 5 — GRAMMAR TABLES (wake words, verbs, subjects)
   * -------------------------------------------------------------------------
   * Everything JARVIS understands is enumerated here. Nothing is inferred.
   * =======================================================================*/

  // Wake phrase: "Jarvis", or "wake up Jarvis". Case-insensitive and tolerant of
  // pauses/commas, since punctuation is stripped before matching.
  //
  // The alternates are the ways speech engines routinely mis-hear the name —
  // "Travis" and "Service" come back often. Both are vanishingly rare in
  // exam-prep speech, so accepting them costs nothing and saves a lot of
  // repeated calling. A false wake is cheap: it answers "Yes, sir" and goes
  // quiet again six seconds later.
  var WAKE_ALT = '(?:jarvis|jarviss|jarvez|jarvus|jervis|javis|jaravis|travis|charvis|service)';
  var WAKE_PATTERNS = [
    new RegExp('\\bwake\\s*up\\s+' + WAKE_ALT + '\\b'),
    new RegExp('\\b' + WAKE_ALT + '\\b')
  ];

  var SUBJECTS = [
    { name: 'Physics',   aliases: ['physics', 'physic', 'physik', 'phy', 'fizz', 'physics'] },
    { name: 'Chemistry', aliases: ['chemistry', 'chemistr', 'chem', 'kemistry'] },
    { name: 'Biology',   aliases: ['biology', 'bio', 'biolog', 'botany', 'zoology'] }
  ];

  /**
   * Intent table.
   *  phrases  – exact word-sequences that trigger the intent (longest wins)
   *  target   – 'subject' | 'task' | 'task?' | 'pyq'
   *             'task?'  = target optional; infer the single active task
   *  weight   – tie-breaker so more specific intents beat generic ones
   */
  var INTENTS = [
    {
      intent: 'log_blowout', target: 'subject', weight: 5,
      phrases: ['log blowout', 'log a blowout', 'log blow out', 'log the blowout',
                'blowout', 'blow out', 'blown out', 'blow up']
    },
    {
      intent: 'start', target: 'task', weight: 1,
      phrases: ['start', 'begin', 'kick off', 'launch', 'starting']
    },
    {
      intent: 'complete', target: 'task?', weight: 3,
      phrases: ['mark complete', 'mark as complete', 'mark done', 'mark it done',
                'complete', 'completed', 'finish', 'finished', 'finish this',
                'wrap up', 'done with', 'its done', 'it is done']
    },
    {
      intent: 'shelve', target: 'pyq', weight: 4,
      phrases: ['shelve', 'shelf', 'shelve this', 'shelve it', 'put on the shelf',
                'park this', 'shelved']
    },
    {
      intent: 'pause', target: 'task?', weight: 2,
      phrases: ['pause', 'paused', 'hold this', 'put on hold', 'freeze this']
    },
    {
      intent: 'cancel', target: 'task?', weight: 2,
      phrases: ['cancel', 'cancelled', 'abort', 'scrap this', 'never mind',
                'nevermind', 'forget it', 'drop this']
    }
  ];

  // Ordinals accepted when JARVIS asks "which task, sir?".
  var ORDINALS = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2,
                   fourth: 3, '4th': 3, 1: 0, 2: 1, 3: 2, 4: 3 };

  /* =========================================================================
   * SECTION 6 — CSS BLOCK + VISUAL INDICATOR
   * -------------------------------------------------------------------------
   * Plain CSS transitions only, no animation library. Injected once so that
   * host-page integration is a single <script> tag. If you prefer to link
   * jarvis.css yourself, set CONFIG.injectStyles = false.
   * =======================================================================*/

  var CSS = [
    // Colours/fonts read the host site's design tokens when they exist
    // (DEB OS defines --accent-warm / --accent-red / --accent-green /
    // --panel-border / --font-mono) and fall back to sane values otherwise, so
    // the widget looks native without the site needing to know about it.
    '#jarvis-indicator{',
    '  position:fixed;right:20px;bottom:20px;z-index:90;',
    '  display:flex;align-items:center;gap:8px;',
    '  padding:6px 11px 6px 9px;border-radius:999px;',
    '  font-family:var(--font-mono,ui-monospace),SFMono-Regular,Menlo,Consolas,monospace;',
    '  font-size:10.5px;font-weight:500;line-height:1.2;',
    '  letter-spacing:.1em;text-transform:uppercase;',
    '  color:rgba(230,238,246,.6);background:rgba(8,12,18,.62);',
    '  border:1px solid var(--panel-border,rgba(120,170,255,.14));',
    '  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
    // Clickable on purpose: tapping the dot reports what the voice layer is
    // doing (or why it isn't) in plain language, and retries a stalled
    // recogniser. Without it, a dim dot is an unreadable dead end.
    '  user-select:none;pointer-events:auto;cursor:pointer;',
    '  transition:background .3s ease,border-color .3s ease,color .3s ease,box-shadow .3s ease;',
    '}',
    '#jarvis-indicator:hover{color:rgba(230,238,246,.92);}',
    /* corner placement (CONFIG.corner / data-corner on the placeholder) */
    '#jarvis-indicator.jarvis-at-bottom-left{left:20px;right:auto;bottom:20px;top:auto;}',
    '#jarvis-indicator.jarvis-at-top-right{top:20px;bottom:auto;right:20px;left:auto;}',
    '#jarvis-indicator.jarvis-at-top-left{top:20px;bottom:auto;left:20px;right:auto;}',
    '#jarvis-indicator .jarvis-dot{',
    '  position:relative;width:9px;height:9px;border-radius:50%;flex:0 0 9px;',
    '  background:#4c6b8a;box-shadow:0 0 0 0 rgba(0,0,0,0);',
    '  transition:background .25s ease,box-shadow .25s ease,transform .25s ease;',
    '}',
    '#jarvis-indicator .jarvis-label{white-space:nowrap;}',
    '#jarvis-indicator .jarvis-timer{',
    '  width:26px;height:2px;border-radius:2px;overflow:hidden;',
    '  background:rgba(255,255,255,.12);opacity:0;transition:opacity .2s ease;',
    '}',
    '#jarvis-indicator .jarvis-timer > i{',
    '  display:block;height:100%;width:100%;transform-origin:left center;',
    '  background:var(--accent-warm,#7fd4ff);transform:scaleX(1);',
    '}',
    /* ---- PASSIVE: dim, barely there ---- */
    '#jarvis-indicator.jarvis--passive .jarvis-dot{background:#41597a;}',
    /* ---- AWAKENED: brightened + pulsing + countdown bar ---- */
    '#jarvis-indicator.jarvis--awake{',
    '  color:#dff1ff;background:rgba(12,28,44,.8);',
    '  border-color:rgba(0,245,255,.5);box-shadow:0 0 18px rgba(0,245,255,.18);',
    '}',
    '#jarvis-indicator.jarvis--awake .jarvis-dot{',
    '  background:var(--accent-warm,#7fd4ff);animation:jarvisPulse 1s ease-in-out infinite;',
    '}',
    '#jarvis-indicator.jarvis--awake .jarvis-timer{opacity:1;}',
    '#jarvis-indicator.jarvis--awake .jarvis-timer > i{animation:jarvisCountdown linear forwards;}',
    /* ---- PROCESSING: green, quick confirm animation ---- */
    '#jarvis-indicator.jarvis--processing{',
    '  color:#dcffe8;background:rgba(10,38,24,.8);',
    '  border-color:rgba(80,230,150,.55);box-shadow:0 0 18px rgba(80,230,150,.2);',
    '}',
    '#jarvis-indicator.jarvis--processing .jarvis-dot{',
    '  background:var(--accent-green,#4ee69a);animation:jarvisBlip .45s ease-out 2;',
    '}',
    /* ---- FAILED MATCH: brief red flash ---- */
    '#jarvis-indicator.jarvis--error{',
    '  color:#ffe0e0;background:rgba(44,12,12,.8);',
    '  border-color:rgba(255,90,90,.6);box-shadow:0 0 18px rgba(255,90,90,.22);',
    '}',
    '#jarvis-indicator.jarvis--error .jarvis-dot{background:var(--accent-red,#ff5a5a);animation:jarvisBlip .3s ease-out 2;}',
    /* ---- DISABLED: unsupported browser / mic denied ---- */
    '#jarvis-indicator.jarvis--disabled{opacity:.45;}',
    '#jarvis-indicator.jarvis--disabled .jarvis-dot{background:#6b6b6b;}',
    '@keyframes jarvisPulse{',
    '  0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(127,212,255,.45);}',
    '  50%{transform:scale(1.25);box-shadow:0 0 0 6px rgba(127,212,255,0);}',
    '}',
    '@keyframes jarvisBlip{0%{transform:scale(1);}50%{transform:scale(1.6);}100%{transform:scale(1);}}',
    '@keyframes jarvisCountdown{from{transform:scaleX(1);}to{transform:scaleX(0);}}',
    /* ---- non-blocking notice (never an alert/popup) ---- */
    '#jarvis-notice{',
    '  position:fixed;right:20px;bottom:58px;z-index:90;max-width:260px;',
    '  padding:8px 11px;border-radius:8px;',
    '  font:400 11.5px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;',
    '  color:rgba(235,240,246,.8);background:rgba(10,14,20,.82);',
    '  border:1px solid rgba(255,255,255,.1);pointer-events:none;',
    '  opacity:0;transform:translateY(4px);transition:opacity .35s ease,transform .35s ease;',
    '}',
    '#jarvis-notice.jarvis-notice--show{opacity:1;transform:translateY(0);}',
    '#jarvis-notice.jarvis-at-bottom-left{left:20px;right:auto;}',
    '#jarvis-notice.jarvis-at-top-right{top:58px;bottom:auto;}',
    '#jarvis-notice.jarvis-at-top-left{top:58px;bottom:auto;left:20px;right:auto;}',
    '@media (prefers-reduced-motion:reduce){',
    '  #jarvis-indicator *,#jarvis-notice{animation:none!important;transition:none!important;}',
    '}'
  ].join('\n');

  var ui = { root: null, dot: null, label: null, timerBar: null, notice: null };

  function injectStyles() {
    if (!CONFIG.injectStyles) return;
    if (document.getElementById('jarvis-styles')) return; // already present
    var s = document.createElement('style');
    s.id = 'jarvis-styles';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var cornerCls = '';

  function buildIndicator() {
    // Reuse the host page's placeholder <div> if it exists; otherwise create
    // one. Either way the widget is fixed-position, so it stays visible no
    // matter which section of DEB OS the user has scrolled to.
    var root = document.getElementById(CONFIG.indicatorId);
    if (!root) {
      root = document.createElement('div');
      root.id = CONFIG.indicatorId;
      document.body.appendChild(root);
    }
    // Per-page corner override, e.g. the subject pages where the "New task"
    // FAB owns bottom-right: <div id="jarvis-indicator" data-corner="bottom-left">
    var corner = (root.getAttribute && root.getAttribute('data-corner')) || CONFIG.corner;
    cornerCls = (corner && corner !== 'bottom-right') ? ('jarvis-at-' + corner) : '';
    root.innerHTML =
      '<span class="jarvis-dot"></span>' +
      '<span class="jarvis-timer"><i></i></span>' +
      (CONFIG.showLabel ? '<span class="jarvis-label"></span>' : '');
    ui.root = root;
    ui.dot = root.querySelector('.jarvis-dot');
    ui.label = root.querySelector('.jarvis-label');
    ui.timerBar = root.querySelector('.jarvis-timer > i');
    if (ui.timerBar) ui.timerBar.style.animationDuration = CONFIG.awakeWindowMs + 'ms';

    // Tap/click the dot: say what's going on in plain language, and give a
    // stalled recogniser a nudge. This click IS a user gesture, which is also
    // the most reliable moment to (re)start recognition in stricter browsers.
    if (root.addEventListener) {
      root.addEventListener('click', function () {
        notice(diagnose());
        if (shouldRun && !running && !permissionDenied) startRecognition();
      });
    }
  }

  var VISUAL = {
    passive:    { cls: 'jarvis--passive',    label: 'JARVIS' },
    awake:      { cls: 'jarvis--awake',      label: 'LISTENING' },
    processing: { cls: 'jarvis--processing', label: 'EXECUTING' },
    error:      { cls: 'jarvis--error',      label: 'NO MATCH' },
    disabled:   { cls: 'jarvis--disabled',   label: 'VOICE OFF' }
  };

  function paint(kind, labelOverride) {
    if (!ui.root) return;
    var v = VISUAL[kind] || VISUAL.passive;
    // Corner class is sticky — state classes are swapped around it.
    ui.root.className = cornerCls ? (v.cls + ' ' + cornerCls) : v.cls;
    if (ui.label) ui.label.textContent = labelOverride || v.label;
    // Restart the countdown-bar animation on every fresh AWAKENED entry.
    if (kind === 'awake' && ui.timerBar) {
      ui.timerBar.style.animation = 'none';
      void ui.timerBar.offsetWidth;              // force reflow
      ui.timerBar.style.animation = 'jarvisCountdown ' + CONFIG.awakeWindowMs + 'ms linear forwards';
    }
  }

  // Brief visual, then fall back to whatever the current state looks like.
  function flash(kind, ms) {
    paint(kind);
    global.setTimeout(function () {
      if (state === 'DISABLED') paint('disabled');
      else if (state === 'AWAKENED') paint('awake');
      else paint('passive');
    }, ms || 900);
  }

  var noticeTimer = null;
  function notice(text, persist) {
    // Non-blocking inline message. Never alert(), never a modal — a failure in
    // the voice layer must not interrupt anything else on the site.
    if (!ui.notice) {
      ui.notice = document.createElement('div');
      ui.notice.id = 'jarvis-notice';
      if (cornerCls) ui.notice.className = cornerCls;   // follow the indicator
      document.body.appendChild(ui.notice);
    }
    ui.notice.textContent = text;
    ui.notice.classList.add('jarvis-notice--show');
    if (noticeTimer) global.clearTimeout(noticeTimer);
    if (!persist) {
      noticeTimer = global.setTimeout(function () {
        ui.notice.classList.remove('jarvis-notice--show');
      }, 6000);
    }
  }

  /* =========================================================================
   * SECTION 7 — SPEECH SYNTHESIS  (+ self-hearing guard)
   * -------------------------------------------------------------------------
   * `muted` is the mute-recognition-during-synthesis flag. While it is true,
   * every incoming transcript is discarded, so JARVIS can never hear its own
   * "Yes, sir" and re-trigger itself. A short post-speech grace period plus an
   * echo filter cover the tail end of the utterance.
   * =======================================================================*/

  var muted = false;
  var lastSpoken = '';
  var lastSpokenAt = 0;
  var chosenVoice = null;

  function pickVoice() {
    if (!SYNTH_SUPPORTED) return;
    var voices = SYNTH.getVoices() || [];
    for (var i = 0; i < CONFIG.preferredVoices.length; i++) {
      for (var j = 0; j < voices.length; j++) {
        if (voices[j].name === CONFIG.preferredVoices[i]) { chosenVoice = voices[j]; return; }
      }
    }
    for (var k = 0; k < voices.length; k++) {
      if (/^en/i.test(voices[k].lang)) { chosenVoice = voices[k]; return; }
    }
  }
  if (SYNTH_SUPPORTED) {
    pickVoice();
    // Chrome populates the voice list asynchronously.
    SYNTH.onvoiceschanged = pickVoice;
  }

  function speak(text, done) {
    lastSpoken = normalize(text);
    if (!SYNTH_SUPPORTED) { if (done) done(); return; }

    muted = true;                       // <-- recogniser input ignored from here
    var utt = new Utterance(text);
    utt.rate = CONFIG.speechRate;
    utt.pitch = CONFIG.speechPitch;
    utt.volume = CONFIG.speechVolume;
    if (chosenVoice) utt.voice = chosenVoice;

    var released = false;
    function release() {
      if (released) return;
      released = true;
      lastSpokenAt = Date.now();
      // Small grace period: the mic can still pick up the audio tail.
      global.setTimeout(function () { muted = false; }, CONFIG.postSpeechMuteMs);
      if (done) done();
    }
    utt.onend = release;
    utt.onerror = release;
    // Safety net: Chrome occasionally never fires onend (known quirk), which
    // would leave the recogniser muted forever. Estimate a worst-case duration.
    global.setTimeout(release, Math.max(1500, text.length * 85));

    try { SYNTH.speak(utt); } catch (e) { release(); }
  }

  // Second line of defence against self-hearing: drop transcripts that look
  // like what JARVIS just said, within ~2s of it finishing.
  function isEcho(text) {
    if (!lastSpoken) return false;
    if (Date.now() - lastSpokenAt > 2000) return false;
    var t = normalize(text);
    if (!t) return false;
    return lastSpoken.indexOf(t) !== -1 || similarity(t, lastSpoken) > 0.7;
  }

  /* =========================================================================
   * SECTION 8 — RECOGNITION LIFECYCLE (continuous + auto-restart)
   * =======================================================================*/

  var recognition = null;
  var running = false;        // recogniser believed to be live
  var shouldRun = false;      // our intent: keep it alive
  var isUnloading = false;    // tab is going away — stop everything, restart nothing
  var restartDelay = CONFIG.restartDelayMs;
  var watchdog = null;
  var permissionDenied = false;

  function buildRecognition() {
    var r = new SR();
    r.lang = CONFIG.lang;
    r.continuous = CONFIG.continuous;       // run for the life of the tab
    r.interimResults = CONFIG.interimResults;
    r.maxAlternatives = CONFIG.maxAlternatives;

    r.onstart = function () {
      running = true;
      DIAG.everStarted = true;
      restartDelay = CONFIG.restartDelayMs; // healthy session -> reset backoff
      log('recognition started');
    };

    r.onresult = function (event) {
      // Pull only the results added since the last event, and only finals
      // (unless interimResults is on for debugging).
      var chunk = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var res = event.results[i];
        if (res.isFinal || CONFIG.interimResults) chunk += ' ' + res[0].transcript;
      }
      chunk = chunk.trim();
      if (!chunk) return;
      DIAG.everHeard = true;

      // Self-hearing guard: while JARVIS is speaking, nothing is parsed.
      if (muted || isEcho(chunk)) { log('ignored (own voice):', chunk); return; }

      handleTranscript(chunk);
      // NOTE: `chunk` is a local — it is never stored, logged, or transmitted.
    };

    r.onerror = function (event) {
      var err = event && event.error;
      DIAG.lastError = err || 'unknown';
      DIAG.errorCount++;
      log('recognition error:', err);
      if (VERBOSE) notice('JARVIS debug — recognition error: ' + DIAG.lastError);

      if (err === 'not-allowed' || err === 'service-not-allowed') {
        // EDGE CASE: microphone permission denied, or the browser refuses to
        // hand the audio to a speech service at all (Brave's shields do this).
        permissionDenied = true;
        disable(BROWSER.isBrave
          ? 'Voice control is blocked by Brave. Brave disables the Web Speech ' +
            'API by default — open this site in Google Chrome instead.'
          : 'Voice control needs microphone permission. Click the mic or lock ' +
            'icon in the address bar, allow the microphone, then reload.');
        return;
      }
      if (err === 'audio-capture') {
        disable('Voice control can’t find a microphone. Plug one in or check ' +
                'your system sound settings, then reload.');
        return;
      }
      if (err === 'network') {
        // Recognition is cloud-backed. One blip is transient — a run of them
        // means this browser can't reach a speech service at all, which is
        // exactly what Brave (and some Edge/Chromium builds) do.
        DIAG.networkErrors++;
        if (DIAG.networkErrors >= 3) {
          disable(BROWSER.isRealChrome
            ? 'Voice control can’t reach the speech service. Check your ' +
              'internet connection and reload.'
            : 'Voice control can’t reach the speech service in this browser. ' +
              'Open this site in Google Chrome — it’s the only browser this ' +
              'feature works reliably in.');
          return;
        }
        restartDelay = Math.min(restartDelay * 2, CONFIG.maxRestartDelayMs);
      }
      // 'no-speech' and 'aborted' are normal and expected — onend handles them.
    };

    r.onend = function () {
      running = false;
      log('recognition ended');
      // EDGE CASE: Chrome silently stops recognition after periods of silence.
      // Transparently restart so the listener resumes with zero user action and
      // zero user-visible error. Never restart while unloading or disabled.
      if (!shouldRun || isUnloading) return;
      global.setTimeout(startRecognition, restartDelay);
      restartDelay = Math.min(restartDelay * 1.5, CONFIG.maxRestartDelayMs);
    };

    return r;
  }

  function startRecognition() {
    if (!shouldRun || isUnloading || permissionDenied || running) return;
    if (!recognition) recognition = buildRecognition();
    DIAG.startAttempts++;
    try {
      // Permission is requested implicitly by .start() — the minimal surface.
      // No separate getUserMedia() call is made.
      recognition.start();
    } catch (e) {
      // InvalidStateError = already started. Anything else: retry with backoff.
      log('start() threw:', e && e.name);
      if (e && e.name !== 'InvalidStateError') {
        global.setTimeout(startRecognition, restartDelay);
        restartDelay = Math.min(restartDelay * 1.5, CONFIG.maxRestartDelayMs);
      }
    }
  }

  function startWatchdog() {
    if (watchdog) return;
    // Belt-and-braces: in a heavily throttled background tab an `onend` can be
    // missed entirely. This poll notices a dead recogniser and revives it.
    watchdog = global.setInterval(function () {
      if (!shouldRun || isUnloading || permissionDenied) return;
      if (!running) startRecognition();
    }, CONFIG.watchdogIntervalMs);
  }

  /* -------------------------------------------------------------------------
   * One sentence describing what the voice layer is doing, or why it isn't.
   * Shown when the indicator is clicked, so a silent failure is always
   * readable without a developer console.
   * ---------------------------------------------------------------------- */
  function diagnose() {
    if (!SUPPORTED) {
      return 'This browser has no speech recognition' +
             (BROWSER.isFirefox ? ' (Firefox never shipped it)' : '') +
             '. Open the site in Google Chrome to use voice.';
    }
    if (global.JARVIS_DISABLED) {
      return 'Voice is off on this page — unlock the site from the landing page first.';
    }
    if (permissionDenied) {
      return BROWSER.isBrave
        ? 'Brave is blocking voice recognition. Use Google Chrome.'
        : 'Microphone permission was refused. Allow it via the address-bar icon, then reload.';
    }
    if (state === 'DISABLED') {
      return 'Voice is switched off' + (DIAG.lastError ? ' (' + DIAG.lastError + ')' : '') +
             '. Reload the page to try again.';
    }
    if (!DIAG.everStarted) {
      return 'Voice hasn’t started in this browser' +
             (DIAG.lastError ? ' (' + DIAG.lastError + ')' : '') +
             '. Chrome is the only browser this works in reliably.';
    }
    if (!DIAG.everHeard) {
      return 'Listening, but nothing has reached me yet. Check the right microphone ' +
             'is selected and speak up — say “Jarvis”.';
    }
    if (state === 'AWAKENED') return 'Awake — give me a command.';
    if (state === 'PROCESSING') return 'Working on it.';
    return 'Listening. Say “Jarvis”, wait for “Yes, sir”, then give a command.' +
           (BROWSER.isRealChrome ? '' : ' (This browser isn’t Chrome — voice may be unreliable.)');
  }

  function disable(message) {
    shouldRun = false;
    setState('DISABLED');
    paint('disabled');
    if (message) notice(message, true);
    try { if (recognition) recognition.abort(); } catch (e) {}
    running = false;
    if (watchdog) { global.clearInterval(watchdog); watchdog = null; }
  }

  /* =========================================================================
   * SECTION 9 — WAKE-WORD STATE MACHINE
   * -------------------------------------------------------------------------
   *   PASSIVE ──"jarvis"/"wake up jarvis"──► AWAKENED ──valid command──►
   *   PROCESSING ──action done──► PASSIVE
   *        ▲                                        │
   *        └────────── 6s timeout (silent) ─────────┘
   *
   *   PASSIVE:    recogniser runs, but transcripts are ONLY checked against the
   *               wake patterns. Nothing else is parsed, logged, or acted on.
   *   AWAKENED:   says "Yes, sir", starts the 6s window, parses commands.
   *   PROCESSING: executes the matched action, confirms, returns to PASSIVE.
   * =======================================================================*/

  var state = 'IDLE';                 // IDLE | PASSIVE | AWAKENED | PROCESSING | DISABLED
  var awakeTimer = null;
  var buffer = '';                    // in-memory transcript buffer for the
                                      // current wake cycle only — wiped on exit
  var pendingClarification = null;    // {intent, candidates} while asking "which task?"
  var incomplete = null;              // known verb heard, target still missing
  var listeners = [];

  function setState(next, detail) {
    if (state === next) return;
    var prev = state;
    state = next;
    log('state:', prev, '->', next);
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i]({ from: prev, to: next, detail: detail || null }); } catch (e) {}
    }
  }

  function clearBuffer() {
    // Explicitly discard transcript text. Nothing about what the user said
    // survives the end of a wake cycle.
    buffer = '';
  }

  function toPassive() {
    if (awakeTimer) { global.clearTimeout(awakeTimer); awakeTimer = null; }
    pendingClarification = null;
    incomplete = null;
    clearBuffer();
    setState('PASSIVE');
    paint('passive');
  }

  function toAwakened(isClarify) {
    if (awakeTimer) global.clearTimeout(awakeTimer);
    clearBuffer();
    incomplete = null;
    setState('AWAKENED');
    paint('awake', isClarify ? 'WHICH ONE?' : null);

    // Exactly 6 seconds (CONFIG.awakeWindowMs) to produce a valid command.
    awakeTimer = global.setTimeout(function () {
      awakeTimer = null;
      if (state !== 'AWAKENED') return;

      // Two different endings, deliberately:
      //
      //  (a) NOTHING was said in the window -> return to PASSIVE in complete
      //      SILENCE. No "going back to sleep" line; that would be pointless
      //      audio noise. Do not add one unless explicitly requested later.
      //
      //  (b) Something WAS said but never resolved into a valid verb+target
      //      inside the window -> that is a failed match, so give the one
      //      short spoken line plus the red flash and go back to PASSIVE.
      //
      // Deciding only at window close (rather than on the first unmatched
      // chunk) is what lets a command arrive split across several recognition
      // results, e.g. "start" ... "the L1 task".
      var saidSomething = buffer.trim().length > 0;
      if (!saidSomething) {
        log('awake window elapsed with no speech — silent return to PASSIVE');
        toPassive();
        return;
      }
      var reason = incomplete ? reasonFor(incomplete) : null;
      log('awake window elapsed without a valid command — failed match');
      fail(reason);
    }, CONFIG.awakeWindowMs);
  }

  // Short, specific line for a verb we understood but a target we did not.
  function reasonFor(match) {
    if (match.needs === 'subject') return 'Which subject, sir?';
    if (match.needs === 'task') return 'Sorry, sir, I didn’t catch which task';
    return null;
  }

  function handleTranscript(text) {
    if (state === 'DISABLED') return;

    /* ---- PASSIVE: wake-word check ONLY ------------------------------- */
    if (state === 'PASSIVE') {
      var probe = normalize(text);
      for (var i = 0; i < WAKE_PATTERNS.length; i++) {
        if (WAKE_PATTERNS[i].test(probe)) {
          log('wake word detected');
          // Enter AWAKENED first so any further "Jarvis" is ignored (the
          // re-trigger guard below), then greet.
          toAwakened(false);
          speak('Yes, sir');
          return;
        }
      }
      return; // not a wake word -> discarded entirely, nothing retained
    }

    /* ---- RE-TRIGGER GUARD -------------------------------------------- */
    // In AWAKENED/PROCESSING we never re-run wake detection, so "Jarvis"
    // spoken again (by JARVIS, the user, or someone nearby) cannot restart the
    // cycle mid-flight. PROCESSING additionally ignores all input.
    if (state === 'PROCESSING') return;

    /* ---- AWAKENED: accumulate + try to match ------------------------- */
    // Chrome may finalise a command across several chunks ("start" / "the L1
    // task"), so match against the accumulated buffer, not just the new chunk.
    buffer = (buffer + ' ' + text).trim();

    if (pendingClarification) { resolveClarification(buffer); return; }

    var match = matchCommand(buffer);
    if (match && !match.needs) {
      execute(match);                 // complete verb + target -> PROCESSING
      return;
    }
    if (match) {
      // Verb understood, target not (yet). Remember why, then keep listening:
      // the target may still arrive in the next recognition chunk. If the
      // window closes first, the timeout path reports this specific failure.
      incomplete = match;
    }
    // Otherwise: nothing matched yet — stay AWAKENED and keep buffering.
  }

  /* =========================================================================
   * SECTION 10 — DETERMINISTIC COMMAND MATCHER
   * -------------------------------------------------------------------------
   * Strictly: known verb + (known target within N words). No NLP, no LLM, no
   * intent scoring beyond phrase specificity. Fuzziness is limited to simple
   * Levenshtein similarity on TARGET NAMES, to absorb mis-transcriptions.
   * =======================================================================*/

  function matchCommand(raw) {
    var words = prep(raw).split(' ').filter(Boolean);
    if (!words.length) return null;

    /* --- 1. find the most specific known verb ------------------------- */
    var best = null;
    for (var i = 0; i < INTENTS.length; i++) {
      var def = INTENTS[i];
      for (var p = 0; p < def.phrases.length; p++) {
        var phrase = prep(def.phrases[p]);
        var hit = findPhrase(words, phrase);
        if (!hit) continue;
        var score = phrase.split(' ').length * 10 + def.weight;
        if (!best || score > best.score) best = { def: def, hit: hit, score: score };
      }
    }
    if (!best) return null;  // no known verb -> not a command at all

    /* --- 2. build the target search segment --------------------------- */
    // Words AFTER the verb take priority ("start the L1 task"); words BEFORE
    // are also considered so "blowout Physics"/"Physics blowout" both work.
    var after = words.slice(best.hit.end + 1, best.hit.end + 1 + CONFIG.proximityWords).join(' ');
    var before = words.slice(Math.max(0, best.hit.start - CONFIG.proximityWords), best.hit.start).join(' ');

    var intent = best.def.intent;
    var kind = best.def.target;

    /* --- 3. resolve the target ---------------------------------------- */
    if (kind === 'subject') {
      var subj = resolveSubject(after) || resolveSubject(before);
      if (!subj) return { intent: intent, target: null, needs: 'subject' };
      // Anything left over in the window is treated as the optional topic.
      var topic = stripTokens(after, subj.matchedTokens) || null;
      return { intent: intent, subject: subj.name, topic: topic };
    }

    if (kind === 'task' || kind === 'task?') {
      var tasks = safeArray(DEBOS.getCurrentTasks());
      var t = resolveTask(after, tasks) || resolveTask(before, tasks);
      if (t) return { intent: intent, task: t.task };
      if (kind === 'task?') return { intent: intent, task: null, infer: true };
      return { intent: intent, task: null, needs: 'task' };
    }

    if (kind === 'pyq') {
      var pyqs = safeArray(DEBOS.getCurrentTasks()).filter(function (x) { return x.type === 'pyq'; });
      var explicit = resolveTask(after, pyqs) || resolveTask(before, pyqs);
      if (explicit) return { intent: intent, task: explicit.task };
      return { intent: intent, task: null, infer: true };
    }

    return null;
  }

  function resolveSubject(segment) {
    var seg = prep(segment);
    if (!seg) return null;
    var best = null;
    for (var i = 0; i < SUBJECTS.length; i++) {
      for (var a = 0; a < SUBJECTS[i].aliases.length; a++) {
        var alias = prep(SUBJECTS[i].aliases[a]);
        var s = bestWindowSimilarity(seg, alias);
        if (s >= CONFIG.fuzzyThreshold && (!best || s > best.score)) {
          best = { name: SUBJECTS[i].name, score: s, matchedTokens: alias };
        }
      }
    }
    return best;
  }

  function resolveTask(segment, tasks) {
    var seg = prep(segment);
    if (!seg || !tasks.length) return null;
    var best = null;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var cands = [t.id, t.name].concat(safeArray(t.aliases));
      for (var c = 0; c < cands.length; c++) {
        if (!cands[c]) continue;
        var cand = prep(String(cands[c]));
        if (!cand) continue;
        var s = bestWindowSimilarity(seg, cand);
        if (s >= CONFIG.fuzzyThreshold && (!best || s > best.score)) {
          best = { task: t, score: s };
        }
      }
    }
    return best;
  }

  function stripTokens(segment, tokens) {
    var seg = prep(segment), tok = prep(tokens || '');
    if (!seg) return '';
    var out = (' ' + seg + ' ').split(' ').filter(function (w) {
      return w && w !== tok && ['the', 'a', 'an', 'for', 'in', 'on', 'of', 'my', 'this', 'that'].indexOf(w) === -1;
    });
    // Drop any word that is part of the matched subject alias.
    out = out.filter(function (w) { return tok.split(' ').indexOf(w) === -1; });
    return out.join(' ').trim();
  }

  /* =========================================================================
   * SECTION 11 — ACTIONS  (voice logic + stub call + spoken confirmation)
   * =======================================================================*/

  function fail(line) {
    // Failed match: brief red flash + one short spoken line, then PASSIVE.
    flash('error', 1100);
    setState('PROCESSING');
    speak(line || 'Sorry, sir, I didn’t catch a valid command', toPassive);
  }

  /* -------------------------------------------------------------------------
   * Integration-stub return contract. A stub may return:
   *    anything truthy / undefined      -> success, default confirmation line
   *    false  |  { ok:false }           -> failure, default failure line
   *    { ok:false, say:'…' }            -> failure, JARVIS speaks that line
   *    { ok:true,  say:'…' }            -> success, JARVIS speaks that line
   *    a Promise of any of the above    -> resolved, then as above
   * The `say` escape hatch lets the DEB OS adapter give a precise answer
   * ("No Physics task is running, sir") instead of a generic one, without the
   * engine needing to know anything about the site's data model.
   * ---------------------------------------------------------------------- */
  function lineFrom(v) {
    return (v && typeof v === 'object' && typeof v.say === 'string') ? v.say : null;
  }
  function isRejection(v) {
    return v === false || (v && typeof v === 'object' && v.ok === false);
  }
  function settle(result, ok, bad) {
    if (result && typeof result.then === 'function') {
      result.then(function (v) { (isRejection(v) ? bad : ok)(v); }, bad);
    } else if (isRejection(result)) { bad(result); }
    else { ok(result); }
  }
  function okSay(defaultLine)  { return function (v) { done(lineFrom(v) || defaultLine); }; }
  function badSay(defaultLine) { return function (v) { fail(lineFrom(v) || defaultLine); }; }

  function execute(match) {
    setState('PROCESSING');
    paint('processing');

    var intent = match.intent;

    /* ---- missing / ambiguous target handling ------------------------- */
    if (match.needs === 'subject') {
      // A verb we know, a target we don't — no guessing allowed.
      return fail('Which subject, sir?');
    }
    if (match.needs === 'task') {
      return fail('Sorry, sir, I didn’t catch which task');
    }

    if (!match.task && match.infer) {
      // "finish this" / "shelve this" — infer from what's currently active.
      var pool = (intent === 'shelve')
        ? safeArray(DEBOS.getActiveTasks()).filter(function (t) { return t.type === 'pyq'; })
        : safeArray(DEBOS.getActiveTasks());

      if (intent === 'shelve' && !pool.length) {
        var single = DEBOS.getActivePYQSet();
        if (single) pool = [single];
      }
      if (pool.length === 1) {
        match.task = pool[0];                       // exactly one -> infer it
      } else if (pool.length === 0) {
        return fail(intent === 'shelve'
          ? 'No PYQ set is open, sir'
          : 'Nothing is active, sir');
      } else {
        return askWhich(intent, pool);              // ambiguous -> clarify
      }
    }

    /* ---- dispatch to the DEB OS integration stubs -------------------- */
    switch (intent) {
      case 'start':
        return settle(DEBOS.startTask(match.task.id),
          okSay('Starting ' + spokenName(match.task) + ', sir'),
          badSay('Couldn’t start that, sir'));

      case 'complete':
        return settle(DEBOS.markComplete(match.task.id),
          okSay(spokenName(match.task) + ' marked complete, sir'),
          badSay('Couldn’t complete that, sir'));

      case 'log_blowout':
        return settle(DEBOS.logBlowout(match.subject, match.topic),
          okSay('Logged, ' + match.subject + ' blowout'),
          badSay('Couldn’t log that, sir'));

      case 'shelve':
        return settle(DEBOS.shelvePYQSet(match.task.id),
          okSay('Shelved ' + spokenName(match.task) + ', sir'),
          badSay('Couldn’t shelve that, sir'));

      case 'pause':
        return settle(DEBOS.pauseTask(match.task.id),
          okSay('Paused ' + spokenName(match.task) + ', sir'),
          badSay('Couldn’t pause that, sir'));

      case 'cancel':
        return settle(DEBOS.cancelTask(match.task.id),
          okSay('Cancelled ' + spokenName(match.task) + ', sir'),
          badSay('Couldn’t cancel that, sir'));

      default:
        return fail();
    }
  }

  function spokenName(task) {
    if (!task) return 'that task';
    // "L1" reads better aloud as "Lecture 1".
    var n = String(task.name || task.id);
    return /^l\d+$/i.test(n) ? n.replace(/^l/i, 'Lecture ') : n;
  }

  function done(line) {
    paint('processing');
    speak(line, function () { toPassive(); });
  }

  /* ---- clarification sub-flow ---------------------------------------- */
  // Only used when the target genuinely cannot be inferred. Re-opens the 6s
  // window with a restricted candidate list — still deterministic matching.
  function askWhich(intent, candidates) {
    pendingClarification = { intent: intent, candidates: candidates.slice(0, 4) };
    var names = pendingClarification.candidates.map(spokenName).join(', or ');
    setState('AWAKENED');
    speak('Which one, sir? ' + names, function () {
      var keep = pendingClarification;
      toAwakened(true);              // fresh 6s window for the answer
      pendingClarification = keep;   // preserved across the state transition
    });
  }

  function resolveClarification(text) {
    var pc = pendingClarification;
    if (!pc) return;
    var seg = prep(text);

    // Ordinal reference: "the second one".
    var words = seg.split(' ');
    for (var i = 0; i < words.length; i++) {
      if (Object.prototype.hasOwnProperty.call(ORDINALS, words[i])) {
        var idx = ORDINALS[words[i]];
        if (pc.candidates[idx]) {
          pendingClarification = null;
          return execute({ intent: pc.intent, task: pc.candidates[idx] });
        }
      }
    }
    // Otherwise match the name against the shortlist only.
    var hit = resolveTask(seg, pc.candidates);
    if (hit) {
      pendingClarification = null;
      return execute({ intent: pc.intent, task: hit.task });
    }
    // No hit yet — stay awake until the window closes, then fall silent.
  }

  /* =========================================================================
   * SECTION 12 — TAB LIFECYCLE
   * =======================================================================*/

  // Tab visibility: we deliberately do NOT stop recognition here. Backgrounded
  // persistence ("Meet-style") is the requested behaviour — the wake word must
  // still be caught while another tab is focused. Chrome honours this; other
  // browsers may throttle, which is an accepted limitation.
  document.addEventListener('visibilitychange', function () {
    log('visibilitychange ->', document.visibilityState, '(recognition intentionally left running)');
    // Opportunistic revive only: if a throttled tab killed the recogniser,
    // bring it back the moment we notice. Never a stop.
    if (shouldRun && !running && !isUnloading) startRecognition();
  });

  // Tab close / navigation: hard stop. Nothing survives the tab — no service
  // worker, no background listener, no stored listening state.
  function shutdown() {
    isUnloading = true;
    shouldRun = false;
    if (awakeTimer) { global.clearTimeout(awakeTimer); awakeTimer = null; }
    if (watchdog) { global.clearInterval(watchdog); watchdog = null; }
    clearBuffer();
    try { if (recognition) { recognition.onend = null; recognition.abort(); } } catch (e) {}
    try { if (SYNTH_SUPPORTED) SYNTH.cancel(); } catch (e) {}
    running = false;
  }
  global.addEventListener('beforeunload', shutdown);
  global.addEventListener('pagehide', shutdown);   // iOS/Safari-safe equivalent

  /* =========================================================================
   * SECTION 13 — BOOT + PUBLIC API
   * =======================================================================*/

  function boot() {
    injectStyles();
    buildIndicator();

    // Host-page opt-out. DEB OS sets this from jarvis-debos.js when the PIN
    // gate hasn't been passed this session, so a page that is about to bounce
    // to index.html never asks for the microphone.
    if (global.JARVIS_DISABLED) {
      shouldRun = false;
      setState('DISABLED');
      paint('disabled', 'VOICE OFF');
      log('disabled by host page (JARVIS_DISABLED)');
      return;
    }

    if (!SUPPORTED) {
      // EDGE CASE: browser has no SpeechRecognition at all (Firefox, most iOS).
      // Disable cleanly — the rest of DEB OS keeps working exactly as before.
      disable('Voice control doesn’t work in this browser' +
              (BROWSER.isFirefox ? ' — Firefox has no speech recognition' : '') +
              '. Open the site in Google Chrome to use JARVIS.');
      console.warn('[JARVIS] SpeechRecognition unsupported; module disabled.');
      return;
    }
    if (!SYNTH_SUPPORTED) {
      console.warn('[JARVIS] speechSynthesis unavailable; running without spoken replies.');
    }

    toPassive();
    if (CONFIG.autoStart) api.start();

    // Say so up front when this isn't Chrome. The API may exist here and still
    // never deliver a result (Brave blocks the service; some Chromium builds
    // throttle it), and a permanently dim dot with no explanation is the worst
    // possible outcome for someone who can't read the console.
    if (!BROWSER.isRealChrome) {
      notice(BROWSER.isBrave
        ? 'Brave blocks voice recognition by default — open this site in Google Chrome for JARVIS.'
        : (BROWSER.isMobile
            ? 'Voice control needs Chrome on a computer; phone browsers stop listening in the background.'
            : 'Voice control only works properly in Google Chrome. In this browser it may never respond.'));
    }

    // If recognition never even starts, say so rather than sitting there dim.
    global.setTimeout(function () {
      if (!shouldRun || state === 'DISABLED' || DIAG.everStarted) return;
      notice('Voice couldn’t start in this browser' +
             (DIAG.lastError ? ' (' + DIAG.lastError + ')' : '') +
             '. Google Chrome is the supported browser. Tap this dot to retry.');
      paint('disabled', 'NO VOICE');
    }, 6000);
  }

  var api = {
    __initialized: true,
    version: VERSION,
    config: CONFIG,
    integration: DEBOS,        // where the real DEB OS wiring gets plugged in
    supported: SUPPORTED,
    css: CSS,                  // the indicator stylesheet, if you'd rather ship
                               // it as a file (see jarvis.css)

    start: function () {
      if (!SUPPORTED || permissionDenied) return false;
      shouldRun = true;
      isUnloading = false;
      if (state === 'DISABLED' || state === 'IDLE') toPassive();
      startRecognition();
      startWatchdog();
      return true;
    },

    // Manual stop (e.g. a mute button in the DEB OS UI). Same guarantees as a
    // tab close: no listener is left dangling.
    stop: function () {
      shouldRun = false;
      if (watchdog) { global.clearInterval(watchdog); watchdog = null; }
      try { if (recognition) recognition.abort(); } catch (e) {}
      running = false;
      toPassive();
      paint('disabled', 'PAUSED');
      return true;
    },

    getState: function () {
      return { state: state, listening: running, muted: muted,
               awakeMsLeft: awakeTimer ? CONFIG.awakeWindowMs : 0 };
    },

    // Plain-language status, same text the indicator shows when clicked.
    diagnose: diagnose,

    // Raw detail for bug reports: JARVIS.report() in the console.
    report: function () {
      return {
        version: VERSION, state: state, listening: running,
        supported: SUPPORTED, synth: SYNTH_SUPPORTED,
        browser: BROWSER, diag: DIAG, wake: 'jarvis',
        lang: CONFIG.lang, ua: UA
      };
    },

    // Test hook: feed a transcript straight into the state machine, exactly as
    // if it had been heard. Lets the whole voice layer be exercised without a
    // microphone (and without any AI in the loop).
    simulate: function (text) { handleTranscript(String(text)); },

    say: speak,

    // Show a small non-blocking message in the corner (never an alert). The
    // DEB OS adapter uses this once per session to tell the user the wake word.
    notify: function (text, persist) { notice(text, persist); return true; },

    on: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    off: function (fn) { listeners = listeners.filter(function (f) { return f !== fn; }); }
  };

  global.JARVIS = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(typeof window !== 'undefined' ? window : this);
