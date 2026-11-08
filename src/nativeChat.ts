import { Context, Markup, Telegraf } from 'telegraf';
import { io, Socket } from 'socket.io-client';
import { promises as fs } from 'fs';
import path from 'path';
import { telegramDelivery } from './telegramDelivery';
import { boundedRecovery } from './boundedRecovery';

export const buttons = {
  find: '🔎 Найти собеседника', stop: '⏹ Остановить', next: '⏭ Следующий',
  settings: '⚙️ Настройки поиска', profile: '👤 Собеседник', report: '🚩 Пожаловаться',
  topic: '💡 Тема для разговора', app: '🌐 Открыть приложение',
};
type Gender = 'male' | 'female';
export interface Preferences { gender?: Gender; age?: number; desiredGender: 'male' | 'female' | 'any'; desiredAgeMin: number; desiredAgeMax: number }
interface Stored { stopping?: boolean; next?: boolean; preferences: Preferences; active: boolean; lastMessage?: string; chatId?: string }
interface Session extends Stored {
  id: number; token?: string; userId?: string; socket?: Socket; ready?: Promise<void>; connecting?: Promise<void>; history?: Promise<void>; historyAgain?: boolean; recovery?: NodeJS.Timeout; retryAt?: number; blocked?: boolean;
  state: 'idle' | 'searching' | 'chat'; next?: boolean; stopping?: boolean;
  input?: 'age' | 'range'; seen: Set<string>; output: Promise<unknown>; touched: number;
}
interface Options { apiUrl: string; secret: string; webAppUrl: string; stateFile: string }
export const defaults = (): Preferences => ({ desiredGender: 'any', desiredAgeMin: 18, desiredAgeMax: 100 });
export function parseAge(text: string): number | undefined {
  return /^\d{2,3}$/.test(text.trim()) && Number(text) >= 18 && Number(text) <= 100 ? Number(text) : undefined;
}
export function parseRange(text: string): [number, number] | undefined {
  const match = text.trim().match(/^(\d{2,3})\s*[-– ]\s*(\d{2,3})$/);
  if (!match) return;
  const low = parseAge(match[1]), high = parseAge(match[2]);
  return low && high && low <= high ? [low, high] : undefined;
}
export function isPartnerMessage(message: any, userId?: string): boolean {
  const sender = typeof message?.sender === 'object' ? message.sender?._id : message?.sender;
  return Boolean(message?._id && userId && String(sender) !== userId);
}

/** A normal API/Socket.IO client. Never forwards Telegram messages or Telegram identity. */
export class NativeChat {
  private sessions = new Map<number, Session>();
  private locks = new Map<number, Promise<unknown>>();
  private updates = new Set<number>();
  private writes: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closing = false;
  private maintenance?: Promise<void>;
  constructor(private bot: Telegraf<Context>, private options: Options) {}

