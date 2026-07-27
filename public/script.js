/* ==========================================================================
   Sport+DS — Frontend JavaScript Application
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // --- ETAT GLOBAL ---
  let ws = null;
  let wsRetryDelay = 2000;
  let activeTab = 'tab-dashboard';
  let activeProgrammeId = null;
  let currentPlannerDay = 1; // 1 = Lundi
  let currentDashboardDays = 30;
  let currentStatsDays = 30;

  // Chart.js Instances
  let overviewChartInstance = null;
  let donutChartInstance = null;
  let lineChartInstance = null;

  // --- INITIALISATION ---
  initNavigationTabs();
  initWebSocket();
  loadInitialData();
  initEventHandlers();

  // ==================== WEBSOCKETTemps Réel avec Auto-Reconnect & Ping/Pong ====================
  function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;

    updateWsIndicator(false, 'Connexion...');
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsRetryDelay = 2000;
      updateWsIndicator(true, 'Temps réel actif');
      console.log('[WebSocket] Connecté au serveur.');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Ping / Pong Heartbeat
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (data.type === 'CONNECTED') {
          console.log('[WebSocket]', data.message);
          return;
        }

        // Evénements temps réel reçus depuis le serveur/Discord
        console.log(`[WebSocket Event] ${data.type}`, data.payload);

        switch (data.type) {
          case 'EXERCISE_UPDATED':
            showToast(`Exercice "${data.payload.exerciseName}" marqué ${data.payload.status}`, 'info');
            refreshCurrentTab();
            break;

          case 'PROGRESS_UPDATED':
            if (activeTab === 'tab-dashboard') loadDashboardData();
            break;

          case 'SESSION_STARTED':
            showToast('Séance de sport démarrée !', 'success');
            updateSessionUI(data.payload.session);
            refreshCurrentTab();
            break;

          case 'SESSION_PAUSED':
            showToast('Séance de sport en pause.', 'info');
            updateSessionUI(data.payload.session);
            break;

          case 'SESSION_RESUMED':
            showToast('Séance de sport reprise.', 'info');
            updateSessionUI(data.payload.session);
            break;

          case 'SESSION_ENDED':
            showToast(`Séance terminée (${Math.round((data.payload.session.duration_sec || 0) / 60)} min)`, 'success');
            updateSessionUI(data.payload.session);
            refreshCurrentTab();
            break;

          case 'PROGRAM_CHANGED':
          case 'EXERCISE_LIST_CHANGED':
            refreshCurrentTab();
            break;

          case 'STREAK_UPDATED':
            loadHeaderStreaks();
            refreshCurrentTab();
            break;

          case 'STATS_UPDATED':
            if (activeTab === 'tab-dashboard' || activeTab === 'tab-stats') {
              refreshCurrentTab();
            }
            break;

          case 'LOG_ADDED':
            appendLogToConsole(data.payload);
            break;

          case 'DATABASE_RESET':
          case 'DATABASE_RESTORED':
            showToast('Base de données réinitialisée / restaurée.', 'success');
            loadInitialData();
            break;
        }
      } catch (e) {
        console.error('Erreur parsing WebSocket :', e);
      }
    };

    ws.onerror = (err) => {
      console.error('[WebSocket Error]', err);
    };

    ws.onclose = () => {
      updateWsIndicator(false, 'Déconnecté');
      console.warn(`[WebSocket] Déconnecté. Nouvelle tentative dans ${wsRetryDelay / 1000}s...`);
      setTimeout(initWebSocket, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 1.5, 30000); // Backoff exponentiel max 30s
    };
  }

  function updateWsIndicator(online, text) {
    const ind = document.getElementById('ws-indicator');
    const txt = document.getElementById('ws-status-text');
    if (online) {
      ind.className = 'ws-status-indicator online';
    } else {
      ind.className = 'ws-status-indicator offline';
    }
    txt.textContent = text;
  }

  // ==================== GESTION DES ONGLETS ====================
  function initNavigationTabs() {
    const buttons = document.querySelectorAll('.nav-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetBtn = e.currentTarget;
        const targetTab = targetBtn.getAttribute('data-tab');
        const targetPane = document.getElementById(targetTab);

        if (!targetPane) return;

        buttons.forEach(b => b.classList.remove('active'));
        targetBtn.classList.add('active');

        document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
        targetPane.classList.add('active');

        activeTab = targetTab;
        refreshCurrentTab();
      });
    });
  }

  function refreshCurrentTab() {
    loadHeaderStreaks();
    if (activeTab === 'tab-dashboard') {
      loadDashboardData();
    } else if (activeTab === 'tab-planner') {
      loadPlannerData();
    } else if (activeTab === 'tab-stats') {
      loadStatsTabData();
    } else if (activeTab === 'tab-settings') {
      loadSettingsTabData();
    }
  }

  function loadInitialData() {
    loadHeaderStreaks();
    loadTodaySession();
    loadDashboardData();
    loadProgrammesList();
  }

  // ==================== HEADER STREAKS ====================
  async function loadHeaderStreaks() {
    try {
      const res = await fetch('/api/stats?days=1');
      const data = await res.json();
      if (data.success) {
        document.getElementById('val-current-streak').textContent = data.stats.currentStreak;
        document.getElementById('val-best-streak').textContent = data.stats.bestStreak;
        document.getElementById('kpi-streak-val').textContent = `${data.stats.currentStreak} jours`;
        document.getElementById('kpi-best-streak-sub').textContent = `Record: ${data.stats.bestStreak} jours`;
      }
    } catch (e) {
      console.error('Erreur chargement streaks :', e);
    }
  }

  // ==================== ONGLET 1: TABLEAU DE BORD ====================
  async function loadDashboardData() {
    try {
      const res = await fetch(`/api/stats?days=${currentDashboardDays}`);
      const data = await res.json();

      if (!data.success) return;
      const s = data.stats;

      // Nom du programme actif
      const progRes = await fetch('/api/programmes');
      const progData = await progRes.json();
      const activeProg = progData.programmes.find(p => p.is_active);
      document.getElementById('dash-active-prog-name').textContent = activeProg ? activeProg.name : 'Aucun';

      // Cartes KPI
      document.getElementById('kpi-done-count').textContent = s.doneCount;
      document.getElementById('kpi-success-rate').textContent = `${s.successRate}% de réussite`;
      document.getElementById('kpi-workout-time').textContent = `${s.totalWorkoutTimeMin} min`;
      document.getElementById('kpi-avg-session').textContent = `Moy. ${s.avgSessionMin} min / séance`;
      document.getElementById('kpi-sessions-count').textContent = s.totalWorkoutSessions;
      document.getElementById('kpi-total-ex-sub').textContent = `${s.totalExercises} exercices totaux`;

      // Rendu du Calendrier GitHub Heatmap Grid
      renderGitHubHeatmap(s.heatMapDays);

      // Rendu du Graphique Aperçu Quotidien Chart.js
      renderOverviewChart(s.chartData);
    } catch (e) {
      console.error('Erreur chargement dashboard :', e);
    }
  }

  // RENDU DE LA GRILLE STYLE GITHUB HEATMAP
  function renderGitHubHeatmap(days) {
    const container = document.getElementById('github-heatmap-grid');
    container.innerHTML = '';

    if (!days || days.length === 0) {
      container.innerHTML = '<span class="section-desc">Aucune donnée sur cette période</span>';
      return;
    }

    days.forEach(day => {
      const tile = document.createElement('div');
      tile.className = 'heatmap-tile';

      const shortDay = day.date.slice(8); // 'DD'
      tile.textContent = shortDay;

      if (day.status === 'SUCCESS' || day.done > 0) {
        tile.classList.add('tile-success');
        tile.title = `${day.date} : Exercices réalisés (${day.done}/${day.total || day.done})`;
      } else if (day.status === 'REST') {
        tile.classList.add('tile-rest');
        tile.title = `${day.date} : Jour de repos validé (Streak continue)`;
      } else if (day.status === 'FAILED') {
        tile.classList.add('tile-failed');
        tile.title = `${day.date} : Échec / Manqué (${day.done}/${day.total} exercices)`;
      } else {
        tile.classList.add('tile-empty');
        tile.title = `${day.date} : Sans exercices`;
      }

      container.appendChild(tile);
    });
  }

  // OVERVIEW CHART (CHART.JS)
  function renderOverviewChart(chartData) {
    const ctx = document.getElementById('overviewChart').getContext('2d');

    if (overviewChartInstance) {
      overviewChartInstance.destroy();
    }

    overviewChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: chartData.labels,
        datasets: [
          {
            label: 'Exercices Validés (Fait)',
            data: chartData.done,
            backgroundColor: '#10b981',
            borderRadius: 4
          },
          {
            label: 'Échecs / Non faits',
            data: chartData.failed,
            backgroundColor: '#ef4444',
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#94a3b8' } }
        },
        scales: {
          x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: {
            min: 0,
            beginAtZero: true,
            ticks: { color: '#64748b', stepSize: 1, precision: 0 },
            grid: { color: 'rgba(255,255,255,0.05)' }
          }
        }
      }
    });
  }

  // ==================== ONGLET 2: PLANIFICATEUR HEBDOMADAIRE ====================
  async function loadProgrammesList() {
    try {
      const res = await fetch('/api/programmes');
      const data = await res.json();
      if (!data.success) return;

      const select = document.getElementById('prog-select');
      select.innerHTML = '';

      data.programmes.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (p.is_active ? ' ★ (Actif)' : '');
        select.appendChild(opt);
      });

      activeProgrammeId = data.activeProgramId;
      if (activeProgrammeId) {
        select.value = activeProgrammeId;
      } else if (data.programmes.length > 0) {
        activeProgrammeId = data.programmes[0].id;
        select.value = activeProgrammeId;
      }

      loadPlannerData();
    } catch (e) {
      console.error('Erreur chargement programmes :', e);
    }
  }

  async function loadPlannerData() {
    const selectedProgId = parseInt(document.getElementById('prog-select').value, 10);
    if (!selectedProgId) return;

    try {
      const res = await fetch(`/api/programmes/${selectedProgId}/exercices`);
      const data = await res.json();
      if (!data.success) return;

      const dayExercises = data.exercices.filter(ex => ex.day_of_week === currentPlannerDay);
      renderExerciseCardsList(dayExercises);
    } catch (e) {
      console.error('Erreur chargement exercices planner :', e);
    }
  }

  // RENDU DES CARTES D'EXERCICES AVEC DRAG & DROP
  function renderExerciseCardsList(exercises) {
    const container = document.getElementById('exercise-list-container');
    container.innerHTML = '';

    const dayNames = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    document.getElementById('current-day-title').textContent = `🏋️ Exercices du ${dayNames[currentPlannerDay]}`;

    if (exercises.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <p>Aucun exercice prévu pour le ${dayNames[currentPlannerDay]}.</p>
          <p class="section-desc">Cliquez sur "Ajouter un exercice" pour commencer.</p>
        </div>
      `;
      return;
    }

    exercises.forEach((ex, index) => {
      const card = document.createElement('div');
      card.className = 'exercise-item-card';
      card.draggable = true;
      card.setAttribute('data-id', ex.id);
      const isStatic = !!ex.is_static;
      let progPill = '';
      if (ex.increment_reps_per_week > 0 || ex.increment_weight_per_week > 0 || ex.increment_hold_time_per_week > 0) {
        const interval = ex.increment_interval_weeks || 1;
        const intervalLabels = { 1: 'sem', 2: '2 sem', 3: '3 sem', 4: 'mois' };
        const unitLabel = intervalLabels[interval] || `${interval} sem`;

        const parts = [];
        if (isStatic && ex.increment_hold_time_per_week > 0) parts.push(`+${ex.increment_hold_time_per_week}s / ${unitLabel}`);
        if (!isStatic && ex.increment_reps_per_week > 0) parts.push(`+${ex.increment_reps_per_week} rep / ${unitLabel}`);
        if (ex.increment_weight_per_week > 0) parts.push(`+${ex.increment_weight_per_week} kg / ${unitLabel}`);
        progPill = `<span class="pill progression">📈 ${parts.join(' | ')}</span>`;
      }

      const countPill = isStatic ? `<span class="pill">⏱️ ${ex.hold_time_sec || 0}s maintien</span>` : `<span class="pill">${ex.reps} reps</span>`;

      card.innerHTML = `
        <div class="ex-left">
          <span class="drag-handle" title="Glisser pour réordonner">☰</span>
          <div class="ex-info">
            <h4>${index + 1}. ${ex.name} ${isStatic ? '<span class="pill" style="font-size:0.75rem; background:rgba(6,182,212,0.15); color:#06b6d4;">Statique</span>' : ''}</h4>
            <div class="ex-details-pills">
              <span class="pill">${ex.sets} séries</span>
              ${countPill}
              ${ex.weight_kg > 0 ? `<span class="pill">${ex.weight_kg} kg</span>` : ''}
              ${ex.duration_sec > 0 ? `<span class="pill">${ex.duration_sec}s repos</span>` : ''}
              ${progPill}
            </div>
            ${ex.comments ? `<p class="ex-comments-text">💬 ${ex.comments}</p>` : ''}
          </div>
        </div>

        <div class="ex-actions">
          <button class="btn btn-secondary btn-sm btn-edit-ex" data-id="${ex.id}" title="Éditer">✏️</button>
          <button class="btn btn-secondary btn-sm btn-copy-ex" data-id="${ex.id}" title="Copier sur un autre jour">📋</button>
          <button class="btn btn-danger-ghost btn-sm btn-delete-ex" data-id="${ex.id}" title="Supprimer">🗑️</button>
        </div>
      `;

      // Evénements Drag & Drop HTML5
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragover', handleDragOver);
      card.addEventListener('drop', handleDrop);
      card.addEventListener('dragend', handleDragEnd);

      container.appendChild(card);
    });

    // Attacher les écouteurs de boutons des cartes
    attachExerciseCardActions(exercises);
  }

  // LOGIQUE DE DRAG & DROP NATIF
  let draggedCard = null;

  function handleDragStart(e) {
    draggedCard = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
  }

  function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    if (draggedCard !== this) {
      const container = document.getElementById('exercise-list-container');
      const cards = Array.from(container.querySelectorAll('.exercise-item-card'));
      const draggedIdx = cards.indexOf(draggedCard);
      const targetIdx = cards.indexOf(this);

      if (draggedIdx < targetIdx) {
        this.after(draggedCard);
      } else {
        this.before(draggedCard);
      }

      saveReorderedExercises();
    }
    return false;
  }

  function handleDragEnd() {
    this.classList.remove('dragging');
  }

  async function saveReorderedExercises() {
    const container = document.getElementById('exercise-list-container');
    const cards = container.querySelectorAll('.exercise-item-card');
    const orderedIds = Array.from(cards).map(c => parseInt(c.getAttribute('data-id'), 10));

    const selectedProgId = parseInt(document.getElementById('prog-select').value, 10);

    try {
      await fetch('/api/exercices/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programme_id: selectedProgId,
          day_of_week: currentPlannerDay,
          orderedIds
        })
      });
      showToast('Nouvel ordre enregistré.', 'success');
    } catch (e) {
      console.error('Erreur réordonnancement :', e);
    }
  }

  function attachExerciseCardActions(exercises) {
    document.querySelectorAll('.btn-edit-ex').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        const ex = exercises.find(x => x.id === id);
        if (ex) openExerciseModal(ex);
      });
    });

    document.querySelectorAll('.btn-delete-ex').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        if (confirm('Voulez-vous vraiment supprimer cet exercice ?')) {
          await fetch(`/api/exercices/${id}`, { method: 'DELETE' });
          showToast('Exercice supprimé.', 'info');
          loadPlannerData();
        }
      });
    });

    document.querySelectorAll('.btn-copy-ex').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        const targetDay = prompt('Copier cet exercice vers quel jour ? (1=Lundi, 2=Mardi, ..., 7=Dimanche)', '2');
        if (targetDay && !isNaN(targetDay)) {
          await fetch('/api/exercices/copy-exercise', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exerciseId: id, targetDayOfWeek: parseInt(targetDay, 10) })
          });
          showToast(`Exercice copié vers le jour ${targetDay}.`, 'success');
        }
      });
    });
  }

  // ==================== ONGLET 3: STATISTIQUES & HEATMAP ====================
  async function loadStatsTabData() {
    try {
      const res = await fetch(`/api/stats?days=${currentStatsDays}`);
      const data = await res.json();
      if (!data.success) return;

      const s = data.stats;

      // Donut Chart (Fait vs Échec vs Non Fait)
      renderDonutChart(s.doneCount, s.failedCount, s.skippedCount);

      // Line Chart (Taux d'évolution)
      renderLineChart(s.chartData);

      // Tableau de réussite par exercice
      const exTable = document.getElementById('table-ex-breakdown');
      exTable.innerHTML = '';
      if (s.byExercise.length === 0) {
        exTable.innerHTML = '<tr><td colspan="4">Aucun historique disponible</td></tr>';
      } else {
        s.byExercise.forEach(ex => {
          const row = document.createElement('tr');
          row.innerHTML = `
            <td><strong>${ex.name}</strong></td>
            <td>${ex.done}</td>
            <td>${ex.total}</td>
            <td>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span>${ex.rate}%</span>
                <div class="progress-inline-bar" style="width: ${ex.rate}%;"></div>
              </div>
            </td>
          `;
          exTable.appendChild(row);
        });
      }

      // Tableau de réussite par jour
      const dayTable = document.getElementById('table-day-breakdown');
      dayTable.innerHTML = '';
      s.byDayOfWeek.forEach(d => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${d.dayName}</td>
          <td>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>${d.rate}%</span>
              <div class="progress-inline-bar" style="width: ${d.rate}%;"></div>
            </div>
          </td>
        `;
        dayTable.appendChild(row);
      });
    } catch (e) {
      console.error('Erreur chargement onglet stats :', e);
    }
  }

  function renderDonutChart(done, failed, skipped) {
    const ctx = document.getElementById('donutChart').getContext('2d');
    if (donutChartInstance) donutChartInstance.destroy();

    donutChartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Validés (Fait)', 'Échecs', 'Non faits'],
        datasets: [{
          data: [done, failed, skipped],
          backgroundColor: ['#10b981', '#ef4444', '#64748b'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#94a3b8' } }
        }
      }
    });
  }

  function renderLineChart(chartData) {
    const ctx = document.getElementById('lineChart').getContext('2d');
    if (lineChartInstance) lineChartInstance.destroy();

    lineChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: chartData.labels,
        datasets: [{
          label: 'Exercices Réussis',
          data: chartData.done,
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.1)',
          fill: true,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: {
            min: 0,
            beginAtZero: true,
            ticks: { color: '#64748b', precision: 0 },
            grid: { color: 'rgba(255,255,255,0.05)' }
          }
        }
      }
    });
  }

  // ==================== ONGLET 4: SETTINGS & LOGS ====================
  async function loadSettingsTabData() {
    loadLogsConsole();
    loadBackupsList();
  }

  async function loadLogsConsole() {
    try {
      const res = await fetch('/api/logs?limit=100');
      const data = await res.json();
      if (!data.success) return;

      const consoleWin = document.getElementById('logs-console-window');
      consoleWin.innerHTML = '';
      data.logs.forEach(appendLogToConsole);
      consoleWin.scrollTop = consoleWin.scrollHeight;
    } catch (e) {
      console.error('Erreur chargement logs :', e);
    }
  }

  function appendLogToConsole(log) {
    const consoleWin = document.getElementById('logs-console-window');
    const line = document.createElement('div');
    line.className = `log-entry ${log.level || 'INFO'}`;
    const timeStr = log.timestamp ? log.timestamp.split('T')[1]?.slice(0, 8) || '' : '';
    line.innerHTML = `<span class="log-time">[${timeStr}]</span> ${log.message}`;
    consoleWin.appendChild(line);
    consoleWin.scrollTop = consoleWin.scrollHeight;
  }

  async function loadBackupsList() {
    try {
      const res = await fetch('/api/backups/list');
      const data = await res.json();
      if (!data.success) return;

      const list = document.getElementById('backups-file-list');
      list.innerHTML = '';
      if (data.backups.length === 0) {
        list.innerHTML = '<li class="section-desc">Aucune sauvegarde automatique récente.</li>';
        return;
      }

      data.backups.forEach(b => {
        const li = document.createElement('li');
        const dateStr = new Date(b.createdAt).toLocaleString('fr-FR');
        const sizeKb = Math.round(b.sizeBytes / 1024);
        li.innerHTML = `
          <span>📄 <strong>${b.name}</strong> (${sizeKb} KB)</span>
          <span style="color: var(--text-dim);">${dateStr}</span>
        `;
        list.appendChild(li);
      });
    } catch (e) {
      console.error('Erreur liste backups :', e);
    }
  }

  // ==================== GESTION DE SEANCE ET CHRONOMETRE ====================
  let sessionTimerInterval = null;
  let currentSessionState = null;

  async function loadTodaySession() {
    try {
      const res = await fetch('/api/session/today');
      const data = await res.json();
      if (data.success && data.session) {
        updateSessionUI(data.session);
      }
    } catch (e) {
      console.error('Erreur chargement séance du jour :', e);
    }
  }

  function updateSessionUI(session) {
    currentSessionState = session;
    const state = session ? session.session_state : 'IDLE';

    const badge = document.getElementById('session-badge-status');
    if (!badge) return;

    if (state === 'IDLE') {
      badge.textContent = '▶️ Non démarrée';
      badge.className = 'session-status-badge badge-neutral';
      stopSessionTimer();
      formatTimerClock(0);
    } else if (state === 'ACTIVE') {
      badge.textContent = '⏱️ Séance en cours';
      badge.className = 'session-status-badge badge-success';
      startSessionTimer();
    } else if (state === 'PAUSED') {
      badge.textContent = '⏸️ Séance en pause';
      badge.className = 'session-status-badge badge-warning';
      stopSessionTimer();
      formatTimerClock(session.duration_sec || 0);
    } else if (state === 'ENDED') {
      const mins = Math.round((session.duration_sec || 0) / 60);
      badge.textContent = `🏁 Terminée (${mins} min)`;
      badge.className = 'session-status-badge badge-info';
      stopSessionTimer();
      formatTimerClock(session.duration_sec || 0);
    }
  }

  function startSessionTimer() {
    stopSessionTimer();
    tickSessionTimer();
    sessionTimerInterval = setInterval(tickSessionTimer, 1000);
  }

  function stopSessionTimer() {
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
    }
  }

  function tickSessionTimer() {
    if (!currentSessionState || currentSessionState.session_state !== 'ACTIVE' || !currentSessionState.start_time) {
      return;
    }
    const nowMs = Date.now();
    const startMs = new Date(currentSessionState.start_time).getTime();
    const elapsedSec = Math.max(0, Math.floor((nowMs - startMs) / 1000) - (currentSessionState.accumulated_pause_sec || 0));
    formatTimerClock(elapsedSec);
  }

  function formatTimerClock(totalSeconds) {
    const clockEl = document.getElementById('session-timer-clock');
    if (!clockEl) return;

    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    const hh = String(hrs).padStart(2, '0');
    const mm = String(mins).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');

    clockEl.textContent = `${hh}:${mm}:${ss}`;
  }

  // ==================== EVENEMENTS INTERFACIAUX & MODALES ====================
  function initEventHandlers() {
    // Boutons de période Dashboard Heatmap
    document.querySelectorAll('#heatmap-period-buttons .period-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('#heatmap-period-buttons .period-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentDashboardDays = parseInt(e.target.getAttribute('data-days'), 10);
        document.getElementById('dash-chart-period-tag').textContent = `${currentDashboardDays} Derniers Jours`;
        loadDashboardData();
      });
    });

    // Boutons de période Onglet Stats
    document.querySelectorAll('#stats-period-buttons .period-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('#stats-period-buttons .period-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentStatsDays = parseInt(e.target.getAttribute('data-days'), 10);
        loadStatsTabData();
      });
    });

    // Onglets Jours Planner
    document.querySelectorAll('.day-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.day-tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentPlannerDay = parseInt(e.target.getAttribute('data-day'), 10);
        loadPlannerData();
      });
    });

    // Changement de programme sélectionné
    document.getElementById('prog-select').addEventListener('change', () => {
      loadPlannerData();
    });

    // Définir comme programme actif
    document.getElementById('btn-activate-prog').addEventListener('click', async () => {
      const selectedProgId = parseInt(document.getElementById('prog-select').value, 10);
      if (selectedProgId) {
        await fetch(`/api/programmes/${selectedProgId}/activate`, { method: 'POST' });
        showToast('Programme actif mis à jour !', 'success');
        loadProgrammesList();
      }
    });

    // Trigger Envoi Discord
    document.getElementById('btn-trigger-discord').addEventListener('click', async () => {
      showToast('Envoi du programme sur Discord...', 'info');
      try {
        const res = await fetch('/api/discord/send-today', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Message envoyé sur Discord !', 'success');
        } else {
          showToast(data.error || 'Échec de l envoi Discord', 'error');
        }
      } catch (e) {
        showToast('Erreur serveur lors de l envoi Discord', 'error');
      }
    });

    // Modale Ajouter Exercice
    const exTypeSelect = document.getElementById('ex-type');
    if (exTypeSelect) {
      exTypeSelect.addEventListener('change', toggleExTypeFields);
    }
    document.getElementById('btn-quick-add-ex').addEventListener('click', () => openExerciseModal());
    document.getElementById('btn-add-ex-day').addEventListener('click', () => openExerciseModal());
    document.getElementById('btn-close-ex-modal').addEventListener('click', closeExerciseModal);
    document.getElementById('btn-cancel-ex').addEventListener('click', closeExerciseModal);

    document.getElementById('form-exercise').addEventListener('submit', async (e) => {
      e.preventDefault();
      const exId = document.getElementById('ex-id').value;

      let selectedProgId = parseInt(document.getElementById('prog-select').value, 10);
      if (isNaN(selectedProgId) || !selectedProgId) {
        selectedProgId = activeProgrammeId;
      }

      if (!selectedProgId) {
        showToast('Veuillez d\'abord sélectionner ou créer un programme.', 'error');
        return;
      }

      const isStatic = document.getElementById('ex-type').value === '1';

      const parseNum = (val, isFloat = false) => {
        if (!val) return 0;
        const sanitized = String(val).replace(',', '.');
        const num = isFloat ? parseFloat(sanitized) : parseInt(sanitized, 10);
        return isNaN(num) ? 0 : num;
      };

      const payload = {
        programme_id: selectedProgId,
        day_of_week: currentPlannerDay || 1,
        name: document.getElementById('ex-name').value.trim(),
        description: document.getElementById('ex-desc').value.trim(),
        sets: parseNum(document.getElementById('ex-sets').value) || 1,
        reps: isStatic ? 1 : (parseNum(document.getElementById('ex-reps').value) || 1),
        weight_kg: parseNum(document.getElementById('ex-weight').value, true),
        increment_reps_per_week: isStatic ? 0 : parseNum(document.getElementById('ex-inc-reps').value),
        increment_weight_per_week: parseNum(document.getElementById('ex-inc-weight').value, true),
        increment_interval_weeks: parseNum(document.getElementById('ex-inc-interval').value) || 1,
        duration_sec: parseNum(document.getElementById('ex-duration').value),
        comments: document.getElementById('ex-comments').value.trim(),
        is_static: isStatic ? 1 : 0,
        hold_time_sec: isStatic ? parseNum(document.getElementById('ex-hold').value) : 0,
        target_hold_time_sec: isStatic ? parseNum(document.getElementById('ex-hold').value) : 0,
        increment_hold_time_per_week: isStatic ? parseNum(document.getElementById('ex-inc-hold').value) : 0
      };

      try {
        let res;
        if (exId) {
          res = await fetch(`/api/exercices/${exId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        } else {
          res = await fetch('/api/exercices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        }
        const data = await res.json();
        if (data.success) {
          showToast(exId ? 'Exercice modifié avec succès.' : 'Exercice ajouté avec me succès.', 'success');
          closeExerciseModal();
          loadPlannerData();
        } else {
          showToast(data.error || 'Erreur lors de la sauvegarde de l\'exercice.', 'error');
        }
      } catch (err) {
        showToast('Erreur serveur lors de la sauvegarde de l\'exercice.', 'error');
      }
    });

    // Modale Nouveau Programme
    document.getElementById('btn-new-prog').addEventListener('click', () => {
      document.getElementById('modal-program').classList.add('show');
    });
    document.getElementById('btn-close-prog-modal').addEventListener('click', () => {
      document.getElementById('modal-program').classList.remove('show');
    });
    document.getElementById('btn-cancel-prog').addEventListener('click', () => {
      document.getElementById('modal-program').classList.remove('show');
    });

    document.getElementById('form-program').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('new-prog-name').value;
      if (name) {
        await fetch('/api/programmes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        showToast(`Programme "${name}" créé.`, 'success');
        document.getElementById('modal-program').classList.remove('show');
        loadProgrammesList();
      }
    });

    // Supprimer Programme
    document.getElementById('btn-delete-prog').addEventListener('click', async () => {
      const selectedProgId = parseInt(document.getElementById('prog-select').value, 10);
      if (confirm('Voulez-vous vraiment supprimer ce programme et tous ses exercices ?')) {
        await fetch(`/api/programmes/${selectedProgId}`, { method: 'DELETE' });
        showToast('Programme supprimé.', 'info');
        loadProgrammesList();
      }
    });

    // Modale Copier Journée
    document.getElementById('btn-copy-day').addEventListener('click', () => {
      document.getElementById('modal-copy-day').classList.add('show');
    });
    document.getElementById('btn-close-copy-day-modal').addEventListener('click', () => {
      document.getElementById('modal-copy-day').classList.remove('show');
    });
    document.getElementById('btn-cancel-copy-day').addEventListener('click', () => {
      document.getElementById('modal-copy-day').classList.remove('show');
    });

    document.getElementById('form-copy-day').addEventListener('submit', async (e) => {
      e.preventDefault();
      const selectedProgId = parseInt(document.getElementById('prog-select').value, 10);
      const targetDay = parseInt(document.getElementById('target-day-select').value, 10);

      await fetch('/api/exercices/copy-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programmeId: selectedProgId,
          sourceDayOfWeek: currentPlannerDay,
          targetDayOfWeek: targetDay
        })
      });
      showToast(`Journée copiée vers le jour ${targetDay}.`, 'success');
      document.getElementById('modal-copy-day').classList.remove('show');
    });

    // Formulaire d'importation de base de données
    document.getElementById('form-import-db').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('input-db-file');
      if (!fileInput.files || fileInput.files.length === 0) return;

      const formData = new FormData();
      formData.append('database', fileInput.files[0]);

      showToast('Restauration en cours...', 'info');
      try {
        const res = await fetch('/api/backup/import', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message, 'success');
          loadInitialData();
        } else {
          showToast(data.error || 'Erreur lors de la restauration', 'error');
        }
      } catch (err) {
        showToast('Échec de la restauration de la base de données.', 'error');
      }
    });

    // Effacer les logs
    document.getElementById('btn-clear-logs').addEventListener('click', async () => {
      if (confirm('Effacer le journal d événements ?')) {
        await fetch('/api/logs', { method: 'DELETE' });
        loadLogsConsole();
      }
    });

    // Réinitialiser la base SQLite (Reset usine)
    const btnResetDb = document.getElementById('btn-reset-db');
    if (btnResetDb) {
      btnResetDb.addEventListener('click', async () => {
        if (confirm('⚠️ Êtes-vous sûr de vouloir réinitialiser entièrement la base de données ?\nToutes les données, programmes, exercices et historiques seront effacés !')) {
          showToast('Réinitialisation de la base SQLite...', 'info');
          try {
            const res = await fetch('/api/database/reset', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
              showToast(data.message, 'success');
              loadInitialData();
            } else {
              showToast(data.error || 'Erreur lors de la réinitialisation.', 'error');
            }
          } catch (err) {
            showToast('Échec de la réinitialisation de la base.', 'error');
          }
        }
      });
    }
  }

  // MODALE EXERCICE HELPERS
  function toggleExTypeFields() {
    const isStatic = document.getElementById('ex-type').value === '1';
    document.getElementById('group-ex-reps').style.display = isStatic ? 'none' : 'block';
    document.getElementById('group-ex-hold').style.display = isStatic ? 'block' : 'none';
    document.getElementById('group-ex-inc-reps').style.display = isStatic ? 'none' : 'block';
    document.getElementById('group-ex-inc-hold').style.display = isStatic ? 'block' : 'none';
  }

  function openExerciseModal(ex = null) {
    const modal = document.getElementById('modal-exercise');
    modal.classList.add('show');

    if (ex) {
      document.getElementById('modal-ex-title').textContent = 'Éditer l\'Exercice';
      document.getElementById('ex-id').value = ex.id;
      document.getElementById('ex-name').value = ex.name;
      document.getElementById('ex-desc').value = ex.description || '';
      document.getElementById('ex-type').value = ex.is_static ? '1' : '0';
      document.getElementById('ex-sets').value = ex.sets;
      document.getElementById('ex-reps').value = ex.reps || 12;
      document.getElementById('ex-hold').value = ex.hold_time_sec || 30;
      document.getElementById('ex-weight').value = ex.weight_kg || 0;
      document.getElementById('ex-inc-reps').value = ex.increment_reps_per_week || 0;
      document.getElementById('ex-inc-hold').value = ex.increment_hold_time_per_week || 0;
      document.getElementById('ex-inc-weight').value = ex.increment_weight_per_week || 0;
      document.getElementById('ex-inc-interval').value = ex.increment_interval_weeks || 1;
      document.getElementById('ex-duration').value = ex.duration_sec || 90;
      document.getElementById('ex-comments').value = ex.comments || '';
    } else {
      document.getElementById('modal-ex-title').textContent = 'Ajouter un Exercice';
      document.getElementById('form-exercise').reset();
      document.getElementById('ex-id').value = '';
      document.getElementById('ex-type').value = '0';
      document.getElementById('ex-inc-interval').value = 1;
    }
    toggleExTypeFields();
  }

  function closeExerciseModal() {
    document.getElementById('modal-exercise').classList.remove('show');
  }

  // TOAST NOTIFICATIONS
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
});
