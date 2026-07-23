import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseVersion } from '../lib/versioning.js';

test('release tags use the Android version-code scheme', () => {
  assert.deepEqual(parseReleaseVersion('v2.2.0'), {
    versionCode: 2_020_000,
    versionName: '2.2.0'
  });
  assert.deepEqual(parseReleaseVersion('2.1.73'), {
    versionCode: 2_010_073,
    versionName: '2.1.73'
  });
});

test('invalid release tags are rejected', () => {
  assert.equal(parseReleaseVersion('latest'), null);
  assert.equal(parseReleaseVersion('v2.100.0'), null);
  assert.equal(parseReleaseVersion('v2.2'), null);
});
