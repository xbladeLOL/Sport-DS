const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database/database');
const { broadcast } = require('../websocket/wsServer');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

let isReady = false;

// Evénement Ready
client.once('ready', () => {
  isReady = true;
  db.addLog(`Bot Discord connecté en tant que ${client.user.tag}`, 'INFO');
  console.log(`[Discord Bot] Connecté en tant que ${client.user.tag}`);
});

// Reconnexion et gestion des erreurs Discord sans crash
client.on('error', (err) => {
  db.addLog(`Erreur Bot Discord : ${err.message}`, 'ERROR');
  console.error('[Discord Bot Error]', err.message);
});

client.on('shardReconnecting', () => {
  db.addLog('Bot Discord en cours de reconnexion...', 'WARNING');
});

// --- GENERATION DE LA BARRE DE PROGRESSION DISCORD ---
function buildProgressBar(doneCount, totalCount) {
  if (totalCount === 0) return '░░░░░░░░░░ 0 %';
  const percentage = Math.round((doneCount / totalCount) * 100);
  const totalBlocks = 10;
  const filledBlocks = Math.round((percentage / 100) * totalBlocks);
  const emptyBlocks = totalBlocks - filledBlocks;
  const bar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
  return `${doneCount} / ${totalCount} exercices validés\n${bar} ${percentage} %`;
}

// --- GENERATION DU JOUR EN FRANCAIS ---
function getDayName(dayIndex) {
  const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  return days[dayIndex % 7];
}

// --- ENVOI DU PROGRAMME DU JOUR ---
async function sendDailyProgram(channelId, activeProgrammeId, dayOfWeek, dateStr) {
  if (!isReady) {
    db.addLog("Bot Discord non prêt. Impossible d'envoyer le message.", 'WARNING');
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      db.addLog(`Salon Discord non trouvé pour l'ID ${channelId}`, 'ERROR');
      return null;
    }

    const prog = db.getProgrammeById(activeProgrammeId);
    const progName = prog ? prog.name : 'Programme';
    const exercises = db.getExercisesByProgrammeAndDay(activeProgrammeId, dayOfWeek);

    if (exercises.length === 0) {
      db.addLog(`Aucun exercice prévu pour aujourd'hui (Jour ${dayOfWeek}). Aucun message Discord envoyé.`, 'INFO');
      return null;
    }

    // Calcul de la semaine courante (depuis la création du programme ou du mois)
    const currentWeekNumber = Math.ceil(new Date().getDate() / 7);

    // Discord autorise max 5 ActionRows par message.
    // Chaque exercice possède 1 ActionRow avec 3 boutons (DONE, FAILED, SKIPPED).
    // On découpe donc par tranche de 5 exercices maximum par message.
    const CHUNK_SIZE = 5;
    const totalChunks = Math.ceil(exercises.length / CHUNK_SIZE);
    const sentMessageIds = [];

    const existingHistory = db.getTodayHistory(dateStr);
    const historyMap = {};
    existingHistory.forEach(h => { historyMap[h.exercice_id] = h; });

    const totalCount = exercises.length;
    const doneCount = Object.values(historyMap).filter(h => h.status === 'DONE').length;

    for (let c = 0; c < totalChunks; c++) {
      const chunkExercises = exercises.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);

      const embed = new EmbedBuilder()
        .setColor(0x06B6D4) // Neon Cyan
        .setTitle(`🏋️ ${progName} — ${getDayName(dayOfWeek)} ${dateStr}` + (totalChunks > 1 ? ` (Partie ${c + 1}/${totalChunks})` : ''))
        .setTimestamp();

      let descriptionText = '';
      const actionRows = [];

      chunkExercises.forEach((ex, idx) => {
        const globalIndex = (c * CHUNK_SIZE) + idx + 1;
        const target = db.getCalculatedTarget(ex, currentWeekNumber);

        const currentStatus = historyMap[ex.id] ? historyMap[ex.id].status : null;
        let statusPrefix = '';
        if (currentStatus === 'DONE') statusPrefix = '✅ ';
        else if (currentStatus === 'FAILED') statusPrefix = '❌ ';
        else if (currentStatus === 'SKIPPED') statusPrefix = '⏭ ';

        descriptionText += `**${globalIndex}. ${statusPrefix}${ex.name}**\n`;
        descriptionText += `${ex.sets} séries • ${ex.reps} répétitions`;
        if (target.targetReps !== ex.reps || target.targetWeight > 0) {
          descriptionText += ` *(Objectif : ${target.targetReps} reps${target.targetWeight > 0 ? ` @ ${target.targetWeight}kg` : ''})*`;
        }
        if (ex.comments) {
          descriptionText += `\n*${ex.comments}*`;
        }
        descriptionText += '\n\n';

        // Boutons pour cet exercice
        const isAnswered = !!currentStatus;

        const doneButton = new ButtonBuilder()
          .setCustomId(`EX_DONE_${ex.id}_${dateStr}`)
          .setLabel('Fait')
          .setEmoji('✅')
          .setStyle(currentStatus === 'DONE' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(isAnswered);

        const failedButton = new ButtonBuilder()
          .setCustomId(`EX_FAILED_${ex.id}_${dateStr}`)
          .setLabel('Échec')
          .setEmoji('❌')
          .setStyle(currentStatus === 'FAILED' ? ButtonStyle.Danger : ButtonStyle.Secondary)
          .setDisabled(isAnswered);

        const skippedButton = new ButtonBuilder()
          .setCustomId(`EX_SKIPPED_${ex.id}_${dateStr}`)
          .setLabel('Non fait')
          .setEmoji('⏭')
          .setStyle(currentStatus === 'SKIPPED' ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(isAnswered);

        const row = new ActionRowBuilder().addComponents(doneButton, failedButton, skippedButton);
        actionRows.push(row);
      });

      // Ajouter la barre de progression sur la dernière tranche
      if (c === totalChunks - 1) {
        embed.addFields({
          name: '📊 Progression du jour',
          value: buildProgressBar(doneCount, totalCount)
        });
      }

      embed.setDescription(descriptionText);

      const msg = await channel.send({ embeds: [embed], components: actionRows });
      sentMessageIds.push(msg.id);
    }

    db.setParam(`discord_msgs_${dateStr}`, JSON.stringify({ channelId, messageIds: sentMessageIds }));
    db.addLog(`Message(s) du programme du jour envoyé(s) sur Discord (IDs: ${sentMessageIds.join(', ')})`, 'INFO');
    return sentMessageIds;
  } catch (err) {
    db.addLog(`Erreur d'envoi du message Discord : ${err.message}`, 'ERROR');
    console.error('[Discord sendDailyProgram Error]', err);
    return null;
  }
}

