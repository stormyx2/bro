require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits: P,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  Routes,
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const config = require("./config.json"); // only needs: { "token": "..." }
const { startWebServer } = require("./web");

process.on("unhandledRejection", (err) => console.error("Unhandled:", err));
process.on("uncaughtException", (err) => console.error("Crash:", err));

// =====================================================
// DATA STORAGE (JSON files)
// =====================================================
function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify(data, null, 2));
}

let voiceData = loadJSON("voice-data.json", {}); // { guildId: channelId }
let warnData = loadJSON("warnings.json", {}); // { guildId: { userId: [warns] } }
let settings = loadJSON("settings.json", {}); // { guildId: { logChannel } }

// =====================================================
// CLIENT
// =====================================================
// GuildMessages + MessageContent are needed so the dashboard's leveling/message-count and
// auto-reply features can actually see chat messages — without them, messageCreate never
// fires for real messages. GuildMembers is needed so the welcome system sees new joins.
// GuildMessageReactions is needed so the Self Roles feature sees people reacting to the
// role-message with an emoji — without it, messageReactionAdd/Remove never fire.
// These are "privileged" intents (Members/Content): they must ALSO be turned on in the
// Discord Developer Portal (your app → Bot tab → Privileged Gateway Intents), or the bot
// will fail to log in.
// Icon shown next to the bot's status. See the note on ws.properties below.
const BOT_PLATFORM = "Discord Embedded"; // try "Discord iOS" (phone), "Discord Client" (desktop)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Partials let reaction/message events fire even for messages the bot hasn't cached
  // (e.g. posted before a restart) — required for Self Roles reactions to be reliable.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
  // The little icon next to the bot's status comes from this "browser" value:
  //   "Discord iOS" / "Discord Android" -> phone icon (reliable)
  //   "Discord Client"                  -> desktop icon
  //   "Discord Embedded"                -> embedded / console-style
  // Discord has NO official VR platform, so a VR headset icon is NOT guaranteed.
  // Change BOT_PLATFORM near the top and restart to experiment.
  ws: { properties: { browser: BOT_PLATFORM } },
});

// =====================================================
// ROTATING STATUS — edit STATUS_LIST to change what it says
// {servers} and {members} get swapped for real numbers
// =====================================================
const STATUS_MODE = "dnd"; // "online", "idle", "dnd" or "invisible"
const STATUS_LIST = [
  "🌑 /help • in the dark",
  "👁️ watching {members} members",
  "🛡️ guarding {servers} servers",
  "🎮 /rps • /8ball • /ship",
];
const STATUS_EVERY_MS = 15_000; // Discord limits fast status changes, keep this 15s or more

// =====================================================
// NAME STYLE (font + effect + color on the bot's name)
// Unofficial: Discord doesn't document this for bots, so it could stop working
// any time. If it fails, the bot still runs — check the console message.
//
// FONTS:   11 Default, 3 Sakura, 4 Jellybean, 6 Modern, 7 Medieval, 8 8Bit,
//          10 Vampyre, 12 Tempo, 13 Monkey Bars, 14 Mainframe, 15 Headbang, 16 Journal
// EFFECTS: 1 Solid (1 color), 2 Gradient (2 colors), 3 Neon (1 color),
//          4 Toon (1 color), 5 Pop (1 color), 6 Glow (1-2 colors)
// COLORS:  hex like 0xFFFFFF (white). Neon needs exactly 1 color.
// =====================================================
const NAME_STYLE = {
  font: 14, // Mainframe (techy). Try 8 for 8Bit or 10 for Vampyre
  effect: 3, // Neon glow
  colors: [0xffffff], // white neon for the black-and-white look
};

async function applyNameStyle() {
  const body = {
    display_name_font_id: NAME_STYLE.font,
    display_name_effect_id: NAME_STYLE.effect,
    display_name_colors: NAME_STYLE.colors,
  };
  // 1) try the bot's global profile
  try {
    await client.rest.patch(Routes.user("@me"), { body });
    console.log("✅ Name style applied (global)");
    return;
  } catch (err) {
    console.log("ℹ️ Global name style didn't work:", err.status || "", err.message);
  }
  // 2) fall back to each server (per-server style), slowly to avoid rate limits
  let ok = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      await client.rest.patch(Routes.guildMember(guild.id, "@me"), { body });
      ok++;
    } catch (err) {
      console.log(`ℹ️ Name style failed in ${guild.name}:`, err.status || "", err.message);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`✅ Name style applied in ${ok}/${client.guilds.cache.size} servers`);
}

function startRotatingStatus() {
  let n = 0;
  const update = () => {
    const members = client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);
    const text = STATUS_LIST[n % STATUS_LIST.length]
      .replace("{servers}", client.guilds.cache.size.toLocaleString())
      .replace("{members}", members.toLocaleString());
    client.user.setPresence({
      status: STATUS_MODE,
      activities: [{ name: "custom", type: 4, state: text }], // type 4 = custom status bubble
    });
    n++;
  };
  update();
  setInterval(update, STATUS_EVERY_MS);
}

// =====================================================
// HELPERS
// =====================================================
const EPHEMERAL = MessageFlags.Ephemeral;
const COLORS = { ok: 0x57f287, bad: 0xed4245, warn: 0xfee75c, info: 0x5865f2 };

const embed = (color, title, desc) =>
  new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp();

async function dm(user, text) {
  try {
    await user.send(text);
  } catch {}
}

async function logAction(guild, e) {
  const id = settings[guild.id]?.logChannel;
  if (!id) return;
  const ch = guild.channels.cache.get(id);
  if (ch) ch.send({ embeds: [e] }).catch(() => {});
}

function parseDuration(str) {
  const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(str.trim());
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  return Number(m[1]) * mult[m[2].toLowerCase()];
}

// returns an error string, or null if the moderator is allowed to act on the target
function checkTarget(interaction, member, action) {
  if (!member) return "❌ That user isn't in this server.";
  if (member.id === interaction.user.id) return `❌ You can't ${action} yourself.`;
  if (member.id === client.user.id) return `❌ I can't ${action} myself.`;
  if (member.id === interaction.guild.ownerId) return `❌ You can't ${action} the server owner.`;
  if (
    interaction.user.id !== interaction.guild.ownerId &&
    member.roles.highest.position >= interaction.member.roles.highest.position
  )
    return "❌ That user's highest role is equal to or above yours.";
  return null;
}

const reply = (i, content) => i.reply({ content, flags: EPHEMERAL });

// =====================================================
// VOICE (24/7 in any server)
// =====================================================
function connectVoice(guildId, channelId) {
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(channelId);
  if (!channel) return false;

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      connection.destroy();
      if (voiceData[guildId]) setTimeout(() => connectVoice(guildId, voiceData[guildId]), 5000);
    }
  });
  return true;
}

// =====================================================
// COMMANDS
// =====================================================
const commands = [];
const add = (data, run) => commands.push({ data, run });

const guildOnly = (b) => b.setDMPermission(false);

// ---------- KICK ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Kick a member")
      .addUserOption((o) => o.setName("user").setDescription("Member to kick").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason"))
      .setDefaultMemberPermissions(P.KickMembers)
  ),
  async (i) => {
    const member = i.options.getMember("user");
    const reason = i.options.getString("reason") || "No reason provided";
    const err = checkTarget(i, member, "kick");
    if (err) return reply(i, err);
    if (!member.kickable) return reply(i, "❌ I can't kick that user (my role is too low).");
    await dm(member.user, `You were kicked from **${i.guild.name}**.\nReason: ${reason}`);
    await member.kick(`${i.user.tag}: ${reason}`);
    const e = embed(COLORS.warn, "👢 Member kicked", `**User:** ${member.user.tag}\n**Moderator:** ${i.user}\n**Reason:** ${reason}`);
    await i.reply({ embeds: [e] });
    logAction(i.guild, e);
  }
);

// ---------- BAN ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Ban a user")
      .addUserOption((o) => o.setName("user").setDescription("User to ban").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason"))
      .addIntegerOption((o) =>
        o.setName("delete_days").setDescription("Delete their messages from the last X days (0-7)").setMinValue(0).setMaxValue(7)
      )
      .setDefaultMemberPermissions(P.BanMembers)
  ),
  async (i) => {
    const user = i.options.getUser("user");
    const member = i.options.getMember("user");
    const reason = i.options.getString("reason") || "No reason provided";
    const days = i.options.getInteger("delete_days") || 0;
    if (member) {
      const err = checkTarget(i, member, "ban");
      if (err) return reply(i, err);
      if (!member.bannable) return reply(i, "❌ I can't ban that user (my role is too low).");
      await dm(user, `You were banned from **${i.guild.name}**.\nReason: ${reason}`);
    }
    await i.guild.members.ban(user, { reason: `${i.user.tag}: ${reason}`, deleteMessageSeconds: days * 86400 });
    const e = embed(COLORS.bad, "🔨 User banned", `**User:** ${user.tag}\n**Moderator:** ${i.user}\n**Reason:** ${reason}`);
    await i.reply({ embeds: [e] });
    logAction(i.guild, e);
  }
);

// ---------- UNBAN ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("unban")
      .setDescription("Unban a user by ID")
      .addStringOption((o) => o.setName("user_id").setDescription("User ID").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason"))
      .setDefaultMemberPermissions(P.BanMembers)
  ),
  async (i) => {
    const id = i.options.getString("user_id").trim();
    const reason = i.options.getString("reason") || "No reason provided";
    try {
      await i.guild.members.unban(id, `${i.user.tag}: ${reason}`);
    } catch {
      return reply(i, "❌ That user isn't banned, or the ID is wrong.");
    }
    const e = embed(COLORS.ok, "✅ User unbanned", `**User ID:** ${id}\n**Moderator:** ${i.user}\n**Reason:** ${reason}`);
    await i.reply({ embeds: [e] });
    logAction(i.guild, e);
  }
);

// ---------- TIMEOUT ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("Timeout a member")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("duration").setDescription("Like 10m, 2h, 1d (max 28d)").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason"))
      .setDefaultMemberPermissions(P.ModerateMembers)
  ),
  async (i) => {
    const member = i.options.getMember("user");
    const reason = i.options.getString("reason") || "No reason provided";
    const ms = parseDuration(i.options.getString("duration"));
    if (!ms) return reply(i, "❌ Use a duration like `30s`, `10m`, `2h`, `1d`, or `1w`.");
    if (ms > 28 * 864e5) return reply(i, "❌ The maximum timeout is 28 days.");
    const err = checkTarget(i, member, "timeout");
    if (err) return reply(i, err);
    if (!member.moderatable) return reply(i, "❌ I can't timeout that user (my role is too low).");
    await member.timeout(ms, `${i.user.tag}: ${reason}`);
    const until = Math.floor((Date.now() + ms) / 1000);
    await dm(member.user, `You were timed out in **${i.guild.name}** until <t:${until}:F>.\nReason: ${reason}`);
    const e = embed(
      COLORS.warn,
      "⏳ Member timed out",
      `**User:** ${member.user.tag}\n**Until:** <t:${until}:R>\n**Moderator:** ${i.user}\n**Reason:** ${reason}`
    );
    await i.reply({ embeds: [e] });
    logAction(i.guild, e);
  }
);

// ---------- UNTIMEOUT ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("untimeout")
      .setDescription("Remove a timeout")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .setDefaultMemberPermissions(P.ModerateMembers)
  ),
  async (i) => {
    const member = i.options.getMember("user");
    if (!member) return reply(i, "❌ That user isn't in this server.");
    if (!member.moderatable) return reply(i, "❌ I can't edit that user.");
    await member.timeout(null);
    const e = embed(COLORS.ok, "✅ Timeout removed", `**User:** ${member.user.tag}\n**Moderator:** ${i.user}`);
    await i.reply({ embeds: [e] });
    logAction(i.guild, e);
  }
);

// ---------- WARN ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Warn a member")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true))
      .setDefaultMemberPermissions(P.ModerateMembers)
  ),
  async (i) => {
    const member = i.options.getMember("user");
    const reason = i.options.getString("reason");
    const err = checkTarget(i, member, "warn");
    if (err) return reply(i, err);
    warnData[i.guildId] ??= {};
    warnData[i.guildId][member.id] ??= [];
    const list = warnData[i.guildId][member.id];
    list.push({ id: Date.now().toString(36), reason, mod: i.user.id, date: Date.now() });
    saveJSON("warnings.json", warnData);
    await dm(member.user, `You were warned in **${i.guild.name}**.\nReason: ${reason}`);
    const e = embed(
      COLORS.warn,
      "⚠️ Member warned",
      `**User:** ${member.user.tag}\n**Total warnings:** ${list.length}\n**Moderator:** ${i.user}\n**Reason:** ${reason}`
    );
    await i.reply({ embeds: [e] });
    logAction(i.guild, e);
  }
);

