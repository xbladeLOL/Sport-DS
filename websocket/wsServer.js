const { WebSocketServer, WebSocket } = require('ws');
const { addLog } = require('../database/database');

let wss = null;

function initWebSocketServer(server) {
  wss = new WebSocketServer({ server });

  // Heartbeat interval (30s) pour éviter la déconnexion des navigateurs après plusieurs heures
  const heartbeatInterval = setInterval(() => {
    if (!wss) return;

    wss.clients.forEach(ws => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;

    // Réponse au Pong du client
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'ping') {
          ws.isAlive = true;
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (e) {
        // Message non JSON ignoré
      }
    });

    ws.on('error', (err) => {
      console.error('Erreur WebSocket client :', err.message);
    });

    // Envoyer un message de bienvenue initial
    ws.send(JSON.stringify({
      type: 'CONNECTED',
      message: 'Connexion WebSocket établie avec succès avec le serveur Sport+DS'
    }));
  });

  addLog('Serveur WebSocket temps réel initialisé avec support Heartbeat (Ping/Pong).', 'INFO');
  return wss;
}

// Fonction de diffusion globale à tous les clients connectés
function broadcast(eventType, payload = {}) {
  if (!wss) return;

  const data = JSON.stringify({
    type: eventType,
    payload,
    timestamp: new Date().toISOString()
  });

  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

module.exports = {
  initWebSocketServer,
  broadcast
};
