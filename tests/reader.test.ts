import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NOW_PLAYING_ROLE,
  audioIndexForTextChapter,
  locatorForSpoken,
  nowPlayingAccessibilityLabel,
  nowPlayingNavigation,
  nowPlayingReaderAction,
  playbackNotice,
  resumeChoice,
} from '../src/lib/playback';
import {
  FOLLOW_BOTTOM,
  FOLLOW_TOP,
  applyScrollReport,
  openingPlace,
  readingProgress,
  reduceFollow,
  scrollRatio,
  shouldFollowScroll,
  shouldPersistScroll,
  type LookPosition,
} from '../src/lib/readerFollow';
import { readerDocument, readerDocumentKey } from '../src/lib/readerHtml';
import { playbackReloads, shouldReloadChapter } from '../src/lib/readerStability';
import { SETTINGS_VERSION, mergeSettings } from '../src/lib/types';

const body = '<p><span class="s" data-i="0">The fire burned.</span> <span class="s" data-i="1">Filby answered.</span></p>';

test('playback ticks do not reload the chapter or rebuild the reader document', () => {
  const ticks = Array.from({ length: 40 }, (_, index) => ({
    itemId: 'time-machine',
    chapter: 1,
    audioPositionMs: index * 80,
    progress: index / 400,
  }));
  assert.equal(playbackReloads(ticks.map(({ itemId, chapter }) => ({ itemId, chapter }))), 1);
  assert.equal(shouldReloadChapter({ itemId: 'time-machine', chapter: 1 }, { itemId: 'time-machine', chapter: 1 }), false);
  assert.equal(shouldReloadChapter({ itemId: 'time-machine', chapter: 1 }, { itemId: 'time-machine', chapter: 2 }), true);
  const options = { body, width: 390, fontSize: 20, lineHeight: 1.45, margin: 28, font: 'serif' as const, theme: 'sepia' as const };
  const key = readerDocumentKey(options);
  assert.equal(readerDocumentKey({ ...options, width: 390.2 }), key);
  assert.equal(readerDocumentKey({ ...options, width: 390.4 }), key);
  assert.notEqual(readerDocumentKey({ ...options, width: 412 }), key);
  const first = readerDocument(options);
  const again = readerDocument({ ...options, width: 390.2 });
  assert.equal(first, again);
  for (const tick of ticks) {
    assert.equal(readerDocumentKey(options), key);
    assert.ok(tick.audioPositionMs >= 0);
  }
});

test('the reader document scrolls vertically and does not mark the current text', () => {
  const html = readerDocument({ body, width: 390, fontSize: 20, lineHeight: 1.45, margin: 28, font: 'serif', theme: 'sepia' });
  assert.equal(html.includes('column-width'), false);
  assert.equal(html.includes('column-gap'), false);
  assert.equal(html.includes('.on'), false);
  assert.equal(html.includes('data-w'), false);
  assert.match(html, /overflow-y:\s*auto/);
  assert.match(html, new RegExp(String(FOLLOW_TOP)));
  assert.match(html, new RegExp(String(FOLLOW_BOTTOM)));
  assert.match(html, /scrollIntoView/);
  assert.match(html, /let scrollOrigin = 'restore'/);
  assert.match(html, /if \(scrollOrigin === origin\) scrollOrigin = 'restore'/);
  assert.match(html, /scrollOrigin = 'user'/);
  assert.match(html, /follow/);
});

test('follow pauses for a manual scroll and resumes from the button or play', () => {
  assert.equal(reduceFollow('following', 'user-scroll'), 'suspended');
  assert.equal(reduceFollow('suspended', 'resume'), 'following');
  assert.equal(reduceFollow('suspended', 'play'), 'following');
  assert.equal(reduceFollow('following', 'play'), 'following');
  const height = 800;
  assert.equal(shouldFollowScroll({ top: 200, bottom: 280 }, height), false);
  assert.equal(shouldFollowScroll({ top: 10, bottom: 80 }, height), true);
  assert.equal(shouldFollowScroll({ top: 600, bottom: 700 }, height), true);
  assert.equal(scrollRatio(250, 1000, 500), 0.5);
  assert.equal(readingProgress(4, 1, 0.5), 1.5 / 4);
});

test('a paused item reopens on the scroll the reader was left at', () => {
  const spoken = { chapter: 0, sentence: 1 };
  let saved: LookPosition | null = { chapter: 0, sentence: 1, scroll: 0.01 };
  saved = applyScrollReport(saved, { origin: 'user', chapter: 0, sentence: 4, scroll: 0.31 });
  const reopened = openingPlace({ fromBar: false, playing: false, followOn: true, spoken, saved });
  assert.equal(reopened.scroll, 0.31);
  assert.notEqual(reopened.sentence, spoken.sentence);
  const afterJump = applyScrollReport(saved, { origin: 'restore', chapter: 0, sentence: spoken.sentence, scroll: 0.01 });
  assert.equal(afterJump?.scroll, 0.31);
  const reloaded = openingPlace({ fromBar: false, playing: false, followOn: true, spoken: null, saved: afterJump });
  assert.equal(reloaded.scroll, 0.31);
  saved = applyScrollReport(saved, { origin: 'user', chapter: 0, sentence: 9, scroll: 0.7 });
  const again = openingPlace({ fromBar: false, playing: false, followOn: true, spoken, saved });
  assert.equal(again.scroll, 0.7);
  assert.equal(applyScrollReport(saved, { origin: 'restore', chapter: 0, sentence: 1, scroll: 0.01 })?.scroll, 0.7);
});

