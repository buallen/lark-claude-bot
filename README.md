# lark-claude-bot

A Lark (Feishu) bot that connects to Claude Code CLI. Supports two modes:

- **Auto-reply mode** — responds to incoming Lark DMs and group mentions by running Claude
- **Send-only mode** — disables the WS listener; exposes an HTTP API so other apps can send messages to Lark through this bot

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `LARK_APP_ID` | Yes | Your Lark app ID (`cli_...`) |
| `LARK_APP_SECRET` | Yes | Your Lark app secret |
| `WORKDIR` | No | Default working directory for Claude (default: `$HOME`) |
| `DISABLE_AUTO_REPLY` | No | Set to `true` to run in send-only mode |

### 3. Run

```bash
node index.js
```

## Send-only mode (API)

Set `DISABLE_AUTO_REPLY=true` in `.env`. The bot starts without a WS listener and exposes a send endpoint on port `9090`:

### `POST /send`

Send a message to any Lark chat or user.

**Request body:**

```json
{
  "receive_id": "oc_xxxx",
  "receive_id_type": "chat_id",
  "text": "Your message here (markdown supported)"
}
```

`receive_id_type` defaults to `chat_id`. Other valid values: `open_id`, `user_id`, `union_id`, `email`.

**Response:**

```json
{ "ok": true, "message_id": "om_xxxx" }
```

### `GET /health`

Returns process health: uptime, pid, active user sessions.

## Auto-start (macOS)

A sample LaunchAgent plist is provided in `launchd/`. Copy it to `~/Library/LaunchAgents/`, update the paths, then:

```bash
launchctl load ~/Library/LaunchAgents/com.example.lark-claude-bot.plist
```

## Project structure

```
src/
  bot.js              Main event loop and message handler
  health.js           HTTP server (/health + /send)
  state.js            Per-user state persistence
  dedup.js            Message deduplication
  ratelimit.js        Per-user rate limiting
  constants.js        Tunable constants
  logger.js           Structured JSON logger
  lark/
    client.js         Lark SDK wrapper + token caching
    messages.js       Send, patch, delete messages
    reactions.js      Emoji reactions
    card.js           Markdown → Lark interactive card
  claude/
    runner.js         Claude CLI subprocess + stream parser
    sessions.js       Session history reader
  commands/
    handler.js        Built-in commands (help, cd, new, cancel…)
    parser.js         Message type detection and content extraction
```
