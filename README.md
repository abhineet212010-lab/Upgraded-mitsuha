# Kiara — Requested Feature Build

This build contains only the requested feature groups:
General, Moderation, Antinuke, Anti-raid, Welcome, Logging, Utility, Voice, Tracking, Roles, Automod/Antispam/Antilink/Antiword, and `/owner`.

## Railway
1. Push the contents of this repository to GitHub.
2. Create a Railway service from the repository.
3. Railway uses the included Dockerfile automatically.
4. Add Variables:
   - `DISCORD_TOKEN` = Discord bot token
   - `BOT_OWNER_ID` = your Discord user ID
   - `DATA_DIR` = `/app/data` (recommended)
5. Attach a Railway Volume mounted at `/app/data` for persistent state/recovery snapshots.

The bot exposes `/health` and `/` on Railway's `PORT`.

## Discord
Enable these Privileged Gateway Intents in the Discord Developer Portal:
- Message Content Intent
- Server Members Intent

The bot also needs the permissions required by the commands (moderation, manage channels/roles, move members, audit log viewing, etc.).

Prefix is `!` by default. Automod commands intentionally use `.` as requested.

Owner commands are slash commands: `/owner ...`.
