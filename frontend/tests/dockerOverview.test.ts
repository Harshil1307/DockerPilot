import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerStoragePercent, formatDockerBytes } from '../src/lib/dockerOverview';

test('Docker byte formatting uses readable binary units and distinguishes unavailable from zero', () => {
  assert.equal(formatDockerBytes(0), '0 B');
  assert.equal(formatDockerBytes(1024), '1 KB');
  assert.equal(formatDockerBytes(1024 ** 3), '1 GB');
  assert.equal(formatDockerBytes(null), 'Unavailable');
  assert.equal(formatDockerBytes(Number.NaN), 'Unavailable');
});

test('storage chart percentages require an available positive total and stay within bounds', () => {
  assert.equal(dockerStoragePercent(25, 100), 25);
  assert.equal(dockerStoragePercent(250, 100), 100);
  assert.equal(dockerStoragePercent(0, 100), 0);
  assert.equal(dockerStoragePercent(null, 100), null);
  assert.equal(dockerStoragePercent(25, null), null);
  assert.equal(dockerStoragePercent(25, 0), null);
});
