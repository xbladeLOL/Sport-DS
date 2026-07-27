const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'sport_ds.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// Initialisation du schéma de base de données
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS parametres (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS programmes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS exercices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      programme_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      sets INTEGER DEFAULT 1,
      reps INTEGER DEFAULT 1,
      target_reps INTEGER DEFAULT 1,
      target_weight REAL DEFAULT 0,
      increment_reps_per_week INTEGER DEFAULT 0,
      increment_weight_per_week REAL DEFAULT 0,
      increment_interval_weeks INTEGER DEFAULT 1,
      duration_sec INTEGER DEFAULT 0,
      weight_kg REAL DEFAULT 0,
      comments TEXT,
      order_index INTEGER DEFAULT 0,
      FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS historique (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      exercice_id INTEGER,
      exercise_name TEXT NOT NULL,
      sets INTEGER,
      reps INTEGER,
      weight_kg REAL,
      status TEXT NOT NULL CHECK(status IN ('DONE', 'FAILED', 'SKIPPED')),
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS day_logs (
      date TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('SUCCESS', 'FAILED', 'REST')),
      exercises_total INTEGER DEFAULT 0,
      exercises_done INTEGER DEFAULT 0,
      discord_message_ids TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      message TEXT NOT NULL,
      level TEXT DEFAULT 'INFO'
    );
  `);

  // Migration douce pour les bases SQLite existantes
  try {
    db.exec(`ALTER TABLE exercices ADD COLUMN increment_interval_weeks INTEGER DEFAULT 1`);
  } catch (e) {
    // La colonne existe déjà
  }

  // Initialisation des paramètres par défaut
  const setParamStmt = db.prepare('INSERT OR IGNORE INTO parametres (key, value) VALUES (?, ?)');
  setParamStmt.run('current_streak', '0');
  setParamStmt.run('best_streak', '0');

  // Création d'un programme par défaut s'il n'en existe aucun
  const progCount = db.prepare('SELECT COUNT(*) as count FROM programmes').get().count;
  if (progCount === 0) {
    const info = db.prepare('INSERT INTO programmes (name) VALUES (?)').run('Programme Standard');
    const defaultProgId = info.lastInsertRowid;
    setParamStmt.run('active_program_id', defaultProgId.toString());

    // Exercices d'exemple (Lundi)
    const addEx = db.prepare(`
      INSERT INTO exercices 
      (programme_id, day_of_week, name, description, sets, reps, target_reps, increment_reps_per_week, duration_sec, weight_kg, comments, order_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    addEx.run(defaultProgId, 1, 'Pompes', 'Pompes classiques au sol', 4, 15, 15, 1, 120, 0, 'Garder le dos bien droit', 1);
    addEx.run(defaultProgId, 1, 'Dips', 'Dips sur chaise ou barres', 3, 12, 12, 1, 90, 0, 'Amplitude complète', 2);
    addEx.run(defaultProgId, 1, 'Squats', 'Squats poids du corps ou lestés', 4, 20, 20, 2, 120, 0, 'Descendre jusqu aux parallèles', 3);
  } else {
    // S'assurer qu'un programme actif est défini
    const active = db.prepare('SELECT value FROM parametres WHERE key = ?').get('active_program_id');
    if (!active) {
      const firstProg = db.prepare('SELECT id FROM programmes LIMIT 1').get();
      if (firstProg) {
        setParamStmt.run('active_program_id', firstProg.id.toString());
      }
    }
  }
}

initSchema();

