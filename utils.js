import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { guildConfig, saveState, state } from './store.js';

export const COLORS = { main:0x8b5cf6, good:0x22c55e, warn:0xf59e0b, bad:0xef4444 };
export function makeEmbed(title, description, color=COLORS.main) { return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp(); }
export async function safeReply(message, payload) { try { return await message.reply(payload); } catch { return null; } }
export function isBotOwner(id) { return state.owners.includes(String(id)); }
export function can(member, permission) { return Boolean(member?.permissions?.has(permission)); }
export async function requirePermission(message, permission) {
  if (!can(message.member, permission)) { await safeReply(message, `❌ You need **${permission}** permission.`); return false; }
  return true;
}
export async function requireGuild(message) { if (!message.guild) { await safeReply(message,'❌ This command can only be used in a server.'); return false; } return true; }
export async function requireOwner(message) { if (!isBotOwner(message.author.id)) { await safeReply(message,'❌ Owner-only command.'); return false; } return true; }
export function mentionedMember(message) { return message.mentions.members.first() || null; }
export function mentionedUser(message) { return message.mentions.users.first() || null; }
export function parseDuration(value) { const m=String(value||'').match(/^(\d+)(s|m|h|d)$/i); if(!m)return null; const n=Number(m[1]); return n*({s:1000,m:60000,h:3600000,d:86400000}[m[2].toLowerCase()]); }
export function formatWelcome(text, member) { return String(text).replaceAll('{user.mention}',member.toString()).replaceAll('{user.name}',member.user.username).replaceAll('{guild.name}',member.guild.name).replaceAll('{guild.member_count}',String(member.guild.memberCount)); }
export function cleanMentionArgs(args) { return args.filter(x => !/^<@!?\d+>$/.test(x) && !/^<@&\d+>$/.test(x) && !/^<#\d+>$/.test(x)); }
export function auditOwner(action, actor, target=null) { state.ownerAudit.unshift({at:Date.now(),actor:String(actor),action,target:target?String(target):null}); state.ownerAudit=state.ownerAudit.slice(0,100); return saveState(); }
export async function logEvent(guild, category, title, description, color=COLORS.main) {
  const c=guildConfig(guild.id); const channelId=c.logging[category] || c.logging.moderation || c.logging.server; if(!channelId)return;
  const ch=guild.channels.cache.get(channelId); if(!ch?.isTextBased())return;
  await ch.send({embeds:[makeEmbed(title,description,color)]}).catch(()=>{});
}
export async function setServerLock(guild, locked, reason='Server control') {
  for (const ch of guild.channels.cache.values()) {
    if (ch.isTextBased() && ch.permissionOverwrites?.edit) await ch.permissionOverwrites.edit(guild.roles.everyone,{SendMessages:locked?false:null},{reason}).catch(()=>{});
  }
  guildConfig(guild.id).antinuke.lockdown = locked; await saveState();
}
export async function getAuditExecutor(guild, type, targetId) {
  try { const logs=await guild.fetchAuditLogs({limit:8,type}); for(const entry of logs.entries.values()) if(!targetId || entry.target?.id===targetId) return entry.executor; } catch {}
  return null;
}
export function authorizedExecutor(guild, user) {
  if (!user) return true;
  if (user.id===guild.ownerId || isBotOwner(user.id)) return true;
  const c=guildConfig(guild.id); if(c.antinuke.whitelistUsers.includes(user.id)) return true;
  const member=guild.members.cache.get(user.id); return Boolean(member && member.roles.cache.some(r=>c.antinuke.whitelistRoles.includes(r.id)));
}
