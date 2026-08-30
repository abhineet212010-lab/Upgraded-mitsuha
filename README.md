# Kiara — Railway-ready Discord bot

This build keeps the requested prefix commands and adds slash-command mirrors for every explicitly listed command/subcommand. Categories that had no command list (Tickets, Embed, Social, Custom Branding, Join2Create) are intentionally left empty rather than inventing extra commands.

## Railway variables

Required:
- `DISCORD_TOKEN` = your bot token

Optional:
- `DISCORD_GUILD_ID` = one server ID for instant guild slash-command registration. Leave empty to register globally (global propagation can take time).
- `BOT_OWNER_ID` = your Discord user ID for owner-only controls.
- `DATA_DIR` = persistent data directory; defaults to `/app/data`.

## Discord Developer Portal

Enable these intents for prefix commands and member/security features:
- Server Members Intent
- Message Content Intent

Invite the bot with both `bot` and `applications.commands` scopes and the permissions required by the commands.

## Railway

Deploy this repository with the included Dockerfile. The Dockerfile copies the complete project (`COPY . .`), so `src/` and `.env.example` are not required to exist separately in Railway's build context.

Health endpoints:
- `/`
- `/health`

The bot logs into Discord first and registers the requested slash commands on the `ready` event.
