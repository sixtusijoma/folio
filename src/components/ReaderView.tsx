import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { WebViewMessageEvent } from 'react-native-webview';

import { FolioWebView, type FolioWebHandle } from '@/components/folioWeb';
import type { ScrollOrigin } from '@/lib/readerFollow';
import { readerDocument, readerDocumentKey } from '@/lib/readerHtml';
import type { FontChoice, ThemeName } from '@/lib/types';
import { usePalette } from '@/theme';

type Props = {
  html: string;
  restoreSentence: number;
  restoreScroll: number | null;
  placeToken: string | null;
  followSentence: number | null;
  holdFollow?: boolean;
  onReleaseFollow?: () => void;
  playing: boolean;
  fontSize: number;
  lineHeight: number;
  margin: number;
  font: FontChoice;
  theme: ThemeName;
  onScroll: (ratio: number, origin: ScrollOrigin) => void;
};

function ReaderViewComponent({
  html,
  restoreSentence,
  restoreScroll,
  placeToken,
  followSentence,
  holdFollow = false,
  onReleaseFollow,
  playing,
  fontSize,
  lineHeight,
  margin,
  font,
  theme,
  onScroll,
}: Props) {
  const palette = usePalette();
  const webRef = useRef<FolioWebHandle>(null);
  const [width, setWidth] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const anchor = useRef({ sentence: restoreSentence, scroll: restoreScroll });
  anchor.current = { sentence: restoreSentence, scroll: restoreScroll };
  const wasPlaying = useRef(playing);
  const onScrollRef = useRef(onScroll);
  const holdRef = useRef(holdFollow);
  const releaseRef = useRef(onReleaseFollow);
  onScrollRef.current = onScroll;
  holdRef.current = holdFollow;
  releaseRef.current = onReleaseFollow;

  const signature =
    html && width > 0 ? readerDocumentKey({ body: html, width, fontSize, lineHeight, margin, font, theme }) : '';
  useEffect(() => {
    setSuspended(false);
  }, [signature]);
  const document = useMemo(() => {
    if (!signature) return '';
    return readerDocument({ body: html, width, fontSize, lineHeight, margin, font, theme });
  }, [signature, html, width, fontSize, lineHeight, margin, font, theme]);
  const source = useMemo(() => (document ? { html: document } : null), [document]);

  function inject(message: { type: string; sentence?: number | null; ratio?: number | null }) {
    webRef.current?.injectJavaScript(`window.__folio && window.__folio(${JSON.stringify(message)}); true;`);
  }

  function place(sentence: number | null, ratio: number | null) {
    inject({ type: 'place', sentence, ratio });
  }

  function follow(sentence: number | null) {
    if (sentence == null) return;
    inject({ type: 'follow', sentence });
  }

  useEffect(() => {
    if (!document || followSentence == null || holdFollow) return;
    follow(followSentence);
    // follow reads the latest sentence. The document script ignores it while the reader is suspended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followSentence, document, holdFollow]);

  useEffect(() => {
    if (!document || !placeToken) return;
    setSuspended(false);
    inject({ type: 'resume' });
    place(anchor.current.sentence, null);
    // placeToken is the bar's request to open this sentence. Later scroll reports must not repeat it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeToken, document]);

  useEffect(() => {
    const started = playing && !wasPlaying.current;
    wasPlaying.current = playing;
    if (!started || !document || holdRef.current) return;
    setSuspended(false);
    inject({ type: 'resume' });
    follow(followSentence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, document]);

  function onMessage(event: WebViewMessageEvent) {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string; ratio?: number; origin?: string };
      if (message.type === 'scroll' && typeof message.ratio === 'number') {
        const origin: ScrollOrigin = message.origin === 'user' || message.origin === 'follow' ? message.origin : 'restore';
        onScrollRef.current(message.ratio, origin);
      }
      if (message.type === 'suspend') setSuspended(true);
    } catch {
      // Ignore a malformed message from the reader document.
    }
  }

  function resume() {
    setSuspended(false);
    releaseRef.current?.();
    inject({ type: 'resume' });
    follow(followSentence);
  }

  return (
    <View
      style={{ flex: 1 }}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        if (next > 0) setWidth((current) => (current === next ? current : next));
      }}
    >
      {source ? (
        <FolioWebView
          ref={webRef}
          originWhitelist={['*']}
          source={source}
          onMessage={onMessage}
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          setSupportMultipleWindows={false}
          style={{ flex: 1, backgroundColor: 'transparent' }}
          onLoadEnd={() => {
            place(anchor.current.sentence, anchor.current.scroll);
            if (!holdRef.current) follow(followSentence);
          }}
        />
      ) : null}
      {suspended || holdFollow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Follow playback"
          onPress={resume}
          style={{ position: 'absolute', right: 16, bottom: 16, backgroundColor: palette.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}
        >
          <Text style={{ color: theme === 'dark' ? '#1c1915' : '#f7f4ee', fontWeight: '700' }}>Follow</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const ReaderView = memo(ReaderViewComponent);
