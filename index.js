require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  Events,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN in .env');

const PENDING_TTL_MS = 15 * 60 * 1000;

/* --------------------------- Per-server config --------------------------- */
// { [guildId]: { staffChannelId, groupId, groupName } }

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'guilds.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let configs = {};
try {
  configs = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {
  configs = {};
}

function saveConfigs() {
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(configs, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

/* ------------------------------ Pending state --------------------------- */
// `${guildId}:${userId}` -> { robloxId, robloxName, displayName, avatar, membership, createdAt }

const pending = new Map();
const pkey = (i) => `${i.guildId}:${i.user.id}`;

function getPending(i) {
  const p = pending.get(pkey(i));
  if (!p) return null;
  if (Date.now() - p.createdAt > PENDING_TTL_MS) {
    pending.delete(pkey(i));
    return null;
  }
  return p;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ------------------------------ Roblox API ------------------------------ */

const robloxFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8000) });

// Returns { id, name, displayName } or null if the username doesn't exist.
async function getRobloxUser(username) {
  const res = await robloxFetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  if (!res.ok) throw new Error(`Roblox users API returned ${res.status}`);
  const { data } = await res.json();
  return data?.[0] ?? null;
}

async function getHeadshot(userId) {
  try {
    const res = await robloxFetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    );
    if (!res.ok) return null;
    const { data } = await res.json();
    return data?.[0]?.imageUrl ?? null;
  } catch {
    return null;
  }
}

// Returns group info, or null if the group doesn't exist. Throws on API failure.
async function getGroup(groupId) {
  const res = await robloxFetch(`https://groups.roblox.com/v1/groups/${groupId}`);
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Roblox groups API returned ${res.status}`);
  return res.json();
}

// Returns the role name if a member, false if definitely not a member,
// or null if membership couldn't be checked (API error, rate limit, etc.).
async function checkGroupMembership(userId, groupId) {
  try {
    const res = await robloxFetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
    if (!res.ok) return null;
    const { data } = await res.json();
    const entry = data?.find((g) => String(g.group.id) === String(groupId));
    return entry ? entry.role.name : false;
  } catch {
    return null;
  }
}

/* ------------------------------ UI builders ----------------------------- */

const notice = (text) => ({ content: text, embeds: [], components: [] });
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const groupUrl = (cfg) => `https://www.roblox.com/groups/${cfg.groupId}`;

const applyPanel = (guildName) => ({
  embeds: [
    new EmbedBuilder()
      .setTitle('Playtester Applications')
      .setDescription(`Want to help test games for **${guildName}**? Click the button below to apply.`)
      .setColor(0x5865f2),
  ],
  components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pt_apply').setLabel('Apply for Playtester').setStyle(ButtonStyle.Primary)
    ),
  ],
});

const joinStep = (p, cfg) => ({
  embeds: [
    new EmbedBuilder()
      .setTitle('Step 3: Join our Roblox group')
      .setDescription(
        `Found **${p.robloxName}** (ID \`${p.robloxId}\`).\n\n` +
          `Join **${cfg.groupName}** using the button below, then come back and click **I've Joined**.`
      )
      .setThumbnail(p.avatar)
      .setColor(0x5865f2),
  ],
  components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Join Roblox Group').setStyle(ButtonStyle.Link).setURL(groupUrl(cfg)),
      new ButtonBuilder().setCustomId('pt_joined').setLabel("I've Joined").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('pt_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    ),
  ],
});

const consentStep = (p, note) => ({
  embeds: [
    new EmbedBuilder()
      .setTitle('Step 4: Confirm and consent')
      .setDescription(
        `${note}\n\n` +
          `By clicking **Yes, I agree**, you confirm that:\n` +
          `• the Roblox account **${p.robloxName}** is yours,\n` +
          `• you agree to follow the playtesting rules, and\n` +
          `• you agree to share your Discord and Roblox details with this server's staff for this application.`
      )
      .setThumbnail(p.avatar)
      .setColor(0xfaa61a),
  ],
  components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pt_agree').setLabel('Yes, I agree').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('pt_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    ),
  ],
});

/* ------------------------------ Admin commands -------------------------- */

