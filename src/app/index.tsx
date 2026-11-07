import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ItemMeta } from '@/components/ItemMeta';
import type { LibraryItem } from '@/lib/types';
import { useLibrary } from '@/state/library';
import { usePlayerActions } from '@/state/player';
import { usePalette } from '@/theme';

const FILTERS = ['All', 'Books', 'Articles'] as const;

function matches(item: LibraryItem, filter: (typeof FILTERS)[number]): boolean {
  if (filter === 'Books') {
    return item.kind === 'book' || item.kind === 'audiobook';
  }
  if (filter === 'Articles') {
    return item.kind === 'article';
  }
  return true;
}

export default function LibraryScreen() {
  const palette = usePalette();
  const { items, ready, status, error, refresh, remove } = useLibrary();
  const { playItem } = usePlayerActions();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const visible = useMemo(
    () => items.filter((item) => matches(item, filter)).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.createdAt - a.createdAt),
    [items, filter],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }} edges={['top', 'left', 'right']}>
      <View style={{ flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
          <Text style={{ color: palette.muted, fontSize: 13, letterSpacing: 1.2 }}>FOLIO</Text>
          <Text style={{ color: palette.ink, fontSize: 34, fontFamily: 'Georgia', marginTop: 2 }}>Your shelf</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <HeaderLink label="Add" onPress={() => router.push('/import')} palette={palette} filled />
            <HeaderLink label="Settings" onPress={() => router.push('/settings')} palette={palette} />
            <HeaderLink label="Credits" onPress={() => router.push('/credits')} palette={palette} />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
            {FILTERS.map((name) => (
              <Pressable key={name} onPress={() => setFilter(name)} style={{ backgroundColor: filter === name ? palette.ink : palette.chip, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: filter === name ? palette.paper : palette.ink, fontSize: 13 }}>{name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        {!ready ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 28, gap: 10 }}>
            <Text style={{ color: palette.ink, fontSize: 18, paddingHorizontal: 4 }}>Opening the shelf</Text>
            <Text style={{ color: palette.muted, marginTop: 4, marginBottom: 8, lineHeight: 22, paddingHorizontal: 4 }}>{status}</Text>
            <ShelfSkeleton />
            <ShelfSkeleton />
            <ShelfSkeleton />
          </View>
        ) : error ? (
          <View style={{ padding: 24 }}>
            <Text style={{ color: palette.ink, fontSize: 18 }}>The shelf did not open</Text>
            <Text style={{ color: palette.muted, marginTop: 8, lineHeight: 22 }}>{error}</Text>
            <Pressable onPress={() => refresh()} style={{ marginTop: 16, alignSelf: 'flex-start', backgroundColor: palette.accent, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 }}>
              <Text style={{ color: palette.paper, fontWeight: '600' }}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={visible}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28, gap: 10 }}
            ListEmptyComponent={
              <Text style={{ color: palette.muted, padding: 12, lineHeight: 22 }}>
                Nothing in this shelf yet. Add an EPUB, an article, or an audio file.
              </Text>
            }
            renderItem={({ item }) => (
              <ShelfCard
                item={item}
                onOpen={() => router.push({ pathname: '/read/[id]', params: { id: item.id } })}
                onListen={() => playItem(item.id, item.hasAudio ? 'audio' : 'narrate')}
                onRemove={() => confirmRemove(item.title, () => remove(item.id))}
              />
            )}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

function confirmRemove(title: string, onRemove: () => void) {
  const message = `Remove “${title}” from the shelf?`;
  if (Platform.OS === 'web') {
    if (window.confirm(message)) onRemove();
    return;
  }
  Alert.alert('Remove', message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: onRemove },
  ]);
}

function HeaderLink({
  label,
  onPress,
  palette,
  filled,
}: {
  label: string;
  onPress: () => void;
  palette: ReturnType<typeof usePalette>;
  filled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={{ backgroundColor: filled ? palette.accent : palette.chip, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}>
      <Text style={{ color: filled ? palette.paper : palette.ink, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

function ShelfSkeleton() {
  const palette = usePalette();
  return (
    <View style={{ backgroundColor: palette.paper, borderRadius: 16, padding: 14, flexDirection: 'row', gap: 12 }}>
      <View style={{ width: 54, height: 78, borderRadius: 6, backgroundColor: palette.chip }} />
      <View style={{ flex: 1, gap: 8, paddingTop: 4 }}>
        <View style={{ height: 10, width: 72, borderRadius: 4, backgroundColor: palette.chip }} />
        <View style={{ height: 18, width: '80%', borderRadius: 4, backgroundColor: palette.chip }} />
        <View style={{ height: 12, width: '50%', borderRadius: 4, backgroundColor: palette.chip }} />
        <View style={{ height: 3, borderRadius: 2, backgroundColor: palette.chip, marginTop: 6 }} />
      </View>
    </View>
  );
}

function ShelfCard({
  item,
  onOpen,
  onListen,
  onRemove,
}: {
  item: LibraryItem;
  onOpen: () => void;
  onListen: () => void;
  onRemove: () => void;
}) {
  const palette = usePalette();
  const { io } = useLibrary();
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => {
    if (!item.coverPath) return;
    io.uri(item.coverPath).then(setCover).catch(() => undefined);
  }, [io, item.coverPath]);
  const kind = item.collection || (item.kind === 'book' ? 'Book' : item.kind === 'article' ? 'Article' : item.kind === 'audiobook' ? 'Audiobook' : 'Audio');
  return (
    <Pressable onPress={onOpen} style={{ backgroundColor: palette.paper, borderRadius: 16, padding: 14, flexDirection: 'row', gap: 12 }}>
      {cover ? (
        <Image source={{ uri: cover }} style={{ width: 54, height: 78, borderRadius: 6, backgroundColor: palette.chip }} contentFit="cover" />
      ) : (
        <View style={{ width: 54, height: 78, borderRadius: 6, backgroundColor: palette.chip, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: palette.muted, fontSize: 11 }}>{item.hasAudio ? 'Listen' : 'Read'}</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.muted, fontSize: 11, letterSpacing: 0.6 }}>{kind.toUpperCase()}</Text>
        <Text style={{ color: palette.ink, fontSize: 18, fontFamily: 'Georgia', marginTop: 2 }} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={{ color: palette.muted, marginTop: 2 }} numberOfLines={1}>
          {item.author}
        </Text>
        <ItemMeta item={item} compact />
        <View style={{ height: 3, backgroundColor: palette.chip, borderRadius: 2, marginTop: 10 }}>
          <View style={{ width: `${Math.round(item.progress * 100)}%`, height: 3, backgroundColor: palette.accent, borderRadius: 2 }} />
        </View>
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 10 }}>
          <Text onPress={onListen} style={{ color: palette.accent, fontWeight: '600' }}>
            {item.hasAudio ? 'Listen' : 'Narrate'}
          </Text>
          <Text onPress={onOpen} style={{ color: palette.ink, fontWeight: '600' }}>
            {item.hasText ? 'Read' : 'Chapters'}
          </Text>
          <Text onPress={onRemove} style={{ color: palette.muted }}>
            Remove
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
