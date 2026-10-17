require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const { DISCORD_TOKEN, GUILD_ID, STAFF_CHANNEL_ID, ROBLOX_GROUP_ID } = process.env;
for (const [k, v] of Object.entries({ DISCORD_TOKEN, GUILD_ID, STAFF_CHANNEL_ID, ROBLOX_GROUP_ID })) {
  if (!v) throw new Error(`Missing ${k} in .env`);
}

const GROUP_URL = `https://www.roblox.com/groups/${ROBLOX_GROUP_ID}`;
const PENDING_TTL_MS = 15 * 60 * 1000;

// discordUserId -> { robloxId, robloxName, displayName, avatar, createdAt }
const pending = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ------------------------------ Roblox API ------------------------------ */

async function robloxFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
}

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

// Returns the role name if a member, false if definitely not a member,
// or null if membership couldn't be checked (API error, rate limit, etc.).
async function checkGroupMembership(userId) {
  try {
    const res = await robloxFetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
    if (!res.ok) return null;
    const { data } = await res.json();
    const entry = data?.find((g) => String(g.group.id) === String(ROBLOX_GROUP_ID));
    return entry ? entry.role.name : false;
  } catch {
    return null;
  }
}

/* ------------------------------ UI builders ----------------------------- */

const applyPanel = () => ({
  embeds: [
    new EmbedBuilder()
      .setTitle('Playtester Applications')
      .setDescription('Want to help test our games before release? Click the button below to apply.')
      .setColor(0x5865f2),
  ],
  components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pt_apply').setLabel('Apply for Playtester').setStyle(ButtonStyle.Primary)
    ),
  ],
});

const joinStep = (p) => ({
  embeds: [
    new EmbedBuilder()
      .setTitle('Step 3: Join our Roblox group')
      .setDescription(
        `Found **${p.robloxName}** (ID \`${p.robloxId}\`).\n\n` +
          `Join the group using the button below, then come back and click **I've Joined**.`
      )
      .setThumbnail(p.avatar)
      .setColor(0x5865f2),
  ],
  components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Join Roblox Group').setStyle(ButtonStyle.Link).setURL(GROUP_URL),
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
          `• you agree to share your Discord and Roblox details with our staff for this application.`
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

const notice = (text) => ({ content: text, embeds: [], components: [] });

/* ------------------------------ Handlers -------------------------------- */

function getPending(userId) {
  const p = pending.get(userId);
  if (!p) return null;
  if (Date.now() - p.createdAt > PENDING_TTL_MS) {
    pending.delete(userId);
    return null;
  }
  return p;
}

async function handleApplyButton(interaction) {
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
  const username = interaction.fields.getTextInputValue('roblox_username').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return interaction.editReply(notice('That doesn\'t look like a valid Roblox username. Click **Apply** to try again.'));
  }

  let user;
  try {
    user = await getRobloxUser(username);
  } catch (err) {
    console.error(err);
    return interaction.editReply(notice('Roblox didn\'t respond. Please try again in a minute.'));
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
  pending.set(interaction.user.id, p);
  await interaction.editReply(joinStep(p));
}

async function handleJoinedButton(interaction) {
  const p = getPending(interaction.user.id);
  if (!p) return interaction.update(notice('This application expired. Click **Apply for Playtester** to start again.'));

  await interaction.deferUpdate();
  const membership = await checkGroupMembership(p.robloxId);

  if (membership === false) {
    return interaction.editReply({
      ...joinStep(p),
      content: "I can't see **" + p.robloxName + '** in the group yet. Join it, wait a few seconds, then click **I\'ve Joined** again.',
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
  const p = getPending(interaction.user.id);
  if (!p || !p.membership) {
    return interaction.update(notice('This application expired. Click **Apply for Playtester** to start again.'));
  }

  const channel = await client.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error('Staff channel not found or not text-based.');
    return interaction.update(notice('Something went wrong sending your application. Please contact staff.'));
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
      { name: 'Group Membership', value: p.membership },
      { name: 'Consent', value: '✅ Agreed to playtesting rules and data sharing' },
      { name: 'Applied', value: `<t:${unix}:F> (<t:${unix}:R>)` }
    )
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    return interaction.update(notice('Something went wrong sending your application. Please contact staff.'));
  }

  pending.delete(interaction.user.id);
  await interaction.update(notice('🎉 Your application has been submitted! Staff will review it and get back to you.'));
}

async function handleCancelButton(interaction) {
  pending.delete(interaction.user.id);
  await interaction.update(notice('Application cancelled. You can apply again any time.'));
}

/* ------------------------------ Wiring ---------------------------------- */

client.once('clientReady', async () => {
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set([
    new SlashCommandBuilder()
      .setName('playtester-panel')
      .setDescription('Post the playtester application panel in this channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
  ]);
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'playtester-panel') {
      await interaction.channel.send(applyPanel());
      return interaction.reply({ content: 'Panel posted.', flags: MessageFlags.Ephemeral });
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
    const msg = { content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
