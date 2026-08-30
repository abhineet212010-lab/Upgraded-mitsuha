import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, Partials, ActivityType, ChannelType, AuditLogEvent, REST, Routes, PermissionFlagsBits } from 'discord.js';
import { initStore, guildConfig, saveState, saveNow, state } from './store.js';
import { handlePrefix, CATALOG, TOTAL_COMMANDS, restoreSnapshot } from './commands.js';
import { makeEmbed, safeReply, isBotOwner, logEvent, setServerLock, getAuditExecutor, authorizedExecutor, COLORS } from './utils.js';

const TOKEN=process.env.DISCORD_TOKEN;
if(!TOKEN){console.error('❌ DISCORD_TOKEN is missing. Add it in Railway Variables.');process.exit(1);}
await initStore();

const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildModeration,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildInvites],partials:[Partials.Channel,Partials.Message,Partials.GuildMember,Partials.User]});
client.deleted=new Map();client.edited=new Map();client.spam=new Map();client.joins=new Map();client.invites=new Map();

async function snapshotGuild(g){
  const c=guildConfig(g.id);const snap={at:Date.now(),channels:[],roles:[]};
  for(const r of [...g.roles.cache.values()].sort((a,b)=>a.position-b.position)){if(r.managed)continue;snap.roles.push({name:r.name,color:r.hexColor,hoist:r.hoist,mentionable:r.mentionable,permissions:r.permissions.bitfield.toString(),position:r.position});}
  for(const ch of g.channels.cache.values()){snap.channels.push({id:ch.id,name:ch.name,type:ch.type,parentId:ch.parentId,position:ch.rawPosition,topic:ch.type===ChannelType.GuildText?ch.topic:null,nsfw:ch.type===ChannelType.GuildText?ch.nsfw:false,rateLimitPerUser:ch.type===ChannelType.GuildText?ch.rateLimitPerUser:0,bitrate:ch.type===ChannelType.GuildVoice?ch.bitrate:null,userLimit:ch.type===ChannelType.GuildVoice?ch.userLimit:null});}
  c.snapshot=snap;await saveState();
}

async function punishNuker(g,user,reason){const c=guildConfig(g.id);if(!c.antinuke.enabled||authorizedExecutor(g,user))return;const m=user&&g.members.cache.get(user.id);try{if(m&&m.id!==g.ownerId){if(c.antinuke.punishment==='ban'&&m.bannable)await m.ban({reason});else if(c.antinuke.punishment==='kick'&&m.kickable)await m.kick(reason);else if(c.antinuke.punishment==='striproles'){const rs=m.roles.cache.filter(r=>r.id!==g.id&&!r.managed&&r.position<g.members.me.roles.highest.position);if(rs.size)await m.roles.remove(rs,reason);}}}catch(e){console.error('antinuke action:',e.message)}await logEvent(g,'antinuke','🚨 Anti-nuke action',`Executor: ${user?.tag||'Unknown'}\nAction: **${c.antinuke.punishment}**\nReason: ${reason}`,COLORS.bad);if(c.antinuke.strict||c.antinuke.lockdown)await setServerLock(g,true,'Anti-nuke lockdown');}

const ownerSlash={name:'owner',description:'Owner-only controls',options:[
  {name:'lockdown',description:'Lock the entire server',type:1},{name:'unlock',description:'Unlock the entire server',type:1},
  {name:'slowmode-all',description:'Set slowmode on all text channels',type:1,options:[{name:'seconds',description:'Seconds',type:4,required:true,min_value:0,max_value:21600}]},
  {name:'emergency',description:'Activate emergency protection',type:1},
  {name:'add',description:'Add bot owner',type:1,options:[{name:'user',description:'User',type:6,required:true}]},
  {name:'remove',description:'Remove bot owner',type:1,options:[{name:'user',description:'User',type:6,required:true}]},
  {name:'list',description:'List bot owners',type:1},
  {name:'transfer',description:'Transfer bot ownership',type:1,options:[{name:'user',description:'New owner',type:6,required:true}]},
  {name:'permissions',description:'Show owner permissions',type:1},{name:'audit',description:'Show owner audit',type:1}
]};


function slashOption(name, description='Value', type=3, required=false) {
  return { name, description: description.slice(0,100), type, required };
}