test('playing with follow, and the now-playing bar, open on the spoken sentence', () => {
  const saved = { chapter: 0, sentence: 2, scroll: 0.31 };
  const spoken = { chapter: 1, sentence: 6 };
  const live = openingPlace({ fromBar: false, playing: true, followOn: true, spoken, saved });
  assert.equal(live.chapter, 1);
  assert.equal(live.sentence, 6);
  assert.equal(live.scroll, null);
  const followOff = openingPlace({ fromBar: false, playing: true, followOn: false, spoken, saved });
  assert.equal(followOff.scroll, 0.31);
  const bar = openingPlace({ fromBar: true, playing: false, followOn: false, spoken, saved });
  assert.equal(bar.chapter, 1);
  assert.equal(bar.sentence, 6);
  assert.equal(bar.scroll, null);
  assert.equal(applyScrollReport(saved, { origin: 'restore', chapter: 1, sentence: 6, scroll: 0.02 })?.scroll, 0.31);
  const followed = applyScrollReport(saved, { origin: 'follow', chapter: 1, sentence: 7, scroll: 0.44 });
  assert.equal(followed?.scroll, 0.44);
  assert.equal(shouldPersistScroll('restore'), false);
  assert.equal(shouldPersistScroll('user'), true);
  assert.equal(shouldPersistScroll('follow'), true);
});

test('a never-played item opens where it was last left', () => {
  const saved = { chapter: 2, sentence: 3, scroll: 0.7 };
  const opened = openingPlace({ fromBar: false, playing: false, followOn: true, spoken: null, saved });
  assert.equal(opened.chapter, 2);
  assert.equal(opened.scroll, 0.7);
  assert.deepEqual(openingPlace({ fromBar: false, playing: false, followOn: true, spoken: null, saved: null }), {
    chapter: 0,
    sentence: 0,
    scroll: null,
  });
  assert.deepEqual(locatorForSpoken({ chapter: saved.chapter, page: 0, sentence: saved.sentence, scroll: saved.scroll }, { chapter: 1, sentence: 23 }), {
    chapter: 1,
    page: 0,
    sentence: 23,
  });
  assert.deepEqual(locatorForSpoken(null, null), { chapter: 0, page: 0, sentence: 0 });
});

test('a chapter pick uses the text-to-audio map and does not resume a stale file', () => {
  const chapters = [
    { textChapter: 1 },
    { textChapter: null },
    { textChapter: 4 },
  ];
  assert.equal(audioIndexForTextChapter(chapters, 4), 2);
  assert.equal(audioIndexForTextChapter(chapters, 0), -1);
  assert.equal(audioIndexForTextChapter(chapters, 1), 0);
  assert.equal(resumeChoice(true), 'continue');
  assert.equal(resumeChoice(false), 'reload');
  assert.match(playbackNotice(new TypeError('Failed to fetch')), /could not be downloaded/);
  assert.equal(playbackNotice(new Error('That chapter is missing.')), 'That chapter is missing.');
  const saved = { chapter: 9, sentence: 0, scroll: 0 };
  const reopened = openingPlace({ fromBar: false, playing: false, followOn: true, spoken: { chapter: 1, sentence: 4 }, saved });
  assert.equal(reopened.chapter, 9);
  assert.equal(reopened.scroll, 0);
  assert.equal(applyScrollReport(saved, { origin: 'restore', chapter: 1, sentence: 4, scroll: 0.01 })?.chapter, 9);
});

test('the now-playing bar opens the spoken reader and stays put when it is already open', () => {
  const locator = locatorForSpoken({ chapter: 0, page: 4, sentence: 2, scroll: 0.2 }, { chapter: 1, sentence: 23 });
  assert.equal(nowPlayingReaderAction('/read/time-machine', 'time-machine'), 'stay');
  assert.equal(nowPlayingReaderAction('/read/time-machine/', 'time-machine'), 'stay');
  assert.equal(nowPlayingReaderAction('/read/time-machine?x=1', 'time-machine'), 'stay');
  assert.equal(nowPlayingNavigation('/read/time-machine', 'time-machine', locator), 'stay');
  assert.equal(nowPlayingReaderAction('/', 'time-machine'), 'open');
  assert.equal(nowPlayingReaderAction('/settings', 'time-machine'), 'open');
  assert.equal(nowPlayingReaderAction('/read/other', 'time-machine'), 'open');
  assert.deepEqual(nowPlayingNavigation('/settings', 'time-machine', locator), {
    id: 'time-machine',
    chapter: '1',
    sentence: '23',
    place: 'sentence',
  });
  assert.equal(NOW_PLAYING_ROLE, 'button');
  assert.equal(nowPlayingAccessibilityLabel('The Time Machine'), 'Open The Time Machine');
});

test('old highlight settings migrate without coming back', () => {
  const merged = mergeSettings({ theme: 'dark', fontSize: 22, followPlayback: false, readAlongHighlight: true });
  assert.equal(merged.version, SETTINGS_VERSION);
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.fontSize, 22);
  assert.equal(merged.followPlayback, false);
  assert.equal('readAlongHighlight' in merged, false);
  assert.equal('readAlongHighlight' in mergeSettings(null), false);
});
