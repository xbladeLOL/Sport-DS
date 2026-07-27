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
  
  // Rattrapage automatique au démarrage si le programme du jour n'a pas encore été envoyé
  checkAndSendMissedDailyProgram();
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

// --- GENERATION DE LA RANGÉE DE BOUTONS DE SEANCE ---
function buildSessionActionRow(session, dateStr) {
  const state = session ? session.session_state : 'IDLE';

  const btnStart = new ButtonBuilder()
    .setCustomId(`SESSION_START_${dateStr}`)
    .setLabel('Lancer la séance')
    .setEmoji('▶️')
    .setStyle(ButtonStyle.Success)
    .setDisabled(state === 'ACTIVE' || state === 'ENDED');

  const btnEnd = new ButtonBuilder()
    .setCustomId(`SESSION_END_${dateStr}`)
    .setLabel('Finir la séance')
    .setEmoji('⏹️')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(state === 'IDLE' || state === 'ENDED');

  return new ActionRowBuilder().addComponents(btnStart, btnEnd);
}

function getSessionStatusFieldText(session) {
  if (!session || session.session_state === 'IDLE') return '▶️ Non démarrée';
  if (session.session_state === 'ACTIVE') {
    const startFormatted = session.start_time ? new Date(session.start_time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
    return `⏱️ **En cours** (depuis ${startFormatted})`;
  }
  if (session.session_state === 'PAUSED') return '⏸️ **En pause**';
  if (session.session_state === 'ENDED') {
    const mins = Math.round((session.duration_sec || 0) / 60);
    return `🏁 **Terminée** — Durée : **${mins} min**`;
  }
  return '▶️ Non démarrée';
}

// --- MISE A JOUR DES MESSAGES DISCORD DE LA JOURNEE ---
async function updateDiscordDailyMessages(dateStr) {
  const msgDataStr = db.getParam(`discord_msgs_${dateStr}`);
  if (!msgDataStr) return;

  const { channelId, messageIds } = JSON.parse(msgDataStr);
  const activeProgId = db.getActiveProgramId();
  if (!activeProgId) return;

  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const dayOfWeek = dateObj.getDay() === 0 ? 7 : dateObj.getDay();

  const allExercises = db.getExercisesByProgrammeAndDay(activeProgId, dayOfWeek);
  const updatedHistory = db.getTodayHistory(dateStr);
  const historyMap = {};
  updatedHistory.forEach(h => { historyMap[h.exercice_id] = h; });

  const doneCount = allExercises.filter(ex => historyMap[ex.id] && historyMap[ex.id].status === 'DONE').length;
  const totalCount = allExercises.length;
  const session = db.getTodaySession(dateStr);

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const CHUNK_SIZE = 4;
  const currentWeekNumber = Math.ceil(new Date().getDate() / 7);

  for (let c = 0; c < messageIds.length; c++) {
    const mId = messageIds[c];
    const chunkExercises = allExercises.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
    try {
      const targetMsg = await channel.messages.fetch(mId).catch(() => null);
      if (!targetMsg) continue;

      const embed = new EmbedBuilder()
        .setColor(0x06B6D4)
        .setTitle(targetMsg.embeds[0]?.title || `🏋️ Programme — ${dateStr}`)
        .setTimestamp();

      let descriptionText = '';
      const actionRows = [];

      if (c === 0) {
        actionRows.push(buildSessionActionRow(session, dateStr));
      }

      chunkExercises.forEach((ex, idx) => {
        const globalIndex = (c * CHUNK_SIZE) + idx + 1;
        const target = db.getCalculatedTarget(ex, currentWeekNumber);
        const status = historyMap[ex.id] ? historyMap[ex.id].status : null;

        let statusPrefix = '';
        if (status === 'DONE') statusPrefix = '✅ ';
        else if (status === 'FAILED') statusPrefix = '❌ ';
        else if (status === 'SKIPPED') statusPrefix = '⏭ ';

        descriptionText += `**${globalIndex}. ${statusPrefix}${ex.name}**\n`;
        if (ex.is_static) {
          const holdSec = ex.hold_time_sec || 0;
          descriptionText += `${ex.sets} séries • Maintien : **${holdSec}s**`;
          if (target.targetHoldTime > holdSec || target.targetWeight > 0) {
            descriptionText += ` *(Objectif : ${target.targetHoldTime}s${target.targetWeight > 0 ? ` @ ${target.targetWeight}kg` : ''})*`;
          }
        } else {
          descriptionText += `${ex.sets} séries • ${ex.reps} répétitions`;
          if (target.targetReps !== ex.reps || target.targetWeight > 0) {
            descriptionText += ` *(Objectif : ${target.targetReps} reps${target.targetWeight > 0 ? ` @ ${target.targetWeight}kg` : ''})*`;
          }
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

      embed.setDescription(descriptionText);
      embed.addFields(
        { name: '⏱️ Statut Séance', value: getSessionStatusFieldText(session), inline: true }
      );

      if (c === messageIds.length - 1) {
        embed.addFields({
          name: '📊 Progression du jour',
          value: buildProgressBar(doneCount, totalCount)
        });
      }

      await targetMsg.edit({ embeds: [embed], components: actionRows });
    } catch (e) {
      console.error(`Erreur d édition du message ${mId}:`, e.message);
    }
  }
}

// --- ENVOI DU PROGRAMME DU JOUR ---
async function sendDailyProgram(channelId, activeProgrammeId, dayOfWeek, dateStr) {
  if (!isReady) {
    const errorMsg = "Le bot Discord n'est pas connecté ou pas prêt. Vérifiez DISCORD_TOKEN dans le fichier .env.";
    db.addLog(errorMsg, 'WARNING');
    return { success: false, error: errorMsg };
  }

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      const errorMsg = `Salon Discord introuvable pour l'ID ${channelId}. Vérifiez DISCORD_CHANNEL_ID dans le fichier .env.`;
      db.addLog(errorMsg, 'ERROR');
      return { success: false, error: errorMsg };
    }

    const prog = db.getProgrammeById(activeProgrammeId);
    const progName = prog ? prog.name : 'Programme';
    const exercises = db.getExercisesByProgrammeAndDay(activeProgrammeId, dayOfWeek);

    if (exercises.length === 0) {
      const infoMsg = `Aucun exercice prévu pour aujourd'hui (${getDayName(dayOfWeek)}). Jour de repos.`;
      db.addLog(infoMsg, 'INFO');
      return { success: false, error: infoMsg };
    }

    const currentWeekNumber = Math.ceil(new Date().getDate() / 7);

    // CHUNK_SIZE = 4 pour réserver une ActionRow pour la séance sur le premier message
    const CHUNK_SIZE = 4;
    const totalChunks = Math.ceil(exercises.length / CHUNK_SIZE);
    const sentMessageIds = [];

    const existingHistory = db.getTodayHistory(dateStr);
    const historyMap = {};
    existingHistory.forEach(h => { historyMap[h.exercice_id] = h; });

    const totalCount = exercises.length;
    const doneCount = exercises.filter(ex => historyMap[ex.id] && historyMap[ex.id].status === 'DONE').length;
    const session = db.getTodaySession(dateStr);

    for (let c = 0; c < totalChunks; c++) {
      const chunkExercises = exercises.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);

      const embed = new EmbedBuilder()
        .setColor(0x06B6D4)
        .setTitle(`🏋️ ${progName} — ${getDayName(dayOfWeek)} ${dateStr}` + (totalChunks > 1 ? ` (Partie ${c + 1}/${totalChunks})` : ''))
        .setTimestamp();

      let descriptionText = '';
      const actionRows = [];

      // Boutons de contrôle de séance sur la première tranche
      if (c === 0) {
        actionRows.push(buildSessionActionRow(session, dateStr));
      }

      chunkExercises.forEach((ex, idx) => {
        const globalIndex = (c * CHUNK_SIZE) + idx + 1;
        const target = db.getCalculatedTarget(ex, currentWeekNumber);

        const currentStatus = historyMap[ex.id] ? historyMap[ex.id].status : null;
        let statusPrefix = '';
        if (currentStatus === 'DONE') statusPrefix = '✅ ';
        else if (currentStatus === 'FAILED') statusPrefix = '❌ ';
        else if (currentStatus === 'SKIPPED') statusPrefix = '⏭ ';

        descriptionText += `**${globalIndex}. ${statusPrefix}${ex.name}**\n`;
        if (ex.is_static) {
          const holdSec = ex.hold_time_sec || 0;
          descriptionText += `${ex.sets} séries • Maintien : **${holdSec}s**`;
          if (target.targetHoldTime > holdSec || target.targetWeight > 0) {
            descriptionText += ` *(Objectif : ${target.targetHoldTime}s${target.targetWeight > 0 ? ` @ ${target.targetWeight}kg` : ''})*`;
          }
        } else {
          descriptionText += `${ex.sets} séries • ${ex.reps} répétitions`;
          if (target.targetReps !== ex.reps || target.targetWeight > 0) {
            descriptionText += ` *(Objectif : ${target.targetReps} reps${target.targetWeight > 0 ? ` @ ${target.targetWeight}kg` : ''})*`;
          }
        }
        if (ex.comments) {
          descriptionText += `\n*${ex.comments}*`;
        }
        descriptionText += '\n\n';

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

        actionRows.push(new ActionRowBuilder().addComponents(doneButton, failedButton, skippedButton));
      });

      embed.setDescription(descriptionText);
      embed.addFields(
        { name: '⏱️ Statut Séance', value: getSessionStatusFieldText(session), inline: true }
      );

      if (c === totalChunks - 1) {
        embed.addFields({
          name: '📊 Progression du jour',
          value: buildProgressBar(doneCount, totalCount)
        });
      }

      const msg = await channel.send({ embeds: [embed], components: actionRows });
      sentMessageIds.push(msg.id);
    }

    db.setParam(`discord_msgs_${dateStr}`, JSON.stringify({ channelId, messageIds: sentMessageIds }));
    db.addLog(`Message(s) du programme du jour envoyé(s) sur Discord (IDs: ${sentMessageIds.join(', ')})`, 'INFO');
    return { success: true, messageIds: sentMessageIds };
  } catch (err) {
    const errorMsg = `Erreur d'envoi Discord : ${err.message}`;
    db.addLog(errorMsg, 'ERROR');
    console.error('[Discord sendDailyProgram Error]', err);
    return { success: false, error: errorMsg };
  }
}

// --- GESTION DES CLICS SUR LES BOUTONS DISCORD ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  // 1. Boutons de séance (SESSION_START, SESSION_END)
  if (customId.startsWith('SESSION_')) {
    const parts = customId.split('_'); // ['SESSION', 'START', '2026-07-28']
    if (parts.length < 3) return;

    const action = parts[1]; // START, END
    const dateStr = parts.slice(2).join('_');

    try {
      await interaction.deferUpdate();

      let session = null;
      if (action === 'START') {
        session = db.startWorkoutSession(dateStr);
        broadcast('SESSION_STARTED', { session });
      } else if (action === 'END') {
        session = db.endWorkoutSession(dateStr);
        broadcast('SESSION_ENDED', { session });
        broadcast('STATS_UPDATED', db.getStats(30));
      }

      await updateDiscordDailyMessages(dateStr);

    } catch (err) {
      db.addLog(`Erreur bouton séance Discord : ${err.message}`, 'ERROR');
      console.error('[Discord session button interaction error]', err);
    }
    return;
  }

  // 2. Boutons d'exercices (EX_DONE, EX_FAILED, EX_SKIPPED)
  if (!customId.startsWith('EX_')) return;

  const parts = customId.split('_'); // ['EX', 'DONE', '12', '2026-07-27']
  if (parts.length < 4) return;

  const action = parts[1]; // DONE, FAILED, SKIPPED
  const exerciseId = parseInt(parts[2], 10);
  const dateStr = parts.slice(3).join('_');

  try {
    const existingHistory = db.getTodayHistory(dateStr);
    const existing = existingHistory.find(h => h.exercice_id === exerciseId);

    if (existing) {
      return interaction.reply({
        content: '🔒 Cet exercice a déjà été validé et ne peut plus être modifié.',
        ephemeral: true
      });
    }

    // Acquittement immédiat sans message popup
    await interaction.deferUpdate();

    // Démarrage automatique de la séance si elle n'a pas encore été démarrée
    let currentSession = db.getTodaySession(dateStr);
    if (currentSession.session_state === 'IDLE') {
      currentSession = db.startWorkoutSession(dateStr);
      broadcast('SESSION_STARTED', { session: currentSession });
    }

    const exRow = db.db.prepare('SELECT * FROM exercices WHERE id = ?').get(exerciseId);
    const exName = exRow ? exRow.name : `Exercice #${exerciseId}`;
    const sets = exRow ? exRow.sets : 1;
    const reps = exRow ? exRow.reps : 1;
    const weight = exRow ? exRow.weight_kg : 0;

    // Enregistrer le résultat SQLite
    db.recordExerciseHistory(dateStr, exerciseId, exName, sets, reps, weight, action);

    const activeProgId = db.getActiveProgramId();
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const dayOfWeek = dateObj.getDay() === 0 ? 7 : dateObj.getDay();
    const planned = db.getExercisesByProgrammeAndDay(activeProgId, dayOfWeek);
    const updatedHistory = db.getTodayHistory(dateStr);
    const doneCount = planned.filter(ex => updatedHistory.some(h => h.exercice_id === ex.id && h.status === 'DONE')).length;
    const answeredCount = planned.filter(ex => updatedHistory.some(h => h.exercice_id === ex.id)).length;

    // Événements WebSocket pour mise à jour de l'UI Web
    broadcast('EXERCISE_UPDATED', {
      date: dateStr,
      exerciseId,
      exerciseName: exName,
      status: action
    });

    broadcast('PROGRESS_UPDATED', {
      date: dateStr,
      doneCount,
      totalCount: planned.length
    });

    // Auto-clôture si TOUS les exercices de la journée sont complétés/répondus
    if (planned.length > 0 && answeredCount >= planned.length) {
      const activeSession = db.getTodaySession(dateStr);
      if (activeSession.session_state === 'ACTIVE') {
        const endedSession = db.endWorkoutSession(dateStr);
        broadcast('SESSION_ENDED', { session: endedSession });
        broadcast('STATS_UPDATED', db.getStats(30));
        db.addLog(`Tous les exercices du ${dateStr} ont été réalisés. Séance clôturée automatiquement !`, 'INFO');
      }
    }

    // Mettre à jour les messages Discord
    await updateDiscordDailyMessages(dateStr);

  } catch (err) {
    db.addLog(`Erreur bouton Discord : ${err.message}`, 'ERROR');
    console.error('[Discord button interaction error]', err);
  }
});