// --- GESTION DES PARAMETRES ---
function getParam(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM parametres WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setParam(key, value) {
  db.prepare('INSERT OR REPLACE INTO parametres (key, value) VALUES (?, ?)').run(key, String(value));
}

function getActiveProgramId() {
  const val = getParam('active_program_id');
  return val ? parseInt(val, 10) : null;
}

function setActiveProgramId(id) {
  setParam('active_program_id', id);
  addLog(`Programme actif changé pour l'ID ${id}`, 'INFO');
}

// --- GESTION DES PROGRAMMES ---
function getAllProgrammes() {
  const activeId = getActiveProgramId();
  const progs = db.prepare('SELECT * FROM programmes ORDER BY id ASC').all();
  return progs.map(p => ({
    ...p,
    is_active: p.id === activeId
  }));
}

function getProgrammeById(id) {
  return db.prepare('SELECT * FROM programmes WHERE id = ?').get(id);
}

function createProgramme(name) {
  const info = db.prepare('INSERT INTO programmes (name) VALUES (?)').run(name);
  const newId = info.lastInsertRowid;
  // Si c'est le seul programme, l'activer automatiquement
  const progs = getAllProgrammes();
  if (progs.length === 1) {
    setActiveProgramId(newId);
  }
  addLog(`Nouveau programme créé : ${name} (ID: ${newId})`, 'INFO');
  return newId;
}

function deleteProgramme(id) {
  const activeId = getActiveProgramId();
  db.prepare('DELETE FROM programmes WHERE id = ?').run(id);
  addLog(`Programme supprimé (ID: ${id})`, 'WARNING');
  if (activeId === id) {
    const nextProg = db.prepare('SELECT id FROM programmes LIMIT 1').get();
    if (nextProg) {
      setActiveProgramId(nextProg.id);
    } else {
      setParam('active_program_id', '');
    }
  }
}

// --- GESTION DES EXERCICES ---
function getExercisesByProgramme(programmeId) {
  return db.prepare(`
    SELECT * FROM exercices 
    WHERE programme_id = ? 
    ORDER BY day_of_week ASC, order_index ASC
  `).all(programmeId);
}

function getExercisesByProgrammeAndDay(programmeId, dayOfWeek) {
  return db.prepare(`
    SELECT * FROM exercices 
    WHERE programme_id = ? AND day_of_week = ? 
    ORDER BY order_index ASC
  `).all(programmeId, dayOfWeek);
}

function addExercise(data) {
  const maxOrder = db.prepare(`
    SELECT COALESCE(MAX(order_index), 0) as max_ord 
    FROM exercices WHERE programme_id = ? AND day_of_week = ?
  `).get(data.programme_id, data.day_of_week).max_ord;

  const stmt = db.prepare(`
    INSERT INTO exercices (
      programme_id, day_of_week, name, description, sets, reps, 
      target_reps, target_weight, increment_reps_per_week, increment_weight_per_week, increment_interval_weeks,
      duration_sec, weight_kg, comments, order_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    data.programme_id,
    data.day_of_week,
    data.name,
    data.description || '',
    data.sets || 1,
    data.reps || 1,
    data.target_reps || data.reps || 1,
    data.target_weight || data.weight_kg || 0,
    data.increment_reps_per_week || 0,
    data.increment_weight_per_week || 0,
    data.increment_interval_weeks || 1,
    data.duration_sec || 0,
    data.weight_kg || 0,
    data.comments || '',
    maxOrder + 1
  );

  addLog(`Exercice ajouté : ${data.name} (Jour ${data.day_of_week})`, 'INFO');
  return info.lastInsertRowid;
}

function updateExercise(id, data) {
  const stmt = db.prepare(`
    UPDATE exercices SET
      name = ?, description = ?, sets = ?, reps = ?,
      target_reps = ?, target_weight = ?, 
      increment_reps_per_week = ?, increment_weight_per_week = ?, increment_interval_weeks = ?,
      duration_sec = ?, weight_kg = ?, comments = ?
    WHERE id = ?
  `);

  stmt.run(
    data.name,
    data.description || '',
    data.sets || 1,
    data.reps || 1,
    data.target_reps || data.reps || 1,
    data.target_weight || data.weight_kg || 0,
    data.increment_reps_per_week || 0,
    data.increment_weight_per_week || 0,
    data.increment_interval_weeks || 1,
    data.duration_sec || 0,
    data.weight_kg || 0,
    data.comments || '',
    id
  );

  addLog(`Exercice mis à jour : ${data.name} (ID: ${id})`, 'INFO');
}

function deleteExercise(id) {
  db.prepare('DELETE FROM exercices WHERE id = ?').run(id);
  addLog(`Exercice supprimé (ID: ${id})`, 'INFO');
}

function reorderExercises(programmeId, dayOfWeek, orderedIds) {
  const updateStmt = db.prepare('UPDATE exercices SET order_index = ? WHERE id = ? AND programme_id = ? AND day_of_week = ?');
  const transaction = db.transaction((ids) => {
    ids.forEach((id, index) => {
      updateStmt.run(index + 1, id, programmeId, dayOfWeek);
    });
  });
  transaction(orderedIds);
  addLog(`Ordre des exercices réorganisé (Programme ${programmeId}, Jour ${dayOfWeek})`, 'INFO');
}

function copyExercise(exerciseId, targetDayOfWeek) {
  const ex = db.prepare('SELECT * FROM exercices WHERE id = ?').get(exerciseId);
  if (!ex) return null;
  return addExercise({
    ...ex,
    day_of_week: targetDayOfWeek
  });
}

function copyDay(programmeId, sourceDayOfWeek, targetDayOfWeek) {
  const sourceExercises = getExercisesByProgrammeAndDay(programmeId, sourceDayOfWeek);
  // Supprimer les exercices existants sur la journée cible
  db.prepare('DELETE FROM exercices WHERE programme_id = ? AND day_of_week = ?').run(programmeId, targetDayOfWeek);

  sourceExercises.forEach((ex, idx) => {
    db.prepare(`
      INSERT INTO exercices (
        programme_id, day_of_week, name, description, sets, reps, 
        target_reps, target_weight, increment_reps_per_week, increment_weight_per_week, increment_interval_weeks,
        duration_sec, weight_kg, comments, order_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      programmeId,
      targetDayOfWeek,
      ex.name,
      ex.description,
      ex.sets,
      ex.reps,
      ex.target_reps,
      ex.target_weight,
      ex.increment_reps_per_week,
      ex.increment_weight_per_week,
      ex.increment_interval_weeks || 1,
      ex.duration_sec,
      ex.weight_kg,
      ex.comments,
      idx + 1
    );
  });

  addLog(`Journée ${sourceDayOfWeek} copiée vers Journée ${targetDayOfWeek}`, 'INFO');
}