const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

async function handleSetup(interaction) {
  if (!isAdmin(interaction)) return interaction.reply(ephemeral('You need the **Manage Server** permission to do that.'));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.options.getChannel('staff_channel', true);
  const groupId = interaction.options.getInteger('roblox_group_id', true);

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const perms = channel.permissionsFor(me);
  const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((n) => !perms?.has(PermissionFlagsBits[n]));
  if (missing.length) {
    return interaction.editReply(
      `I'm missing permissions in ${channel}: **${missing.join(', ')}**. Grant them and run \`/setup\` again.`
    );
  }

  let group;
  try {
    group = await getGroup(groupId);
  } catch (err) {
    console.error(err);
    return interaction.editReply("Roblox didn't respond while I was checking that group. Try again in a minute.");
  }
  if (!group) {
    return interaction.editReply(
      `I couldn't find a Roblox group with ID \`${groupId}\`. The ID is the number in your group's URL (roblox.com/groups/**ID**/...).`
    );
  }

  configs[interaction.guildId] = { staffChannelId: channel.id, groupId, groupName: group.name };
  saveConfigs();

  await interaction.editReply(
    `✅ Setup complete.\n• Applications go to ${channel}\n• Roblox group: **${group.name}** (\`${groupId}\`)\n\n` +
      `Now run \`/panel\` in the channel where people should apply.`
  );
}

async function handleConfig(interaction) {
  if (!isAdmin(interaction)) return interaction.reply(ephemeral('You need the **Manage Server** permission to do that.'));
  const cfg = configs[interaction.guildId];
  if (!cfg) return interaction.reply(ephemeral('This server isn\'t set up yet. Run `/setup` first.'));
  return interaction.reply(
    ephemeral(
      `**Staff channel:** <#${cfg.staffChannelId}>\n**Roblox group:** [${cfg.groupName}](${groupUrl(cfg)}) (\`${cfg.groupId}\`)`
    )
  );
}

async function handlePanel(interaction) {
  if (!isAdmin(interaction)) return interaction.reply(ephemeral('You need the **Manage Server** permission to do that.'));
  if (!configs[interaction.guildId]) return interaction.reply(ephemeral('Run `/setup` first so I know where to send applications.'));
  try {
    await interaction.channel.send(applyPanel(interaction.guild.name));
  } catch {
    return interaction.reply(ephemeral("I can't send messages in this channel. Give me **Send Messages** and **Embed Links** here."));
  }
  return interaction.reply(ephemeral('Panel posted.'));
}

/* ------------------------------ Applicant flow -------------------------- */

async function handleApplyButton(interaction) {
  if (!configs[interaction.guildId]) {
    return interaction.reply(ephemeral('Applications aren\'t set up in this server yet. Ask an admin to run `/setup`.'));
  }
  const modal = new ModalBuilder().setCustomId('pt_username').setTitle('Playtester Application');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('roblox_username')
        .setLabel('Your Roblox username')
        .setStyle(TextInputStyle.Short)
        .setMinLength(3)
        .setMaxLength(20)
        .setRequired(true)
    )
  );
  await interaction.showModal(modal);
}

async function handleUsernameModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const cfg = configs[interaction.guildId];
  if (!cfg) return interaction.editReply(notice('Applications aren\'t set up in this server. Ask an admin to run `/setup`.'));

  const username = interaction.fields.getTextInputValue('roblox_username').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return interaction.editReply(notice("That doesn't look like a valid Roblox username. Click **Apply** to try again."));
  }

  let user;
  try {
    user = await getRobloxUser(username);
  } catch (err) {
    console.error(err);
    return interaction.editReply(notice("Roblox didn't respond. Please try again in a minute."));
  }
  if (!user) {
    return interaction.editReply(notice(`I couldn't find a Roblox user named **${username}**. Check the spelling and try again.`));
  }

  const p = {
    robloxId: user.id,
    robloxName: user.name,
    displayName: user.displayName,
    avatar: await getHeadshot(user.id),
    createdAt: Date.now(),
  };
  pending.set(pkey(interaction), p);
  await interaction.editReply(joinStep(p, cfg));
}

