import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { usePathname } from 'expo-router';
import * as Speech from 'expo-speech';
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  FIRST_SOUND_MS,
  KOKORO_PREFETCH,
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
} from '@/lib/clipQueue';
import { GeminiError, synthesizeGemini } from '@/lib/gemini';
import { sentencesFromHtml } from '@/lib/htmlSentences';
import { ensureAudioLocal, isDownloadCancelled, readChapter } from '@/lib/libraryStore';
import {
  freshClipWatch,
  isBundledNarration,
  listenMode,
  offersVoiceChoice,
  playbackNotice,
  playbackPlan,
  readerItemId,
  reduceClipStatus,
  resumeChoice,
  skipSentence,
  type ClipWatch,
} from '@/lib/playback';
import { getGeminiKey } from '@/lib/secrets';
import { sentenceAtTime, spokenAt, timeForSentence, type Spoken } from '@/lib/spoken';
import { normalizeClock } from '@/lib/timing';
import type { LibraryItem, ListenMode } from '@/lib/types';
import { usableVoice, type SystemVoice } from '@/lib/voices';
import { wavDurationMs } from '@/lib/wav';
import { useLibrary } from '@/state/library';
import { useSettings } from '@/state/settings';
import { kokoroStatus, subscribeKokoro, synthesizeKokoro } from '@/tts/kokoro';

export type FollowMark = { chapter: number; sentence: number } | null;

type PlayerState = {
  itemId: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  chapter: number;
  notice: string | null;
  buffering: boolean;
  busy: boolean;
  statusLine: string | null;
  retryable: boolean;
  sleepLabel: string | null;
};

type MarkState = {
  itemId: string | null;
  spoken: FollowMark;
  follow: FollowMark;
};

type PlayerActions = {
  playItem: (id: string, mode?: 'audio' | 'narrate') => Promise<void>;
  toggle: () => void;
  pause: () => void;
  seekBy: (deltaMs: number) => void;
  cueChapter: (id: string, index: number, autoplay: boolean) => void;
  /** True when the user asked audio to play, including while a file swap reports paused. */
  intendedPlaying: () => boolean;
  setSleepMinutes: (minutes: number | null) => void;
  /** Switch a scripted audio item between its recording and the Settings voice, keeping the place. */
  setListen: (id: string, listen: ListenMode) => void;
  clearNotice: () => void;
  retry: () => void;
};

type Narrated = { itemId: string; chapter: number; sentence: number; sentences: string[] };

type NarrationJob = { kind: 'clip'; chapter: number; sentence: number; text: string; uri: string } | { kind: 'speech' };

type Primed = { slot: 0 | 1; uri: string };

const PlayerContext = createContext<PlayerState | null>(null);
const MarkContext = createContext<MarkState | null>(null);
const PlayingContext = createContext<boolean | null>(null);
const PlayerActionsContext = createContext<PlayerActions | null>(null);

const MISSING_BUNDLE = 'The bundled recording is missing, so Folio will not switch to another voice.';
const PLAYER_OPTIONS = { updateInterval: 80, keepAudioSessionActive: true } as const;
const LOAD_MS = 5000;
const START_MS = 3000;
const START_RETRY_MS = 2500;

function waitPlayer(player: AudioPlayer, ok: (status: AudioStatus) => boolean, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (poll) {
        clearInterval(poll);
      }
      subscription.remove();
      resolve(value);
    };
    const check = (status: AudioStatus) => {
      if (!alive()) {
        finish(false);
        return;
      }
      if (status.error) {
        finish(false);
        return;
      }
      if (ok(status)) {
        finish(true);
      }
    };
    const subscription = player.addListener('playbackStatusUpdate', check);
    poll = setInterval(() => check(snapshot(player)), 80);
    timer = setTimeout(() => finish(alive() && ok(snapshot(player))), timeoutMs);
    check(snapshot(player));
  });
}

