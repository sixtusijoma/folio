import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ItemMeta } from '@/components/ItemMeta';
import { ReaderView } from '@/components/ReaderView';
import { GEMINI_VOICES } from '@/lib/gemini';
import { libraryWritesSettled, readChapter } from '@/lib/libraryStore';
import { audioIndexForTextChapter, isBundledNarration, listenMode, offersVoiceChoice } from '@/lib/playback';
import { applyScrollReport, openingPlace, readingProgress, shouldPersistScroll, type ScrollOrigin } from '@/lib/readerFollow';
import { shouldReloadChapter, type ChapterLoad } from '@/lib/readerStability';
import type { LibraryItem, ListenMode } from '@/lib/types';
import { narrationLabel } from '@/lib/voices';
import { useLibrary } from '@/state/library';
import { usePlayerActions, usePlayerMarks, usePlayerState, usePlaying } from '@/state/player';
import { useSettings } from '@/state/settings';
import { KOKORO_VOICES } from '@/tts/kokoro';
import { usePalette } from '@/theme';

export default function ReadScreen() {
  const params = useLocalSearchParams<{ id: string; chapter?: string; sentence?: string; place?: string }>();
  const id = params.id;
  const palette = usePalette();
  const { settings, update } = useSettings();
  const { items, io, ready, patch } = useLibrary();
  const marks = usePlayerMarks();
  const playing = usePlaying();
  const player = usePlayerState();
  const actions = usePlayerActions();
  const item = items.find((entry) => entry.id === id);
  const bundled = item ? isBundledNarration(item) : false;
  const voiceChoice = item ? offersVoiceChoice(item) : false;
  const listen = item ? listenMode(item) : 'recording';
  const fromBar = params.place === 'sentence';
  const barSpoken =
    fromBar && params.chapter != null && params.sentence != null && Number.isFinite(Number(params.chapter)) && Number.isFinite(Number(params.sentence))
      ? { chapter: Number(params.chapter), sentence: Number(params.sentence) }
      : null;
  const loadedSpoken = marks.itemId === id ? marks.spoken : null;
  const spoken = fromBar ? (barSpoken ?? loadedSpoken) : loadedSpoken;
  const sameItemPlaying = playing && marks.itemId === id;
  const opened = openingPlace({
    fromBar,
    playing: sameItemPlaying,
    followOn: settings.followPlayback,
    spoken,
    saved: item?.locator ?? null,
  });
  const [chapter, setChapter] = useState(opened.chapter);
  const [html, setHtml] = useState('');
  const [ratio, setRatio] = useState(opened.scroll ?? 0);
  const [menu, setMenu] = useState<'none' | 'chapters' | 'type'>('none');
  const loaded = useRef<ChapterLoad | null>(null);
  const seededChapter = useRef(false);
  const preserveRatio = useRef(true);
  const [chapterHold, setChapterHold] = useState(false);
  const chapterHoldRef = useRef(false);
  const chapterRef = useRef(chapter);
  const sentenceRef = useRef(opened.sentence);
  const savedRef = useRef(item?.locator ?? null);
  chapterRef.current = chapter;
  savedRef.current = item?.locator ?? null;

  useEffect(() => {
    if (preserveRatio.current) {
      preserveRatio.current = false;
      return;
    }
    setRatio(0);
  }, [chapter]);

  useEffect(() => {
    if (seededChapter.current || !item) return;
    seededChapter.current = true;
    const next = openingPlace({
      fromBar: params.place === 'sentence',
      playing: playing && marks.itemId === item.id,
      followOn: settings.followPlayback,
      spoken:
        params.place === 'sentence' && params.chapter != null && params.sentence != null
          ? { chapter: Number(params.chapter), sentence: Number(params.sentence) }
          : marks.itemId === item.id
            ? marks.spoken
            : null,
      saved: item.locator,
    });
    if (next.chapter !== chapter) {
      preserveRatio.current = true;
      setChapter(next.chapter);
    }
    setRatio(next.scroll ?? 0);
  }, [item, params.place, params.chapter, params.sentence, playing, marks.itemId, marks.spoken, settings.followPlayback, chapter]);

  useEffect(() => {
    if (params.place !== 'sentence' || params.chapter == null) return;
    const next = Number(params.chapter);
    if (Number.isFinite(next)) setChapter(next);
  }, [params.place, params.chapter, params.sentence]);

  useEffect(() => {
    if (chapterHoldRef.current) return;
    if (!playing || !settings.followPlayback || !id || marks.itemId !== id || !marks.spoken) return;
    if (marks.spoken.chapter !== chapter) setChapter(marks.spoken.chapter);
  }, [playing, settings.followPlayback, id, marks.spoken, marks.itemId, chapter, chapterHold]);

  useEffect(() => {
    if (!chapterHold || !id || marks.itemId !== id || !marks.spoken) return;
    if (marks.spoken.chapter === chapter) {
      chapterHoldRef.current = false;
      setChapterHold(false);
    }
  }, [chapterHold, id, marks.itemId, marks.spoken, chapter]);

  useEffect(() => {
    if (!item?.hasText || !id) return;
    const next = { itemId: id, chapter };
    if (!shouldReloadChapter(loaded.current, next)) return;
    let cancel = false;
    readChapter(io, id, chapter).then((body) => {
      if (cancel) return;
      loaded.current = next;
      setHtml(body);
    });
    return () => {
      cancel = true;
    };
  }, [io, id, item?.hasText, chapter]);

  const tracking = !chapterHold && sameItemPlaying && settings.followPlayback && loadedSpoken != null && loadedSpoken.chapter === chapter;
  const followSentence = tracking && loadedSpoken ? loadedSpoken.sentence : null;
  sentenceRef.current = followSentence ?? (item?.locator?.chapter === chapter ? item.locator.sentence : opened.sentence);
  const placeToken = fromBar ? `${params.chapter ?? chapter}:${params.sentence ?? opened.sentence}` : null;
  const anchor = chapter === opened.chapter ? opened : { chapter, sentence: 0, scroll: 0 };

  function leaveReader() {
    void libraryWritesSettled().finally(() => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    });
  }

  function chooseChapter(index: number) {
    if (!item) return;
    setMenu('none');
    if (!item.hasText) {
      const loadedHere = marks.itemId === item.id;
      actions.cueChapter(item.id, index, loadedHere ? actions.intendedPlaying() : true);
      return;
    }
    if (settings.followPlayback && marks.itemId === item.id) {
      chapterHoldRef.current = true;
      setChapterHold(true);
    }
    setChapter(index);
    const count = Math.max(1, item.chapters.length);
    patch(item.id, {
      locator: { chapter: index, page: 0, sentence: 0, scroll: 0 },
      progress: readingProgress(count, index, 0),
      lastOpenedAt: Date.now(),
    }).catch(() => undefined);
    if (!item.hasAudio || marks.itemId !== item.id) return;
    const audioIndex = audioIndexForTextChapter(item.audioChapters, index);
    if (audioIndex < 0) return;
    actions.cueChapter(item.id, audioIndex, actions.intendedPlaying());
  }

  const onScroll = useCallback(
    (next: number, origin: ScrollOrigin) => {
      setRatio(next);
      if (!id || !shouldPersistScroll(origin)) return;
      const currentChapter = chapterRef.current;
      const count = item?.chapters.length ?? 0;
      const kept = applyScrollReport(savedRef.current, {
        origin,
        chapter: currentChapter,
        sentence: sentenceRef.current,
        scroll: next,
      });
      if (!kept || kept.scroll == null) return;
      patch(id, {
        locator: { chapter: kept.chapter, page: 0, sentence: kept.sentence, scroll: kept.scroll },
        progress: readingProgress(count, kept.chapter, kept.scroll),
        lastOpenedAt: Date.now(),
      }).catch(() => undefined);
    },
    [id, item?.chapters.length, patch],
  );

  if (!ready) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
        <View style={{ padding: 24, gap: 12 }}>
          <View style={{ height: 18, width: 72, borderRadius: 6, backgroundColor: palette.chip }} />
          <View style={{ height: 28, width: '70%', borderRadius: 6, backgroundColor: palette.chip }} />
          <Text style={{ color: palette.muted }}>Opening…</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (!item) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg, padding: 24 }}>
        <Text style={{ color: palette.ink, fontSize: 22 }}>That item is gone.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to the shelf" onPress={leaveReader} style={{ marginTop: 16 }}>
          <Text style={{ color: palette.accent }}>Back to the shelf</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const syncNote = syncNoteFor(item, listen);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.paper }} edges={['top', 'left', 'right']}>
      <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable accessibilityLabel="Back" onPress={leaveReader} style={{ padding: 8 }}>
            <Text style={{ color: palette.accent, fontSize: 16 }}>Shelf</Text>
          </Pressable>
          <Text numberOfLines={2} style={{ flex: 1, color: palette.ink, fontSize: 16, fontFamily: 'Georgia' }}>
            {item.title}
          </Text>
        </View>
        <Text numberOfLines={1} style={{ color: palette.muted, fontSize: 12, paddingHorizontal: 8 }}>
          {item.chapters[chapter]?.title || item.author}
          {item.hasText ? ` · ${Math.round(ratio * 100)}%` : ''}
        </Text>
        <View style={{ paddingHorizontal: 8 }}>
          <ItemMeta item={item} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
          {item.chapters.length > 1 || item.audioChapters.length > 1 ? (
            <Pressable onPress={() => setMenu('chapters')} style={{ padding: 8 }}>
              <Text style={{ color: palette.ink }}>Chapters</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setMenu('type')} style={{ padding: 8 }}>
            <Text style={{ color: palette.ink }}>Aa</Text>
          </Pressable>
          {item.hasText && item.hasAudio && !bundled ? (
            <Pressable disabled={player.busy && player.itemId === item.id} onPress={() => actions.playItem(item.id, 'narrate')} style={{ padding: 8, opacity: player.busy && player.itemId === item.id ? 0.45 : 1 }}>
              <Text style={{ color: palette.ink }}>Speak</Text>
            </Pressable>
          ) : null}
          <Pressable
            disabled={player.busy && player.itemId === item.id}
            onPress={() => actions.playItem(item.id, item.hasAudio ? 'audio' : 'narrate')}
            style={{ backgroundColor: palette.accent, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, minWidth: 88, alignItems: 'center', opacity: player.busy && player.itemId === item.id ? 0.7 : 1 }}
          >
            <Text style={{ color: settings.theme === 'dark' ? '#1c1915' : '#f7f4ee', fontWeight: '700' }}>{item.hasAudio ? 'Listen' : 'Narrate'}</Text>
          </Pressable>
        </View>
        {voiceChoice ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingBottom: 4 }}>
            <Chip active={listen === 'recording'} label="Original recording" onPress={() => actions.setListen(item.id, 'recording')} />
            <Chip
              active={listen === 'voice'}
              label={`Voice: ${narrationLabel(settings, KOKORO_VOICES, GEMINI_VOICES)}`}
              onPress={() => actions.setListen(item.id, 'voice')}
            />
            {listen === 'voice' ? (
              <Pressable accessibilityRole="link" onPress={() => router.push('/settings')} style={{ padding: 4 }}>
                <Text style={{ color: palette.accent, fontSize: 13 }}>Change voice</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {player.itemId === item.id && (player.statusLine || player.buffering) ? (
          <Text style={{ color: palette.muted, fontSize: 12, paddingHorizontal: 8 }}>{player.statusLine || 'Fetching audio…'}</Text>
        ) : null}
      </View>
      <Text style={{ color: palette.muted, fontSize: 12, paddingHorizontal: 20, paddingBottom: 6 }}>{syncNote}</Text>
      {item.hasText ? (
        html ? (
          <ReaderView
            html={html}
            restoreSentence={anchor.sentence}
            restoreScroll={anchor.scroll}
            placeToken={placeToken}
            followSentence={followSentence}
            holdFollow={chapterHold}
            onReleaseFollow={() => {
              chapterHoldRef.current = false;
              setChapterHold(false);
            }}
            playing={playing}
            fontSize={settings.fontSize}
            lineHeight={settings.lineHeight}
            margin={settings.margin}
            font={settings.font}
            theme={settings.theme}
            onScroll={onScroll}
          />
        ) : (
          <View style={{ flex: 1, padding: 20, gap: 12 }}>
            <View style={{ height: 18, width: '88%', borderRadius: 6, backgroundColor: palette.chip }} />
            <View style={{ height: 18, width: '72%', borderRadius: 6, backgroundColor: palette.chip }} />
            <View style={{ height: 18, width: '80%', borderRadius: 6, backgroundColor: palette.chip }} />
            <Text style={{ color: palette.muted, marginTop: 8 }}>Opening this chapter…</Text>
          </View>
        )
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20, gap: 8 }}>
          <Text style={{ color: palette.ink, fontSize: 18 }}>Audio only</Text>
          {item.audioChapters.map((audio, index) => (
            <Pressable key={`${audio.title}-${index}`} accessibilityRole="button" accessibilityLabel={audio.title} onPress={() => chooseChapter(index)} style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: palette.line }}>
              <Text style={{ color: palette.ink }}>{audio.title}</Text>
              <Text style={{ color: palette.muted, fontSize: 12 }}>{audio.file ? 'On this device' : 'Downloads when you play it'}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <Modal visible={menu !== 'none'} animationType="slide" transparent onRequestClose={() => setMenu('none')}>
        <Pressable style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }} onPress={() => setMenu('none')}>
          <Pressable onPress={(event) => event.stopPropagation()} style={{ backgroundColor: palette.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', padding: 20 }}>
            {menu === 'chapters' ? (
              <ScrollView>
                <Text style={{ color: palette.ink, fontSize: 20, marginBottom: 8 }}>Chapters</Text>
                {(item.hasText ? item.chapters : item.audioChapters).map((entry, index) => (
                  <Pressable
                    key={`${entry.title}-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={entry.title}
                    onPress={() => chooseChapter(index)}
                    style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: palette.line }}
                  >
                    <Text style={{ color: index === chapter ? palette.accent : palette.ink }}>{entry.title}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <View style={{ gap: 12 }}>
                <Text style={{ color: palette.ink, fontSize: 20 }}>Type</Text>
                <Row label="Theme">
                  {(['light', 'sepia', 'dark'] as const).map((theme) => (
                    <Chip key={theme} active={settings.theme === theme} label={theme} onPress={() => update({ theme })} />
                  ))}
                </Row>
                <Row label="Font">
                  <Chip active={settings.font === 'serif'} label="Serif" onPress={() => update({ font: 'serif' })} />
                  <Chip active={settings.font === 'sans'} label="Sans" onPress={() => update({ font: 'sans' })} />
                </Row>
                <Row label="Size">
                  <Chip label="−" onPress={() => update({ fontSize: Math.max(16, settings.fontSize - 2) })} />
                  <Text style={{ color: palette.ink }}>{settings.fontSize}</Text>
                  <Chip label="+" onPress={() => update({ fontSize: Math.min(32, settings.fontSize + 2) })} />
                </Row>
                <Row label="Spacing">
                  {[1.3, 1.45, 1.65, 1.85].map((lineHeight) => (
                    <Chip key={lineHeight} active={settings.lineHeight === lineHeight} label={String(lineHeight)} onPress={() => update({ lineHeight })} />
                  ))}
                </Row>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function syncNoteFor(item: LibraryItem, listen: ListenMode): string {
  if (offersVoiceChoice(item)) {
    return listen === 'voice'
      ? 'This reads the script in your Settings voice, sentence by sentence. Follow playback keeps the spoken sentence in view.'
      : 'This plays the original recording. Follow playback keeps the spoken part in view.';
  }
  if (isBundledNarration(item)) {
    return 'This plays the bundled recording. Follow playback keeps the spoken part in view.';
  }
  if (item.sync === 'vtt') {
    return 'Follow playback tracks the transcript.';
  }
  if (item.sync === 'approximate') {
    return 'This recording has no transcript, so follow playback estimates the place in the chapter.';
  }
  return item.hasAudio ? 'This audio has no timings. Read and listen side by side.' : 'Narration moves through the chapter sentence by sentence.';
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: palette.muted }}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</View>
    </View>
  );
}

function Chip({ label, onPress, active }: { label: string; onPress: () => void; active?: boolean }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(active) }}
      onPress={onPress}
      style={{ backgroundColor: active ? palette.ink : palette.chip, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 }}
    >
      <Text style={{ color: active ? palette.paper : palette.ink }}>{label}</Text>
    </Pressable>
  );
}
