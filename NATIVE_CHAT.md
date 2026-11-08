# Native Telegram chat (2026-10-29)

## Implemented

Opt-in `ENABLE_NATIVE_CHAT=true` adds a private-chat client for the existing API and
Socket.IO matchmaking pool. It is not a separate Telegram-only matching service.

- `/start`, `/help`, `/find`, `/stop`, `/next`, `/settings` and reply keyboards.
- Adult onboarding, gender and age preferences; server-side plan/filter rules remain authoritative.
- Anonymous text (2000 characters), voice (60 seconds / 2 MiB, existing API voice processing), mini-profile, topic requests, reports and post-chat ratings.
- One serialized command queue per Telegram user, bounded update/event deduplication,
  stale-chat checks and persistent preferences/active session recovery.
- REST message submission for persistence confirmation; Socket.IO events wake a serialized, paginated history reader. A cursor only advances after delivery, never past a failure.
- Telegram transient-error retries honor retry_after; background recovery retries failed history and reconnects active sessions every 30 seconds. Permanent 403 errors stop passive delivery until user interaction.
- Voice and text use the same output queue. Chat-bound guards prevent a slow old-chat download/queued retry from reaching a new conversation.
- Single-flight authentication, stale-socket event guards, explicit persisted-state validation and shutdown guards.
- No Telegram forwarding headers. Incoming text has no HTML/Markdown parsing.
- API credentials stay in memory. The state file contains only own Telegram IDs,
  preferences, active flags, chat/message cursors; no bodies or partner profiles.
- Existing payment/service updates and unrelated callbacks continue to legacy handlers.

Visual games, detailed account/privacy editing and other rich screens still open in
Mini App. This is **not** full feature parity for every visual screen. Telegram native
reply-to mapping, geolocation filters and photos/stickers are not implemented here.

## Compatibility

API changes are additive: `POST /api/auth/bot/session`, protected by existing
`botAuth` (`X-Bot-Secret`), and a `telegram_bot` token platform. The new endpoint
accepts a validated Telegram numeric ID only from the trusted backend. Do not expose
the backend secret to clients. Telegram webhook validation remains fail-closed.

Bot tokens do not revoke `telegram` (Mini App) or `web` sessions. Existing API
routes/events and frontend sources are unchanged. Existing user profiles are not
overwritten by bot login. No database migration is required.

## Enable / rollback

Current server inspection: bot token is NOT configured. No live deployment or
webhook change was performed for this implementation.

1. Back up current `api` and `bot` image IDs/tags and deployment settings.
2. Build updated API and bot using the existing deployment compose file. Deploy the
   API before enabling native mode in the bot. Check `/health` and the existing site.
3. In `deploy/bot.env`, set `ENABLE_NATIVE_CHAT=true` and
   `NATIVE_CHAT_STATE_FILE=/data/native-chat-state.json`. The existing bot-data volume
   must remain mounted, writable by the container user. Run **one bot replica**;
   deduplication/command queues are process-local.
4. Configure the missing bot token from a private SSH terminal with the existing
   hidden-input setup script (never paste it into chat):
   `python3 /home/alex/.openclaw/workspace/projects/anoname/deploy/scripts/configure-bot.py`
   This script configures the intended Telegram bot and checks webhook ownership;
   it does not build images. Build the updated images in step 2 first.
5. Recreate the bot with the new settings. Validate with two test accounts: bot↔bot
   and bot↔Mini App/web, text and voice both ways, cancel/next, report/rating,
   reconnection and simultaneous Mini App login. No real-user broadcasts required.

Use the existing compose project and explicit env file:
`docker compose --env-file .env -f compose.yml` (working directory `deploy`).
Do not dump merged compose config or secret environment values to logs.

Rollback: set `ENABLE_NATIVE_CHAT=false` and recreate only the bot, or restore its
previous image. The additive API can stay; its new route is not used by legacy UI.
Keep the state volume for a future re-enable. Do not roll back unrelated local changes.

## Verification and limitations

- `npm test` (bot): validation and local HTTP + actual Socket.IO transport integration,
  fake Telegram delivery. Tests cover onboarding, shared API contract, duplicate
  start/update/event handling, cancel before search acknowledgement, text/voice,
  echo/identity protection, stale report buttons, restart and next-partner sequencing.
  Additional scenarios cover 205-message recovery, three consecutive Telegram failures
  without skipping the cursor, and a voice download completing after a chat switch.
  Retry unit tests cover 429, 400/403, long flood holds and cancelled stale retries.
- `npm run build` (bot/API).
- API: existing 95 tests plus 4 bot-session/auth isolation tests passed.
- No live Telegram or production end-to-end test: token missing.
- Delivery is not an exactly-once transactional outbox. A crash between Telegram
  delivery and cursor persistence, or an ambiguous network timeout, can replay a message.
  Failed deliveries are retried from the last confirmed API history cursor.
- History is read in pages of 100 until caught up; existing API retention applies.
  Recovery is for the current active conversation; old-chat messages are not injected
  into a new conversation. No message bodies are persisted locally.

## Startup and outage recovery follow-up

Local state is loaded synchronously at startup; network restoration runs in the
background with at most four workers and non-overlapping maintenance cycles.
Local `/start` and `/help` do not require API availability. Failed accounts do not
block other accounts, and shutdown stops queued recovery work.

Session snapshots reconcile an interrupted stop/next with server truth: retry end
or cancel while still active, or clear pending stop when the server is already idle.
A stale profile response is suppressed after the chat changes. Recovery timers
release their retry gate on wake-up, avoiding a missed retry at the clock boundary.

Current bot suite: 13 tests, including held API requests during startup, bounded
restoration, shutdown and lost chat-end acknowledgement followed by reconnect.

## Durable stop intent

Stop/next intent is persisted before API connection or socket emission. If the API
is unavailable, the bot confirms that stopping is saved. A restart restores pending
intent and reconciles it with the server: cancel search, end an active chat, or clear
an already-completed stop. Explicit stop overrides pending next. Maintenance
resynchronizes unacknowledged stops instead of leaving the UI indefinitely pending.
Three new HTTP/Socket.IO regressions cover offline stop followed by a restart with
server state searching, chatting or idle, without starting an unwanted new search.