// Slash-command mirror of every explicitly listed prefix command.
// We intentionally keep the same command names/subcommands and route them through
// the already-tested prefix handlers so both interfaces behave the same.
function buildSlashCommands() {
  const out=[];
  const add=(name,description,options=[])=>out.push({name,description:description.slice(0,100),type:1,options});
  const simple=['ping','av','ab','poll','botinvite','serverinfo','afk','snipe','esnipe','unban','delwarn','clearwarnings','purge','lock','unlock','hide','unhide','lockall','unlockall','view','myperms','viewperms','botperms','listadmins','viewroles','setprefix','botsettings','leaderboard','viewuser','setidentity','removeidentity','adminview','modview','vckick','vcpull','vcmute','vcdeafen','vcpullall','vckickall','vcdeafenall','createrole'];
  for(const n of simple){
    const opts=[];
    if(['av','ab','viewperms','viewuser','setidentity','removeidentity'].includes(n)) opts.push(slashOption('user','User',6,false));
    if(n==='clearwarnings') opts.push(slashOption('user','Member',6,true));
    if(n==='poll'||n==='afk'||n==='setprefix'||n==='setidentity'||n==='createrole') opts.push(slashOption('text',n==='poll'?'Poll question':n==='afk'?'AFK reason':n==='setprefix'?'New prefix':n==='setidentity'?'Identity':'Role name',3,n==='poll'||n==='setprefix'));
    if(['unban','delwarn'].includes(n)) opts.push(slashOption(n==='unban'?'user_id':'id',n==='unban'?'User ID':'Warning ID',3,true));
    if(['kick','ban','mute','unmute','warn'].includes(n)) opts.push(slashOption('user','Member',6,true),slashOption('reason','Reason',3,false));
    if(n==='nick') opts.push(slashOption('user','Member',6,true),slashOption('nickname','Nickname',3,false));
    if(n==='purge') opts.push(slashOption('amount','Number of messages',4,false),slashOption('user','Only this user',6,false),slashOption('bots','Use bot messages',5,false));
    if(['vckick','vcpull','vcmute','vcdeafen'].includes(n)) opts.push(slashOption('user','Voice member',6,true));
    add(n,`Kiara ${n} command`,opts);
  }

  const moderation=['kick','ban','mute','unmute','warn','warnings','nick'];
  for(const n of moderation){
    // Already registered above for simple member commands except warnings/nick.
    if(n==='warnings') add('warnings','View warnings',[slashOption('user','Member',6,false)]);
    if(n==='nick') add('nick','Change or lock a nickname',[slashOption('action','lock or unlock',3,false),slashOption('user','Member',6,true),slashOption('nickname','Nickname',3,false)]);
  }

  const subMap={
    antinuke:['setup','enable','disable','status','owner','whitelist','wlrole','punishment','logging','strict','lockdown','panic','recover'],
    antiraid:['enable','disable','status','action','threshold','lockdown','age_limit','verification','avatar_check','delete_invites'],
    welcomer:['channel','message','image','embed','test'],
    logging:['enable','disable','enableall','disableall','categories'],
    prefix:['set','reset','show','add','remove'],
    vcrole:['add','remove','show'],
    role:['add','remove','create','delete','colour','rename','all','bots','humans','info','list'],
    automod:['punishment'],
    antispam:['enable','disable','wl_add','wl_remove','wl_list'],
    antilink:['enable','disable','wl_add','wl_remove','wl_list'],
    antiword:['enable','disable','add','remove','list','wl_add','wl_remove','wl_list']
  };
  const subOptions=(base,sub)=>{
    const o=[];
    if(['channel','enableall'].includes(sub)) o.push(slashOption('channel','Channel',7,false));
    if(base==='logging'&&['enable','disable'].includes(sub)) o.push(slashOption('category','Logging category',3,true));
    if(['message','embed','image'].includes(sub)) o.push(slashOption('text','Value',3,true));
    if(sub==='test') o.push(slashOption('user','Member',6,false));
    if(base==='antinuke'&&['whitelist','wlrole'].includes(sub)) o.push(slashOption('user','User',6,false),slashOption('role','Role',8,false));
    if(base==='antinuke'&&sub==='punishment') o.push({name:'value',description:'ban, kick or striproles',type:3,required:true,choices:[{name:'ban',value:'ban'},{name:'kick',value:'kick'},{name:'striproles',value:'striproles'}]});
    if(base==='antinuke'&&sub==='logging') o.push(slashOption('channel','Log channel',7,false));
    if(base==='antiraid'&&sub==='action') o.push({name:'value',description:'Punishment action',type:3,required:true,choices:[{name:'kick',value:'kick'},{name:'ban',value:'ban'}]});
    if(base==='antiraid'&&sub==='threshold') o.push(slashOption('value','Join threshold',4,true));
    if(base==='antiraid'&&sub==='age_limit') o.push(slashOption('value','Minimum account age in days',10,true));
    if(base==='prefix'&&['set','add'].includes(sub)) o.push(slashOption('value','Prefix',3,true));
    if(base==='role'&&['add','remove'].includes(sub)) o.push(slashOption('user','Member',6,true),slashOption('role','Role',8,true));
    if(base==='role'&&sub==='create') o.push(slashOption('name','Role name',3,true));
    if(base==='role'&&sub==='delete') o.push(slashOption('role','Role',8,true));
    if(base==='role'&&sub==='colour') o.push(slashOption('role','Role',8,true),slashOption('value','Colour',3,true));
    if(base==='role'&&sub==='rename') o.push(slashOption('role','Role',8,true),slashOption('name','New name',3,true));
    if(base==='role'&&['all','bots','humans','info'].includes(sub)) o.push(slashOption('role','Role',8,true));
    if(base==='automod'&&sub==='punishment') o.push({name:'value',description:'delete, timeout or warn',type:3,required:true,choices:[{name:'delete',value:'delete'},{name:'timeout',value:'timeout'},{name:'warn',value:'warn'}]});
    if(['antispam','antilink','antiword'].includes(base)&&sub.startsWith('wl_')) o.push(slashOption('user','User',6,false),slashOption('role','Role',8,false));
    if(base==='antiword'&&['add','remove'].includes(sub)) o.push(slashOption('word','Word',3,true));
    return o;
  };
  for(const [base,subs] of Object.entries(subMap)){
    // Prefix names beginning with a dot are not used for slash commands; slash names are clean.
    const options=[];
    for(const sub of subs){
      // Use a subcommand group for whitelist actions where Discord supports 2-level nesting.
      if(['antispam','antilink','antiword'].includes(base)&&sub.startsWith('wl_')) continue;
      options.push({name:sub,description:`${base} ${sub}`.slice(0,100),type:1,options:subOptions(base,sub)});
    }
    if(['antispam','antilink','antiword'].includes(base)){
      options.push({name:'wl',description:'Whitelist management',type:2,options:['add','remove','list'].map(a=>({name:a,description:`${base} whitelist ${a}`,type:1,options:subOptions(base,`wl_${a}`)}))});
    }
    // Discord requires subcommands to be used when present. The base prefix command is
    // still available exactly as requested; slash uses /<base> status/overview subcommands
    // for commands that have children.
    add(base,`Kiara ${base} commands`,options);
  }
  add('help','Show Kiara help',[slashOption('category','Category',3,false)]);
  add('list','List administrators',[{name:'admins',description:'Show administrators',type:1}]);
  return out;
}