// --- SURCHARGE PROGRESSIVE ET CALCUL D'OBJECTIFS ---
function getCalculatedTarget(exercise, weekNumber = 1) {
  const interval = Math.max(1, exercise.increment_interval_weeks || 1);
  const weekDiff = Math.max(0, weekNumber - 1);
  const incrementsApplied = Math.floor(weekDiff / interval);

  const targetReps = (exercise.target_reps || exercise.reps || 1) + (incrementsApplied * (exercise.increment_reps_per_week || 0));
  const targetWeight = (exercise.target_weight || exercise.weight_kg || 0) + (incrementsApplied * (exercise.increment_weight_per_week || 0));
  return {
    targetReps,
    targetWeight: Math.round(targetWeight * 10) / 10
  };
}

// --- HISTORIQUE & ENREGISTREMENT ---
function recordExerciseHistory(dateStr, exerciseId, name, sets, reps, weight_kg, status) {
  const stmt = db.prepare(`
    INSERT INTO historique (date, exercice_id, exercise_name, sets, reps, weight_kg, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(dateStr, exerciseId, name, sets, reps, weight_kg, status);
  addLog(`Exercice "${name}" marqué [${status}] pour le ${dateStr}`, 'INFO');
}

function getTodayHistory(dateStr) {
  return db.prepare('SELECT * FROM historique WHERE date = ?').all(dateStr);
}

// --- FIN DE JOURNÉE & CALCUL DE STREAK ---
function closeDayAndCalculateStreak(dateStr, activeProgrammeId, dayOfWeek) {
  const plannedExercises = getExercisesByProgrammeAndDay(activeProgrammeId, dayOfWeek);
  
  if (plannedExercises.length === 0) {
    // Jour de repos : compte comme un succès pour la streak !
    db.prepare(`
      INSERT OR REPLACE INTO day_logs (date, status, exercises_total, exercises_done)
      VALUES (?, 'REST', 0, 0)
    `).run(dateStr);
    
    incrementStreak();
    addLog(`Journée ${dateStr} : Jour de repos validé. Streak maintenue.`, 'INFO');
    return { status: 'REST', streak: parseInt(getParam('current_streak'), 10) };
  }

  const existingHistory = getTodayHistory(dateStr);
  const answeredExerciseIds = new Set(existingHistory.map(h => h.exercice_id));

  // Auto-fail pour les exercices non répondus
  let newSkips = 0;
  plannedExercises.forEach(ex => {
    if (!answeredExerciseIds.has(ex.id)) {
      recordExerciseHistory(dateStr, ex.id, ex.name, ex.sets, ex.reps, ex.weight_kg, 'SKIPPED');
      newSkips++;
    }
  });

  if (newSkips > 0) {
    addLog(`Clôture de journée : ${newSkips} exercice(s) non répondu(s) passé(s) en SKIPPED`, 'WARNING');
  }

  const fullHistory = getTodayHistory(dateStr);
  const totalCount = plannedExercises.length;
  const doneCount = fullHistory.filter(h => h.status === 'DONE').length;

  const isFullSuccess = (doneCount === totalCount) && (fullHistory.every(h => h.status === 'DONE'));

  let dayStatus = isFullSuccess ? 'SUCCESS' : 'FAILED';

  db.prepare(`
    INSERT OR REPLACE INTO day_logs (date, status, exercises_total, exercises_done)
    VALUES (?, ?, ?, ?)
  `).run(dateStr, dayStatus, totalCount, doneCount);

  if (isFullSuccess) {
    incrementStreak();
  } else {
    resetStreak();
  }

  const currentStreak = parseInt(getParam('current_streak'), 10);
  addLog(`Fin de journée ${dateStr} : Statut ${dayStatus} (${doneCount}/${totalCount} validés). Streak: ${currentStreak}`, 'INFO');

  return {
    status: dayStatus,
    exercisesTotal: totalCount,
    exercisesDone: doneCount,
    streak: currentStreak
  };
}

function incrementStreak() {
  const current = parseInt(getParam('current_streak', '0'), 10) + 1;
  let best = parseInt(getParam('best_streak', '0'), 10);
  if (current > best) {
    best = current;
    setParam('best_streak', best);
  }
  setParam('current_streak', current);
}

function resetStreak() {
  setParam('current_streak', '0');
}

function calculateStreakInfo() {
  return {
    currentStreak: parseInt(getParam('current_streak', '0'), 10),
    bestStreak: parseInt(getParam('best_streak', '0'), 10)
  };
}

// --- STATISTIQUES AVANCEES ---
function getStats(daysCount = 30) {
  // Période de temps
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - (daysCount - 1));

  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  // Totaux globaux historique
  const totalStats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) as skipped
    FROM historique
    WHERE date >= ? AND date <= ?
  `).get(startDateStr, endDateStr);

  const total = totalStats.total || 0;
  const done = totalStats.done || 0;
  const failed = totalStats.failed || 0;
  const skipped = totalStats.skipped || 0;
  const successRate = total > 0 ? Math.round((done / total) * 100) : 0;

  // Calcul du temps total et moyen d'entraînement
  const durationRow = db.prepare(`
    SELECT 
      SUM(e.duration_sec) as total_duration,
      COUNT(DISTINCT h.date) as total_sessions
    FROM historique h
    JOIN exercices e ON h.exercice_id = e.id
    WHERE h.date >= ? AND h.date <= ? AND h.status = 'DONE'
  `).get(startDateStr, endDateStr);

  const totalDurationSec = durationRow.total_duration || 0;
  const totalSessions = durationRow.total_sessions || 0;
  const avgSessionMin = totalSessions > 0 ? Math.round((totalDurationSec / totalSessions) / 60) : 0;

  // Taux de réussite par exercice
  const byExercise = db.prepare(`
    SELECT 
      exercise_name as name,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done
    FROM historique
    WHERE date >= ? AND date <= ?
    GROUP BY exercise_name
    ORDER BY total DESC
  `).all(startDateStr, endDateStr).map(row => ({
    name: row.name,
    total: row.total,
    done: row.done,
    rate: Math.round((row.done / row.total) * 100)
  }));

  // Taux de réussite par jour de la semaine
  const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const byDayOfWeekRaw = db.prepare(`
    SELECT 
      CAST(strftime('%w', date) AS INT) as day_num,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done
    FROM historique
    WHERE date >= ? AND date <= ?
    GROUP BY day_num
  `).all(startDateStr, endDateStr);

  const byDayOfWeekMap = {};
  byDayOfWeekRaw.forEach(r => {
    byDayOfWeekMap[r.day_num] = Math.round((r.done / r.total) * 100);
  });

  const byDayOfWeek = [1, 2, 3, 4, 5, 6, 0].map(dayNum => ({
    dayNumber: dayNum === 0 ? 7 : dayNum,
    dayName: dayNames[dayNum],
    rate: byDayOfWeekMap[dayNum] !== undefined ? byDayOfWeekMap[dayNum] : 0
  }));

  // Génération de la grille Heatmap style GitHub et des données chronologiques Chart.js
  const heatMapDays = [];
  const chartLabels = [];
  const chartDoneData = [];
  const chartFailedData = [];

  const dayLogs = db.prepare(`SELECT * FROM day_logs WHERE date >= ? AND date <= ?`).all(startDateStr, endDateStr);
  const dayLogsMap = {};
  dayLogs.forEach(dl => { dayLogsMap[dl.date] = dl; });

  const curr = new Date(startDate);
  while (curr <= endDate) {
    const dStr = curr.toISOString().split('T')[0];
    const log = dayLogsMap[dStr];

    let dayStatus = 'EMPTY'; // 'SUCCESS', 'FAILED', 'REST', 'EMPTY'
    if (log) {
      dayStatus = log.status;
    }

    heatMapDays.push({
      date: dStr,
      status: dayStatus,
      done: log ? log.exercises_done : 0,
      total: log ? log.exercises_total : 0
    });

    chartLabels.push(dStr.slice(5)); // 'MM-DD'
    
    // Obtenir le nombre de faites et échouées pour ce jour précis
    const dayHist = db.prepare(`
      SELECT 
        SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as d,
        SUM(CASE WHEN status IN ('FAILED', 'SKIPPED') THEN 1 ELSE 0 END) as f
      FROM historique WHERE date = ?
    `).get(dStr);

    chartDoneData.push(dayHist ? (dayHist.d || 0) : 0);
    chartFailedData.push(dayHist ? (dayHist.f || 0) : 0);

    curr.setDate(curr.getDate() + 1);
  }

  const streak = calculateStreakInfo();

  return {
    totalExercises: total,
    doneCount: done,
    failedCount: failed,
    skippedCount: skipped,
    successRate,
    totalWorkoutTimeMin: Math.round(totalDurationSec / 60),
    totalWorkoutSessions: totalSessions,
    avgSessionMin,
    currentStreak: streak.currentStreak,
    bestStreak: streak.bestStreak,
    byExercise,
    byDayOfWeek,
    heatMapDays,
    chartData: {
      labels: chartLabels,
      done: chartDoneData,
      failed: chartFailedData
    }
  };
}

