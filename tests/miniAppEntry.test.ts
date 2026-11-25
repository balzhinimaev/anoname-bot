import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMiniAppEntry, buildMiniAppUrl, hasBotToken, installMiniAppMenu,
  normalizeMiniAppUrl, parseStartPayload, telegramErrorStatus,
} from '../src/miniAppEntry';

const webAppUrl = 'https://anoname.ru/miniapp/app';
// Format-only fixture; no request in these tests reaches Telegram.
const token = `123456789:${'x'.repeat(35)}`;

test('launch preserves existing query/fragment and properly encodes referral parameters', () => {
  const result = buildMiniAppUrl(`${webAppUrl}?source=bot&exp=old#chat`, 'B', 'friend&exp=A');
  const parsed = new URL(result!);
  assert.equal(parsed.pathname, '/miniapp/app');
  assert.equal(parsed.searchParams.get('source'), 'bot');
  assert.deepEqual(parsed.searchParams.getAll('exp'), ['B']);
  assert.equal(parsed.searchParams.get('ref'), 'friend&exp=A');
  assert.equal(parsed.hash, '#chat');
});

test('private entry is a WebApp button with existing referral and experiment flow', () => {
  const payload = 'friend__campaign';
  const entry = buildMiniAppEntry({ webAppUrl, chatType: 'private', payload, variant: 'A' });
  const button: any = entry.reply_markup?.inline_keyboard[0][0];
  assert.equal(button.text, 'Открыть Anoname');
  assert.equal(new URL(button.web_app.url).searchParams.get('ref'), 'friend');
  assert.equal(new URL(button.web_app.url).searchParams.get('exp'), 'A');
  assert.deepEqual(parseStartPayload(payload), { referralCode: 'friend', campaign: 'campaign' });
  assert.doesNotMatch(entry.text, /\$50|из 200|элит|розыгрыш/i);
});

test('group entry never emits private-only WebApp button and retains valid start payload', () => {
  for (const chatType of ['group', 'supergroup', 'channel', undefined]) {
    const entry = buildMiniAppEntry({ webAppUrl, chatType, botUsername: 'anoname_bot', payload: 'friend__campaign' });
    const button: any = entry.reply_markup?.inline_keyboard[0][0];
    assert.equal(button.web_app, undefined);
    assert.equal(button.url, 'https://t.me/anoname_bot?start=friend__campaign');
    assert.match(entry.text, /личный чат/);
  }
});

test('group fallback accepts only a bot username and valid Telegram start payload', () => {
  assert.equal(buildMiniAppEntry({ chatType: 'group', botUsername: 'bad/redirect' }).reply_markup, undefined);
  const entry = buildMiniAppEntry({ chatType: 'group', botUsername: '@anoname_bot', payload: 'bad&payload' });
  assert.equal((entry.reply_markup!.inline_keyboard[0][0] as any).url, 'https://t.me/anoname_bot');
});

test('unconfigured and insecure launch URLs fail closed without placeholder buttons', () => {
  for (const invalid of [undefined, '', '/miniapp/app', 'http://anoname.ru', 'javascript:alert(1)', 'https://name:password@anoname.ru']) {
    assert.equal(normalizeMiniAppUrl(invalid), undefined);
    assert.equal(buildMiniAppUrl(invalid, 'A'), undefined);
    const entry = buildMiniAppEntry({ webAppUrl: invalid, chatType: 'private' });
    assert.equal(entry.reply_markup, undefined);
    assert.match(entry.text, /временно недоступно/);
  }
});

test('default menu registration needs both a configured token and an HTTPS launch URL', async () => {
  const calls: unknown[] = [];
  const telegram = { setChatMenuButton: async (value: unknown) => { calls.push(value); return true; } };
  assert.equal(hasBotToken(token), true);
  for (const invalidToken of [undefined, '', 'replace-me', '123:short']) {
    assert.equal(await installMiniAppMenu(telegram, invalidToken, webAppUrl), 'skipped');
  }
  assert.equal(await installMiniAppMenu(telegram, token, 'http://anoname.ru'), 'skipped');
  assert.equal(calls.length, 0);
  assert.equal(await installMiniAppMenu(telegram, token, webAppUrl), 'installed');
  assert.deepEqual(calls, [{ menuButton: { type: 'web_app', text: 'Открыть Anoname', web_app: { url: webAppUrl } } }]);
});

test('startup error details cannot expose request credentials', () => {
  const error = Object.assign(new Error(`Failed https://api.telegram.org/bot${token}/setChatMenuButton`), {
    response: { error_code: 401, description: token },
  });
  assert.equal(telegramErrorStatus(error), 'Telegram HTTP 401');
  assert.doesNotMatch(telegramErrorStatus(new Error(token)), /123456789/);
  assert.doesNotMatch(telegramErrorStatus({ response: { error_code: token } }), /123456789/);
});