function fakeMessageFromInteraction(interaction, client) {
  const users=interaction.options;
  const user=users.getUser('user');
  const role=users.getRole('role');
  const channel=users.getChannel('channel');
  const text=users.getString('text') ?? users.getString('value') ?? users.getString('name') ?? users.getString('word') ?? users.getString('nickname') ?? users.getString('id') ?? users.getString('user_id');
  const sub=interaction.options.getSubcommand(false);
  const group=interaction.options.getSubcommandGroup(false);
  const args=[];
  if(group) args.push(group);
  if(sub) args.push(sub);
  if(user) args.push(`<@${user.id}>`);
  if(role) args.push(`<@&${role.id}>`);
  if(channel) args.push(`<#${channel.id}>`);
  const n=users.getInteger('amount') ?? users.getInteger('seconds') ?? users.getInteger('value');
  if(n!==null) args.push(String(n));
  if(text) args.push(text);
  const reason=users.getString('reason'); if(reason) args.push(reason);
  const nickname=users.getString('nickname'); if(nickname && text!==nickname) args.push(nickname);
  const mentions={
    users:{first:()=>user},
    members:{first:()=>user?interaction.guild?.members.cache.get(user.id):null},
    roles:{first:()=>role},
    channels:{first:()=>channel}
  };
  return {
    guild:interaction.guild, member:interaction.member, author:interaction.user,
    channel:interaction.channel, mentions, content:'',
    reply:async payload=>{if(typeof payload==='string') payload={content:payload}; return interaction.replied||interaction.deferred?interaction.followUp(payload):interaction.reply(payload);}
  };
}