// --- VERIFICATION ET RATTRAPAGE AUTOMATIQUE AU DEMARRAGE ---
async function checkAndSendMissedDailyProgram() {
  try {
    const { getTodayString, getDayOfWeekIndex } = require('./scheduler');
    const dateStr = getTodayString();
    const dayOfWeek = getDayOfWeekIndex();
    const activeProgId = db.getActiveProgramId();
    const channelId = process.env.DISCORD_CHANNEL_ID;

    if (!activeProgId) {
      db.addLog('[Démarrage] Aucun programme actif configuré.', 'WARNING');
      return;
    }

    // Vérifier si le message a déjà été envoyé aujourd'hui
    const existingMsgData = db.getParam(`discord_msgs_${dateStr}`);
    if (existingMsgData) {
      console.log(`[Démarrage] Le programme du jour (${dateStr}) a déjà été envoyé sur Discord.`);
      db.addLog(`[Démarrage] Le programme du jour (${dateStr}) a déjà été envoyé sur Discord.`, 'INFO');
      return;
    }

    const exercises = db.getExercisesByProgrammeAndDay(activeProgId, dayOfWeek);

    if (exercises.length === 0) {
      const dayLog = db.db.prepare('SELECT * FROM day_logs WHERE date = ?').get(dateStr);
      if (!dayLog) {
        db.closeDayAndCalculateStreak(dateStr, activeProgId, dayOfWeek);
        broadcast('STREAK_UPDATED', db.calculateStreakInfo());
        db.addLog(`[Démarrage] Aucun exercice aujourd'hui (${dateStr}). Journée de repos validée.`, 'INFO');
      }
    } else if (channelId && !channelId.includes('votre_channel')) {
      console.log(`[Démarrage] Programme du jour (${dateStr}) non envoyé. Rattrapage en cours...`);
      db.addLog(`[Démarrage] Programme du jour (${dateStr}) non envoyé. Rattrapage d'envoi en cours...`, 'INFO');
      const res = await sendDailyProgram(channelId, activeProgId, dayOfWeek, dateStr);
      if (res && res.success) {
        broadcast('PROGRAM_SENT', { date: dateStr, exercisesCount: exercises.length });
      }
    } else {
      db.addLog('[Démarrage] DISCORD_CHANNEL_ID non configuré.', 'WARNING');
    }
  } catch (err) {
    db.addLog(`[Démarrage] Erreur lors de la vérification de l'envoi : ${err.message}`, 'ERROR');
    console.error('[Startup Check Error]', err);
  }
}

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
  checkAndSendMissedDailyProgram,
  isBotReady: () => isReady
};
