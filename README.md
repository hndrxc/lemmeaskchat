# omp-lemmeaskchat

Discord DM relay and away-mode conversation plugin for [oh-my-pi (`omp`)](https://github.com/oh-my-pi)'s built-in `ask` tool and interactive sessions. When an agent prompts for clarification or confirmation, questions are forwarded directly to your Discord DM so you can answer from your phone or desktop via buttons, menus, or typed replies—while the terminal prompt stays active in parallel. In away mode, completion announcements notify you when an agent run finishes and allow continuing the conversation or asking isolated `/btw` side questions by quote-replying directly from Discord.

## Installation

Requires [Bun](https://bun.sh) `>= 1.3.0` and `omp` ([`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) `>= 18.12.4`).

```bash
git clone https://github.com/hndrxc/lemmeaskchat.git
cd lemmeaskchat
bun install
omp plugin link .
```

## Discord Bot Setup

1. **Create Bot:** In the [Discord Developer Portal](https://discord.com/developers/applications), create a **New Application**, open the **Bot** tab, and reset/copy your token. Privileged Gateway Intents can remain disabled.
2. **Install to Server:** Under **Installation** → **Install Link**, choose **Guild Install** with scope `bot` and no permissions (`0`). Open the generated link and invite the bot to a private server you own.
3. **Allow DMs:** Ensure server privacy settings permit Direct Messages from members.
4. **Copy User ID:** In Discord client settings under **Advanced**, enable **Developer Mode**. Right-click your profile and select **Copy User ID**.
5. **Configure Plugin:** In `omp`, run `/lemmeaskchat setup` and enter your bot token and user ID.

## Commands

| Command | Description |
| --- | --- |
| `/lemmeaskchat` or `/lemmeaskchat status` | Show configuration, away status, away timeout, delay seconds, and bridge connection. |
| `/lemmeaskchat setup` | Interactive wizard to set token and user ID, verify REST connectivity, and test DMs. |
| `/lemmeaskchat away [on\|off]` | Toggle or set away mode (`away → Discord` in status bar). Immediately connects Gateway and starts away conversation. |
| `/lemmeaskchat timeout <seconds>` | Set away mode idle timeout in seconds (range: `1`..`2147483`, default: `900s`). |
| `/lemmeaskchat delay <seconds>` | Delay before sending a DM for an ask when away mode is off (default: `60s`; `0` disables delayed DMs). |
| `/lemmeaskchat test` | Send an interactive test question to Discord DM (120s timeout). |

While away mode is active, the status bar displays `away → Discord`.

## Away Mode & Remote Conversations

Away mode enables full interactive conversations with your active `omp` session from Discord when you step away from your desk.

### Gateway Connection Lifecycle

Away mode connects to the Discord Gateway immediately upon `/lemmeaskchat away on`. When away mode is turned off or the idle timeout expires, it releases the conversation reference (the Gateway stops if no active ask remains). Disabling away mode or timing out stops the remote relay only; it **never aborts** an active model generation or terminates the terminal session.

### Completion Notifications

When away mode is enabled and the agent finishes its work, `lemmeaskchat` sends a named completion notification to your Discord DM containing the final assistant response:

```text
Session “lemmeaskchat (4a9f12bc)” has finished — awaiting response.

I have implemented the away mode conversation controller and updated the configuration schema. All unit tests pass cleanly. Would you like me to prepare the commit?
```

Session names use the custom name or fall back to `<directory> (<session-id-first-8>)`.

### Quote-Reply Prompting vs. Ask Answers

- **Prompting the Model:** Quote-reply to any announcement or completion message sent by that session's bot to inject a new prompt. If the model is busy, the prompt queues safely behind running work without interrupting tools.
- **Answering an Ask:** Quote-replying to an `ask` prompt (or sending text while an ask is open) answers that question. Unquoted messages **never** start new prompts.
- **Message Splitting:** Responses exceeding Discord's 2,000-character limit are automatically split into chunks, each remaining a valid quote-reply target.

### Ephemeral Side Questions (`/btw`)

You can ask isolated side questions without interrupting running work or polluting the session transcript by prefixing your quote-reply with `/btw <question>`:

```text
/btw What was the name of the function we just modified?
```

The response is returned directly in Discord under a distinct side-question header:

```text
Session “lemmeaskchat (4a9f12bc)” — /btw

We modified `handlePrompt` in `src/away-session.ts`.
```

- **Native Ephemeral Isolation:** Side questions execute via the host's native `ctx.runEphemeralTurn` API with isolated context. They run concurrently alongside active tool batches or streaming turns without interrupting, steering, or blocking them. Tools are disabled and never run, and side exchanges never enter the main conversation history or session `.jsonl` transcript.
- **Bare `/btw` Usage:** Sending a bare `/btw` (or `/btw:`) without a question returns a concise usage reminder (`Use /btw <question> to ask a side question.`). Because the native interactive TUI history viewer cannot render in Discord, bare commands do not open an interactive viewer, trigger a model turn, or reset/postpone the idle timeout deadline.
- **Ordinary Prompts & Asks Unchanged:** Quote-replies without `/btw` continue to route as regular prompts (queued behind active runs if busy). Answers to active `ask` dialogs are always passed literally without slash command parsing. Side questions are independent single turns; replying to a `/btw` answer without `/btw` is treated as a normal prompt to the main session.
- **Idle Timeout & Cancellation:** In-flight side calls and Discord answer delivery hold the away idle timeout. Once all side queries and main operations finish, the full idle countdown resumes only if the session is truly idle. Turning away mode off (`/lemmeaskchat away off`), session switching, or idle expiration cancels active side calls via `AbortSignal`, but **never** aborts the main session turn.
- **Scope & Persistence:** Discord relays each `/btw` query as an independent, single-turn question with current session context. Upstream TUI history viewing and session branching from side questions are not persisted or supported over Discord.

### Idle Timeout

After an output is delivered and the session is truly idle, an idle timer starts:
- Configured via `/lemmeaskchat timeout <seconds>` or `LEMMEASKCHAT_AWAY_TIMEOUT_SECONDS` (range: `1`..`2147483`s, default: `900s` / 15m).
- Any new activity (prompts, model runs, active asks) clears and suspends the timer.
- On expiry, away mode turns off automatically and releases the Gateway connection.

### Main Sessions Only & Delayed Asks Retained

- **Main Sessions Only:** Away mode and ask relays operate exclusively in interactive main sessions. Background subagents never connect or send DMs.
- **Delayed Asks Retained Outside Away:** When away mode is off, the plugin retains its original delayed ask behavior: questions wait `delaySeconds` (default: `60s`) before sending to Discord. In away mode, ask questions dispatch immediately (0s delay).

## Ask Relay Behavior

- **First-Answer-Wins:** The terminal prompt opens immediately. Answering in the terminal resolves the Discord message and removes its buttons; answering in Discord closes the terminal prompt.
- **Multi-Question Asks:** Questions in multi-prompt asks are sent sequentially. If running multiple `omp` sessions against the same bot, quote-reply to the specific question message.

## Typed Replies

Along with clicking buttons or dropdowns, you can reply directly with text in the DM:

- **Option number or name:** `1` or `alpha` picks that option (case-insensitive).
- **Multi-select:** `1, 3` or `1 3` selects multiple options in order. Reply `none` to submit an empty selection.
- **Custom input:** Any text that does not match an option is passed to the agent as custom input.

## Configuration & Security

Settings are saved under omp's agent directory, typically `~/.omp/agent/lemmeaskchat/config.json` (file permissions `0600`, directory `0700`).

- `LEMMEASKCHAT_DISCORD_TOKEN`: Discord bot token (overrides config file).
- `LEMMEASKCHAT_DISCORD_USER_ID`: Target Discord user ID (overrides config file).
- `LEMMEASKCHAT_DELAY_SECONDS`: Delay in seconds before relaying an ask when away mode is off (non-negative integer; overrides config file).
- `LEMMEASKCHAT_AWAY_TIMEOUT_SECONDS`: Away mode idle timeout in seconds (valid positive integer `1`..`2147483`, default: `900`; overrides config file).

> **Security Caveat:** The bot token is stored in plaintext in `config.json`. To avoid keeping tokens on disk, supply `LEMMEASKCHAT_DISCORD_TOKEN` via environment variable instead.

## Development

```bash
bun test            # Run unit and integration tests
bun run typecheck   # Typecheck TypeScript sources
```

Host interfaces are checked against `@oh-my-pi/pi-coding-agent@18.12.4`; the current interactive smoke runs use `omp 18.14.0` on Bun 1.4.2. The plugin wraps the host's native `ask` tool at session startup to preserve TUI formatting; changes to host internal tool schemas in future `omp` versions may require updates.

### Verification

Interactive smoke runs verified the away conversation loop on `omp 18.13.3`. A separate `omp 18.14.0` smoke verified `/btw` running concurrently with the main turn, side-question isolation from main history, unchanged ordinary follow-ups, and idle expiry only after side delivery. These runs used local Discord and model substitutes, not live Discord or production providers. See [research/active-session-prompting.md](research/active-session-prompting.md) for execution details and upstream interface references.
