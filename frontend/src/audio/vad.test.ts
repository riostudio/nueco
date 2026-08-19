/**
 * Unit tests for the silence-pause VAD. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/audio/vad.test.ts
 */
import { createSilencePauseVad, DEFAULT_SILENCE_PAUSE_CONFIG } from './vad.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

const SPEECH = -25;
const SILENCE = -55;
const cfg = DEFAULT_SILENCE_PAUSE_CONFIG;

function feed(vad: ReturnType<typeof createSilencePauseVad>, dbfs: number | undefined, ts: number) {
  return vad.process(dbfs, ts);
}

function main() {
  console.log('silence-pause VAD:');

  {
    const vad = createSilencePauseVad();
    // Sustained speech never pauses
    let action: any = null;
    for (let t = 0; t < 5000; t += 60) action = feed(vad, SPEECH, t);
    ok('continuous speech never pauses', action === null && vad.state === 'listening');
  }

  {
    const vad = createSilencePauseVad();
    feed(vad, SPEECH, 0); // arm
    let action: any = null;
    for (let t = 60; t < cfg.minSilenceToPauseMs; t += 60) action = feed(vad, SILENCE, t);
    ok(`no pause before ${cfg.minSilenceToPauseMs}ms of silence`, action === null && vad.state === 'listening');
    action = feed(vad, SILENCE, cfg.minSilenceToPauseMs + 60);
    ok('pause emitted once silence exceeds threshold', action === 'pause' && vad.state === 'paused');
  }

  {
    // A natural pause shorter than the threshold must NOT pause the recorder -
    // this is the "segment, do not strip" guarantee.
    const vad = createSilencePauseVad();
    feed(vad, SPEECH, 0);
    let action: any = null;
    for (let t = 60; t <= 700; t += 60) action = feed(vad, SILENCE, t);
    action = feed(vad, SPEECH, 760) ?? action;
    ok('natural pause (~700ms) kept, speech resumes without pause', action === null && vad.state === 'listening');
  }

  {
    // armOnFirstSpeech: silence before any speech must not pause
    const vad = createSilencePauseVad();
    let action: any = null;
    for (let t = 0; t < 10000; t += 60) action = feed(vad, SILENCE, t);
    ok('never-spoken recording stays armed, no pause', action === null && vad.state === 'listening');
  }

  {
    // While paused, samples are ignored; probe cycle resumes on speech.
    // Timeline: speech at 0, silence from 60, pause triggers at t=900 (900-60 >= 900).
    const vad = createSilencePauseVad();
    feed(vad, SPEECH, 0);
    let action: any = null;
    let pausedTs = -1;
    for (let t = 60; t <= 1200; t += 60) {
      const a = feed(vad, SILENCE, t);
      if (a === 'pause') { pausedTs = t; action = a; break; }
      action = a;
    }
    ok('pauses at exactly the sustained-silence threshold', action === 'pause' && pausedTs === 960, `pausedTs=${pausedTs}`);
    ok('stale samples while paused are ignored', feed(vad, SPEECH, pausedTs + 60) === null && vad.state === 'paused');

    ok('shouldProbe false too early', vad.shouldProbe(pausedTs + cfg.probeIntervalMs - 10) === false);
    ok('shouldProbe true after probe interval', vad.shouldProbe(pausedTs + cfg.probeIntervalMs + 10) === true);
    ok('state is probing', vad.state === 'probing');

    const probeTs = pausedTs + cfg.probeIntervalMs + 10;
    ok('silence during probe does not resume yet', feed(vad, SILENCE, probeTs + 60) === null);
    const resumeAction = feed(vad, SPEECH, probeTs + 120);
    ok('speech during probe resumes recording', resumeAction === 'resume' && vad.state === 'listening');
  }

  {
    // Probe with continued silence re-pauses after the probe window
    const vad = createSilencePauseVad();
    feed(vad, SPEECH, 0);
    let pausedTs = -1;
    for (let t = 60; t <= 1200; t += 60) {
      if (feed(vad, SILENCE, t) === 'pause') { pausedTs = t; break; }
    }
    vad.shouldProbe(pausedTs + cfg.probeIntervalMs); // -> probing
    const probeTs = pausedTs + cfg.probeIntervalMs;
    let action: any = null;
    let repausedTs = -1;
    for (let t = 60; t <= cfg.probeWindowMs + 120; t += 60) {
      const a = feed(vad, SILENCE, probeTs + t);
      if (a === 'pause') { repausedTs = probeTs + t; action = a; break; }
      action = a;
    }
    ok('still-silent probe re-pauses', action === 'pause' && vad.state === 'paused' && repausedTs > 0, `repausedTs=${repausedTs}`);
    ok('next probe scheduled from re-pause time', vad.shouldProbe(repausedTs + cfg.probeIntervalMs - 100) === false);
  }

  {
    // Resume threshold hysteresis: a level between silence and resume thresholds does not resume
    const vad = createSilencePauseVad();
    feed(vad, SPEECH, 0);
    let pausedTs = -1;
    for (let t = 60; t <= 1200; t += 60) {
      if (feed(vad, SILENCE, t) === 'pause') { pausedTs = t; break; }
    }
    vad.shouldProbe(pausedTs + cfg.probeIntervalMs);
    const mid = (cfg.silenceThresholdDb + cfg.resumeThresholdDb) / 2; // -40: above silence threshold but below resume threshold
    const action = feed(vad, mid, pausedTs + cfg.probeIntervalMs + 60);
    ok('ambiguous level does not resume during probe', action === null);
  }

  {
    // undefined / NaN metering treated as silence, never crashes
    const vad = createSilencePauseVad();
    feed(vad, SPEECH, 0);
    let action: any = null;
    for (let t = 60; t < cfg.minSilenceToPauseMs + 120; t += 60) action = feed(vad, NaN, t);
    ok('NaN metering counts as silence and eventually pauses', action === 'pause');
    const vad2 = createSilencePauseVad();
    feed(vad2, SPEECH, 0);
    let a2: any = null;
    for (let t = 60; t < cfg.minSilenceToPauseMs + 120; t += 60) a2 = feed(vad2, undefined, t);
    ok('undefined metering counts as silence and eventually pauses', a2 === 'pause');
  }

  {
    const vad = createSilencePauseVad();
    feed(vad, SPEECH, 0);
    feed(vad, SILENCE, cfg.minSilenceToPauseMs + 60);
    vad.reset();
    ok('reset returns to armed listening state', vad.state === 'listening');
    ok('after reset, silence alone does not pause (needs speech first)', (() => {
      let action: any = null;
      for (let t = 0; t < 5000; t += 60) action = feed(vad, SILENCE, t);
      return action === null && vad.state === 'listening';
    })());
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