// ---------- WARNINGS ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("warnings")
      .setDescription("View a member's warnings")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .setDefaultMemberPermissions(P.ModerateMembers)
  ),
  async (i) => {
    const user = i.options.getUser("user");
    const list = warnData[i.guildId]?.[user.id] || [];
    if (!list.length) return reply(i, `✅ ${user.tag} has no warnings.`);
    const text = list
      .slice(-15)
      .map((w, n) => `**${n + 1}.** \`${w.id}\` • <t:${Math.floor(w.date / 1000)}:d> • <@${w.mod}>\n${w.reason}`)
      .join("\n\n");
    await i.reply({ embeds: [embed(COLORS.warn, `Warnings for ${user.tag} (${list.length})`, text)], flags: EPHEMERAL });
  }
);

// ---------- UNWARN ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("unwarn")
      .setDescription("Remove one warning by its ID")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("warn_id").setDescription("ID shown in /warnings").setRequired(true))
      .setDefaultMemberPermissions(P.ModerateMembers)
  ),
  async (i) => {
    const user = i.options.getUser("user");
    const wid = i.options.getString("warn_id").trim();
    const list = warnData[i.guildId]?.[user.id] || [];
    const idx = list.findIndex((w) => w.id === wid);
    if (idx === -1) return reply(i, "❌ Warning ID not found.");
    list.splice(idx, 1);
    saveJSON("warnings.json", warnData);
    await i.reply({ embeds: [embed(COLORS.ok, "✅ Warning removed", `Removed from ${user.tag}.`)] });
  }
);

// ---------- CLEARWARNINGS ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("clearwarnings")
      .setDescription("Clear all warnings of a member")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .setDefaultMemberPermissions(P.ModerateMembers)
  ),
  async (i) => {
    const user = i.options.getUser("user");
    if (warnData[i.guildId]) delete warnData[i.guildId][user.id];
    saveJSON("warnings.json", warnData);
    await i.reply({ embeds: [embed(COLORS.ok, "✅ Warnings cleared", `All warnings for ${user.tag} were removed.`)] });
  }
);

// ---------- PURGE ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("purge")
      .setDescription("Delete recent messages")
      .addIntegerOption((o) => o.setName("amount").setDescription("1-100").setMinValue(1).setMaxValue(100).setRequired(true))
      .addUserOption((o) => o.setName("user").setDescription("Only delete this user's messages"))
      .setDefaultMemberPermissions(P.ManageMessages)
  ),
  async (i) => {
    await i.deferReply({ flags: EPHEMERAL });
    const amount = i.options.getInteger("amount");
    const target = i.options.getUser("user");
    let msgs = await i.channel.messages.fetch({ limit: 100 });
    if (target) msgs = msgs.filter((m) => m.author.id === target.id);
    msgs = [...msgs.values()].slice(0, amount);
    const deleted = await i.channel.bulkDelete(msgs, true);
    await i.editReply(`🧹 Deleted **${deleted.size}** messages. (Messages older than 14 days can't be bulk deleted.)`);
  }
);

// ---------- SLOWMODE ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("slowmode")
      .setDescription("Set slowmode in this channel")
      .addIntegerOption((o) => o.setName("seconds").setDescription("0 to turn off (max 21600)").setMinValue(0).setMaxValue(21600).setRequired(true))
      .setDefaultMemberPermissions(P.ManageChannels)
  ),
  async (i) => {
    const s = i.options.getInteger("seconds");
    await i.channel.setRateLimitPerUser(s);
    await i.reply(s ? `🐌 Slowmode set to **${s}s**.` : "✅ Slowmode turned off.");
  }
);

// ---------- LOCK / UNLOCK ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("Stop everyone from sending messages in this channel")
      .setDefaultMemberPermissions(P.ManageChannels)
  ),
  async (i) => {
    await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: false });
    await i.reply({ embeds: [embed(COLORS.bad, "🔒 Channel locked", `${i.channel} was locked by ${i.user}.`)] });
  }
);
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("Unlock this channel")
      .setDefaultMemberPermissions(P.ManageChannels)
  ),
  async (i) => {
    await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: null });
    await i.reply({ embeds: [embed(COLORS.ok, "🔓 Channel unlocked", `${i.channel} was unlocked by ${i.user}.`)] });
  }
);

// ---------- NICK ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("nick")
      .setDescription("Change or reset a member's nickname")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("nickname").setDescription("New nickname (leave empty to reset)").setMaxLength(32))
      .setDefaultMemberPermissions(P.ManageNicknames)
  ),
  async (i) => {
    const member = i.options.getMember("user");
    if (!member) return reply(i, "❌ That user isn't in this server.");
    if (!member.manageable) return reply(i, "❌ I can't change that user's nickname.");
    await member.setNickname(i.options.getString("nickname") || null);
    await i.reply(`✅ Nickname updated for ${member.user.tag}.`);
  }
);

// ---------- ADDROLE / REMOVEROLE ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("addrole")
      .setDescription("Give a role to a member")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
      .setDefaultMemberPermissions(P.ManageRoles)
  ),
  async (i) => {
    const member = i.options.getMember("user");
    const role = i.options.getRole("role");
    if (!member) return reply(i, "❌ That user isn't in this server.");
    if (role.managed || role.position >= i.guild.members.me.roles.highest.position)
      return reply(i, "❌ I can't give that role (it's above my role or managed by an integration).");
    if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position)
      return reply(i, "❌ That role is equal to or above your highest role.");
    await member.roles.add(role);
    await i.reply(`✅ Gave **${role.name}** to ${member.user.tag}.`);
  }
);
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("removerole")
      .setDescription("Remove a role from a member")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
      .setDefaultMemberPermissions(P.ManageRoles)
  ),
  async (i) => {
    const member = i.options.getMember("user");
    const role = i.options.getRole("role");
    if (!member) return reply(i, "❌ That user isn't in this server.");
    if (role.managed || role.position >= i.guild.members.me.roles.highest.position)
      return reply(i, "❌ I can't remove that role.");
    if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position)
      return reply(i, "❌ That role is equal to or above your highest role.");
    await member.roles.remove(role);
    await i.reply(`✅ Removed **${role.name}** from ${member.user.tag}.`);
  }
);

// ---------- SETLOGS ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("setlogs")
      .setDescription("Set the channel where mod actions are logged")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Log channel").addChannelTypes(ChannelType.GuildText).setRequired(true)
      )
      .setDefaultMemberPermissions(P.Administrator)
  ),
  async (i) => {
    const ch = i.options.getChannel("channel");
    settings[i.guildId] ??= {};
    settings[i.guildId].logChannel = ch.id;
    saveJSON("settings.json", settings);
    await i.reply(`✅ Mod logs will be sent to ${ch}.`);
  }
);

// ---------- VOICE ----------
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("Join a voice channel and stay there 24/7")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Voice channel (default: the one you're in)")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      )
      .setDefaultMemberPermissions(P.ManageChannels)
  ),
  async (i) => {
    const channel = i.options.getChannel("channel") || i.member.voice.channel;
    if (!channel) return reply(i, "❌ Join a voice channel first, or pick one in the command.");
    voiceData[i.guildId] = channel.id;
    saveJSON("voice-data.json", voiceData);
    if (!connectVoice(i.guildId, channel.id)) return reply(i, "❌ I can't access that channel.");
    await i.reply({ content: `✅ Joined **${channel.name}** and I'll stay here.`, flags: EPHEMERAL });
  }
);
add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Leave the voice channel")
      .setDefaultMemberPermissions(P.ManageChannels)
  ),
  async (i) => {
    delete voiceData[i.guildId];
    saveJSON("voice-data.json", voiceData);
    getVoiceConnection(i.guildId)?.destroy();
    await i.reply({ content: "👋 Left the voice channel.", flags: EPHEMERAL });
  }
);

// ---------- UTILITY (everyone) ----------
add(new SlashCommandBuilder().setName("ping").setDescription("Check the bot's latency"), async (i) => {
  await i.reply(`🏓 Pong! **${client.ws.ping}ms**`);
});

add(
  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's avatar")
    .addUserOption((o) => o.setName("user").setDescription("User (default: you)")),
  async (i) => {
    const u = i.options.getUser("user") || i.user;
    await i.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`${u.tag}'s avatar`).setImage(u.displayAvatarURL({ size: 1024 }))],
    });
  }
);

add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("userinfo")
      .setDescription("Show info about a user")
      .addUserOption((o) => o.setName("user").setDescription("User (default: you)"))
  ),
  async (i) => {
    const u = i.options.getUser("user") || i.user;
    const m = i.options.getMember("user") || i.member;
    const e = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(u.tag)
      .setThumbnail(u.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "ID", value: u.id, inline: true },
        { name: "Created", value: `<t:${Math.floor(u.createdTimestamp / 1000)}:R>`, inline: true },
        { name: "Joined", value: m?.joinedTimestamp ? `<t:${Math.floor(m.joinedTimestamp / 1000)}:R>` : "Not in server", inline: true },
        { name: "Warnings", value: String(warnData[i.guildId]?.[u.id]?.length || 0), inline: true }
      );
    await i.reply({ embeds: [e] });
  }
);

add(guildOnly(new SlashCommandBuilder().setName("serverinfo").setDescription("Show info about this server")), async (i) => {
  const g = i.guild;
  const e = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(g.name)
    .setThumbnail(g.iconURL({ size: 256 }))
    .addFields(
      { name: "Owner", value: `<@${g.ownerId}>`, inline: true },
      { name: "Members", value: String(g.memberCount), inline: true },
      { name: "Channels", value: String(g.channels.cache.size), inline: true },
      { name: "Roles", value: String(g.roles.cache.size), inline: true },
      { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true }
    );
  await i.reply({ embeds: [e] });
});

add(
  new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the magic 8-ball")
    .addStringOption((o) => o.setName("question").setDescription("Your question").setRequired(true)),
  async (i) => {
    const a = ["Yes.", "No.", "Maybe.", "Definitely.", "Not a chance.", "Ask again later.", "Looks good.", "I wouldn't count on it."];
    await i.reply(`🎱 **${i.options.getString("question")}**\n${a[Math.floor(Math.random() * a.length)]}`);
  }
);

add(new SlashCommandBuilder().setName("coinflip").setDescription("Flip a coin"), async (i) => {
  await i.reply(`🪙 ${Math.random() < 0.5 ? "Heads" : "Tails"}!`);
});

add(
  new SlashCommandBuilder()
    .setName("roll")
    .setDescription("Roll a dice")
    .addIntegerOption((o) => o.setName("sides").setDescription("Sides (default 6)").setMinValue(2).setMaxValue(1000)),
  async (i) => {
    const s = i.options.getInteger("sides") || 6;
    await i.reply(`🎲 You rolled **${1 + Math.floor(Math.random() * s)}** (1-${s}).`);
  }
);

add(
  guildOnly(
    new SlashCommandBuilder()
      .setName("say")
      .setDescription("Make the bot say something")
      .addStringOption((o) => o.setName("message").setDescription("Message").setRequired(true))
      .setDefaultMemberPermissions(P.ManageMessages)
  ),
  async (i) => {
    await i.channel.send({ content: i.options.getString("message"), allowedMentions: { parse: [] } });
    await i.reply({ content: "✅ Sent.", flags: EPHEMERAL });
  }
);

add(new SlashCommandBuilder().setName("help").setDescription("List all commands"), async (i) => {
  const text =
    "**Moderation:** `/kick` `/ban` `/unban` `/timeout` `/untimeout` `/warn` `/warnings` `/unwarn` `/clearwarnings` `/purge` `/slowmode` `/lock` `/unlock` `/nick` `/addrole` `/removerole` `/setlogs`\n" +
    "**Voice:** `/join` `/leave`\n" +
    "**Info & fun:** `/ping` `/avatar` `/userinfo` `/serverinfo` `/8ball` `/coinflip` `/roll` `/say` `/help`";
  await i.reply({ embeds: [embed(COLORS.info, "Commands", text)], flags: EPHEMERAL });
});

