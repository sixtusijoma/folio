import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

export async function loadAsset(moduleId: number): Promise<Uint8Array> {
  const asset = Asset.fromModule(moduleId);
  if (!asset.localUri) {
    await asset.downloadAsync();
  }
  const uri = asset.localUri ?? asset.uri;
  // fetch on Android does not decode a file:// path, and Expo Go keeps assets in a percent-encoded folder.
  if (Platform.OS === 'android' && uri.startsWith('file:')) {
    return new File(uri).bytes();
  }
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error('A starter file could not be read.');
  }
  return new Uint8Array(await response.arrayBuffer());
}
