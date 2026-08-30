# Anistropic Discord Bot — Railway Docker Edition

## Railway deployment
1. Upload this folder to a GitHub repository.
2. In Railway, create a service from that repository.
3. Railway will detect `Dockerfile` automatically.
4. Add these Variables:
   - `DISCORD_TOKEN` = your Discord bot token
   - `BOT_OWNER_ID` = your Discord user ID
5. Optional but recommended: attach a Railway Volume mounted at `/app/data` so SQLite survives redeploys.
6. Deploy. The container starts with `python -u bot.py`.

## Discord Developer Portal
Enable these Privileged Gateway Intents for the bot:
- Server Members Intent
- Message Content Intent
- Presence Intent

Give the bot only the permissions it actually needs; Administrator is not required for every command.

## Important
The bot is a Discord worker and does not need an HTTP port. Do not add a web server just to satisfy Railway.
