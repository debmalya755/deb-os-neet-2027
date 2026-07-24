/*!
 * ============================================================================
 *  jarvis-offline.js — offline speech engine for browsers that refuse the
 *  Web Speech API (Brave, Firefox). v1.0.0
 * ============================================================================
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  Brave ships Chromium but deliberately blocks browser speech recognition:
 *  the object exists and simply never returns a result, because Google's
 *  speech service is licensed to Chrome alone and Brave won't route audio to
 *  it. Firefox never implemented the API. There is no setting to flip in
 *  either. The only way to have voice control in those browsers is to bring
 *  our own recogniser.
 *
 *  So this file listens to the microphone directly, decides when a sentence
 *  has been spoken, and transcribes it with a small speech model running
 *  inside the page. The transcript is then handed to jarvis.js through
 *  JARVIS.ingest() — wake word, state machine, command grammar and every
 *  action stay exactly as they were. This is a replacement ear, nothing more.
 *
 *  DELIBERATE DEPARTURE FROM THE ORIGINAL RULES
 *  --------------------------------------------
 *  The original build banned ML models and third-party libraries. This file
 *  breaks that rule on purpose, at the project owner's request, to get voice
 *  working in Brave. Note what it does NOT break: audio never leaves the
 *  machine (arguably more private than Chrome's cloud recognition), there is
 *  still no LLM anywhere, command matching is still deterministic pattern
 *  matching, and nothing survives the tab closing.
 *
 *  COSTS, HONESTLY
 *  ---------------
 *  - One-time ~40MB model download per browser, then cached and fully offline.
 *    Never started without an explicit tap, so it can't surprise a data plan.
 *  - Slower than Chrome: transcription starts when you stop talking and takes
 *    roughly 0.3–2s depending on the machine and whether WebGPU is available.
 *  - Heavier: the model runs on your CPU/GPU. Idle cost is small because
 *    transcription only runs when the microphone actually hears speech, but
 *    this will use more battery than Chrome's native path.
 *  - Less accurate than Chrome on unusual words, which is why the command
 *    grammar's fuzzy target matching matters here.
 *
 *  LOAD ORDER (after jarvis.js, which owns the state machine):
 *      <script src="jarvis-debos.js"></script>
 *      <script src="jarvis.js"></script>
 *      <script src="jarvis-offline.js"></script>
 *
 *  It stays completely dormant when the browser's own recognition works, so
 *  Chrome users download nothing and pay nothing.
 * ============================================================================
 */

