import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { NativeChat, buttons, parseAge, parseRange, isPartnerMessage } from '../src/nativeChat';

const chatId = '000000000000000000000001';
const mid = (n: number) => n.toString(16).padStart(24, '0');
const otherChat = '000000000000000000000002';
const until = async (check: () => boolean) => {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
};
test('validates adult ages, ordered ranges and populated sender echo suppression', () => {
  assert.equal(parseAge('17'), undefined); assert.equal(parseAge('101'), undefined); assert.equal(parseAge('25abc'), undefined);
  assert.equal(parseAge('25'), 25); assert.deepEqual(parseRange('18–35'), [18, 35]); assert.equal(parseRange('35-18'), undefined);
  assert.equal(isPartnerMessage({ _id: 'm', sender: { _id: 'me' } }, 'me'), false);
  assert.equal(isPartnerMessage({ _id: 'm', sender: 'them' }, 'me'), true);
});
test('real socket transport: onboarding, shared search, text, privacy, duplicate events, cancel race and restart', async () => {
  const dir = await mkdtemp(`${tmpdir()}/anoname-native-test-`);
  const app = express(); app.use(express.json());
  const server = createServer(app); const io = new Server(server);
  let current: any; let searchCount = 0; let cancelCount = 0; let ended = 0; let reports = 0; let suppressEnd = false;
  let activeChat: string | undefined; let searching = false;
  const history: any[] = []; let historyReads = 0; let lastHistoryChat = ''; let failDelivery = 0;
  const posted: any[] = []; const output: any[] = []; const voices: Buffer[] = []; const uploads: Buffer[] = [];
  app.post('/api/auth/bot/session', (req, res) => {
    assert.equal(req.headers['x-bot-secret'], 'test-secret');
    assert.deepEqual(req.body, { telegramId: 123 });
    res.json({ token: 'test-jwt', user: { id: 'me' } });
  });
  app.get('/api/chats/:id/messages', (req, res) => {
    historyReads++; lastHistoryChat = req.params.id;
    res.json(history.filter(m => m.chatId === req.params.id && m._id > String(req.query.after || '')).slice(0, 100));
  });
  app.post('/api/chats/:id/messages', (req, res) => { posted.push(req.body); res.json({ _id: 'saved' }); });
  app.get('/test-audio', (_req, res) => res.type('audio/ogg').send(Buffer.from('test-voice')));
  app.get('/api/media/voice/:id', (_req, res) => res.type('audio/mpeg').send(Buffer.from('incoming-voice')));
  app.post('/api/media/voice', express.raw({ type: 'multipart/form-data' }), (req, res) => { uploads.push(req.body); res.status(201).json({ message: { _id: 'voice' } }); });
  io.on('connection', socket => {
    current = socket;
    assert.equal(socket.handshake.auth.token, 'test-jwt');
    socket.emit('session:state', { activeChatId: activeChat, searchStatus: searching ? 'searching' : 'idle' });
    socket.on('search:start', data => { searchCount++; searching = true; assert.equal(data.criteria.age, 25); assert.deepEqual(data.criteria.desiredGender, ['any']); });
    socket.on('search:cancel', () => { cancelCount++; searching = false; socket.emit('search:status', { status: 'cancelled' }); });
    socket.on('chat:end', () => { ended++; activeChat = undefined; if (!suppressEnd) socket.emit('chat:ended', { chatId }); });
    socket.on('chat:report', () => { reports++; });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  const bot: any = { telegram: {
    getFileLink: async () => new URL(`http://127.0.0.1:${address.port}/test-audio`),
    sendVoice: async (_id: number, data: any) => { voices.push(data.source); return {}; },
    sendMessage: async (id: number, text: string, markup: any) => { if (text === 'retry-first' && failDelivery-- > 0) throw { response: { error_code: 429, parameters: { retry_after: 0.01 } } }; output.push({ id, text, markup }); return { message_id: output.length }; } } };
  const options = { apiUrl: `http://127.0.0.1:${address.port}`, secret: 'test-secret', webAppUrl: 'https://example.org', stateFile: `${dir}/state.json` };
  let native = new NativeChat(bot, options); await native.start();
  let updateId = 0;
  const send = async (text = '', data?: string, type = 'private', fixedId?: number) => {
    const ctx: any = { from: { id: 123, username: 'PRIVATE' }, chat: { id: 123, type }, update: { update_id: fixedId ?? ++updateId }, answerCbQuery: async () => {} };
    if (data) ctx.callbackQuery = { data }; else ctx.message = { text, message_id: updateId };
    let passed = false; await native.middleware()(ctx, async () => { passed = true; }); return passed;
  };
  const incoming = (data: any) => { if (!history.some(m => m._id === data.message._id)) history.push({ ...data.message, chatId: data.chatId }); current.emit('chat:message', data); };
  try {
    assert.equal(await send('/start', undefined, 'group'), true);
    await send('/start'); await send(buttons.find);
    assert.equal(searchCount, 0);
    await send('', 'nc:gender:male'); await send('', 'nc:age'); await send('17'); await send('25');
    await send(buttons.find); await send(buttons.find); await until(() => searchCount === 1);
    // Cancel before server confirms searching, then retry.
    await send(buttons.stop); await until(() => cancelCount === 1); await new Promise(r => setTimeout(r, 20));
    await send(buttons.find); await until(() => searchCount === 2);
    activeChat = chatId; searching = false;
    current.emit('search:matched', { matchedUser: { chatId, telegramId: 'PRIVATE', username: 'PRIVATE' } });
    await until(() => output.some(x => x.text.startsWith('Собеседник найден')));
    await send('Привет', undefined, 'private', 999); await send('Привет', undefined, 'private', 999);
    assert.deepEqual(posted, [{ content: 'Привет' }]);
    incoming({ chatId, message: { _id: mid(1), sender: 'me', content: 'own-echo' } });
    incoming({ chatId, message: { _id: mid(2), sender: { _id: 'them' }, content: '<b>Привет</b>' } });
    incoming({ chatId, message: { _id: mid(2), sender: 'them', content: '<b>Привет</b>' } });
    incoming({ chatId: otherChat, message: { _id: mid(3), sender: 'them', content: 'stale' } });
    await until(() => output.some(x => x.text === '<b>Привет</b>'));
    assert.equal(output.filter(x => x.text === '<b>Привет</b>').length, 1);
    assert.ok(!output.some(x => /own-echo|stale|PRIVATE/.test(x.text)));
    assert.equal(output.find(x => x.text === '<b>Привет</b>').markup.parse_mode, undefined);
    incoming({ chatId, message: { _id: mid(4), sender: 'them', type: 'voice' } });
    await until(() => voices.length === 1);
    assert.equal(voices[0].toString(), 'incoming-voice');
    await native.middleware()({ from: { id: 123 }, chat: { id: 123, type: 'private' }, update: { update_id: 1000 }, message: { message_id: 1000, voice: { file_id: 'test-file', duration: 2, file_size: 10 } } } as any, async () => {});
    assert.equal(uploads.length, 1); assert.ok(uploads[0].includes(Buffer.from('test-voice'))); assert.ok(uploads[0].includes(Buffer.from('tg-123-1000')));
    await send('', `nc:report:${otherChat}:spam`); assert.equal(reports, 0);
    await send('', `nc:report:${chatId}:spam`); await until(() => reports === 1);
    failDelivery = 3;
    incoming({ chatId, message: { _id: mid(5), sender: 'them', content: 'retry-first' } });
    incoming({ chatId, message: { _id: mid(6), sender: 'them', content: 'retry-second' } });
    await until(() => failDelivery === 0);
    assert.ok(!output.some(x => x.text === 'retry-second'));
    const cursorAfterFailure = JSON.parse(await readFile(options.stateFile, 'utf8'))[0][1].lastMessage;
    assert.equal(cursorAfterFailure, mid(4));
    await until(() => output.some(x => x.text === 'retry-second'));
    assert.deepEqual(output.filter(x => x.text.startsWith('retry-')).map(x => x.text), ['retry-first', 'retry-second']);
    await native.close();
    // More than a page arrives while the bot is offline.
    for (let n = 7; n <= 211; n++) history.push({ chatId, _id: mid(n), sender: 'them', content: `backlog-${n}` });
    const stored = await readFile(options.stateFile, 'utf8');
    assert.ok(!/test-jwt|test-secret|Привет|PRIVATE/.test(stored));
    native = new NativeChat(bot, options); await native.start();
    await until(() => output.filter(x => x.text.startsWith('backlog-')).length === 205);
    assert.deepEqual(output.filter(x => x.text.startsWith('backlog-')).map(x => x.text), Array.from({ length: 205 }, (_, i) => `backlog-${i + 7}`));
    assert.ok(historyReads >= 3);
    await send('После перезапуска'); assert.equal(posted.at(-1).content, 'После перезапуска');
    await send(buttons.next); await until(() => ended === 1 && searchCount === 3);
    current.emit('search:expired');
    await until(() => output.some(x => x.text.startsWith('Поиск завершился без совпадения')));
    await send(buttons.find); await until(() => searchCount === 4);
    // A voice download finishing after a chat switch must not target the new chat.
    lastHistoryChat = '';
    current.emit('session:state', { activeChatId: chatId });
    await until(() => lastHistoryChat === chatId);
    let started = false; let release!: () => void;
    bot.telegram.getFileLink = async () => { started = true; await new Promise<void>(r => { release = r; }); return new URL(`${options.apiUrl}/test-audio`); };
    const pendingVoice = native.middleware()({ from: { id: 123 }, chat: { id: 123, type: 'private' }, update: { update_id: 2000 }, message: { message_id: 2000, voice: { file_id: 'slow', duration: 2, file_size: 10 } } } as any, async () => {});
    await until(() => started);
    current.emit('session:state', { activeChatId: otherChat });
    await until(() => lastHistoryChat === otherChat);
    release(); await pendingVoice;
    assert.equal(uploads.length, 1, 'stale voice must not be uploaded to another chat');
    assert.ok(output.some(x => x.text.includes('Голосовое не отправлено')));
    // End reached API but acknowledgement was lost. Idle reconnect must clear stop.
    suppressEnd = true; searching = false;
    await send(buttons.stop); await until(() => ended === 2);
    const notices = output.filter(x => x.text.startsWith('Связь с чатом прервана')).length;
    current.disconnect(true);
    await until(() => output.filter(x => x.text.startsWith('Связь с чатом прервана')).length > notices);
    await send(buttons.find); await until(() => searchCount === 5);
  } finally {
    await native.close(); await new Promise<void>(resolve => io.close(() => resolve())); server.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('startup and local help stay responsive while restored accounts wait for unavailable API', async () => {
  const dir = await mkdtemp(`${tmpdir()}/anoname-startup-test-`);
  const stateFile = `${dir}/state.json`;
  await writeFile(stateFile, JSON.stringify(Array.from({ length: 9 }, (_, i) => [i + 1, {
    preferences: { gender: 'male', age: 25, desiredGender: 'any', desiredAgeMin: 18, desiredAgeMax: 100 }, active: true,
  }])));
  const app = express(); const waiting: any[] = []; let released = false; let requests = 0;
  app.post('/api/auth/bot/session', (_req, res) => {
    requests++; if (released) res.status(503).json({ error: 'offline' }); else waiting.push(res);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const output: string[] = [];
  const native = new NativeChat({ telegram: { sendMessage: async (_id: number, text: string) => { output.push(text); return {}; } } } as any, {
    apiUrl: `http://127.0.0.1:${(server.address() as any).port}`, secret: 'test', webAppUrl: '', stateFile,
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([native.start(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('startup blocked on remote API')), 1000); })]);
    clearTimeout(timeout);
    await until(() => requests === 4);
    await native.middleware()({ from: { id: 99 }, chat: { id: 99, type: 'private' }, update: { update_id: 3000 }, message: { text: '/help', message_id: 3000 } } as any, async () => {});
    assert.ok(output.some(text => text.startsWith('Anoname')));
    assert.equal(requests, 4, 'local help must not require API or release more background workers');
  } finally {
    clearTimeout(timeout); released = true;
    for (const response of waiting) response.status(503).json({ error: 'offline' });
    await native.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
