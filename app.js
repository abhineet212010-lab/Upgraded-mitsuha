import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  Client, GatewayIntentBits, Partials, PermissionsBitField, PermissionFlagsBits,
  EmbedBuilder, Collection, ChannelType, AuditLogEvent, ActivityType,
  AttachmentBuilder
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('DISCORD_TOKEN is missing. Set it in Railway Variables.'); process.exit(1); }
const DATA_DIR = process.env.DATA_DIR || '/app/data';
await fs.mkdir(DATA_DIR, {recursive:true});
const FILE = path.join(DATA_DIR,'state.json');
const DEFAULT = {
  prefix:'!',
  guilds:{},
  owners: process.env.BOT_OWNER_ID ? [process.env.BOT_OWNER_ID] : [],
  ownerAudit: []
};
let state = DEFAULT;
try { state = {...DEFAULT, ...JSON.parse(await fs.readFile(FILE,'utf8'))}; } catch {}
state.guilds ||= {}; state.owners ||= []; state.ownerAudit ||= [];
const save = async()=>{ const tmp=FILE+'.tmp'; await fs.writeFile(tmp,JSON.stringify(state,null,2)); await fs.rename(tmp,FILE); };

const client = new Client({
  intents:[
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildInvites
  ],
  partials:[Partials.Channel,Partials.Message,Partials.GuildMember,Partials.User]
});
client.commands = new Collection();
const deleted = new Map(), edited = new Map(), afk = new Map(), joinWindows = new Map();