async function handleSlashInteraction(interaction) {
  if(!interaction.isChatInputCommand() || interaction.commandName==='owner') return;
  if(!interaction.guild) return interaction.reply({content:'❌ Server only.',ephemeral:true});
  const fake=fakeMessageFromInteraction(interaction,client);
  if(interaction.commandName==='help') return handlePrefix(fake,'help',[interaction.options.getString('category')||''],client);
  if(interaction.commandName==='list') return handlePrefix(fake,'list',['admins'],client);
  const group=interaction.options.getSubcommandGroup(false), sub=interaction.options.getSubcommand(false);
  let args=[];
  if(group) args.push(group,sub);
  else if(sub) args.push(sub);
  const u=interaction.options.getUser('user');
  const r=interaction.options.getRole('role');
  const ch=interaction.options.getChannel('channel');
  if(u) args.push(`<@${u.id}>`);
  if(r) args.push(`<@&${r.id}>`);
  if(ch) args.push(`<#${ch.id}>`);
  const id=interaction.options.getString('user_id')||interaction.options.getString('id'); if(id) args.push(id);
  const amount=interaction.options.getInteger('amount'); if(amount!==null) args.push(String(amount));
  const integerValue=interaction.options.getInteger('value'); if(integerValue!==null) args.push(String(integerValue));
  const numberValue=interaction.options.getNumber('value'); if(numberValue!==null) args.push(String(numberValue));
  const strValue=interaction.options.getString('value'); if(strValue) args.push(strValue);
  for(const key of ['text','name','word','nickname','reason']) { const v=interaction.options.getString(key); if(v) args.push(v); }
  if(interaction.options.getBoolean('bots')) args.push('bot');
  if(interaction.commandName==='role'&&sub==='add'||interaction.commandName==='role'&&sub==='remove'){
    // handler expects user before role in mentions; rebuild when both were supplied
    args=[sub, ...(u?[`<@${u.id}>`]:[]), ...(r?[`<@&${r.id}>`]:[])];
  }
  if(interaction.commandName==='role'&&['delete','colour','rename','all','bots','humans','info'].includes(sub)) args=[sub, ...(r?[`<@&${r.id}>`]:[]), ...(interaction.options.getString('value')?[interaction.options.getString('value')]:[]), ...(interaction.options.getString('name')?[interaction.options.getString('name')]:[])];
  if(interaction.commandName==='antinuke'&&['whitelist','wlrole'].includes(sub)) args=[sub,...(u?[`<@${u.id}>`]:[]),...(r?[`<@&${r.id}>`]:[])];
  if(interaction.commandName==='logging'&&['enable','disable'].includes(sub)) args=[sub,...(interaction.options.getString('category')?[interaction.options.getString('category')]:[]),...(ch?[`<#${ch.id}>`]:[])];
  if(interaction.commandName==='welcomer'&&sub==='test') args=[sub,...(u?[`<@${u.id}>`]:[])];
  if(interaction.commandName==='vcrole'&&sub==='add') args=[sub,...(r?[`<@&${r.id}>`]:[])];
  if(interaction.commandName==='prefix'&&['set','add'].includes(sub)) args=[sub,interaction.options.getString('value')||''];
  if(['antispam','antilink','antiword'].includes(interaction.commandName)&&group==='wl') args=['wl',sub,...(u?[`<@${u.id}>`]:[]),...(r?[`<@&${r.id}>`]:[])];
  if(interaction.commandName==='antiword'&&['add','remove'].includes(sub)) args=[sub,interaction.options.getString('word')||''];
  if(interaction.commandName==='automod'&&sub==='punishment') args=[sub,interaction.options.getString('value')||''];
  if(interaction.commandName==='antinuke'&&sub==='punishment') args=[sub,interaction.options.getString('value')||''];
  if(interaction.commandName==='antiraid'&&['action','threshold','age_limit'].includes(sub)) args=[sub,...(interaction.options.getString('value')?[interaction.options.getString('value')]:[]),...(interaction.options.getInteger('value')!==null?[String(interaction.options.getInteger('value'))]:[]),...(interaction.options.getNumber('value')!==null?[String(interaction.options.getNumber('value'))]:[])];
  if(['kick','ban','mute','unmute','warn'].includes(interaction.commandName)) args=[...(u?[`<@${u.id}>`]:[]),...(interaction.options.getString('reason')?[interaction.options.getString('reason')]:[])];
  if(interaction.commandName==='nick') args=[...(interaction.options.getString('action')?[interaction.options.getString('action')]:[]),...(u?[`<@${u.id}>`]:[]),...(interaction.options.getString('nickname')?[interaction.options.getString('nickname')]:[])];
  if(interaction.commandName==='purge') args=[...(interaction.options.getBoolean('bots')?['bot']:[]),...(u?[`<@${u.id}>`]:[]),...(amount!==null?[String(amount)]:[])];
  if(['av','ab','viewperms','viewuser','vckick','vcpull','vcmute','vcdeafen'].includes(interaction.commandName)) args=[...(u?[`<@${u.id}>`]:[])];
  if(interaction.commandName==='setprefix') args=[interaction.options.getString('text')||''];
  if(interaction.commandName==='setidentity') args=[...(u?[`<@${u.id}>`]:[]),interaction.options.getString('text')||''];
  if(interaction.commandName==='createrole') args=[interaction.options.getString('text')||'New Role'];
  if(interaction.commandName==='unban') args=[interaction.options.getString('user_id')||''];
  if(interaction.commandName==='delwarn') args=[interaction.options.getString('id')||''];
  try {
    const result=await handlePrefix(fake,interaction.commandName,args,client);
    if(!interaction.replied&&!interaction.deferred) await interaction.reply({content:'✅ Done.'});
    return result;
  } catch(e) {
    console.error('slash command',interaction.commandName,e);
    if(!interaction.replied&&!interaction.deferred) await interaction.reply({content:`❌ ${e.message}`,ephemeral:true});
  }
}

