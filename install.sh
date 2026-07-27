#!/bin/bash

# ==============================================================================
# Sport+DS - Script d'installation automatique pour Ubuntu Server
# ==============================================================================

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}   🏋️  Installation de Sport+DS (Discord & Web)     ${NC}"
echo -e "${CYAN}====================================================${NC}"
echo ""

# 1. Vérification / Installation de Node.js & npm
echo -e "${YELLOW}[1/6] Vérification des prérequis système...${NC}"
if ! command -v node &> /dev/null || [ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]; then
    echo -e "${YELLOW}Node.js v18+ non détecté. Installation de Node.js 20 LTS via NodeSource...${NC}"
    sudo apt-get update -y
    sudo apt-get install -y curl build-essential python3
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo -e "${GREEN}✓ Node.js $(node -v) est déjà installé.${NC}"
fi

# Verification de npm
if ! command -v npm &> /dev/null; then
    echo -e "${YELLOW}npm non détecté. Installation de npm...${NC}"
    sudo apt-get install -y npm
else
    echo -e "${GREEN}✓ npm $(npm -v) est déjà installé.${NC}"
fi

# 2. Dossiers de travail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

mkdir -p "$PROJECT_DIR/database"
mkdir -p "$PROJECT_DIR/backups"

# 3. Installation des dépendances npm
echo -e "\n${YELLOW}[2/6] Installation des dépendances NPM...${NC}"
npm install --production

# 4. Configuration interactive du fichier .env
echo -e "\n${YELLOW}[3/6] Configuration du fichier .env...${NC}"

if [ -f "$PROJECT_DIR/.env" ]; then
    echo -e "${YELLOW}Un fichier .env existe déjà.${NC}"
    read -p "Voulez-vous le réécrire ? (o/N): " REWRITE_ENV
    REWRITE_ENV=${REWRITE_ENV:-n}
else
    REWRITE_ENV="o"
fi

if [[ "$REWRITE_ENV" =~ ^[oO]$ ]]; then
    read -p "Entrez votre Token Discord Bot (DISCORD_TOKEN): " DISCORD_TOKEN
    read -p "Entrez l'ID du Salon Discord (DISCORD_CHANNEL_ID): " DISCORD_CHANNEL_ID
    read -p "Entrez le Port du serveur web (Défaut: 3000): " PORT
    PORT=${PORT:-3000}

    cat <<EOF > "$PROJECT_DIR/.env"
PORT=$PORT
DISCORD_TOKEN=$DISCORD_TOKEN
DISCORD_CHANNEL_ID=$DISCORD_CHANNEL_ID
DATABASE_PATH=./database/sport_ds.db
TZ=Europe/Paris
EOF
    echo -e "${GREEN}✓ Fichier .env généré avec succès.${NC}"
fi

# 5. Initialisation de la base SQLite
echo -e "\n${YELLOW}[4/6] Initialisation de la base SQLite...${NC}"
node -e "require('./database/database.js')"
echo -e "${GREEN}✓ Base de données et tables initialisées avec succès.${NC}"

# 6. Création et activation du service systemd
echo -e "\n${YELLOW}[5/6] Configuration du service systemd (sport-ds.service)...${NC}"
SERVICE_FILE="/etc/systemd/system/sport-ds.service"
CURRENT_USER=$(whoami)
NODE_EXEC=$(which node)

sudo bash -c "cat <<EOF > $SERVICE_FILE
[Unit]
Description=Sport+DS - Service de suivi sportif Discord & Web
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_EXEC $PROJECT_DIR/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF"

echo -e "${YELLOW}Activation et démarrage du service systemd...${NC}"
sudo systemctl daemon-reload
sudo systemctl enable sport-ds.service
sudo systemctl restart sport-ds.service

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}  🎉 Installation de Sport+DS terminée avec succès ! ${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "Statut du service : ${CYAN}sudo systemctl status sport-ds.service${NC}"
echo -e "Logs en direct   : ${CYAN}sudo journalctl -u sport-ds.service -f${NC}"
echo -e "Accès Web        : ${CYAN}http://$(hostname -I | awk '{print $1}'):$(grep PORT .env | cut -d= -f2)${NC}"
echo -e "${GREEN}====================================================${NC}"
