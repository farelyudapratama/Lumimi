#!/usr/bin/env node
/* test-speech-motion-sync.js — kontrak sinkronisasi motion↔audio dua fase.
 *
 * Root cause yang dijaga: applyActions() langsung playMotion lalu speak(),
 * sementara TTS masih fetch 10-16 dtk → motion habis sebelum suara; saat
 * suara mulai tersisa gaze scheduler acak → robotik/patah-patah.
 * Kontrak baru:
 *  - PRE-SPEECH: reaksi (expression/pose) langsung, speech-motion DITUNDA.
 *  - SPEECH: motion/gesture mulai dari onAudioStart = audio benar-benar bunyi
 *    (elemen audio `playing` / utterance `onstart`), bukan speak/fetch/reveal.
 *  - Scheduler mengalah ke MotionRuntime & saat talking bias ke user kecil.
 *
 * Run: node test/legacy/test-speech-motion-sync.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');
const brainSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'agent', 'brain.ts'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

section('speak(): teruskan onAudioStart + kembalikan status (SUPPRESS tidak bocor)');
ok('job membawa onAudioStart dari opts', /onAudioStart:\s*\n?\s*opts && typeof opts\.onAudioStart/.test(appSrc));
ok('speak SUPPRESS mengembalikan status', /if \(r\.status === "SUPPRESS"\) \{[\s\S]*?return "SUPPRESS"/.test(appSrc));
ok('speak QUEUED mengembalikan status', /if \(r\.status === "QUEUED"\) return "QUEUED"/.test(appSrc));

section('runSpeech(): jangkar sekali-guard, hanya saat claim aktif');
ok('fireAudioStart sekali-guard', /let audioStarted = false;[\s\S]*?const fireAudioStart = \(\) => \{[\s\S]*?if \(audioStarted\) return;/.test(appSrc));
ok('fireAudioStart hormati preempt (isActive)', /const fireAudioStart[\s\S]*?if \(!isActive\(\)\) return;/.test(appSrc));
ok('no-model tetap memicu audio-start (motion tidak hilang)', /if \(!state\.model\) \{[\s\S]*?fireAudioStart\(\);/.test(appSrc));

section('titik akurat: playing/onstart, BUKAN reveal/fetch/speak');
ok('remote: onplaying memicu start', /audio\.onplaying = \(\) => \{[\s\S]*?fireStart\(\);/.test(appSrc));
ok('remote: onplay cadangan memicu start', /audio\.onplay = \(\) => \{[\s\S]*?fireStart\(\);/.test(appSrc));
ok('browser: onstart memicu start', /u\.onstart = \(\) => \{[\s\S]*?onAudioStart/.test(appSrc));
ok('browser: onboundary cadangan memicu start', /u\.onboundary = \(\) => \{[\s\S]*?onAudioStart/.test(appSrc));
ok('doRemoteTTS meneruskan onAudioStart', /async function doRemoteTTS\(text, markDone, sess, reveal, ttsLang, onAudioStart\)/.test(appSrc));
ok('jalur satu-segmen meneruskan ke playTTSAudio', /playTTSAudio\(\s*blob,[\s\S]*?sess,\s*\n?\s*onAudioStart,?\s*\n?\s*\);/.test(appSrc));

section('scheduler: mengalah ke motion runtime saat talking');
ok('yield ke motionRuntime.isPlaying (bukan cuma clip)', /motionRuntime[\s\S]*?\.isPlaying\(\)/.test(appSrc));
ok('talking: bias face-user kuat', /if \(state\.talking\) \{[\s\S]*?r < 0\.85/.test(appSrc));
ok('talking: glance-soft kecil (bukan glance/think besar)', /glance-soft/.test(appSrc) && /ax: s \* R\(2, 4\)/.test(appSrc));
ok('tidak ada glance/think penuh di cabang talking', !/if \(state\.talking\) \{[\s\S]{0,800}?pickGazeIntent\(\)/.test(appSrc));

section('brain.ts dua fase (tanpa fixed delay untuk mulai motion)');
ok('reactionOnly vs speechOnly ada', /reactionOnly/.test(brainSrc) && /speechOnly/.test(brainSrc));
ok('reaction: motion/gesture dilewati', /!reactionOnly && actions\.motion/.test(brainSrc) && /!reactionOnly && gesture/.test(brainSrc));
ok('speech: expression/pose tidak diulang', /!speechOnly/.test(brainSrc));
ok('playSegments mendefer ke onAudioStart', /onAudioStart: startSpeechMotion/.test(brainSrc));
ok('SUPPRESS dimajukan (tidak bocor lock)', /speakStatus === "SUPPRESS"/.test(brainSrc));
ok('tidak ada setTimeout tetap untuk mulai motion', !/setTimeout\([^)]*startSpeechMotion/.test(brainSrc) && !/setTimeout\([^)]*speechOnly/.test(brainSrc));
ok('estimate hanya untuk fitToMs', /fitToMs: actions\.durationMs \|\| estimateSpeechMs\(segmentText\)/.test(brainSrc));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
