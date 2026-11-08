import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramDelivery } from '../src/telegramDelivery';

test('honors Telegram retry_after and preserves one successful result', async () => {
  let attempts = 0; const delays: number[] = [];
  const result = await telegramDelivery(async () => {
    if (++attempts < 3) throw { response: { error_code: 429, parameters: { retry_after: 2 } } };
    return 'ok';
  }, { sleep: async ms => { delays.push(ms); } });
  assert.equal(result, 'ok'); assert.equal(attempts, 3); assert.deepEqual(delays, [2000, 2000]);
});
test('permanent errors do not loop; long flood hold is delegated to recovery', async () => {
  for (const response of [{ error_code: 403 }, { error_code: 400 }, { error_code: 429, parameters: { retry_after: 120 } }]) {
    let attempts = 0;
    await assert.rejects(telegramDelivery(async () => { attempts++; throw { response }; }, { sleep: async () => { assert.fail('must not sleep'); } }));
    assert.equal(attempts, 1);
  }
});
test('a chat switch cancels a queued retry rather than sending stale content', async () => {
  let valid = true, attempts = 0;
  const result = await telegramDelivery(async () => { attempts++; throw new Error('connection reset'); }, {
    valid: () => valid, sleep: async () => { valid = false; },
  });
  assert.equal(result, undefined); assert.equal(attempts, 1);
});
test('transient retries are bounded', async () => {
  let attempts = 0;
  await assert.rejects(telegramDelivery(async () => { attempts++; throw new Error('offline'); }, { sleep: async () => {} }));
  assert.equal(attempts, 3);
});