const LOG_CATS = ['message','member','moderation','channel','role','voice','server','invite','automod','antinuke','antiraid','owner','joinleave'];
const defaultGuild = ()=>({
  prefix:'!', warnings:{}, nickLocks:[], afk: {},
  logging:Object.fromEntries(LOG_CATS.map(x=>[x,null])),
  welcome:{enabled:false,channelId:null,message:'Welcome {user.mention} to **{guild.name}**! You are member #{guild.member_count}.',image:null,embed:null},
  antinuke:{enabled:false,punishment:'striproles',logChannelId:null,strict:false,lockdown:false,panic:false,whitelistUsers:[],whitelistRoles:[],limits:{channelDelete:3,channelCreate:5,roleDelete:3,roleCreate:5,kick:5,ban:5}},
  antiraid:{enabled:false,action:'kick',threshold:5,windowSeconds:10,lockdown:false,ageLimit:0,verification:false,avatarCheck:false,deleteInvites:false},
  automod:{antispam:false,antilink:false,antiword:false,punishment:'delete',spamWindow:5000,spamLimit:5,words:[],whitelists:{antispam:{users:[],roles:[]},antilink:{users:[],roles:[]},antiword:{users:[],roles:[]}}},
  vcrole:null, identities:{}, tracking:{messages:{},daily:{},invites:{}},
  snapshot:null, emergency:false
});
function cfg(g){ if(!state.guilds[g]) state.guilds[g]=defaultGuild(); return state.guilds[g]; }
function isBotOwner(id){ return state.owners.includes(String(id)); }
function isOwner(msg){ return isBotOwner(msg.author.id); }
function has(member,p){ return member?.permissions?.has(p); }
function me(g){ return g.members.me; }
function canAct(member,target){
  return member && target && target.id!==member.guild.ownerId && target.id!==member.id && member.roles.highest.comparePositionTo(target.roles.highest)>0;
}
function parseDuration(s){
  if(!s) return null; const m=String(s).match(/^(\d+)(s|m|h|d)$/i); if(!m) return null;
  const n=Number(m[1]), u=m[2].toLowerCase(); return n*(u==='s'?1000:u==='m'?60000:u==='h'?3600000:86400000);
}
function cleanText(s){return String(s??'').replace(/`/g,'');}
function embed(title,description,color=0x8b5cf6){return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();}
async function reply(msg,content){try{return await msg.reply(content)}catch{}}
async function log(g,cat,title,description,color=0x8b5cf6){
  const c=cfg(g).logging[cat] || cfg(g).logging.moderation || cfg(g).logging.server;
  if(!c) return; const ch=g.channels.cache.get(c); if(!ch?.isTextBased()) return;
  await ch.send({embeds:[embed(title,description,color)]}).catch(()=>{});
}
function formatWelcome(text,member){
  return text.replaceAll('{user.mention}',member.toString()).replaceAll('{user.name}',member.user.username)
    .replaceAll('{guild.name}',member.guild.name).replaceAll('{guild.member_count}',String(member.guild.memberCount));
}
function argsAndRest(args){return [args[0],args.slice(1).join(' ').trim()];}
async function ensureGuild(msg){ if(!msg.guild){await reply(msg,'❌ This command can only be used in a server.'); return false;} return true; }
async function requirePerm(msg,p){if(!has(msg.member,p)){await reply(msg,`❌ You need **${new PermissionsBitField(p).toArray().join(', ')||'the required'}** permission.`);return false}return true}
async function requireOwner(msg){if(!isOwner(msg)){await reply(msg,'❌ Owner-only command.');return false}return true}
function mentionedUser(msg){return msg.mentions.users.first() || null}
function mentionedMember(msg){return msg.mentions.members.first() || null}

async function snapshotGuild(g){
  const snap={at:Date.now(),name:g.name,channels:[],roles:[]};
  for(const r of [...g.roles.cache.values()].sort((a,b)=>a.position-b.position)){
    if(r.managed) continue;
    snap.roles.push({id:r.id,name:r.name,color:r.hexColor,hoist:r.hoist,mentionable:r.mentionable,permissions:r.permissions.bitfield.toString(),position:r.position});
  }
  for(const c of g.channels.cache.values()){
    snap.channels.push({
      id:c.id,name:c.name,type:c.type,parentId:c.parentId,position:c.rawPosition,topic:c.isTextBased?.()?c.topic:null,
      nsfw:c.isTextBased?.()?c.nsfw:false,rateLimitPerUser:c.isTextBased?.()?c.rateLimitPerUser:0,
      bitrate:c.isVoiceBased?.()?c.bitrate:null,userLimit:c.isVoiceBased?.()?c.userLimit:null
    });
  }
  cfg(g.id).snapshot=snap; await save(); return snap;
}
async function restoreSnapshot(g){
  const snap=cfg(g).snapshot; if(!snap) return 0; let n=0;
  const roleByName=new Map(g.roles.cache.map(r=>[r.name,r]));
  for(const r of snap.roles){
    if(roleByName.has(r.name)) continue;
    try{await g.roles.create({name:r.name,color:r.color==='NotQuiteBlack'?0:r.color,hoist:r.hoist,mentionable:r.mentionable,permissions:BigInt(r.permissions),reason:'Automatic disaster recovery'});n++}catch{}
  }
  const catMap=new Map();
  for(const c of snap.channels.filter(x=>x.type===ChannelType.GuildCategory).sort((a,b)=>a.position-b.position)){
    let ch=g.channels.cache.find(x=>x.type===ChannelType.GuildCategory&&x.name===c.name);
    if(!ch) try{ch=await g.channels.create({name:c.name,type:ChannelType.GuildCategory,reason:'Automatic disaster recovery'});n++}catch{}
    if(ch)catMap.set(c.id,ch);
  }
  for(const c of snap.channels.filter(x=>x.type!==ChannelType.GuildCategory).sort((a,b)=>a.position-b.position)){
    if(g.channels.cache.find(x=>x.name===c.name&&x.type===c.type))continue;
    try{
      const o={name:c.name,type:c.type,parent:catMap.get(c.parentId),reason:'Automatic disaster recovery'};
      if(c.type===ChannelType.GuildText){o.topic=c.topic||undefined;o.nsfw=c.nsfw;o.rateLimitPerUser=c.rateLimitPerUser||0}
      if(c.type===ChannelType.GuildVoice){o.bitrate=c.bitrate||64000;o.userLimit=c.userLimit||0}
      await g.channels.create(o);n++;
    }catch{}
  }
  await log(g,'antinuke','🛠️ Disaster Recovery',`Best-effort recovery restored **${n}** missing server items.`,0x22c55e);
  return n;
}
async function auditExecutor(g,action,targetId){
  try{
    const logs=await g.fetchAuditLogs({limit:8,type:action});
    for(const e of logs.entries.values()) if(!targetId||e.target?.id===targetId) return e.executor;
  }catch{}
  return null;
}
async function authorizedNuker(g,user){
  if(!user)return true;
  if(user.id===g.ownerId||isBotOwner(user.id))return true;
  const c=cfg(g.id);
  if(c.antinuke.whitelistUsers.includes(user.id))return true;
  const m=g.members.cache.get(user.id); return !!m&&m.roles.cache.some(r=>c.antinuke.whitelistRoles.includes(r.id));
}
async function punishNuker(g,user,reason){
  const c=cfg(g.id); if(!c.antinuke.enabled||await authorizedNuker(g,user))return;
  const m=user&&g.members.cache.get(user.id); let action=c.antinuke.punishment;
  try{
    if(m&&m.id!==g.ownerId){
      if(action==='ban'&&m.bannable)await m.ban({reason});
      else if(action==='kick'&&m.kickable)await m.kick(reason);
      else if(action==='striproles'){
        const rs=m.roles.cache.filter(r=>r.id!==g.id&&!r.managed&&r.position<g.members.me.roles.highest.position);
        if(rs.size)await m.roles.remove(rs,reason);
      }
    }
  }catch{}
  await log(g,'antinuke','🚨 Anti-nuke action',`Executor: ${user?.tag||'Unknown'}\nAction: **${action}**\nReason: ${reason}`,0xef4444);
  if(c.antinuke.strict||c.antinuke.lockdown) await setServerLock(g,true,'Anti-nuke lockdown');
}
async function setServerLock(g,on,reason){
  for(const ch of g.channels.cache.values()) if(ch.isTextBased()&&ch.permissionOverwrites?.edit){
    await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:on?false:null},{reason}).catch(()=>{});
  }
  cfg(g.id).antinuke.lockdown=on; await save();
}
async function deleteInvites(g){try{const inv=await g.invites.fetch();for(const i of inv.values())await i.delete('Anti-raid invite destruction').catch(()=>{});}catch{}}
async function roleWhitelist(c,sub,msg){
  const u=mentionedUser(msg), r=msg.mentions.roles.first(), id=u?.id||r?.id; const kind=u?'users':'roles';
  if(!id)return reply(msg,'❌ Mention a user or role.');
  const arr=c.whitelists?.[sub]?.[kind]; if(!arr)return reply(msg,'❌ Invalid whitelist target.');
  if(msg.content.includes(' add ')){if(!arr.includes(id))arr.push(id);await save();return reply(msg,`✅ Added to ${sub} whitelist.`)}
  if(msg.content.includes(' remove ')){c.whitelists[sub][kind]=arr.filter(x=>x!==id);await save();return reply(msg,`✅ Removed from ${sub} whitelist.`)}
  return reply(msg,`**${sub} whitelist**\nUsers: ${c.whitelists[sub].users.length}\nRoles: ${c.whitelists[sub].roles.length}`);
}

async function handleCommand(msg,name,args){
  const g=msg.guild, c=g&&cfg(g.id), member=msg.member;
  const fail=async(p)=>await requirePerm(msg,p);

  // GENERAL
  if(name==='ping')return reply(msg,`🏓 Pong! **${Math.round(client.ws.ping)}ms**`);
  if(name==='av'){const u=mentionedUser(msg)||msg.author;return reply(msg,{embeds:[embed(`${u.username}'s Avatar`,`[Open full size](${u.displayAvatarURL({size:4096,dynamic:true})})`).setImage(u.displayAvatarURL({size:4096,dynamic:true}))]})}
  if(name==='ab'){const u=mentionedUser(msg)||msg.author;const user=await client.users.fetch(u.id,{force:true}).catch(()=>u);const b=user.bannerURL({size:4096,dynamic:true});return reply(msg,b?{embeds:[embed(`${u.username}'s Banner`,`[Open full size](${b})`).setImage(b)]}:'❌ This user has no banner.')}
  if(name==='poll'){if(!args.length)return reply(msg,'Usage: `!poll <question>`');return reply(msg,{embeds:[embed('📊 Poll',args.join(' '))],content:'👍 **Yes**   👎 **No**'}).then(async m=>{await m.react('👍');await m.react('👎');})}
  if(name==='botinvite'){const u=client.user;return reply(msg,`🔗 https://discord.com/oauth2/authorize?client_id=${u.id}&scope=bot%20applications.commands&permissions=8`)}
  if(name==='serverinfo'){return reply(msg,{embeds:[embed(`📊 ${g.name}`,`**Owner:** <@${g.ownerId}>\n**Members:** ${g.memberCount}\n**Channels:** ${g.channels.cache.size}\n**Roles:** ${g.roles.cache.size}\n**Boosts:** ${g.premiumSubscriptionCount||0}\n**Created:** <t:${Math.floor(g.createdTimestamp/1000)}:F>\n**ID:** \`${g.id}\``)]})}
  if(name==='afk'){const reason=args.join(' ')||'AFK';afk.set(msg.author.id,{reason,at:Date.now()});return reply(msg,`💤 AFK set: **${reason}**`)}
  if(name==='snipe'){const x=deleted.get(msg.channel.id);return reply(msg,x?{embeds:[embed('🗑️ Deleted Message',`**${x.author}**\n${x.content||'*No text*'}`)]}:'❌ Nothing to snipe.')}
  if(name==='esnipe'){const x=edited.get(msg.channel.id);return reply(msg,x?{embeds:[embed('✏️ Edited Message',`**${x.author}**\nBefore: ${x.before||'*No text*'}\nAfter: ${x.after||'*No text*'}`)]}:'❌ Nothing to esnipe.')}

  // MODERATION
  if(['kick','ban','mute','unmute','warn','warnings','delwarn','clearwarnings','nick'].includes(name)){
    if(!await fail(PermissionFlagsBits.ModerateMembers)) return;
  }
  if(name==='kick' && !await fail(PermissionFlagsBits.KickMembers)) return;
  if(name==='ban' && !await fail(PermissionFlagsBits.BanMembers)) return;
  if(name==='unban' && !await fail(PermissionFlagsBits.BanMembers)) return;
  if(['purge'].includes(name) && !await fail(PermissionFlagsBits.ManageMessages)) return;
  if(['lock','unlock','hide','unhide','lockall','unlockall'].includes(name) && !await fail(PermissionFlagsBits.ManageChannels)) return;
  if(name==='kick'||name==='ban'||name==='mute'||name==='unmute'){
    const m=mentionedMember(msg);if(!m||!canAct(member,m))return reply(msg,'❌ Mention a member you can manage.');
    const reason=args.filter(x=>!x.startsWith('<@')).join(' ')||'No reason provided';
    try{if(name==='kick')await m.kick(reason);if(name==='ban')await m.ban({reason});if(name==='mute')await m.timeout(parseDuration(args.find(x=>/^\d+[smhd]$/i.test(x)))||3600000,reason);if(name==='unmute')await m.timeout(null,reason);return reply(msg,`✅ ${name} completed for **${m.user.tag}**.`)}catch(e){return reply(msg,`❌ ${e.message}`)}
  }
  if(name==='unban'){const id=args[0]?.replace(/\D/g,'');if(!id)return reply(msg,'Usage: `!unban <user ID>`');try{await g.members.unban(id);return reply(msg,'✅ User unbanned.')}catch(e){return reply(msg,`❌ ${e.message}`)}}
  if(name==='warn'){const m=mentionedMember(msg);if(!m||m.id===msg.author.id)return reply(msg,'❌ Mention a member.');const reason=args.filter(x=>!x.startsWith('<@')).join(' ')||'No reason provided';c.warnings[m.id] ||= [];const id=Date.now().toString(36);c.warnings[m.id].push({id,moderator:msg.author.id,reason,at:Date.now()});await save();await log(g,'moderation','⚠️ Warning',`${m} was warned by ${msg.author}.\nReason: ${reason}`);return reply(msg,`⚠️ Warned ${m} — ID \`${id}\``)}
  if(name==='warnings'){const m=mentionedMember(msg)||member;const ws=c.warnings[m.id]||[];return reply(msg,{embeds:[embed(`Warnings: ${m.user.tag}`,ws.length?ws.map((w,i)=>`**${i+1}.** \`${w.id}\` — ${w.reason} — <@${w.moderator}>`).join('\n'):'No warnings.') ]})}
  if(name==='delwarn'){const id=args[0];if(!id)return reply(msg,'Usage: `!delwarn <ID>`');let found=false;for(const uid of Object.keys(c.warnings)){const old=c.warnings[uid]||[];const nw=old.filter(w=>w.id!==id);if(nw.length!==old.length){c.warnings[uid]=nw;found=true}}await save();return reply(msg,found?'✅ Warning deleted.':'❌ Warning ID not found.')}
  if(name==='clearwarnings'){const m=mentionedMember(msg);if(!m)return reply(msg,'Mention a member.');c.warnings[m.id]=[];await save();return reply(msg,'✅ Warnings cleared.')}
  if(name==='nick'){
    const sub=args[0]; const m=mentionedMember(msg);
    if(sub==='lock'||sub==='unlock'){if(!m)return reply(msg,'Mention a member.');c.nickLocks=sub==='lock'?[...new Set([...c.nickLocks,m.id])]:c.nickLocks.filter(x=>x!==m.id);await save();return reply(msg,`✅ Nick lock ${sub}ed for ${m}.`)}
    if(!m)return reply(msg,'Usage: `!nick @user <nickname>`');const nick=args.slice(1).join(' ')||null;try{await m.setNickname(nick,'Nickname command');return reply(msg,'✅ Nickname updated.')}catch(e){return reply(msg,`❌ ${e.message}`)}
  }
  if(name==='purge'){
    const n=Math.min(Math.max(Number(args[0])||0,1),100); if(args[0]==='bot'){const msgs=await msg.channel.messages.fetch({limit:100});const del=msgs.filter(x=>x.author.bot);await msg.channel.bulkDelete(del,true);return reply(msg,`🧹 Deleted **${del.size}** bot messages.`).then(x=>setTimeout(()=>x.delete().catch(()=>{}),3000))}
    let count=n;let user=mentionedMember(msg);if(user)count=Math.min(Number(args[2])||Number(args[1])||10,100);
    const msgs=await msg.channel.messages.fetch({limit:100});const filtered=user?msgs.filter(x=>x.author.id===user.id).first(count):msgs.first(count);const arr=Array.isArray(filtered)?filtered:[...filtered];await msg.channel.bulkDelete(arr,true);return reply(msg,`🧹 Deleted **${arr.length}** messages.`)
  }
  if(['lock','unlock','hide','unhide'].includes(name)){const on=['lock','hide'].includes(name);await msg.channel.permissionOverwrites.edit(g.roles.everyone,on?{SendMessages:name==='lock'?false:null,ViewChannel:name==='hide'?false:null}:{SendMessages:name==='unlock'?null:undefined,ViewChannel:name==='unhide'?null:undefined});return reply(msg,`✅ Channel ${name}ed.`)}
  if(name==='lockall'||name==='unlockall'){for(const ch of g.channels.cache.values())if(ch.isTextBased())await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:name==='lockall'?false:null}).catch(()=>{});return reply(msg,`✅ All text channels ${name==='lockall'?'locked':'unlocked'}.`)}

  // ANTINUKE
  if(name==='antinuke'||name==='antiraid'||name==='welcomer'||name==='logging'||name==='automod'||name==='botsettings'||name==='view') {
    if(name==='view'||name==='botsettings') return reply(msg,{embeds:[embed('🔧 Bot Settings','Use the requested command groups and their subcommands. Prefix: `'+c.prefix+'`')]});
    if(name==='antinuke')return reply(msg,{embeds:[embed('🛡️ Antinuke',`Enabled: **${c.antinuke.enabled}**\nPunishment: **${c.antinuke.punishment}**\nStrict: **${c.antinuke.strict}**\nLockdown: **${c.antinuke.lockdown}**\nPanic: **${c.antinuke.panic}**`)]});
    if(name==='antiraid')return reply(msg,{embeds:[embed('🛡️ Antiraid',`Enabled: **${c.antiraid.enabled}**\nAction: **${c.antiraid.action}**\nThreshold: **${c.antiraid.threshold}/${c.antiraid.windowSeconds}s**\nAge limit: **${c.antiraid.ageLimit} days**\nLockdown: **${c.antiraid.lockdown}**`)]});
    if(name==='welcomer')return reply(msg,{embeds:[embed('👋 Welcomer',`Enabled: **${c.welcome.enabled}**\nChannel: ${c.welcome.channelId?`<#${c.welcome.channelId}>`:'Not set'}\nMessage: ${c.welcome.message}`)]});
    if(name==='logging')return reply(msg,{embeds:[embed('📋 Logging',LOG_CATS.map(x=>`**${x}:** ${c.logging[x]?`<#${c.logging[x]}>`:'off'}`).join('\n'))]});
    return reply(msg,{embeds:[embed('🤖 Automod',`Antispam: **${c.automod.antispam}**\nAntilink: **${c.automod.antilink}**\nAntiword: **${c.automod.antiword}**\nPunishment: **${c.automod.punishment}**`)]});
  }
  if(name==='antinuke'){
    // unreachable due above; kept intentionally no-op
  }
  if(name.startsWith('antinuke')){}
  if(name==='antiraid'){}
  if(name==='welcomer'){}
  if(name==='logging'){}

  // SUBCOMMAND dispatchers (names are parsed as first token; parent command above returned, so use aliases with command path in parser)
}

function commandHelp(){
  return `**GENERAL**\n!ping !av !ab !poll !botinvite !serverinfo !afk !snipe !esnipe\n\n**MODERATION**\n!kick !ban !unban !mute !unmute !warn !warnings !delwarn !clearwarnings !nick !purge !lock !unlock !hide !unhide !lockall !unlockall\n\n**ANTINUKE**\n!antinuke, setup, enable, disable, status, owner, whitelist, wlrole, punishment, logging, strict, lockdown, panic, recover\n\n**ANTI RAID**\n!antiraid, enable, disable, status, action, threshold, lockdown, age_limit, verification, avatar_check, delete_invites\n\n**WELCOME**\n!welcomer, channel, message, image, embed, test\n\n**LOGGING**\n!logging, enable, disable, enableall, disableall, categories\n\n**UTILITY**\n!view !myperms !viewperms !botperms !listadmins !list admins !viewroles !prefix !setprefix !botsettings\n\n**VOICE**\n!vckick !vcpull !vcmute !vcdeafen !vcpullall !vckickall !vcdeafenall !vcrole add/remove/show\n\n**TRACKING**\n!leaderboard !viewuser !setidentity !removeidentity !adminview !modview\n\n**ROLES**\n!role add/remove/create/delete/colour/rename/all/bots/humans/info/list !createrole\n\n**AUTOMOD**\n.automod .antispam .antispam enable/disable/wl add/remove/list .antilink enable/disable/wl... .antiword enable/disable/add/remove/list/wl... .automod punishment\n\n**OWNER**\n/owner lockdown unlock slowmode-all emergency add remove list transfer permissions audit`;
}

// Slash owner commands only.
const ownerData = {
  name:'owner',
  description:'Owner-only server control and owner management',
  options:[
    {name:'lockdown',description:'Lock the entire server',type:1},
    {name:'unlock',description:'Unlock the entire server',type:1},
    {name:'slowmode-all',description:'Set slowmode on all text channels',type:1,options:[{name:'seconds',description:'Slowmode seconds',type:4,required:true}]},
    {name:'emergency',description:'Activate emergency protection',type:1},
    {name:'add',description:'Add bot owner',type:1,options:[{name:'user',description:'User',type:6,required:true}]},
    {name:'remove',description:'Remove bot owner',type:1,options:[{name:'user',description:'User',type:6,required:true}]},
    {name:'list',description:'List bot owners',type:1},
    {name:'transfer',description:'Transfer bot ownership',type:1,options:[{name:'user',description:'New owner',type:6,required:true}]},
    {name:'permissions',description:'Show owner permissions',type:1},
    {name:'audit',description:'Show owner action audit',type:1}
  ]
};

async function ownerSlash(i){
  if(!isBotOwner(i.user.id))return i.reply({content:'❌ Owner-only command.',ephemeral:true});
  const s=i.options.getSubcommand(); const g=i.guild;
  const audit=(action,target)=>{state.ownerAudit.unshift({at:Date.now(),actor:i.user.id,action,target:target||null});state.ownerAudit=state.ownerAudit.slice(0,100);};
  if(s==='add'){const u=i.options.getUser('user');if(!state.owners.includes(u.id))state.owners.push(u.id);audit('add',u.id);await save();return i.reply(`✅ Added ${u} as bot owner.`)}
  if(s==='remove'){const u=i.options.getUser('user');if(state.owners.length<=1)return i.reply({content:'❌ Cannot remove the last owner.',ephemeral:true});state.owners=state.owners.filter(x=>x!==u.id);audit('remove',u.id);await save();return i.reply(`✅ Removed ${u} from bot owners.`)}
  if(s==='list')return i.reply({embeds:[embed('👑 Bot Owners',state.owners.map(x=>`• <@${x}> — \`${x}\``).join('\n')||'None')]});
  if(s==='transfer'){const u=i.options.getUser('user');state.owners=[u.id];audit('transfer',u.id);await save();return i.reply(`👑 Ownership transferred to ${u}.`)}
  if(s==='permissions')return i.reply({embeds:[embed('👑 Owner Permissions','Owner commands bypass normal server permission checks. Discord API actions still require the bot to have the corresponding permissions and hierarchy.')]});
  if(s==='audit')return i.reply({embeds:[embed('🧾 Owner Audit',state.ownerAudit.slice(0,20).map(x=>`<t:${Math.floor(x.at/1000)}:R> <@${x.actor}> **${x.action}** ${x.target?`<@${x.target}>`:''}`).join('\n')||'No actions logged.')]});
  if(!g)return i.reply({content:'❌ Server only.',ephemeral:true});
  if(s==='lockdown'){await setServerLock(g,true,'Owner lockdown');audit('lockdown',g.id);await save();return i.reply('🔒 Entire server locked.')}
  if(s==='unlock'){await setServerLock(g,false,'Owner unlock');audit('unlock',g.id);await save();return i.reply('🔓 Entire server unlocked.')}
  if(s==='slowmode-all'){const n=Math.min(Math.max(i.options.getInteger('seconds'),0),21600);for(const ch of g.channels.cache.values())if(ch.type===ChannelType.GuildText)await ch.setRateLimitPerUser(n,'Owner slowmode-all').catch(()=>{});audit('slowmode-all',String(n));await save();return i.reply(`🐢 Slowmode set to **${n}s** on all text channels.`)}
  if(s==='emergency'){const c=cfg(g.id);c.emergency=true;c.antinuke.enabled=true;c.antinuke.strict=true;c.antinuke.panic=true;await setServerLock(g,true,'Owner emergency protection');await snapshotGuild(g);audit('emergency',g.id);await save();await log(g,'owner','🚨 EMERGENCY MODE','Owner activated emergency protection.',0xef4444);
      for(const oid of state.owners){const u=await client.users.fetch(oid).catch(()=>null);if(u)await u.send(`🚨 Emergency protection activated in **${g.name}** by ${i.user.tag}.`).catch(()=>{});}
      return i.reply('🚨 Emergency protection activated.')}
}

const slashCommands=[ownerData];
const REST={async register(){const {REST,Routes}=await import('discord.js');const r=new REST({version:'10'}).setToken(TOKEN);await r.put(Routes.applicationCommands(client.user.id),{body:slashCommands});}};

client.once('ready',async()=>{
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('server security',{type:ActivityType.Watching});
  for(const g of client.guilds.cache.values()){cfg(g.id);await snapshotGuild(g).catch(()=>{});}
  await REST.register().catch(e=>console.error('Slash registration:',e.message));
  console.log(`✅ ${client.guilds.cache.size} guild(s) ready.`);
});

client.on('messageDelete',m=>{if(m.author)deleted.set(m.channel.id,{author:m.author.tag,content:m.content,at:Date.now()});});
client.on('messageUpdate',(a,b)=>{if(a.author)edited.set(a.channel.id,{author:a.author.tag,before:a.content,after:b.content,at:Date.now()});});
client.on('messageCreate',async msg=>{
  if(msg.author.bot)return;
  if(afk.has(msg.author.id)){const x=afk.get(msg.author.id);afk.delete(msg.author.id);await reply(msg,`👋 Welcome back! AFK removed (**${x.reason}**).`).catch(()=>{});}
  for(const u of msg.mentions.users.values())if(afk.has(u.id)){const x=afk.get(u.id);await reply(msg,`💤 **${u.username}** is AFK: ${x.reason}`).catch(()=>{});}
  if(!msg.guild)return;
  const c=cfg(msg.guild.id);
  // tracking
  c.tracking.messages[msg.author.id]=(c.tracking.messages[msg.author.id]||0)+1;
  const day=new Date().toISOString().slice(0,10); c.tracking.daily[day] ||= {};c.tracking.daily[day][msg.author.id]=(c.tracking.daily[day][msg.author.id]||0)+1;
  await save().catch(()=>{});
  // prefix and automod
  const pref = c.prefix || '!';
  let content=msg.content, usedPrefix=null;
  if(content.startsWith(pref))usedPrefix=pref; else if(content.startsWith('.') && ['automod','antispam','antilink','antiword'].includes(content.slice(1).split(/\s+/)[0]))usedPrefix='.';
  if(usedPrefix){
    const a=content.slice(usedPrefix.length).trim().split(/\s+/); const name=(a.shift()||'').toLowerCase();
    if(c.emergency && !isBotOwner(msg.author.id) && !['owner'].includes(name)){
      return reply(msg,'🚨 Emergency protection is active. Commands are temporarily disabled.');
    }
    // subcommand implementations
    try{
      if(['antinuke','antiraid','welcomer','logging','automod','antispam','antilink','antiword'].includes(name)){
        await dispatchSecurity(msg,name,a);return;
      }
      if(['myperms','viewperms','botperms','listadmins','list','viewroles','prefix','setprefix','leaderboard','viewuser','setidentity','removeidentity','adminview','modview','vckick','vcpull','vcmute','vcdeafen','vcpullall','vckickall','vcdeafenall','vcrole','role','createrole'].includes(name)){
        await dispatchUtility(msg,name,a);return;
      }
      await handleCommand(msg,name,a);
    }catch(e){console.error('command',name,e);await reply(msg,`❌ ${e.message}`)}
    return;
  }
  await automodMessage(msg);
});

async function antinukeWizard(msg,c){
  if(!await requirePerm(msg,PermissionFlagsBits.ManageGuild)) return;
  const filter=m=>m.author.id===msg.author.id&&m.channel.id===msg.channel.id;
  const ask=async(text)=>{
    await reply(msg,text);
    const col=msg.channel.createMessageCollector({filter,time:60000,max:1});
    return await new Promise(resolve=>{
      col.on('collect',m=>resolve(m));
      col.on('end',()=>resolve(null));
    });
  };
  const s1=await ask('🛡️ **Antinuke Setup — Step 1/4**\nEnable antinuke? Reply `yes` or `no`.');
  if(!s1)return reply(msg,'❌ Setup timed out.');
  c.antinuke.enabled=['yes','y'].includes(s1.content.toLowerCase());
  const s2=await ask('**Step 2/4**\nPunishment? Reply `ban`, `kick`, or `striproles`.');
  if(!s2)return reply(msg,'❌ Setup timed out.');
  if(['ban','kick','striproles'].includes(s2.content.toLowerCase()))c.antinuke.punishment=s2.content.toLowerCase();
  const s3=await ask('**Step 3/4**\nEnable strict mode? Reply `yes` or `no`.');
  if(!s3)return reply(msg,'❌ Setup timed out.');
  c.antinuke.strict=['yes','y'].includes(s3.content.toLowerCase());
  const s4=await ask('**Step 4/4**\nUse this channel for antinuke logs? Reply `yes` or `no`.');
  if(!s4)return reply(msg,'❌ Setup timed out.');
  if(['yes','y'].includes(s4.content.toLowerCase())){c.antinuke.logChannelId=msg.channel.id;c.logging.antinuke=msg.channel.id;}
  await save();
  return reply(msg,`✅ **Antinuke setup complete.** Enabled: ${c.antinuke.enabled} • Punishment: ${c.antinuke.punishment} • Strict: ${c.antinuke.strict}`);
}
async function dispatchSecurity(msg,name,a){
  const g=msg.guild,c=cfg(g.id), sub=(a[0]||'').toLowerCase();
  if(name==='automod'&&sub==='punishment'){if(!await requirePerm(msg,PermissionFlagsBits.ManageGuild))return;c.automod.punishment=a[1]||a[0]||'delete';await save();return reply(msg,`✅ Automod punishment: **${c.automod.punishment}**`)}
  if(name==='antispam'||name==='antilink'||name==='antiword'||name==='automod'){
    if(!await requirePerm(msg,PermissionFlagsBits.ManageGuild))return;
    const key=name==='automod'?'antispam':name;
    if(sub==='enable'||sub==='disable'){c.automod[key]=sub==='enable';await save();return reply(msg,`✅ ${name} ${sub}d.`)}
    if(sub==='add'&&name==='antiword'){const w=a.slice(1).join(' ')||a[0];if(w&&!c.automod.words.includes(w.toLowerCase()))c.automod.words.push(w.toLowerCase());await save();return reply(msg,'✅ Bad word added.')}
    if(sub==='remove'&&name==='antiword'){const w=a.slice(1).join(' ')||a[0];c.automod.words=c.automod.words.filter(x=>x!==String(w).toLowerCase());await save();return reply(msg,'✅ Bad word removed.')}
    if(sub==='list'&&name==='antiword')return reply(msg,`**Bad words:** ${c.automod.words.join(', ')||'None'}`);
    if(sub==='wl')return roleWhitelist(c,key,msg);
    return reply(msg,{embeds:[embed(`🤖 ${name}`,`Enabled: **${c.automod[key]}**\nWhitelisted users: ${c.automod.whitelists[key].users.length}\nWhitelisted roles: ${c.automod.whitelists[key].roles.length}`)]});
  }
  if(name==='antinuke'){
    if(!await requirePerm(msg,PermissionFlagsBits.ManageGuild))return;
    if(!sub)return handleCommand(msg,'antinuke',[]);
    if(sub==='setup') return antinukeWizard(msg,c);
    if(sub==='enable'||sub==='disable'){c.antinuke.enabled=sub==='enable';await save();return reply(msg,`🛡️ Antinuke ${sub}d.`)}
    if(sub==='status')return reply(msg,{embeds:[embed('🛡️ Antinuke Status',`Enabled: **${c.antinuke.enabled}**\nPunishment: **${c.antinuke.punishment}**\nStrict: **${c.antinuke.strict}**\nLockdown: **${c.antinuke.lockdown}**\nPanic: **${c.antinuke.panic}**\nWhitelist users: **${c.antinuke.whitelistUsers.length}**\nWhitelist roles: **${c.antinuke.whitelistRoles.length}**`)]});
    if(sub==='punishment'){const x=a[1];if(!['ban','kick','striproles'].includes(x))return reply(msg,'Use `ban`, `kick`, or `striproles`.');c.antinuke.punishment=x;await save();return reply(msg,`✅ Punishment set to **${x}**.`)}
    if(sub==='logging'){c.antinuke.logChannelId=msg.mentions.channels.first()?.id||a[1]||msg.channel.id;c.logging.antinuke=c.antinuke.logChannelId;await save();return reply(msg,'✅ Antinuke log channel set.')}
    if(sub==='strict'||sub==='lockdown'){c.antinuke[sub]=!c.antinuke[sub];await save();if(sub==='lockdown')await setServerLock(g,c.antinuke.lockdown,'Antinuke lockdown');return reply(msg,`✅ ${sub}: **${c.antinuke[sub]}**`)}
    if(sub==='panic'){c.antinuke.panic=true;c.antinuke.strict=true;await setServerLock(g,true,'Antinuke panic');await save();return reply(msg,'🚨 Antinuke panic enabled.')}
    if(sub==='recover'){c.antinuke.panic=false;c.antinuke.strict=false;c.antinuke.lockdown=false;await setServerLock(g,false,'Antinuke recovery');await restoreSnapshot(g);await save();return reply(msg,'🟢 Recovery completed.')}
    if(sub==='owner')return reply(msg,'👑 The server owner is always trusted. Bot owners are also trusted.');
    if(sub==='whitelist'||sub==='wlrole'){const u=mentionedUser(msg),r=msg.mentions.roles.first();if(u){if(!c.antinuke.whitelistUsers.includes(u.id))c.antinuke.whitelistUsers.push(u.id);await save();return reply(msg,'✅ User whitelisted.')}if(r){if(!c.antinuke.whitelistRoles.includes(r.id))c.antinuke.whitelistRoles.push(r.id);await save();return reply(msg,'✅ Role whitelisted.')}return reply(msg,'Mention a user or role.')}
  }
  if(name==='antiraid'){
    if(!await requirePerm(msg,PermissionFlagsBits.ManageGuild))return;
    if(!sub)return handleCommand(msg,'antiraid',[]);
    const bools=['enable','disable','lockdown','verification','avatar_check','delete_invites'];
    if(bools.includes(sub)){
      const key=sub==='enable'||sub==='disable'?'enabled':sub;
      c.antiraid[key]=sub==='enable'?true:sub==='disable'?false:!c.antiraid[key];
      if(sub==='lockdown') { for(const ch of g.channels.cache.values()) if(ch.isTextBased()&&ch.permissionOverwrites?.edit) await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:c.antiraid.lockdown?false:null},{reason:'Anti-raid lockdown'}).catch(()=>{}); }
      await save(); return reply(msg,`✅ antiraid ${sub} updated.`);
    }
    if(sub==='status')return reply(msg,{embeds:[embed('🛡️ Antiraid Status',Object.entries(c.antiraid).map(([k,v])=>`**${k}:** ${typeof v==='object'?JSON.stringify(v):v}`).join('\n'))]});
    if(sub==='action'){if(!['kick','ban'].includes(a[1]))return reply(msg,'Use kick or ban.');c.antiraid.action=a[1];await save();return reply(msg,'✅ Action set.')}
    if(sub==='threshold'){const n=Number(a[1]);if(!n)return reply(msg,'Usage: `!antiraid threshold <number>`');c.antiraid.threshold=Math.max(2,Math.min(n,100));await save();return reply(msg,'✅ Threshold updated.')}
    if(sub==='age_limit'){const n=Math.max(0,Number(a[1]));c.antiraid.ageLimit=n;await save();return reply(msg,'✅ Age limit updated.')}
  }
  if(name==='welcomer'){
    if(!await requirePerm(msg,PermissionFlagsBits.ManageGuild))return;
    if(!sub){c.welcome.enabled=!c.welcome.enabled;await save();return reply(msg,`👋 Welcomer ${c.welcome.enabled?'enabled':'disabled'}.`)}
    if(sub==='channel'){c.welcome.channelId=msg.mentions.channels.first()?.id||a[1]||msg.channel.id;c.welcome.enabled=true;await save();return reply(msg,'✅ Welcome channel set.')}
    if(sub==='message'){c.welcome.message=a.slice(1).join(' ')||a.join(' ');await save();return reply(msg,'✅ Welcome message saved.')}
    if(sub==='image'){c.welcome.image=a[1]||a[0]||null;await save();return reply(msg,'✅ Welcome image saved.')}
    if(sub==='embed'){c.welcome.embed=a.slice(1).join(' ')||a.join(' ');await save();return reply(msg,'✅ Welcome embed text saved.')}
    if(sub==='test'){const m=msg.mentions.members.first()||msg.member;const ch=g.channels.cache.get(c.welcome.channelId)||msg.channel;const e=embed('👋 Welcome',formatWelcome(c.welcome.message,m));if(c.welcome.image)e.setImage(c.welcome.image);return ch.send({embeds:[e]}).then(()=>reply(msg,'✅ Welcome tested.'))}
  }
  if(name==='logging'){
    if(!await requirePerm(msg,PermissionFlagsBits.ManageGuild))return;
    if(!sub||sub==='categories')return reply(msg,`**Logging categories:** ${LOG_CATS.join(', ')}`);
    if(sub==='enableall'){const ch=msg.mentions.channels.first()||msg.channel;for(const k of LOG_CATS)c.logging[k]=ch.id;await save();return reply(msg,'✅ All logging categories enabled.')}
    if(sub==='disableall'){for(const k of LOG_CATS)c.logging[k]=null;await save();return reply(msg,'✅ All logging categories disabled.')}
    if(sub==='enable'||sub==='disable'){const cat=a[1];if(!LOG_CATS.includes(cat))return reply(msg,`❌ Category must be one of: ${LOG_CATS.join(', ')}`);c.logging[cat]=sub==='enable'?(msg.mentions.channels.first()?.id||a[2]||msg.channel.id):null;await save();return reply(msg,`✅ ${cat} logging ${sub}d.`)}
  }
}
async function dispatchUtility(msg,name,a){
  const g=msg.guild,c=cfg(g.id),sub=(a[0]||'').toLowerCase();
  if(name==='view')return reply(msg,{embeds:[embed('🔎 View Commands','`!myperms`\n`!viewperms @user`\n`!botperms`\n`!list admins`\n`!viewroles`')]});
  if(name==='myperms')return reply(msg,`**Your permissions:** ${msg.member.permissions.toArray().join(', ')||'None'}`);
  if(name==='viewperms'){const m=msg.mentions.members.first();return reply(msg,m?`**${m.user.tag}:** ${m.permissions.toArray().join(', ')}`:'Mention a member.')}
  if(name==='botperms')return reply(msg,`**Bot:** ${g.members.me.permissions.toArray().join(', ')}`);
  if(name==='listadmins'||(name==='listadmins'&&sub==='admins')||name==='list'){
    if(name==='list'&&sub!=='admins')return reply(msg,'Usage: `!list admins`');
    const a=[...g.members.cache.values()].filter(m=>m.permissions.has(PermissionFlagsBits.Administrator));return reply(msg,{embeds:[embed('👑 Administrators',`**Humans:**\n${a.filter(m=>!m.user.bot).map(m=>m.toString()).join(', ')||'None'}\n\n**Bots:**\n${a.filter(m=>m.user.bot).map(m=>m.toString()).join(', ')||'None'}`)]});
  }
  if(name==='viewroles'){const rs=[...g.roles.cache.values()].sort((a,b)=>b.position-a.position).slice(0,50);return reply(msg,{embeds:[embed('🎭 Roles',rs.map(r=>`${r} — ${r.members.size} members — ${r.permissions.has(PermissionFlagsBits.Administrator)?'ADMIN':''}`).join('\n'))]})}
  if(name==='prefix'||name==='setprefix'){if(!has(msg.member,PermissionFlagsBits.ManageGuild))return reply(msg,'❌ Manage Server required.');if(!sub)return reply(msg,`Current prefix: \`${c.prefix}\``);if(sub==='set'||name==='setprefix'){const p=name==='setprefix'?a[0]:a[1];if(!p||p.length>5)return reply(msg,'❌ Prefix must be 1–5 characters.');c.prefix=p;await save();return reply(msg,`✅ Prefix set to \`${p}\`.`)}if(sub==='reset'){c.prefix='!';await save();return reply(msg,'✅ Prefix reset.')}if(sub==='show')return reply(msg,`Prefix: \`${c.prefix}\``);
    if(sub==='add'){const p=a[1];if(!p||p.length>5)return reply(msg,'❌ Usage: `!prefix add <prefix>`');c.prefix=p;await save();return reply(msg,`✅ Prefix set to \`${p}\`.`)}
    if(sub==='remove'){c.prefix='!';await save();return reply(msg,'✅ Custom prefix removed; reset to `!`.')}
  }
  if(name==='leaderboard'){const entries=Object.entries(c.tracking.messages).sort((a,b)=>b[1]-a[1]).slice(0,10);return reply(msg,{embeds:[embed('🏆 Message Leaderboard',entries.map((x,i)=>`**${i+1}.** <@${x[0]}> — ${x[1]} messages`).join('\n')||'No data.')]})}
  if(name==='viewuser'){if(!has(msg.member,PermissionFlagsBits.Administrator))return reply(msg,'❌ Administrator required.');const m=msg.mentions.member||msg.member;return reply(msg,{embeds:[embed('👤 User Profile',`User: ${m}\nID: \`${m.id}\`\nJoined: <t:${Math.floor(m.joinedTimestamp/1000)}:F>\nMessages: **${c.tracking.messages[m.id]||0}**\nIdentity: ${c.identities[m.id]||'Not set'}`)]})}
  if(name==='setidentity'||name==='removeidentity'){if(!has(msg.member,PermissionFlagsBits.Administrator))return reply(msg,'❌ Administrator required.');const m=msg.mentions.members.first()||msg.member;if(name==='setidentity'){c.identities[m.id]=a.slice(1).join(' ')||a.join(' ')}else delete c.identities[m.id];await save();return reply(msg,'✅ Identity updated.')}
  if(name==='adminview'||name==='modview'){
    if(!has(msg.member,PermissionFlagsBits.ManageGuild))return reply(msg,'❌ Manage Server required.');
    const list=[...g.members.cache.values()].filter(m=>name==='adminview'?m.permissions.has(PermissionFlagsBits.Administrator):(m.permissions.has(PermissionFlagsBits.ManageGuild)||m.permissions.has(PermissionFlagsBits.ManageMessages)));
    return reply(msg,{embeds:[embed(name==='adminview'?'👑 Admin View':'🛡️ Mod View',list.map(m=>m.toString()).join(', ')||'None')]});
  }
  // voice
  if(['vckick','vcpull','vcmute','vcdeafen','vcpullall','vckickall','vcdeafenall'].includes(name)){
    if(!await requirePerm(msg,PermissionFlagsBits.MoveMembers))return;
    const target=msg.mentions.members.first();
    if(['vckickall','vcpullall','vcdeafenall'].includes(name)){
      const from=msg.member.voice.channel;if(!from)return reply(msg,'❌ You are not in a voice channel.');
      if(name==='vcpullall'){
        for(const ch of g.channels.cache.values()) if(ch.isVoiceBased()) for(const m of ch.members.values()) if(m.id!==msg.author.id) await m.voice.setChannel(from).catch(()=>{});
      } else {
        for(const m of from.members.values()){if(name==='vckickall')await m.voice.disconnect().catch(()=>{});if(name==='vcdeafenall')await m.voice.setDeaf(true).catch(()=>{});}
      }
      return reply(msg,'✅ Voice action completed.');
    }
    if(!target)return reply(msg,'Mention a voice member.');if(name==='vckick')await target.voice.disconnect();if(name==='vcpull')await target.voice.setChannel(msg.member.voice.channel);if(name==='vcmute')await target.voice.setMute(true);if(name==='vcdeafen')await target.voice.setDeaf(true);return reply(msg,'✅ Voice action completed.');
  }
  if(name==='vcrole'){if(!has(msg.member,PermissionFlagsBits.ManageRoles))return reply(msg,'❌ Manage Roles required.');if(sub==='add'){const r=msg.mentions.roles.first();if(!r)return reply(msg,'Mention a role.');c.vcrole=r.id;await save();return reply(msg,'✅ Voice role set.')}if(sub==='remove'){c.vcrole=null;await save();return reply(msg,'✅ Voice role removed.')}return reply(msg,`Voice role: ${c.vcrole?`<@&${c.vcrole}>`:'None'}`)}
  // roles
  if(name==='createrole'||name==='role'){
    if(!await requirePerm(msg,PermissionFlagsBits.ManageRoles))return;
    if(name==='createrole'){const r=await g.roles.create({name:a.join(' ')||'New Role'});return reply(msg,`✅ Created ${r}.`)}
    const action=sub;
    if(action==='create'){const r=await g.roles.create({name:a.slice(1).join(' ')||'New Role'});return reply(msg,`✅ Created ${r}.`)}
    const r=msg.mentions.roles.first()||g.roles.cache.find(x=>x.name===a[1]);const u=msg.mentions.members.first();
    if(action==='add'||action==='remove'){if(!r||!u)return reply(msg,'Mention a user and role.');if(action==='add')await u.roles.add(r);else await u.roles.remove(r);return reply(msg,'✅ Role updated.')}
    if(action==='delete'){if(!r)return reply(msg,'Mention a role.');await r.delete();return reply(msg,'✅ Role deleted.')}
    if(action==='colour'){if(!r)return reply(msg,'Mention a role.');const color=a[2]||a[1];await r.setColor(color);return reply(msg,'✅ Role colour updated.')}
    if(action==='rename'){if(!r)return reply(msg,'Mention a role.');await r.setName(a.slice(2).join(' '));return reply(msg,'✅ Role renamed.')}
    if(['all','bots','humans'].includes(action)){if(!r)return reply(msg,'Mention a role.');for(const m of g.members.cache.values()){if(action==='bots'&&!m.user.bot)continue;if(action==='humans'&&m.user.bot)continue;await m.roles.add(r).catch(()=>{})}return reply(msg,'✅ Bulk role update completed.')}
    if(action==='info'){if(!r)return reply(msg,'Mention a role.');return reply(msg,{embeds:[embed('🎭 Role Info',`Name: ${r}\nID: \`${r.id}\`\nMembers: ${r.members.size}\nColour: ${r.hexColor}\nPosition: ${r.position}\nMentionable: ${r.mentionable}`)]})}
    if(action==='list'||!action)return reply(msg,{embeds:[embed('🎭 Roles',[...g.roles.cache.values()].sort((a,b)=>b.position-a.position).map(x=>`${x} — ${x.members.size}`).join('\n'))]})
  }
}
async function automodMessage(msg){
  const g=msg.guild,c=cfg(g.id),m=msg.member;
  const whitelisted=(key)=>c.automod.whitelists[key].users.includes(msg.author.id)||m.roles.cache.some(r=>c.automod.whitelists[key].roles.includes(r.id));
  if(c.automod.antilink&&!whitelisted('antilink')&&/(https?:\/\/|discord\.gg\/|www\.)/i.test(msg.content)){await msg.delete().catch(()=>{});await punishAuto(msg,'antilink');return}
  if(c.automod.antiword&&!whitelisted('antiword')&&c.automod.words.some(w=>w&&msg.content.toLowerCase().includes(w))){await msg.delete().catch(()=>{});await punishAuto(msg,'antiword');return}
  if(c.automod.antispam&&!whitelisted('antispam')){
    const key=`${g.id}:${msg.author.id}`, now=Date.now(), arr=(spamMap.get(key)||[]).filter(t=>now-t<c.automod.spamWindow);arr.push(now);spamMap.set(key,arr);
    if(arr.length>=c.automod.spamLimit){spamMap.set(key,[]);await punishAuto(msg,'antispam');}
  }
}
const spamMap=new Map();
async function punishAuto(msg,why){const c=cfg(msg.guild.id);if(c.automod.punishment==='timeout')await msg.member.timeout(60000,`Automod: ${why}`).catch(()=>{});await log(msg.guild,'automod','🤖 Automod action',`${msg.author} — **${why}**`,0xf59e0b);}

client.on('guildMemberAdd',async m=>{
  const g=m.guild,c=cfg(g.id);
  if(c.welcome.enabled&&c.welcome.channelId){const ch=g.channels.cache.get(c.welcome.channelId);if(ch?.isTextBased()){const e=embed('👋 Welcome',formatWelcome(c.welcome.message,m));if(c.welcome.image)e.setImage(c.welcome.image);await ch.send({embeds:[e]}).catch(()=>{});}}
  if(c.vcrole){const r=g.roles.cache.get(c.vcrole);if(r)await m.roles.add(r).catch(()=>{});}
  if(c.antiraid.enabled){
    const now=Date.now(), arr=(joinWindows.get(g.id)||[]).filter(x=>now-x<c.antiraid.windowSeconds*1000);arr.push(now);joinWindows.set(g.id,arr);
    const age=Date.now()-m.user.createdTimestamp;
    const suspicious=(c.antiraid.ageLimit>0&&age<c.antiraid.ageLimit*86400000)||(c.antiraid.avatarCheck&&!m.user.avatar);
    if(suspicious||arr.length>=c.antiraid.threshold){
      if(c.antiraid.verification)await g.setVerificationLevel(4,'Anti-raid detection').catch(()=>{});
      if(c.antiraid.deleteInvites)await deleteInvites(g);
      if(c.antiraid.lockdown){c.antiraid.lockdown=true;await setServerLock(g,true,'Anti-raid lockdown');}
      if(suspicious){if(c.antiraid.action==='ban'&&m.bannable)await m.ban({reason:'Anti-raid'}).catch(()=>{});else if(m.kickable)await m.kick('Anti-raid').catch(()=>{});}
      await log(g,'antiraid','🚨 Anti-raid detection',`Join burst/suspicious account detected. Joins: **${arr.length}**`,0xef4444);
    }
  }
  await log(g,'joinleave','📥 Member joined',`${m} (\`${m.id}\`)`);
});
client.on('guildMemberRemove',async m=>{await log(m.guild,'joinleave','📤 Member left',`${m.user.tag} (\`${m.id}\`)`); const c=cfg(m.guild.id); if(c.antinuke.enabled){const ex=await auditExecutor(m.guild,AuditLogEvent.MemberKick,m.id); if(ex) await punishNuker(m.guild,ex,`Unauthorized kick of ${m.user.tag}`);}});
client.on('guildBanAdd',async b=>{
  const g=b.guild,c=cfg(g.id);await log(g,'moderation','🔨 Member banned',`${b.user.tag}`);
  if(c.antinuke.enabled){const ex=await auditExecutor(g,AuditLogEvent.MemberBanAdd,b.user.id);await punishNuker(g,ex,`Unauthorized ban of ${b.user.tag}`);}
});
client.on('channelCreate',async ch=>{await log(ch.guild,'channel','📁 Channel created',`${ch}`);const c=cfg(ch.guild.id);if(c.antinuke.enabled){const ex=await auditExecutor(ch.guild,AuditLogEvent.ChannelCreate,ch.id);await punishNuker(ch.guild,ex,`Unauthorized channel creation: ${ch.name}`);}});
client.on('channelDelete',async ch=>{await log(ch.guild,'channel','🗑️ Channel deleted',`\`${ch.name}\``);const c=cfg(ch.guild.id);if(c.antinuke.enabled){const ex=await auditExecutor(ch.guild,AuditLogEvent.ChannelDelete,ch.id);await punishNuker(ch.guild,ex,`Unauthorized channel deletion: ${ch.name}`);if(!await authorizedNuker(ch.guild,ex))await restoreSnapshot(ch.guild);}});
client.on('roleCreate',async r=>{await log(r.guild,'role','🎭 Role created',`${r}`);const c=cfg(r.guild.id);if(c.antinuke.enabled){const ex=await auditExecutor(r.guild,AuditLogEvent.RoleCreate,r.id);await punishNuker(r.guild,ex,`Unauthorized role creation: ${r.name}`);}});
client.on('roleDelete',async r=>{await log(r.guild,'role','🗑️ Role deleted',`\`${r.name}\``);const c=cfg(r.guild.id);if(c.antinuke.enabled){const ex=await auditExecutor(r.guild,AuditLogEvent.RoleDelete,r.id);await punishNuker(r.guild,ex,`Unauthorized role deletion: ${r.name}`);if(!await authorizedNuker(r.guild,ex))await restoreSnapshot(r.guild);}});
client.on('guildUpdate',async(before,after)=>{await log(after,'server','⚙️ Server updated',`Name: **${before.name}** → **${after.name}**`);});
client.on('voiceStateUpdate',async(before,after)=>{if(before.channelId!==after.channelId)await log(after.guild,'voice','🎙️ Voice state',`${after.member} ${before.channelId?'left':'joined'} ${after.channel?.name||'voice'}`);});

client.on('interactionCreate',async i=>{if(!i.isChatInputCommand())return;if(i.commandName==='owner')await ownerSlash(i).catch(e=>i.reply({content:`❌ ${e.message}`,ephemeral:true}).catch(()=>{}));});

const app=express();app.get('/',(_,res)=>res.json({ok:true,bot:client.user?.tag||null}));app.get('/health',(_,res)=>res.json({ok:true,ready:client.isReady()}));
app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('🌐 Health server online'));
setInterval(()=>save().catch(()=>{}),30000);
setInterval(async()=>{for(const g of client.guilds.cache.values()){if(cfg(g.id).antinuke.enabled||cfg(g.id).antiraid.enabled)await snapshotGuild(g).catch(()=>{});}},15*60*1000);

process.on('unhandledRejection',e=>console.error('Unhandled rejection:',e));
process.on('uncaughtException',e=>console.error('Uncaught exception:',e));
await client.login(TOKEN);
