import assert from 'node:assert/strict';
import test from 'node:test';

import { SENTENCE_LEAD_MS, cueAt } from '../src/lib/cues';
import { parseMemo, publishedAt } from '../src/lib/memo';
import { freshClipWatch, playbackPlan, reduceClipStatus } from '../src/lib/playback';
import { normalizeClock } from '../src/lib/timing';

test('clock normalization keeps seconds, milliseconds, and mixed units apart', () => {
  assert.deepEqual(normalizeClock(12.5, 40), { positionMs: 12500, durationMs: 40000 });
  assert.deepEqual(normalizeClock(12500, 40), { positionMs: 12500, durationMs: 40000 });
  assert.deepEqual(normalizeClock(25000, 180000), { positionMs: 25000, durationMs: 180000 });
  assert.deepEqual(normalizeClock(0, 3), { positionMs: 0, durationMs: 3000 });
});

test('a cue that has not started is not the current cue', () => {
  const cues = [
    { startMs: 1000, endMs: 2000, sentence: 0, chapter: 0 },
    { startMs: 2000, endMs: 3000, sentence: 1, chapter: 0 },
  ];
  assert.equal(cueAt(cues, 0), null);
  assert.equal(cueAt(cues, 999), null);
  assert.equal(cueAt(cues, 1000)?.sentence, 0);
  assert.equal(cueAt(cues, 2500)?.sentence, 1);
  assert.equal(cueAt(cues, 3000), null);
  assert.equal(cueAt(cues, 1500, 1), null);
  assert.equal(cueAt([{ ...cues[0], audio: 1 }, cues[1]], 1500, 1)?.sentence, 0);
});

test('a sentence starts at its cue, and a padded previous end does not hold it', () => {
  const cues = [
    { startMs: 0, endMs: 5000, sentence: 0, chapter: 0 },
    { startMs: 2500, endMs: 4000, sentence: 1, chapter: 0 },
  ];
  assert.equal(cueAt(cues, 1799)?.sentence, 0);
  assert.equal(cueAt(cues, 1800)?.sentence, 0);
  assert.equal(cueAt(cues, 2500 - SENTENCE_LEAD_MS - 1)?.sentence, 0);
  assert.ok(SENTENCE_LEAD_MS <= 100);
  assert.equal(cueAt(cues, 2500 - 150)?.sentence, 0);
  assert.equal(cueAt(cues, 2500 - SENTENCE_LEAD_MS)?.sentence, 1);
  assert.equal(cueAt(cues, 2500)?.sentence, 1);
  assert.equal(cueAt(cues, 3999)?.sentence, 1);
  assert.equal(cueAt(cues, 4000), null);
  const lead = [{ startMs: 15418, endMs: 16000, sentence: 0, chapter: 0 }];
  assert.equal(cueAt(lead, 2000), null);
  assert.equal(cueAt(lead, 15418)?.sentence, 0);
});

test('a replaced clip does not finish until the new audio has played through', () => {
  let watch = freshClipWatch();
  const stale = reduceClipStatus(watch, { positionMs: 8000, durationMs: 8000, didJustFinish: true });
  assert.equal(stale.finished, false);
  watch = stale.state;
  const reset = reduceClipStatus(watch, { positionMs: 0, durationMs: 2000, didJustFinish: true });
  assert.equal(reset.finished, false);
  watch = reset.state;
  const early = reduceClipStatus(watch, { positionMs: 80, durationMs: 2000, didJustFinish: false });
  assert.equal(early.finished, false);
  watch = early.state;
  const done = reduceClipStatus(watch, { positionMs: 1960, durationMs: 2000, didJustFinish: true });
  assert.equal(done.finished, true);
});

test('a memo keeps the header out of the narration', () => {
  const note = parseMemo(`Title: A Lamp in the Window
Release date: Wednesday, October 15, 2026, after market close (ET)
Description: A short sample.
Sources: https://example.com/a ; https://example.com/b
---
The lamp burned until morning.
https://example.com/skip`);
  assert.equal(note.title, 'A Lamp in the Window');
  assert.match(note.dateLabel, /October 15, 2026/);
  assert.equal(note.sources.length, 2);
  assert.equal(note.spoken.includes('http'), false);
  assert.match(note.spoken, /lamp burned/);
  assert.equal(publishedAt(note.dateLabel), '2026-10-15T20:00:00.000Z');
  assert.equal(publishedAt('Wed Oct 15, 2026, about 3:00 PM ET'), '2026-10-15T19:00:00.000Z');

  const memo = parseMemo(`A note about the lamp (Rewritten 2026-01-15 from source)
January 15, 2026, about 3:00 PM ET
https://example.com/lamp
---
The lamp burned until morning.`);
  assert.equal(memo.note, 'Rewritten 2026-01-15 from source');
  assert.equal(memo.spoken, 'The lamp burned until morning.');
  assert.equal(memo.title.includes('Rewritten'), false);
});

test('bundled audio plays the file even when narration was requested', () => {
  const bundled = { kind: 'audio' as const, bundledAudio: true, hasAudio: true, hasText: true };
  assert.equal(playbackPlan(bundled, 'narrate').action, 'file');
  assert.equal(playbackPlan({ kind: 'book' as const, bundledAudio: true, hasAudio: true, hasText: true }, 'narrate').action, 'file');
  assert.equal(playbackPlan(bundled, 'audio').action, 'file');
  assert.equal(playbackPlan({ ...bundled, hasAudio: false }, 'audio').action, 'error');
  assert.equal(playbackPlan({ kind: 'book' as const, hasAudio: false, hasText: true }, 'audio').action, 'narrate');
});
