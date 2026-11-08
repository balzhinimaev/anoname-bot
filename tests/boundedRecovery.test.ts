import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedRecovery } from '../src/boundedRecovery';

test('limits concurrent restoration and continues after failed accounts', async () => {
  let active = 0, peak = 0; const completed: number[] = [];
  await boundedRecovery(Array.from({ length: 17 }, (_, i) => i), async id => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--; completed.push(id);
    if (id % 3 === 0) throw new Error('API offline');
  }, 4);
  assert.equal(peak, 4); assert.equal(completed.length, 17);
});
test('shutdown prevents queued accounts from opening new connections', async () => {
  let stop = false; const started: number[] = [];
  await boundedRecovery([1, 2, 3, 4, 5, 6], async id => {
    started.push(id); await new Promise(resolve => setImmediate(resolve)); stop = true;
  }, 2, () => stop);
  assert.deepEqual(started, [1, 2]);
});
test('invalid worker limits cannot silently drop all recovery work', async () => {
  await assert.rejects(boundedRecovery([1], async () => {}, 0));
});