(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  /* =========================================================================
   * CONFIG — override before this file loads via window.JARVIS_OFFLINE_CONFIG
   * =======================================================================*/

  var CFG = {
    // transformers.js from jsDelivr. Version range (not an exact pin) so a
    // patch release can't 404 the whole feature; jsDelivr resolves "@3" to the
    // newest 3.x. Swap in a local copy here if you ever want zero CDN reliance.
    lib: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3',

    // Whisper tiny, English-only, int8. The smallest model that transcribes
    // short commands usefully. ~40MB, fetched from the Hugging Face CDN and
    // cached by the browser afterwards.
    model: 'Xenova/whisper-tiny.en',
    dtype: 'q8',
    device: 'auto',            // 'auto' tries WebGPU, falls back to WASM

    sampleRate: 16000,         // what Whisper expects

    /* Voice activity detection (energy based — no second model) ---------- */
    frameMs: 32,               // analysis frame
    startFrames: 3,            // ~96ms above threshold to call it speech
    hangoverMs: 600,           // silence that ends an utterance
    preRollMs: 288,            // audio kept from just before speech started
    minUtteranceMs: 260,       // shorter than this is a cough, not a word
    maxUtteranceMs: 9000,      // hard cap, also Whisper's comfort zone
    floorMargin: 3.0,          // threshold = noise floor * this
    absoluteFloor: 0.008,      // ...but never below this RMS
    noiseCeiling: 0.03,        // ...and the learned floor never above this
    warmupMs: 400,             // listen to the room before judging anything

    maxQueue: 2,               // pending transcriptions before dropping audio
    autoEnableIfAllowed: true, // silently re-enable on later visits
    prefKey: 'debos.jarvis.offline'
  };

  var override = global.JARVIS_OFFLINE_CONFIG;
  if (override) Object.keys(override).forEach(function (k) { CFG[k] = override[k]; });

  /* =========================================================================
   * DO WE EVEN NEED TO BE HERE?
   * =======================================================================*/

  function braveDetected() {
    return !!(global.navigator && global.navigator.brave);
  }

  function webSpeechUsable() {
    var has = !!(global.SpeechRecognition || global.webkitSpeechRecognition);
    // Present-but-inert counts as unusable: that is exactly Brave's behaviour.
    return has && !braveDetected();
  }

  // ?jarvisoffline=1 forces this engine even in Chrome, for testing.
  var forced = false;
  try {
    forced = !!(global.location && /jarvisoffline/.test(global.location.search || ''));
  } catch (e) {}

  var NEEDED = forced || !webSpeechUsable();

  /* =========================================================================
   * VAD SEGMENTER — pure logic, unit-tested in jarvis-offline.test.mjs
   * -------------------------------------------------------------------------
   * Fed one RMS value per frame, it decides where an utterance starts and
   * stops. Keeping it free of audio APIs is what makes it testable at all.
   * =======================================================================*/

  function Segmenter(cfg, onSegment) {
    this.cfg = cfg;
    this.onSegment = onSegment;
    this.reset();
  }

  Segmenter.prototype.reset = function () {
    this.speaking = false;
    this.aboveCount = 0;
    this.silenceMs = 0;
    this.voicedMs = 0;
    this.noiseFloor = 0.004;     // learned from the room during warm-up
    this.startFrame = 0;
    this.lastVoicedFrame = 0;
    this.sumRms = 0;             // for the "is this machinery?" check
    this.rmsFrames = 0;
    this.silentFrames = 0;
    // Spend the first fraction of a second measuring the room instead of
    // reacting to it. Without this, a fan or an air conditioner reads as
    // someone talking continuously.
    this.warmup = Math.max(1, Math.round((this.cfg.warmupMs || 400) / this.cfg.frameMs));
  };

  Segmenter.prototype.threshold = function () {
    return Math.max(this.cfg.absoluteFloor, this.noiseFloor * this.cfg.floorMargin);
  };

  /**
   * @param {number} rms       energy of this frame
   * @param {number} frameIdx  monotonically increasing frame counter
   */
  Segmenter.prototype.push = function (rms, frameIdx) {
    var cfg = this.cfg;

    // --- warm-up: learn the room, judge nothing ---
    if (this.warmup > 0) {
      this.warmup--;
      this.noiseFloor = Math.min(cfg.noiseCeiling, this.noiseFloor * 0.85 + rms * 0.15);
      return null;
    }

    var loud = rms > this.threshold();

    if (!this.speaking) {
      // Keep tracking the quiet background so the bar drifts with the room.
      if (!loud) {
        this.noiseFloor = Math.min(cfg.noiseCeiling, this.noiseFloor * 0.95 + rms * 0.05);
      }
      this.aboveCount = loud ? this.aboveCount + 1 : 0;

      if (this.aboveCount >= cfg.startFrames) {
        this.speaking = true;
        this.voicedMs = this.aboveCount * cfg.frameMs;
        this.silenceMs = 0;
        this.sumRms = rms * this.aboveCount;
        this.rmsFrames = this.aboveCount;
        this.silentFrames = 0;
        var preRollFrames = Math.round(cfg.preRollMs / cfg.frameMs);
        this.startFrame = Math.max(0, frameIdx - this.aboveCount - preRollFrames + 1);
        this.lastVoicedFrame = frameIdx;
      }
      return null;
    }

    // --- inside an utterance ---
    this.voicedMs += cfg.frameMs;
    this.sumRms += rms;
    this.rmsFrames++;
    if (loud) {
      this.silenceMs = 0;
      this.lastVoicedFrame = frameIdx;
    } else {
      this.silenceMs += cfg.frameMs;
      this.silentFrames++;
    }

    var ended = this.silenceMs >= cfg.hangoverMs;
    var tooLong = this.voicedMs >= cfg.maxUtteranceMs;
    if (!ended && !tooLong) return null;

    // Energy that ran for nine seconds without a single quiet frame is a
    // machine — a fan, traffic, a fridge — not a person. Don't transcribe it;
    // relearn the floor from it so it stops registering at all.
    if (tooLong && this.silentFrames === 0) {
      this.noiseFloor = Math.min(cfg.noiseCeiling, this.sumRms / Math.max(1, this.rmsFrames));
      this.speaking = false;
      this.aboveCount = 0; this.silenceMs = 0; this.voicedMs = 0;
      this.sumRms = 0; this.rmsFrames = 0; this.silentFrames = 0;
      return null;
    }

    // Keep a little of the trailing silence so word endings aren't clipped.
    var tailFrames = Math.round(160 / cfg.frameMs);
    var endFrame = Math.min(frameIdx, this.lastVoicedFrame + tailFrames);
    var seg = {
      startFrame: this.startFrame,
      endFrame: endFrame,
      durationMs: (endFrame - this.startFrame + 1) * cfg.frameMs,
      reason: tooLong ? 'max-length' : 'silence'
    };

    this.speaking = false;
    this.aboveCount = 0;
    this.silenceMs = 0;
    this.voicedMs = 0;
    this.sumRms = 0;
    this.rmsFrames = 0;
    this.silentFrames = 0;

    if (seg.durationMs < cfg.minUtteranceMs) return null;   // too short to mean anything
    if (this.onSegment) this.onSegment(seg);
    return seg;
  };

  /* =========================================================================
   * TRANSCRIPT CLEANUP
   * -------------------------------------------------------------------------
   * Whisper politely invents things when given silence or noise — "[BLANK_
   * AUDIO]", "Thanks for watching!", "you". Those must never reach the command
   * matcher, or a cough could start a task.
   * =======================================================================*/

  var HALLUCINATIONS = [
    'thank you', 'thanks for watching', 'thank you for watching', 'you',
    'bye', 'bye bye', 'okay', 'ok', 'oh', 'uh', 'um', 'mm', 'hmm', 'yeah',
    'so', 'the', 'a', 'i', 'and', 'please subscribe', 'subscribe',
    'transcription by castingwords', 'music', 'applause', 'silence',
    'blank audio', 'inaudible', 'foreign'
  ];

  function cleanTranscript(raw) {
    var t = String(raw == null ? '' : raw);
    t = t.replace(/\[[^\]]*\]/g, ' ');      // [BLANK_AUDIO], [Music]
    t = t.replace(/\([^)]*\)/g, ' ');       // (silence)
    t = t.replace(/\*[^*]*\*/g, ' ');       // *coughs*
    t = t.replace(/\s+/g, ' ').trim();
    if (!t) return '';

    var bare = t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (bare.length < 2) return '';
    if (HALLUCINATIONS.indexOf(bare) !== -1) return '';
    // A single short word that isn't the wake word is almost always noise.
    if (bare.indexOf(' ') === -1 && bare.length < 4 && !/^(jarv|trav)/.test(bare)) return '';
    return t;
  }

  /* =========================================================================
   * From here down: browser-only. Nothing below runs under Node, which is why
   * the two pure functions above are exported for testing.
   * =======================================================================*/

  var INTERNALS = { Segmenter: Segmenter, cleanTranscript: cleanTranscript,
                    CFG: CFG, needed: NEEDED, version: VERSION };
  global.JARVIS_OFFLINE_INTERNALS = INTERNALS;

  if (typeof document === 'undefined' || typeof global.navigator === 'undefined') return;

  /* ---------------------------------------------------------------- state */

  var S = {
    ready: false,       // model loaded and microphone live
    loading: false,
    error: null,
    message: null,
    progress: 0,
    listening: false,
    queue: 0,
    transcriptions: 0
  };

  var asr = null;              // the transcription pipeline
  var audioCtx = null, micStream = null, node = null, source = null;
  var ring = null, ringFrames = 0, frameSamples = 0, frameIdx = 0;
  var segmenter = null;
  var busy = false;

  function status() {
    return {
      name: 'offline-whisper',
      ready: S.ready, loading: S.loading, error: S.error,
      message: S.message, progress: S.progress,
      listening: S.listening, transcriptions: S.transcriptions
    };
  }

  function say(msg, keep) {
    S.message = msg;
    if (global.JARVIS && global.JARVIS.notify) global.JARVIS.notify(msg, !!keep);
  }

  function label(text) {
    if (global.JARVIS && global.JARVIS.setLabel) global.JARVIS.setLabel(text);
  }

  function prefAllowed() {
    try { return localStorage.getItem(CFG.prefKey) === 'on'; } catch (e) { return false; }
  }
  function rememberAllowed(on) {
    try { localStorage.setItem(CFG.prefKey, on ? 'on' : 'off'); } catch (e) {}
  }

  /* ------------------------------------------------------------ the model */

  async function loadModel() {
    var mod = await import(/* webpackIgnore: true */ CFG.lib);
    if (mod.env) {
      mod.env.allowLocalModels = false;      // always fetch from the CDN
      if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) {
        // No COOP/COEP headers on GitHub Pages means no SharedArrayBuffer,
        // so threads are unavailable. Say so explicitly rather than letting
        // onnxruntime probe and warn.
        mod.env.backends.onnx.wasm.numThreads = 1;
      }
    }

    var lastShown = -1;
    function onProgress(p) {
      if (!p || p.status !== 'progress' || !p.total) return;
      var pct = Math.round((p.loaded / p.total) * 100);
      S.progress = pct;
      if (pct >= lastShown + 10) {          // don't spam the corner
        lastShown = pct;
        label('DOWNLOADING ' + pct + '%');
        say('Downloading the offline voice model — ' + pct + '%. One time only; ' +
            'after this it works offline.', true);
      }
    }

    var devices = CFG.device === 'auto' ? ['webgpu', 'wasm'] : [CFG.device];
    var lastErr = null;
    for (var i = 0; i < devices.length; i++) {
      try {
        return await mod.pipeline('automatic-speech-recognition', CFG.model, {
          dtype: CFG.dtype,
          device: devices[i],
          progress_callback: onProgress
        });
      } catch (e) {
        lastErr = e;
        // WebGPU is unavailable or crashed — fall through to WASM.
        console.warn('[JARVIS offline] device "' + devices[i] + '" failed:', e && e.message);
      }
    }
    throw lastErr || new Error('no usable backend');
  }

  /* ------------------------------------------------------------ the mic  */

  // Runs in the audio thread: copies each 128-sample block to the main thread.
  var WORKLET_SRC =
    'class JarvisTap extends AudioWorkletProcessor{' +
    '  process(inputs){' +
    '    const ch = inputs[0] && inputs[0][0];' +
    '    if (ch) this.port.postMessage(new Float32Array(ch));' +
    '    return true;' +
    '  }' +
    '}' +
    'registerProcessor("jarvis-tap", JarvisTap);';

  async function openMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,     // helps it not hear its own "Yes, sir"
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    var Ctx = global.AudioContext || global.webkitAudioContext;
    // Ask for 16kHz directly — the browser resamples for us and Whisper gets
    // what it wants. If a platform refuses the hint, fall back to the device
    // rate and resample by hand at extraction time (see resampleTo16k).
    try { audioCtx = new Ctx({ sampleRate: CFG.sampleRate }); }
    catch (e) { audioCtx = new Ctx(); }
    if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (e) {} }
    source = audioCtx.createMediaStreamSource(micStream);

    // Ring buffer holding the last maxUtteranceMs + preRoll of audio.
    frameSamples = Math.round(audioCtx.sampleRate * CFG.frameMs / 1000);
    ringFrames = Math.ceil((CFG.maxUtteranceMs + CFG.preRollMs + 2000) / CFG.frameMs);
    ring = new Float32Array(ringFrames * frameSamples);
    frameIdx = 0;

    segmenter = new Segmenter(CFG, onSegment);

    var pending = new Float32Array(0);
    function onBlock(block) {
      // While JARVIS is speaking, throw audio away and forget any part-heard
      // utterance — otherwise it transcribes its own voice.
      var st = global.JARVIS && global.JARVIS.getState ? global.JARVIS.getState() : null;
      if (st && st.muted) { segmenter.reset(); pending = new Float32Array(0); return; }

      var merged = new Float32Array(pending.length + block.length);
      merged.set(pending, 0); merged.set(block, pending.length);

      var off = 0;
      while (merged.length - off >= frameSamples) {
        var frame = merged.subarray(off, off + frameSamples);
        off += frameSamples;

        var sum = 0;
        for (var i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        var rms = Math.sqrt(sum / frame.length);

        ring.set(frame, (frameIdx % ringFrames) * frameSamples);
        segmenter.push(rms, frameIdx);
        frameIdx++;
      }
      pending = merged.slice(off);
    }

    if (audioCtx.audioWorklet && global.Blob && global.URL && URL.createObjectURL) {
      var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      node = new global.AudioWorkletNode(audioCtx, 'jarvis-tap');
      node.port.onmessage = function (e) { onBlock(e.data); };
      source.connect(node);
      // Worklets need a destination to be pulled; a silent gain keeps it quiet.
      var mute = audioCtx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(audioCtx.destination);
    } else {
      // Deprecated but universally available fallback.
      node = audioCtx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = function (e) { onBlock(new Float32Array(e.inputBuffer.getChannelData(0))); };
      source.connect(node);
      node.connect(audioCtx.destination);
    }
  }

  function closeMic() {
    try { if (node) { node.onaudioprocess = null; if (node.port) node.port.onmessage = null; node.disconnect(); } } catch (e) {}
    try { if (source) source.disconnect(); } catch (e) {}
    // Releasing the tracks is what clears the browser's recording indicator.
    try { if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (audioCtx && audioCtx.close) audioCtx.close(); } catch (e) {}
    node = source = micStream = audioCtx = null;
    S.listening = false;
  }

  /* --------------------------------------------------- segment -> text   */

  // Linear resample to 16kHz. Only used when the AudioContext refused the
  // 16kHz hint — good enough for speech, and far better than feeding Whisper
  // audio at the wrong rate, which produces confident nonsense.
  function resampleTo16k(input, fromRate) {
    if (!fromRate || fromRate === CFG.sampleRate) return input;
    var ratio = fromRate / CFG.sampleRate;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos), i1 = Math.min(i0 + 1, input.length - 1);
      var frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  function extractSegment(seg) {
    // Pull the frames for this utterance out of the ring buffer in order.
    var total = (seg.endFrame - seg.startFrame + 1);
    if (total <= 0) return null;
    if (total > ringFrames) { seg.startFrame = seg.endFrame - ringFrames + 1; total = ringFrames; }
    var out = new Float32Array(total * frameSamples);
    for (var f = 0; f < total; f++) {
      var slot = ((seg.startFrame + f) % ringFrames) * frameSamples;
      out.set(ring.subarray(slot, slot + frameSamples), f * frameSamples);
    }
    return out;
  }

  function onSegment(seg) {
    if (!S.ready) return;
    // One utterance at a time. Dropping the newer clip is better than queuing
    // audio the user has already moved past — a stale command executed late is
    // worse than one that never fires.
    if (busy) { console.warn('[JARVIS offline] busy — dropped an utterance'); return; }
    var audio = extractSegment(seg);
    if (!audio) return;
    audio = resampleTo16k(audio, audioCtx && audioCtx.sampleRate);
    S.queue++;
    transcribe(audio).catch(function (e) {
      console.warn('[JARVIS offline] transcription failed:', e && e.message);
    }).then(function () { S.queue = Math.max(0, S.queue - 1); });
  }

  async function transcribe(audio) {
    busy = true;
    try {
      label('THINKING');
      var out = await asr(audio);
      S.transcriptions++;
      var text = cleanTranscript(out && (out.text || (out[0] && out[0].text)));
      if (!text) { label('JARVIS'); return; }
      if (global.JARVIS && global.JARVIS.ingest) global.JARVIS.ingest(text);
      else console.log('[JARVIS offline] heard:', text);
      // The transcript is not stored anywhere — it goes straight to the state
      // machine and the local variable falls out of scope.
    } finally {
      busy = false;
      label('JARVIS');
    }
  }

  /* ------------------------------------------------------- public engine */

  var recognizer = {
    name: 'offline-whisper',
    status: status,

    // Called by jarvis.js when it wants listening to resume.
    start: function () {
      if (S.ready) { S.listening = true; return true; }
      // Not ready: only auto-load if the user already opted in on this device.
      if (CFG.autoEnableIfAllowed && prefAllowed() && !S.loading) recognizer.enable();
      return false;
    },

    stop: function () {
      closeMic();
      return true;
    },

    // User gesture: microphone permission + one-time model download.
    enable: async function () {
      if (S.loading || S.ready) return;
      S.loading = true; S.error = null;
      label('STARTING');
      say('Starting the offline voice engine — allow the microphone if asked.', true);
      try {
        // Microphone first: a refusal here should not cost a 40MB download.
        await openMic();
        say('Microphone on. Loading the voice model (about 40MB, one time)…', true);
        asr = await loadModel();
        S.ready = true;
        S.listening = true;
        rememberAllowed(true);
        label('JARVIS');
        say('Offline voice is ready. Say “Jarvis”, then your command. ' +
            'Everything stays on this device.');
        if (global.JARVIS && global.JARVIS.start) global.JARVIS.start();
      } catch (e) {
        S.error = (e && (e.name === 'NotAllowedError' ? 'microphone blocked' : e.message)) || 'unknown';
        closeMic();
        label('NO VOICE');
        say(e && e.name === 'NotAllowedError'
          ? 'Microphone permission was refused, so offline voice can’t run. ' +
            'Allow it via the address-bar icon and tap the dot again.'
          : 'The offline voice engine couldn’t start (' + S.error + '). ' +
            'The rest of DEB OS is unaffected — tap the dot to retry, or use Chrome.', true);
        console.warn('[JARVIS offline] enable failed:', e);
      } finally {
        S.loading = false;
      }
    }
  };

  /* ------------------------------------------------------------ bootstrap */

  function install() {
    if (!NEEDED) {
      // Chrome and friends: stay out of the way entirely. No model, no mic.
      return;
    }
    var J = global.JARVIS;
    if (!J || !J.useExternalRecognizer) {
      console.warn('[JARVIS offline] jarvis.js not found — load it before this file.');
      return;
    }
    if (J.getState && J.getState().state === 'DISABLED' && global.JARVIS_DISABLED) {
      return;   // locked session; nothing to do
    }

    J.useExternalRecognizer(recognizer);

    if (prefAllowed() && CFG.autoEnableIfAllowed) {
      // Already opted in on this device: model is cached and permission is
      // remembered, so bring it up without making them tap again.
      recognizer.enable();
    } else {
      label('TAP TO TALK');
      say('This browser can’t use Google’s speech service' +
          (braveDetected() ? ' (Brave blocks it)' : '') +
          '. Tap this dot once to switch on the offline voice engine — ' +
          'a ~40MB one-time download, then it works with no internet at all.', true);
    }
  }

  // jarvis.js boots on DOMContentLoaded; make sure it has run first.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(install, 0); });
  } else {
    setTimeout(install, 0);
  }

  global.JARVIS_OFFLINE = { version: VERSION, recognizer: recognizer, config: CFG,
                            status: status, enable: function () { return recognizer.enable(); },
                            internals: INTERNALS };

})(typeof window !== 'undefined' ? window : this);
