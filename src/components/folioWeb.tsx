import { type ComponentType, type Ref } from 'react';
import { WebView, type WebViewProps } from 'react-native-webview';

export type FolioWebHandle = {
  injectJavaScript: (script: string) => void;
};

/** The published WebView types intersect props with `undefined` under TypeScript 6. */
export const FolioWebView = WebView as unknown as ComponentType<WebViewProps & { ref?: Ref<FolioWebHandle> }>;
