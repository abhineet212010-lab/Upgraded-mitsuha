import os
import re
import json
import time
import asyncio
import logging
import traceback
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiosqlite
import discord
from discord.ext import commands, tasks
from discord import app_commands
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
OWNER_ID_RAW = os.getenv("BOT_OWNER_ID", "0")
try:
    BOT_OWNER_ID = int(OWNER_ID_RAW)
except ValueError:
    BOT_OWNER_ID = 0

if not TOKEN:
    raise RuntimeError("DISCORD_TOKEN is missing. Add it to Railway Variables.")

DATA_DIR = "/app/data" if os.path.isdir("/app/data") else os.path.join(os.getcwd(), "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "anistropic.db")

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s")
log = logging.getLogger("anistropic")

INTENTS = discord.Intents.default()
INTENTS.members = True
INTENTS.message_content = True
INTENTS.guilds = True
INTENTS.voice_states = True
INTENTS.presences = True

DEFAULT_PREFIX = "!"
LOG_CATEGORIES = [
    "message_delete", "message_edit", "member_join", "member_leave",
    "member_update", "voice", "role_create", "role_delete",
    "channel_create", "channel_delete", "channel_update", "moderation",
    "server_update"
]

def utcnow():
    return datetime.now(timezone.utc)

def dt_iso(dt):
    return dt.astimezone(timezone.utc).isoformat() if dt else None

def human_dt(dt):
    return discord.utils.format_dt(dt, "R") if dt else "Unknown"

def clean_reason(reason: Optional[str]) -> str:
    return (reason or "No reason provided").strip()[:500]

async def db_execute(sql, params=(), fetch=False, many=False):
    async with aiosqlite.connect(DB_PATH) as db:
        if many:
            await db.executemany(sql, params)
        else:
            cur = await db.execute(sql, params)
        await db.commit()
        if fetch:
            return await cur.fetchall()
        return None

async def db_one(sql, params=()):
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(sql, params)
        return await cur.fetchone()

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
        CREATE TABLE IF NOT EXISTS guilds (
            guild_id INTEGER PRIMARY KEY,
            prefix TEXT NOT NULL DEFAULT '!',
            welcome_channel INTEGER,
            welcome_message TEXT,
            welcome_image TEXT,
            welcome_embed TEXT,
            antinuke_enabled INTEGER DEFAULT 0,
            antinuke_punishment TEXT DEFAULT 'striproles',
            antinuke_log_channel INTEGER,
            antinuke_strict INTEGER DEFAULT 0,
            antinuke_lockdown INTEGER DEFAULT 0,
            antiraid_enabled INTEGER DEFAULT 0,
            antiraid_action TEXT DEFAULT 'kick',
            antiraid_threshold INTEGER DEFAULT 8,
            antiraid_window INTEGER DEFAULT 15,
            antiraid_age_days INTEGER DEFAULT 0,
            antiraid_verification INTEGER DEFAULT 0,
            antiraid_avatar_check INTEGER DEFAULT 0,
            antiraid_delete_invites INTEGER DEFAULT 0,
            automod_punishment TEXT DEFAULT 'delete',
            automod_strict INTEGER DEFAULT 0,
            lockdown INTEGER DEFAULT 0,
            emergency INTEGER DEFAULT 0,
            voice_role INTEGER
        );
        CREATE TABLE IF NOT EXISTS warnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id INTEGER,
            user_id INTEGER,
            moderator_id INTEGER,
            reason TEXT,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS afk (
            guild_id INTEGER,
            user_id INTEGER,
            reason TEXT,
            since TEXT,
            PRIMARY KEY(guild_id,user_id)
        );
        CREATE TABLE IF NOT EXISTS snipes (
            guild_id INTEGER,
            channel_id INTEGER,
            kind TEXT,
            author_id INTEGER,
            content TEXT,
            created_at TEXT,
            PRIMARY KEY(guild_id,channel_id,kind)
        );
        CREATE TABLE IF NOT EXISTS logging (
            guild_id INTEGER,
            category TEXT,
            channel_id INTEGER,
            PRIMARY KEY(guild_id,category)
        );
        CREATE TABLE IF NOT EXISTS whitelist (
            guild_id INTEGER,
            kind TEXT,
            target_id INTEGER,
            PRIMARY KEY(guild_id,kind,target_id)
        );
        CREATE TABLE IF NOT EXISTS nicklocks (
            guild_id INTEGER,
            user_id INTEGER,
            nickname TEXT,
            PRIMARY KEY(guild_id,user_id)
        );
        CREATE TABLE IF NOT EXISTS stats (
            guild_id INTEGER,
            user_id INTEGER,
            messages INTEGER DEFAULT 0,
            daily_messages INTEGER DEFAULT 0,
            last_day TEXT,
            PRIMARY KEY(guild_id,user_id)
        );
        CREATE TABLE IF NOT EXISTS identities (
            guild_id INTEGER,
            user_id INTEGER,
            identity TEXT,
            PRIMARY KEY(guild_id,user_id)
        );
        CREATE TABLE IF NOT EXISTS bot_owners (
            user_id INTEGER PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS bot_mods (
            user_id INTEGER PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS bot_admins (
            user_id INTEGER PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS snapshots (
            guild_id INTEGER PRIMARY KEY,
            payload TEXT,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS automod_words (
            guild_id INTEGER,
            word TEXT,
            PRIMARY KEY(guild_id,word)
        );
        CREATE TABLE IF NOT EXISTS automod_whitelist (
            guild_id INTEGER,
            kind TEXT,
            target_id INTEGER,
            PRIMARY KEY(guild_id,kind,target_id)
        );
        """)
        await db.execute("INSERT OR IGNORE INTO bot_owners(user_id) VALUES(?)", (BOT_OWNER_ID,))
        await db.commit()
    log.info("Database ready: %s", DB_PATH)

async def ensure_guild(guild_id):
    await db_execute("INSERT OR IGNORE INTO guilds(guild_id) VALUES(?)", (guild_id,))

async def get_prefix(guild_id):
    row = await db_one("SELECT prefix FROM guilds WHERE guild_id=?", (guild_id,))
    return row[0] if row and row[0] else DEFAULT_PREFIX

async def set_prefix(guild_id, prefix):
    await ensure_guild(guild_id)
    await db_execute("UPDATE guilds SET prefix=? WHERE guild_id=?", (prefix, guild_id))

async def get_cfg(guild_id):
    await ensure_guild(guild_id)
    row = await db_one("SELECT * FROM guilds WHERE guild_id=?", (guild_id,))
    cols = ["guild_id","prefix","welcome_channel","welcome_message","welcome_image","welcome_embed",
            "antinuke_enabled","antinuke_punishment","antinuke_log_channel","antinuke_strict","antinuke_lockdown",
            "antiraid_enabled","antiraid_action","antiraid_threshold","antiraid_window","antiraid_age_days",
            "antiraid_verification","antiraid_avatar_check","antiraid_delete_invites","automod_punishment",
            "automod_strict","lockdown","emergency","voice_role"]
    return dict(zip(cols,row))

async def is_global_owner(user_id):
    row = await db_one("SELECT 1 FROM bot_owners WHERE user_id=?", (user_id,))
    return bool(row)

async def is_bot_admin(user_id):
    return bool(await db_one("SELECT 1 FROM bot_admins WHERE user_id=?", (user_id,))) or await is_global_owner(user_id)

async def is_bot_mod(user_id):
    return bool(await db_one("SELECT 1 FROM bot_mods WHERE user_id=?", (user_id,))) or await is_bot_admin(user_id)

def embed(title, description="", colour=discord.Colour.blurple()):
    return discord.Embed(title=title, description=description, colour=colour, timestamp=utcnow())

def hierarchy_check(actor: discord.Member, target: discord.Member) -> bool:
    return target != actor and target != actor.guild.owner and actor.top_role > target.top_role

async def audit_log_channel(guild, category=None):
    if category:
        row = await db_one("SELECT channel_id FROM logging WHERE guild_id=? AND category=?", (guild.id,category))
        if row:
            return guild.get_channel(row[0])
    cfg = await get_cfg(guild.id)
    if cfg.get("antinuke_log_channel"):
        return guild.get_channel(cfg["antinuke_log_channel"])
    return None

async def log_event(guild, category, title, description, colour=discord.Colour.blurple()):
    ch = await audit_log_channel(guild, category)
    if ch:
        try:
            await ch.send(embed=embed(title, description, colour))
        except discord.HTTPException:
            pass

async def take_snapshot(guild):
    payload = {
        "roles": [{"id": r.id, "name": r.name, "colour": r.colour.value, "permissions": r.permissions.value,
                   "position": r.position, "hoist": r.hoist, "mentionable": r.mentionable}
                  for r in guild.roles if not r.is_default()],
        "categories": [{"id": c.id, "name": c.name, "position": c.position} for c in guild.categories],
        "channels": [{"id": c.id, "name": c.name, "type": str(c.type), "position": c.position,
                      "category_id": c.category_id, "slowmode": getattr(c,"slowmode_delay",0),
                      "overwrites": {str(k.id): {"allow": v.pair()[0].value, "deny": v.pair()[1].value}
                                     for k,v in c.overwrites.items() if hasattr(k,"id")}}
                     for c in guild.channels],
    }
    await db_execute("INSERT OR REPLACE INTO snapshots(guild_id,payload,created_at) VALUES(?,?,?)",
                     (guild.id,json.dumps(payload),dt_iso(utcnow())))

async def emergency_lock(guild, reason="Emergency protection"):
    cfg = await get_cfg(guild.id)
    await db_execute("UPDATE guilds SET emergency=1, lockdown=1 WHERE guild_id=?", (guild.id,))
    for ch in guild.text_channels:
        try:
            overwrite = ch.overwrites_for(guild.default_role)
            overwrite.send_messages = False
            overwrite.create_public_threads = False
            await ch.set_permissions(guild.default_role, overwrite=overwrite, reason=reason)
        except discord.HTTPException:
            pass
    await log_event(guild, "moderation", "🚨 Emergency lockdown", reason, discord.Colour.red())

async def emergency_unlock(guild, reason="Emergency recovery"):
    await db_execute("UPDATE guilds SET emergency=0, lockdown=0 WHERE guild_id=?", (guild.id,))
    for ch in guild.text_channels:
        try:
            overwrite = ch.overwrites_for(guild.default_role)
            overwrite.send_messages = None
            overwrite.create_public_threads = None
            await ch.set_permissions(guild.default_role, overwrite=overwrite, reason=reason)
        except discord.HTTPException:
            pass
    await log_event(guild, "moderation", "🟢 Emergency recovery", reason, discord.Colour.green())


async def get_audit_executor(guild, action, target_id=None):
    """Return the newest matching audit-log executor. Audit logs are best-effort and can lag."""
    try:
        async for entry in guild.audit_logs(limit=8, action=action):
            if target_id is None or getattr(entry.target, "id", None) == target_id:
                return entry.user
    except (discord.Forbidden, discord.HTTPException):
        return None
    return None

async def antinuke_authorized(guild, user):
    if not user:
        return True
    if user.id == guild.owner_id or user.id == bot.user.id or await is_global_owner(user.id):
        return True
    if await db_one("SELECT 1 FROM whitelist WHERE guild_id=? AND kind='user' AND target_id=?",
                    (guild.id, user.id)):
        return True
    role_rows = await db_execute("SELECT target_id FROM whitelist WHERE guild_id=? AND kind='role'",
                                 (guild.id,), fetch=True)
    member = guild.get_member(user.id)
    return bool(member and any(guild.get_role(r[0]) in member.roles for r in role_rows))

async def punish_nuker(guild, user, reason):
    cfg = await get_cfg(guild.id)
    if await antinuke_authorized(guild, user):
        return False
    action = cfg["antinuke_punishment"]
    member = guild.get_member(user.id)
    try:
        if action == "ban" and member and member != guild.owner:
            await member.ban(reason=reason)
        elif action == "kick" and member and member != guild.owner:
            await member.kick(reason=reason)
        elif action == "striproles" and member and member != guild.owner:
            removable = [r for r in member.roles[1:] if r < guild.me.top_role and not r.managed]
            if removable:
                await member.remove_roles(*removable, reason=reason)
        if cfg["antinuke_lockdown"]:
            await emergency_lock(guild, reason)
        await log_event(guild, "moderation", "🚨 Anti-nuke response",
                        f"Executor: {user.mention if member else user}\nAction: {action}\nReason: {reason}",
                        discord.Colour.red())
        return True
    except discord.HTTPException:
        return False

async def restore_snapshot(guild):
    """Best-effort restore of missing roles/channels from the latest snapshot.
    Discord IDs cannot be recreated, so this restores names/settings rather than exact IDs.
    """
    row = await db_one("SELECT payload FROM snapshots WHERE guild_id=?", (guild.id,))
    if not row:
        return 0
    try:
        data=json.loads(row[0])
    except Exception:
        return 0
    restored=0
    existing_role_names={r.name for r in guild.roles}
    for r in data.get("roles", []):
        if r["name"] in existing_role_names:
            continue
        try:
            perms=discord.Permissions(r["permissions"])
            await guild.create_role(name=r["name"],colour=discord.Colour(r["colour"]),
                                    permissions=perms,hoist=r["hoist"],mentionable=r["mentionable"],
                                    reason="Anistropic disaster recovery")
            restored += 1
        except discord.HTTPException:
            pass
    existing_channels={(str(c.type),c.name) for c in guild.channels}
    cats={}
    for c in sorted(data.get("categories",[]),key=lambda x:x["position"]):
        if ("category",c["name"]) not in existing_channels:
            try:
                cats[c["id"]]=await guild.create_category(c["name"],reason="Anistropic disaster recovery")
                restored += 1
            except discord.HTTPException:
                pass
        else:
            cats[c["id"]]=discord.utils.get(guild.categories,name=c["name"])
    for c in sorted(data.get("channels",[]),key=lambda x:x["position"]):
        if c["type"] == "category":
            continue
        if (c["type"],c["name"]) in existing_channels:
            continue
        try:
            category=cats.get(c.get("category_id"))
            if c["type"]=="text":
                await guild.create_text_channel(c["name"],category=category,
                                                 slowmode_delay=c.get("slowmode",0),
                                                 reason="Anistropic disaster recovery")
            elif c["type"]=="voice":
                await guild.create_voice_channel(c["name"],category=category,
                                                 reason="Anistropic disaster recovery")
            elif c["type"]=="stage_voice":
                await guild.create_stage_channel(c["name"],category=category,
                                                 reason="Anistropic disaster recovery")
            restored += 1
        except (discord.HTTPException, ValueError):
            pass
    return restored

class Bot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix=self.dynamic_prefix, intents=INTENTS, help_command=None,
                         case_insensitive=True, allowed_mentions=discord.AllowedMentions(everyone=False, roles=False))
        self.deleted_cache = {}
        self.edited_cache = {}
        self.join_windows = defaultdict(deque)
        self.spam_windows = defaultdict(deque)
        self.ready_once = False

    async def dynamic_prefix(self, bot, message):
        if not message.guild:
            return DEFAULT_PREFIX
        return await get_prefix(message.guild.id)

    async def setup_hook(self):
        await init_db()
        await self.add_cog(CoreCog(self))
        await self.add_cog(ModerationCog(self))
        await self.add_cog(SecurityCog(self))
        await self.add_cog(WelcomeLoggingCog(self))
        await self.add_cog(UtilityCog(self))
        await self.add_cog(VoiceTrackingCog(self))
        await self.add_cog(RoleCog(self))
        await self.add_cog(AutomodCog(self))
        await self.add_cog(OwnerCog(self))
        try:
            await self.tree.sync()
            log.info("Slash commands synced.")
        except Exception:
            log.exception("Slash sync failed")

    async def on_ready(self):
        if not self.ready_once:
            self.ready_once = True
            log.info("Logged in as %s (%s) | %d guild(s)", self.user, self.user.id, len(self.guilds))
        await self.change_presence(activity=discord.Game(name="!help | Anistropic"))

    async def on_guild_join(self, guild):
        await ensure_guild(guild.id)
        await take_snapshot(guild)

    async def on_message_delete(self, message):
        if not message.guild or message.author.bot:
            return
        content = message.content or ("[attachment]" if message.attachments else "[no text]")
        self.deleted_cache[(message.guild.id,message.channel.id)] = (message.author.id, content, utcnow())
        await db_execute("""INSERT OR REPLACE INTO snipes(guild_id,channel_id,kind,author_id,content,created_at)
                            VALUES(?,?,?,?,?,?)""",
                         (message.guild.id,message.channel.id,"delete",message.author.id,content,dt_iso(utcnow())))
        await log_event(message.guild,"message_delete","🗑️ Message deleted",
                        f"Author: {message.author.mention}\nChannel: {message.channel.mention}\nContent: {content[:1000]}")

    async def on_message_edit(self, before, after):
        if not before.guild or before.author.bot or before.content == after.content:
            return
        self.edited_cache[(before.guild.id,before.channel.id)] = (before.author.id,before.content,after.content,utcnow())
        await db_execute("""INSERT OR REPLACE INTO snipes(guild_id,channel_id,kind,author_id,content,created_at)
                            VALUES(?,?,?,?,?,?)""",
                         (before.guild.id,before.channel.id,"edit",before.author.id,
                          f"Before: {before.content}\nAfter: {after.content}",dt_iso(utcnow())))
        await log_event(before.guild,"message_edit","✏️ Message edited",
                        f"Author: {before.author.mention}\nChannel: {before.channel.mention}\nBefore: {before.content[:700]}\nAfter: {after.content[:700]}")


    async def on_guild_channel_delete(self, channel):
        await log_event(channel.guild,"channel_delete","🗑️ Channel deleted",f"`{channel.name}`")
        cfg=await get_cfg(channel.guild.id)
        if cfg["antinuke_enabled"]:
            executor=await get_audit_executor(channel.guild,discord.AuditLogAction.channel_delete,channel.id)
            await punish_nuker(channel.guild,executor,f"Unauthorized channel deletion: {channel.name}")
            if not await antinuke_authorized(channel.guild,executor):
                await restore_snapshot(channel.guild)

    async def on_guild_role_delete(self, role):
        await log_event(role.guild,"role_delete","🗑️ Role deleted",f"`{role.name}`")
        cfg=await get_cfg(role.guild.id)
        if cfg["antinuke_enabled"]:
            executor=await get_audit_executor(role.guild,discord.AuditLogAction.role_delete,role.id)
            await punish_nuker(role.guild,executor,f"Unauthorized role deletion: {role.name}")
            if not await antinuke_authorized(role.guild,executor):
                await restore_snapshot(role.guild)

    async def on_guild_channel_create(self, channel):
        await log_event(channel.guild,"channel_create","📁 Channel created",f"{channel.mention}")
        cfg=await get_cfg(channel.guild.id)
        if cfg["antinuke_enabled"]:
            executor=await get_audit_executor(channel.guild,discord.AuditLogAction.channel_create,channel.id)
            await punish_nuker(channel.guild,executor,f"Unauthorized channel creation: {channel.name}")

    async def on_guild_role_create(self, role):
        await log_event(role.guild,"role_create","🎭 Role created",f"{role.mention}")
        cfg=await get_cfg(role.guild.id)
        if cfg["antinuke_enabled"]:
            executor=await get_audit_executor(role.guild,discord.AuditLogAction.role_create,role.id)
            await punish_nuker(role.guild,executor,f"Unauthorized role creation: {role.name}")

    async def on_member_ban(self, guild, user):
        cfg=await get_cfg(guild.id)
        if cfg["antinuke_enabled"]:
            executor=await get_audit_executor(guild,discord.AuditLogAction.ban,user.id)
            await punish_nuker(guild,executor,f"Unauthorized ban of {user}")

    async def on_member_remove(self, member):
        await log_event(member.guild,"member_leave","📤 Member left",f"{member} (`{member.id}`)")
        cfg=await get_cfg(member.guild.id)
        if cfg["antinuke_enabled"]:
            executor=await get_audit_executor(member.guild,discord.AuditLogAction.kick,member.id)
            if executor:
                await punish_nuker(member.guild,executor,f"Unauthorized kick of {member}")

    async def on_member_join(self, member):
        cfg = await get_cfg(member.guild.id)
        now = time.time()
        q = self.join_windows[member.guild.id]
        q.append(now)
        while q and now-q[0] > cfg["antiraid_window"]:
            q.popleft()
        if cfg["antiraid_enabled"]:
            suspicious_age = cfg["antiraid_age_days"] and (utcnow()-member.created_at).days < cfg["antiraid_age_days"]
            raid = len(q) >= cfg["antiraid_threshold"] or suspicious_age
            if raid:
                await self.handle_raid(member.guild, member, "Join threshold/account-age detection")
        if cfg["welcome_channel"]:
            ch = member.guild.get_channel(cfg["welcome_channel"])
            if ch:
                msg = cfg["welcome_message"] or "Welcome {user.mention} to **{guild.name}**! You are member #{guild.member_count}."
                msg = msg.replace("{user.mention}",member.mention).replace("{user.name}",member.name)\
                         .replace("{guild.name}",member.guild.name).replace("{guild.member_count}",str(member.guild.member_count))
                try:
                    if cfg["welcome_embed"]:
                        e = discord.Embed.from_dict(json.loads(cfg["welcome_embed"]))
                        e.description = (e.description or "").replace("{user.mention}",member.mention).replace("{guild.name}",member.guild.name)
                        await ch.send(content=msg if msg else None, embed=e)
                    elif cfg["welcome_image"]:
                        e = embed("👋 Welcome!", msg)
                        e.set_image(url=cfg["welcome_image"])
                        await ch.send(embed=e)
                    else:
                        await ch.send(msg)
                except Exception:
                    log.exception("Welcome failed")
        await log_event(member.guild,"member_join","📥 Member joined",f"{member.mention} (`{member.id}`)")

    async def handle_raid(self, guild, member, reason):
        cfg = await get_cfg(guild.id)
        if cfg["antiraid_lockdown"]:
            await emergency_lock(guild,"Anti-raid lockdown")
        if cfg["antiraid_verification"]:
            try: await guild.edit(verification_level=discord.VerificationLevel.highest, reason="Anti-raid")
            except discord.HTTPException: pass
        if cfg["antiraid_delete_invites"]:
            try:
                invites = await guild.invites()
                for inv in invites:
                    try: await inv.delete(reason="Anti-raid detected")
                    except discord.HTTPException: pass
            except discord.HTTPException:
                pass
        action = cfg["antiraid_action"]
        try:
            if action == "ban":
                await member.ban(reason=reason)
            else:
                await member.kick(reason=reason)
        except discord.HTTPException:
            pass
        await log_event(guild,"moderation","🛡️ Anti-raid action",f"{member} — {action}\n{reason}",discord.Colour.red())

    async def on_member_update(self, before, after):
        row = await db_one("SELECT nickname FROM nicklocks WHERE guild_id=? AND user_id=?", (after.guild.id,after.id))
        if row and after.nick != row[0]:
            try: await after.edit(nick=row[0], reason="Nickname lock")
            except discord.HTTPException: pass
        await log_event(after.guild,"member_update","👤 Member updated",f"{after.mention}")

    async def on_voice_state_update(self, member, before, after):
        if before.channel != after.channel:
            await log_event(member.guild,"voice","🔊 Voice update",
                            f"{member.mention}: {before.channel} → {after.channel}")
        cfg = await get_cfg(member.guild.id)
        if after.channel and cfg["voice_role"]:
            role = member.guild.get_role(cfg["voice_role"])
            if role and role not in member.roles:
                try: await member.add_roles(role, reason="Voice role automation")
                except discord.HTTPException: pass

    async def on_guild_role_update(self, before, after):
        await log_event(after.guild,"role_create","🎭 Role updated",f"{before.name} → {after.name}")
    async def on_guild_channel_update(self, before, after):
        await log_event(after.guild,"channel_update","🛠️ Channel updated",f"`{before.name}` → `{after.name}`")

    async def process_commands(self, message):
        if message.author.bot:
            return
        if message.guild:
            row = await db_one("SELECT reason,since FROM afk WHERE guild_id=? AND user_id=?", (message.guild.id,message.author.id))
            if row:
                await db_execute("DELETE FROM afk WHERE guild_id=? AND user_id=?", (message.guild.id,message.author.id))
                try: await message.channel.send(f"Welcome back {message.author.mention}! Your AFK was removed.")
                except discord.HTTPException: pass
            for u in message.mentions:
                r = await db_one("SELECT reason,since FROM afk WHERE guild_id=? AND user_id=?", (message.guild.id,u.id))
                if r:
                    await message.channel.send(f"{u.mention} is AFK: {r[0] or 'No reason'}")
                    break
            # tracking
            day = utcnow().date().isoformat()
            await db_execute("""INSERT INTO stats(guild_id,user_id,messages,daily_messages,last_day)
                                VALUES(?,?,?,?,?)
                                ON CONFLICT(guild_id,user_id) DO UPDATE SET
                                messages=messages+1,
                                daily_messages=CASE WHEN last_day=? THEN daily_messages+1 ELSE 1 END,
                                last_day=?""",
                             (message.guild.id,message.author.id,1,1,day,day,day))
        await super().process_commands(message)

bot = Bot()

def guild_only():
    return commands.guild_only()

def has_mod():
    async def predicate(ctx):
        return ctx.author.guild_permissions.manage_guild or ctx.author.guild_permissions.manage_messages or await is_bot_mod(ctx.author.id)
    return commands.check(predicate)

def has_admin():
    async def predicate(ctx):
        return ctx.author.guild_permissions.administrator or await is_bot_admin(ctx.author.id)
    return commands.check(predicate)

def owner_only():
    async def predicate(ctx):
        return await is_global_owner(ctx.author.id)
    return commands.check(predicate)

async def safe_delete(ctx, limit, check=None):
    limit = max(1,min(int(limit),100))
    deleted = await ctx.channel.purge(limit=limit, check=check)
    await ctx.send(f"🧹 Deleted **{len(deleted)}** messages.", delete_after=4)

class CoreCog(commands.Cog):
    def __init__(self, bot): self.bot=bot

    @commands.command(name="help")
    async def help_cmd(self, ctx, category=None):
        cats = {
            "general": ["ping","av","ab","poll","botinvite","serverinfo","afk","snipe","esnipe"],
            "moderation": ["kick","ban","unban","mute","unmute","warn","warnings","delwarn","clearwarnings","nick","purge","lock","unlock","hide","unhide","lockall","unlockall"],
            "antinuke": ["antinuke","antinuke setup","antinuke enable","antinuke disable","antinuke status","antinuke owner","antinuke whitelist","antinuke wlrole","antinuke punishment","antinuke logging","antinuke strict","antinuke lockdown","antinuke panic","antinuke recover"],
            "antiraid": ["antiraid","antiraid enable","antiraid disable","antiraid status","antiraid action","antiraid threshold","antiraid lockdown","antiraid age_limit","antiraid verification","antiraid avatar_check","antiraid delete_invites"],
            "welcome": ["welcomer","welcomer channel","welcomer message","welcomer image","welcomer embed","welcomer test"],
            "logging": ["logging","logging enable","logging disable","logging enableall","logging disableall","logging categories"],
            "utility": ["view","myperms","viewperms","botperms","listadmins","viewroles","prefix","setprefix","botsettings"],
            "voice": ["vckick","vcpull","vcmute","vcdeafen","vcpullall","vckickall","vcdeafenall","vcrole"],
            "tracking": ["leaderboard","viewuser","setidentity","removeidentity","adminview","modview"],
            "roles": ["role","role add","role remove","role create","role delete","role colour","role rename","role all","role bots","role humans","role info","role list","createrole"],
            "automod": ["automod","antispam","antilink","antiword"],
        }
        if not category:
            e=embed("🌌 Anistropic", "Powerful moderation, security, utility and tracking bot.\n\nSelect a category with `!help <category>`.")
            e.add_field(name="Categories", value=" • ".join(k.title() for k in cats), inline=False)
            e.set_footer(text=f"Prefix: {await get_prefix(ctx.guild.id)} • {len(bot.commands)} loaded commands")
            return await ctx.send(embed=e)
        category=category.lower()
        if category not in cats:
            return await ctx.send(f"❌ Unknown category. Try: `!help general`")
        await ctx.send(embed=embed(f"📚 {category.title()} Commands", "\n".join(f"`{x}`" for x in cats[category])))

    @commands.command()
    async def ping(self,ctx):
        await ctx.send(embed=embed("🏓 Pong!",f"Bot latency: **{round(bot.latency*1000)}ms**"))

    @commands.command()
    async def av(self,ctx,user:discord.User=None):
        user=user or ctx.author
        e=embed(f"🖼️ {user}'s Avatar")
        e.set_image(url=user.display_avatar.url)
        await ctx.send(embed=e)

    @commands.command()
    async def ab(self,ctx,user:discord.User=None):
        user=user or ctx.author
        banner=user.banner
        if not banner:
            return await ctx.send("❌ This user has no profile banner.")
        e=embed(f"🎨 {user}'s Banner")
        e.set_image(url=banner.url)
        await ctx.send(embed=e)

    @commands.command()
    async def poll(self,ctx,*,question):
        e=embed("📊 Poll",question)
        msg=await ctx.send(embed=e)
        await msg.add_reaction("✅"); await msg.add_reaction("❌")

    @commands.command()
    async def botinvite(self,ctx):
        perms=discord.Permissions(administrator=False)
        url=discord.utils.oauth_url(bot.user.id,permissions=perms)
        await ctx.send(f"🔗 **Bot Invite:** {url}")

    @commands.command()
    async def serverinfo(self,ctx):
        g=ctx.guild
        e=embed(f"📊 {g.name} Server Info")
        e.add_field(name="Owner",value=str(g.owner),inline=True)
        e.add_field(name="Members",value=str(g.member_count),inline=True)
        e.add_field(name="Channels",value=str(len(g.channels)),inline=True)
        e.add_field(name="Roles",value=str(len(g.roles)),inline=True)
        e.add_field(name="Created",value=human_dt(g.created_at),inline=True)
        e.add_field(name="Boosts",value=str(g.premium_subscription_count),inline=True)
        await ctx.send(embed=e)

    @commands.command()
    async def afk(self,ctx,*,reason="AFK"):
        await db_execute("INSERT OR REPLACE INTO afk(guild_id,user_id,reason,since) VALUES(?,?,?,?)",
                         (ctx.guild.id,ctx.author.id,reason,dt_iso(utcnow())))
        await ctx.send(f"💤 {ctx.author.mention} is now AFK: **{reason}**")

    @commands.command()
    async def snipe(self,ctx):
        row=await db_one("SELECT author_id,content,created_at FROM snipes WHERE guild_id=? AND channel_id=? AND kind='delete'",
                         (ctx.guild.id,ctx.channel.id))
        if not row: return await ctx.send("❌ Nothing to snipe.")
        author=ctx.guild.get_member(row[0])
        await ctx.send(embed=embed("🕵️ Deleted Message",f"**{author or row[0]}:** {row[1]}\n{row[2]}"))

    @commands.command()
    async def esnipe(self,ctx):
        row=await db_one("SELECT author_id,content,created_at FROM snipes WHERE guild_id=? AND channel_id=? AND kind='edit'",
                         (ctx.guild.id,ctx.channel.id))
        if not row: return await ctx.send("❌ Nothing to esnipe.")
        author=ctx.guild.get_member(row[0])
        await ctx.send(embed=embed("✏️ Edited Message",f"**{author or row[0]}:**\n{row[1]}\n{row[2]}"))

class ModerationCog(commands.Cog):
    def __init__(self,bot): self.bot=bot

    @commands.command()
    @guild_only()
    @has_mod()
    async def kick(self,ctx,member:discord.Member,*,reason="No reason provided"):
        if not hierarchy_check(ctx.author,member): return await ctx.send("❌ Role hierarchy prevents this action.")
        await member.kick(reason=clean_reason(reason)); await log_event(ctx.guild,"moderation","👢 Member kicked",f"{member} — {reason}",discord.Colour.orange())
        await ctx.send(f"👢 Kicked {member.mention}.")

    @commands.command()
    @guild_only()
    @has_mod()
    async def ban(self,ctx,member:discord.Member,*,reason="No reason provided"):
        if not hierarchy_check(ctx.author,member): return await ctx.send("❌ Role hierarchy prevents this action.")
        await member.ban(reason=clean_reason(reason)); await log_event(ctx.guild,"moderation","🔨 Member banned",f"{member} — {reason}",discord.Colour.red())
        await ctx.send(f"🔨 Banned {member.mention}.")

    @commands.command()
    @guild_only()
    @has_mod()
    async def unban(self,ctx,user_id:int,*,reason="No reason provided"):
        try: user=await bot.fetch_user(user_id); await ctx.guild.unban(user,reason=clean_reason(reason))
        except discord.HTTPException as e: return await ctx.send(f"❌ Could not unban: {e}")
        await ctx.send(f"🟢 Unbanned `{user}`.")

    @commands.command()
    @guild_only()
    @has_mod()
    async def mute(self,ctx,member:discord.Member,duration:str="10m",*,reason="No reason provided"):
        if not hierarchy_check(ctx.author,member): return await ctx.send("❌ Role hierarchy prevents this action.")
        m=re.fullmatch(r"(\d+)([smhd])",duration.lower())
        if not m: return await ctx.send("Usage: `!mute @user 10m [reason]`")
        amount,unit=int(m.group(1)),m.group(2); secs=amount*{"s":1,"m":60,"h":3600,"d":86400}[unit]
        secs=min(secs,28*86400)
        await member.timeout(timedelta(seconds=secs),reason=clean_reason(reason))
        await ctx.send(f"🔇 Timed out {member.mention} for **{duration}**.")

    @commands.command()
    @guild_only()
    @has_mod()
    async def unmute(self,ctx,member:discord.Member):
        await member.timeout(None,reason="Unmute")
        await ctx.send(f"🔊 Unmuted {member.mention}.")

    @commands.command()
    @guild_only()
    @has_mod()
    async def warn(self,ctx,member:discord.Member,*,reason="No reason provided"):
        row=await db_one("SELECT COALESCE(MAX(id),0)+1 FROM warnings")
        await db_execute("INSERT INTO warnings(guild_id,user_id,moderator_id,reason,created_at) VALUES(?,?,?,?,?)",
                         (ctx.guild.id,member.id,ctx.author.id,reason,dt_iso(utcnow())))
        w=await db_one("SELECT id FROM warnings WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 1",(ctx.guild.id,member.id))
        await ctx.send(f"⚠️ Warned {member.mention}. Warning ID: **{w[0]}**")

    @commands.command()
    @guild_only()
    @has_mod()
    async def warnings(self,ctx,member:discord.Member):
        rows=await db_execute("SELECT id,moderator_id,reason,created_at FROM warnings WHERE guild_id=? AND user_id=? ORDER BY id DESC", (ctx.guild.id,member.id), fetch=True)
        if not rows: return await ctx.send("No warnings.")
        text="\n".join(f"`#{r[0]}` <@{r[1]}> — {r[2]} — {r[3][:10]}" for r in rows[:20])
        await ctx.send(embed=embed(f"⚠️ Warnings for {member}",text))

    @commands.command()
    @guild_only()
    @has_mod()
    async def delwarn(self,ctx,warn_id:int):
        await db_execute("DELETE FROM warnings WHERE id=? AND guild_id=?",(warn_id,ctx.guild.id))
        await ctx.send(f"🗑️ Deleted warning `{warn_id}`.")

    @commands.command()
    @guild_only()
    @has_mod()
    async def clearwarnings(self,ctx,member:discord.Member):
        await db_execute("DELETE FROM warnings WHERE guild_id=? AND user_id=?",(ctx.guild.id,member.id))
        await ctx.send(f"🧹 Cleared warnings for {member.mention}.")

    @commands.group(invoke_without_command=True)
    @guild_only()
    @has_mod()
    async def nick(self,ctx,member:discord.Member,*,nickname=None):
        if nickname is None: return await ctx.send("Usage: `!nick @user New Nick` or `!nick lock/unlock @user`")
        if not hierarchy_check(ctx.author,member): return await ctx.send("❌ Role hierarchy prevents this action.")
        await member.edit(nick=nickname,reason="Nickname command"); await ctx.send(f"✏️ Nickname changed for {member.mention}.")

    @nick.command()
    async def lock(self,ctx,member:discord.Member,*,nickname=None):
        nickname=nickname or member.nick or member.name
        await db_execute("INSERT OR REPLACE INTO nicklocks(guild_id,user_id,nickname) VALUES(?,?,?)",(ctx.guild.id,member.id,nickname))
        await member.edit(nick=nickname,reason="Nickname lock")
        await ctx.send(f"🔒 Locked nickname for {member.mention} as **{nickname}**.")

    @nick.command()
    async def unlock(self,ctx,member:discord.Member):
        await db_execute("DELETE FROM nicklocks WHERE guild_id=? AND user_id=?",(ctx.guild.id,member.id))
        await ctx.send(f"🔓 Unlocked nickname for {member.mention}.")

    @commands.command()
    @guild_only()
    @has_mod()
    async def purge(self,ctx,amount:str="10",*args):
        if amount.lower()=="bot":
            await safe_delete(ctx,100,lambda m:m.author.bot); return
        if ctx.message.mentions:
            target=ctx.message.mentions[0]
            try: n=int(args[-1]) if args else 10
            except ValueError: n=10
            await safe_delete(ctx,n,lambda m:m.author.id==target.id); return
        try: n=int(amount)
        except ValueError: return await ctx.send("Usage: `!purge <N>` / `!purge bot` / `!purge @user <N>`")
        await safe_delete(ctx,n)

    async def channel_lock(self,ctx,lock=True,hide=False):
        ow=ctx.channel.overwrites_for(ctx.guild.default_role)
        if hide: ow.view_channel=not lock
        else: ow.send_messages=not lock
        await ctx.channel.set_permissions(ctx.guild.default_role,overwrite=ow,reason="Channel control")
        await ctx.send(("🔒 Locked" if lock else "🔓 Unlocked")+" this channel.")

    @commands.command()
    @has_mod()
    async def lock(self,ctx): await self.channel_lock(ctx,True)
    @commands.command()
    @has_mod()
    async def unlock(self,ctx): await self.channel_lock(ctx,False)
    @commands.command()
    @has_mod()
    async def hide(self,ctx): await self.channel_lock(ctx,True,True)
    @commands.command()
    @has_mod()
    async def unhide(self,ctx): await self.channel_lock(ctx,False,True)

    @commands.command()
    @has_admin()
    async def lockall(self,ctx):
        count=0
        for ch in ctx.guild.text_channels:
            try:
                ow=ch.overwrites_for(ctx.guild.default_role); ow.send_messages=False
                await ch.set_permissions(ctx.guild.default_role,overwrite=ow,reason="Lock all")
                count+=1
            except discord.HTTPException: pass
        await ctx.send(f"🔒 Locked **{count}** text channels.")

    @commands.command()
    @has_admin()
    async def unlockall(self,ctx):
        count=0
        for ch in ctx.guild.text_channels:
            try:
                ow=ch.overwrites_for(ctx.guild.default_role); ow.send_messages=None
                await ch.set_permissions(ctx.guild.default_role,overwrite=ow,reason="Unlock all")
                count+=1
            except discord.HTTPException: pass
        await ctx.send(f"🔓 Unlocked **{count}** text channels.")

class SecurityCog(commands.Cog):
    def __init__(self,bot): self.bot=bot

    @commands.group(invoke_without_command=True)
    @has_admin()
    async def antinuke(self,ctx):
        cfg=await get_cfg(ctx.guild.id)
        await ctx.send(embed=embed("🛡️ Anti-nuke",f"Enabled: **{bool(cfg['antinuke_enabled'])}**\nPunishment: **{cfg['antinuke_punishment']}**\nStrict: **{bool(cfg['antinuke_strict'])}**\nLockdown: **{bool(cfg['antinuke_lockdown'])}**"))

    @antinuke.command()
    async def setup(self,ctx):
        await take_snapshot(ctx.guild)
        await db_execute("UPDATE guilds SET antinuke_enabled=1 WHERE guild_id=?",(ctx.guild.id,))
        await ctx.send("🛡️ Anti-nuke setup complete: protection enabled and a recovery snapshot was saved.")

    @antinuke.command()
    async def enable(self,ctx):
        await db_execute("UPDATE guilds SET antinuke_enabled=1 WHERE guild_id=?",(ctx.guild.id,)); await ctx.send("🛡️ Anti-nuke enabled.")
    @antinuke.command()
    async def disable(self,ctx):
        await db_execute("UPDATE guilds SET antinuke_enabled=0 WHERE guild_id=?",(ctx.guild.id,)); await ctx.send("🛑 Anti-nuke disabled.")
    @antinuke.command()
    async def status(self,ctx):
        cfg=await get_cfg(ctx.guild.id); await ctx.send(embed=embed("🛡️ Anti-nuke Status",json.dumps({
            "enabled":bool(cfg["antinuke_enabled"]),"punishment":cfg["antinuke_punishment"],
            "strict":bool(cfg["antinuke_strict"]),"lockdown":bool(cfg["antinuke_lockdown"]),
            "log_channel":cfg["antinuke_log_channel"]},indent=2)))
    @antinuke.command()
    async def owner(self,ctx): await ctx.send(f"👑 Configured bot owner: <@{BOT_OWNER_ID}>")
    @antinuke.command()
    async def whitelist(self,ctx):
        rows=await db_execute("SELECT kind,target_id FROM whitelist WHERE guild_id=?",(ctx.guild.id,),fetch=True)
        await ctx.send("Whitelist:\n"+("\n".join(f"{r[0]}: <@{r[1]}>" for r in rows) if rows else "Empty"))
    @antinuke.command()
    async def wlrole(self,ctx,role:discord.Role=None):
        if not role: return await ctx.send("Usage: `!antinuke wlrole @Role`")
        await db_execute("INSERT OR REPLACE INTO whitelist(guild_id,kind,target_id) VALUES(?,?,?)",(ctx.guild.id,"role",role.id))
        await ctx.send(f"✅ Whitelisted role {role.mention}.")
    @antinuke.command()
    async def punishment(self,ctx,action:str=None):
        if action not in ("ban","kick","striproles"): return await ctx.send("Use: `ban`, `kick`, or `striproles`.")
        await db_execute("UPDATE guilds SET antinuke_punishment=? WHERE guild_id=?",(action,ctx.guild.id)); await ctx.send(f"🛡️ Punishment: **{action}**")
    @antinuke.command()
    async def logging(self,ctx,channel:discord.TextChannel=None):
        if not channel: return await ctx.send("Usage: `!antinuke logging #channel`")
        await db_execute("UPDATE guilds SET antinuke_log_channel=? WHERE guild_id=?",(channel.id,ctx.guild.id)); await ctx.send(f"📝 Anti-nuke log channel set to {channel.mention}.")
    @antinuke.command()
    async def strict(self,ctx):
        row=await db_one("SELECT antinuke_strict FROM guilds WHERE guild_id=?",(ctx.guild.id,)); val=0 if row and row[0] else 1
        await db_execute("UPDATE guilds SET antinuke_strict=? WHERE guild_id=?",(val,ctx.guild.id)); await ctx.send(f"Strict mode: **{bool(val)}**")
    @antinuke.command()
    async def lockdown(self,ctx):
        row=await db_one("SELECT antinuke_lockdown FROM guilds WHERE guild_id=?",(ctx.guild.id,)); val=0 if row and row[0] else 1
        await db_execute("UPDATE guilds SET antinuke_lockdown=? WHERE guild_id=?",(val,ctx.guild.id)); await ctx.send(f"Anti-nuke lockdown: **{bool(val)}**")
    @antinuke.command()
    async def panic(self,ctx):
        await take_snapshot(ctx.guild); await emergency_lock(ctx.guild,"Anti-nuke PANIC requested by "+str(ctx.author)); await ctx.send("🚨 PANIC MODE activated. Snapshot saved.")
    @antinuke.command()
    async def recover(self,ctx):
        restored = await restore_snapshot(ctx.guild)
        await emergency_unlock(ctx.guild,"Anti-nuke recovery requested by "+str(ctx.author))
        await ctx.send(f"🟢 Panic/emergency mode recovered. Best-effort snapshot restore: **{restored}** items.")

    @commands.group(invoke_without_command=True)
    @has_admin()
    async def antiraid(self,ctx):
        cfg=await get_cfg(ctx.guild.id)
        await ctx.send(embed=embed("🛡️ Anti-raid",f"Enabled: **{bool(cfg['antiraid_enabled'])}**\nThreshold: **{cfg['antiraid_threshold']} joins/{cfg['antiraid_window']}s**\nAge limit: **{cfg['antiraid_age_days']} days**\nAction: **{cfg['antiraid_action']}**"))

    async def toggle_cfg(self,ctx,column,label):
        cfg=await get_cfg(ctx.guild.id); val=0 if cfg[column] else 1
        await db_execute(f"UPDATE guilds SET {column}=? WHERE guild_id=?",(val,ctx.guild.id)); await ctx.send(f"{label}: **{bool(val)}**")
    @antiraid.command()
    async def enable(self,ctx): await self.toggle_cfg(ctx,"antiraid_enabled","Anti-raid")
    @antiraid.command()
    async def disable(self,ctx):
        await db_execute("UPDATE guilds SET antiraid_enabled=0 WHERE guild_id=?",(ctx.guild.id,)); await ctx.send("Anti-raid disabled.")
    @antiraid.command()
    async def status(self,ctx):
        cfg=await get_cfg(ctx.guild.id); await ctx.send(embed=embed("Anti-raid Status",json.dumps({k:cfg[k] for k in ["antiraid_enabled","antiraid_action","antiraid_threshold","antiraid_window","antiraid_age_days","antiraid_verification","antiraid_avatar_check","antiraid_delete_invites"]},indent=2)))
    @antiraid.command()
    async def action(self,ctx,action:str):
        if action not in ("kick","ban"): return await ctx.send("Use `kick` or `ban`.")
        await db_execute("UPDATE guilds SET antiraid_action=? WHERE guild_id=?",(action,ctx.guild.id)); await ctx.send(f"Raid action: **{action}**")
    @antiraid.command()
    async def threshold(self,ctx,count:int,window:int=15):
        if not 1<=count<=100: return await ctx.send("Threshold must be 1-100.")
        await db_execute("UPDATE guilds SET antiraid_threshold=?,antiraid_window=? WHERE guild_id=?",(count,window,ctx.guild.id)); await ctx.send(f"Threshold: **{count} joins/{window}s**")
    @antiraid.command()
    async def lockdown(self,ctx): await self.toggle_cfg(ctx,"antiraid_lockdown","Raid lockdown")
    @antiraid.command(name="age_limit")
    async def age_limit(self,ctx,days:int):
        await db_execute("UPDATE guilds SET antiraid_age_days=? WHERE guild_id=?",(max(0,days),ctx.guild.id)); await ctx.send(f"Account age limit: **{max(0,days)} days**")
    @antiraid.command()
    async def verification(self,ctx): await self.toggle_cfg(ctx,"antiraid_verification","Verification upgrade")
    @antiraid.command()
    async def avatar_check(self,ctx): await self.toggle_cfg(ctx,"antiraid_avatar_check","Avatar check")
    @antiraid.command()
    async def delete_invites(self,ctx): await self.toggle_cfg(ctx,"antiraid_delete_invites","Invite deletion")

class WelcomeLoggingCog(commands.Cog):
    def __init__(self,bot): self.bot=bot

    @commands.group(invoke_without_command=True)
    @has_admin()
    async def welcomer(self,ctx):
        cfg=await get_cfg(ctx.guild.id); await ctx.send(embed=embed("👋 Welcomer",f"Channel: {('<#'+str(cfg['welcome_channel'])+'>') if cfg['welcome_channel'] else 'Not set'}\nMessage: {cfg['welcome_message'] or 'Default'}"))

    @welcomer.command()
    async def channel(self,ctx,channel:discord.TextChannel=None):
        await db_execute("UPDATE guilds SET welcome_channel=? WHERE guild_id=?",(channel.id if channel else None,ctx.guild.id))
        await ctx.send(f"Welcome channel: {channel.mention if channel else 'disabled'}")
    @welcomer.command()
    async def message(self,ctx,*,message):
        await db_execute("UPDATE guilds SET welcome_message=? WHERE guild_id=?",(message,ctx.guild.id)); await ctx.send("✅ Welcome message saved.")
    @welcomer.command()
    async def image(self,ctx,url:str):
        await db_execute("UPDATE guilds SET welcome_image=? WHERE guild_id=?",(url,ctx.guild.id)); await ctx.send("🖼️ Welcome image saved.")
    @welcomer.command()
    async def embed(self,ctx,*,raw):
        try: json.loads(raw)
        except json.JSONDecodeError: return await ctx.send("❌ Provide a valid Discord embed JSON object.")
        await db_execute("UPDATE guilds SET welcome_embed=? WHERE guild_id=?",(raw,ctx.guild.id)); await ctx.send("✅ Welcome embed JSON saved.")
    @welcomer.command()
    async def test(self,ctx,member:discord.Member=None):
        member=member or ctx.author; cfg=await get_cfg(ctx.guild.id)
        msg=(cfg["welcome_message"] or "Welcome {user.mention} to **{guild.name}**!")
        msg=msg.replace("{user.mention}",member.mention).replace("{user.name}",member.name).replace("{guild.name}",ctx.guild.name).replace("{guild.member_count}",str(ctx.guild.member_count))
        e=embed("👋 Welcome!",msg)
        if cfg["welcome_image"]: e.set_image(url=cfg["welcome_image"])
        await ctx.send(embed=e)

    @commands.group(invoke_without_command=True)
    @has_admin()
    async def logging(self,ctx):
        rows=await db_execute("SELECT category,channel_id FROM logging WHERE guild_id=?",(ctx.guild.id,),fetch=True)
        await ctx.send(embed=embed("📝 Logging", "\n".join(f"**{r[0]}** → <#{r[1]}>" for r in rows) or "No logging categories configured."))

    @logging.command()
    async def enable(self,ctx,category:str,channel:discord.TextChannel):
        if category not in LOG_CATEGORIES: return await ctx.send("❌ Unknown category. Use `!logging categories`.")
        await db_execute("INSERT OR REPLACE INTO logging(guild_id,category,channel_id) VALUES(?,?,?)",(ctx.guild.id,category,channel.id)); await ctx.send(f"📝 Enabled `{category}` → {channel.mention}")
    @logging.command()
    async def disable(self,ctx,category:str):
        await db_execute("DELETE FROM logging WHERE guild_id=? AND category=?",(ctx.guild.id,category)); await ctx.send(f"Disabled `{category}`.")
    @logging.command()
    async def enableall(self,ctx,channel:discord.TextChannel):
        await db_execute("DELETE FROM logging WHERE guild_id=?",(ctx.guild.id,))
        await db_execute("INSERT INTO logging(guild_id,category,channel_id) VALUES(?,?,?)",[(ctx.guild.id,c,channel.id) for c in LOG_CATEGORIES],many=True)
        await ctx.send(f"📝 Enabled all logging categories → {channel.mention}")
    @logging.command()
    async def disableall(self,ctx):
        await db_execute("DELETE FROM logging WHERE guild_id=?",(ctx.guild.id,)); await ctx.send("🧹 All logging categories disabled.")
    @logging.command()
    async def categories(self,ctx): await ctx.send("Available categories:\n`"+"`, `".join(LOG_CATEGORIES)+"`")

class UtilityCog(commands.Cog):
    def __init__(self,bot): self.bot=bot

    @commands.command()
    async def view(self,ctx): await ctx.send("Available view commands: `!myperms`, `!viewperms`, `!botperms`, `!listadmins`, `!viewroles`")
    @commands.command()
    async def myperms(self,ctx):
        perms=[n for n,v in ctx.author.guild_permissions if v]
        await ctx.send(embed=embed("🔐 Your permissions","\n".join(f"• `{p}`" for p in perms)))
    @commands.command()
    async def viewperms(self,ctx,member:discord.Member):
        perms=[n for n,v in member.guild_permissions if v]
        await ctx.send(embed=embed(f"🔐 Permissions: {member}", "\n".join(f"• `{p}`" for p in perms)))
    @commands.command()
    async def botperms(self,ctx):
        me=ctx.guild.me; perms=[n for n,v in me.guild_permissions if v]
        await ctx.send(embed=embed("🤖 Bot permissions","\n".join(f"• `{p}`" for p in perms)))
    @commands.command(name="listadmins")
    async def listadmins(self,ctx):
        humans=[]; bots=[]
        for m in ctx.guild.members:
            if m.guild_permissions.administrator:
                (bots if m.bot else humans).append(m.mention)
        await ctx.send(embed=embed("👑 Administrators",f"**Humans:** {', '.join(humans) or 'None'}\n**Bots:** {', '.join(bots) or 'None'}"))
    @commands.command(name="list")
    async def list_cmd(self,ctx,*args):
        if args and args[0].lower()=="admins": await self.listadmins(ctx)
        else: await ctx.send("Use `!list admins`.")
    @commands.command()
    @has_mod()
    async def viewroles(self,ctx,member:discord.Member=None):
        member=member or ctx.author
        roles=[f"{r.mention} — `{r.position}`" for r in reversed(member.roles) if not r.is_default()]
        await ctx.send(embed=embed(f"🎭 Roles: {member}","\n".join(roles) or "None"))
    @commands.group(invoke_without_command=True)
    @has_admin()
    async def prefix(self,ctx):
        await ctx.send(f"Current prefix: `{await get_prefix(ctx.guild.id)}`")
    @prefix.command()
    async def set(self,ctx,prefix:str): 
        if not 1<=len(prefix)<=5: return await ctx.send("Prefix must be 1-5 characters.")
        await set_prefix(ctx.guild.id,prefix); await ctx.send(f"Prefix set to `{prefix}`")
    @prefix.command()
    async def reset(self,ctx): await set_prefix(ctx.guild.id,"!"); await ctx.send("Prefix reset to `!`.")
    @prefix.command()
    async def show(self,ctx): await ctx.send(f"`{await get_prefix(ctx.guild.id)}`")
    @prefix.command()
    async def add(self,ctx,prefix:str): await self.set.callback(self,ctx,prefix)  # alias behavior
    @prefix.command()
    async def remove(self,ctx,prefix:str): await ctx.send("Use `!prefix reset` to return to the default prefix.")
    @commands.command()
    @has_admin()
    async def setprefix(self,ctx,prefix:str): await set_prefix(ctx.guild.id,prefix); await ctx.send(f"Prefix set to `{prefix}`")
    @commands.command()
    async def botsettings(self,ctx):
        cfg=await get_cfg(ctx.guild.id); await ctx.send(embed=embed("⚙️ Bot Settings",f"Prefix: `{cfg['prefix']}`\nDB: persistent SQLite\nAntinuke: `{bool(cfg['antinuke_enabled'])}`\nAntiraid: `{bool(cfg['antiraid_enabled'])}`"))

class VoiceTrackingCog(commands.Cog):
    def __init__(self,bot): self.bot=bot

    def voice_target(self,ctx,member):
        return member.voice.channel if member and member.voice else None
    async def voice_action(self,ctx,action,member):
        ch=self.voice_target(ctx,member)
        if not ch: return await ctx.send("❌ User is not in a voice channel.")
        if action=="kick": await member.move_to(None,reason="VC command")
        elif action=="mute": await member.edit(mute=True,reason="VC command")
        elif action=="deafen": await member.edit(deafen=True,reason="VC command")
        elif action=="pull": await member.move_to(ctx.author.voice.channel,reason="VC pull")
        await ctx.send(f"🔊 `{action}` applied to {member.mention}.")
    @commands.command()
    @has_mod()
    async def vckick(self,ctx,member:discord.Member): await self.voice_action(ctx,"kick",member)
    @commands.command()
    @has_mod()
    async def vcpull(self,ctx,member:discord.Member): await self.voice_action(ctx,"pull",member)
    @commands.command()
    @has_mod()
    async def vcmute(self,ctx,member:discord.Member): await self.voice_action(ctx,"mute",member)
    @commands.command()
    @has_mod()
    async def vcdeafen(self,ctx,member:discord.Member): await self.voice_action(ctx,"deafen",member)
    async def all_voice(self,ctx,action):
        if not ctx.author.voice: return await ctx.send("❌ You are not in a voice channel.")
        members=list(ctx.author.voice.channel.members); count=0
        for m in members:
            if m==ctx.author: continue
            try: await self.voice_action(ctx,action,m); count+=1
            except discord.HTTPException: pass
        await ctx.send(f"Done for **{count}** members.")
    @commands.command()
    @has_admin()
    async def vcpullall(self,ctx):
        if not ctx.author.voice: return await ctx.send("❌ Join a voice channel first.")
        source=ctx.author.voice.channel; count=0
        for ch in ctx.guild.voice_channels:
            for m in list(ch.members):
                if m==ctx.author: continue
                try: await m.move_to(source,reason="VC pull all"); count+=1
                except discord.HTTPException: pass
        await ctx.send(f"🔊 Pulled **{count}** members.")
    @commands.command()
    @has_admin()
    async def vckickall(self,ctx):
        if not ctx.author.voice: return await ctx.send("❌ Join a voice channel first.")
        count=0
        for ch in ctx.guild.voice_channels:
            for m in list(ch.members):
                if m==ctx.author: continue
                try: await m.move_to(None,reason="VC kick all"); count+=1
                except discord.HTTPException: pass
        await ctx.send(f"🔊 Kicked **{count}** voice members.")
    @commands.command()
    @has_admin()
    async def vcdeafenall(self,ctx):
        count=0
        for ch in ctx.guild.voice_channels:
            for m in ch.members:
                try: await m.edit(deafen=True,reason="VC deafen all"); count+=1
                except discord.HTTPException: pass
        await ctx.send(f"🔇 Deafened **{count}** members.")
    @commands.group(invoke_without_command=True)
    @has_admin()
    async def vcrole(self,ctx): 
        cfg=await get_cfg(ctx.guild.id); await ctx.send(f"Voice role: <@&{cfg['voice_role']}> " if cfg["voice_role"] else "Voice role disabled.")
    @vcrole.command()
    async def add(self,ctx,role:discord.Role):
        await db_execute("UPDATE guilds SET voice_role=? WHERE guild_id=?",(role.id,ctx.guild.id)); await ctx.send(f"✅ Voice role set to {role.mention}")
    @vcrole.command()
    async def remove(self,ctx):
        await db_execute("UPDATE guilds SET voice_role=NULL WHERE guild_id=?",(ctx.guild.id,)); await ctx.send("🧹 Voice role removed.")
    @vcrole.command()
    async def show(self,ctx): await self.vcrole(ctx)

    @commands.command()
    async def leaderboard(self,ctx,kind="messages"):
        rows=await db_execute("SELECT user_id,messages,daily_messages FROM stats WHERE guild_id=? ORDER BY messages DESC LIMIT 10",(ctx.guild.id,),fetch=True)
        text="\n".join(f"**{i}.** <@{r[0]}> — {r[1]} messages" for i,r in enumerate(rows,1))
        await ctx.send(embed=embed("🏆 Message Leaderboard",text or "No data yet."))
    @commands.command()
    @has_admin()
    async def viewuser(self,ctx,member:discord.Member):
        r=await db_one("SELECT messages,daily_messages,last_day FROM stats WHERE guild_id=? AND user_id=?",(ctx.guild.id,member.id))
        await ctx.send(embed=embed(f"📈 Stats: {member}",f"Messages: **{r[0] if r else 0}**\nDaily: **{r[1] if r else 0}**"))
    @commands.command()
    @has_admin()
    async def setidentity(self,ctx,member:discord.Member,*,identity):
        await db_execute("INSERT OR REPLACE INTO identities(guild_id,user_id,identity) VALUES(?,?,?)",(ctx.guild.id,member.id,identity)); await ctx.send("✅ Identity saved.")
    @commands.command()
    @has_admin()
    async def removeidentity(self,ctx,member:discord.Member):
        await db_execute("DELETE FROM identities WHERE guild_id=? AND user_id=?",(ctx.guild.id,member.id)); await ctx.send("🧹 Identity removed.")
    @commands.command()
    @has_mod()
    async def adminview(self,ctx):
        rows=await db_execute("SELECT user_id FROM bot_admins",fetch=True); await ctx.send("Bot admins:\n"+("\n".join(f"<@{r[0]}>" for r in rows) or "None"))
    @commands.command()
    @has_mod()
    async def modview(self,ctx):
        rows=await db_execute("SELECT user_id FROM bot_mods",fetch=True); await ctx.send("Bot mods:\n"+("\n".join(f"<@{r[0]}>" for r in rows) or "None"))

class RoleCog(commands.Cog):
    def __init__(self,bot): self.bot=bot

    @commands.group(invoke_without_command=True)
    @has_mod()
    async def role(self,ctx): await ctx.send("Use `!role add/remove/create/delete/colour/rename/all/bots/humans/info/list`.")
    @role.command()
    async def add(self,ctx,member:discord.Member,role:discord.Role): await member.add_roles(role,reason="Role command"); await ctx.send(f"✅ Added {role.mention} to {member.mention}.")
    @role.command()
    async def remove(self,ctx,member:discord.Member,role:discord.Role): await member.remove_roles(role,reason="Role command"); await ctx.send(f"✅ Removed {role.mention}.")
    @role.command()
    async def create(self,ctx,*,name): 
        r=await ctx.guild.create_role(name=name,reason="Role create"); await ctx.send(f"🎭 Created {r.mention}.")
    @role.command()
    async def delete(self,ctx,role:discord.Role): await role.delete(reason="Role delete"); await ctx.send("🗑️ Role deleted.")
    @role.command()
    async def colour(self,ctx,role:discord.Role,hexcode:str):
        h=hexcode.lstrip("#")
        try: c=discord.Colour(int(h,16))
        except ValueError: return await ctx.send("Use a hex colour like `#9B59FF`.")
        await role.edit(colour=c,reason="Role colour"); await ctx.send("🎨 Role colour updated.")
    @role.command()
    async def rename(self,ctx,role:discord.Role,*,name): await role.edit(name=name,reason="Role rename"); await ctx.send("✏️ Role renamed.")
    async def bulk(self,ctx,role,mode):
        members=[m for m in ctx.guild.members if (mode=="all" or (mode=="bots" and m.bot) or (mode=="humans" and not m.bot))]
        count=0
        for m in members:
            try: await m.add_roles(role,reason="Bulk role assignment"); count+=1
            except discord.HTTPException: pass
        await ctx.send(f"🎭 Added {role.mention} to **{count}** members.")
    @role.command()
    async def all(self,ctx,role:discord.Role): await self.bulk(ctx,role,"all")
    @role.command()
    async def bots(self,ctx,role:discord.Role): await self.bulk(ctx,role,"bots")
    @role.command()
    async def humans(self,ctx,role:discord.Role): await self.bulk(ctx,role,"humans")
    @role.command()
    async def info(self,ctx,role:discord.Role):
        await ctx.send(embed=embed(f"🎭 {role.name}",f"ID: `{role.id}`\nPosition: `{role.position}`\nMembers: `{len(role.members)}`\nPermissions: `{role.permissions.value}`"))
    @role.command()
    async def list(self,ctx):
        await ctx.send(embed=embed("🎭 Server Roles","\n".join(f"{r.mention} — {len(r.members)} members" for r in reversed(ctx.guild.roles[1:]))[:4000]))
    @commands.command(name="createrole")
    @has_mod()
    async def createrole(self,ctx,*,name): await self.create.callback(self,ctx,name)

class AutomodCog(commands.Cog):
    def __init__(self,bot): self.bot=bot

    @commands.Cog.listener()
    async def on_message(self,message):
        if not message.guild or message.author.bot: return
        cfg=await get_cfg(message.guild.id)
        if await is_bot_mod(message.author.id): return
        # Whitelist checks are performed below for users and roles.
        role_rows=await db_execute("SELECT target_id FROM automod_whitelist WHERE guild_id=? AND kind='role'",(message.guild.id,),fetch=True)
        if any(message.guild.get_role(r[0]) in message.author.roles for r in role_rows): return
        reasons=[]
        if cfg["automod_strict"] or True:
            # invite/link filter
            if await db_one("SELECT 1 FROM automod_whitelist WHERE guild_id=? AND kind='user' AND target_id=?",(message.guild.id,message.author.id)):
                return
        if cfg["automod_punishment"] != "off":
            if re.search(r"(https?://|www\.|discord\.gg/)",message.content,re.I):
                link_enabled=await db_one("SELECT 1 FROM automod_words WHERE guild_id=? AND word='__antilink_enabled__'",(message.guild.id,))
                if link_enabled: reasons.append("link")
            words=await db_execute("SELECT word FROM automod_words WHERE guild_id=?",(message.guild.id,),fetch=True)
            bad={r[0].lower() for r in words if not r[0].startswith("__")}
            if any(w and re.search(r"\b"+re.escape(w)+r"\b",message.content,re.I) for w in bad): reasons.append("bad word")
            now=time.time(); key=(message.guild.id,message.author.id); q=self.bot.spam_windows[key]; q.append(now)
            while q and now-q[0]>8: q.popleft()
            if len(q)>=7: reasons.append("spam")
        if reasons:
            try: await message.delete(reason="Automod: "+", ".join(reasons))
            except discord.HTTPException: pass
            await log_event(message.guild,"moderation","🤖 Automod action",f"{message.author.mention} — {', '.join(reasons)}",discord.Colour.orange())

    @commands.group(invoke_without_command=True)
    @has_admin()
    async def automod(self,ctx): await ctx.send("Automod: `!antispam`, `!antilink`, `!antiword`, `!automod punishment`")
    @commands.group(invoke_without_command=True)
    @has_admin()
    async def antispam(self,ctx): await ctx.send("Antispam is built in; 7 messages/8 seconds triggers deletion.")
    @antispam.command()
    async def enable(self,ctx): await db_execute("UPDATE guilds SET automod_strict=1 WHERE guild_id=?",(ctx.guild.id,)); await ctx.send("🛡️ Antispam enabled.")
    @antispam.command()
    async def disable(self,ctx): await db_execute("UPDATE guilds SET automod_strict=0 WHERE guild_id=?",(ctx.guild.id,)); await ctx.send("🛑 Antispam disabled.")
    @antispam.command()
    async def wl(self,ctx,action:str,target=None):
        if action=="list":
            rows=await db_execute("SELECT kind,target_id FROM automod_whitelist WHERE guild_id=?",(ctx.guild.id,),fetch=True)
            return await ctx.send("\n".join(f"{r[0]}: <@{r[1]}>" for r in rows) or "Empty.")
        obj=None
        if target and target.startswith("<@&"):
            try: obj=ctx.guild.get_role(int(re.sub(r"\D","",target)))
            except: pass
        if target and target.startswith("<@"):
            try: obj=ctx.guild.get_member(int(re.sub(r"\D","",target)))
            except: pass
        if not obj: return await ctx.send("Mention a user/role.")
        kind="role" if isinstance(obj,discord.Role) else "user"
        if action=="add": await db_execute("INSERT OR IGNORE INTO automod_whitelist VALUES(?,?,?)",(ctx.guild.id,kind,obj.id))
        elif action=="remove": await db_execute("DELETE FROM automod_whitelist WHERE guild_id=? AND kind=? AND target_id=?",(ctx.guild.id,kind,obj.id))
        await ctx.send(f"Whitelist `{action}` complete.")
    @commands.group(invoke_without_command=True)
    @has_admin()
    async def antilink(self,ctx): await ctx.send("Use `!antilink enable/disable/wl add/wl remove/wl list`.")
    @antilink.command()
    async def enable(self,ctx): await db_execute("INSERT OR IGNORE INTO automod_words VALUES(?,?)",(ctx.guild.id,"__antilink_enabled__")); await ctx.send("🔗 Anti-link enabled.")
    @antilink.command()
    async def disable(self,ctx): await db_execute("DELETE FROM automod_words WHERE guild_id=? AND word='__antilink_enabled__'",(ctx.guild.id,)); await ctx.send("🔗 Anti-link disabled.")
    @antilink.command()
    async def wl(self,ctx,action:str,target=None):
        await self._wl(ctx,action,target)
    async def _wl(self,ctx,action,target):
        if action=="list":
            rows=await db_execute("SELECT kind,target_id FROM automod_whitelist WHERE guild_id=?",(ctx.guild.id,),fetch=True); return await ctx.send("\n".join(f"{r[0]}: <@{r[1]}>" for r in rows) or "Empty.")
        if not target: return await ctx.send("Mention a user/role.")
        tid=int(re.sub(r"\D","",target)); kind="role" if "<@&" in target else "user"
        if action=="add": await db_execute("INSERT OR IGNORE INTO automod_whitelist VALUES(?,?,?)",(ctx.guild.id,kind,tid))
        else: await db_execute("DELETE FROM automod_whitelist WHERE guild_id=? AND kind=? AND target_id=?",(ctx.guild.id,kind,tid))
        await ctx.send("Whitelist updated.")
    @commands.group(invoke_without_command=True)
    @has_admin()
    async def antiword(self,ctx): await ctx.send("Use `!antiword enable/disable/add/remove/list/wl add/wl remove/wl list`.")
    @antiword.command()
    async def enable(self,ctx): await ctx.send("Bad-word filtering is active whenever words are configured.")
    @antiword.command()
    async def disable(self,ctx):
        rows=await db_execute("SELECT word FROM automod_words WHERE guild_id=?",(ctx.guild.id,),fetch=True)
        for r in rows:
            if r[0]!="__antilink_enabled__": await db_execute("DELETE FROM automod_words WHERE guild_id=? AND word=?",(ctx.guild.id,r[0]))
        await ctx.send("🧹 Bad-word list cleared.")
    @antiword.command()
    async def add(self,ctx,*,word): await db_execute("INSERT OR IGNORE INTO automod_words VALUES(?,?)",(ctx.guild.id,word.lower())); await ctx.send("🚫 Word added.")
    @antiword.command()
    async def remove(self,ctx,*,word): await db_execute("DELETE FROM automod_words WHERE guild_id=? AND word=?",(ctx.guild.id,word.lower())); await ctx.send("🧹 Word removed.")
    @antiword.command()
    async def list(self,ctx):
        rows=await db_execute("SELECT word FROM automod_words WHERE guild_id=?",(ctx.guild.id,),fetch=True)
        await ctx.send("\n".join(f"• `{r[0]}`" for r in rows if r[0]!="__antilink_enabled__") or "No words.")
    @antiword.command()
    async def wl(self,ctx,action:str,target=None): await self._wl(ctx,action,target)
    @automod.command()
    async def punishment(self,ctx,action:str):
        if action not in ("delete","warn","timeout","off"): return await ctx.send("Use `delete`, `warn`, `timeout`, or `off`.")
        await db_execute("UPDATE guilds SET automod_punishment=? WHERE guild_id=?",(action,ctx.guild.id)); await ctx.send(f"Automod punishment: **{action}**")

class OwnerCog(commands.Cog):
    def __init__(self,bot): self.bot=bot

    async def check_owner(self,interaction):
        return await is_global_owner(interaction.user.id)

    async def owner_lock(self,guild):
        await emergency_lock(guild,"Owner lockdown")

    async def owner_unlock(self,guild):
        await emergency_unlock(guild,"Owner unlock")

    owner_group=app_commands.Group(name="owner",description="Bot-owner-only server control")

    @owner_group.command(name="lockdown",description="Lock the entire server")
    async def lockdown(self,interaction:discord.Interaction):
        if not await self.check_owner(interaction): return await interaction.response.send_message("❌ Bot owner only.",ephemeral=True)
        await self.owner_lock(interaction.guild); await interaction.response.send_message("🚨 Server lockdown activated.")

    @owner_group.command(name="unlock",description="Unlock the entire server")
    async def unlock(self,interaction:discord.Interaction):
        if not await self.check_owner(interaction): return await interaction.response.send_message("❌ Bot owner only.",ephemeral=True)
        await self.owner_unlock(interaction.guild); await interaction.response.send_message("🟢 Server unlocked.")

    @owner_group.command(name="slowmode-all",description="Apply slowmode to all text channels")
    @app_commands.describe(seconds="0-21600 seconds")
    async def slowmode_all(self,interaction:discord.Interaction,seconds:int):
        if not await self.check_owner(interaction): return await interaction.response.send_message("❌ Bot owner only.",ephemeral=True)
        seconds=max(0,min(21600,seconds)); count=0
        for ch in interaction.guild.text_channels:
            try: await ch.edit(slowmode_delay=seconds,reason="Owner slowmode-all"); count+=1
            except discord.HTTPException: pass
        await interaction.response.send_message(f"🐢 Set slowmode to **{seconds}s** in {count} channels.")

    @owner_group.command(name="emergency",description="Activate emergency protection")
    async def emergency(self,interaction:discord.Interaction):
        if not await self.check_owner(interaction): return await interaction.response.send_message("❌ Bot owner only.",ephemeral=True)
        await take_snapshot(interaction.guild); await emergency_lock(interaction.guild,"Owner emergency mode")
        await interaction.response.send_message("🚨 Emergency protection activated and recovery snapshot saved.")

    @owner_group.command(name="add",description="Add a bot owner")
    async def add(self,interaction:discord.Interaction,user:discord.User):
        if interaction.user.id!=BOT_OWNER_ID: return await interaction.response.send_message("❌ Initial owner only.",ephemeral=True)
        await db_execute("INSERT OR IGNORE INTO bot_owners(user_id) VALUES(?)",(user.id,)); await interaction.response.send_message(f"👑 Added {user.mention} as bot owner.")

    @owner_group.command(name="remove",description="Remove a bot owner")
    async def remove(self,interaction:discord.Interaction,user:discord.User):
        if interaction.user.id!=BOT_OWNER_ID: return await interaction.response.send_message("❌ Initial owner only.",ephemeral=True)
        if user.id==BOT_OWNER_ID: return await interaction.response.send_message("❌ The initial owner cannot be removed.",ephemeral=True)
        await db_execute("DELETE FROM bot_owners WHERE user_id=?",(user.id,)); await interaction.response.send_message(f"Removed {user.mention} from bot owners.")

    @owner_group.command(name="list",description="List bot owners")
    async def list_(self,interaction:discord.Interaction):
        if not await self.check_owner(interaction): return await interaction.response.send_message("❌ Bot owner only.",ephemeral=True)
        rows=await db_execute("SELECT user_id FROM bot_owners",fetch=True)
        await interaction.response.send_message("👑 Owners:\n"+"\n".join(f"<@{r[0]}>" for r in rows))

    @owner_group.command(name="transfer",description="Transfer initial bot ownership")
    async def transfer(self,interaction:discord.Interaction,user:discord.User):
        if interaction.user.id!=BOT_OWNER_ID: return await interaction.response.send_message("❌ Initial owner only.",ephemeral=True)
        await db_execute("INSERT OR IGNORE INTO bot_owners(user_id) VALUES(?)",(user.id,))
        await interaction.response.send_message(f"⚠️ Added {user.mention} as an owner. The environment variable `BOT_OWNER_ID` remains the immutable deployment owner; change it in Railway Variables for a full transfer.")

    @owner_group.command(name="permissions",description="Show your owner permissions")
    async def permissions(self,interaction:discord.Interaction):
        if not await self.check_owner(interaction): return await interaction.response.send_message("❌ Bot owner only.",ephemeral=True)
        await interaction.response.send_message("👑 Owner permissions: server lockdown, unlock, slowmode-all, emergency, owner management and audit.",ephemeral=True)

    @owner_group.command(name="audit",description="Show recent sensitive owner actions")
    async def audit(self,interaction:discord.Interaction):
        if not await self.check_owner(interaction): return await interaction.response.send_message("❌ Bot owner only.",ephemeral=True)
        await interaction.response.send_message("🔎 Sensitive actions are sent to configured logging/anti-nuke channels when available.",ephemeral=True)

bot.tree.add_command(OwnerCog.owner_group)

@bot.event
async def on_command_error(ctx,error):
    if isinstance(error,commands.CommandNotFound): return
    if isinstance(error,commands.MissingPermissions): return await ctx.send("❌ You do not have permission.")
    if isinstance(error,commands.CheckFailure): return await ctx.send("❌ You do not have permission to use this command.")
    if isinstance(error,commands.MissingRequiredArgument): return await ctx.send(f"❌ Missing argument: `{error.param.name}`")
    if isinstance(error,commands.BadArgument): return await ctx.send("❌ Invalid argument. Mention the user/role or use the expected format.")
    if isinstance(error,commands.NoPrivateMessage): return await ctx.send("❌ This command only works in a server.")
    log.error("Command error: %s",error)
    await ctx.send("❌ Something went wrong while running that command.")

async def main():
    async with bot:
        await bot.start(TOKEN)

if __name__=="__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
