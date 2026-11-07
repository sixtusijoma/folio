import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIRST_SOUND_MS,
  PLAY_FAILED,
  clipPath,
  estimateSpeechMs,
  narrationClock,
  nextClipSlot,
  noticeIsRetryable,
  playbackHasStarted,
  prefetchSentences,
  preparingLine,
  raceFirstSound,
  sentenceSpanMs,
  shouldHandoff,
  sourceHasReplaced,
} from '../src/lib/clipQueue';
import { hashText } from '../src/lib/sentences';

const sentences = ['One short line.', 'A second line that runs a bit longer than that.', 'Third.', 'Fourth line here.', 'Last one.'];

test('speech length scales with characters and rate', () => {
  assert.equal(estimateSpeechMs('abcdefghijklmno', 1), 1000);
  assert.equal(estimateSpeechMs('abcdefghijklmno', 2), 500);
  assert.ok(estimateSpeechMs('', 1) > 0);
});

test('a chapter clock walks the whole item, not the clip', () => {
  assert.deepEqual(narrationClock({ elapsedBeforeMs: 7000, clipPositionMs: 1000, clipDurationMs: 4000, remainingAfterMs: 9000 }), {
    positionMs: 8000,
    durationMs: 20000,
  });
  assert.deepEqual(narrationClock({ elapsedBeforeMs: 0, clipPositionMs: 0, clipDurationMs: 0, remainingAfterMs: 15000 }), {
    positionMs: 0,
    durationMs: 15000,
  });
});

test('completed sentences prefer measured clip lengths over estimates', () => {
  const estimates = sentenceSpanMs(sentences, 0, 2, 1);
  const actuals = sentenceSpanMs(sentences, 0, 2, 1, [2500, 8000]);
  assert.equal(actuals, 10500);
  assert.notEqual(actuals, estimates);
});

test('handoff starts before the live clip ends, and never on an empty clip', () => {
  assert.equal(shouldHandoff(0, 0), false);
  assert.equal(shouldHandoff(6880, 7000), true);
  assert.equal(shouldHandoff(5000, 7000), false);
  assert.equal(nextClipSlot(0), 1);
  assert.equal(nextClipSlot(1), 0);
});

test('Kokoro keeps four sentences warm, and a clip file is unique to that text', () => {
  assert.deepEqual(prefetchSentences(sentences, 0, 4), sentences.slice(1, 5));
  assert.deepEqual(prefetchSentences(sentences, 3, 4), ['Last one.']);
  assert.deepEqual(prefetchSentences(sentences, 4, 4), []);
  assert.equal(clipPath('memo', 'kokoro', 'af_bella', 'Hello.'), `items/memo/tts/kokoro/af_bella/${hashText('Hello.')}.wav`);
});

test('a failed start is retryable, and Kokoro download is a preparing line not an error', () => {
  assert.equal(noticeIsRetryable(PLAY_FAILED), true);
  assert.equal(noticeIsRetryable('This chapter could not be downloaded. Check the connection and try again.'), true);
  assert.equal(noticeIsRetryable('Speech did not start. Tap to try again.'), true);
  assert.equal(noticeIsRetryable('Add a Gemini API key in Settings.'), false);
  assert.equal(preparingLine('system'), 'Preparing voice…');
  assert.equal(preparingLine('kokoro', { state: 'loading', progress: 0.4, message: 'Downloading Kokoro… 40%' }), 'Downloading Kokoro… 40%');
  assert.equal(preparingLine('kokoro', { state: 'ready', progress: 1, message: 'Kokoro is on this device.' }), 'Preparing voice…');
});

test('replace is not done while the previous clip is still loaded', () => {
  const previous = { duration: 7, time: 1.4 };
  const stale = { isLoaded: true, currentTime: 1.4, duration: 7, playing: false, error: null };
  assert.equal(sourceHasReplaced(stale, previous, false), false);
  assert.equal(sourceHasReplaced({ ...stale, currentTime: 0 }, previous, false), true);
  assert.equal(sourceHasReplaced({ isLoaded: true, currentTime: 0, duration: 7, error: null }, { duration: 7, time: 0 }, false), false);
  assert.equal(sourceHasReplaced({ isLoaded: true, currentTime: 0, duration: 7, error: null }, { duration: 7, time: 0 }, true), true);
  assert.equal(sourceHasReplaced({ isLoaded: true, currentTime: 0, duration: 4, error: null }, previous, false), true);
  assert.equal(sourceHasReplaced({ isLoaded: false, currentTime: 0, duration: 0, error: null }, previous, false), false);
});

test('Play has not started just because the paused clock is past zero', () => {
  const paused = { isLoaded: true, playing: false, didJustFinish: false, currentTime: 99, duration: 120, error: null };
  assert.equal(playbackHasStarted(paused, 99), false);
  assert.equal(playbackHasStarted({ ...paused, playing: true }, 99), true);
  assert.equal(playbackHasStarted({ ...paused, currentTime: 99.08 }, 99), true);
  assert.equal(playbackHasStarted({ ...paused, didJustFinish: true }, 99), true);
  assert.equal(playbackHasStarted({ ...paused, isLoaded: false }, 99), false);
});

test('the first clip gives up instead of waiting on a hung engine', async () => {
  assert.equal(FIRST_SOUND_MS, 8000);
  const hanging = new Promise<string>(() => undefined);
  await assert.rejects(() => raceFirstSound(hanging, false, 20), /did not finish/);
  const done = Promise.resolve('wav');
  assert.equal(await raceFirstSound(done, false, 50), 'wav');
  assert.equal(await raceFirstSound(Promise.resolve('keep'), true, 20), 'keep');
});
