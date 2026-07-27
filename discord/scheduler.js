const cron = require('node-cron');
const db = require('../database/database');
const { sendDailyProgram } = require('./bot');
const { broadcast } = require('../websocket/wsServer');

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDayOfWeekIndex() {
  // JavaScript : 0 = Dimanche, 1 = Lundi, ..., 6 = Samedi
  // Notre convention : 1 = Lundi, 2 = Mardi, ..., 7 = Dimanche
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

function initScheduler() {
  const timezone = process.env.TZ || 'Europe/Paris';

  // 1. Cron de 08:00 : Envoi automatique du programme du jour
  cron.schedule('0 8 * * *', async () => {
    const dateStr = getTodayString();
    const dayOfWeek = getDayOfWeekIndex();
    const activeProgId = db.getActiveProgramId();
    const channelId = process.env.DISCORD_CHANNEL_ID;

    db.addLog(`[08:00] Déclenchement de l'envoi du programme pour le ${dateStr}`, 'INFO');

    if (!activeProgId) {
      db.addLog('Aucun programme actif configuré. Impossible d envoyer le message de 08:00.', 'WARNING');
      return;
    }

    const exercises = db.getExercisesByProgrammeAndDay(activeProgId, dayOfWeek);

    if (exercises.length === 0) {
      // Repos automatique
      db.closeDayAndCalculateStreak(dateStr, activeProgId, dayOfWeek);
      broadcast('STREAK_UPDATED', db.calculateStreakInfo());
      db.addLog(`[08:00] Aucun exercice aujourd'hui. Journée de repos validée automatiquement pour la streak.`, 'INFO');
    } else if (channelId) {
      await sendDailyProgram(channelId, activeProgId, dayOfWeek, dateStr);
      broadcast('PROGRAM_SENT', { date: dateStr, exercisesCount: exercises.length });
    } else {
      db.addLog('ID du salon DISCORD_CHANNEL_ID non défini dans .env', 'WARNING');
    }
  }, { timezone });

  // 2. Cron de 23:59 : Clôture automatique de la journée et mise à jour de la streak
  cron.schedule('59 23 * * *', () => {
    const dateStr = getTodayString();
    const dayOfWeek = getDayOfWeekIndex();
    const activeProgId = db.getActiveProgramId();

    db.addLog(`[23:59] Fin automatique de la journée ${dateStr}`, 'INFO');

    if (activeProgId) {
      const result = db.closeDayAndCalculateStreak(dateStr, activeProgId, dayOfWeek);
      broadcast('STREAK_UPDATED', db.calculateStreakInfo());
      broadcast('STATS_UPDATED', db.getStats(30));
      db.addLog(`[23:59] Clôture terminée. Statut: ${result.status}, Streak: ${result.streak}`, 'INFO');
    }
  }, { timezone });

  // 3. Cron de 02:00 : Sauvegarde automatique SQLite dans /backups/
  cron.schedule('0 2 * * *', () => {
    db.addLog('[02:00] Exécution de la sauvegarde automatique SQLite...', 'INFO');
    const backupName = db.autoBackupDatabase();
    if (backupName) {
      broadcast('BACKUP_CREATED', { fileName: backupName });
    }
  }, { timezone });

  // 4. Cron de 03:00 : Purge automatique des données de plus de 45 jours
  cron.schedule('0 3 * * *', () => {
    db.addLog('[03:00] Exécution de la purge automatique des données > 45 jours...', 'INFO');
    db.cleanOldData(45);
  }, { timezone });

  db.addLog(`Planificateur de tâches Cron initialisé (Fuseau: ${timezone}).`, 'INFO');
  console.log(`[Scheduler] Tâches Cron configurées avec succès (${timezone}).`);
}

module.exports = {
  initScheduler,
  getTodayString,
  getDayOfWeekIndex
};