// --- LOGS SYSTEME ---
function addLog(message, level = 'INFO') {
  try {
    db.prepare('INSERT INTO logs (message, level) VALUES (?, ?)').run(message, level);
  } catch (err) {
    console.error('Erreur lors de l ajout de log :', err);
  }
}

function getRecentLogs(limit = 100) {
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
}

// --- PURGE ET SAUVEGARDE AUTOMATIQUE ---
function cleanOldData(days = 45) {
  const purgeDateStr = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const purgedHist = db.prepare('DELETE FROM historique WHERE date < ?').run(purgeDateStr);
  const purgedLogs = db.prepare('DELETE FROM day_logs WHERE date < ?').run(purgeDateStr);
  const purgedSysLogs = db.prepare("DELETE FROM logs WHERE timestamp < datetime('now', '-45 days')").run();

  addLog(`Auto-purge DB (> ${days} jours) : ${purgedHist.changes} historiques et ${purgedLogs.changes} day_logs supprimés.`, 'INFO');

  // Nettoyage des anciens fichiers de sauvegarde dans /backups/
  const backupsDir = path.join(__dirname, '..', 'backups');
  if (fs.existsSync(backupsDir)) {
    const files = fs.readdirSync(backupsDir);
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(backupsDir, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > days * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
        addLog(`Ancien backup supprimé : ${file}`, 'INFO');
      }
    });
  }
}

function autoBackupDatabase() {
  const backupsDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `sport_ds_backup_${timestamp}.db`;
  const backupPath = path.join(backupsDir, backupFileName);

  try {
    db.backup(backupPath);
    addLog(`Sauvegarde automatique créée : ${backupFileName}`, 'INFO');
    return backupFileName;
  } catch (err) {
    addLog(`Échec de la sauvegarde automatique : ${err.message}`, 'ERROR');
    return null;
  }
}

module.exports = {
  db,
  getParam,
  setParam,
  getActiveProgramId,
  setActiveProgramId,
  getAllProgrammes,
  getProgrammeById,
  createProgramme,
  deleteProgramme,
  getExercisesByProgramme,
  getExercisesByProgrammeAndDay,
  addExercise,
  updateExercise,
  deleteExercise,
  reorderExercises,
  copyExercise,
  copyDay,
  getCalculatedTarget,
  recordExerciseHistory,
  getTodayHistory,
  closeDayAndCalculateStreak,
  calculateStreakInfo,
  getStats,
  addLog,
  getRecentLogs,
  cleanOldData,
  autoBackupDatabase
};
