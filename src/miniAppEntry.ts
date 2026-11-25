import { Markup } from 'telegraf';
import type { MenuButtonWebApp } from 'telegraf/types';

export const MINI_APP_INTRO = `👋 <b>Добро пожаловать в Anoname</b>

Знакомься и общайся с собеседниками в мини-приложении Telegram.

• Поиск по интересам и предпочтениям.
• Бесплатный геопоиск: приоритет ближайшему подходящему участнику, который тоже включил геолокацию.
• Текстовые сообщения и игры в чате.

Нажми «Открыть Anoname», настрой профиль и начни поиск. Время ожидания зависит от доступных собеседников.`;

export const RATING_INFO = `⭐ <b>Рейтинг собеседника</b>

После разговора можно оценить собеседника от 1 до 5 звёзд. За один диалог каждый участник оставляет одну оценку.

Рейтинг — это средняя оценка от собеседников, а не оплата за сообщения. Общайся уважительно; при нарушениях можно пожаловаться или заблокировать пользователя.`;

/** Never generate a launch button for malformed or credential-bearing URLs. */
export function normalizeMiniAppUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return;
    return url.toString();
  } catch {
    return;
  }
}

export function hasBotToken(value: string | undefined): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(value || '');
}

export function parseStartPayload(payload?: string): { referralCode?: string; campaign?: string } {
  if (!payload) return {};
  const [codeRaw, campaignRaw] = payload.split('__');
  return {
    referralCode: codeRaw?.trim() || undefined,
    campaign: campaignRaw?.trim() || undefined,
  };
}

export function buildMiniAppUrl(baseUrl: string | undefined, variant?: 'A' | 'B', referralCode?: string): string | undefined {
  const validated = normalizeMiniAppUrl(baseUrl);
  if (!validated) return;
  const url = new URL(validated);
  if (variant) url.searchParams.set('exp', variant);
  if (referralCode) url.searchParams.set('ref', referralCode);
  return url.toString();
}

export function buildMiniAppEntry(options: {
  webAppUrl?: string;
  chatType?: string;
  botUsername?: string;
  payload?: string;
  variant?: 'A' | 'B';
}) {
  if (options.chatType !== 'private') {
    const username = options.botUsername?.replace(/^@/, '');
    const privateUrl = username && /^[A-Za-z0-9_]{5,32}$/.test(username)
      ? new URL(`https://t.me/${username}`) : undefined;
    if (privateUrl && /^[A-Za-z0-9_-]{1,64}$/.test(options.payload || '')) {
      // Telegram /start accepts only base64url characters, at most 64 bytes.
      privateUrl.searchParams.set('start', options.payload!);
    }
    return {
      text: 'Открой личный чат с ботом и нажми «Открыть Anoname» — мини-приложение запускается там.',
      reply_markup: privateUrl ? Markup.inlineKeyboard([
        Markup.button.url('Открыть личный чат', privateUrl.toString()),
      ]).reply_markup : undefined,
    };
  }
  const { referralCode } = parseStartPayload(options.payload);
  const launchUrl = buildMiniAppUrl(options.webAppUrl, options.variant, referralCode);
  return {
    text: launchUrl ? MINI_APP_INTRO : 'Мини-приложение Anoname временно недоступно. Попробуй /app позже.',
    reply_markup: launchUrl ? Markup.inlineKeyboard([
      [Markup.button.webApp('Открыть Anoname', launchUrl)],
      [Markup.button.callback('Как работает рейтинг', 'rating_info')],
    ]).reply_markup : undefined,
  };
}

export async function installMiniAppMenu(
  telegram: { setChatMenuButton(options: { menuButton: MenuButtonWebApp }): Promise<unknown> },
  token: string | undefined,
  webAppUrl: string | undefined,
): Promise<'installed' | 'skipped'> {
  const url = normalizeMiniAppUrl(webAppUrl);
  if (!hasBotToken(token) || !url) return 'skipped';
  await telegram.setChatMenuButton({
    menuButton: { type: 'web_app', text: 'Открыть Anoname', web_app: { url } },
  });
  return 'installed';
}

/** API errors can contain request URLs (including a bot token). Log status only. */
export function telegramErrorStatus(error: unknown): string {
  const code = (error as { response?: { error_code?: unknown } } | null)?.response?.error_code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599
    ? `Telegram HTTP ${code}` : 'ошибка запроса; подробности скрыты';
}
