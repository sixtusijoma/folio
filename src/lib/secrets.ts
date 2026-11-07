import { Platform } from 'react-native';

const KEY = 'folio.gemini.apiKey';

export async function getGeminiKey(): Promise<string | null> {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem(KEY) ?? null;
  const SecureStore = await import('expo-secure-store');
  return SecureStore.getItemAsync(KEY);
}

export async function setGeminiKey(value: string): Promise<void> {
  const trimmed = value.trim();
  if (Platform.OS === 'web') {
    if (trimmed) globalThis.localStorage?.setItem(KEY, trimmed);
    else globalThis.localStorage?.removeItem(KEY);
    return;
  }
  const SecureStore = await import('expo-secure-store');
  if (!trimmed) {
    await SecureStore.deleteItemAsync(KEY);
    return;
  }
  await SecureStore.setItemAsync(KEY, trimmed);
}
