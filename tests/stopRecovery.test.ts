import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { NativeChat, buttons } from '../src/nativeChat';
const until = async (condition: () => boolean) => {
  const end = Date.now() + 3000;
  while (!condition()) { if (Date.now() >= end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
};
for (const restored of ['searching', 'chat', 'idle']) test(`offline stop survives restart with server ${restored}`, async () => {
  const dir = await mkdtemp(`${tmpdir()}/anoname-stop-`);
  const stateFile = `${dir}/state.json`; let online = false, cancelled = 0, ended = 0, searched = 0;
  const app = express(); app.use(express.json());
  app.post('/api/auth/bot/session', (_req, res) => online
    ? res.json({ token: 'test', user: { id: 'me', gender: 'male', age: 25 } })
    : res.status(503).json({ error: 'offline' }));
  app.get('/api/chats/:id/messages', (_req, res) => res.json([]));
  const server = createServer(app); const io = new Server(server);
  const chatId = '000000000000000000000001';
  io.on('connection', socket => {
    socket.emit('session:state', { searchStatus: restored === 'searching' ? 'searching' : 'idle', activeChatId: restored === 'chat' ? chatId : undefined });
    socket.on('search:cancel', () => { cancelled++; socket.emit('search:status', { status: 'cancelled' }); });
    socket.on('chat:end', data => { assert.equal(data.chatId, chatId); ended++; socket.emit('chat:ended', { chatId }); });
    socket.on('search:start', () => { searched++; });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const output: string[] = [];
  const bot: any = { telegram: { sendMessage: async (_id: number, text: string) => { output.push(text); return {}; } } };
  const options = { apiUrl: `http://127.0.0.1:${(server.address() as any).port}`, secret: 'test', webAppUrl: '', stateFile };
  let native = new NativeChat(bot, options);
  try {
    await native.start();
    await native.middleware()({ from: { id: 123 }, chat: { id: 123, type: 'private' }, update: { update_id: 1 }, message: { text: buttons.stop, message_id: 1 } } as any, async () => {});
    const saved = JSON.parse(await readFile(stateFile, 'utf8'))[0][1];
    assert.equal(saved.stopping, true); assert.equal(saved.active, true); assert.equal(saved.next, false);
    assert.ok(output.some(text => text.startsWith('Остановка сохранена')));
    await native.close();
    online = true; native = new NativeChat(bot, options); await native.start();
    await until(() => output.some(text => text === (restored === 'chat' ? 'Разговор завершён.' : restored === 'searching' ? 'Поиск остановлен.' : 'Поиск и разговор остановлены.')));
    assert.equal(ended, restored === 'chat' ? 1 : 0);
    assert.equal(cancelled, restored === 'searching' ? 1 : 0);
    await native.close();
    const after = JSON.parse(await readFile(stateFile, 'utf8'))[0][1];
    assert.equal(after.stopping, false); assert.equal(after.next, false); assert.equal(searched, 0);
  } finally {
    await native.close(); await new Promise<void>(resolve => io.close(() => resolve())); server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