async function handleJoinedButton(interaction) {
  const cfg = configs[interaction.guildId];
  const p = getPending(interaction);
  if (!cfg || !p) return interaction.update(notice('This application expired. Click **Apply for Playtester** to start again.'));

  await interaction.deferUpdate();
  const membership = await checkGroupMembership(p.robloxId, cfg.groupId);

  if (membership === false) {
    return interaction.editReply({
      ...joinStep(p, cfg),
      content: `I can't see **${p.robloxName}** in the group yet. Join it, wait a few seconds, then click **I've Joined** again.`,
    });
  }

  p.membership = membership === null ? 'Could not verify (Roblox API unavailable)' : `Verified member (${membership})`;
  const note =
    membership === null
      ? "⚠️ I couldn't verify your group membership right now. Staff will check it manually."
      : '✅ Group membership verified.';
  await interaction.editReply({ ...consentStep(p, note), content: '' });
}

async function handleAgreeButton(interaction) {
  const cfg = configs[interaction.guildId];
  const p = getPending(interaction);
  if (!cfg || !p || !p.membership) {
    return interaction.update(notice('This application expired. Click **Apply for Playtester** to start again.'));
  }

  const channel = await client.channels.fetch(cfg.staffChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`Staff channel missing for guild ${interaction.guildId}`);
    return interaction.update(
      notice("I couldn't deliver your application because the staff channel is unavailable. Please tell an admin to re-run `/setup`.")
    );
  }

  const unix = Math.floor(Date.now() / 1000);
  const embed = new EmbedBuilder()
    .setTitle('New Playtester Application')
    .setColor(0x57f287)
    .setThumbnail(p.avatar)
    .addFields(
      { name: 'Discord', value: `${interaction.user} (${interaction.user.tag})\nID: \`${interaction.user.id}\``, inline: true },
      {
        name: 'Roblox',
        value: `[${p.robloxName}](https://www.roblox.com/users/${p.robloxId}/profile)\nDisplay: ${p.displayName}`,
        inline: true,
      },
      { name: 'Roblox User ID', value: `\`${p.robloxId}\``, inline: true },
      { name: 'Group Membership', value: `${p.membership}\nGroup: ${cfg.groupName}` },
      { name: 'Consent', value: '✅ Agreed to playtesting rules and data sharing' },
      { name: 'Applied', value: `<t:${unix}:F> (<t:${unix}:R>)` }
    )
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    return interaction.update(notice("I couldn't deliver your application. Please tell an admin to check my permissions in the staff channel."));
  }

  pending.delete(pkey(interaction));
  await interaction.update(notice('🎉 Your application has been submitted! Staff will review it and get back to you.'));
}

async function handleCancelButton(interaction) {
  pending.delete(pkey(interaction));
  await interaction.update(notice('Application cancelled. You can apply again any time.'));
}

/* ------------------------------ Wiring ---------------------------------- */

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure playtester applications for this server')
    .addChannelOption((o) =>
      o
        .setName('staff_channel')
        .setDescription('Private channel where applications are sent')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName('roblox_group_id')
        .setDescription('Your Roblox group ID (the number in the group URL)')
        .setMinValue(1)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post the playtester application button in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Show this server\'s playtester settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async () => {
  await client.application.commands.set(commands); // global: works in every server
  console.log(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s)`);
});

client.on(Events.GuildDelete, (guild) => {
  if (configs[guild.id]) {
    delete configs[guild.id];
    saveConfigs();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild()) return;

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'setup': return await handleSetup(interaction);
        case 'panel': return await handlePanel(interaction);
        case 'config': return await handleConfig(interaction);
      }
    }
    if (interaction.isButton()) {
      switch (interaction.customId) {
        case 'pt_apply': return await handleApplyButton(interaction);
        case 'pt_joined': return await handleJoinedButton(interaction);
        case 'pt_agree': return await handleAgreeButton(interaction);
        case 'pt_cancel': return await handleCancelButton(interaction);
      }
    }
    if (interaction.isModalSubmit() && interaction.customId === 'pt_username') {
      return await handleUsernameModal(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = ephemeral('Something went wrong. Please try again.');
    if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);