# Anistropic — Railway-ready Discord Security & Moderation Bot

A persistent prefix-command Discord bot designed for Railway. It uses SQLite for configuration/data persistence, so settings survive normal restarts/redeploys when the Railway volume is mounted.

## Included systems

- General: ping, avatar, banner, poll, bot invite, server info, AFK, snipe, esnipe
- Moderation: kick, ban, unban, timeout mute/unmute, warnings, nick lock, purge, lock/unlock/hide/unhide, lockall/unlockall
- Anti-nuke: enable/disable/status/setup, punishment, logging, strict, lockdown, panic/recover, whitelist/role whitelist
- Anti-raid: join threshold, account age, action, lockdown, verification, avatar check, invite deletion
- Welcome: channel/message/image/embed/test
- Logging: 13 event categories + enable/disable/enableall/disableall
- Utility: permissions, admin lists, role lists, prefix management, bot settings
- Voice: vckick/vcpull/vcmute/vcdeafen and all-member variants, voice-role automation
- Tracking: message leaderboard, user stats, identities, admin/mod views
- Roles: create/delete/add/remove/colour/rename/bulk assignment/info/list
- Automod: anti-spam, anti-link, anti-word, whitelists, configurable punishment
- Owner: lockdown/unlock/slowmode-all/emergency + owner management + audit
- Disaster recovery: snapshots of channels/roles and a restore command for panic/recovery workflows

## Railway deployment

1. Create a Discord application/bot in the Discord Developer Portal.
2. Enable the **Server Members Intent**, **Message Content Intent**, and **Presence Intent** if desired.
3. Copy `.env.example` to `.env` locally only for testing. On Railway, add:
   - `DISCORD_TOKEN`
   - `BOT_OWNER_ID`
4. Create a Railway **Worker** service from this folder/repository.
5. The included `Procfile` runs `python bot.py`.
6. For persistent SQLite data, attach a Railway Volume and set its mount path to `/app/data`.
   - The bot automatically stores its database in `/app/data/anistropic.db` when that directory exists.
   - Without a volume, the bot still runs, but SQLite data can be lost when the container is recreated.
7. Invite the bot with permissions appropriate for the features you enable. For full moderation/security functionality it needs the relevant moderation, message, role, channel-management, audit-log and voice permissions.

## Important Discord limitations

No bot can undo every server change perfectly. Anti-nuke/recovery is best-effort and depends on Discord audit-log events, hierarchy, permissions, rate limits and what the bot has previously recorded.

Keep the bot's highest role below the server owner but above the roles it must manage. Do not give the bot unnecessary permissions.

Default prefix is `!`. The `.automod` names shown in some guides are also available as `!automod`, `!antispam`, `!antilink`, and `!antiword`.

## Commands

Run `!help` in Discord. The bot has a built-in categorized help panel and command aliases matching the requested names.

Owner-only slash commands are registered as:
- `/owner lockdown`
- `/owner unlock`
- `/owner slowmode-all`
- `/owner emergency`
- `/owner add`
- `/owner remove`
- `/owner list`
- `/owner transfer`
- `/owner permissions`
- `/owner audit`

The `BOT_OWNER_ID` is the initial immutable bot owner. Owner management is stored per bot and requires the configured owner for changes.
