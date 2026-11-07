import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { PlayerBar } from '@/components/PlayerBar';
import { LibraryProvider } from '@/state/library';
import { PlayerProvider } from '@/state/player';
import { SettingsProvider } from '@/state/settings';
import { useSettings } from '@/state/settings';
import { KokoroHost } from '@/tts/kokoro';
import { usePalette } from '@/theme';

function Shell() {
  const palette = usePalette();
  const { settings } = useSettings();
  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <StatusBar style={settings.theme === 'dark' ? 'light' : 'dark'} />
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />
      </View>
      <PlayerBar />
      <KokoroHost />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <LibraryProvider>
        <SettingsProvider>
          <PlayerProvider>
            <Shell />
          </PlayerProvider>
        </SettingsProvider>
      </LibraryProvider>
    </GestureHandlerRootView>
  );
}
