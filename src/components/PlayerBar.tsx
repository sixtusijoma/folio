import { router, usePathname } from 'expo-router';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { GEMINI_VOICES } from '@/lib/gemini';
import { NOW_PLAYING_ROLE, listenMode, nowPlayingAccessibilityLabel, nowPlayingNavigation, offersVoiceChoice } from '@/lib/playback';
import { narrationLabel } from '@/lib/voices';
import { useLibrary } from '@/state/library';
import { usePlayerActions, usePlayerMarks, usePlayerState } from '@/state/player';
import { useSettings } from '@/state/settings';
import { KOKORO_VOICES } from '@/tts/kokoro';
import { usePalette } from '@/theme';

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const body = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : body;
}

export function PlayerBar() {
  const palette = usePalette();
  const { settings } = useSettings();
  const pathname = usePathname();
  const { items, patch } = useLibrary();
  const state = usePlayerState();
  const marks = usePlayerMarks();
  const actions = usePlayerActions();
  const item = items.find((entry) => entry.id === state.itemId);
  if (!state.itemId && !state.notice) {
    return null;
  }
  const mode = item && offersVoiceChoice(item) ? listenMode(item) : null;
  const source =
    mode === 'voice' ? `Voice: ${narrationLabel(settings, KOKORO_VOICES, GEMINI_VOICES)}` : mode === 'recording' ? 'Original recording' : null;
  const subtitle = state.statusLine || (state.buffering ? 'Fetching audio…' : source || item?.audioChapters[state.chapter]?.title || item?.author);
  const contrast = settings.theme === 'dark' ? '#1c1915' : '#f7f4ee';
  const showPause = state.playing || Boolean(state.itemId && (state.buffering || state.statusLine));
  const playLabel = showPause ? 'Pause' : 'Play';

  function openReader() {
    if (!item) {
      return;
    }
    const spoken = marks.itemId === item.id ? marks.spoken : null;
    const shown = spoken ?? { chapter: item.locator?.chapter ?? 0, sentence: item.locator?.sentence ?? 0 };
    const target = nowPlayingNavigation(pathname, item.id, { chapter: shown.chapter, page: 0, sentence: shown.sentence });
    if (target === 'stay') {
      return;
    }
    patch(item.id, { lastOpenedAt: Date.now() }).catch(() => undefined);
    if (!spoken) {
      router.navigate({ pathname: '/read/[id]', params: { id: item.id } });
      return;
    }
    router.navigate({ pathname: '/read/[id]', params: target });
  }

  return (
    <View style={{ backgroundColor: palette.paper, borderTopWidth: 1, borderTopColor: palette.line, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 }}>
      {state.notice ? (
        <Pressable onPress={state.retryable ? actions.retry : actions.clearNotice} style={{ marginBottom: 8 }}>
          <Text style={{ color: palette.accent, fontSize: 13, lineHeight: 18 }}>
            {state.notice}
            {state.retryable ? (/try again/i.test(state.notice) ? '' : ' Tap to try again.') : ' Tap to dismiss.'}
          </Text>
        </Pressable>
      ) : null}
      {item ? (
        <>
          <Pressable accessibilityRole={NOW_PLAYING_ROLE} accessibilityLabel={nowPlayingAccessibilityLabel(item.title)} onPress={openReader}>
            <Text numberOfLines={1} style={{ color: palette.ink, fontSize: 15, fontWeight: '600' }}>
              {item.title}
            </Text>
            <Text numberOfLines={1} style={{ color: palette.muted, fontSize: 12, marginTop: 2 }}>
              {subtitle}
              {mode === 'voice' || state.statusLine || state.buffering ? '' : item.sync === 'approximate' ? ' · approximate sync' : item.sync === 'vtt' ? ' · transcript sync' : ''}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 8 }}>
              <Text style={{ color: palette.muted, fontVariant: ['tabular-nums'], width: 52 }}>{clock(state.positionMs)}</Text>
              <View style={{ flex: 1, height: 3, backgroundColor: palette.chip, borderRadius: 2 }}>
                <View
                  style={{
                    width: `${state.durationMs ? Math.min(100, (state.positionMs / state.durationMs) * 100) : 0}%`,
                    height: 3,
                    backgroundColor: palette.accent,
                    borderRadius: 2,
                  }}
                />
              </View>
              <Text style={{ color: palette.muted, fontVariant: ['tabular-nums'], width: 52, textAlign: 'right' }}>{clock(state.durationMs)}</Text>
            </View>
          </Pressable>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <Pressable
              accessibilityLabel="Skip back"
              disabled={state.busy}
              onPress={() => actions.seekBy(-settings.skipBack * 1000)}
              style={[chip(palette.chip), state.busy ? { opacity: 0.45 } : null]}
            >
              <Text style={{ color: palette.ink }}>−{settings.skipBack}s</Text>
            </Pressable>
            <Pressable accessibilityLabel={playLabel} onPress={actions.toggle} style={chip(palette.accent)}>
              {state.buffering && showPause ? (
                <ActivityIndicator color={contrast} size="small" />
              ) : (
                <Text style={{ color: contrast, fontWeight: '700' }}>{playLabel}</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityLabel="Skip forward"
              disabled={state.busy}
              onPress={() => actions.seekBy(settings.skipForward * 1000)}
              style={[chip(palette.chip), state.busy ? { opacity: 0.45 } : null]}
            >
              <Text style={{ color: palette.ink }}>+{settings.skipForward}s</Text>
            </Pressable>
            <Pressable accessibilityLabel="Sleep timer" onPress={() => cycleSleep(state.sleepLabel, actions.setSleepMinutes)} style={chip(palette.chip)}>
              <Text style={{ color: palette.ink }}>{state.sleepLabel ?? 'Sleep'}</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </View>
  );
}

function cycleSleep(label: string | null, setSleepMinutes: (minutes: number | null) => void) {
  if (!label) {
    setSleepMinutes(15);
  } else if (label === '15 min') {
    setSleepMinutes(30);
  } else if (label === '30 min') {
    setSleepMinutes(0);
  } else {
    setSleepMinutes(null);
  }
}

function chip(backgroundColor: string) {
  return { backgroundColor, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, minWidth: 72, minHeight: 36, alignItems: 'center' as const, justifyContent: 'center' as const };
}
