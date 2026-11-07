import assert from 'node:assert/strict';
import test from 'node:test';

import { readingVoices, usableVoice, type SystemVoice } from '../src/lib/voices';

const ios: SystemVoice[] = [
  { identifier: 'com.apple.speech.synthesis.voice.Albert', name: 'Albert', language: 'en-US', quality: 'Default' },
  { identifier: 'com.apple.speech.synthesis.voice.BadNews', name: 'Bad News', language: 'en-US', quality: 'Default' },
  { identifier: 'com.apple.speech.synthesis.voice.Bahh', name: 'Bahh', language: 'en-US', quality: 'Default' },
  { identifier: 'com.apple.eloquence.en-GB.Eddy', name: 'Eddy', language: 'en-GB', quality: 'Default' },
  { identifier: 'com.apple.eloquence.en-US.Eddy', name: 'Eddy', language: 'en-US', quality: 'Default' },
  { identifier: 'com.apple.eloquence.en-US.Grandma', name: 'Grandma', language: 'en-US', quality: 'Default' },
  { identifier: 'com.apple.voice.compact.en-AU.Karen', name: 'Karen', language: 'en-AU', quality: 'Default' },
  { identifier: 'com.apple.voice.compact.en-GB.Daniel', name: 'Daniel', language: 'en-GB', quality: 'Default' },
  { identifier: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US', quality: 'Default' },
  { identifier: 'com.apple.voice.enhanced.en-US.Samantha', name: 'Samantha', language: 'en-US', quality: 'Enhanced' },
  { identifier: 'com.apple.voice.premium.en-GB.Malcolm', name: 'Malcolm', language: 'en-GB', quality: 'Default' },
  { identifier: 'com.apple.voice.compact.fr-FR.Thomas', name: 'Thomas', language: 'fr-FR', quality: 'Default' },
];

test('iOS reading voices skip novelty and Eloquence voices and put the best first', () => {
  const picked = readingVoices(ios);
  assert.deepEqual(
    picked.map((voice) => voice.label),
    ['Malcolm · GB · Premium', 'Samantha · US · Enhanced', 'Samantha · US', 'Daniel · GB', 'Karen · AU'],
  );
  assert.ok(picked.every((voice) => !voice.identifier.includes('eloquence') && !voice.identifier.includes('speech.synthesis')));
});

test('the saved voice stays in the list even when it would be filtered or cut', () => {
  const picked = readingVoices(ios, 'com.apple.eloquence.en-GB.Eddy', 2);
  assert.equal(picked.length, 3);
  assert.equal(picked[2].identifier, 'com.apple.eloquence.en-GB.Eddy');
});

test('Android voice names that already carry the locale are not repeated, and local voices come before network ones', () => {
  const picked = readingVoices([
    { identifier: 'en-us-x-sfg-network', name: 'en-us-x-sfg-network', language: 'en-US', quality: 'Enhanced' },
    { identifier: 'en-gb-x-gba-local', name: 'en-gb-x-gba-local', language: 'en-GB', quality: 'Enhanced' },
    { identifier: 'en-us-x-sfg-local', name: 'en-us-x-sfg-local', language: 'en-US', quality: 'Enhanced' },
  ]);
  assert.deepEqual(
    picked.map((voice) => voice.label),
    ['en-us-x-sfg-local', 'en-gb-x-gba-local', 'en-us-x-sfg-network'],
  );
});

test('a saved voice that is no longer on the device is dropped before speaking', () => {
  assert.equal(usableVoice(ios, 'com.apple.voice.compact.en-US.Samantha'), 'com.apple.voice.compact.en-US.Samantha');
  assert.equal(usableVoice(ios, 'com.apple.voice.premium.en-US.Zoe'), undefined);
  assert.equal(usableVoice(ios, undefined), undefined);
  assert.equal(usableVoice([], 'com.apple.voice.premium.en-US.Zoe'), 'com.apple.voice.premium.en-US.Zoe');
});