client.once('ready',async()=>{
  console.log(`✅ Logged in as ${client.user.tag} (${client.user.id})`);console.log(`🌐 Guilds: ${client.guilds.cache.size}`);client.user.setActivity('server security',{type:ActivityType.Watching});
  for(const g of client.guilds.cache.values()){guildConfig(g.id);await snapshotGuild(g).catch(e=>console.error('snapshot',e.message));try{client.invites.set(g.id,await g.invites.fetch());}catch{}}
  const rest=new REST({version:'10'}).setToken(TOKEN);try{const body=[...buildSlashCommands(),ownerSlash];const gid=process.env.DISCORD_GUILD_ID;if(gid){await rest.put(Routes.applicationGuildCommands(client.user.id,gid),{body});console.log(`✅ ${body.length} slash commands registered for ${gid}.`);}else{await rest.put(Routes.applicationCommands(client.user.id),{body});console.log(`✅ ${body.length} global slash commands registered.`);}}catch(e){console.error('❌ Slash registration failed:',e.message)}
});

client.on('messageDelete',m=>{if(m.author)client.deleted.set(m.channel.id,{author:m.author.tag,content:m.content,at:Date.now()});});
client.on('messageUpdate',(oldMsg,newMsg)=>{if(oldMsg.author&&oldMsg.content!==newMsg.content)client.edited.set(oldMsg.channel.id,{author:oldMsg.author.tag,before:oldMsg.content,after:newMsg.content,at:Date.now()});});

client.on('messageCreate',async msg=>{
  if(msg.author.bot)return;
  if(msg.guild){const c=guildConfig(msg.guild.id);c.tracking.messages[msg.author.id]=(c.tracking.messages[msg.author.id]||0)+1;const d=new Date().toISOString().slice(0,10);c.tracking.daily[d] ||= {};c.tracking.daily[d][msg.author.id]=(c.tracking.daily[d][msg.author.id]||0)+1;}
  if(!msg.guild)return;
  const c=guildConfig(msg.guild.id);const prefix=c.prefix||'!';let used=null;if(msg.content.startsWith(prefix))used=prefix;else if(msg.content.startsWith('.')&&['automod','antispam','antilink','antiword'].includes(msg.content.slice(1).trim().split(/\s+/)[0].toLowerCase()))used='.';
  if(used){const bits=msg.content.slice(used.length).trim().split(/\s+/);const name=(bits.shift()||'').toLowerCase();if(c.emergency&&!isBotOwner(msg.author.id))return safeReply(msg,'🚨 Emergency protection is active. Commands are temporarily disabled.');await handlePrefix(msg,name,bits,client).catch(e=>{console.error(`command ${name}:`,e);safeReply(msg,`❌ ${e.message}`);});return;}
  await automod(msg);
  for(const u of msg.mentions.users.values()){if(c.afk?.[u.id])await safeReply(msg,`💤 **${u.username}** is AFK: ${c.afk[u.id].reason}`);}
  if(c.afk?.[msg.author.id]){const r=c.afk[msg.author.id].reason;delete c.afk[msg.author.id];await saveState();await safeReply(msg,`👋 Welcome back! AFK removed (**${r}**).`);}
});

