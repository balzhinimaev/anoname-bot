/** Bounded independent work: one failed account must not block all other users. */
export async function boundedRecovery<T>(items: Iterable<T>, run: (item: T) => Promise<unknown>, concurrency = 4, stopped: () => boolean = () => false): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  const iterator = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!stopped()) {
      const item = iterator.next();
      if (item.done) return;
      try { await run(item.value); } catch { /* retried on the next recovery cycle */ }
    }
  }));
}
