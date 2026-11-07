import * as Speech from 'expo-speech';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GEMINI_MODELS, GEMINI_VOICES } from '@/lib/gemini';
import { getGeminiKey, setGeminiKey } from '@/lib/secrets';
import type { NarrationEngine } from '@/lib/types';
import { readingVoices, type SystemVoice } from '@/lib/voices';
import { useSettings } from '@/state/settings';
import { usePalette } from '@/theme';
import { KOKORO_VOICES, kokoroStatus, prepareKokoro, subscribeKokoro } from '@/tts/kokoro';

const ENGINES: { id: NarrationEngine; label: string; detail: string }[] = [
  { id: 'system', label: Platform.OS === 'ios' ? 'iOS system voice' : 'System voice', detail: 'Built in. Works offline. The fallback when another voice fails.' },
  { id: 'kokoro', label: 'On-device neural', detail: 'Kokoro, free and offline after a one-time download. Runs in the app, including Expo Go.' },
  { id: 'gemini', label: 'Gemini', detail: 'Your own free-tier key. Generated audio is cached on the device.' },
];

export default function SettingsScreen() {
  const palette = usePalette();
  const { settings, update } = useSettings();
  const [key, setKey] = useState('');
  const [keyNote, setKeyNote] = useState('No key saved.');
  const [voices, setVoices] = useState<SystemVoice[]>([]);
  const [voicesReady, setVoicesReady] = useState(false);
  const [kokoro, setKokoro] = useState(kokoroStatus());
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    getGeminiKey()
      .then((saved) => setKeyNote(saved ? 'A key is saved on this device.' : 'No key saved.'))
      .catch(() => setKeyNote('No key saved.'));
    Speech.getAvailableVoicesAsync()
      .then((available) => {
        setVoices(available.map((voice) => ({ identifier: voice.identifier, name: voice.name, language: voice.language, quality: voice.quality })));
      })
      .catch(() => undefined)
      .finally(() => setVoicesReady(true));
    return subscribeKokoro(setKokoro);
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView contentContainerStyle={{ padding: 20, width: '100%', maxWidth: 720, alignSelf: 'center', gap: 16, paddingBottom: 40 }}>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: palette.accent }}>Shelf</Text>
        </Pressable>
        <Text style={{ color: palette.ink, fontSize: 32, fontFamily: 'Georgia' }}>Settings</Text>

        <Block title="Reading">
          <Line label="Theme">
            {(['light', 'sepia', 'dark'] as const).map((theme) => (
              <Pill key={theme} label={theme} active={settings.theme === theme} onPress={() => update({ theme })} />
            ))}
          </Line>
          <Line label="Font">
            <Pill label="Serif" active={settings.font === 'serif'} onPress={() => update({ font: 'serif' })} />
            <Pill label="Sans" active={settings.font === 'sans'} onPress={() => update({ font: 'sans' })} />
          </Line>
          <Line label={`Size ${settings.fontSize}`}>
            <Pill label="−" onPress={() => update({ fontSize: Math.max(16, settings.fontSize - 1) })} />
            <Pill label="+" onPress={() => update({ fontSize: Math.min(32, settings.fontSize + 1) })} />
          </Line>
          <Line label="Line spacing">
            {[1.3, 1.45, 1.65, 1.85].map((lineHeight) => (
              <Pill key={lineHeight} label={String(lineHeight)} active={settings.lineHeight === lineHeight} onPress={() => update({ lineHeight })} />
            ))}
          </Line>
          <Line label="Margins">
            {[16, 28, 40].map((margin) => (
              <Pill key={margin} label={String(margin)} active={settings.margin === margin} onPress={() => update({ margin })} />
            ))}
          </Line>
          <Line label="Estimate position">
            <Pill label={settings.approximateSync ? 'On' : 'Off'} active={settings.approximateSync} onPress={() => update({ approximateSync: !settings.approximateSync })} />
          </Line>
          <Line label="Follow playback">
            <Pill label={settings.followPlayback ? 'On' : 'Off'} active={settings.followPlayback} onPress={() => update({ followPlayback: !settings.followPlayback })} />
          </Line>
        </Block>

        <Block title="Narration">
          {ENGINES.map((engine) => (
            <Pressable key={engine.id} onPress={() => update({ engine: engine.id })} style={{ paddingVertical: 8 }}>
              <Text style={{ color: settings.engine === engine.id ? palette.accent : palette.ink, fontWeight: '600' }}>
                {settings.engine === engine.id ? '● ' : '○ '}
                {engine.label}
              </Text>
              <Text style={{ color: palette.muted, marginTop: 2, lineHeight: 18 }}>{engine.detail}</Text>
            </Pressable>
          ))}
          <Line label={`Speed ${settings.rate.toFixed(2)}`}>
            {[0.85, 1, 1.15, 1.35, 1.6].map((rate) => (
              <Pill key={rate} label={String(rate)} active={settings.rate === rate} onPress={() => update({ rate })} />
            ))}
          </Line>
          <Line label="Skip back">
            {[10, 15, 30].map((skipBack) => (
              <Pill key={skipBack} label={`${skipBack}s`} active={settings.skipBack === skipBack} onPress={() => update({ skipBack })} />
            ))}
          </Line>
          <Line label="Skip forward">
            {[15, 30, 45].map((skipForward) => (
              <Pill key={skipForward} label={`${skipForward}s`} active={settings.skipForward === skipForward} onPress={() => update({ skipForward })} />
            ))}
          </Line>
        </Block>

        <Block title="System voice">
          <Pill label="Default" active={!settings.systemVoice} onPress={() => update({ systemVoice: undefined })} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {readingVoices(voices, settings.systemVoice).map((voice) => (
              <Pill
                key={voice.identifier}
                label={voice.label}
                active={settings.systemVoice === voice.identifier}
                onPress={() => update({ systemVoice: voice.identifier })}
              />
            ))}
          </View>
          {!voicesReady ? (
            <Text style={{ color: palette.muted }}>Looking up voices…</Text>
          ) : voices.length === 0 ? (
            <Text style={{ color: palette.muted }}>Voices appear on a device. The web preview uses the browser voice.</Text>
          ) : null}
        </Block>

        <Block title="Kokoro">
          <Text style={{ color: palette.muted, lineHeight: 20 }}>{kokoro.message}</Text>
          <Pressable
            onPress={() => {
              prepareKokoro().catch((caught: unknown) => setKokoro({ state: 'error', progress: 0, message: caught instanceof Error ? caught.message : 'Kokoro failed.' }));
            }}
            style={{ alignSelf: 'flex-start', backgroundColor: palette.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}
          >
            <Text style={{ color: palette.paper, fontWeight: '700' }}>{kokoro.state === 'loading' ? 'Downloading…' : 'Download Kokoro'}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {KOKORO_VOICES.map((voice) => (
              <Pill key={voice.id} label={voice.label} active={settings.kokoroVoice === voice.id} onPress={() => update({ kokoroVoice: voice.id })} />
            ))}
          </View>
        </Block>

        <Block title="Gemini">
          <Text style={{ color: palette.muted, lineHeight: 20 }}>
            Paste a key from Google AI Studio. It stays in secure storage on iPhone, and in this browser’s local storage on the web preview. Folio never ships a key.
          </Text>
          <Text style={{ color: palette.ink }}>{keyNote}</Text>
          <TextInput
            value={key}
            onChangeText={setKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Paste key"
            placeholderTextColor={palette.muted}
            style={{ borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 12, color: palette.ink }}
          />
          {keyError ? <Text style={{ color: palette.accent }}>{keyError}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={() => {
                setGeminiKey(key)
                  .then(() => {
                    setKey('');
                    setKeyError(null);
                    setKeyNote(key.trim() ? 'A key is saved on this device.' : 'No key saved.');
                  })
                  .catch(() => setKeyError('The key could not be saved.'));
              }}
              style={{ backgroundColor: palette.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}
            >
              <Text style={{ color: palette.paper, fontWeight: '700' }}>Save key</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setGeminiKey('')
                  .then(() => {
                    setKeyNote('No key saved.');
                    setKeyError(null);
                  })
                  .catch(() => setKeyError('The key could not be removed.'));
              }}
              style={{ backgroundColor: palette.chip, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}
            >
              <Text style={{ color: palette.ink }}>Remove</Text>
            </Pressable>
          </View>
          {GEMINI_MODELS.map((model) => (
            <Pill key={model.id} label={model.label} active={settings.geminiModel === model.id} onPress={() => update({ geminiModel: model.id })} />
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {GEMINI_VOICES.map((voice) => (
              <Pill key={voice.id} label={voice.id} active={settings.geminiVoice === voice.id} onPress={() => update({ geminiVoice: voice.id })} />
            ))}
          </View>
        </Block>
      </ScrollView>
    </SafeAreaView>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={{ backgroundColor: palette.paper, borderRadius: 16, padding: 16, gap: 10 }}>
      <Text style={{ color: palette.ink, fontSize: 20, fontFamily: 'Georgia' }}>{title}</Text>
      {children}
    </View>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: palette.muted }}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</View>
    </View>
  );
}

function Pill({ label, onPress, active }: { label: string; onPress: () => void; active?: boolean }) {
  const palette = usePalette();
  return (
    <Pressable onPress={onPress} style={{ backgroundColor: active ? palette.ink : palette.chip, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 }}>
      <Text style={{ color: active ? palette.paper : palette.ink }}>{label}</Text>
    </Pressable>
  );
}
