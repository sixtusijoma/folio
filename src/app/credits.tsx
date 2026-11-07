import { router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useLibrary } from '@/state/library';
import { usePalette } from '@/theme';

export default function CreditsScreen() {
  const palette = usePalette();
  const { items } = useLibrary();
  const sourced = items.filter((item) => item.textSource || item.audioSource || item.credit);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView contentContainerStyle={{ padding: 20, width: '100%', maxWidth: 720, alignSelf: 'center', gap: 16, paddingBottom: 48 }}>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: palette.accent }}>Shelf</Text>
        </Pressable>
        <Text style={{ color: palette.ink, fontSize: 32, fontFamily: 'Georgia' }}>Credits</Text>
        <Text style={{ color: palette.muted, lineHeight: 22 }}>
          The starter shelf is a small demo. Each book ships as a Standard Ebooks EPUB plus the first LibriVox chapter. Later chapters download from Archive.org when you play them. The short sample is original text with a recording made for this demo.
        </Text>
        <Card title="The Time Machine">
          H. G. Wells, 1895. Text from Standard Ebooks. Audio from LibriVox (time_machine_v6_2008_librivox). Chapter 1 is on the device.
        </Card>
        <Card title="The Art of War">
          Sun Tzu, Lionel Giles translation. Text from Standard Ebooks. Audio from LibriVox (artofwar3_pc_librivox). Laying Plans is on the device.
        </Card>
        <Card title="A Lamp in the Window">
          Original sample text. The recording is a short synthetic reading of that text, bundled with a WebVTT so follow playback can track the sentences.
        </Card>
        <Card title="Voices">
          iOS system speech is the default. Kokoro 82M is the free on-device neural voice and downloads from Hugging Face the first time you use it. Gemini TTS uses a key you paste in Settings. If Gemini hits a free-tier limit, Folio backs off, then falls through to Kokoro and the system voice.
        </Card>
        {sourced.length ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: palette.ink, fontSize: 20, fontFamily: 'Georgia' }}>On this shelf</Text>
            {sourced.map((item) => (
              <Text key={item.id} style={{ color: palette.muted, lineHeight: 20 }}>
                {item.title}
                {item.textSource ? ` · text ${item.textSource}` : ''}
                {item.audioSource ? ` · audio ${item.audioSource}` : ''}
                {item.credit ? ` · ${item.credit}` : ''}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Card({ title, children }: { title: string; children: string }) {
  const palette = usePalette();
  return (
    <View style={{ backgroundColor: palette.paper, borderRadius: 16, padding: 16, gap: 8 }}>
      <Text style={{ color: palette.ink, fontSize: 18, fontFamily: 'Georgia' }}>{title}</Text>
      <Text style={{ color: palette.muted, lineHeight: 22 }}>{children}</Text>
    </View>
  );
}
