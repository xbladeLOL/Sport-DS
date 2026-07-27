require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');

const db = require('./database/database');
const apiRoutes = require('./routes/api');
const { initWebSocketServer } = require('./websocket/wsServer');
const { startDiscordBot } = require('./discord/bot');
const { initScheduler } = require('./discord/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares Express
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routage API REST
app.use('/api', apiRoutes);

// Fallback pour l'application Web mono-page (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware global de gestion d'erreurs
app.use((err, req, res, next) => {
  db.addLog(`Erreur serveur Express : ${err.message}`, 'ERROR');
  console.error('[Server Error]', err);
  res.status(500).json({ success: false, error: 'Une erreur interne du serveur est survenue.' });
});

// Creation du serveur HTTP
const server = http.createServer(app);

// Initialisation des WebSockets
initWebSocketServer(server);

// Initialisation du Bot Discord
startDiscordBot();

// Initialisation du planificateur Cron
initScheduler();

// Démarrage de l'écoute sur le port configuré
server.listen(PORT, () => {
  db.addLog(`Serveur Sport+DS démarré sur le port ${PORT}`, 'INFO');
  console.log(`====================================================`);
  console.log(` 🏋️ Sport+DS - Serveur démarré avec succès !`);
  console.log(` 🌐 Interface Web : http://localhost:${PORT}`);
  console.log(`====================================================`);
});

// Gestion propre de l'arrêt du processus (SIGINT / SIGTERM)
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

function gracefulShutdown() {
  console.log('\n[Shutdown] Arrêt propre du serveur Sport+DS...');
  db.addLog('Arrêt du serveur Sport+DS...', 'WARNING');
  server.close(() => {
    console.log('[Shutdown] Serveur HTTP fermé.');
    db.db.close();
    console.log('[Shutdown] Base de données SQLite fermée.');
    process.exit(0);
  });
}
