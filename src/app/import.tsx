import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { router } from 'expo-router';
import JSZip from 'jszip';
import { useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchArticle } from '@/lib/article';
import { attachAudio, importArticleHtml, importAudioBytes, importEpubBytes, importFolioFiles } from '@/lib/libraryStore';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/theme';

async function readUri(uri: string): Promise<Uint8Array> {
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    if (!response.ok) throw new Error('Could not read that file.');
    return new Uint8Array(await response.arrayBuffer());
  }
  return new File(uri).bytes();
}

async function filesFromZip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes);
  const files: Record<string, Uint8Array> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    files[name] = await entry.async('uint8array');
  }
  return files;
}

export default function ImportScreen() {
  const palette = usePalette();
  const { io, items, refresh } = useLibrary();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bookId, setBookId] = useState<string | null>(null);
  const [audioId, setAudioId] = useState<string | null>(null);

  async function run(task: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const note = await task();
      await refresh();
      setMessage(note);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  async function pick(kind: 'epub' | 'audio' | 'folio') {
    const type =
      kind === 'epub'
        ? ['application/epub+zip', 'application/octet-stream']
        : kind === 'audio'
          ? ['audio/*', 'text/vtt', 'text/plain', 'application/json']
          : ['application/zip', 'application/json', 'audio/*', 'text/vtt', 'text/plain'];
    const picked = await DocumentPicker.getDocumentAsync({ type, multiple: kind !== 'epub', copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets?.length) return;
    await run(async () => {
      const named: Record<string, Uint8Array> = {};
      for (const asset of picked.assets) {
        named[asset.name] = await readUri(asset.uri);
      }
      if (kind === 'epub') {
        const [name, bytes] = Object.entries(named)[0];
        const item = await importEpubBytes(io, bytes);
        return `Added ${item.title || name}.`;
      }
      const folioName = Object.keys(named).find((name) => name.endsWith('folio.json'));
      const zipName = Object.keys(named).find((name) => name.endsWith('.zip'));
      if (folioName) {
        const item = await importFolioFiles(io, named);
        return `Added ${item.title} to ${item.collection || 'the shelf'}.`;
      }
      if (zipName) {
        const item = await importFolioFiles(io, await filesFromZip(named[zipName]));
        return `Added ${item.title} from the bundle.`;
      }
      const audioName = Object.keys(named).find((name) => /\.(mp3|m4a|m4b)$/i.test(name));
      if (!audioName) throw new Error('Choose an MP3, M4A, M4B, a folio.json, or a zip.');
      const captions = Object.entries(named).find(([name]) => name.endsWith('.vtt'))?.[1];
      const script = Object.entries(named).find(([name]) => name.endsWith('.txt'))?.[1];
      const item = await importAudioBytes(io, audioName, named[audioName], { captions, script });
      return `Added ${item.title}.`;
    });
  }

  async function fromUrl() {
    const target = url.trim();
    if (!target) return;
    await run(async () => {
      const lower = target.toLowerCase();
      const file = lower.includes('.epub') || lower.includes('.zip');
      if (!file) {
        const article = await fetchArticle(target);
        const item = await importArticleHtml(io, article);
        return `Saved “${item.title}”.`;
      }
      const response = await fetch(target);
      if (!response.ok) throw new Error(`The link returned ${response.status}.`);
      if (lower.includes('.epub')) {
        const item = await importEpubBytes(io, new Uint8Array(await response.arrayBuffer()));
        return `Added ${item.title}.`;
      }
      const item = await importFolioFiles(io, await filesFromZip(new Uint8Array(await response.arrayBuffer())));
      return `Added ${item.title}.`;
    });
  }

  const books = items.filter((item) => item.kind === 'book' && item.hasText);
  const audios = items.filter((item) => item.hasAudio && item.kind !== 'book');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView contentContainerStyle={{ padding: 20, width: '100%', maxWidth: 720, alignSelf: 'center', gap: 18 }}>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: palette.accent }}>Shelf</Text>
        </Pressable>
        <Text style={{ color: palette.ink, fontSize: 32, fontFamily: 'Georgia' }}>Add to Folio</Text>
        <Text style={{ color: palette.muted, lineHeight: 22 }}>
          DRM-free EPUBs, articles, and audiobook files. Kindle and Audible files stay out.
        </Text>
        {busy ? <Text style={{ color: palette.ink }}>Working…</Text> : null}
        {message ? <Text style={{ color: palette.ink }}>{message}</Text> : null}
        {error ? <Text style={{ color: palette.accent, lineHeight: 20 }}>{error}</Text> : null}

        <Section title="Book" body="An EPUB from Standard Ebooks, Project Gutenberg, or Files.">
          <Button label="Choose EPUB" onPress={() => pick('epub')} />
        </Section>
        <Section title="Audio" body="MP3, M4A, or M4B. Add a .vtt or .txt in the same pick and Folio reads along with the file.">
          <Button label="Choose audio" onPress={() => pick('audio')} />
        </Section>
        <Section title="Audio bundle" body="A zip, or folio.json plus the audio, captions, and script it names.">
          <Button label="Choose bundle" onPress={() => pick('folio')} />
        </Section>
        <Section title="Link or article" body="Paste an EPUB link, a .zip bundle link, an article URL, or an X post.">
          <TextInput
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://"
            placeholderTextColor={palette.muted}
            style={{ borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper, color: palette.ink, borderRadius: 12, padding: 12 }}
          />
          <Button label="Fetch" onPress={fromUrl} />
        </Section>
        <Section title="Pair audio with a book" body="Copies the audio onto a book and turns on approximate read-along. Word-level sync needs a VTT.">
          <Text style={{ color: palette.muted }}>Book</Text>
          {books.map((item) => (
            <Choice key={item.id} label={item.title} active={bookId === item.id} onPress={() => setBookId(item.id)} />
          ))}
          <Text style={{ color: palette.muted, marginTop: 8 }}>Audio</Text>
          {audios.map((item) => (
            <Choice key={item.id} label={item.title} active={audioId === item.id} onPress={() => setAudioId(item.id)} />
          ))}
          <Button
            label="Link them"
            onPress={() => {
              if (!bookId || !audioId) {
                setError('Pick a book and an audio item.');
                return;
              }
              void run(async () => {
                const linked = await attachAudio(io, bookId, audioId);
                if (!linked) throw new Error('Those two items could not be linked.');
                return `${linked.title} now has that audio.`;
              });
            }}
          />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={{ backgroundColor: palette.paper, borderRadius: 16, padding: 16, gap: 10 }}>
      <Text style={{ color: palette.ink, fontSize: 20, fontFamily: 'Georgia' }}>{title}</Text>
      <Text style={{ color: palette.muted, lineHeight: 20 }}>{body}</Text>
      {children}
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable onPress={onPress} style={{ alignSelf: 'flex-start', backgroundColor: palette.accent, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 }}>
      <Text style={{ color: palette.paper, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

function Choice({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable onPress={onPress} style={{ paddingVertical: 8 }}>
      <Text style={{ color: active ? palette.accent : palette.ink }}>{active ? '● ' : '○ '}{label}</Text>
    </Pressable>
  );
}