function snapshot(player: AudioPlayer): AudioStatus {
  return {
    id: player.id,
    currentTime: player.currentTime,
    playbackState: '',
    timeControlStatus: '',
    reasonForWaitingToPlay: '',
    mute: player.muted,
    duration: player.duration,
    playing: player.playing,
    loop: player.loop,
    didJustFinish: false,
    isBuffering: player.isBuffering,
    isLoaded: player.isLoaded,
    playbackRate: player.playbackRate,
    shouldCorrectPitch: true,
    isLive: false,
    currentOffsetFromLive: null,
    error: null,
  };
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { io, items, patch } = useLibrary();
  const { settings } = useSettings();
  const playerRef = useRef<AudioPlayer | null>(null);
  const playersRef = useRef<[AudioPlayer | null, AudioPlayer | null]>([null, null]);
  const liveSlotRef = useRef<0 | 1>(0);
  const primedRef = useRef<Primed | null>(null);
  const liveUriRef = useRef<string | null>(null);
  const itemsRef = useRef(items);
  const settingsRef = useRef(settings);
  const runRef = useRef(0);
  const narratingRef = useRef(false);
  const finishRef = useRef<(() => void) | null>(null);
  const clipRef = useRef<ClipWatch>(freshClipWatch());
  const narrationRef = useRef<NarrationJob | null>(null);
  const narratedRef = useRef<Narrated | null>(null);
  const speechRef = useRef(new Map<string, Promise<Uint8Array>>());
  const voicesRef = useRef<SystemVoice[]>([]);
  const saveAt = useRef(0);
  const clipDurationsRef = useRef<Array<number | undefined>>([]);
  const kokoroRef = useRef(kokoroStatus());
  const lastPlayTapRef = useRef(0);
  const [itemId, setItemId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [chapter, setChapterState] = useState(0);
  const [marks, setMarks] = useState<MarkState>({ itemId: null, spoken: null, follow: null });
  const [notice, setNotice] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [sleepLabel, setSleepLabel] = useState<string | null>(null);
  const sleepRef = useRef<{ until: number | null; endOfChapter: boolean }>({ until: null, endOfChapter: false });
  const chapterRef = useRef(0);
  const itemIdRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const fileLoadedRef = useRef(false);
  const wantPlayingRef = useRef(false);
  const downloadRef = useRef<AbortController | null>(null);
  const downloadGen = useRef(0);
  const cancelOnLeaveRef = useRef(false);
  const queuedChapterRef = useRef<{ id: string; index: number; positionMs: number } | null>(null);
  const listenPrefRef = useRef<Record<string, ListenMode>>({});
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  playingRef.current = playing;

  itemsRef.current = items;
  settingsRef.current = settings;

  const currentItem = () => itemsRef.current.find((item) => item.id === itemIdRef.current) ?? null;

  function livePlayer(): AudioPlayer | null {
    return playersRef.current[liveSlotRef.current] ?? playerRef.current;
  }

  function pausePlayers() {
    playersRef.current[0]?.pause();
    playersRef.current[1]?.pause();
  }

  function pickFileSlot() {
    primedRef.current = null;
    liveUriRef.current = null;
    liveSlotRef.current = 0;
    playerRef.current = playersRef.current[0];
    playersRef.current[1]?.pause();
  }

  function showNotice(message: string, canRetry = noticeIsRetryable(message)) {
    setNotice(message);
    setRetryable(canRetry);
  }

  function clearStatus() {
    setBuffering(false);
    setBusy(false);
    setStatusLine(null);
  }

  useEffect(() => {
    setMarks((current) => {
      const follow = settings.followPlayback ? current.spoken : null;
      const same =
        current.follow?.chapter === follow?.chapter && current.follow?.sentence === follow?.sentence && Boolean(current.follow) === Boolean(follow);
      if (same) {
        return current;
      }
      return { ...current, follow };
    });
  }, [settings.followPlayback]);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => undefined);
    void setIsAudioActiveAsync(true).catch(() => undefined);
    const first = createAudioPlayer(null, PLAYER_OPTIONS);
    const second = createAudioPlayer(null, PLAYER_OPTIONS);
    playersRef.current = [first, second];
    playerRef.current = first;
    const sub0 = first.addListener('playbackStatusUpdate', (status) => onStatus(0, status));
    const sub1 = second.addListener('playbackStatusUpdate', (status) => onStatus(1, status));
    return () => {
      downloadRef.current?.abort();
      downloadGen.current += 1;
      sub0.remove();
      sub1.remove();
      first.remove();
      second.remove();
    };
    // The listener closes over refs, so it stays current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    playersRef.current[0]?.setPlaybackRate(settings.rate, 'high');
    playersRef.current[1]?.setPlaybackRate(settings.rate, 'high');
  }, [settings.rate]);

  useEffect(() => {
    return subscribeKokoro((status) => {
      kokoroRef.current = status;
      if (!wantPlayingRef.current || !narratingRef.current) {
        return;
      }
      if (status.state === 'loading') {
        setStatusLine(preparingLine('kokoro', status));
        setBuffering(true);
      }
    });
  }, []);

  useEffect(() => {
    const previous = pathRef.current;
    pathRef.current = pathname;
    const previousId = readerItemId(previous);
    const nextId = readerItemId(pathname);
    // A chapter the user just picked is cancelled on the way out. The next file in a
    // book that is still playing is not: that download has to finish on the shelf.
    if (previousId != null && previousId !== nextId && cancelOnLeaveRef.current) {
      const pausedPick = !wantPlayingRef.current;
      cancelDownload();
      // A paused chapter pick is cancelled on the way out. Clear the fetching
      // line so the shelf shows Play, which then loads that chapter.
      if (pausedPick) {
        clearStatus();
      }
    }
  }, [pathname]);

  const voiceKey = `${settings.engine}:${settings.kokoroVoice}:${settings.geminiVoice}:${settings.systemVoice ?? ''}`;
  useEffect(() => {
    if (!narratingRef.current || !itemIdRef.current || !wantPlayingRef.current) {
      return;
    }
    const item = currentItem();
    const from = narratedRef.current;
    if (!item || !from || from.itemId !== item.id) {
      return;
    }
    runRef.current += 1;
    Speech.stop();
    pausePlayers();
    finishRef.current?.();
    finishRef.current = null;
    primedRef.current = null;
    liveUriRef.current = null;
    setStatusLine(preparingLine(settingsRef.current.engine, kokoroRef.current));
    setBuffering(true);
    setBusy(true);
    wantPlayingRef.current = true;
    setPlaying(true);
    void narrate(item, { chapter: from.chapter, sentence: from.sentence });
    // Restart the current sentence when the chosen voice changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceKey]);

  function publishMark(mark: { chapter: number; sentence: number } | null) {
    const follow = settingsRef.current.followPlayback && mark ? { chapter: mark.chapter, sentence: mark.sentence } : null;
    const spoken = mark ? { chapter: mark.chapter, sentence: mark.sentence } : null;
    setMarks((current) => {
      const sameFollow =
        current.follow?.chapter === follow?.chapter && current.follow?.sentence === follow?.sentence && Boolean(current.follow) === Boolean(follow);
      const sameSpoken =
        current.spoken?.chapter === spoken?.chapter && current.spoken?.sentence === spoken?.sentence && Boolean(current.spoken) === Boolean(spoken);
      if (sameFollow && sameSpoken && current.itemId === itemIdRef.current) {
        return current;
      }
      return { itemId: itemIdRef.current, spoken, follow };
    });
  }

  function publishNarrationClock(narrated: Narrated, clipPositionMs: number, clipDurationMs: number) {
    const rate = settingsRef.current.rate;
    const elapsedBeforeMs = sentenceSpanMs(narrated.sentences, 0, narrated.sentence, rate, clipDurationsRef.current);
    const remainingAfterMs = sentenceSpanMs(narrated.sentences, narrated.sentence + 1, narrated.sentences.length, rate, clipDurationsRef.current);
    const currentLength = clipDurationMs > 0 ? clipDurationMs : estimateSpeechMs(narrated.sentences[narrated.sentence] ?? '', rate);
    const clock = narrationClock({
      elapsedBeforeMs,
      clipPositionMs,
      clipDurationMs: currentLength,
      remainingAfterMs,
    });
    setPositionMs(clock.positionMs);
    setDurationMs(clock.durationMs);
  }

  function onClipStarted() {
    setPlaying(true);
    setBuffering(false);
    setBusy(false);
    setStatusLine(null);
  }

  function tryHandoff(): boolean {
    const primed = primedRef.current;
    const next = primed ? playersRef.current[primed.slot] : null;
    if (!primed || !next?.isLoaded || !wantPlayingRef.current) {
      return false;
    }
    const previous = liveSlotRef.current;
    liveSlotRef.current = primed.slot;
    playerRef.current = next;
    liveUriRef.current = primed.uri;
    primedRef.current = null;
    clipRef.current = freshClipWatch();
    next.setPlaybackRate(settingsRef.current.rate, 'high');
    next.play();
    playersRef.current[previous]?.pause();
    onClipStarted();
    const job = narrationRef.current;
    if (job?.kind === 'clip') {
      narrationRef.current = { ...job, uri: primed.uri };
    }
    return true;
  }

  function onStatus(slot: 0 | 1, status: AudioStatus) {
    if (slot !== liveSlotRef.current) {
      return;
    }
    if (status.error && wantPlayingRef.current && (fileLoadedRef.current || narrationRef.current?.kind === 'clip')) {
      failStart(status.error);
      return;
    }
    if (!status.isLoaded) {
      if (status.isBuffering && wantPlayingRef.current) {
        setBuffering(true);
      }
      return;
    }
    const clock = normalizeClock(status.currentTime, status.duration || 0);
    const job = narrationRef.current;
    if (narratingRef.current && job?.kind === 'clip') {
      const narrated = narratedRef.current;
      if (narrated) {
        if (clock.durationMs > 0) {
          clipDurationsRef.current[narrated.sentence] = clock.durationMs;
        }
        publishNarrationClock(narrated, clock.positionMs, clock.durationMs);
      } else {
        setPositionMs(clock.positionMs);
        setDurationMs(clock.durationMs);
      }
      const reduced = reduceClipStatus(clipRef.current, {
        positionMs: clock.positionMs,
        durationMs: clock.durationMs,
        didJustFinish: Boolean(status.didJustFinish),
      });
      clipRef.current = reduced.state;
      const canHandoff = Boolean(primedRef.current && playersRef.current[primedRef.current.slot]?.isLoaded);
      const nearEnd = shouldHandoff(clock.positionMs, clock.durationMs);
      if (finishRef.current && ((nearEnd && canHandoff) || reduced.finished)) {
        tryHandoff();
        const done = finishRef.current;
        finishRef.current = null;
        done();
      }
      return;
    }
    if (narratingRef.current) {
      return;
    }
    setPositionMs(clock.positionMs);
    setDurationMs(clock.durationMs);
    if (status.playing && !wantPlayingRef.current) {
      livePlayer()?.pause();
      setPlaying(false);
      return;
    }
    setPlaying(status.playing && wantPlayingRef.current);
    if (status.playing && wantPlayingRef.current) {
      setBuffering(Boolean(status.isBuffering));
      if (!status.isBuffering) {
        setBusy(false);
        setStatusLine(null);
      }
    }
    const item = currentItem();
    if (item) {
      const mark = spokenFrom(item, chapterRef.current, clock.positionMs, clock.durationMs);
      publishMark(mark);
    }
    if (status.didJustFinish) {
      if (endOfChapterDue()) {
        pause();
      } else {
        const next = chapterRef.current + 1;
        const latest = currentItem();
        if (latest && next < latest.audioChapters.length) {
          void startFile(latest, next, latest.audioChapters[next]?.startMs ?? 0);
        }
      }
    }
    const now = Date.now();
    if (sleepDue()) {
      pause();
    }
    if (item && queuedChapterRef.current == null && now - saveAt.current > 4000) {
      saveAt.current = now;
      const progress = progressFor(item, chapterRef.current, clock.positionMs, clock.durationMs);
      patch(item.id, {
        audioPositionMs: clock.positionMs,
        audioChapter: chapterRef.current,
        progress,
        lastOpenedAt: now,
      }).catch(() => undefined);
    }
  }

  // A timer fires once and clears itself, so Play after it stops is not stopped again.
  function sleepDue(): boolean {
    const until = sleepRef.current.until;
    if (until == null || Date.now() <= until) {
      return false;
    }
    sleepRef.current = { until: null, endOfChapter: false };
    setSleepLabel(null);
    return true;
  }

  function endOfChapterDue(): boolean {
    if (!sleepRef.current.endOfChapter) {
      return false;
    }
    sleepRef.current = { until: null, endOfChapter: false };
    setSleepLabel(null);
    return true;
  }

  function spokenFrom(item: LibraryItem, audioChapter: number, position: number, duration: number): Spoken {
    if (item.sync !== 'vtt' && item.sync !== 'approximate' && !settingsRef.current.approximateSync) {
      return null;
    }
    return spokenAt(item, audioChapter, position, duration);
  }

  function progressFor(item: LibraryItem, audioChapter: number, position: number, duration: number): number {
    if (item.chapters.length) {
      const mark = spokenFrom(item, audioChapter, position, duration);
      if (!mark) {
        return item.progress;
      }
      const count = item.chapters[mark.chapter]?.sentences || 1;
      return Math.min(1, (mark.chapter + mark.sentence / count) / item.chapters.length);
    }
    if (!item.audioChapters.length) {
      return 0;
    }
    return Math.min(1, (audioChapter + (duration ? position / duration : 0)) / item.audioChapters.length);
  }

  function beginDownload(): { generation: number; signal: AbortSignal } {
    downloadRef.current?.abort();
    const controller = new AbortController();
    downloadRef.current = controller;
    return { generation: ++downloadGen.current, signal: controller.signal };
  }

  function cancelDownload() {
    downloadRef.current?.abort();
    downloadRef.current = null;
    downloadGen.current += 1;
    cancelOnLeaveRef.current = false;
    setBuffering(false);
    setBusy(false);
  }

  async function replaceAndWait(player: AudioPlayer, uri: string, alive: () => boolean): Promise<boolean> {
    const previous = { duration: player.duration, time: player.currentTime };
    player.replace({ uri });
    player.setPlaybackRate(settingsRef.current.rate, 'high');
    let seenUnloaded = !player.isLoaded;
    return waitPlayer(
      player,
      (status) => {
        if (!status.isLoaded) {
          seenUnloaded = true;
          return false;
        }
        return sourceHasReplaced(status, previous, seenUnloaded);
      },
      LOAD_MS,
      alive,
    );
  }

  async function startPlayback(player: AudioPlayer, alive: () => boolean): Promise<void> {
    if (!alive()) {
      return;
    }
    await setIsAudioActiveAsync(true).catch(() => undefined);
    if (!alive()) {
      return;
    }
    const playOnce = async (waitMs: number) => {
      const startedAt = player.currentTime;
      player.play();
      return waitPlayer(player, (status) => playbackHasStarted(status, startedAt), waitMs, alive);
    };
    if (await playOnce(START_MS)) {
      return;
    }
    if (!alive()) {
      return;
    }
    if (await playOnce(START_RETRY_MS)) {
      return;
    }
    if (!alive()) {
      return;
    }
    throw new Error(PLAY_FAILED);
  }

  function failStart(message = PLAY_FAILED) {
    wantPlayingRef.current = false;
    runRef.current += 1;
    narratingRef.current = false;
    narrationRef.current = null;
    finishRef.current = null;
    primedRef.current = null;
    liveUriRef.current = null;
    Speech.stop();
    pausePlayers();
    setPlaying(false);
    clearStatus();
    showNotice(message);
  }

  async function startFile(item: LibraryItem, index: number, seekMs: number, autoplay = true, cancelOnLeave = false) {
    const player = playersRef.current[0];
    if (!player) {
      return;
    }
    const flight = beginDownload();
    cancelOnLeaveRef.current = cancelOnLeave;
    const stale = () => flight.generation !== downloadGen.current || flight.signal.aborted;
    const positionMs = Math.max(0, Math.round(seekMs));
    queuedChapterRef.current = { id: item.id, index, positionMs };
    fileLoadedRef.current = false;
    pickFileSlot();
    patch(item.id, { audioChapter: index, audioPositionMs: positionMs, lastOpenedAt: Date.now() }).catch(() => undefined);
    narratingRef.current = false;
    narrationRef.current = null;
    narratedRef.current = null;
    Speech.stop();
    wantPlayingRef.current = autoplay;
    setBuffering(true);
    setBusy(true);
    setStatusLine('Fetching audio…');
    try {
      const fresh = await ensureAudioLocal(io, item, index, { signal: flight.signal });
      if (stale()) {
        return;
      }
      if (fresh.audioChapters !== item.audioChapters) {
        patch(fresh.id, { audioChapters: fresh.audioChapters }).catch(() => undefined);
      }
      const audio = fresh.audioChapters[index];
      if (!audio?.file && isBundledNarration(fresh)) {
        throw new Error(MISSING_BUNDLE);
      }
      const path = `items/${fresh.id}/audio/${audio?.file ?? ''}`;
      const uri = audio?.file ? await io.uri(path) : null;
      if (!uri) {
        throw new Error(isBundledNarration(fresh) ? MISSING_BUNDLE : 'The audio file is missing.');
      }
      if (stale()) {
        return;
      }
      chapterRef.current = index;
      itemIdRef.current = fresh.id;
      setItemId(fresh.id);
      setChapterState(index);
      setMarks({ itemId: fresh.id, spoken: null, follow: null });
      const loaded = await replaceAndWait(player, uri, () => !stale());
      if (stale()) {
        return;
      }
      if (!loaded) {
        throw new Error(PLAY_FAILED);
      }
      // seekMs is a file position. Chapter starts already include startMs, and a saved position does too.
      const start = Math.max(0, seekMs) / 1000;
      if (start > 0.2) {
        await player.seekTo(start);
      }
      if (stale()) {
        return;
      }
      player.setActiveForLockScreen(
        true,
        { title: fresh.title, artist: fresh.author, albumTitle: audio.title },
        { showSeekBackward: true, showSeekForward: true },
      );
      fileLoadedRef.current = true;
      liveUriRef.current = uri;
      if (queuedChapterRef.current?.id === fresh.id && queuedChapterRef.current.index === index) {
        queuedChapterRef.current = null;
      }
      cancelOnLeaveRef.current = false;
      patch(fresh.id, { audioChapter: index, audioPositionMs: positionMs, lastOpenedAt: Date.now() }).catch(() => undefined);
      if (autoplay) {
        await startPlayback(player, () => !stale() && wantPlayingRef.current);
        if (stale()) {
          return;
        }
        setPlaying(true);
        clearStatus();
      } else {
        player.pause();
        setPlaying(false);
        clearStatus();
      }
    } catch (error) {
      if (stale() || isDownloadCancelled(error)) {
        return;
      }
      cancelOnLeaveRef.current = false;
      wantPlayingRef.current = false;
      fileLoadedRef.current = false;
      setPlaying(false);
      clearStatus();
      showNotice(playbackNotice(error));
    } finally {
      if (flight.generation === downloadGen.current) {
        downloadRef.current = null;
        if (!wantPlayingRef.current || fileLoadedRef.current) {
          setBuffering(false);
          setBusy(false);
          if (fileLoadedRef.current) {
            setStatusLine(null);
          }
        }
      }
    }
  }

  async function primeIdle(uri: string, alive: () => boolean) {
    const idle = nextClipSlot(liveSlotRef.current);
    const player = playersRef.current[idle];
    if (!player || !alive()) {
      return;
    }
    if (primedRef.current?.uri === uri && player.isLoaded) {
      return;
    }
    primedRef.current = { slot: idle, uri };
    const ready = await replaceAndWait(player, uri, alive);
    if (!alive() || !ready) {
      if (primedRef.current?.uri === uri) {
        primedRef.current = null;
      }
    }
  }

  function playClip(uri: string, clipMs: number): Promise<void> {
    const run = runRef.current;
    const alive = () => run === runRef.current && wantPlayingRef.current;
    clipRef.current = freshClipWatch();
    return new Promise((resolve, reject) => {
      let settled = false;
      let guard: ReturnType<typeof setInterval> | undefined;
      const done = () => {
        if (guard) {
          clearInterval(guard);
        }
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      // A missed finish event must not leave narration waiting on a clip that already stopped.
      const guardEnd = () => {
        const began = Date.now();
        let lastTime = -1;
        guard = setInterval(() => {
          if (settled || !alive()) {
            done();
            return;
          }
          const player = livePlayer();
          if (!player || liveUriRef.current !== uri) {
            return;
          }
          const knownMs = clipMs > 0 ? clipMs : player.duration * 1000;
          const timeMs = player.currentTime * 1000;
          const atEnd = knownMs > 0 && !player.playing && timeMs >= knownMs - 300;
          const overdue = knownMs > 0 && Date.now() - began > knownMs / Math.max(0.25, settingsRef.current.rate) + 3000;
          const stalled = timeMs === lastTime;
          lastTime = timeMs;
          if (!atEnd && !(overdue && stalled)) {
            return;
          }
          if (finishRef.current === done) {
            tryHandoff();
            finishRef.current = null;
          }
          done();
        }, 500);
      };
      finishRef.current = done;
      void (async () => {
        try {
          if (!alive()) {
            done();
            return;
          }
          const live = liveSlotRef.current;
          const current = playersRef.current[live];
          if (liveUriRef.current === uri && current?.playing) {
            onClipStarted();
            guardEnd();
            return;
          }
          const primed = primedRef.current;
          const primedPlayer = primed?.uri === uri ? playersRef.current[primed.slot] : null;
          if (primed && primedPlayer?.isLoaded) {
            const from = live;
            liveSlotRef.current = primed.slot;
            playerRef.current = primedPlayer;
            liveUriRef.current = uri;
            primedRef.current = null;
            playersRef.current[from]?.pause();
            await startPlayback(primedPlayer, alive);
            if (!alive()) {
              done();
              return;
            }
                    onClipStarted();
            guardEnd();
            return;
          }
          if (!current) {
            throw new Error(PLAY_FAILED);
          }
          const loaded = await replaceAndWait(current, uri, alive);
          if (!alive()) {
            done();
            return;
          }
          if (!loaded) {
            throw new Error(PLAY_FAILED);
          }
          liveUriRef.current = uri;
          await startPlayback(current, alive);
          if (!alive()) {
            done();
            return;
          }
                onClipStarted();
          guardEnd();
        } catch (error) {
          if (settled) {
            return;
          }
          settled = true;
          finishRef.current = null;
          reject(error);
        }
      })();
    });
  }

  async function loadVoices() {
    if (voicesRef.current.length) {
      return;
    }
    // A browser with no voices never sends voiceschanged, so the list request can wait forever.
    voicesRef.current = await Promise.race([
      Speech.getAvailableVoicesAsync().catch(() => []),
      new Promise<SystemVoice[]>((resolve) => setTimeout(() => resolve([]), 1500)),
    ]);
  }

  function speakSentence(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;
      let settled = false;
      const hang = setTimeout(() => {
        if (settled || started) {
          return;
        }
        settled = true;
        reject(new Error('Speech did not start. Tap to try again.'));
      }, FIRST_SOUND_MS);
      const finish = (ok: boolean, error?: unknown) => {
        if (settled) {
          return;
        }
        if (!ok) {
          settled = true;
          clearTimeout(hang);
          const message = error instanceof Error ? error.message.trim() : '';
          reject(message ? error : new Error('Speech failed.'));
          return;
        }
        if (!started) {
          return;
        }
        settled = true;
        clearTimeout(hang);
        resolve();
      };
      Speech.speak(text, {
        voice: usableVoice(voicesRef.current, settingsRef.current.systemVoice),
        rate: settingsRef.current.rate,
        onStart: () => {
          started = true;
          onClipStarted();
        },
        onDone: () => finish(true),
        onStopped: () => finish(true),
        onError: (error) => finish(false, error),
      });
    });
  }

  function cachedSpeech(item: LibraryItem, engine: string, voice: string, text: string): Promise<Uint8Array> {
    const path = clipPath(item.id, engine, voice, text);
    const running = speechRef.current.get(path);
    if (running) {
      return running;
    }
    const job = synthesize(path, engine, voice, text).finally(() => speechRef.current.delete(path));
    speechRef.current.set(path, job);
    return job;
  }

  async function synthesize(path: string, engine: string, voice: string, text: string): Promise<Uint8Array> {
    const existing = await io.readBytes(path);
    if (existing) {
      return existing;
    }
    let bytes: Uint8Array;
    if (engine === 'gemini') {
      const apiKey = await getGeminiKey();
      if (!apiKey) {
        throw new GeminiError('Add a Gemini API key in Settings.', 0, false, false);
      }
      bytes = await synthesizeGemini({
        apiKey,
        model: settingsRef.current.geminiModel,
        voice,
        text,
      });
    } else {
      bytes = await synthesizeKokoro(text, voice);
    }
    await io.writeBytes(path, bytes);
    return bytes;
  }

  function warmNext(item: LibraryItem, choice: string, voice: string, sentences: string[], sentence: number, alive: () => boolean) {
    const following = choice === 'kokoro' ? prefetchSentences(sentences, sentence, KOKORO_PREFETCH) : [];
    for (const text of following) {
      cachedSpeech(item, choice, voice, text).catch(() => undefined);
    }
    const nextText = sentences[sentence + 1];
    if (!nextText || (choice !== 'kokoro' && choice !== 'gemini')) {
      return;
    }
    if (choice === 'gemini') {
      cachedSpeech(item, choice, voice, nextText).catch(() => undefined);
    }
    void cachedSpeech(item, choice, voice, nextText)
      .then(async () => {
        if (!alive()) {
          return;
        }
        const uri = await io.uri(clipPath(item.id, choice, voice, nextText));
        if (!uri || !alive()) {
          return;
        }
        await primeIdle(uri, alive);
      })
      .catch(() => undefined);
  }

  async function narrate(item: LibraryItem, from = { chapter: item.locator?.chapter ?? 0, sentence: item.locator?.sentence ?? 0 }) {
    const run = ++runRef.current;
    fileLoadedRef.current = false;
    narratingRef.current = true;
    narrationRef.current = { kind: 'speech' };
    primedRef.current = null;
    liveUriRef.current = null;
    Speech.stop();
    pausePlayers();
    clipDurationsRef.current = [];
    setPositionMs(0);
    setDurationMs(0);
    setBuffering(true);
    setBusy(true);
    setStatusLine(preparingLine(settingsRef.current.engine, kokoroRef.current));
    await new Promise((resolve) => setTimeout(resolve, 60));
    itemIdRef.current = item.id;
    setItemId(item.id);
    const alive = () => run === runRef.current;
    let engine = settingsRef.current.engine;
    let geminiNote: string | null = null;
    for (let chapterIndex = from.chapter; chapterIndex < item.chapters.length; chapterIndex += 1) {
      const html = await readChapter(io, item.id, chapterIndex);
      const sentences = sentencesFromHtml(html);
      const start = chapterIndex === from.chapter ? from.sentence : 0;
      clipDurationsRef.current = [];
      for (let sentence = start; sentence < sentences.length; sentence += 1) {
        if (!alive()) {
          return;
        }
        if (sleepDue()) {
          pause();
          return;
        }
        chapterRef.current = chapterIndex;
        setChapterState(chapterIndex);
        narratedRef.current = { itemId: item.id, chapter: chapterIndex, sentence, sentences };
        const text = sentences[sentence];
        if (!text) {
          continue;
        }
        publishMark({ chapter: chapterIndex, sentence });
        publishNarrationClock(narratedRef.current, 0, 0);
        if (sentence > start || chapterIndex > from.chapter) {
          const live = livePlayer();
          if (!live?.playing) {
            setStatusLine('Waiting for the next sentence…');
            setBuffering(true);
          }
        }
        const order = engine === 'gemini' ? ['gemini', 'kokoro', 'system'] : engine === 'kokoro' ? ['kokoro', 'system'] : ['system'];
        let spoken = false;
        for (const choice of order) {
          if (!alive()) {
            return;
          }
          try {
            if (choice === 'system') {
              narrationRef.current = { kind: 'speech' };
              await loadVoices();
                        await speakSentence(text);
                    clipDurationsRef.current[sentence] = estimateSpeechMs(text, settingsRef.current.rate);
            } else {
              const voice = choice === 'gemini' ? settingsRef.current.geminiVoice : settingsRef.current.kokoroVoice;
              if (choice === 'kokoro' && kokoroRef.current.state === 'loading') {
                setStatusLine(preparingLine('kokoro', kokoroRef.current));
                setBuffering(true);
              } else if (!livePlayer()?.playing) {
                setStatusLine(sentence === start && chapterIndex === from.chapter ? preparingLine(choice, kokoroRef.current) : 'Waiting for the next sentence…');
                setBuffering(true);
              }
              const generate = cachedSpeech(item, choice, voice, text);
              // Bound every Kokoro sentence, not only the first, so a stall between clips falls back to the system voice.
              const hungKokoro = choice === 'kokoro' && kokoroRef.current.state !== 'loading';
              const bytes = hungKokoro ? await raceFirstSound(generate, false) : await generate;
              clipDurationsRef.current[sentence] = wavDurationMs(bytes);
              warmNext(item, choice, voice, sentences, sentence, alive);
              const uri = await io.uri(clipPath(item.id, choice, voice, text));
              if (!uri || !alive()) {
                return;
              }
              const player = livePlayer();
              player?.setActiveForLockScreen(true, { title: item.title, artist: item.author }, { showSeekBackward: true, showSeekForward: true });
              narrationRef.current = { kind: 'clip', chapter: chapterIndex, sentence, text, uri };
              publishMark({ chapter: chapterIndex, sentence });
              await playClip(uri, clipDurationsRef.current[sentence] ?? 0);
            }
            spoken = true;
            break;
          } catch (error) {
            if (!alive()) {
              return;
            }
            const quota = error instanceof GeminiError && error.quota;
            if (choice === 'gemini') {
              const missingKey = error instanceof GeminiError && /API key in Settings/i.test(error.message);
              geminiNote = missingKey ? 'Add a Gemini API key in Settings.' : null;
              showNotice(
                geminiNote ??
                  (quota
                    ? 'Gemini quota was hit. Switching to the on-device voice, then the system voice if needed.'
                    : 'Gemini could not speak that sentence. Trying the next voice.'),
                false,
              );
              engine = 'kokoro';
            } else if (choice === 'kokoro') {
              const kokoroNote = 'Kokoro is not ready on this device, so Folio is using the system voice.';
              showNotice(geminiNote ? `${geminiNote} ${kokoroNote}` : kokoroNote, false);
              engine = 'system';
            } else {
              narratingRef.current = false;
              narrationRef.current = null;
              wantPlayingRef.current = false;
              setPlaying(false);
              clearStatus();
              const failed = error instanceof Error && error.message === PLAY_FAILED;
              const message = error instanceof Error ? error.message.trim() : '';
              showNotice(failed ? PLAY_FAILED : message || 'Narration stopped.');
              return;
            }
          }
        }
        if (!spoken || !alive()) {
          return;
        }
        const latest = itemsRef.current.find((entry) => entry.id === item.id);
        const keptScroll = latest?.locator?.chapter === chapterIndex ? latest.locator.scroll : undefined;
        patch(item.id, {
          locator: {
            chapter: chapterIndex,
            page: 0,
            sentence,
            ...(keptScroll != null ? { scroll: keptScroll } : {}),
          },
          lastOpenedAt: Date.now(),
          progress: (chapterIndex + (sentence + 1) / Math.max(1, sentences.length)) / item.chapters.length,
        }).catch(() => undefined);
      }
      if (alive() && endOfChapterDue()) {
        pause();
        return;
      }
    }
    if (alive()) {
      narratingRef.current = false;
      narrationRef.current = null;
      setPlaying(false);
      clearStatus();
    }
  }

  async function playItem(id: string, mode: 'audio' | 'narrate' = 'audio') {
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    await play(item, mode);
  }

  async function play(item: LibraryItem, mode: 'audio' | 'narrate') {
    const id = item.id;
    const now = Date.now();
    if (itemIdRef.current === id && wantPlayingRef.current && now - lastPlayTapRef.current < 400) {
      return;
    }
    lastPlayTapRef.current = now;
    cancelDownload();
    runRef.current += 1;
    narratingRef.current = false;
    narrationRef.current = null;
    Speech.stop();
    pausePlayers();
    finishRef.current?.();
    finishRef.current = null;
    narratedRef.current = null;
    primedRef.current = null;
    liveUriRef.current = null;
    setNotice(null);
    setRetryable(false);
    itemIdRef.current = id;
    setItemId(id);
    patch(id, { lastOpenedAt: Date.now() }).catch(() => undefined);
    const planned = { ...item, listen: listenPrefRef.current[id] ?? item.listen };
    const plan = playbackPlan(planned, mode);
    if (plan.action === 'error') {
      wantPlayingRef.current = false;
      setPlaying(false);
      clearStatus();
      showNotice(plan.message, false);
      return;
    }
    if (plan.action === 'narrate') {
      pausePlayers();
      wantPlayingRef.current = true;
      setPlaying(true);
      setBuffering(true);
      setBusy(true);
      setStatusLine(preparingLine(settingsRef.current.engine, kokoroRef.current));
      await narrate(planned);
      return;
    }
    const queued = queuedChapterRef.current;
    const chapterIndex = queued?.id === id ? queued.index : planned.audioChapter || 0;
    const resume = queued?.id === id ? queued.positionMs : planned.audioPositionMs || planned.audioChapters[chapterIndex]?.startMs || 0;
    await startFile(planned, chapterIndex, resume);
  }

  function pause() {
    const player = livePlayer();
    const id = itemIdRef.current;
    const wasFile = fileLoadedRef.current && !narratingRef.current;
    const positionMs = player ? Math.max(0, Math.round(player.currentTime * 1000)) : 0;
    wantPlayingRef.current = false;
    runRef.current += 1;
    cancelDownload();
    narratingRef.current = false;
    narrationRef.current = null;
    Speech.stop();
    pausePlayers();
    finishRef.current?.();
    finishRef.current = null;
    primedRef.current = null;
    if (wasFile && id && queuedChapterRef.current == null) {
      patch(id, { audioPositionMs: positionMs, audioChapter: chapterRef.current }).catch(() => undefined);
    }
    setPlaying(false);
    clearStatus();
  }

  function toggle() {
    if (playingRef.current || wantPlayingRef.current) {
      pause();
      return;
    }
    if (resumeChoice(fileLoadedRef.current) === 'continue' && livePlayer()) {
      const player = livePlayer();
      if (!player) {
        return;
      }
      if (!player.isLoaded) {
        if (itemIdRef.current) {
          void playItem(itemIdRef.current);
        }
        return;
      }
      wantPlayingRef.current = true;
      setBuffering(true);
      player.setPlaybackRate(settingsRef.current.rate, 'high');
      void (async () => {
        const run = ++runRef.current;
        try {
          await startPlayback(player, () => run === runRef.current && wantPlayingRef.current);
          if (run !== runRef.current || !wantPlayingRef.current) {
            return;
          }
          setPlaying(true);
          clearStatus();
        } catch {
          if (run === runRef.current) {
            failStart();
          }
        }
      })();
      return;
    }
    if (itemIdRef.current) {
      void playItem(itemIdRef.current);
    }
  }

  function seekBy(deltaMs: number) {
    if (busy && !narratedRef.current) {
      return;
    }
    const narrated = narratedRef.current;
    if (narrated && narrated.itemId === itemIdRef.current && !fileLoadedRef.current) {
      skipNarration(narrated, deltaMs);
      return;
    }
    const player = livePlayer();
    if (!player || narratingRef.current) {
      return;
    }
    const next = Math.max(0, player.currentTime * 1000 + deltaMs);
    player.seekTo(next / 1000).catch(() => undefined);
  }

  // Narration has no clock to seek, so a skip restarts it on the sentence the skip lands on.
  // While paused, the skip only moves the place Play starts from.
  function skipNarration(narrated: Narrated, deltaMs: number) {
    const item = currentItem();
    const sentence = skipSentence(narrated.sentences, narrated.sentence, deltaMs);
    if (!item || sentence === narrated.sentence) {
      return;
    }
    narratedRef.current = { ...narrated, sentence };
    publishMark({ chapter: narrated.chapter, sentence });
    publishNarrationClock(narratedRef.current, 0, 0);
    if (!narratingRef.current) {
      patch(item.id, { locator: { chapter: narrated.chapter, page: 0, sentence } }).catch(() => undefined);
      return;
    }
    runRef.current += 1;
    Speech.stop();
    pausePlayers();
    finishRef.current?.();
    finishRef.current = null;
    primedRef.current = null;
    liveUriRef.current = null;
    void narrate(item, { chapter: narrated.chapter, sentence });
  }

  function setListen(id: string, listen: ListenMode) {
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (!item || !offersVoiceChoice(item) || listenMode({ ...item, listen: listenPrefRef.current[id] ?? item.listen }) === listen) {
      return;
    }
    listenPrefRef.current[id] = listen;
    const player = livePlayer();
    const loaded = itemIdRef.current === id;
    const resume = loaded && wantPlayingRef.current;
    const changes: Partial<LibraryItem> = { listen };
    if (listen === 'voice') {
      const file = loaded && fileLoadedRef.current ? player : null;
      const positionMs = file ? Math.round(file.currentTime * 1000) : item.audioPositionMs;
      const durationMs = file ? Math.round((file.duration || 0) * 1000) : 0;
      const audioChapter = file ? chapterRef.current : item.audioChapter || 0;
      // A recording that was never started says nothing about the place, so the reading place stays.
      const at = file || positionMs > 0 ? sentenceAtTime(item, audioChapter, positionMs, durationMs) : null;
      if (at) {
        changes.locator = { chapter: at.chapter, page: 0, sentence: at.sentence };
      }
      if (file) {
        changes.audioPositionMs = positionMs;
        changes.audioChapter = audioChapter;
      }
    } else {
      const narrated = narratingRef.current && narratedRef.current?.itemId === id ? narratedRef.current : null;
      const from = narrated ?? item.locator;
      const at = from ? timeForSentence(item, from.chapter, from.sentence) : null;
      if (at) {
        changes.audioChapter = at.audioChapter;
        changes.audioPositionMs = at.positionMs;
        if (queuedChapterRef.current?.id === id) {
          queuedChapterRef.current = null;
        }
      }
    }
    if (loaded) {
      runRef.current += 1;
      cancelDownload();
      narratingRef.current = false;
      narrationRef.current = null;
      narratedRef.current = null;
      fileLoadedRef.current = false;
      wantPlayingRef.current = false;
      Speech.stop();
      pausePlayers();
      finishRef.current?.();
      finishRef.current = null;
      primedRef.current = null;
      liveUriRef.current = null;
      setPlaying(false);
    }
    patch(id, changes).catch(() => undefined);
    if (resume) {
      if (listen === 'voice') {
        setStatusLine(preparingLine(settingsRef.current.engine, kokoroRef.current));
        setBuffering(true);
        setBusy(true);
      } else {
        setStatusLine('Fetching audio…');
        setBuffering(true);
        setBusy(true);
      }
      void play({ ...item, ...changes }, 'audio');
    }
  }

  function cueChapter(id: string, index: number, autoplay: boolean) {
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    if (index < 0 || index >= item.audioChapters.length) {
      showNotice('That chapter is missing.', false);
      return;
    }
    if (isBundledNarration(item) && !item.hasAudio) {
      showNotice(MISSING_BUNDLE, false);
      return;
    }
    void startFile(item, index, item.audioChapters[index]?.startMs ?? 0, autoplay, true);
  }

  function intendedPlaying() {
    return wantPlayingRef.current;
  }

  function retry() {
    setNotice(null);
    setRetryable(false);
    const id = itemIdRef.current;
    if (id) {
      void playItem(id);
    }
  }

  function setSleepMinutes(minutes: number | null) {
    if (minutes == null) {
      sleepRef.current = { until: null, endOfChapter: false };
      setSleepLabel(null);
      return;
    }
    if (minutes === 0) {
      sleepRef.current = { until: null, endOfChapter: true };
      setSleepLabel('End of chapter');
      return;
    }
    sleepRef.current = { until: Date.now() + minutes * 60_000, endOfChapter: false };
    setSleepLabel(`${minutes} min`);
  }

  const actionsRef = useRef({
    playItem,
    toggle,
    pause,
    seekBy,
    cueChapter,
    intendedPlaying,
    setSleepMinutes,
    setListen,
    clearNotice: () => {
      setNotice(null);
      setRetryable(false);
    },
    retry,
  });
  actionsRef.current = {
    playItem,
    toggle,
    pause,
    seekBy,
    cueChapter,
    intendedPlaying,
    setSleepMinutes,
    setListen,
    clearNotice: () => {
      setNotice(null);
      setRetryable(false);
    },
    retry,
  };

  const actions = useMemo<PlayerActions>(
    () => ({
      playItem: (id, mode) => actionsRef.current.playItem(id, mode),
      toggle: () => actionsRef.current.toggle(),
      pause: () => actionsRef.current.pause(),
      seekBy: (delta) => actionsRef.current.seekBy(delta),
      cueChapter: (id, index, autoplay) => actionsRef.current.cueChapter(id, index, autoplay),
      intendedPlaying: () => actionsRef.current.intendedPlaying(),
      setSleepMinutes: (minutes) => actionsRef.current.setSleepMinutes(minutes),
      setListen: (id, listen) => actionsRef.current.setListen(id, listen),
      clearNotice: () => actionsRef.current.clearNotice(),
      retry: () => actionsRef.current.retry(),
    }),
    [],
  );

  const state = useMemo<PlayerState>(
    () => ({ itemId, playing, positionMs, durationMs, chapter, notice, buffering, busy, statusLine, retryable, sleepLabel }),
    [itemId, playing, positionMs, durationMs, chapter, notice, buffering, busy, statusLine, retryable, sleepLabel],
  );

  return (
    <PlayerActionsContext.Provider value={actions}>
      <PlayerContext.Provider value={state}>
        <MarkContext.Provider value={marks}>
          <PlayingContext.Provider value={playing}>
            <Quiet>{children}</Quiet>
          </PlayingContext.Provider>
        </MarkContext.Provider>
      </PlayerContext.Provider>
    </PlayerActionsContext.Provider>
  );
}

const Quiet = memo(function Quiet({ children }: { children: ReactNode }) {
  return children;
});

export function usePlayerState(): PlayerState {
  const value = useContext(PlayerContext);
  if (!value) {
    throw new Error('Player is not ready.');
  }
  return value;
}

export function usePlayerMarks(): MarkState {
  const value = useContext(MarkContext);
  if (!value) {
    throw new Error('Player is not ready.');
  }
  return value;
}

export function usePlaying(): boolean {
  const value = useContext(PlayingContext);
  if (value == null) {
    throw new Error('Player is not ready.');
  }
  return value;
}

export function usePlayerActions(): PlayerActions {
  const value = useContext(PlayerActionsContext);
  if (!value) {
    throw new Error('Player is not ready.');
  }
  return value;
}

export function usePlayer(): PlayerState & PlayerActions {
  return { ...usePlayerState(), ...usePlayerActions() };
}
