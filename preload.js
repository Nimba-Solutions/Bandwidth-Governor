/**
 * @name         Bandwidth Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Preload script — exposes IPC bridge to the renderer process.
 * @author       Cloud Nimbus LLC
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Bandwidth
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
  getSavedPolicies: () => ipcRenderer.invoke('get-saved-policies'),
  createPolicy: (data) => ipcRenderer.invoke('create-policy', data),
  removePolicy: (name) => ipcRenderer.invoke('remove-policy', name),
  removeAllPolicies: () => ipcRenderer.invoke('remove-all-policies'),
  getBandwidth: () => ipcRenderer.invoke('get-bandwidth'),
  getEnabled: () => ipcRenderer.invoke('get-enabled'),
  toggleEnabled: () => ipcRenderer.invoke('toggle-enabled'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  setAutoStart: (v) => ipcRenderer.invoke('set-auto-start', v),
  applyPreset: (preset) => ipcRenderer.invoke('apply-preset', { preset }),
  quickLimitApp: (appName, uploadMbps) => ipcRenderer.invoke('quick-limit-app', { appName, uploadMbps }),
  selfElevate: () => ipcRenderer.invoke('self-elevate'),
  runSpeedTest: () => ipcRenderer.invoke('run-speed-test'),
  configureClaude: (uploadCapPercent, forceSpeedTest) => ipcRenderer.invoke('configure-claude', { uploadCapPercent, forceSpeedTest }),
  getClaudeConfig: () => ipcRenderer.invoke('get-claude-config'),
  quickSetup: (uploadCapPercent) => ipcRenderer.invoke('quick-setup', { uploadCapPercent }),
  onEnabledChanged: (cb) => ipcRenderer.on('enabled-changed', (_, val) => cb(val)),

  // Launchers
  getLaunchers: () => ipcRenderer.invoke('get-launchers'),
  saveLauncher: (l) => ipcRenderer.invoke('save-launcher', l),
  removeLauncher: (id) => ipcRenderer.invoke('remove-launcher', id),
  launchClaude: (id, promptText) => ipcRenderer.invoke('launch-claude', { id, promptText }),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),

  // Prompts
  getPrompts: () => ipcRenderer.invoke('get-prompts'),
  savePrompt: (p) => ipcRenderer.invoke('save-prompt', p),
  removePrompt: (id) => ipcRenderer.invoke('remove-prompt', id),
  reorderPrompts: (ids) => ipcRenderer.invoke('reorder-prompts', ids),
  updatePromptStatus: (id, status) => ipcRenderer.invoke('update-prompt-status', { id, status }),
});
