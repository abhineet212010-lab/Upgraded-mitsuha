import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || '/app/data';
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

const LOG_CATEGORIES = ['message','member','moderation','channel','role','voice','server','invite','automod','antinuke','antiraid','owner','joinleave'];
export { LOG_CATEGORIES };

export function defaultGuild() {
  return {
    prefix: '!',
    warnings: {},
    nickLocks: [],
    logging: Object.fromEntries(LOG_CATEGORIES.map(x => [x, null])),
    welcome: { enabled:false, channelId:null, message:'Welcome {user.mention} to **{guild.name}**! You are member #{guild.member_count}.', image:null, embed:null },
    antinuke: { enabled:false, punishment:'striproles', logChannelId:null, strict:false, lockdown:false, panic:false, whitelistUsers:[], whitelistRoles:[], limits:{channelDelete:3,channelCreate:5,roleDelete:3,roleCreate:5,kick:5,ban:5} },
    antiraid: { enabled:false, action:'kick', threshold:5, windowSeconds:10, lockdown:false, ageLimit:0, verification:false, avatarCheck:false, deleteInvites:false },
    automod: { antispam:false, antilink:false, antiword:false, punishment:'delete', spamWindow:5000, spamLimit:5, words:[], whitelists:{antispam:{users:[],roles:[]},antilink:{users:[],roles:[]},antiword:{users:[],roles:[]}} },
    vcrole: null,
    join2create: { enabled:false, triggerChannelId:null, categoryId:null, limit:0 },
    identities: {},
    tracking: { messages:{}, daily:{}, invites:{} },
    snapshot: null,
    emergency: false,
    branding: { name:null, icon:null, banner:null, description:null },
    tickets: { enabled:false, categoryId:null, supportRoleId:null },
    social: { autoresponders:{} },
    embeds: {}
  };
}

export const state = { guilds:{}, owners:[], ownerAudit:[] };
let saveTimer = null;

export async function initStore() {
  await fs.mkdir(DATA_DIR, {recursive:true});
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE,'utf8'));
    state.guilds = parsed.guilds || {};
    state.owners = Array.isArray(parsed.owners) ? parsed.owners : [];
    state.ownerAudit = Array.isArray(parsed.ownerAudit) ? parsed.ownerAudit : [];
  } catch {}
  if (process.env.BOT_OWNER_ID && !state.owners.includes(String(process.env.BOT_OWNER_ID))) state.owners.push(String(process.env.BOT_OWNER_ID));
  await saveState();
}
export async function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow().catch(console.error), 100);
}
export async function saveNow() {
  const tmp = STATE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state,null,2));
  await fs.rename(tmp, STATE_FILE);
}
export function guildConfig(guildId) {
  if (!state.guilds[guildId]) state.guilds[guildId] = defaultGuild();
  return state.guilds[guildId];
}
