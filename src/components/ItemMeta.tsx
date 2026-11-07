import { Linking, Text, View } from 'react-native';

import { itemDateLabel } from '@/lib/playback';
import type { LibraryItem } from '@/lib/types';
import { usePalette } from '@/theme';

export function ItemMeta({ item, compact }: { item: LibraryItem; compact?: boolean }) {
  const palette = usePalette();
  const date = itemDateLabel(item);
  const sources = item.sources?.length ? item.sources : item.sourceUrl ? [item.sourceUrl] : [];
  if (!date && !item.note && !item.description && !sources.length) return null;
  return (
    <View style={{ gap: 2, marginTop: compact ? 4 : 2 }}>
      {date ? (
        <Text style={{ color: palette.muted, fontSize: 12 }} numberOfLines={compact ? 1 : 2}>
          {date}
        </Text>
      ) : null}
      {item.note ? (
        <Text style={{ color: palette.muted, fontSize: 12 }} numberOfLines={2}>
          {item.note}
        </Text>
      ) : null}
      {item.description && !item.description.startsWith('Kokoro narration') ? (
        <Text style={{ color: palette.muted, fontSize: 12 }} numberOfLines={compact ? 2 : 4}>
          {item.description}
        </Text>
      ) : null}
      {sources.map((url) => (
        <Text
          key={url}
          accessibilityRole="link"
          onPress={() => Linking.openURL(url)}
          style={{ color: palette.accent, fontSize: 12 }}
          numberOfLines={1}
        >
          {url}
        </Text>
      ))}
    </View>
  );
}
