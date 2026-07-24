/*!
 * ============================================================================
 *  jarvis-debos.js — DEB OS data-layer adapter for the JARVIS voice module
 *  v1.0.0
 * ============================================================================
 *
 *  This is the ONLY file that knows how DEB OS stores its data. It defines
 *  window.DEBOS, which jarvis.js consumes. Load it BEFORE jarvis.js:
 *
 *      <div id="jarvis-indicator"></div>
 *      <script src="jarvis-debos.js"></script>
 *      <script src="jarvis.js"></script>
 *
 *  If the site's storage model changes, only this file changes. The voice
 *  engine (state machine, wake word, grammar) stays untouched.
 *
 *  WHAT IT TALKS TO
 *  ----------------
 *  localStorage key `debos.tasks.<YYYY-MM-DD>` — today's task array, exactly
 *  the shape command.html and the subject pages already write:
 *
 *      { id, name, unit, subject, topic, assignedMin, actualMin,
 *        status: 'not-started'|'in-progress'|'paused'|'completed',
 *        blowout, startedAt, deadline, completedAt }
 *
 *  TWO EXECUTION CONTEXTS
 *  ----------------------
 *  1. command.html holds the same array in memory and re-renders from it. So
 *     when window.DEBOS_BRIDGE exists (command.html exposes it), every write
 *     goes through the page's own markCompleted / setTaskStatus functions —
 *     no duplicated business logic, and the UI updates instantly.
 *  2. physics/chemistry/biology.html keep no in-memory copy; they read and
 *     write localStorage on demand. There the adapter writes storage directly,
 *     mirroring the exact same status transitions command.html performs. An
 *     open command.html tab picks the change up via its `storage` listener.
 *
 *  DESIGN DECISIONS (per project owner)
 *  ------------------------------------
 *  - "shelve this"  → sets the active PYQ-50 task to 'paused'. Nothing else:
 *                     no new flag, no new storage key, no shelving history.
 *                     (Swap in a richer log later by editing shelvePYQSet.)
 *  - "log blowout X"→ flags the RUNNING task if its subject matches, exactly
 *                     like the existing "Log blowout" button on the Now card.
 *                     If nothing matching is running it refuses and says so
 *                     rather than guessing at a task.
 *  - "cancel"       → resets the task to 'not-started' (clears actualMin and
 *                     the blowout flag), which is what the site's own status
 *                     picker does for that transition.
 * ============================================================================
 */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------ session gate
   * Every DEB OS page bounces to the PIN screen unless this session flag is
   * set. If we're on such a page, tell the engine to stay switched off so the
   * browser never prompts for the microphone on a page that's about to
   * redirect. index.html itself never loads JARVIS at all.
   * ---------------------------------------------------------------------- */
  try {
    if (sessionStorage.getItem('debos.session.unlocked') !== '1') {
      global.JARVIS_DISABLED = 1;
    }
  } catch (e) { /* storage blocked — leave JARVIS enabled, engine handles it */ }

  /* ---------------------------------------------------------------- storage */

  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function tasksKey() { return 'debos.tasks.' + todayISO(); }

  function load() {
    // Prefer command.html's live in-memory array so we never fight its state.
    var bridge = global.DEBOS_BRIDGE;
    if (bridge && typeof bridge.getTasks === 'function') {
      try { return bridge.getTasks() || []; } catch (e) {}
    }
    try { return JSON.parse(localStorage.getItem(tasksKey()) || '[]') || []; }
    catch (e) { return []; }
  }

  function save(tasks) {
    try { localStorage.setItem(tasksKey(), JSON.stringify(tasks)); } catch (e) {}
    var bridge = global.DEBOS_BRIDGE;
    // Ask command.html to re-render if we're on that page.
    if (bridge && typeof bridge.refresh === 'function') {
      try { bridge.refresh(); } catch (e) {}
    }
  }

  function byId(tasks, id) {
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i];
    return null;
  }

  /* ------------------------------------------------- status transitions -----
   * Mirrors command.html's setTaskStatus() / markCompleted() semantics for the
   * subject-page path. On command.html the bridge is used instead, so this
   * logic never diverges into a second source of truth there.
   * ---------------------------------------------------------------------- */

  function applyStatus(tasks, task, next) {
    if (!task || task.status === next) return false;
    if (next === 'in-progress') {
      // Only one task runs at a time — pause whatever else is running.
      tasks.forEach(function (x) {
        if (x !== task && x.status === 'in-progress') {
          x.actualMin = Math.floor((Date.now() - x.startedAt) / 60000);
          x.status = 'paused'; x.startedAt = 0;
        }
      });
      task.startedAt = Date.now() - (task.actualMin || 0) * 60000;
      task.completedAt = null;
    } else if (next === 'paused') {
      if (task.status === 'in-progress') {
        task.actualMin = Math.floor((Date.now() - task.startedAt) / 60000);
      }
      task.startedAt = 0;
      task.completedAt = null;
    } else if (next === 'completed') {
      if (task.status === 'in-progress') {
        task.actualMin = Math.floor((Date.now() - task.startedAt) / 60000);
      }
      if (task.actualMin > task.assignedMin) task.blowout = true;   // same rule
      task.startedAt = 0;
      task.completedAt = todayISO();
    } else if (next === 'not-started') {
      task.actualMin = 0; task.startedAt = 0; task.completedAt = null;
      task.blowout = false;
    }
    task.status = next;
    return true;
  }

  // Single write path: bridge when available, direct storage otherwise.
  function transition(id, next, failLine) {
    var bridge = global.DEBOS_BRIDGE;
    if (bridge && typeof bridge.setTaskStatus === 'function') {
      var t = byId(load(), id);
      if (!t) return { ok: false, say: failLine || 'I couldn’t find that task, sir' };
      bridge.setTaskStatus(id, next);
      return true;
    }
    var tasks = load();
    var task = byId(tasks, id);
    if (!task) return { ok: false, say: failLine || 'I couldn’t find that task, sir' };
    applyStatus(tasks, task, next);
    save(tasks);
    return true;
  }

  /* ----------------------------------------------------- voice-facing view --
   * jarvis.js expects { id, name, subject, type, active, aliases }. Aliases are
   * what make loose speech land on the right row: the chapter/topic, the unit
   * ("PYQ", "DPP"), and a spoken shorthand for lecture numbers so that
   * "start L1", "start lecture one" and "start lecture 1" all resolve.
   * ---------------------------------------------------------------------- */

  function unitType(unit) {
    var u = String(unit || '').toLowerCase();
    if (u.indexOf('pyq') !== -1) return 'pyq';
    if (u.indexOf('dpp') !== -1) return 'dpp';
    return 'lecture';
  }

  function aliasesFor(t) {
    var out = [];
    if (t.topic) out.push(t.topic);
    if (t.unit) out.push(t.unit);

    // "Lecture 3" / "L3" / "lec 3" in the task name → alias "l3"
    var m = String(t.name || '').match(/(?:^|\b)(?:l|lec|lect|lecture)\s*[-–]?\s*(\d+)\b/i);
    if (m) { out.push('l' + m[1]); out.push('lecture ' + m[1]); }

    // A bare trailing number ("Rotational Motion 2") is a weak but useful hook.
    var n = String(t.name || '').match(/\b(\d{1,2})\s*$/);
    if (n && !m) out.push('l' + n[1]);

    if (unitType(t.unit) === 'pyq') { out.push('pyq'); out.push('pyq set'); }
    if (unitType(t.unit) === 'dpp') out.push('dpp');

    return out.filter(Boolean);
  }

  function view(t) {
    return {
      id: t.id,
      name: t.name,
      subject: t.subject,
      type: unitType(t.unit),
      active: t.status === 'in-progress',
      aliases: aliasesFor(t)
    };
  }

  function openTasks(tasks) {   // anything not finished today
    return tasks.filter(function (t) { return t.status !== 'completed'; });
  }

  /* ------------------------------------------------------------ the adapter */

  var DEBOS = {

    /* ---- reads ---------------------------------------------------------- */

    // Only unfinished tasks are voice-addressable: saying "start L1" should
    // never re-open something already ticked off.
    getCurrentTasks: function () {
      return openTasks(load()).map(view);
    },

    getTaskById: function (id) {
      var t = byId(load(), id);
      return t ? view(t) : null;
    },

    getActiveTasks: function () {
      return load().filter(function (t) { return t.status === 'in-progress'; }).map(view);
    },

    // "shelve this" target: the running PYQ set, or the only open one.
    getActivePYQSet: function () {
      var tasks = load();
      var running = tasks.filter(function (t) {
        return t.status === 'in-progress' && unitType(t.unit) === 'pyq';
      });
      if (running.length) return view(running[0]);
      var open = openTasks(tasks).filter(function (t) { return unitType(t.unit) === 'pyq'; });
      return open.length === 1 ? view(open[0]) : null;
    },

    /* ---- writes --------------------------------------------------------- */

    startTask: function (taskId) {
      var t = byId(load(), taskId);
      if (!t) return { ok: false, say: 'I couldn’t find that task, sir' };
      if (t.status === 'completed') {
        return { ok: false, say: t.name + ' is already complete, sir' };
      }
      if (t.status === 'in-progress') {
        return { ok: true, say: t.name + ' is already running, sir' };
      }
      return transition(taskId, 'in-progress');
    },

    markComplete: function (taskId) {
      var t = byId(load(), taskId);
      if (!t) return { ok: false, say: 'I couldn’t find that task, sir' };
      if (t.status === 'completed') {
        return { ok: true, say: t.name + ' was already complete, sir' };
      }
      var bridge = global.DEBOS_BRIDGE;
      if (bridge && typeof bridge.markCompleted === 'function') {
        bridge.markCompleted(taskId);      // reuse the page's own logic
      } else {
        var tasks = load();
        applyStatus(tasks, byId(tasks, taskId), 'completed');
        save(tasks);
      }
      // Read back so the confirmation can mention an overrun honestly.
      var after = byId(load(), taskId);
      if (after && after.blowout) {
        return { ok: true, say: after.name + ' complete, sir — logged as a blowout' };
      }
      return { ok: true, say: (after ? after.name : 'Task') + ' marked complete, sir' };
    },

    // Flags the running task for that subject, matching the Now card's
    // "Log blowout" button. Refuses rather than guessing if nothing matches.
    logBlowout: function (subject, topic) {
      var tasks = load();
      var candidates = tasks.filter(function (t) {
        return t.status === 'in-progress' && t.subject === subject;
      });

      // Optional spoken topic narrows it further, e.g. "blowout physics rotation".
      if (candidates.length > 1 && topic) {
        var needle = String(topic).toLowerCase();
        var narrowed = candidates.filter(function (t) {
          return (String(t.topic || '') + ' ' + String(t.name || '')).toLowerCase().indexOf(needle) !== -1;
        });
        if (narrowed.length) candidates = narrowed;
      }

      if (!candidates.length) {
        return { ok: false, say: 'No ' + subject + ' task is running, sir' };
      }
      var target = candidates[0];
      if (target.blowout) {
        return { ok: true, say: target.name + ' is already flagged, sir' };
      }
      target.blowout = true;
      save(tasks);
      return { ok: true, say: 'Logged, ' + subject + ' blowout on ' + target.name };
    },

    // Owner's choice: shelving is just a pause on the existing status model —
    // no extra flag, no extra storage key, no shelving log.
    // TODO(optional): if a real shelving log lands later, extend this one
    // function; nothing else in the voice stack needs to change.
    shelvePYQSet: function (setId) {
      var t = byId(load(), setId);
      if (!t) return { ok: false, say: 'I couldn’t find that set, sir' };
      if (t.status === 'paused') {
        return { ok: true, say: t.name + ' is already shelved, sir' };
      }
      var res = transition(setId, 'paused');
      if (res !== true) return res;
      return { ok: true, say: 'Shelved ' + t.name + ', sir' };
    },

    pauseTask: function (taskId) {
      var t = byId(load(), taskId);
      if (!t) return { ok: false, say: 'I couldn’t find that task, sir' };
      if (t.status !== 'in-progress') {
        return { ok: false, say: t.name + ' isn’t running, sir' };
      }
      return transition(taskId, 'paused');
    },

    // "cancel" = back to Not started, clearing time logged and the blowout
    // flag — the same reset the site's status picker performs.
    cancelTask: function (taskId) {
      var t = byId(load(), taskId);
      if (!t) return { ok: false, say: 'I couldn’t find that task, sir' };
      var res = transition(taskId, 'not-started');
      if (res !== true) return res;
      return { ok: true, say: 'Reset ' + t.name + ' to not started, sir' };
    }
  };

  /* ------------------------------------------------------------- first run --
   * Once per browser session, after the engine has settled, show a quiet corner
   * hint naming the wake word — otherwise a fresh tab gives no clue that voice
   * control exists. Suppressed if the engine disabled itself (unsupported
   * browser, mic denied, locked session), since it prints its own message then.
   * The only thing stored is a "hint already shown" flag: no audio, no
   * transcript, nothing about what was said.
   * ---------------------------------------------------------------------- */
  function maybeHint() {
    if (global.JARVIS_DISABLED) return;
    try {
      if (sessionStorage.getItem('debos.jarvis.hinted') === '1') return;
      sessionStorage.setItem('debos.jarvis.hinted', '1');
    } catch (e) { return; }
    setTimeout(function () {
      var J = global.JARVIS;
      if (!J || !J.notify) return;
      if (J.getState().state === 'DISABLED') return;   // engine already spoke up
      J.notify('Voice control is on. Say “Captain”, wait for “Yes, sir”, ' +
               'then give a command — e.g. “start L1” or “mark complete”.');
    }, 1800);
  }
  // jarvis.js loads after this file, so wait a tick for JARVIS to exist.
  if (typeof setTimeout === 'function') setTimeout(maybeHint, 0);

  // Merge rather than overwrite, so a page can pre-define its own overrides.
  var existing = global.DEBOS || {};
  Object.keys(DEBOS).forEach(function (k) {
    if (typeof existing[k] !== 'function') existing[k] = DEBOS[k];
  });
  global.DEBOS = existing;
  global.DevOS = existing;   // alias kept for the stub names in the spec

})(typeof window !== 'undefined' ? window : this);
