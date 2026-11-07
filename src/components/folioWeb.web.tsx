import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

export type FolioWebHandle = {
  injectJavaScript: (script: string) => void;
};

type Props = {
  source?: { html?: string; baseUrl?: string };
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
  onLoadEnd?: () => void;
  onContentProcessDidTerminate?: () => void;
  onRenderProcessGone?: () => void;
  style?: StyleProp<ViewStyle>;
  originWhitelist?: string[];
  scrollEnabled?: boolean;
  showsHorizontalScrollIndicator?: boolean;
  showsVerticalScrollIndicator?: boolean;
  setSupportMultipleWindows?: boolean;
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  allowFileAccess?: boolean;
  mixedContentMode?: string;
};

export const FolioWebView = forwardRef<FolioWebHandle, Props>(function FolioWebView(props, ref) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const onMessage = props.onMessage;
  const html = props.source?.html ?? '';

  useImperativeHandle(ref, () => ({
    injectJavaScript(script: string) {
      const win = frame.current?.contentWindow as (Window & { eval?: (code: string) => unknown }) | null;
      win?.eval?.(script);
    },
  }));

  useEffect(() => {
    function handle(event: MessageEvent) {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
      onMessage?.({ nativeEvent: { data } });
    }
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [onMessage]);

  return (
    <View style={[{ flex: 1, minHeight: 0 }, props.style]}>
      {createElement('iframe', {
        ref: frame,
        title: 'Folio page',
        srcDoc: html,
        onLoad: () => props.onLoadEnd?.(),
        style: { border: 'none', width: '100%', height: '100%', background: 'transparent' },
      })}
    </View>
  );
});
