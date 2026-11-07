import assert from 'node:assert/strict';
import test from 'node:test';

import { listenMode, offersVoiceChoice, playbackPlan, skipSentence } from '../src/lib/playback';
import { sentenceAtTime, timeForSentence, type SpokenSource } from '../src/lib/spoken';
import { narrationLabel } from '../src/lib/voices';

const memo = { kind: 'audio' as const, bundledAudio: true, hasAudio: true, hasText: true };

test('a scripted audio piece plays its recording until Voice is chosen', () => {
  assert.equal(playbackPlan(memo, 'audio').action, 'file');
  assert.equal(playbackPlan({ ...memo, listen: 'recording' }, 'audio').action, 'file');
  assert.equal(playbackPlan({ ...memo, listen: 'voice' }, 'audio').action, 'narrate');
  assert.equal(playbackPlan({ ...memo, listen: 'voice' }, 'narrate').action, 'narrate');
  assert.equal(listenMode(memo), 'recording');
  assert.equal(listenMode({ ...memo, listen: 'voice' }), 'voice');
});

test('Voice reads a piece whose recording is missing, and Original recording still reports it', () => {
  assert.equal(playbackPlan({ ...memo, hasAudio: false, listen: 'voice' }, 'audio').action, 'narrate');
  assert.equal(playbackPlan({ ...memo, hasAudio: false }, 'audio').action, 'error');
});

test('only a scripted audio item offers the voice choice', () => {
  assert.equal(offersVoiceChoice(memo), true);
  assert.equal(offersVoiceChoice({ ...memo, hasText: false }), false);
  assert.equal(offersVoiceChoice({ kind: 'book', hasText: true }), false);
  assert.equal(offersVoiceChoice({ kind: 'article', hasText: true }), false);
  assert.equal(playbackPlan({ kind: 'book', bundledAudio: true, hasAudio: true, hasText: true, listen: 'voice' }, 'narrate').action, 'file');
  assert.equal(listenMode({ kind: 'book', hasText: true, listen: 'voice' }), 'recording');
});

const captioned: SpokenSource = {
  sync: 'vtt',
  chapters: [{ sentences: 5 }],
  audioChapters: [{ title: 'Memo', file: 'audio.mp3', textChapter: 0 }],
  cues: [
    { startMs: 400, endMs: 2000, chapter: 0, sentence: 0 },
    { startMs: 2300, endMs: 4100, chapter: 0, sentence: 1 },
    { startMs: 4100, endMs: 5000, chapter: 0, sentence: 2 },
    { startMs: 5000, endMs: 6200, chapter: 0, sentence: 2 },
    { startMs: 7000, endMs: 9000, chapter: 0, sentence: 4 },
  ],
};

test('the recording position maps to the caption it is in, and a gap keeps the caption before', () => {
  assert.deepEqual(sentenceAtTime(captioned, 0, 0, 0), { chapter: 0, sentence: 0 });
  assert.deepEqual(sentenceAtTime(captioned, 0, 1000, 0), { chapter: 0, sentence: 0 });
  assert.deepEqual(sentenceAtTime(captioned, 0, 2100, 0), { chapter: 0, sentence: 0 });
  assert.deepEqual(sentenceAtTime(captioned, 0, 5500, 0), { chapter: 0, sentence: 2 });
  assert.deepEqual(sentenceAtTime(captioned, 0, 6600, 0), { chapter: 0, sentence: 2 });
  assert.deepEqual(sentenceAtTime(captioned, 0, 60000, 0), { chapter: 0, sentence: 4 });
});

test('a narrated sentence maps to its first caption, and an uncaptioned one to the caption before', () => {
  assert.deepEqual(timeForSentence(captioned, 0, 0), { audioChapter: 0, positionMs: 400 });
  assert.deepEqual(timeForSentence(captioned, 0, 2), { audioChapter: 0, positionMs: 4100 });
  assert.deepEqual(timeForSentence(captioned, 0, 3), { audioChapter: 0, positionMs: 4100 });
  assert.deepEqual(timeForSentence(captioned, 0, 4), { audioChapter: 0, positionMs: 7000 });
  assert.equal(timeForSentence(captioned, 1, 0), null);
});

test('the two maps round-trip on every captioned sentence', () => {
  for (const sentence of [0, 1, 2, 4]) {
    const at = timeForSentence(captioned, 0, sentence);
    assert.ok(at);
    assert.deepEqual(sentenceAtTime(captioned, at.audioChapter, at.positionMs, 0), { chapter: 0, sentence });
  }
});

test('without captions the sentence is estimated from the duration, and the recording keeps its place', () => {
  const plain: SpokenSource = { ...captioned, sync: 'approximate', cues: [] };
  assert.equal(sentenceAtTime(plain, 0, 5000, 0), null);
  assert.deepEqual(sentenceAtTime(plain, 0, 5000, 10000), { chapter: 0, sentence: 2 });
  assert.equal(timeForSentence(plain, 0, 2), null);
});

const sentences = ['One short line.', 'A second line that runs a bit longer than that.', 'Third.', 'Fourth line here.', 'Last one.'];

test('a narration skip spends its seconds on the text and always moves a sentence', () => {
  assert.equal(skipSentence(sentences, 0, 1000), 1);
  assert.equal(skipSentence(sentences, 0, 30000), 4);
  assert.equal(skipSentence(sentences, 1, 1000), 2);
  assert.equal(skipSentence(sentences, 2, 3000), 4);
  assert.equal(skipSentence(sentences, 4, -1000), 3);
  assert.equal(skipSentence(sentences, 4, -15000), 0);
  assert.equal(skipSentence(sentences, 3, -1000), 1);
});

test('a narration skip stops at either end', () => {
  assert.equal(skipSentence(sentences, 4, 30000), 4);
  assert.equal(skipSentence(sentences, 0, -15000), 0);
  assert.equal(skipSentence(sentences, 9, -1000), 3);
  assert.equal(skipSentence([], 3, 1000), 0);
});

const kokoro = [
  { id: 'af_heart', label: 'Heart · American woman' },
  { id: 'bf_emma', label: 'Emma · British woman' },
];
const gemini = [{ id: 'Kore', label: 'Kore · Firm' }];

test('the voice toggle names the engine and the voice it will read with', () => {
  assert.equal(narrationLabel({ engine: 'system', kokoroVoice: 'bf_emma', geminiVoice: 'Kore' }, kokoro, gemini), 'System');
  assert.equal(narrationLabel({ engine: 'kokoro', kokoroVoice: 'bf_emma', geminiVoice: 'Kore' }, kokoro, gemini), 'Kokoro · Emma');
  assert.equal(narrationLabel({ engine: 'gemini', kokoroVoice: 'bf_emma', geminiVoice: 'Kore' }, kokoro, gemini), 'Gemini · Kore');
  assert.equal(narrationLabel({ engine: 'kokoro', kokoroVoice: 'xx_new', geminiVoice: 'Kore' }, kokoro, gemini), 'Kokoro · xx_new');
});