// --- GESTION DES CLICS SUR LES BOUTONS DISCORD ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  if (!customId.startsWith('EX_')) return;

  const parts = customId.split('_'); // ['EX', 'DONE', '12', '2026-07-27']
  if (parts.length < 4) return;

  const action = parts[1]; // DONE, FAILED, SKIPPED
  const exerciseId = parseInt(parts[2], 10);
  const dateStr = parts[3];

  try {
    // Vérifier si cet exercice a déjà été validé
    const existingHistory = db.getTodayHistory(dateStr);
    const existing = existingHistory.find(h => h.exercice_id === exerciseId);

    if (existing) {
      return interaction.reply({
        content: '🔒 Cet exercice a déjà été validé et ne peut plus être modifié.',
        ephemeral: true
      });
    }

    // Récupérer l'exercice
    const exRow = db.db.prepare('SELECT * FROM exercices WHERE id = ?').get(exerciseId);
    const exName = exRow ? exRow.name : `Exercice #${exerciseId}`;
    const sets = exRow ? exRow.sets : 1;
    const reps = exRow ? exRow.reps : 1;
    const weight = exRow ? exRow.weight_kg : 0;

    // Enregistrer le résultat SQLite
    db.recordExerciseHistory(dateStr, exerciseId, exName, sets, reps, weight, action);

    // Notifier immédiatement l'interface Web via WebSocket
    broadcast('EXERCISE_UPDATED', {
      date: dateStr,
      exerciseId,
      exerciseName: exName,
      status: action
    });

    // Mettre à jour tous les messages Discord du jour pour refléter la nouvelle progression et désactiver les boutons
    const msgDataStr = db.getParam(`discord_msgs_${dateStr}`);
    if (msgDataStr) {
      const { channelId, messageIds } = JSON.parse(msgDataStr);
      const activeProgId = db.getActiveProgramId();
      const dayOfWeek = new Date().getDay() === 0 ? 7 : new Date().getDay();
      const allExercises = db.getExercisesByProgrammeAndDay(activeProgId, dayOfWeek);
      const updatedHistory = db.getTodayHistory(dateStr);
      const historyMap = {};
      updatedHistory.forEach(h => { historyMap[h.exercice_id] = h; });

      const doneCount = Object.values(historyMap).filter(h => h.status === 'DONE').length;
      const totalCount = allExercises.length;
      const CHUNK_SIZE = 5;

      const channel = await client.channels.fetch(channelId);
      if (channel) {
        for (let c = 0; c < messageIds.length; c++) {
          const mId = messageIds[c];
          const chunkExercises = allExercises.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
          try {
            const targetMsg = await channel.messages.fetch(mId);
            if (targetMsg) {
              const currentWeekNumber = Math.ceil(new Date().getDate() / 7);

              const embed = new EmbedBuilder()
                .setColor(0x06B6D4)
                .setTitle(targetMsg.embeds[0]?.title || `🏋️ Programme — ${dateStr}`)
                .setTimestamp();

              let descriptionText = '';
              const actionRows = [];

              chunkExercises.forEach((ex, idx) => {
                const globalIndex = (c * CHUNK_SIZE) + idx + 1;
                const target = db.getCalculatedTarget(ex, currentWeekNumber);
                const status = historyMap[ex.id] ? historyMap[ex.id].status : null;

                let statusPrefix = '';
                if (status === 'DONE') statusPrefix = '✅ ';
                else if (status === 'FAILED') statusPrefix = '❌ ';
                else if (status === 'SKIPPED') statusPrefix = '⏭ ';

                descriptionText += `**${globalIndex}. ${statusPrefix}${ex.name}**\n`;
                descriptionText += `${ex.sets} séries • ${ex.reps} répétitions`;
                if (target.targetReps !== ex.reps || target.targetWeight > 0) {
                  descriptionText += ` *(Objectif : ${target.targetReps} reps${target.targetWeight > 0 ? ` @ ${target.targetWeight}kg` : ''})*`;
                }
                if (ex.comments) {
                  descriptionText += `\n*${ex.comments}*`;
                }
                descriptionText += '\n\n';

                const isAnswered = !!status;

                const doneButton = new ButtonBuilder()
                  .setCustomId(`EX_DONE_${ex.id}_${dateStr}`)
                  .setLabel('Fait')
                  .setEmoji('✅')
                  .setStyle(status === 'DONE' ? ButtonStyle.Success : ButtonStyle.Secondary)
                  .setDisabled(isAnswered);

                const failedButton = new ButtonBuilder()
                  .setCustomId(`EX_FAILED_${ex.id}_${dateStr}`)
                  .setLabel('Échec')
                  .setEmoji('❌')
                  .setStyle(status === 'FAILED' ? ButtonStyle.Danger : ButtonStyle.Secondary)
                  .setDisabled(isAnswered);

                const skippedButton = new ButtonBuilder()
                  .setCustomId(`EX_SKIPPED_${ex.id}_${dateStr}`)
                  .setLabel('Non fait')
                  .setEmoji('⏭')
                  .setStyle(status === 'SKIPPED' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                  .setDisabled(isAnswered);

                actionRows.push(new ActionRowBuilder().addComponents(doneButton, failedButton, skippedButton));
              });

              if (c === messageIds.length - 1) {
                embed.addFields({
                  name: '📊 Progression du jour',
                  value: buildProgressBar(doneCount, totalCount)
                });
              }

              embed.setDescription(descriptionText);
              await targetMsg.edit({ embeds: [embed], components: actionRows });
            }
          } catch (e) {
            console.error(`Erreur d edition du message ${mId}:`, e.message);
          }
        }
      }
    }

    // Répondre à l'interaction pour confirmer la prise en compte
    const statusLabels = { 'DONE': '✅ Validé (Fait)', 'FAILED': '❌ Marquée comme Échec', 'SKIPPED': '⏭ Marqué comme Non fait' };
    await interaction.reply({
      content: `Exercice **${exName}** : ${statusLabels[action]}`,
      ephemeral: true
    });

  } catch (err) {
    db.addLog(`Erreur bouton Discord : ${err.message}`, 'ERROR');
    console.error('[Discord button interaction error]', err);
    if (!interaction.replied) {
      await interaction.reply({ content: 'Une erreur s est produite.', ephemeral: true });
    }
  }
});

// Connexion du bot Discord avec gestion du Token manquant
function startDiscordBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token || token.includes('votre_token')) {
    db.addLog("Jeton DISCORD_TOKEN manquant ou non configuré dans .env. Le bot ne s'est pas connecté.", 'WARNING');
    console.warn('[Discord Bot] Aucun DISCORD_TOKEN valide dans .env. Le serveur web continuera de fonctionner.');
    return;
  }

  client.login(token).catch(err => {
    db.addLog(`Échec de connexion Discord : ${err.message}`, 'ERROR');
    console.error('[Discord Login Failed]', err.message);
  });
}

module.exports = {
  client,
  startDiscordBot,
  sendDailyProgram,
  isBotReady: () => isReady
};