// =====================================================
// EXTRAS — fun, server tools, moderation upgrades, tickets, economy, store, stats
// =====================================================
function setupExtras(ctx) {
  const {
    client, commands, add, embed, COLORS, EPHEMERAL, reply, checkTarget, dm,
    logAction, loadJSON, saveJSON, parseDuration, settings, warnData,
  } = ctx;

  const guildOnly = (b) => b.setDMPermission(false);
  const saveSettings = () => saveJSON("settings.json", settings);
  const ts = (ms) => Math.floor(ms / 1000);

  // ---------- data ----------
  const economy = loadJSON("economy.json", {}); // { guildId: { userId: { coins, lastDaily, lastWork } } }
  const giveaways = loadJSON("giveaways.json", {}); // { messageId: giveaway }
  let reminders = loadJSON("reminders.json", []); // [{ userId, channelId, text, at }]
  const polls = loadJSON("polls.json", {}); // { messageId: { question, options, votes, author } }
  const afk = loadJSON("afk.json", {}); // { guildId: { userId: { reason, since } } }
  const snipes = new Map(); // channelId -> last deleted message
  const spamTracker = new Map(); // "guild:user" -> [timestamps]
  const msgCoinCooldown = new Map(); // "guild:user" -> last time they earned message coins
  const voiceTime = new Map(); // "guild:user" -> { acc, last } time in voice not paid yet
  const statsUpdated = new Map(); // guildId -> last time the stats channels were renamed

  // =====================================================
  // FUN
  // =====================================================
  add(
    new SlashCommandBuilder()
      .setName("ship")
      .setDescription("Love % between two people")
      .addUserOption((o) => o.setName("user1").setDescription("First person").setRequired(true))
      .addUserOption((o) => o.setName("user2").setDescription("Second person (default: you)")),
    async (i) => {
      const a = i.options.getUser("user1");
      const b = i.options.getUser("user2") || i.user;
      let pct = 0;
      for (const c of [a.id, b.id].sort().join("")) pct = (pct * 31 + c.charCodeAt(0)) % 101;
      const full = Math.round(pct / 10);
      const bar = "💗".repeat(full) + "🖤".repeat(10 - full);
      const shipName = a.username.slice(0, Math.ceil(a.username.length / 2)) + b.username.slice(Math.floor(b.username.length / 2));
      const verdict = pct >= 80 ? "Soulmates 💍" : pct >= 50 ? "Cute couple 🥰" : pct >= 25 ? "Just friends 🤝" : "Not happening 💀";
      await i.reply({
        embeds: [embed(0xff69b4, `💘 ${a.username} + ${b.username}`, `**Ship name:** ${shipName}\n**${pct}%** — ${verdict}\n${bar}`)],
      });
    }
  );

  add(
    new SlashCommandBuilder()
      .setName("rate")
      .setDescription("Rate anything out of 10")
      .addStringOption((o) => o.setName("thing").setDescription("What to rate").setRequired(true).setMaxLength(100)),
    async (i) => {
      const score = Math.floor(Math.random() * 11);
      await i.reply(`⭐ I rate **${i.options.getString("thing")}** a **${score}/10**\n${"⭐".repeat(score)}${"▫️".repeat(10 - score)}`);
    }
  );

  add(new SlashCommandBuilder().setName("meme").setDescription("Get a random meme"), async (i) => {
    await i.deferReply();
    for (let tries = 0; tries < 5; tries++) {
      try {
        const m = await (await fetch("https://meme-api.com/gimme/memes")).json();
        if (!m?.url || m.nsfw || m.spoiler) continue;
        return i.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.info)
              .setTitle(String(m.title).slice(0, 256))
              .setURL(m.postLink)
              .setImage(m.url)
              .setFooter({ text: `r/${m.subreddit} • 👍 ${m.ups}` }),
          ],
        });
      } catch {}
    }
    await i.editReply("❌ Couldn't get a meme right now, try again.");
  });

  add(new SlashCommandBuilder().setName("rps").setDescription("Play rock paper scissors against the bot"), async (i) => {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rps:rock:${i.user.id}`).setLabel("Rock").setEmoji("🪨").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rps:paper:${i.user.id}`).setLabel("Paper").setEmoji("📄").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rps:scissors:${i.user.id}`).setLabel("Scissors").setEmoji("✂️").setStyle(ButtonStyle.Primary)
    );
    await i.reply({ content: "🎮 **Rock, paper, scissors!** Pick one:", components: [row] });
  });

  add(guildOnly(new SlashCommandBuilder().setName("snipe").setDescription("Show the last deleted message in this channel")), async (i) => {
    const s = snipes.get(i.channelId);
    if (!s) return reply(i, "❌ Nothing to snipe here.");
    const e = new EmbedBuilder()
      .setColor(COLORS.info)
      .setAuthor({ name: s.author, iconURL: s.avatar })
      .setDescription(s.content || "*(no text)*")
      .setFooter({ text: "Deleted" })
      .setTimestamp(s.at);
    if (s.image) e.setImage(s.image);
    await i.reply({ embeds: [e] });
  });

  // =====================================================
  // SERVER TOOLS
  // =====================================================
  // ---------- POLL ----------
  function pollEmbed(p) {
    const counts = p.options.map((_, n) => Object.values(p.votes).filter((v) => v === n).length);
    const total = counts.reduce((a, b) => a + b, 0);
    const lines = p.options.map((o, n) => {
      const pct = total ? Math.round((counts[n] / total) * 100) : 0;
      const fill = Math.round(pct / 10);
      return `**${n + 1}. ${o}**\n${"█".repeat(fill)}${"░".repeat(10 - fill)} ${pct}% (${counts[n]})`;
    });
    return embed(COLORS.info, `📊 ${p.question}`, lines.join("\n\n")).setFooter({
      text: `${total} vote${total === 1 ? "" : "s"} • poll by ${p.author}`,
    });
  }
  const pollRow = (p) =>
    new ActionRowBuilder().addComponents(
      p.options.map((o, n) =>
        new ButtonBuilder().setCustomId(`poll:${n}`).setLabel(`${n + 1}. ${o}`.slice(0, 80)).setStyle(ButtonStyle.Primary)
      )
    );

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("poll")
        .setDescription("Create a poll with buttons")
        .addStringOption((o) => o.setName("question").setDescription("The question").setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName("option1").setDescription("Option 1").setRequired(true).setMaxLength(70))
        .addStringOption((o) => o.setName("option2").setDescription("Option 2").setRequired(true).setMaxLength(70))
        .addStringOption((o) => o.setName("option3").setDescription("Option 3").setMaxLength(70))
        .addStringOption((o) => o.setName("option4").setDescription("Option 4").setMaxLength(70))
    ),
    async (i) => {
      const options = [1, 2, 3, 4].map((n) => i.options.getString(`option${n}`)).filter(Boolean);
      const p = { question: i.options.getString("question"), options, votes: {}, author: i.user.username };
      await i.reply({ embeds: [pollEmbed(p)], components: [pollRow(p)] });
      const msg = await i.fetchReply();
      polls[msg.id] = p;
      saveJSON("polls.json", polls);
    }
  );

  // ---------- GIVEAWAY ----------
  const giveawayEmbed = (g, winnersText) =>
    new EmbedBuilder()
      .setColor(winnersText ? COLORS.bad : 0xff73fa)
      .setTitle(`🎉 ${g.prize}`)
      .setDescription(
        winnersText
          ? `**Winners:** ${winnersText}\n**Hosted by:** <@${g.host}>\n**Entries:** ${g.entries.length}`
          : `Click **🎉 Enter** to join!\n\n**Ends:** <t:${ts(g.end)}:R>\n**Winners:** ${g.winners}\n**Hosted by:** <@${g.host}>\n**Entries:** ${g.entries.length}`
      )
      .setFooter({ text: winnersText ? "Giveaway ended" : "Ends at" })
      .setTimestamp(g.end);
  const giveawayRow = () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("gw:enter").setLabel("Enter").setEmoji("🎉").setStyle(ButtonStyle.Success)
    );

  async function endGiveaway(id, reroll = false) {
    const g = giveaways[id];
    if (!g) return false;
    g.ended = true;
    saveJSON("giveaways.json", giveaways);
    const ch = await client.channels.fetch(g.channelId).catch(() => null);
    if (!ch) return false;
    const pool = [...g.entries];
    const winners = [];
    while (winners.length < g.winners && pool.length) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    const text = winners.length ? winners.map((w) => `<@${w}>`).join(", ") : "No one entered 😢";
    if (!reroll) {
      const msg = await ch.messages.fetch(id).catch(() => null);
      if (msg) await msg.edit({ embeds: [giveawayEmbed(g, text)], components: [] }).catch(() => {});
    }
    await ch
      .send(
        winners.length
          ? `🎉 ${reroll ? "New winner" + (winners.length > 1 ? "s" : "") + ":" : "Congrats"} ${text}! You won **${g.prize}**!`
          : `🎉 The giveaway for **${g.prize}** ended — ${text}`
      )
      .catch(() => {});
    return true;
  }

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("giveaway")
        .setDescription("Start a giveaway")
        .addStringOption((o) => o.setName("prize").setDescription("What you're giving away").setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName("duration").setDescription("Like 10m, 2h, 1d").setRequired(true))
        .addIntegerOption((o) => o.setName("winners").setDescription("Number of winners (default 1)").setMinValue(1).setMaxValue(20))
        .setDefaultMemberPermissions(P.ManageGuild)
    ),
    async (i) => {
      const ms = parseDuration(i.options.getString("duration"));
      if (!ms) return reply(i, "❌ Use a duration like `30s`, `10m`, `2h`, `1d`, or `1w`.");
      const g = {
        guildId: i.guildId,
        channelId: i.channelId,
        prize: i.options.getString("prize"),
        winners: i.options.getInteger("winners") || 1,
        end: Date.now() + ms,
        host: i.user.id,
        entries: [],
        ended: false,
      };
      await i.reply({ embeds: [giveawayEmbed(g)], components: [giveawayRow()] });
      const msg = await i.fetchReply();
      giveaways[msg.id] = g;
      saveJSON("giveaways.json", giveaways);
    }
  );

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("reroll")
        .setDescription("Pick new winners for an ended giveaway")
        .addStringOption((o) => o.setName("message_id").setDescription("The giveaway message ID").setRequired(true))
        .setDefaultMemberPermissions(P.ManageGuild)
    ),
    async (i) => {
      const id = i.options.getString("message_id").trim();
      const g = giveaways[id];
      if (!g || g.guildId !== i.guildId) return reply(i, "❌ Giveaway not found.");
      if (!g.ended) return reply(i, "❌ That giveaway hasn't ended yet.");
      await reply(i, "🎲 Rerolling...");
      await endGiveaway(id, true);
    }
  );

  // ---------- REMIND ----------
  add(
    new SlashCommandBuilder()
      .setName("remind")
      .setDescription("Get a reminder later")
      .addStringOption((o) => o.setName("time").setDescription("Like 10m, 2h, 1d").setRequired(true))
      .addStringOption((o) => o.setName("message").setDescription("What to remind you about").setRequired(true).setMaxLength(500)),
    async (i) => {
      const ms = parseDuration(i.options.getString("time"));
      if (!ms) return reply(i, "❌ Use a time like `30s`, `10m`, `2h`, `1d`, or `1w`.");
      const at = Date.now() + ms;
      reminders.push({ userId: i.user.id, channelId: i.channelId, text: i.options.getString("message"), at });
      saveJSON("reminders.json", reminders);
      await reply(i, `⏰ Got it! I'll remind you <t:${ts(at)}:R>.`);
    }
  );

  // ---------- AFK ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("afk")
        .setDescription("Set yourself as AFK")
        .addStringOption((o) => o.setName("reason").setDescription("Why you're away").setMaxLength(100))
    ),
    async (i) => {
      const reason = i.options.getString("reason") || "AFK";
      afk[i.guildId] ??= {};
      afk[i.guildId][i.user.id] = { reason, since: Date.now() };
      saveJSON("afk.json", afk);
      await i.reply({ content: `💤 ${i.user} is now AFK: **${reason}**`, allowedMentions: { parse: [] } });
    }
  );

  // ---------- EMBED ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("embed")
        .setDescription("Send a fancy embed message")
        .addStringOption((o) => o.setName("description").setDescription("Main text (use \\n for a new line)").setRequired(true).setMaxLength(4000))
        .addStringOption((o) => o.setName("title").setDescription("Title").setMaxLength(256))
        .addStringOption((o) => o.setName("color").setDescription("Hex color like #ff0000"))
        .addStringOption((o) => o.setName("image").setDescription("Image link"))
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Where to send it (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .setDefaultMemberPermissions(P.ManageMessages)
    ),
    async (i) => {
      let color = COLORS.info;
      const colorStr = i.options.getString("color");
      if (colorStr) {
        const m = /^#?([0-9a-f]{6})$/i.exec(colorStr.trim());
        if (!m) return reply(i, "❌ Color must be a hex code like `#ff0000`.");
        color = parseInt(m[1], 16);
      }
      const e = new EmbedBuilder().setColor(color).setDescription(i.options.getString("description").replace(/\\n/g, "\n"));
      const title = i.options.getString("title");
      const image = i.options.getString("image");
      if (title) e.setTitle(title);
      if (image) {
        if (!/^https?:\/\//i.test(image)) return reply(i, "❌ The image must be a link starting with http.");
        e.setImage(image);
      }
      const ch = i.options.getChannel("channel") || i.channel;
      await ch.send({ embeds: [e] });
      await reply(i, `✅ Sent to ${ch}.`);
    }
  );

  // =====================================================
  // MODERATION UPGRADES
  // =====================================================
  // ---------- AUTO-PUNISH (hooks into your existing /warn) ----------
  const warnCmd = commands.find((c) => c.data.name === "warn");
  if (warnCmd) {
    const originalWarn = warnCmd.run;
    warnCmd.run = async (i) => {
      const target = i.options.getUser("user");
      const before = warnData[i.guildId]?.[target.id]?.length || 0;
      await originalWarn(i);
      const count = warnData[i.guildId]?.[target.id]?.length || 0;
      if (count <= before) return; // warn didn't go through
      const cfg = { enabled: true, timeoutAt: 3, kickAt: 5, ...(settings[i.guildId]?.autopunish || {}) };
      if (!cfg.enabled) return;
      const member = i.options.getMember("user");
      if (!member) return;
      if (count >= cfg.kickAt && member.kickable) {
        await dm(member.user, `You were kicked from **${i.guild.name}** for reaching **${count}** warnings.`);
        await member.kick(`Auto-punish: ${count} warnings`);
        const e = embed(COLORS.bad, "🤖 Auto-punish: kicked", `**User:** ${member.user.tag}\n**Warnings:** ${count}`);
        await i.followUp({ embeds: [e] });
        logAction(i.guild, e);
      } else if (count === cfg.timeoutAt && member.moderatable) {
        await member.timeout(36e5, `Auto-punish: ${count} warnings`);
        await dm(member.user, `You were timed out for 1 hour in **${i.guild.name}** for reaching **${count}** warnings.`);
        const e = embed(COLORS.warn, "🤖 Auto-punish: timed out", `**User:** ${member.user.tag}\n**Warnings:** ${count}\n**Duration:** 1 hour`);
        await i.followUp({ embeds: [e] });
        logAction(i.guild, e);
      }
    };
  }

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("autopunish")
        .setDescription("Set up automatic punishments for warnings")
        .addBooleanOption((o) => o.setName("enabled").setDescription("Turn auto-punish on or off").setRequired(true))
        .addIntegerOption((o) => o.setName("timeout_at").setDescription("Warnings for a 1h timeout (default 3)").setMinValue(1).setMaxValue(50))
        .addIntegerOption((o) => o.setName("kick_at").setDescription("Warnings for a kick (default 5)").setMinValue(1).setMaxValue(50))
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      settings[i.guildId] ??= {};
      const old = settings[i.guildId].autopunish || {};
      const cfg = {
        enabled: i.options.getBoolean("enabled"),
        timeoutAt: i.options.getInteger("timeout_at") ?? old.timeoutAt ?? 3,
        kickAt: i.options.getInteger("kick_at") ?? old.kickAt ?? 5,
      };
      settings[i.guildId].autopunish = cfg;
      saveSettings();
      await i.reply(
        cfg.enabled
          ? `✅ Auto-punish is **on**: 1h timeout at **${cfg.timeoutAt}** warnings, kick at **${cfg.kickAt}** warnings.`
          : "✅ Auto-punish is **off**."
      );
    }
  );

  // ---------- ANTI-SPAM ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("antispam")
        .setDescription("Auto-timeout people who spam (6 messages in 5 seconds)")
        .addBooleanOption((o) => o.setName("enabled").setDescription("Turn anti-spam on or off").setRequired(true))
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      settings[i.guildId] ??= {};
      settings[i.guildId].antispam = i.options.getBoolean("enabled");
      saveSettings();
      await i.reply(settings[i.guildId].antispam ? "✅ Anti-spam is **on**." : "✅ Anti-spam is **off**.");
    }
  );

  // ---------- LOCKDOWN / UNLOCKDOWN ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("lockdown")
        .setDescription("Lock every text channel (for raids)")
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      await i.deferReply();
      const everyone = i.guild.roles.everyone;
      const locked = [];
      for (const ch of i.guild.channels.cache.values()) {
        if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type)) continue;
        if (ch.permissionOverwrites.cache.get(everyone.id)?.deny.has(P.SendMessages)) continue; // already locked
        try {
          await ch.permissionOverwrites.edit(everyone, { SendMessages: false });
          locked.push(ch.id);
        } catch {}
      }
      settings[i.guildId] ??= {};
      settings[i.guildId].lockdown = [...new Set([...(settings[i.guildId].lockdown || []), ...locked])];
      saveSettings();
      const e = embed(COLORS.bad, "🚨 Server lockdown", `Locked **${locked.length}** channels.\nUse \`/unlockdown\` to undo.\n**By:** ${i.user}`);
      await i.editReply({ embeds: [e] });
      logAction(i.guild, e);
    }
  );

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("unlockdown")
        .setDescription("Unlock the channels locked by /lockdown")
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      const ids = settings[i.guildId]?.lockdown || [];
      if (!ids.length) return reply(i, "❌ The server isn't in lockdown.");
      await i.deferReply();
      let count = 0;
      for (const id of ids) {
        const ch = i.guild.channels.cache.get(id);
        if (!ch) continue;
        try {
          await ch.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: null });
          count++;
        } catch {}
      }
      settings[i.guildId].lockdown = [];
      saveSettings();
      const e = embed(COLORS.ok, "✅ Lockdown lifted", `Unlocked **${count}** channels.\n**By:** ${i.user}`);
      await i.editReply({ embeds: [e] });
      logAction(i.guild, e);
    }
  );

  // ---------- SOFTBAN ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("softban")
        .setDescription("Ban then unban someone to delete their recent messages")
        .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Reason"))
        .setDefaultMemberPermissions(P.BanMembers)
    ),
    async (i) => {
      const member = i.options.getMember("user");
      const reason = i.options.getString("reason") || "No reason provided";
      const err = checkTarget(i, member, "softban");
      if (err) return reply(i, err);
      if (!member.bannable) return reply(i, "❌ I can't ban that user (my role is too low).");
      await dm(member.user, `You were kicked from **${i.guild.name}** and your recent messages were deleted.\nReason: ${reason}`);
      await i.guild.members.ban(member.user, { reason: `Softban by ${i.user.tag}: ${reason}`, deleteMessageSeconds: 7 * 86400 });
      await i.guild.members.unban(member.id, "Softban (auto unban)");
      const e = embed(COLORS.warn, "🧹 Member softbanned", `**User:** ${member.user.tag}\n**Moderator:** ${i.user}\n**Reason:** ${reason}`);
      await i.reply({ embeds: [e] });
      logAction(i.guild, e);
    }
  );

  // ---------- /give role all  &  /delrole all ----------
  async function massRole(i, mode) {
    const role = i.options.getRole("role");
    const includeBots = i.options.getBoolean("include_bots") || false;
    if (role.id === i.guild.id) return reply(i, "❌ You can't use @everyone here.");
    if (role.managed || role.position >= i.guild.members.me.roles.highest.position)
      return reply(i, "❌ I can't manage that role (it's above my role or managed by an integration).");
    if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position)
      return reply(i, "❌ That role is equal to or above your highest role.");

    await i.deferReply();
    const members = await i.guild.members.fetch();
    const targets = members.filter(
      (m) => (includeBots || !m.user.bot) && (mode === "add" ? !m.roles.cache.has(role.id) : m.roles.cache.has(role.id))
    );
    if (!targets.size)
      return i.editReply(mode === "add" ? `✅ Everyone already has **${role.name}**.` : `✅ No one has **${role.name}**.`);

    await i.editReply(
      `⏳ ${mode === "add" ? "Giving" : "Removing"} **${role.name}** ${mode === "add" ? "to" : "from"} **${targets.size}** members... this can take a while.`
    );
    let done = 0;
    let failed = 0;
    for (const m of targets.values()) {
      try {
        if (mode === "add") await m.roles.add(role, `Give role all by ${i.user.tag}`);
        else await m.roles.remove(role, `Delrole all by ${i.user.tag}`);
        done++;
      } catch {
        failed++;
      }
    }
    const e = embed(
      COLORS.ok,
      mode === "add" ? "✅ Role given to everyone" : "✅ Role removed from everyone",
      `**Role:** ${role}\n**Members updated:** ${done}${failed ? `\n**Failed:** ${failed}` : ""}\n**By:** ${i.user}`
    );
    await i.editReply({ content: "", embeds: [e] }).catch(() => i.channel.send({ embeds: [e] }).catch(() => {}));
    logAction(i.guild, e);
  }

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("give")
        .setDescription("Give things to members")
        .addSubcommandGroup((g) =>
          g
            .setName("role")
            .setDescription("Give a role")
            .addSubcommand((s) =>
              s
                .setName("all")
                .setDescription("Give a role to every member")
                .addRoleOption((o) => o.setName("role").setDescription("Role to give").setRequired(true))
                .addBooleanOption((o) => o.setName("include_bots").setDescription("Also give it to bots (default: no)"))
            )
        )
        .setDefaultMemberPermissions(P.ManageRoles)
    ),
    (i) => massRole(i, "add")
  );

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("delrole")
        .setDescription("Remove roles from members")
        .addSubcommand((s) =>
          s
            .setName("all")
            .setDescription("Remove a role from every member")
            .addRoleOption((o) => o.setName("role").setDescription("Role to remove").setRequired(true))
            .addBooleanOption((o) => o.setName("include_bots").setDescription("Also remove it from bots (default: no)"))
        )
        .setDefaultMemberPermissions(P.ManageRoles)
    ),
    (i) => massRole(i, "remove")
  );

  // =====================================================
  // TICKETS
  // =====================================================
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("ticketsetup")
        .setDescription("Post the ticket panel with an Open Ticket button")
        .addRoleOption((o) => o.setName("staff_role").setDescription("Role that can see tickets").setRequired(true))
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Where to post the panel (default: here)").addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption((o) =>
          o.setName("category").setDescription("Category to create tickets in").addChannelTypes(ChannelType.GuildCategory)
        )
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      const staff = i.options.getRole("staff_role");
      const ch = i.options.getChannel("channel") || i.channel;
      const cat = i.options.getChannel("category");
      settings[i.guildId] ??= {};
      settings[i.guildId].tickets = { staffRole: staff.id, category: cat?.id || null };
      saveSettings();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket:open").setLabel("Open Ticket").setEmoji("🎫").setStyle(ButtonStyle.Primary)
      );
      await ch.send({
        embeds: [embed(COLORS.info, "🎫 Need help?", "Click the button below to open a private ticket with the staff team.")],
        components: [row],
      });
      await reply(i, `✅ Ticket panel posted in ${ch}.`);
    }
  );

  // =====================================================
  // ECONOMY
  // =====================================================
  const wallet = (g, u) => {
    economy[g] ??= {};
    return (economy[g][u] ??= { coins: 0, lastDaily: 0, lastWork: 0 });
  };
  const saveEco = () => saveJSON("economy.json", economy);
  let ecoDirty = false; // message/voice coins are saved in batches by the timer

  // Discord shows 0x000000 as "no color", so this is the darkest black that still shows.
  const BLACK = 0x010101;
  const isLink = (s) => /^https?:\/\/\S+$/i.test(s);
  const ecoCfg = (g) => ({ msgCoins: 0, msgCooldown: 0, voiceCoins: 0, voiceEvery: 6e4, lbImage: null, ...(settings[g]?.economy || {}) });
  const setEcoCfg = (g, patch) => {
    settings[g] ??= {};
    settings[g].economy = { ...ecoCfg(g), ...patch };
    saveSettings();
  };
  // ---- Uploaded images (store banner, coin leaderboard background) ----
  // Uploaded files are saved in the bot's folder and attached to the message by the bot itself,
  // so they never expire like copied Discord links do. Saved as "file:<name>" in settings;
  // a plain http link still works too.
  const IMG_DIR = path.join(__dirname, "bot-images");
  fs.mkdirSync(IMG_DIR, { recursive: true });
  async function saveUpload(att, baseName) {
    if (!att.contentType?.startsWith("image/")) throw new Error("❌ That file isn't an image or GIF.");
    if (att.size > 10 * 1024 * 1024) throw new Error("❌ That file is too big — keep it under 10 MB.");
    const ext = (att.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const res = await fetch(att.url);
    if (!res.ok) throw new Error("❌ Couldn't download that file, try again.");
    const buf = Buffer.from(await res.arrayBuffer());
    for (const f of fs.readdirSync(IMG_DIR)) if (f.startsWith(baseName + ".")) fs.unlinkSync(path.join(IMG_DIR, f));
    const file = `${baseName}.${ext}`;
    fs.writeFileSync(path.join(IMG_DIR, file), buf);
    return `file:${file}`;
  }
  // Turns a saved image ("file:..." or a link) into what an embed + message need.
  function imageRef(ref) {
    if (!ref) return { url: null, files: [] };
    if (ref.startsWith("file:")) {
      const name = ref.slice(5);
      const p = path.join(IMG_DIR, name);
      if (!fs.existsSync(p)) return { url: null, files: [] };
      return { url: `attachment://${name}`, files: [new AttachmentBuilder(p, { name })] };
    }
    return { url: ref, files: [] };
  }

  const fmtDuration = (ms) => {
    for (const [u, v] of [["w", 6048e5], ["d", 864e5], ["h", 36e5], ["m", 6e4], ["s", 1e3]]) if (ms % v === 0) return `${ms / v}${u}`;
    return `${ms / 1000}s`;
  };

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("balance")
        .setDescription("Check your coins")
        .addUserOption((o) => o.setName("user").setDescription("User (default: you)"))
    ),
    async (i) => {
      const u = i.options.getUser("user") || i.user;
      await i.reply({
        embeds: [embed(BLACK, `🪙 ${u.username}'s balance`, `**${wallet(i.guildId, u.id).coins.toLocaleString()}** coins`).setThumbnail(u.displayAvatarURL({ size: 128 }))],
      });
    }
  );

  // ---------- /coinsetup (coins for messages + voice) ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("coinsetup")
        .setDescription("Set how many coins people earn")
        .addSubcommand((s) =>
          s
            .setName("messages")
            .setDescription("Coins for every message")
            .addIntegerOption((o) => o.setName("coins").setDescription("Coins per message (0 = off)").setRequired(true).setMinValue(0).setMaxValue(100000))
            .addIntegerOption((o) =>
              o.setName("cooldown_seconds").setDescription("Seconds before the next message pays again (default 0)").setMinValue(0).setMaxValue(86400)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("voice")
            .setDescription("Coins for time spent in voice")
            .addIntegerOption((o) => o.setName("coins").setDescription("Coins each time (0 = off)").setRequired(true).setMinValue(0).setMaxValue(100000))
            .addStringOption((o) => o.setName("every").setDescription("How often, like 30s, 1m, 1h (default 1m)"))
        )
        .addSubcommand((s) => s.setName("view").setDescription("Show the current coin settings"))
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      const sub = i.options.getSubcommand();
      if (sub === "messages") {
        const coins = i.options.getInteger("coins");
        const cd = i.options.getInteger("cooldown_seconds") ?? ecoCfg(i.guildId).msgCooldown;
        setEcoCfg(i.guildId, { msgCoins: coins, msgCooldown: cd });
        return i.reply(coins ? `✅ Members now get **${coins}** 🪙 per message${cd ? ` (once every **${cd}s**)` : ""}.` : "✅ Message coins are **off**.");
      }
      if (sub === "voice") {
        const coins = i.options.getInteger("coins");
        let every = ecoCfg(i.guildId).voiceEvery;
        const everyStr = i.options.getString("every");
        if (everyStr) {
          every = parseDuration(everyStr);
          if (!every) return reply(i, "❌ Use a time like `30s`, `1m`, `5m`, or `1h`.");
          if (every < 1e4) return reply(i, "❌ The shortest time is `10s`.");
        }
        setEcoCfg(i.guildId, { voiceCoins: coins, voiceEvery: every });
        return i.reply(coins ? `✅ Members now get **${coins}** 🪙 every **${fmtDuration(every)}** in voice.` : "✅ Voice coins are **off**.");
      }
      const c = ecoCfg(i.guildId);
      await i.reply({
        embeds: [
          embed(
            BLACK,
            "🪙 Coin settings",
            `**Messages:** ${c.msgCoins ? `${c.msgCoins} 🪙 per message${c.msgCooldown ? ` (cooldown ${c.msgCooldown}s)` : ""}` : "off"}\n` +
              `**Voice:** ${c.voiceCoins ? `${c.voiceCoins} 🪙 every ${fmtDuration(c.voiceEvery)}` : "off"}\n` +
              `**Daily:** 500 🪙 • **Work:** 50–200 🪙 every hour`
          ),
        ],
        flags: EPHEMERAL,
      });
    }
  );

  // ---------- /coins (admin: add / remove / set) ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("coins")
        .setDescription("Change someone's coins (admin)")
        .addSubcommand((s) =>
          s
            .setName("add")
            .setDescription("Add coins to someone")
            .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
            .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1))
        )
        .addSubcommand((s) =>
          s
            .setName("remove")
            .setDescription("Remove coins from someone")
            .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
            .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1))
        )
        .addSubcommand((s) =>
          s
            .setName("set")
            .setDescription("Set someone's coins to an exact number")
            .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
            .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(0))
        )
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      const sub = i.options.getSubcommand();
      const u = i.options.getUser("user");
      const amount = i.options.getInteger("amount");
      const w = wallet(i.guildId, u.id);
      if (sub === "add") w.coins += amount;
      else if (sub === "remove") w.coins = Math.max(0, w.coins - amount);
      else w.coins = amount;
      saveEco();
      await i.reply(`✅ ${u} now has **${w.coins.toLocaleString()}** 🪙.`);
    }
  );

  add(guildOnly(new SlashCommandBuilder().setName("daily").setDescription("Claim 500 free coins every 24 hours")), async (i) => {
    const w = wallet(i.guildId, i.user.id);
    const next = w.lastDaily + 864e5;
    if (Date.now() < next) return reply(i, `⏳ You already claimed today. Come back <t:${ts(next)}:R>.`);
    w.coins += 500;
    w.lastDaily = Date.now();
    saveEco();
    await i.reply(`🪙 You claimed **500** coins! You now have **${w.coins.toLocaleString()}**.`);
  });

  add(guildOnly(new SlashCommandBuilder().setName("work").setDescription("Work for coins (every hour)")), async (i) => {
    const w = wallet(i.guildId, i.user.id);
    const next = w.lastWork + 36e5;
    if (Date.now() < next) return reply(i, `⏳ You're tired. Work again <t:${ts(next)}:R>.`);
    const jobs = ["delivered pizza 🍕", "fixed a bug 💻", "walked dogs 🐕", "streamed on Twitch 🎮", "mowed lawns 🌱", "made a YouTube video 🎬", "moderated a Discord server 🛡️"];
    const pay = 50 + Math.floor(Math.random() * 151);
    w.coins += pay;
    w.lastWork = Date.now();
    saveEco();
    await i.reply(`💼 You ${jobs[Math.floor(Math.random() * jobs.length)]} and earned **${pay}** coins!`);
  });

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("pay")
        .setDescription("Give coins to someone")
        .addUserOption((o) => o.setName("user").setDescription("Who to pay").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("How many coins").setRequired(true).setMinValue(1))
    ),
    async (i) => {
      const u = i.options.getUser("user");
      const amount = i.options.getInteger("amount");
      if (u.id === i.user.id) return reply(i, "❌ You can't pay yourself.");
      if (u.bot) return reply(i, "❌ Bots don't need coins.");
      const from = wallet(i.guildId, i.user.id);
      if (from.coins < amount) return reply(i, `❌ You only have **${from.coins.toLocaleString()}** coins.`);
      from.coins -= amount;
      wallet(i.guildId, u.id).coins += amount;
      saveEco();
      await i.reply(`💸 ${i.user} paid **${amount.toLocaleString()}** coins to ${u}.`);
    }
  );

  // ---------- COIN LEADERBOARD (embed with your picture) ----------
  function coinTop(guildId) {
    return Object.entries(economy[guildId] || {})
      .filter(([, w]) => w.coins > 0)
      .sort((a, b) => b[1].coins - a[1].coins)
      .slice(0, 10);
  }

  async function coinLeaderboardPayload(guild) {
    const top = coinTop(guild.id);
    if (!top.length) return null;
    const medals = ["🥇", "🥈", "🥉"];
    const text = top.map(([id, w], n) => `${medals[n] || `**${n + 1}.**`} <@${id}> — **${w.coins.toLocaleString()}** 🪙`).join("\n");
    const e = embed(BLACK, `🏆 ${guild.name} Leaderboard`, text).setThumbnail(guild.iconURL({ size: 256 }));
    const bg = imageRef(ecoCfg(guild.id).lbImage);
    if (bg.url) e.setImage(bg.url);
    return { embeds: [e], files: bg.files, allowedMentions: { parse: [] } };
  }

  add(guildOnly(new SlashCommandBuilder().setName("coinleaderboard").setDescription("Top 10 richest members (coins)")), async (i) => {
    if (!coinTop(i.guildId).length) return reply(i, "❌ No one has coins yet. Try `/daily`!");
    await i.deferReply();
    await i.editReply(await coinLeaderboardPayload(i.guild));
  });

  // ---------- /coinleaderboardsetup (background image/gif) ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("coinleaderboardsetup")
        .setDescription("Change the coin leaderboard background image or GIF")
        .addAttachmentOption((o) => o.setName("file").setDescription("Upload an image or GIF from your device (best)"))
        .addStringOption((o) => o.setName("image").setDescription("Or a direct link to an image/GIF (type 'none' to remove)"))
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      const file = i.options.getAttachment("file");
      const img = i.options.getString("image")?.trim();
      if (!file && !img) return reply(i, "❌ Upload a file or give a link (or type `none` to remove it).");
      if (!file && img.toLowerCase() !== "none" && !isLink(img)) return reply(i, "❌ That needs to be a link starting with `http`.");
      await i.deferReply({ flags: EPHEMERAL });
      let ref = null;
      if (file) {
        try {
          ref = await saveUpload(file, `coinlb-${i.guildId}`);
        } catch (err) {
          return i.editReply(err.message);
        }
      } else if (img.toLowerCase() !== "none") ref = img;
      setEcoCfg(i.guildId, { lbImage: ref });
      const preview = await coinLeaderboardPayload(i.guild);
      const msg = ref ? "✅ Leaderboard background updated." : "✅ Leaderboard background removed.";
      await i.editReply(preview ? { ...preview, content: `${msg} Preview:` } : msg);
    }
  );

  // =====================================================
  // ROLE STORE
  // =====================================================
  const storeCfg = (g) => ({ channelId: null, messageId: null, banner: null, title: "🛒 Role Store", description: "Pick a role from the menu below to buy it with your coins!", items: [], ...(settings[g]?.store || {}) });
  const setStoreCfg = (g, patch) => {
    settings[g] ??= {};
    settings[g].store = { ...storeCfg(g), ...patch };
    saveSettings();
  };

  function storeEmbed(guild) {
    const s = storeCfg(guild.id);
    const items = s.items.filter((it) => guild.roles.cache.has(it.roleId));
    const list = items.length
      ? items.map((it, n) => `**${n + 1}.** <@&${it.roleId}> — **${it.price.toLocaleString()}** 🪙`).join("\n")
      : "*No roles for sale yet. An admin can add some with `/store add`.*";
    const e = new EmbedBuilder()
      .setColor(BLACK)
      .setTitle(s.title)
      .setDescription(`${s.description}\n\n${list}`)
      .setFooter({ text: "Check your coins with /balance" });
    const img = imageRef(s.banner);
    if (img.url) e.setImage(img.url);
    if (guild.iconURL()) e.setThumbnail(guild.iconURL({ size: 256 }));
    return e;
  }
  // Full store message: embed + menu + the banner file (re-attached so it never expires).
  function storeMessage(guild) {
    return { embeds: [storeEmbed(guild)], components: storeComponents(guild), files: imageRef(storeCfg(guild.id).banner).files, attachments: [] };
  }

  function storeComponents(guild) {
    const items = storeCfg(guild.id).items.filter((it) => guild.roles.cache.has(it.roleId)).slice(0, 25);
    if (!items.length) return [];
    const menu = new StringSelectMenuBuilder()
      .setCustomId("store:buy")
      .setPlaceholder("🛒 Choose a role to buy")
      .addOptions(
        items.map((it) => ({
          label: guild.roles.cache.get(it.roleId).name.slice(0, 100),
          description: `${it.price.toLocaleString()} coins`,
          value: it.roleId,
          emoji: "🪙",
        }))
      );
    return [new ActionRowBuilder().addComponents(menu)];
  }

  async function refreshStore(guild) {
    const s = storeCfg(guild.id);
    if (!s.channelId || !s.messageId) return;
    const ch = guild.channels.cache.get(s.channelId);
    const msg = await ch?.messages.fetch(s.messageId).catch(() => null);
    if (msg) await msg.edit(storeMessage(guild)).catch((err) => console.error("Store refresh failed:", err.message));
  }

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("store")
        .setDescription("Set up the role store")
        .addSubcommand((s) =>
          s
            .setName("setup")
            .setDescription("Post the store panel")
            .addAttachmentOption((o) => o.setName("banner_file").setDescription("Upload the banner GIF/image from your device (best)"))
            .addStringOption((o) => o.setName("banner").setDescription("Or a direct link to the banner GIF/image"))
            .addChannelOption((o) =>
              o.setName("channel").setDescription("Where to post the store (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            )
            .addStringOption((o) => o.setName("title").setDescription("Store title").setMaxLength(256))
            .addStringOption((o) => o.setName("description").setDescription("Store text (use \\n for a new line)").setMaxLength(1500))
        )
        .addSubcommand((s) =>
          s
            .setName("add")
            .setDescription("Add a role to the store (or change its price)")
            .addRoleOption((o) => o.setName("role").setDescription("Role to sell").setRequired(true))
            .addIntegerOption((o) => o.setName("price").setDescription("Price in coins").setRequired(true).setMinValue(1))
        )
        .addSubcommand((s) =>
          s
            .setName("remove")
            .setDescription("Remove a role from the store")
            .addRoleOption((o) => o.setName("role").setDescription("Role to remove").setRequired(true))
        )
        .addSubcommand((s) =>
          s
            .setName("banner")
            .setDescription("Change the store banner GIF/image")
            .addAttachmentOption((o) => o.setName("file").setDescription("Upload the GIF/image from your device (best)"))
            .addStringOption((o) => o.setName("link").setDescription("Or a direct link to the GIF/image (type 'none' to remove)"))
        )
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      const sub = i.options.getSubcommand();

      if (sub === "setup") {
        const banner = i.options.getString("banner")?.trim();
        const bannerFile = i.options.getAttachment("banner_file");
        if (banner && !bannerFile && !isLink(banner)) return reply(i, "❌ The banner needs to be a link starting with `http`.");
        await i.deferReply({ flags: EPHEMERAL });
        const patch = {};
        if (bannerFile) {
          try {
            patch.banner = await saveUpload(bannerFile, `store-${i.guildId}`);
          } catch (err) {
            return i.editReply(err.message);
          }
        } else if (banner) patch.banner = banner;
        if (i.options.getString("title")) patch.title = i.options.getString("title");
        if (i.options.getString("description")) patch.description = i.options.getString("description").replace(/\\n/g, "\n");
        setStoreCfg(i.guildId, patch);

        // remove the old panel if there was one
        const old = storeCfg(i.guildId);
        if (old.channelId && old.messageId) {
          const oldMsg = await i.guild.channels.cache.get(old.channelId)?.messages.fetch(old.messageId).catch(() => null);
          if (oldMsg) await oldMsg.delete().catch(() => {});
        }

        const ch = i.options.getChannel("channel") || i.channel;
        const msg = await ch.send(storeMessage(i.guild));
        setStoreCfg(i.guildId, { channelId: ch.id, messageId: msg.id });
        return i.editReply(`✅ Store posted in ${ch}. Add roles with \`/store add\` — the panel updates by itself.`);
      }

      if (sub === "add") {
        const role = i.options.getRole("role");
        const price = i.options.getInteger("price");
        if (role.id === i.guild.id) return reply(i, "❌ You can't sell @everyone.");
        if (role.managed || role.position >= i.guild.members.me.roles.highest.position)
          return reply(i, "❌ I can't give that role (it's above my role or managed by an integration). Move my role above it first.");
        const items = storeCfg(i.guildId).items.filter((it) => it.roleId !== role.id);
        if (items.length >= 25) return reply(i, "❌ The store can hold up to 25 roles.");
        items.push({ roleId: role.id, price });
        items.sort((a, b) => a.price - b.price);
        setStoreCfg(i.guildId, { items });
        await refreshStore(i.guild);
        return i.reply({ content: `✅ **${role.name}** is in the store for **${price.toLocaleString()}** 🪙.`, allowedMentions: { parse: [] } });
      }

      if (sub === "remove") {
        const role = i.options.getRole("role");
        const s = storeCfg(i.guildId);
        if (!s.items.some((it) => it.roleId === role.id)) return reply(i, "❌ That role isn't in the store.");
        setStoreCfg(i.guildId, { items: s.items.filter((it) => it.roleId !== role.id) });
        await refreshStore(i.guild);
        return i.reply({ content: `✅ **${role.name}** was removed from the store.`, allowedMentions: { parse: [] } });
      }

      // banner
      const file = i.options.getAttachment("file");
      const link = i.options.getString("link")?.trim();
      if (!file && !link) return reply(i, "❌ Upload a file or give a link (or type `none` to remove the banner).");
      if (!file && link.toLowerCase() !== "none" && !isLink(link)) return reply(i, "❌ The banner needs to be a link starting with `http`.");
      await i.deferReply({ flags: EPHEMERAL });
      if (file) {
        try {
          setStoreCfg(i.guildId, { banner: await saveUpload(file, `store-${i.guildId}`) });
        } catch (err) {
          return i.editReply(err.message);
        }
      } else setStoreCfg(i.guildId, { banner: link.toLowerCase() === "none" ? null : link });
      await refreshStore(i.guild);
      const { components, ...preview } = storeMessage(i.guild);
      await i.editReply({ ...preview, content: "✅ Banner updated. Preview:" });
    }
  );

  // buying from the store menu
  client.on("interactionCreate", async (i) => {
    if (!i.isStringSelectMenu() || i.customId !== "store:buy") return;
    try {
      // reset the menu so the same role can be picked again later
      await i.update({ components: storeComponents(i.guild) });
      const roleId = i.values[0];
      const item = storeCfg(i.guildId).items.find((it) => it.roleId === roleId);
      const role = i.guild.roles.cache.get(roleId);
      const say = (content) => i.followUp({ content, flags: EPHEMERAL });
      if (!item || !role) return say("❌ That role isn't for sale anymore.");
      if (i.member.roles.cache.has(roleId)) return say(`✅ You already own **${role.name}**.`);
      const w = wallet(i.guildId, i.user.id);
      if (w.coins < item.price)
        return say(`❌ **${role.name}** costs **${item.price.toLocaleString()}** 🪙 but you only have **${w.coins.toLocaleString()}** 🪙.`);
      w.coins -= item.price;
      saveEco();
      try {
        await i.member.roles.add(role, "Bought from the store");
      } catch {
        w.coins += item.price; // refund
        saveEco();
        return say("❌ I couldn't give you that role (my role might be too low). You weren't charged.");
      }
      await say(`🎉 You bought **${role.name}** for **${item.price.toLocaleString()}** 🪙! You have **${w.coins.toLocaleString()}** 🪙 left.`);
      logAction(i.guild, embed(BLACK, "🛒 Store purchase", `**User:** ${i.user.tag}\n**Role:** ${role}\n**Price:** ${item.price.toLocaleString()} 🪙`));
    } catch (err) {
      console.error("Store error:", err);
      i.followUp({ content: "❌ Something went wrong.", flags: EPHEMERAL }).catch(() => {});
    }
  });

  // =====================================================
  // SERVER STATS (locked voice channels that show counts)
  // =====================================================
  const STAT_TYPES = {
    members: { label: "👥 Members", count: (g) => g.members.cache.filter((m) => !m.user.bot).size },
    bots: { label: "🤖 Bots", count: (g) => g.members.cache.filter((m) => m.user.bot).size },
    voice: { label: "🔊 In Voice", count: (g) => g.voiceStates.cache.filter((v) => v.channelId).size },
    channels: { label: "💬 Channels", count: (g) => g.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).size },
  };
  const statName = (type, guild) => `${STAT_TYPES[type].label}: ${STAT_TYPES[type].count(guild).toLocaleString()}`;

  async function updateStats(guild) {
    const st = settings[guild.id]?.stats;
    if (!st) return;
    for (const [type, id] of Object.entries(st.channels)) {
      const ch = guild.channels.cache.get(id);
      if (!ch || !STAT_TYPES[type]) continue;
      const name = statName(type, guild);
      if (ch.name !== name) await ch.setName(name).catch(() => {});
    }
  }

  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("serverstats")
        .setDescription("Locked channels that show member, bot, voice and channel counts")
        .addSubcommand((s) => s.setName("setup").setDescription("Create the server stats channels"))
        .addSubcommand((s) => s.setName("remove").setDescription("Delete the server stats channels"))
        .setDefaultMemberPermissions(P.Administrator)
    ),
    async (i) => {
      const sub = i.options.getSubcommand();
      const old = settings[i.guildId]?.stats;

      if (sub === "remove") {
        if (!old) return reply(i, "❌ Server stats aren't set up.");
        await i.deferReply({ flags: EPHEMERAL });
        for (const id of [...Object.values(old.channels), old.categoryId]) await i.guild.channels.cache.get(id)?.delete().catch(() => {});
        delete settings[i.guildId].stats;
        saveSettings();
        return i.editReply("✅ Server stats channels deleted.");
      }

      if (old && i.guild.channels.cache.has(old.categoryId)) return reply(i, "❌ Server stats are already set up. Use `/serverstats remove` first.");
      await i.deferReply({ flags: EPHEMERAL });
      await i.guild.members.fetch().catch(() => {});
      const everyone = i.guild.roles.everyone.id;
      const locked = [
        { id: everyone, allow: [P.ViewChannel], deny: [P.Connect] },
        { id: client.user.id, allow: [P.ViewChannel, P.Connect, P.ManageChannels] },
      ];
      const category = await i.guild.channels.create({
        name: "📊 Server Stats",
        type: ChannelType.GuildCategory,
        position: 0,
        permissionOverwrites: locked,
      });
      const channels = {};
      for (const type of Object.keys(STAT_TYPES)) {
        const ch = await i.guild.channels.create({
          name: statName(type, i.guild),
          type: ChannelType.GuildVoice,
          parent: category.id,
          permissionOverwrites: locked,
        });
        channels[type] = ch.id;
      }
      settings[i.guildId] ??= {};
      settings[i.guildId].stats = { categoryId: category.id, channels };
      saveSettings();
      statsUpdated.set(i.guildId, Date.now());
      await i.editReply("✅ Server stats created at the top of your channel list. They update every 10 minutes.");
    }
  );

  // =====================================================
  // OWNER ONLY (/servers, /leaveserver)
  // =====================================================
  // Who can use /servers and /leaveserver:
  //  • If BOT_OWNER_IDS is set in your .env (user IDs, comma separated), ONLY those people.
  //  • If it's not set: the bot's personal owner, or — for a team-owned bot — only the team's
  //    owner. Other team members (admins/developers) are NOT allowed.
  const BOT_OWNER_IDS = (process.env.BOT_OWNER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  async function isBotOwner(userId) {
    if (BOT_OWNER_IDS.length) return BOT_OWNER_IDS.includes(userId);
    const app = await client.application.fetch().catch(() => null);
    const owner = app?.owner;
    if (!owner) return false;
    if (owner.members) return owner.ownerId === userId; // team-owned app: only the team owner
    return owner.id === userId;
  }

  add(
    new SlashCommandBuilder()
      .setName("servers")
      .setDescription("List every server the bot is in (bot owner only)")
      .setDefaultMemberPermissions(P.Administrator),
    async (i) => {
      if (!(await isBotOwner(i.user.id))) return reply(i, "❌ Only the bot owner can use this.");
      const guilds = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
      const lines = guilds.map((g, n) => `**${n + 1}.** ${g.name} — \`${g.id}\` — ${g.memberCount.toLocaleString()} members`);
      const embeds = [];
      let chunk = "";
      for (const line of lines) {
        if ((chunk + line).length > 3900) {
          embeds.push(chunk);
          chunk = "";
        }
        chunk += line + "\n";
      }
      if (chunk) embeds.push(chunk);
      await i.reply({
        embeds: embeds.slice(0, 10).map((text, n) =>
          new EmbedBuilder()
            .setColor(BLACK)
            .setTitle(n === 0 ? `📋 Servers (${guilds.length})` : null)
            .setDescription(text)
        ),
        flags: EPHEMERAL,
      });
    }
  );

  add(
    new SlashCommandBuilder()
      .setName("leaveserver")
      .setDescription("Make the bot leave a server (bot owner only)")
      .addStringOption((o) => o.setName("server_id").setDescription("Server ID from /servers").setRequired(true))
      .setDefaultMemberPermissions(P.Administrator),
    async (i) => {
      if (!(await isBotOwner(i.user.id))) return reply(i, "❌ Only the bot owner can use this.");
      const guild = client.guilds.cache.get(i.options.getString("server_id").trim());
      if (!guild) return reply(i, "❌ I'm not in a server with that ID. Check `/servers`.");
      const name = guild.name;
      await reply(i, `👋 Leaving **${name}**...`);
      try {
        await guild.leave();
        await i.followUp({ content: `✅ I left **${name}**.`, flags: EPHEMERAL }).catch(() => {});
      } catch {
        await i.followUp({ content: `❌ I couldn't leave **${name}**.`, flags: EPHEMERAL }).catch(() => {});
      }
    }
  );

  // =====================================================
  // HELP (replaces the old /help and lists everything)
  // =====================================================
  const oldHelp = commands.findIndex((c) => c.data.name === "help");
  if (oldHelp !== -1) commands.splice(oldHelp, 1);

  const CATEGORIES = {
    "🛡️ Moderation": ["kick", "ban", "softban", "unban", "timeout", "untimeout", "warn", "warnings", "unwarn", "clearwarnings", "purge", "slowmode", "lock", "unlock", "lockdown", "unlockdown", "nick", "addrole", "removerole", "give", "delrole"],
    "⚙️ Setup": ["setlogs", "autopunish", "antispam", "ticketsetup", "serverstats", "coinsetup", "store", "coinleaderboardsetup", "coins", "embed", "say"],
    "🎉 Server": ["poll", "giveaway", "reroll", "remind", "afk"],
    "💰 Economy": ["balance", "daily", "work", "pay", "coinleaderboard"],
    "🎮 Fun": ["8ball", "coinflip", "roll", "ship", "rate", "meme", "rps", "snipe"],
    "ℹ️ Info": ["ping", "avatar", "userinfo", "serverinfo", "help"],
    "🔊 Voice": ["join", "leave"],
    "👑 Owner": ["servers", "leaveserver"],
  };
  const display = {
    give: "give role all",
    delrole: "delrole all",
    store: "store setup/add/remove/banner",
    coinsetup: "coinsetup messages/voice/view",
    coins: "coins add/remove/set",
    serverstats: "serverstats setup/remove",
  };

  // Paste a GIF link here to show a banner at the top of /help (optional):
  const HELP_GIF_URL = "";
  const BRAND = "by DEV si0kai • use /help for help with commands";

  function helpPages() {
    const names = new Set(commands.map((c) => c.data.name));
    const descOf = (n) => commands.find((c) => c.data.name === n)?.data.description || "";
    const pages = [];
    const used = new Set();
    for (const [cat, list] of Object.entries(CATEGORIES)) {
      const have = list.filter((n) => names.has(n));
      have.forEach((n) => used.add(n));
      if (have.length) pages.push({ title: cat, lines: have.map((n) => `\`/${display[n] || n}\` — ${descOf(n)}`) });
    }
    const other = [...names].filter((n) => !used.has(n));
    if (other.length) pages.push({ title: "\U0001F4E6 Other", lines: other.map((n) => `\`/${n}\` — ${descOf(n)}`) });
    return pages;
  }

  function buildHelp(page, userId) {
    const pages = helpPages();
    page = ((page % pages.length) + pages.length) % pages.length;
    const pg = pages[page];
    const e = new EmbedBuilder()
      .setColor(COLORS.info)
      .setAuthor({ name: `${client.user.username} • Commands`, iconURL: client.user.displayAvatarURL() })
      .setTitle(pg.title)
      .setDescription(pg.lines.join("\n"))
      .setFooter({ text: `${BRAND}  •  Page ${page + 1}/${pages.length}` });
    if (HELP_GIF_URL) e.setImage(HELP_GIF_URL);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`help:prev:${userId}:${page}`).setEmoji("◀️").setLabel("Prev").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`help:home:${userId}:${page}`).setLabel(`${page + 1}/${pages.length}`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`help:next:${userId}:${page}`).setEmoji("▶️").setLabel("Next").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [e], components: [row] };
  }

  add(new SlashCommandBuilder().setName("help").setDescription("List all commands"), async (i) => {
    await i.reply({ ...buildHelp(0, i.user.id), flags: EPHEMERAL });
  });

  // ---------- FONTS (fancy unicode text) ----------
  const fontHoles = {
    italic: { h: "ℎ" },
    script: { B:"ℬ",E:"ℰ",F:"ℱ",H:"ℋ",I:"ℐ",L:"ℒ",M:"ℳ",R:"ℛ",e:"ℯ",g:"ℊ",o:"ℴ" },
    double: { C:"ℂ",H:"ℍ",N:"ℕ",P:"ℙ",Q:"ℚ",R:"ℝ",Z:"ℤ" },
  };
  const fontBases = {
    bold:       { U:0x1D400, L:0x1D41A, D:0x1D7CE },
    italic:     { U:0x1D434, L:0x1D44E, D:null, holes:"italic" },
    bolditalic: { U:0x1D468, L:0x1D482, D:null },
    script:     { U:0x1D49C, L:0x1D4B6, D:null, holes:"script" },
    double:     { U:0x1D538, L:0x1D552, D:0x1D7D8, holes:"double" },
    mono:       { U:0x1D670, L:0x1D68A, D:0x1D7F6 },
    sansbold:   { U:0x1D5D4, L:0x1D5EE, D:0x1D7EC },
    fullwidth:  { U:0xFF21,  L:0xFF41,  D:0xFF10 },
  };
  const smallcaps = {a:"ᴀ",b:"ʙ",c:"ᴄ",d:"ᴅ",e:"ᴇ",f:"ꜰ",g:"ɢ",h:"ʜ",i:"ɪ",j:"ᴊ",k:"ᴋ",l:"ʟ",m:"ᴍ",n:"ɴ",o:"ᴏ",p:"ᴘ",q:"q",r:"ʀ",s:"s",t:"ᴛ",u:"ᴜ",v:"ᴠ",w:"ᴡ",x:"x",y:"ʏ",z:"ᴢ"};
  function fontConvert(text, style) {
    if (style === "circled") return [...text].map((ch) => {
      const c = ch.charCodeAt(0);
      if (ch >= "A" && ch <= "Z") return String.fromCodePoint(0x24B6 + c - 65);
      if (ch >= "a" && ch <= "z") return String.fromCodePoint(0x24D0 + c - 97);
      if (ch >= "1" && ch <= "9") return String.fromCodePoint(0x2460 + c - 49);
      if (ch === "0") return "⓪";
      return ch;
    }).join("");
    if (style === "smallcaps") return [...text].map((ch) => (ch >= "a" && ch <= "z" ? smallcaps[ch] : ch)).join("");
    const b = fontBases[style];
    if (!b) return text;
    const holes = b.holes ? fontHoles[b.holes] : null;
    return [...text].map((ch) => {
      if (holes && holes[ch]) return holes[ch];
      const c = ch.charCodeAt(0);
      if (ch >= "A" && ch <= "Z") return String.fromCodePoint(b.U + c - 65);
      if (ch >= "a" && ch <= "z") return String.fromCodePoint(b.L + c - 97);
      if (ch >= "0" && ch <= "9" && b.D != null) return String.fromCodePoint(b.D + c - 48);
      return ch;
    }).join("");
  }
  const FONT_STYLES = ["bold","italic","bolditalic","script","double","mono","sansbold","fullwidth","smallcaps","circled"];
  add(
    new SlashCommandBuilder()
      .setName("font")
      .setDescription("Turn text into fancy fonts")
      .addStringOption((o) => o.setName("text").setDescription("Text to convert").setRequired(true).setMaxLength(200))
      .addStringOption((o) => {
        o.setName("style").setDescription("Pick one (leave empty to see all styles)");
        FONT_STYLES.forEach((st) => o.addChoices({ name: st, value: st }));
        return o;
      }),
    async (i) => {
      const text = i.options.getString("text");
      const style = i.options.getString("style");
      if (style) return i.reply({ content: fontConvert(text, style), allowedMentions: { parse: [] } });
      const lines = FONT_STYLES.map((st) => `**${st}:** ${fontConvert(text, st)}`).join("\n");
      await i.reply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle("\U0001F524 Fonts").setDescription(lines).setFooter({ text: BRAND })] });
    }
  );

  // ---------- STICKER (send one of THIS server's stickers) ----------
  add(
    guildOnly(
      new SlashCommandBuilder()
        .setName("sticker")
        .setDescription("Send one of this server's stickers")
        .addStringOption((o) => o.setName("name").setDescription("Sticker name (leave empty to list them)"))
    ),
    async (i) => {
      const stickers = await i.guild.stickers.fetch().catch(() => null);
      if (!stickers || !stickers.size) return reply(i, "❌ This server has no stickers. Add some in Server Settings → Stickers.");
      const name = i.options.getString("name");
      if (!name) {
        const list = [...stickers.values()].map((s) => `\`${s.name}\``).join(", ").slice(0, 1900);
        return i.reply({ embeds: [embed(COLORS.info, `Server stickers (${stickers.size})`, list)], flags: EPHEMERAL });
      }
      const st = stickers.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!st) return reply(i, "❌ No sticker with that name. Use `/sticker` with no name to see the list.");
      await i.channel.send({ stickers: [st.id] }).catch(() => {});
      await reply(i, "✅ Sent.");
    }
  );

  // =====================================================
  // BUTTONS
  // =====================================================
  client.on("interactionCreate", async (i) => {
    if (!i.isButton()) return;
    const [kind, a, b] = i.customId.split(":");
    try {
      // ----- help pagination -----
      if (kind === "help") {
        const parts = i.customId.split(":"); // help:action:userId:page
        const action = parts[1], owner = parts[2], page = Number(parts[3]) || 0;
        if (i.user.id !== owner) return reply(i, "❌ Run your own `/help`.");
        const next = action === "next" ? page + 1 : action === "prev" ? page - 1 : page;
        return i.update(buildHelp(next, owner));
      }

      // ----- rock paper scissors -----
      if (kind === "rps") {
        if (i.user.id !== b) return reply(i, "❌ Start your own game with `/rps`.");
        const opts = ["rock", "paper", "scissors"];
        const emo = { rock: "🪨", paper: "📄", scissors: "✂️" };
        const bot = opts[Math.floor(Math.random() * 3)];
        const win = (a === "rock" && bot === "scissors") || (a === "paper" && bot === "rock") || (a === "scissors" && bot === "paper");
        const result = a === bot ? "🤝 It's a tie!" : win ? "🎉 You win!" : "😈 I win!";
        return i.update({ content: `You: ${emo[a]}  vs  Me: ${emo[bot]}\n**${result}**`, components: [] });
      }

      // ----- poll votes -----
      if (kind === "poll") {
        const p = polls[i.message.id];
        if (!p) return reply(i, "❌ This poll isn't active anymore.");
        const n = Number(a);
        if (p.votes[i.user.id] === n) delete p.votes[i.user.id];
        else p.votes[i.user.id] = n;
        saveJSON("polls.json", polls);
        return i.update({ embeds: [pollEmbed(p)] });
      }

      // ----- giveaway entry -----
      if (kind === "gw") {
        const g = giveaways[i.message.id];
        if (!g || g.ended) return reply(i, "❌ This giveaway has ended.");
        const idx = g.entries.indexOf(i.user.id);
        if (idx === -1) g.entries.push(i.user.id);
        else g.entries.splice(idx, 1);
        saveJSON("giveaways.json", giveaways);
        await i.update({ embeds: [giveawayEmbed(g)] });
        return i.followUp({ content: idx === -1 ? "✅ You entered the giveaway! Good luck 🍀" : "👋 You left the giveaway.", flags: EPHEMERAL });
      }

      // ----- tickets -----
      if (kind === "ticket" && a === "open") {
        const cfg = settings[i.guildId]?.tickets;
        if (!cfg) return reply(i, "❌ Tickets aren't set up. An admin needs to run `/ticketsetup`.");
        const existing = i.guild.channels.cache.find((c) => c.topic === `ticket:${i.user.id}`);
        if (existing) return reply(i, `❌ You already have a ticket open: ${existing}`);
        await i.deferReply({ flags: EPHEMERAL });
        const staffPerms = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles];
        const ch = await i.guild.channels.create({
          name: `ticket-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 90),
          type: ChannelType.GuildText,
          parent: cfg.category || null,
          topic: `ticket:${i.user.id}`,
          permissionOverwrites: [
            { id: i.guild.roles.everyone.id, deny: [P.ViewChannel] },
            { id: i.user.id, allow: staffPerms },
            { id: cfg.staffRole, allow: staffPerms },
            { id: client.user.id, allow: [...staffPerms, P.ManageChannels] },
          ],
        });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket:close").setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger)
        );
        await ch.send({
          content: `${i.user} <@&${cfg.staffRole}>`,
          embeds: [embed(COLORS.info, "🎫 Ticket opened", "Tell us what you need help with. Staff will be with you soon.")],
          components: [row],
        });
        logAction(i.guild, embed(COLORS.info, "🎫 Ticket opened", `**User:** ${i.user.tag}\n**Channel:** ${ch}`));
        return i.editReply(`✅ Your ticket is ready: ${ch}`);
      }

      if (kind === "ticket" && a === "close") {
        const ownerId = i.channel.topic?.split(":")[1];
        const staffRole = settings[i.guildId]?.tickets?.staffRole;
        const allowed =
          i.user.id === ownerId || (staffRole && i.member.roles.cache.has(staffRole)) || i.memberPermissions.has(P.ManageChannels);
        if (!allowed) return reply(i, "❌ Only the ticket owner or staff can close this.");
        await i.reply("🔒 Closing this ticket in 5 seconds...");
        logAction(i.guild, embed(COLORS.bad, "🔒 Ticket closed", `**Channel:** #${i.channel.name}\n**Closed by:** ${i.user.tag}`));
        setTimeout(() => i.channel.delete().catch(() => {}), 5000);
      }
    } catch (err) {
      console.error(`Button error (${i.customId}):`, err);
      const msg = { content: "❌ Something went wrong.", flags: EPHEMERAL };
      if (i.replied || i.deferred) i.followUp(msg).catch(() => {});
      else i.reply(msg).catch(() => {});
    }
  });

  // =====================================================
  // MESSAGE EVENTS (AFK, anti-spam, snipe)
  // =====================================================
  client.on("messageCreate", async (msg) => {
    if (!msg.guild || msg.author.bot) return;

    // ----- AFK -----
    const gAfk = afk[msg.guild.id];
    if (gAfk?.[msg.author.id]) {
      delete gAfk[msg.author.id];
      saveJSON("afk.json", afk);
      msg
        .reply({ content: "👋 Welcome back! I removed your AFK.", allowedMentions: { repliedUser: false } })
        .then((m) => setTimeout(() => m.delete().catch(() => {}), 5000))
        .catch(() => {});
    }
    if (gAfk) {
      for (const u of msg.mentions.users.values()) {
        const info = gAfk[u.id];
        if (info)
          msg
            .reply({ content: `💤 **${u.username}** is AFK: ${info.reason} (<t:${ts(info.since)}:R>)`, allowedMentions: { repliedUser: false } })
            .catch(() => {});
      }
    }

    // ----- COINS FOR MESSAGES -----
    const eco = ecoCfg(msg.guild.id);
    if (eco.msgCoins > 0) {
      const key = `${msg.guild.id}:${msg.author.id}`;
      const last = msgCoinCooldown.get(key) || 0;
      if (Date.now() - last >= eco.msgCooldown * 1000) {
        msgCoinCooldown.set(key, Date.now());
        wallet(msg.guild.id, msg.author.id).coins += eco.msgCoins;
        ecoDirty = true;
      }
    }

    // ----- ANTI-SPAM -----
    if (settings[msg.guild.id]?.antispam && msg.member && !msg.member.permissions.has(P.ManageMessages)) {
      const key = `${msg.guild.id}:${msg.author.id}`;
      const now = Date.now();
      const times = (spamTracker.get(key) || []).filter((t) => now - t < 5000);
      times.push(now);
      spamTracker.set(key, times);
      if (times.length >= 6) {
        spamTracker.delete(key);
        if (msg.member.moderatable) {
          await msg.member.timeout(5 * 60 * 1000, "Anti-spam").catch(() => {});
          msg.channel.send(`🚫 ${msg.author} was timed out for 5 minutes for spamming.`).catch(() => {});
          logAction(msg.guild, embed(COLORS.bad, "🚫 Anti-spam", `**User:** ${msg.author.tag}\nTimed out for 5 minutes.`));
        }
      }
    }
  });

  client.on("messageDelete", (m) => {
    if (m.partial || !m.guild || m.author?.bot) return;
    if (!m.content && !m.attachments.size) return;
    snipes.set(m.channel.id, {
      content: m.content,
      author: m.author.tag,
      avatar: m.author.displayAvatarURL(),
      at: Date.now(),
      image: m.attachments.first()?.url,
    });
  });

  // =====================================================
  // TIMERS (reminders + giveaways), checked every 10 seconds
  // =====================================================
  async function tick() {
    const now = Date.now();

    const due = reminders.filter((r) => r.at <= now);
    if (due.length) {
      reminders = reminders.filter((r) => r.at > now);
      saveJSON("reminders.json", reminders);
      for (const r of due) {
        const ch = await client.channels.fetch(r.channelId).catch(() => null);
        const sent = ch
          ? await ch.send({ content: `⏰ <@${r.userId}> reminder: **${r.text}**`, allowedMentions: { users: [r.userId] } }).catch(() => null)
          : null;
        if (!sent) {
          const u = await client.users.fetch(r.userId).catch(() => null);
          if (u) await dm(u, `⏰ Reminder: **${r.text}**`);
        }
      }
    }

    for (const [id, g] of Object.entries(giveaways)) {
      if (!g.ended && g.end <= now) await endGiveaway(id).catch(console.error);
      else if (g.ended && now - g.end > 7 * 864e5) {
        delete giveaways[id];
        saveJSON("giveaways.json", giveaways);
      }
    }

    // ----- coins for voice time -----
    const seen = new Set();
    for (const guild of client.guilds.cache.values()) {
      const eco = ecoCfg(guild.id);
      if (eco.voiceCoins <= 0) continue;
      for (const vs of guild.voiceStates.cache.values()) {
        if (!vs.channelId || vs.channelId === guild.afkChannelId || vs.member?.user.bot) continue;
        const key = `${guild.id}:${vs.id}`;
        seen.add(key);
        const t = voiceTime.get(key) || { acc: 0, last: now };
        t.acc += now - t.last;
        t.last = now;
        if (t.acc >= eco.voiceEvery) {
          const times = Math.floor(t.acc / eco.voiceEvery);
          t.acc -= times * eco.voiceEvery;
          wallet(guild.id, vs.id).coins += times * eco.voiceCoins;
          ecoDirty = true;
        }
        voiceTime.set(key, t);
      }
    }
    for (const key of voiceTime.keys()) if (!seen.has(key)) voiceTime.delete(key); // left voice

    if (ecoDirty) {
      ecoDirty = false;
      saveEco();
    }

    // ----- server stats channels (Discord only allows renaming every ~10 min) -----
    for (const guild of client.guilds.cache.values()) {
      if (!settings[guild.id]?.stats) continue;
      if (now - (statsUpdated.get(guild.id) || 0) < 10 * 6e4) continue;
      statsUpdated.set(guild.id, now);
      await updateStats(guild).catch(console.error);
    }
  }

  client.once("ready", async () => {
    // load member lists so the stats counts are right after a restart
    for (const guild of client.guilds.cache.values()) {
      if (settings[guild.id]?.stats) await guild.members.fetch().catch(() => {});
    }
    setInterval(() => tick().catch(console.error), 10_000);
  });
}

