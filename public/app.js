(function() {
  'use strict';

  // State
  let bots = [];
  let globalSettings = {};
  let statusPollingInterval = null;
  const POLL_INTERVAL = 4000; // 4 seconds

  // DOM Elements
  const elements = {
    // System metrics
    cpuBar: document.getElementById('cpu-bar'),
    cpuValue: document.getElementById('cpu-value'),
    memoryBar: document.getElementById('memory-bar'),
    memoryValue: document.getElementById('memory-value'),
    uptimeValue: document.getElementById('uptime-value'),

    // Bot grid and empty state
    botsGrid: document.getElementById('bots-grid'),
    emptyState: document.getElementById('empty-state'),

    // Buttons
    refreshBtn: document.getElementById('refresh-btn'),
    addBotBtn: document.getElementById('add-bot-btn'),
    addFirstBotBtn: document.getElementById('add-first-bot-btn'),

    // Bot Modal
    botModal: document.getElementById('bot-modal'),
    modalTitle: document.getElementById('modal-title'),
    botForm: document.getElementById('bot-form'),
    botId: document.getElementById('bot-id'),
    modalClose: document.getElementById('modal-close'),
    modalCancel: document.getElementById('modal-cancel'),
    modalSave: document.getElementById('modal-save'),

    // Settings Modal
    settingsModal: document.getElementById('settings-modal'),
    settingsForm: document.getElementById('settings-form'),
    settingsClose: document.getElementById('settings-close'),
    settingsCancel: document.getElementById('settings-cancel'),
    settingsSave: document.getElementById('settings-save'),

    // Delete Modal
    deleteModal: document.getElementById('delete-modal'),
    deleteBotName: document.getElementById('delete-bot-name'),
    deleteClose: document.getElementById('delete-close'),
    deleteCancel: document.getElementById('delete-cancel'),
    deleteConfirm: document.getElementById('delete-confirm'),

    // Toast container
    toastContainer: document.getElementById('toast-container')
  };

  // Current editing/deleting bot
  let currentBotId = null;

  // ============================================================
  // API FUNCTIONS
  // ============================================================
  async function fetchStatus() {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error('Failed to fetch status');
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error fetching status:', error);
      showToast('error', 'Connection Error', 'Unable to fetch server status');
      return null;
    }
  }

  async function fetchBots() {
    try {
      const response = await fetch('/api/bots');
      if (!response.ok) throw new Error('Failed to fetch bots');
      const data = await response.json();
      bots = data.bots || [];
      globalSettings = data.globalSettings || {};
      return data;
    } catch (error) {
      console.error('Error fetching bots:', error);
      showToast('error', 'Connection Error', 'Unable to fetch bot configurations');
      return null;
    }
  }

  async function createBot(botData) {
    try {
      const response = await fetch('/api/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botData)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create bot');
      }
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  async function updateBot(botId, botData) {
    try {
      const response = await fetch(`/api/bots/${botId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botData)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update bot');
      }
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  async function deleteBot(botId) {
    try {
      const response = await fetch(`/api/bots/${botId}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete bot');
      }
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  async function startBot(botId) {
    try {
      const response = await fetch(`/api/bots/${botId}/start`, {
        method: 'POST'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start bot');
      }
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  async function stopBot(botId) {
    try {
      const response = await fetch(`/api/bots/${botId}/stop`, {
        method: 'POST'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to stop bot');
      }
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  async function restartBot(botId) {
    try {
      const response = await fetch(`/api/bots/${botId}/restart`, {
        method: 'POST'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to restart bot');
      }
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  async function updateSettings(settings) {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update settings');
      }
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  // ============================================================
  // UI UPDATE FUNCTIONS
  // ============================================================
  function updateSystemMetrics(system) {
    if (!system) return;

    // CPU
    const cpuUsage = system.cpuUsage || 0;
    elements.cpuBar.style.width = `${Math.min(cpuUsage, 100)}%`;
    elements.cpuValue.textContent = `${cpuUsage.toFixed(1)}%`;

    // Update bar color based on usage
    elements.cpuBar.classList.remove('warning', 'critical');
    if (cpuUsage > 80) {
      elements.cpuBar.classList.add('critical');
    } else if (cpuUsage > 60) {
      elements.cpuBar.classList.add('warning');
    }

    // Memory
    const memPercent = system.memory?.percentage || 0;
    const memUsed = system.memory?.used || 0;
    elements.memoryBar.style.width = `${Math.min(memPercent, 100)}%`;
    elements.memoryValue.textContent = `${memUsed} MB`;

    // Memory bar color
    elements.memoryBar.classList.remove('warning', 'critical');
    if (memPercent > 80) {
      elements.memoryBar.classList.add('critical');
    } else if (memPercent > 60) {
      elements.memoryBar.classList.add('warning');
    }

    // Uptime
    elements.uptimeValue.textContent = formatUptime(system.uptime || 0);
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (d > 0) {
      return `${d}d ${h}h ${m}m`;
    } else if (h > 0) {
      return `${h}h ${m}m`;
    } else if (m > 0) {
      return `${m}m ${s}s`;
    } else {
      return `${s}s`;
    }
  }

  function updateBotsGrid(botsData) {
    if (!botsData || botsData.length === 0) {
      elements.botsGrid.innerHTML = '';
      elements.emptyState.style.display = 'flex';
      return;
    }

    elements.emptyState.style.display = 'none';

    // Get current bot order from config
    const botIds = bots.map(b => b.id);
    const sortedBots = botsData.sort((a, b) => {
      const aIdx = botIds.indexOf(a.id);
      const bIdx = botIds.indexOf(b.id);
      return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    });

    elements.botsGrid.innerHTML = sortedBots.map(bot => createBotCard(bot)).join('');

    // Attach event listeners to new cards
    attachCardEventListeners();
  }

  function createBotCard(bot) {
    const statusClass = getStatusClass(bot.status, bot.connected);
    const statusLabel = getStatusLabel(bot.status, bot.connected);
    const isRunning = bot.running;
    const coords = bot.coordinates
      ? `${bot.coordinates.x}, ${bot.coordinates.y}, ${bot.coordinates.z}`
      : '--';

    const playerBadgeClass = bot.playerCount > 0 ? '' : 'empty';
    const playerCountText = bot.playerCount > 0 ? `${bot.playerCount} online` : 'Empty';

    return `
      <div class="bot-card" data-bot-id="${bot.id}">
        <div class="bot-card-header">
          <div class="bot-card-title">
            <span class="status-indicator ${statusClass}"></span>
            <span class="bot-name">${escapeHtml(bot.name)}</span>
          </div>
          <span class="status-label ${statusClass}">${statusLabel}</span>
        </div>
        <div class="bot-card-body">
          <div class="bot-info-grid">
            <div class="bot-info-item">
              <span class="info-label">Server</span>
              <span class="info-value highlight">${escapeHtml(bot.serverIp)}:${bot.serverPort}</span>
            </div>
            <div class="bot-info-item">
              <span class="info-label">Players</span>
              <span class="player-count">
                <span class="player-badge ${playerBadgeClass}">${playerCountText}</span>
              </span>
            </div>
            <div class="bot-info-item">
              <span class="info-label">Coordinates</span>
              <span class="info-value">${coords}</span>
            </div>
            <div class="bot-info-item">
              <span class="info-label">Uptime</span>
              <span class="info-value">${formatUptime(bot.uptime || 0)}</span>
            </div>
          </div>
        </div>
        <div class="bot-card-footer">
          <button class="btn btn-sm ${isRunning ? 'btn-danger' : 'btn-success'}" data-action="toggle">
            ${isRunning ? 'Stop' : 'Start'}
          </button>
          <button class="btn btn-sm btn-secondary" data-action="edit">Edit</button>
          <button class="btn btn-sm btn-secondary btn-icon-only" data-action="delete" title="Delete">
            &#128465;
          </button>
        </div>
      </div>
    `;
  }

  function getStatusClass(status, connected) {
    if (connected) return 'connected';
    switch (status) {
      case 'connecting':
      case 'reconnecting':
        return 'connecting';
      case 'polling':
        return 'polling';
      case 'stopped':
      case 'idle':
        return 'stopped';
      default:
        return 'disconnected';
    }
  }

  function getStatusLabel(status, connected) {
    if (connected) return 'Online';
    switch (status) {
      case 'connecting':
        return 'Connecting';
      case 'reconnecting':
        return 'Reconnecting';
      case 'polling':
        return 'Waiting';
      case 'starting':
        return 'Starting';
      case 'stopping':
        return 'Stopping';
      case 'stopped':
      case 'idle':
        return 'Stopped';
      case 'error':
        return 'Error';
      default:
        return 'Offline';
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================================
  // MODAL FUNCTIONS
  // ============================================================
  function openModal(modal) {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(modal) {
    modal.classList.remove('active');
    document.body.style.overflow = '';
  }

  function openBotModal(bot = null) {
    currentBotId = bot ? bot.id : null;
    elements.modalTitle.textContent = bot ? 'Edit Bot Instance' : 'Add Bot Instance';

    // Reset form
    elements.botForm.reset();

    if (bot) {
      // Populate form with existing data
      elements.botId.value = bot.id;
      document.getElementById('bot-name').value = bot.name || '';
      document.getElementById('auth-type').value = bot.authType || 'offline';
      document.getElementById('bot-password').value = bot.password || '';
      document.getElementById('bot-enabled').checked = bot.enabled !== false;
      document.getElementById('server-ip').value = bot.serverIp || '';
      document.getElementById('server-port').value = bot.serverPort || 25565;
      document.getElementById('server-version').value = bot.serverVersion || '';
      document.getElementById('try-creative').checked = bot.tryCreative || false;
      document.getElementById('webhook-url').value = bot.webhookUrl || '';
      document.getElementById('player-guard-enabled').checked = bot.playerGuard?.enabled !== false;
      document.getElementById('evict-on-player').checked = bot.playerGuard?.evictOnPlayer !== false;
      document.getElementById('anti-afk-enabled').checked = bot.antiAfk?.enabled !== false;
      document.getElementById('anti-afk-sneak').checked = bot.antiAfk?.sneak !== false;
      document.getElementById('anti-afk-swing').checked = bot.antiAfk?.swingArm !== false;
      document.getElementById('anti-afk-hotbar').checked = bot.antiAfk?.hotbarCycle !== false;
      document.getElementById('movement-enabled').checked = bot.movement?.enabled !== false;
      document.getElementById('circle-walk-enabled').checked = bot.movement?.circleWalk?.enabled !== false;
      document.getElementById('circle-walk-radius').value = bot.movement?.circleWalk?.radius || 5;
      document.getElementById('look-around').checked = bot.movement?.lookAround?.enabled !== false;
      document.getElementById('auto-auth-enabled').checked = bot.autoAuth?.enabled || false;
      document.getElementById('auto-auth-password').value = bot.autoAuth?.password || '';
      document.getElementById('attack-mobs').checked = bot.combat?.attackMobs || false;
      document.getElementById('auto-eat').checked = bot.combat?.autoEat || false;
    }

    openModal(elements.botModal);
  }

  function openDeleteModal(bot) {
    currentBotId = bot.id;
    elements.deleteBotName.textContent = bot.name;
    openModal(elements.deleteModal);
  }

  function openSettingsModal() {
    document.getElementById('global-webhook').value = globalSettings.webhookUrl || '';
    document.getElementById('check-interval').value = globalSettings.checkInterval || 30000;
    document.getElementById('auto-reconnect-delay').value = globalSettings.autoReconnectDelay || 3000;
    document.getElementById('max-reconnect-delay').value = globalSettings.maxReconnectDelay || 30000;
    openModal(elements.settingsModal);
  }

  // ============================================================
  // EVENT HANDLERS
  // ============================================================
  function attachCardEventListeners() {
    elements.botsGrid.querySelectorAll('.bot-card').forEach(card => {
      const botId = card.dataset.botId;
      const bot = bots.find(b => b.id === botId);

      card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          const action = btn.dataset.action;
          const botConfig = bots.find(b => b.id === botId);

          switch (action) {
            case 'toggle':
              await handleToggleBot(botId, botConfig);
              break;
            case 'edit':
              openBotModal(botConfig);
              break;
            case 'delete':
              if (botConfig) openDeleteModal(botConfig);
              break;
          }
        });
      });
    });
  }

  async function handleToggleBot(botId, botConfig) {
    try {
      const card = document.querySelector(`.bot-card[data-bot-id="${botId}"]`);
      const btn = card?.querySelector('[data-action="toggle"]');
      const statusData = Array.from(document.querySelectorAll('.bot-card')).find(c => c.dataset.botId === botId);
      const botStatus = bots.find(b => b.id === botId);
      const isRunning = botStatus?.running || false;

      if (btn) {
        btn.disabled = true;
        btn.textContent = isRunning ? 'Stopping...' : 'Starting...';
      }

      if (isRunning) {
        await stopBot(botId);
        showToast('success', 'Bot Stopped', `${botConfig?.name || 'Bot'} has been stopped`);
      } else {
        await startBot(botId);
        showToast('success', 'Bot Started', `${botConfig?.name || 'Bot'} is starting`);
      }

      // Refresh status immediately
      await refreshStatus();

    } catch (error) {
      showToast('error', 'Action Failed', error.message);
      await refreshStatus();
    }
  }

  async function handleSaveBot() {
    const formData = getFormData();

    // Validate
    if (!formData.name?.trim()) {
      showToast('error', 'Validation Error', 'Bot name is required');
      return;
    }
    if (!formData.serverIp?.trim()) {
      showToast('error', 'Validation Error', 'Server IP is required');
      return;
    }

    try {
      elements.modalSave.disabled = true;
      elements.modalSave.textContent = 'Saving...';

      if (currentBotId) {
        await updateBot(currentBotId, formData);
        showToast('success', 'Bot Updated', `${formData.name} has been updated`);
      } else {
        await createBot(formData);
        showToast('success', 'Bot Created', `${formData.name} has been created`);
      }

      closeModal(elements.botModal);
      await fetchBots();
      await refreshStatus();

    } catch (error) {
      showToast('error', 'Save Failed', error.message);
    } finally {
      elements.modalSave.disabled = false;
      elements.modalSave.textContent = 'Save Bot';
    }
  }

  async function handleConfirmDelete() {
    if (!currentBotId) return;

    const botConfig = bots.find(b => b.id === currentBotId);
    const botName = botConfig?.name || 'Bot';

    try {
      elements.deleteConfirm.disabled = true;
      elements.deleteConfirm.textContent = 'Deleting...';

      await deleteBot(currentBotId);
      showToast('success', 'Bot Deleted', `${botName} has been removed`);

      closeModal(elements.deleteModal);
      currentBotId = null;
      await fetchBots();
      await refreshStatus();

    } catch (error) {
      showToast('error', 'Delete Failed', error.message);
    } finally {
      elements.deleteConfirm.disabled = false;
      elements.deleteConfirm.textContent = 'Delete';
    }
  }

  async function handleSaveSettings() {
    const settings = {
      webhookUrl: document.getElementById('global-webhook').value || '',
      checkInterval: parseInt(document.getElementById('check-interval').value) || 30000,
      autoReconnectDelay: parseInt(document.getElementById('auto-reconnect-delay').value) || 3000,
      maxReconnectDelay: parseInt(document.getElementById('max-reconnect-delay').value) || 30000
    };

    try {
      elements.settingsSave.disabled = true;
      await updateSettings(settings);
      Object.assign(globalSettings, settings);
      showToast('success', 'Settings Saved', 'Global settings updated');
      closeModal(elements.settingsModal);
    } catch (error) {
      showToast('error', 'Save Failed', error.message);
    } finally {
      elements.settingsSave.disabled = false;
    }
  }

  function getFormData() {
    return {
      name: document.getElementById('bot-name').value.trim(),
      authType: document.getElementById('auth-type').value,
      password: document.getElementById('bot-password').value || '',
      enabled: document.getElementById('bot-enabled').checked,
      serverIp: document.getElementById('server-ip').value.trim(),
      serverPort: parseInt(document.getElementById('server-port').value) || 25565,
      serverVersion: document.getElementById('server-version').value.trim() || '',
      tryCreative: document.getElementById('try-creative').checked,
      webhookUrl: document.getElementById('webhook-url').value.trim() || '',
      playerGuard: {
        enabled: document.getElementById('player-guard-enabled').checked,
        evictOnPlayer: document.getElementById('evict-on-player').checked,
        pollInterval: 30000
      },
      antiAfk: {
        enabled: document.getElementById('anti-afk-enabled').checked,
        sneak: document.getElementById('anti-afk-sneak').checked,
        swingArm: document.getElementById('anti-afk-swing').checked,
        hotbarCycle: document.getElementById('anti-afk-hotbar').checked
      },
      movement: {
        enabled: document.getElementById('movement-enabled').checked,
        circleWalk: {
          enabled: document.getElementById('circle-walk-enabled').checked,
          radius: parseInt(document.getElementById('circle-walk-radius').value) || 5,
          speed: 3000
        },
        randomJump: {
          enabled: false,
          interval: 15000
        },
        lookAround: {
          enabled: document.getElementById('look-around').checked,
          interval: 20000
        }
      },
      autoAuth: {
        enabled: document.getElementById('auto-auth-enabled').checked,
        password: document.getElementById('auto-auth-password').value || ''
      },
      combat: {
        attackMobs: document.getElementById('attack-mobs').checked,
        autoEat: document.getElementById('auto-eat').checked
      },
      autoReconnect: true
    };
  }

  // ============================================================
  // TOAST NOTIFICATIONS
  // ============================================================
  function showToast(type, title, message) {
    const icons = {
      success: '&#10004;',
      error: '&#10006;',
      warning: '&#9888;'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || ''}</span>
      <div class="toast-content">
        <div class="toast-title">${escapeHtml(title)}</div>
        <div class="toast-message">${escapeHtml(message)}</div>
      </div>
      <button class="toast-close">&times;</button>
    `;

    elements.toastContainer.appendChild(toast);

    // Close button
    toast.querySelector('.toast-close').addEventListener('click', () => {
      removeToast(toast);
    });

    // Auto remove after 5 seconds
    setTimeout(() => {
      removeToast(toast);
    }, 5000);
  }

  function removeToast(toast) {
    toast.style.animation = 'toast-enter 0.3s ease reverse';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }

  // ============================================================
  // REFRESH & POLLING
  // ============================================================
  async function refreshStatus() {
    const data = await fetchStatus();
    if (data) {
      updateSystemMetrics(data.system);
      updateBotsGrid(data.bots);
    }
  }

  async function initialize() {
    // Initial load
    await fetchBots();
    await refreshStatus();

    // Start polling
    statusPollingInterval = setInterval(refreshStatus, POLL_INTERVAL);

    // Event Listeners
    elements.refreshBtn.addEventListener('click', refreshStatus);
    elements.addBotBtn.addEventListener('click', () => openBotModal());
    elements.addFirstBotBtn?.addEventListener('click', () => openBotModal());

    // Bot modal events
    elements.modalClose.addEventListener('click', () => closeModal(elements.botModal));
    elements.modalCancel.addEventListener('click', () => closeModal(elements.botModal));
    elements.modalSave.addEventListener('click', handleSaveBot);

    // Settings modal events
    elements.settingsClose.addEventListener('click', () => closeModal(elements.settingsModal));
    elements.settingsCancel.addEventListener('click', () => closeModal(elements.settingsModal));
    elements.settingsSave.addEventListener('click', handleSaveSettings);

    // Delete modal events
    elements.deleteClose.addEventListener('click', () => closeModal(elements.deleteModal));
    elements.deleteCancel.addEventListener('click', () => closeModal(elements.deleteModal));
    elements.deleteConfirm.addEventListener('click', handleConfirmDelete);

    // Close modals on overlay click
    [elements.botModal, elements.settingsModal, elements.deleteModal].forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
      });
    });

    // Collapsible sections
    document.querySelectorAll('.form-section.collapsible .section-title.clickable').forEach(title => {
      title.addEventListener('click', () => {
        title.parentElement.classList.toggle('expanded');
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal(elements.botModal);
        closeModal(elements.settingsModal);
        closeModal(elements.deleteModal);
      }
    });

    // Settings link (if exists)
    const settingsLink = document.getElementById('settings-link');
    settingsLink?.addEventListener('click', (e) => {
      e.preventDefault();
      openSettingsModal();
    });
  }

  // Start application
  document.addEventListener('DOMContentLoaded', initialize);

})();