async function automod(msg){const c=guildConfig(msg.guild.id),m=msg.member;const allowed=k=>c.automod.whitelists[k].users.includes(msg.author.id)||m.roles.cache.some(r=>c.automod.whitelists[k].roles.includes(r.id));
  if(c.automod.antilink&&!allowed('antilink')&&/(https?:\/\/|discord\.gg\/|www\.)/i.test(msg.content)){await msg.delete().catch(()=>{});return autoPunish(msg,'antilink');}
  if(c.automod.antiword&&!allowed('antiword')&&c.automod.words.some(w=>w&&msg.content.toLowerCase().includes(w))){await msg.delete().catch(()=>{});return autoPunish(msg,'antiword');}
  if(c.automod.antispam&&!allowed('antispam')){const key=`${msg.guild.id}:${msg.author.id}`,now=Date.now();const arr=(client.spam.get(key)||[]).filter(t=>now-t<c.automod.spamWindow);arr.push(now);client.spam.set(key,arr);if(arr.length>=c.automod.spamLimit){client.spam.set(key,[]);return autoPunish(msg,'antispam');}}
}
async function autoPunish(msg,why){const p=guildConfig(msg.guild.id).automod.punishment;if(p==='timeout')await msg.member.timeout(60000,`AutoMod: ${why}`).catch(()=>{});if(p==='warn'){const c=guildConfig(msg.guild.id);c.warnings[msg.author.id] ||= [];c.warnings[msg.author.id].push({id:Date.now().toString(36),moderator:client.user.id,reason:`AutoMod: ${why}`,at:Date.now()});await saveState();}await logEvent(msg.guild,'automod','🤖 AutoMod action',`${msg.author} — **${why}**`,COLORS.warn);}

client.on('inviteCreate',async invite=>{try{const c=guildConfig(invite.guild.id);c.tracking.invites ||= {};client.invites.get(invite.guild.id)?.set(invite.code,invite);await saveState();}catch{}});
client.on('inviteDelete',async invite=>{client.invites.get(invite.guild.id)?.delete(invite.code);});
client.on('guildMemberAdd',async m=>{const g=m.guild,c=guildConfig(g.id);if(m.user.bot&&c.antinuke.enabled){const ex=await getAuditExecutor(g,AuditLogEvent.BotAdd,m.id);if(ex)await punishNuker(g,ex,`Unauthorized bot addition: ${m.user.tag}`);}try{const before=client.invites.get(g.id)||new Map();const after=await g.invites.fetch();const used=[...after.values()].find(i=>(before.get(i.code)?.uses||0)<(i.uses||0));if(used?.inviter?.id){c.tracking.invites[used.inviter.id]=(c.tracking.invites[used.inviter.id]||0)+1;}client.invites.set(g.id,after);}catch{}if(c.welcome.enabled&&c.welcome.channelId){const ch=g.channels.cache.get(c.welcome.channelId);if(ch?.isTextBased()){const e=makeEmbed('👋 Welcome',formatWelcome(c.welcome.message,m));if(c.welcome.image)e.setImage(c.welcome.image);if(c.welcome.embed)e.addFields({name:'Saved embed',value:c.welcome.embed});await ch.send({embeds:[e]}).catch(()=>{});}}
  if(c.vcrole){const r=g.roles.cache.get(c.vcrole);if(r)await m.roles.add(r).catch(()=>{});}if(c.antiraid.enabled){const now=Date.now(),arr=(client.joins.get(g.id)||[]).filter(x=>now-x<c.antiraid.windowSeconds*1000);arr.push(now);client.joins.set(g.id,arr);const age=Date.now()-m.user.createdTimestamp;const suspicious=(c.antiraid.ageLimit>0&&age<c.antiraid.ageLimit*86400000)||(c.antiraid.avatarCheck&&!m.user.avatar);if(suspicious||arr.length>=c.antiraid.threshold){if(c.antiraid.verification)await g.setVerificationLevel(4,'Anti-raid detection').catch(()=>{});if(c.antiraid.deleteInvites){try{const inv=await g.invites.fetch();for(const i of inv.values())await i.delete('Anti-raid detection').catch(()=>{});}catch{}}if(c.antiraid.lockdown)await setServerLock(g,true,'Anti-raid lockdown');if(suspicious){if(c.antiraid.action==='ban'&&m.bannable)await m.ban({reason:'Anti-raid'}).catch(()=>{});else if(m.kickable)await m.kick('Anti-raid').catch(()=>{});}await logEvent(g,'antiraid','🚨 Anti-raid detection',`Joins detected: **${arr.length}**`,COLORS.bad);}}await logEvent(g,'joinleave','📥 Member joined',`${m} (\`${m.id}\`)`);});