setupExtras({ client, commands, add, embed, COLORS, EPHEMERAL, reply, checkTarget, dm, logAction, loadJSON, saveJSON, parseDuration, settings, warnData });

// =====================================================
// APP EMOJIS (icons the bot can use anywhere)
// Upload them in the Developer Portal → your app → Emojis.
// Then use emo("name") in any message, e.g. `${emo("fire", "🔥")} Done!`
// The second part is a backup emoji if that name isn't uploaded.
// =====================================================
const appEmojis = new Map();
async function loadAppEmojis() {
  try {
    const list = await client.application.emojis.fetch();
    appEmojis.clear();
    for (const e of list.values()) appEmojis.set(e.name, e.toString());
    console.log(`✅ Loaded ${appEmojis.size} app emojis`);
  } catch (err) {
    console.error("Couldn't load app emojis:", err.message);
  }
}
const emo = (name, fallback = "") => appEmojis.get(name) || fallback;

add(new SlashCommandBuilder().setName("emojis").setDescription("Show the bot's custom emojis"), async (i) => {
  await loadAppEmojis();
  if (!appEmojis.size) return reply(i, "❌ No emojis uploaded yet. Add them in the Developer Portal → Emojis.");
  const text = [...appEmojis.entries()].map(([name, e]) => `${e} \`${name}\``).join("\n").slice(0, 4000);
  await i.reply({ embeds: [embed(COLORS.info, `Bot emojis (${appEmojis.size})`, text)] });
});

