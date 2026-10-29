# omp-lemmeaskchat

Discord DM relay plugin for [oh-my-pi (`omp`)](https://github.com/oh-my-pi)'s built-in `ask` tool. When an agent prompts for clarification or confirmation, questions are forwarded directly to your Discord DM so you can answer from your phone or desktop via buttons, menus, or typed replies—while the terminal prompt stays active in parallel.

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
| `/lemmeaskchat` or `/lemmeaskchat status` | Show configuration, away status, delay seconds, and bridge connection. |
| `/lemmeaskchat setup` | Interactive wizard to set token and user ID, verify REST connectivity, and test DMs. |
| `/lemmeaskchat away [on\|off]` | Toggle or set away mode (`away → Discord` in status bar) to dispatch DMs immediately. |
| `/lemmeaskchat delay <seconds>` | Delay before sending a DM when away mode is off (default: `60s`; `0` disables delayed DMs). |
| `/lemmeaskchat test` | Send an interactive test question to Discord DM (120s timeout). |

## Behavior

- **First-Answer-Wins:** The terminal prompt opens immediately. Answering in the terminal resolves the Discord message and removes its buttons; answering in Discord closes the terminal prompt.
- **Timing:** In away mode (`/lemmeaskchat away on`), DMs send immediately. Otherwise, the plugin waits `delaySeconds` before sending. If answered in the terminal before the delay expires, no DM is sent.
- **Main Sessions Only:** Only interactive main sessions relay questions; background subagents never send DMs. If Discord delivery fails, the terminal prompt remains active.
- **Multi-Question & Multi-Session:** Questions in multi-prompt asks are sent sequentially. If running multiple `omp` sessions against the same bot, quote-reply to the specific message to ensure the right session receives your answer.

## Typed Replies

Along with clicking buttons or dropdowns, you can reply directly with text in the DM:

- **Option number or name:** `1` or `alpha` picks that option (case-insensitive).
- **Multi-select:** `1, 3` or `1 3` selects multiple options in order. Reply `none` to submit an empty selection.
- **Custom input:** Any text that does not match an option is passed to the agent as custom input.

## Configuration & Security

Settings are saved under omp's agent directory, typically `~/.omp/agent/lemmeaskchat/config.json` (file permissions `0600`, directory `0700`).

- `LEMMEASKCHAT_DISCORD_TOKEN`: Discord bot token (overrides config file).
- `LEMMEASKCHAT_DISCORD_USER_ID`: Target Discord user ID (overrides config file).
- `LEMMEASKCHAT_DELAY_SECONDS`: Delay in seconds when away mode is off (overrides config file).

> **Security Caveat:** The bot token is stored in plaintext in `config.json`. To avoid keeping tokens on disk, supply `LEMMEASKCHAT_DISCORD_TOKEN` via environment variable instead.

## Development

```bash
bun test            # Run unit and integration tests
bun run typecheck   # Typecheck TypeScript sources
```

Tested against `@oh-my-pi/pi-coding-agent@18.12.4` and `omp 18.13.0` on Bun 1.4.2. The plugin wraps the host's native `ask` tool at session startup to preserve TUI formatting; changes to host internal tool schemas in future `omp` versions may require updates.