client.on('guildMemberRemove',async m=>{await logEvent(m.guild,'joinleave','📤 Member left',`${m.user.tag} (\`${m.id}\`)`);const c=guildConfig(m.guild.id);if(c.antinuke.enabled){const ex=await getAuditExecutor(m.guild,AuditLogEvent.MemberKick,m.id);if(ex)await punishNuker(m.guild,ex,`Unauthorized kick of ${m.user.tag}`);}});
client.on('guildBanAdd',async b=>{const c=guildConfig(b.guild.id);await logEvent(b.guild,'moderation','🔨 Member banned',`${b.user.tag}`);if(c.antinuke.enabled){const ex=await getAuditExecutor(b.guild,AuditLogEvent.MemberBanAdd,b.user.id);await punishNuker(b.guild,ex,`Unauthorized ban of ${b.user.tag}`);}});
for(const [event,type,label] of [['channelCreate',AuditLogEvent.ChannelCreate,'📁 Channel created'],['channelDelete',AuditLogEvent.ChannelDelete,'🗑️ Channel deleted'],['roleCreate',AuditLogEvent.RoleCreate,'🎭 Role created'],['roleDelete',AuditLogEvent.RoleDelete,'🗑️ Role deleted']])client.on(event,async obj=>{const g=obj.guild;if(!g)return;const cat=event.startsWith('role')?'role':'channel';await logEvent(g,cat,label,`[${obj.name||obj.id}]`.replace(/[\u001b]/g,''));const c=guildConfig(g.id);if(c.antinuke.enabled){const ex=await getAuditExecutor(g,type,obj.id);await punishNuker(g,ex,`Unauthorized ${event.replace('Create',' creation').replace('Delete',' deletion')}: ${obj.name}`);if(event.endsWith('Delete')&&!authorizedExecutor(g,ex))await restoreSnapshot(g);}});
client.on('guildUpdate',async(before,after)=>{await logEvent(after,'server','⚙️ Server updated',`Name: **${before.name}** → **${after.name}**`);const c=guildConfig(after.id);if(c.antinuke.enabled){const ex=await getAuditExecutor(after,AuditLogEvent.GuildUpdate,after.id);if(ex&&!authorizedExecutor(after,ex)){await punishNuker(after,ex,'Unauthorized server modification');if(before.name!==after.name)await after.setName(before.name,'Automatic disaster recovery').catch(()=>{});}}});
client.on('guildMemberUpdate',async(before,after)=>{const c=guildConfig(after.guild.id);if(c.nickLocks.includes(after.id)&&before.nickname!==after.nickname){if(after.manageable)await after.setNickname(before.nickname,'Nickname lock').catch(()=>{});}});
client.on('voiceStateUpdate',async(before,after)=>{const c=guildConfig(after.guild.id);if(!before.channelId&&after.channelId&&c.vcrole){const r=after.guild.roles.cache.get(c.vcrole);if(r)await after.member.roles.add(r).catch(()=>{});}if(before.channelId!==after.channelId)await logEvent(after.guild,'voice','🎙️ Voice state',`${after.member} ${before.channelId?'left':'joined'} ${after.channel?.name||'voice'}`);});
client.on('messageDeleteBulk',async messages=>{const first=messages.first();if(first?.guild)await logEvent(first.guild,'message','🧹 Messages purged',`**${messages.size}** messages deleted in ${first.channel}.`);});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'owner') return handleSlashInteraction(interaction);

  if (!isBotOwner(interaction.user.id)) return interaction.reply({content:'❌ Owner-only command.',ephemeral:true});
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;

  if (['add','remove','list','transfer','permissions','audit'].includes(sub)) {
    if (sub === 'add') {
      const user = interaction.options.getUser('user');
      if (!state.owners.includes(user.id)) state.owners.push(user.id);
      await auditOwner('add', interaction.user.id, user.id);
      return interaction.reply(`✅ Added ${user} as bot owner.`);
    }
    if (sub === 'remove') {
      const user = interaction.options.getUser('user');
      if (state.owners.length <= 1) return interaction.reply({content:'❌ Cannot remove the last owner.',ephemeral:true});
      state.owners = state.owners.filter(x => x !== user.id);
      await auditOwner('remove', interaction.user.id, user.id);
      return interaction.reply(`✅ Removed ${user}.`);
    }
    if (sub === 'list') {
      return interaction.reply({embeds:[makeEmbed('👑 Bot Owners',state.owners.map(x=>`• <@${x}> — \`${x}\``).join('\\n')||'None')]});
    }
    if (sub === 'transfer') {
      const user = interaction.options.getUser('user');
      state.owners = [user.id];
      await auditOwner('transfer', interaction.user.id, user.id);
      return interaction.reply(`👑 Ownership transferred to ${user}.`);
    }
    if (sub === 'permissions') return interaction.reply({embeds:[makeEmbed('👑 Owner Permissions','Owner controls bypass normal server permission checks; Discord API permissions and role hierarchy still apply.')]});
    return interaction.reply({embeds:[makeEmbed('🧾 Owner Audit',state.ownerAudit.slice(0,20).map(x=>`<t:${Math.floor(x.at/1000)}:R> <@${x.actor}> **${x.action}** ${x.target?`<@${x.target}>`:''}`).join('\\n')||'No actions logged.')]});
  }

  if (!guild) return interaction.reply({content:'❌ Server only.',ephemeral:true});
  if (sub === 'lockdown') {
    await setServerLock(guild,true,'Owner lockdown');
    await auditOwner('lockdown',interaction.user.id,guild.id);
    return interaction.reply('🔒 Entire server locked.');
  }
  if (sub === 'unlock') {
    await setServerLock(guild,false,'Owner unlock');
    await auditOwner('unlock',interaction.user.id,guild.id);
    return interaction.reply('🔓 Entire server unlocked.');
  }
  if (sub === 'slowmode-all') {
    const seconds = interaction.options.getInteger('seconds');
    for (const ch of guild.channels.cache.values()) if (ch.type === ChannelType.GuildText) await ch.setRateLimitPerUser(seconds,'Owner slowmode-all').catch(()=>{});
    await auditOwner('slowmode-all',interaction.user.id,String(seconds));
    return interaction.reply(`🐢 Slowmode set to **${seconds}s** on all text channels.`);
  }
  if (sub === 'emergency') {
    const c = guildConfig(guild.id);
    c.emergency = true;
    c.antinuke.enabled = true;
    c.antinuke.strict = true;
    c.antinuke.panic = true;
    await snapshotGuild(guild);
    await setServerLock(guild,true,'Owner emergency protection');
    await auditOwner('emergency',interaction.user.id,guild.id);
    await logEvent(guild,'owner','🚨 Emergency mode','Owner activated emergency protection.',COLORS.bad);
    for (const ownerId of state.owners) {
      const user = await client.users.fetch(ownerId).catch(()=>null);
      if (user) await user.send(`🚨 Emergency protection activated in **${guild.name}**.`).catch(()=>{});
    }
    return interaction.reply('🚨 Emergency protection activated.');
  }
});