// =====================================================
// GIFS + "visual" OPTION ON EVERY COMMAND
// Put GIF files in a folder called "gifs" next to this file:
//   gifs/ban.gif          → used for /ban
//   gifs/8ball/a.gif, b.gif → a random one is picked for /8ball
// Every command gets a "visual" option: true (default) shows the GIF, false hides it.
// =====================================================
const GIF_DIR = path.join(__dirname, "gifs");
function pickGif(name) {
  try {
    const dir = path.join(GIF_DIR, name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const list = fs.readdirSync(dir).filter((f) => /\.gif$/i.test(f));
      if (list.length) return path.join(dir, list[Math.floor(Math.random() * list.length)]);
    }
    const file = path.join(GIF_DIR, `${name}.gif`);
    if (fs.existsSync(file)) return file;
  } catch {}
  return null;
}

function addGif(payload, file) {
  payload = typeof payload === "string" ? { content: payload } : { ...payload };
  if (payload.ephemeral || (Number(payload.flags || 0) & Number(EPHEMERAL))) return null; // skip private replies
  const name = "visual.gif";
  if (payload.embeds?.length) {
    const first = EmbedBuilder.from(payload.embeds[0]);
    if (first.data.image) return null; // already has a picture
    first.setImage(`attachment://${name}`);
    payload.embeds = [first, ...payload.embeds.slice(1)];
  }
  payload.files = [...(payload.files || []), new AttachmentBuilder(file, { name })];
  return payload;
}