  private session(id: number): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = { id, preferences: defaults(), active: false, state: 'idle', seen: new Set(), output: Promise.resolve(), touched: Date.now() };
      this.sessions.set(id, session);
    }
    session.touched = Date.now();
    return session;
  }
  private save(): Promise<unknown> {
    // No JWTs, Telegram tokens, message bodies or partner identities persisted.
    this.writes = this.writes.catch(() => {}).then(async () => {
      const values = [...this.sessions.values()].map(s => [s.id, { preferences: s.preferences, active: s.active || s.stopping || s.next || false, stopping: s.stopping === true, next: s.next === true, chatId: s.chatId, lastMessage: s.lastMessage }]);
      await fs.mkdir(path.dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(`${this.options.stateFile}.tmp`, JSON.stringify(values), { mode: 0o600 });
      await fs.rename(`${this.options.stateFile}.tmp`, this.options.stateFile);
    });
    return this.writes;
  }
  async start() {
    try {
      const values: [number, Stored][] = JSON.parse(await fs.readFile(this.options.stateFile, 'utf8'));
      for (const [id, data] of values) {
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        if (!data || typeof data !== 'object' || !data.preferences) throw new Error('Invalid state');
        const prefs = data.preferences;
        const session = this.session(id);
        session.preferences = {
          ...defaults(),
          gender: prefs.gender === 'male' || prefs.gender === 'female' ? prefs.gender : undefined,
          age: parseAge(String(prefs.age || '')),
          desiredGender: ['male', 'female', 'any'].includes(prefs.desiredGender) ? prefs.desiredGender : 'any',
          desiredAgeMin: parseRange(`${prefs.desiredAgeMin}-${prefs.desiredAgeMax}`)?.[0] || 18,
          desiredAgeMax: parseRange(`${prefs.desiredAgeMin}-${prefs.desiredAgeMax}`)?.[1] || 100,
        };
        session.stopping = data.stopping === true || data.next === true;
        session.next = data.next === true;
        session.active = data.active === true || session.stopping;
        session.chatId = /^[a-f0-9]{24}$/i.test(data.chatId || '') ? data.chatId : undefined;
        session.lastMessage = /^[a-f0-9]{24}$/i.test(data.lastMessage || '') ? data.lastMessage : undefined;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Native chat state could not be loaded');
    }
    // Load local state before accepting updates, but never wait for remote accounts.
    void this.recover();
    this.timer = setInterval(() => { void this.recover(); }, 30_000);
    this.timer.unref();
  }
  private recover(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.maintenance) return this.maintenance;
    const sessions = [...this.sessions.values()];
    this.maintenance = boundedRecovery(sessions, async s => {
      if ((s.active || s.stopping) && !s.blocked) {
        if (s.stopping && s.socket?.connected) {
          s.socket.removeAllListeners(); s.socket.disconnect(); s.ready = undefined;
        }
        await (s.socket?.connected ? this.history(s) : this.connect(s));
      } else if (s.socket && s.state === 'idle' && Date.now() - s.touched > 10 * 60_000) {
        s.socket.removeAllListeners(); s.socket.disconnect(); s.socket = undefined; s.ready = undefined;
      }
    }, 4, () => this.closing).finally(() => { this.maintenance = undefined; });
    return this.maintenance;
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const s of this.sessions.values()) { clearTimeout(s.recovery); s.socket?.removeAllListeners(); s.socket?.disconnect(); }
    await Promise.allSettled([...this.sessions.values()].flatMap(s => [s.history, s.connecting, s.output].filter(Boolean) as Promise<unknown>[]));
    await this.maintenance;
    await this.save();
  }
  private keyboard(s: Session) {
    return Markup.keyboard(s.state === 'chat' ? [
      [buttons.next, buttons.stop], [buttons.profile, buttons.report], [buttons.topic, buttons.app],
    ] : s.state === 'searching' ? [[buttons.stop], [buttons.settings, buttons.app]] : [
      [buttons.find], [buttons.settings, buttons.app],
    ]).resize();
  }
  private output<T>(s: Session, send: () => Promise<T>, valid: () => boolean = () => true) {
    const result = s.output.catch(() => {}).then(() => telegramDelivery(send, {
      valid: () => !this.closing && !s.blocked && valid(),
    })).catch(error => {
      if ((error as any)?.response?.error_code === 403) {
        s.blocked = true; s.active = false; s.socket?.disconnect();
        void this.save().catch(() => {});
      }
      throw error;
    });
    s.output = result.catch(() => {});
    return result;
  }
  private tell(s: Session, text: string, markup: any = this.keyboard(s), valid?: () => boolean) {
    return this.output(s, () => this.bot.telegram.sendMessage(s.id, text, markup), valid);
  }
  private async request(s: Session, endpoint: string, init: RequestInit = {}) {
    const response = await fetch(`${this.options.apiUrl.replace(/\/$/, '')}${endpoint}`, {
      ...init, headers: { ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      throw new Error(typeof body.error === 'string' ? body.error : 'Сервис временно недоступен. Попробуйте ещё раз.');
    }
    return response;
  }
  private connect(s: Session): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Shutting down'));
    if (s.connecting) return s.connecting;
    if (s.socket?.connected && s.ready) return s.ready;
    s.connecting = this.open(s).catch(error => {
      s.socket?.disconnect(); s.socket = undefined; s.ready = undefined;
      throw error;
    }).finally(() => { s.connecting = undefined; });
    s.ready = s.connecting;
    return s.connecting;
  }
  private async open(s: Session) {
    s.socket?.removeAllListeners(); s.socket?.disconnect();
    const response = await this.request(s, '/api/auth/bot/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': this.options.secret },
      body: JSON.stringify({ telegramId: s.id }),
    });
    const auth: any = await response.json();
    if (this.closing) return;
    s.token = auth.token; s.userId = auth.user.id;
    s.preferences.gender ??= auth.user.gender === 'male' || auth.user.gender === 'female' ? auth.user.gender : undefined;
    s.preferences.age ??= auth.user.age;
    const socket = io(this.options.apiUrl, { auth: { token: s.token }, transports: ['websocket'], autoConnect: false, forceNew: true, reconnectionAttempts: 10 });
    s.socket = socket;
    const event = (name: string, fn: (data: any) => Promise<unknown> | unknown) => socket.on(name, data => {
      Promise.resolve().then(() => { if (!this.closing && s.socket === socket) return fn(data); }).catch(() => { console.warn('[native_chat] Event handling failed:', name); });
    });
    event('session:state', async data => {
      const oldChat = s.chatId;
      s.chatId = data.activeChatId;
      s.state = s.chatId ? 'chat' : data.searchStatus === 'searching' ? 'searching' : 'idle';
      s.active = s.state !== 'idle';
      s.ready = Promise.resolve();
      if (s.stopping) void this.reconcileStop(s).catch(() => {});
      if (s.chatId) {
        if (oldChat !== s.chatId) { s.lastMessage = undefined; s.retryAt = undefined; }
        socket.emit('chat:join', s.chatId);
        void this.history(s).catch(() => {});
      }
      await this.save();
    });
    event('search:matched', async data => {
      const chatId = data.matchedUser?.chatId;
      if (!chatId || s.chatId === chatId) return;
      s.chatId = chatId; s.lastMessage = undefined; s.retryAt = undefined; s.state = 'chat'; s.active = true;
      socket.emit('chat:join', chatId);
      if (s.stopping) { socket.emit('chat:end', { chatId }); return; }
      await this.save();
      void this.history(s).catch(() => {});
      await this.tell(s, 'Собеседник найден! Пишите сюда — сообщения попадут в общий чат. Имя и ссылка на ваш Telegram не передаются.');
    });
    event('search:status', async data => {
      if (s.chatId || data.status === 'matched') return;
      s.state = data.status === 'searching' ? 'searching' : 'idle'; s.active = s.state !== 'idle';
      if (data.status === 'cancelled' || data.status === 'expired') s.stopping = false;
      await this.save();
      await this.tell(s, s.state === 'searching' ? 'Ищем собеседника…' : 'Поиск остановлен.');
    });
    event('search:expired', async () => {
      if (s.chatId) return;
      s.state = 'idle'; s.active = false; s.stopping = false; s.next = false;
      await this.save(); await this.tell(s, 'Поиск завершился без совпадения. Попробуйте ещё раз.');
    });
    event('chat:partner_status', data => {
      if (data.chatId === s.chatId) return this.tell(s, data.status === 'offline' ? 'Собеседник потерял связь. Ждём возвращения…' : 'Собеседник снова на связи.');
    });
    event('chat:message', data => { if (data.chatId === s.chatId) return this.history(s); });
    event('chat:ended', async data => {
      if (data.chatId !== s.chatId) return;
      const ended = s.chatId;
      s.chatId = undefined; s.lastMessage = undefined; s.state = 'idle'; s.active = false; s.stopping = false;
      await this.save();
      await this.tell(s, 'Разговор завершён.', Markup.inlineKeyboard([1, 2, 3, 4, 5].map(n => Markup.button.callback(`${n} ⭐`, `nc:rate:${ended}:${n}`))));
      if (s.next) { s.next = false; await this.search(s); }
      else await this.tell(s, 'Можно найти нового собеседника.');
    });
    for (const name of ['error', 'search:error', 'search:limit', 'search:cancel_error']) event(name, async data => {
      s.next = false; s.stopping = false;
      if ((name === 'search:error' || name === 'search:limit') && !s.chatId) { s.state = 'idle'; s.active = false; await this.save(); }
      await this.tell(s, data.message || 'Не удалось выполнить действие. Попробуйте ещё раз.');
    });
    event('report:submitted', () => this.tell(s, 'Жалоба отправлена модераторам.'));
    event('chat:rated', () => this.tell(s, 'Оценка сохранена.'));
    event('game:invite', () => this.tell(s, 'Собеседник приглашает в игру. Откройте приложение для участия.'));
    event('disconnect', () => { s.ready = undefined; if (s.active) return this.tell(s, 'Связь с чатом прервана. Восстанавливаю соединение…'); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Не удалось подключиться к чату. Попробуйте ещё раз.')); }, 15_000);
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Чат временно недоступен. Попробуйте ещё раз.')); };
      const cleanup = () => { clearTimeout(timer); socket.off('session:state', ready); socket.off('connect_error', failed); };
      socket.once('session:state', ready); socket.once('connect_error', failed); socket.connect();
    });
  }
  private history(s: Session): Promise<void> {
    if (this.closing || s.blocked || !s.chatId || (s.retryAt || 0) > Date.now()) return Promise.resolve();
    if (s.history) { s.historyAgain = true; return s.history; }
    clearTimeout(s.recovery);
    s.history = (async () => {
      do {
        s.historyAgain = false;
        const chatId = s.chatId;
        if (!chatId || this.closing) return;
        // Always ascending from a confirmed cursor, including the first page.
        // Live events only wake this reader; they cannot overtake older history.
        let more = true;
        while (more && s.chatId === chatId && !this.closing && !s.blocked) {
          const cursor = s.lastMessage || '000000000000000000000000';
          const response = await this.request(s, `/api/chats/${chatId}/messages?limit=100&after=${encodeURIComponent(cursor)}`);
          const body: any = await response.json();
          const messages: any[] = Array.isArray(body) ? body : body.messages || [];
          if (s.chatId !== chatId) break;
          for (const message of messages) {
            if (this.closing || s.blocked) return;
            if (s.chatId !== chatId) { s.historyAgain = true; break; }
            const id = String(message._id || '');
            if (!/^[a-f0-9]{24}$/i.test(id) || id <= cursor) continue;
            if (isPartnerMessage(message, s.userId) && !s.seen.has(id)) {
              if (message.type === 'voice') {
                const audio = await this.request(s, `/api/media/voice/${id}`);
                const buffer = Buffer.from(await audio.arrayBuffer());
                await this.output(s, () => this.bot.telegram.sendVoice(s.id, { source: buffer, filename: 'voice.mp3' }, { protect_content: true }), () => s.chatId === chatId);
              } else if (typeof message.content === 'string' && message.content) {
                await this.tell(s, message.content, { protect_content: true }, () => s.chatId === chatId);
              }
              if (this.closing || s.blocked) return;
              if (s.chatId !== chatId) { s.historyAgain = true; break; }
              s.seen.add(id);
              if (s.seen.size > 1000) s.seen.delete(s.seen.values().next().value!);
            }
            // Cursor cannot pass a failed delivery. Own echoes still advance it.
            s.lastMessage = id;
            await this.save();
          }
          more = messages.length === 100 && s.lastMessage !== cursor;
        }
      } while (s.historyAgain && !this.closing);
    })().catch(error => {
      if (!this.closing && s.chatId && !s.blocked) {
        const retry = Number((error as any)?.response?.parameters?.retry_after);
        const delay = Math.max(2000, Number.isFinite(retry) ? retry * 1000 : 2000);
        s.retryAt = Date.now() + delay;
        s.recovery = setTimeout(() => { s.retryAt = undefined; void this.history(s).catch(() => {}); }, delay);
        s.recovery.unref();
      }
      throw error;
    }).finally(() => { s.history = undefined; });
    return s.history;
  }
  private async settings(s: Session) {
    const p = s.preferences;
    await this.tell(s, `Настройки поиска\nВаш пол: ${p.gender === 'male' ? 'мужской' : p.gender === 'female' ? 'женский' : 'не указан'}\nВаш возраст: ${p.age || 'не указан'}\nИщем: ${p.desiredGender === 'any' ? 'всех' : p.desiredGender === 'male' ? 'мужчин' : 'женщин'}, ${p.desiredAgeMin}–${p.desiredAgeMax} лет.\nФильтры применяются с учётом правил вашего аккаунта.`, Markup.inlineKeyboard([
      [Markup.button.callback('Я мужчина', 'nc:gender:male'), Markup.button.callback('Я женщина', 'nc:gender:female')],
      [Markup.button.callback('Мой возраст', 'nc:age'), Markup.button.callback('Возраст собеседника', 'nc:range')],
      [Markup.button.callback('Ищу мужчин', 'nc:desired:male'), Markup.button.callback('Ищу женщин', 'nc:desired:female'), Markup.button.callback('Всех', 'nc:desired:any')],
      [Markup.button.callback('🔎 Искать', 'nc:find')],
    ]));
  }
  private async reconcileStop(s: Session) {
    if (!s.stopping || this.closing || !s.socket?.connected) return;
    if (s.chatId) s.socket.emit('chat:end', { chatId: s.chatId });
    else if (s.state === 'searching') {
      s.next = false; await this.save(); s.socket.emit('search:cancel');
    } else {
      const resumeNext = s.next;
      s.stopping = false; s.next = false;
      await this.save();
      if (resumeNext) await this.search(s);
      else await this.tell(s, 'Поиск и разговор остановлены.');
    }
  }
  private async search(s: Session) {
    await this.connect(s);
    if (s.stopping) return this.tell(s, 'Завершаю предыдущее действие…');
    if (s.state === 'chat') return this.tell(s, 'Вы уже общаетесь. Для смены собеседника нажмите «Следующий».');
    if (s.state === 'searching') return this.tell(s, 'Поиск уже идёт.');
    if (!s.preferences.gender || !s.preferences.age) return this.settings(s);
    s.stopping = false; s.active = true; s.state = 'searching';
    await this.save();
    s.socket!.emit('search:start', { criteria: { ...s.preferences, desiredGender: [s.preferences.desiredGender], useGeolocation: false } });
  }
  middleware() {
    return async (ctx: Context, next: () => Promise<void>) => {
      if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return next();
      const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
      const callback = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
      if (callback && !callback.startsWith('nc:')) return next();
      if (!ctx.message && !callback) return next();
      if (ctx.message && ('successful_payment' in ctx.message || 'web_app_data' in ctx.message)) return next();
      if (text.startsWith('/') && !/^\/(start|help|find|stop|next|settings)(?:@\w+)?(?:\s|$)/.test(text)) return next();
      // Preserve existing administrative broadcast handlers.
      if (text === 'тестовая рассылка' || text.startsWith('/broadcast')) return next();
      if (this.updates.has(ctx.update.update_id)) return;
      this.updates.add(ctx.update.update_id);
      if (this.updates.size > 10_000) this.updates.delete(this.updates.values().next().value!);
      if (callback) await ctx.answerCbQuery().catch(() => {});
      const id = ctx.from.id;
      const receivedChatId = this.sessions.get(id)?.chatId;
      const previous = this.locks.get(id) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const s = this.session(id);
        s.blocked = false;
        try { await this.handle(s, ctx, text, callback, receivedChatId); }
        catch { await this.tell(s, 'Не удалось выполнить действие. Сообщение могло не отправиться. Попробуйте ещё раз.').catch(() => {}); }
      });
      this.locks.set(id, task);
      try { await task; } finally { if (this.locks.get(id) === task) this.locks.delete(id); }
    };
  }
  private async handle(s: Session, ctx: Context, text: string, callback: string, receivedChatId?: string) {
    const command = text.split(/\s/)[0].split('@')[0];
    if (command === '/start' || command === '/help') {
      s.input = undefined;
      if (s.active) void this.connect(s).catch(() => {});
      return this.tell(s, 'Anoname — анонимное общение прямо здесь. Нажмите «Найти собеседника». Во время разговора отправляйте текст или голосовые.\n\n18+. Не сообщайте личные данные. Игры и расширенные настройки доступны в приложении.');
    }
    if (text === buttons.app) return this.tell(s, 'Открыть тот же аккаунт в приложении:', this.options.webAppUrl ? Markup.inlineKeyboard([Markup.button.webApp('Открыть приложение', this.options.webAppUrl)]) : this.keyboard(s));
    if (text === buttons.stop || command === '/stop' || text === buttons.next || command === '/next') {
      s.input = undefined;
      // Persist intent BEFORE network I/O: stopping still works during an outage.
      const alreadyStopping = s.stopping;
      if (text === buttons.stop || command === '/stop') s.next = false;
      else if (!alreadyStopping) s.next = true;
      s.stopping = true;
      await this.save();
      if (alreadyStopping && s.socket?.connected) return this.tell(s, 'Завершаю предыдущее действие…');
      if (s.socket?.connected) await this.reconcileStop(s);
      else {
        try { await this.connect(s); } // session snapshot reconciles the saved intent
        catch { await this.tell(s, 'Остановка сохранена. Завершу поиск или разговор, когда восстановится связь с сервером.'); }
      }
      return;
    }
    if (text === buttons.find || command === '/find' || callback === 'nc:find') { s.input = undefined; return this.search(s); }
    if (text === buttons.settings || command === '/settings' || /^nc:(gender|desired|age|range)/.test(callback)) {
      if (s.state !== 'idle') return this.tell(s, 'Сначала остановите поиск или разговор, затем измените настройки.');
      if (callback === 'nc:age' || callback === 'nc:range') {
        s.input = callback === 'nc:age' ? 'age' : 'range';
        return this.tell(s, s.input === 'age' ? 'Введите свой возраст — от 18 до 100 лет.' : 'Введите диапазон возраста, например 18-35.');
      }
      if (/^nc:gender:(male|female)$/.test(callback)) s.preferences.gender = callback.split(':')[2] as Gender;
      if (/^nc:desired:(male|female|any)$/.test(callback)) s.preferences.desiredGender = callback.split(':')[2] as Preferences['desiredGender'];
      s.input = undefined; await this.save(); return this.settings(s);
    }
    if (s.input && !callback) {
      if (s.input === 'age') {
        const age = parseAge(text); if (!age) return this.tell(s, 'Введите число от 18 до 100.');
        s.preferences.age = age;
      } else {
        const range = parseRange(text); if (!range) return this.tell(s, 'Нужен диапазон от 18 до 100, например 18-35.');
        [s.preferences.desiredAgeMin, s.preferences.desiredAgeMax] = range;
      }
      s.input = undefined; await this.save(); return this.settings(s);
    }
    await this.connect(s);
    const rate = callback.match(/^nc:rate:([a-f0-9]{24}):([1-5])$/);
    if (rate) { s.socket!.emit('chat:rate', { chatId: rate[1], score: Number(rate[2]) }); return; }
    const report = callback.match(/^nc:report:([a-f0-9]{24}):(spam|insult|scam|sexual|illegal|other)$/);
    if (report) {
      if (report[1] !== s.chatId) return this.tell(s, 'Эта кнопка относится к завершённому разговору.');
      s.socket!.emit('chat:report', { chatId: s.chatId, reason: report[2] }); return;
    }
    if (!s.chatId) return this.tell(s, s.state === 'searching' ? 'Собеседник ещё не найден. Дождитесь подключения.' : 'Нажмите «Найти собеседника», чтобы начать разговор.');
    if (text === buttons.report) return this.tell(s, 'Выберите причину жалобы:', Markup.inlineKeyboard([
      ['Спам', 'spam'], ['Оскорбления', 'insult'], ['Мошенничество', 'scam'], ['Неприемлемый контент', 'sexual'], ['Другое', 'other'],
    ].map(([label, reason]) => [Markup.button.callback(label, `nc:report:${s.chatId}:${reason}`)])));
    if (text === buttons.profile) {
      const chatId = s.chatId;
      const profile: any = await (await this.request(s, `/api/chats/${chatId}/partner-profile`)).json();
      return this.tell(s, `${profile.firstName || 'Собеседник'}${profile.age ? `, ${profile.age}` : ''}\n${profile.bio || ''}\n${(profile.interests || []).join(', ')}`, { protect_content: true }, () => s.chatId === chatId);
    }
    if (text === buttons.topic) { s.socket!.emit('chat:suggest_topic', { chatId: s.chatId }); return; }
    if (callback) return this.tell(s, 'Эта кнопка больше недоступна.');
    if (receivedChatId && receivedChatId !== s.chatId) return this.tell(s, 'Собеседник уже сменился. Это сообщение не отправлено.');
    if (ctx.message && 'voice' in ctx.message) {
      const chatId = s.chatId;
      const voice = ctx.message.voice;
      if (voice.duration > 60 || (voice.file_size || 0) > 2 * 1024 * 1024) return this.tell(s, 'Голосовое должно быть не длиннее 1 минуты и не больше 2 МБ.');
      const url = await this.bot.telegram.getFileLink(voice.file_id);
      const audio = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!audio.ok) throw new Error('Audio unavailable');
      const bytes = await audio.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('Audio too large');
      if (s.chatId !== chatId) return this.tell(s, 'Разговор уже завершён. Голосовое не отправлено.');
      const form = new FormData();
      form.set('file', new Blob([bytes], { type: 'audio/ogg' }), 'voice.ogg');
      form.set('chatId', chatId); form.set('clientId', `tg-${s.id}-${ctx.message.message_id}`); form.set('voiceChanged', 'true');
      await this.request(s, '/api/media/voice', { method: 'POST', body: form });
      return;
    }
    if (text) {
      if (text.length > 2000) return this.tell(s, 'Сообщение слишком длинное. Максимум — 2000 символов.');
      // REST response confirms persistence; socket sends partner delivery events.
      await this.request(s, `/api/chats/${s.chatId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) });
      return;
    }
    return this.tell(s, 'В чате поддерживаются текст и голосовые. Контакты и пересылка профиля Telegram не отправляются.');
  }
}
