/** Retry transient Telegram transport failures, honoring server-side flood control.
 * Never retry permanent 4xx errors. Network timeouts can still be ambiguous;
 * Telegram offers no idempotency key for sendMessage/sendVoice. */
export async function telegramDelivery<T>(
  send: () => Promise<T>,
  options: { sleep?: (ms: number) => Promise<void>; attempts?: number; valid?: () => boolean } = {},
): Promise<T | undefined> {
  const sleep = options.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < (options.attempts || 3); attempt++) {
    if (options.valid && !options.valid()) return;
    try { return await send(); }
    catch (error) {
      const response = (error as any)?.response;
      const code = Number(response?.error_code || (error as any)?.code);
      const retryAfter = Number(response?.parameters?.retry_after);
      if ((code >= 400 && code < 500 && code !== 429) || attempt + 1 >= (options.attempts || 3)) throw error;
      // Long flood holds should not occupy a webhook handler. Caller retries later.
      if (code === 429 && retryAfter > 30) throw error;
      const delay = code === 429 && Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000 : Math.min(500 * 2 ** attempt, 5000);
      await sleep(delay);
    }
  }
}