function addVisualOption(b) {
  const opts = b.options || [];
  const kids = opts.filter((o) => [1, 2].includes(o.toJSON().type)); // subcommands / groups
  if (kids.length) return kids.forEach(addVisualOption);
  if (opts.length >= 25 || opts.some((o) => o.name === "visual")) return;
  b.addBooleanOption((o) => o.setName("visual").setDescription("Show the GIF (default: true)"));
}
for (const c of commands) addVisualOption(c.data);

function applyVisual(interaction) {
  if ((interaction.options.getBoolean("visual") ?? true) === false) return;
  const gif = pickGif(interaction.commandName);
  if (!gif) return;
  let used = false;
  for (const fn of ["reply", "editReply", "followUp"]) {
    const orig = interaction[fn].bind(interaction);
    interaction[fn] = (payload = {}) => {
      if (!used) {
        const p = addGif(payload, gif);
        if (p) {
          used = true;
          return orig(p);
        }
      }
      return orig(payload);
    };
  }
}

// =====================================================
// EVENTS
// =====================================================
const commandMap = new Map(commands.map((c) => [c.data.name, c.run]));


client.once("ready", async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  startRotatingStatus();
  applyNameStyle().catch((e) => console.error("Name style error:", e.message));
  loadAppEmojis();

  // Commands are registered in each server directly, so they show up instantly.
  // The old global copies are cleared so nothing shows up twice.
  try {
    await client.application.commands.set([]);
  } catch (err) {
    console.error("Failed to clear old global commands:", err.message);
  }
  // Registering happens in web.js (startWebServer below), together with the dashboard's own
  // commands, so neither list overwrites the other.

  for (const [guildId, channelId] of Object.entries(voiceData)) {
    if (!connectVoice(guildId, channelId)) delete voiceData[guildId];
  }
  saveJSON("voice-data.json", voiceData);

  // ---- Start the dashboard web API ----
  startWebServer({
    client,
    warnData,
    saveJSON,
    settings,
    voiceData,
    connectVoice,
    getVoiceConnection,
    extraCommands: commands.map((c) => c.data.toJSON()), // web.js registers these together with its own
  });
});

client.on("guildDelete", (guild) => {
  delete voiceData[guild.id];
  saveJSON("voice-data.json", voiceData);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const run = commandMap.get(interaction.commandName);
  if (!run) return;
  applyVisual(interaction);
  try {
    await run(interaction);
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    const msg = { content: "❌ Something went wrong running that command.", flags: EPHEMERAL };
    if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

// =====================================================
// START
// =====================================================
console.log("Starting...");
client.login(config.token).catch((err) => console.error("❌ Login failed:", err));