function formatWelcome(text,member){return String(text).replaceAll('{user.mention}',member.toString()).replaceAll('{user.name}',member.user.username).replaceAll('{guild.name}',member.guild.name).replaceAll('{guild.member_count}',String(member.guild.memberCount));}
const app=express();app.get('/',(_,res)=>res.json({ok:true,ready:client.isReady(),bot:client.user?.tag||null,guilds:client.guilds.cache.size,commands:TOTAL_COMMANDS}));app.get('/health',(_,res)=>res.status(client.isReady()?200:503).json({ok:client.isReady(),ready:client.isReady(),guilds:client.guilds.cache.size}));app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`🌐 Health server online on ${process.env.PORT||3000}`));
setInterval(()=>saveNow().catch(()=>{}),30000);setInterval(async()=>{for(const g of client.guilds.cache.values()){const c=guildConfig(g.id);if(c.antinuke.enabled||c.antiraid.enabled)await snapshotGuild(g).catch(()=>{});}},15*60*1000);
client.on('error',e=>console.error('❌ Discord client error:',e));client.on('shardError',e=>console.error('❌ Discord gateway error:',e));client.on('invalidated',()=>console.error('❌ Discord session invalidated.'));process.on('unhandledRejection',e=>console.error('❌ Unhandled rejection:',e));process.on('uncaughtException',e=>console.error('❌ Uncaught exception:',e));
try{await client.login(TOKEN);}catch(e){console.error('❌ Discord login failed:',e);process.exit(1);}
