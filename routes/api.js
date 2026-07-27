const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database/database');
const { sendDailyProgram } = require('../discord/bot');
const { broadcast } = require('../websocket/wsServer');
const { getTodayString, getDayOfWeekIndex } = require('../discord/scheduler');

// Configuration de multer pour l'import de base de données
const upload = multer({ dest: path.join(__dirname, '../temp_uploads/') });

// --- PROGRAMMES ---
router.get('/programmes', (req, res) => {
  try {
    const progs = db.getAllProgrammes();
    const activeId = db.getActiveProgramId();
    res.json({ success: true, activeProgramId: activeId, programmes: progs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/programmes', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Le nom du programme est requis.' });
    }
    const newId = db.createProgramme(name.trim());
    broadcast('PROGRAM_CHANGED', { action: 'create', id: newId });
    res.json({ success: true, id: newId, message: 'Programme créé avec succès.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/programmes/:id/activate', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const prog = db.getProgrammeById(id);
    if (!prog) {
      return res.status(404).json({ success: false, error: 'Programme introuvable.' });
    }
    db.setActiveProgramId(id);
    broadcast('PROGRAM_CHANGED', { action: 'activate', activeProgramId: id });
    res.json({ success: true, message: `Programme "${prog.name}" activé avec succès.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/programmes/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Le nom est requis.' });
    }
    db.db.prepare('UPDATE programmes SET name = ? WHERE id = ?').run(name.trim(), id);
    broadcast('PROGRAM_CHANGED', { action: 'update', id });
    res.json({ success: true, message: 'Programme renommé avec succès.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/programmes/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.deleteProgramme(id);
    broadcast('PROGRAM_CHANGED', { action: 'delete', id });
    res.json({ success: true, message: 'Programme supprimé.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- EXERCICES ---
router.get('/programmes/:id/exercices', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const exercises = db.getExercisesByProgramme(id);
    res.json({ success: true, exercices: exercises });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/exercices', (req, res) => {
  try {
    const { programme_id, day_of_week, name } = req.body;
    if (!programme_id || !day_of_week || !name) {
      return res.status(400).json({ success: false, error: 'Champs requis manquants (programme_id, day_of_week, name).' });
    }
    const newId = db.addExercise(req.body);
    broadcast('EXERCISE_LIST_CHANGED', { programme_id, day_of_week });
    res.json({ success: true, id: newId, message: 'Exercice ajouté.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/exercices/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.updateExercise(id, req.body);
    broadcast('EXERCISE_LIST_CHANGED', { id });
    res.json({ success: true, message: 'Exercice mis à jour.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/exercices/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.deleteExercise(id);
    broadcast('EXERCISE_LIST_CHANGED', { id });
    res.json({ success: true, message: 'Exercice supprimé.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/exercices/reorder', (req, res) => {
  try {
    const { programme_id, day_of_week, orderedIds } = req.body;
    if (!programme_id || !day_of_week || !Array.isArray(orderedIds)) {
      return res.status(400).json({ success: false, error: 'Paramètres d ordre invalides.' });
    }
    db.reorderExercises(programme_id, day_of_week, orderedIds);
    broadcast('EXERCISE_LIST_CHANGED', { programme_id, day_of_week });
    res.json({ success: true, message: 'Ordre mis à jour.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/exercices/copy-exercise', (req, res) => {
  try {
    const { exerciseId, targetDayOfWeek } = req.body;
    if (!exerciseId || !targetDayOfWeek) {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }
    const newId = db.copyExercise(exerciseId, targetDayOfWeek);
    broadcast('EXERCISE_LIST_CHANGED', { targetDayOfWeek });
    res.json({ success: true, id: newId, message: 'Exercice copié.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/exercices/copy-day', (req, res) => {
  try {
    const { programmeId, sourceDayOfWeek, targetDayOfWeek } = req.body;
    if (!programmeId || !sourceDayOfWeek || !targetDayOfWeek) {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }
    db.copyDay(programmeId, sourceDayOfWeek, targetDayOfWeek);
    broadcast('EXERCISE_LIST_CHANGED', { programmeId, targetDayOfWeek });
    res.json({ success: true, message: `Journée ${sourceDayOfWeek} copiée vers Journée ${targetDayOfWeek}.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- STATISTIQUES ---
router.get('/stats', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const stats = db.getStats(days);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- LOGS ---
router.get('/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const logs = db.getRecentLogs(limit);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/logs', (req, res) => {
  try {
    db.db.prepare('DELETE FROM logs').run();
    db.addLog('Journaux système réinitialisés.', 'INFO');
    res.json({ success: true, message: 'Logs effacés.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- SAUVEGARDE EXPORT / IMPORT ---
router.get('/backup/export', (req, res) => {
  try {
    const dbPath = db.db.name;
    if (fs.existsSync(dbPath)) {
      const fileName = `sport_ds_backup_${new Date().toISOString().split('T')[0]}.db`;
      res.download(dbPath, fileName);
    } else {
      res.status(404).json({ success: false, error: 'Fichier de base SQLite introuvable.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/backup/import', upload.single('database'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Aucun fichier fourni.' });
    }

    const tempFilePath = req.file.path;
    const targetDbPath = db.db.name;

    // Fermer temporairement la base ou copier le fichier de manière sécurisée
    try {
      db.db.close();
    } catch (e) {
      // Ignorer si déjà fermée
    }

    fs.copyFileSync(tempFilePath, targetDbPath);
    fs.unlinkSync(tempFilePath); // Supprimer le fichier temporaire

    // Réouvrir la base de données SQLite
    db.db = new (require('better-sqlite3'))(targetDbPath);
    db.db.pragma('foreign_keys = ON');

    db.addLog('Base de données SQLite restaurée avec succès depuis un fichier d import.', 'INFO');
    broadcast('DATABASE_RESTORED', {});

    res.json({ success: true, message: 'Sauvegarde restaurée avec succès. L interface a été mise à jour.' });
  } catch (err) {
    res.status(500).json({ success: false, error: `Erreur d import : ${err.message}` });
  }
});

router.get('/backups/list', (req, res) => {
  try {
    const backupsDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupsDir)) {
      return res.json({ success: true, backups: [] });
    }
    const files = fs.readdirSync(backupsDir).map(file => {
      const stats = fs.statSync(path.join(backupsDir, file));
      return {
        name: file,
        sizeBytes: stats.size,
        createdAt: stats.mtime
      };
    }).sort((a, b) => b.createdAt - a.createdAt);

    res.json({ success: true, backups: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/database/reset', (req, res) => {
  try {
    db.resetDatabase();
    broadcast('DATABASE_RESTORED', {});
    res.json({ success: true, message: 'La base de données SQLite a été réinitialisée avec succès.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ACTION MANUELLE DISCORD ---
router.post('/discord/send-today', async (req, res) => {
  try {
    const channelId = process.env.DISCORD_CHANNEL_ID;
    const activeProgId = db.getActiveProgramId();
    const dateStr = getTodayString();
    const dayOfWeek = getDayOfWeekIndex();

    if (!channelId || channelId.includes('votre_channel')) {
      return res.status(400).json({ success: false, error: 'DISCORD_CHANNEL_ID non configuré dans le fichier .env.' });
    }
    if (!activeProgId) {
      return res.status(400).json({ success: false, error: 'Aucun programme actif configuré.' });
    }

    const result = await sendDailyProgram(channelId, activeProgId, dayOfWeek, dateStr);
    if (result && result.success) {
      res.json({ success: true, message: 'Message du programme envoyé avec succès sur Discord !' });
    } else {
      const errorMsg = (result && result.error) ? result.error : 'Échec d envoi du message Discord.';
      res.status(400).json({ success: false, error: errorMsg });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
