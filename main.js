/**
 * @name         Bandwidth Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Electron main process — bandwidth policy management via Windows QoS.
 * @author       Cloud Nimbus LLC
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    policies: [],
    settings: {
      autoStart: false,
      startMinimized: false,
      autoApplyOnLaunch: true,
      defaultPreset: 'moderate',  // which preset to auto-apply
      defaultUploadMbps: 5,
      defaultDownloadMbps: 0,     // 0 = no download limit by default
    },
    enabled: true,  // master on/off
    launchers: [],  // { id, name, folder, claudeArgs }
    prompts: [],    // { id, text, priority, status, createdAt, tags }
    claudeConfig: null, // { speed: {download, upload}, percent, limitMbps, testedAt }
  },
});

let mainWindow = null;
let tray = null;
let isEnabled = store.get('enabled', true);

// --- Icon ---

function createTrayIcon(active) {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const isBorder = x === 0 || x === size - 1 || y === 0 || y === size - 1;
      if (active) {
        canvas[i] = isBorder ? 50 : 34;
        canvas[i + 1] = isBorder ? 180 : 140;
        canvas[i + 2] = isBorder ? 50 : 34;
        canvas[i + 3] = 255;
      } else {
        canvas[i] = isBorder ? 180 : 140;
        canvas[i + 1] = isBorder ? 50 : 40;
        canvas[i + 2] = isBorder ? 50 : 40;
        canvas[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

// --- Window ---

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 820,
    height: 750,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: createTrayIcon(isEnabled),
    title: 'Bandwidth Governor',
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// --- Tray ---

function updateTrayMenu() {
  if (!tray) return;
  tray.setImage(createTrayIcon(isEnabled));
  tray.setToolTip(`Bandwidth Governor - ${isEnabled ? 'ACTIVE' : 'OFF'}`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isEnabled ? 'Limiting ON' : 'Limiting OFF',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: isEnabled ? 'Disable Limits' : 'Enable Limits',
      click: () => toggleEnabled(),
    },
    { label: 'Open Dashboard', click: () => createWindow() },
    { type: 'separator' },
    { label: 'Remove All Limits', click: () => { removeAllPolicies(); updateTrayMenu(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  tray = new Tray(createTrayIcon(isEnabled));
  updateTrayMenu();
  tray.on('double-click', () => createWindow());
}

// --- PowerShell ---

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`;
    exec(psCmd, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// --- Policy management ---

async function createPolicy({ name, appPath, uploadLimitMbps, downloadLimitMbps }) {
  const results = [];

  if (uploadLimitMbps && uploadLimitMbps > 0) {
    const bitsPerSec = Math.round(uploadLimitMbps * 1000000);
    const policyName = `BG_UL_${name}`;
    let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
    if (appPath) cmd += ` -AppPathNameMatchCondition '${appPath}'`;
    cmd += ' -PolicyStore ActiveStore';
    try {
      await runPowerShell(cmd);
      results.push({ policy: policyName, status: 'created' });
    } catch (e) {
      results.push({ policy: policyName, status: 'error', message: e.message });
    }
  }

  if (downloadLimitMbps && downloadLimitMbps > 0) {
    const bitsPerSec = Math.round(downloadLimitMbps * 1000000);
    const policyName = `BG_DL_${name}`;
    let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
    if (appPath) cmd += ` -AppPathNameMatchCondition '${appPath}'`;
    cmd += ' -PolicyStore ActiveStore';
    try {
      await runPowerShell(cmd);
      results.push({ policy: policyName, status: 'created' });
    } catch (e) {
      results.push({ policy: policyName, status: 'error', message: e.message });
    }
  }

  // Save to persistent store (avoid duplicates)
  const saved = store.get('policies', []);
  const existing = saved.findIndex(p => p.name === name);
  const entry = { name, appPath, uploadLimitMbps, downloadLimitMbps, createdAt: new Date().toISOString() };
  if (existing >= 0) saved[existing] = entry;
  else saved.push(entry);
  store.set('policies', saved);

  return results;
}

async function removePolicy(name) {
  const results = [];
  for (const prefix of ['BG_UL_', 'BG_DL_']) {
    const policyName = `${prefix}${name}`;
    try {
      await runPowerShell(`Remove-NetQosPolicy -Name '${policyName}' -PolicyStore ActiveStore -Confirm:$false`);
      results.push({ policy: policyName, status: 'removed' });
    } catch (e) {
      results.push({ policy: policyName, status: 'not_found' });
    }
  }
  const saved = store.get('policies', []);
  store.set('policies', saved.filter(p => p.name !== name));
  return results;
}

async function removeAllPolicies() {
  try {
    await runPowerShell(
      `Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'BG_*' } | Remove-NetQosPolicy -Confirm:$false`
    );
    store.set('policies', []);
    return { status: 'all_removed' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// --- Toggle master on/off ---

async function toggleEnabled() {
  isEnabled = !isEnabled;
  store.set('enabled', isEnabled);

  if (isEnabled) {
    // Re-apply saved policies
    await reapplyPolicies();
  } else {
    // Remove all active policies but keep them saved
    try {
      await runPowerShell(
        `Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'BG_*' } | Remove-NetQosPolicy -Confirm:$false`
      );
    } catch (e) { /* ignore */ }
  }

  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('enabled-changed', isEnabled);
  }
  return isEnabled;
}

// --- Re-apply all saved policies (used on startup and re-enable) ---

async function reapplyPolicies() {
  const saved = store.get('policies', []);
  if (saved.length === 0) {
    // Apply default if configured
    const settings = store.get('settings');
    if (settings.autoApplyOnLaunch && (settings.defaultUploadMbps > 0 || settings.defaultDownloadMbps > 0)) {
      await createPolicy({
        name: 'Default',
        appPath: null,
        uploadLimitMbps: settings.defaultUploadMbps,
        downloadLimitMbps: settings.defaultDownloadMbps,
      });
    }
    return;
  }

  for (const p of saved) {
    if (p.uploadLimitMbps && p.uploadLimitMbps > 0) {
      const bitsPerSec = Math.round(p.uploadLimitMbps * 1000000);
      const policyName = `BG_UL_${p.name}`;
      let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
      if (p.appPath) cmd += ` -AppPathNameMatchCondition '${p.appPath}'`;
      cmd += ' -PolicyStore ActiveStore';
      try { await runPowerShell(cmd); } catch (e) { /* ignore duplicates */ }
    }
    if (p.downloadLimitMbps && p.downloadLimitMbps > 0) {
      const bitsPerSec = Math.round(p.downloadLimitMbps * 1000000);
      const policyName = `BG_DL_${p.name}`;
      let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
      if (p.appPath) cmd += ` -AppPathNameMatchCondition '${p.appPath}'`;
      cmd += ' -PolicyStore ActiveStore';
      try { await runPowerShell(cmd); } catch (e) { /* ignore duplicates */ }
    }
  }
}

// --- Auto-start (Windows registry) ---

async function setAutoStart(enabled) {
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  // Use the electron exe with app path for dev, or packaged exe
  const launchCmd = exePath.includes('electron') ? `"${exePath}" "${appPath}"` : `"${exePath}"`;

  try {
    if (enabled) {
      await runPowerShell(
        `New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'BandwidthGovernor' -Value '${launchCmd}' -PropertyType String -Force`
      );
    } else {
      await runPowerShell(
        `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'BandwidthGovernor' -ErrorAction SilentlyContinue`
      );
    }
    const settings = store.get('settings');
    settings.autoStart = enabled;
    store.set('settings', settings);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// --- Bandwidth monitoring ---

let lastStats = null;
let lastStatsTime = null;

async function getBandwidthUsage() {
  try {
    const raw = await runPowerShell(
      `Get-NetAdapterStatistics | Select-Object Name, SentBytes, ReceivedBytes | ConvertTo-Json -Compress`
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const stats = Array.isArray(parsed) ? parsed : [parsed];
    const now = Date.now();

    if (lastStats && lastStatsTime) {
      const elapsed = (now - lastStatsTime) / 1000;
      const results = stats.map((s, i) => {
        const prev = lastStats.find(p => p.Name === s.Name);
        if (!prev) return { name: s.Name, uploadMbps: 0, downloadMbps: 0 };
        const uploadBytes = s.SentBytes - prev.SentBytes;
        const downloadBytes = s.ReceivedBytes - prev.ReceivedBytes;
        return {
          name: s.Name,
          uploadMbps: Math.max(0, (uploadBytes * 8 / 1000000) / elapsed).toFixed(2),
          downloadMbps: Math.max(0, (downloadBytes * 8 / 1000000) / elapsed).toFixed(2),
        };
      });
      lastStats = stats;
      lastStatsTime = now;
      return results;
    }

    lastStats = stats;
    lastStatsTime = now;
    return stats.map(s => ({ name: s.Name, uploadMbps: '0.00', downloadMbps: '0.00' }));
  } catch (e) {
    return null;
  }
}

async function checkAdmin() {
  try {
    const result = await runPowerShell(
      `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
    );
    return result === 'True';
  } catch (e) {
    return false;
  }
}

// --- IPC Handlers ---

ipcMain.handle('check-admin', () => checkAdmin());
ipcMain.handle('get-saved-policies', () => store.get('policies', []));
ipcMain.handle('create-policy', (_, data) => createPolicy(data));
ipcMain.handle('remove-policy', (_, name) => removePolicy(name));
ipcMain.handle('remove-all-policies', () => removeAllPolicies());
ipcMain.handle('get-bandwidth', () => getBandwidthUsage());
ipcMain.handle('get-enabled', () => isEnabled);
ipcMain.handle('toggle-enabled', () => toggleEnabled());
ipcMain.handle('get-settings', () => store.get('settings'));
ipcMain.handle('save-settings', (_, settings) => {
  store.set('settings', settings);
  return { status: 'ok' };
});
ipcMain.handle('set-auto-start', (_, enabled) => setAutoStart(enabled));

ipcMain.handle('apply-preset', async (_, { preset }) => {
  await removeAllPolicies();

  const presets = {
    'upload-only-light':  { upload: 10, download: 0, label: 'Upload Light (10 Mbps)' },
    'upload-only-medium': { upload: 5,  download: 0, label: 'Upload Medium (5 Mbps)' },
    'upload-only-strict': { upload: 2,  download: 0, label: 'Upload Strict (2 Mbps)' },
    'balanced-light':     { upload: 10, download: 50, label: 'Balanced Light' },
    'balanced-medium':    { upload: 5,  download: 20, label: 'Balanced Medium' },
    'balanced-strict':    { upload: 2,  download: 10, label: 'Balanced Strict' },
  };

  const p = presets[preset];
  if (!p) return { status: 'error', message: 'Unknown preset' };

  isEnabled = true;
  store.set('enabled', true);
  updateTrayMenu();

  return await createPolicy({
    name: `Preset_${preset}`,
    appPath: null,
    uploadLimitMbps: p.upload,
    downloadLimitMbps: p.download,
  });
});

ipcMain.handle('quick-limit-app', async (_, { appName, uploadMbps }) => {
  return await createPolicy({
    name: `App_${appName.replace('.exe', '')}`,
    appPath: appName,
    uploadLimitMbps: uploadMbps,
    downloadLimitMbps: 0,
  });
});

// --- Speed test ---

async function runSpeedTest(progressCallback) {
  const results = { download: 0, upload: 0 };

  // Download test: fetch a 10MB file from Cloudflare and measure speed
  try {
    const dlResult = await new Promise((resolve, reject) => {
      const startTime = Date.now();
      const testSize = 10000000; // 10MB
      exec(
        `curl -s -o NUL -w "%{speed_download}" "https://speed.cloudflare.com/__down?bytes=${testSize}"`,
        { windowsHide: true, timeout: 30000 },
        (err, stdout) => {
          if (err) return reject(err);
          const bytesPerSec = parseFloat(stdout.replace(/"/g, ''));
          resolve((bytesPerSec * 8) / 1000000); // convert to Mbps
        }
      );
    });
    results.download = Math.round(dlResult * 10) / 10;
  } catch (e) {
    console.error('Download test failed:', e.message);
  }

  // Upload test: send 2MB of data to Cloudflare
  try {
    const ulResult = await new Promise((resolve, reject) => {
      // Create a temp file with random data for upload test
      const tempFile = path.join(app.getPath('temp'), 'bg-speedtest.bin');
      const fs = require('fs');
      fs.writeFileSync(tempFile, Buffer.alloc(2000000, 0x41)); // 2MB of data

      exec(
        `curl -s -w "%{speed_upload}" -X POST -F "file=@${tempFile.replace(/\\/g, '/')}" "https://speed.cloudflare.com/__up" -o NUL`,
        { windowsHide: true, timeout: 30000 },
        (err, stdout) => {
          try { fs.unlinkSync(tempFile); } catch (e) {}
          if (err) return reject(err);
          const bytesPerSec = parseFloat(stdout.replace(/"/g, ''));
          resolve((bytesPerSec * 8) / 1000000);
        }
      );
    });
    results.upload = Math.round(ulResult * 10) / 10;
  } catch (e) {
    console.error('Upload test failed:', e.message);
  }

  return results;
}

ipcMain.handle('run-speed-test', async () => {
  return await runSpeedTest();
});

// --- Configure for Claude ---

ipcMain.handle('configure-claude', async (_, { uploadCapPercent, forceSpeedTest }) => {
  // Step 1: Use saved speed or run test
  let speed;
  const savedConfig = store.get('claudeConfig');
  if (!forceSpeedTest && savedConfig && savedConfig.speed && savedConfig.speed.upload > 0) {
    speed = savedConfig.speed;
  } else {
    speed = await runSpeedTest();
    if (speed.upload <= 0) {
      return { status: 'error', message: 'Speed test failed - could not measure upload speed', speed };
    }
  }

  // Step 2: Calculate limit
  const percent = uploadCapPercent || 50;
  const limitMbps = Math.max(0.5, Math.round(speed.upload * (percent / 100) * 10) / 10);

  // Step 3: Remove existing Claude policies
  const claudeApps = ['node.exe', 'claude.exe', 'git.exe', 'git-remote-https.exe', 'ssh.exe', 'scp.exe'];
  for (const a of claudeApps) {
    try { await removePolicy(`Claude_${a.replace('.exe', '')}`); } catch (e) {}
  }

  // Step 4: Apply per-app limits to all Claude-related processes
  const results = [];
  for (const appName of claudeApps) {
    const r = await createPolicy({
      name: `Claude_${appName.replace('.exe', '')}`,
      appPath: appName,
      uploadLimitMbps: limitMbps,
      downloadLimitMbps: 0,
    });
    results.push({ app: appName, result: r });
  }

  isEnabled = true;
  store.set('enabled', true);
  updateTrayMenu();

  // Save config for next time
  const claudeConfig = { speed, percent, limitMbps, testedAt: new Date().toISOString() };
  store.set('claudeConfig', claudeConfig);

  return {
    status: 'ok',
    speed,
    percent,
    limitMbps,
    results,
    usedSavedSpeed: !forceSpeedTest && savedConfig && savedConfig.speed && savedConfig.speed.upload > 0,
  };
});

ipcMain.handle('get-claude-config', () => store.get('claudeConfig'));

ipcMain.handle('quick-setup', async (_, { uploadCapPercent }) => {
  let speed;
  const savedConfig = store.get('claudeConfig');
  if (savedConfig && savedConfig.speed && savedConfig.speed.upload > 0) {
    speed = savedConfig.speed;
  } else {
    speed = await runSpeedTest();
    if (speed.upload <= 0) {
      return { status: 'error', message: 'Speed test failed', speed };
    }
  }

  const percent = uploadCapPercent || 50;
  const limitMbps = Math.max(0.5, Math.round(speed.upload * (percent / 100) * 10) / 10);

  const claudeApps = ['node.exe', 'claude.exe', 'git.exe', 'git-remote-https.exe', 'ssh.exe', 'scp.exe'];
  for (const a of claudeApps) {
    try { await removePolicy(`Claude_${a.replace('.exe', '')}`); } catch (e) {}
  }
  for (const appName of claudeApps) {
    await createPolicy({
      name: `Claude_${appName.replace('.exe', '')}`,
      appPath: appName,
      uploadLimitMbps: limitMbps,
      downloadLimitMbps: 0,
    });
  }

  isEnabled = true;
  store.set('enabled', true);
  updateTrayMenu();

  // Save claude config
  store.set('claudeConfig', { speed, percent, limitMbps, testedAt: new Date().toISOString() });

  // Enable auto-start
  await setAutoStart(true);

  // Set start-minimized
  const settings = store.get('settings');
  settings.autoStart = true;
  settings.startMinimized = true;
  settings.autoApplyOnLaunch = true;
  store.set('settings', settings);

  // Minimize to tray
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  return { status: 'ok', speed, percent, limitMbps };
});

// --- Claude Launchers ---

ipcMain.handle('get-launchers', () => store.get('launchers', []));

ipcMain.handle('save-launcher', (_, launcher) => {
  const launchers = store.get('launchers', []);
  if (!launcher.id) {
    launcher.id = `launch_${Date.now()}`;
    launchers.push(launcher);
  } else {
    const idx = launchers.findIndex(l => l.id === launcher.id);
    if (idx >= 0) launchers[idx] = launcher;
    else launchers.push(launcher);
  }
  store.set('launchers', launchers);
  return launcher;
});

ipcMain.handle('remove-launcher', (_, id) => {
  const launchers = store.get('launchers', []).filter(l => l.id !== id);
  store.set('launchers', launchers);
  return { status: 'ok' };
});

ipcMain.handle('launch-claude', (_, { id, promptText }) => {
  const launchers = store.get('launchers', []);
  const launcher = launchers.find(l => l.id === id);
  if (!launcher) return { status: 'error', message: 'Launcher not found' };

  const folder = launcher.folder.replace(/\//g, '\\');
  const args = launcher.claudeArgs || '--dangerously-skip-permissions';

  let cmd;
  if (promptText) {
    // Escape the prompt for command line - write to temp file then pipe
    const fs = require('fs');
    const tempPrompt = path.join(app.getPath('temp'), `bg-prompt-${Date.now()}.txt`);
    fs.writeFileSync(tempPrompt, promptText, 'utf8');
    // Launch in new cmd window, cd to folder, run claude with prompt from file, then pause
    cmd = `start cmd.exe /k "cd /d ${folder} && claude ${args} -p \\"$(cat ${tempPrompt.replace(/\\/g, '/')})\\" "`;
    // Simpler approach: just open terminal and let user paste
    cmd = `start cmd.exe /k "cd /d ${folder} && echo Prompt copied to clipboard. && claude ${args}"`;
    // Copy prompt to clipboard
    const { clipboard } = require('electron');
    clipboard.writeText(promptText);
  } else {
    cmd = `start cmd.exe /k "cd /d ${folder} && claude ${args}"`;
  }

  exec(cmd, { windowsHide: false, shell: true }, (err) => {
    if (err) console.error('Launch error:', err.message);
  });

  return { status: 'ok', folder: launcher.folder };
});

ipcMain.handle('browse-folder', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select project folder',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// --- Prompt Backlog ---

ipcMain.handle('get-prompts', () => store.get('prompts', []));

ipcMain.handle('save-prompt', (_, prompt) => {
  const prompts = store.get('prompts', []);
  if (!prompt.id) {
    prompt.id = `prompt_${Date.now()}`;
    prompt.createdAt = new Date().toISOString();
    prompt.status = prompt.status || 'queued';
    prompt.priority = prompt.priority || prompts.length;
    prompts.push(prompt);
  } else {
    const idx = prompts.findIndex(p => p.id === prompt.id);
    if (idx >= 0) prompts[idx] = { ...prompts[idx], ...prompt };
  }
  store.set('prompts', prompts);
  return prompt;
});

ipcMain.handle('remove-prompt', (_, id) => {
  const prompts = store.get('prompts', []).filter(p => p.id !== id);
  store.set('prompts', prompts);
  return { status: 'ok' };
});

ipcMain.handle('reorder-prompts', (_, ids) => {
  const prompts = store.get('prompts', []);
  const reordered = ids.map((id, i) => {
    const p = prompts.find(pr => pr.id === id);
    if (p) p.priority = i;
    return p;
  }).filter(Boolean);
  // Add any prompts not in the reorder list
  for (const p of prompts) {
    if (!ids.includes(p.id)) reordered.push(p);
  }
  store.set('prompts', reordered);
  return { status: 'ok' };
});

ipcMain.handle('update-prompt-status', (_, { id, status }) => {
  const prompts = store.get('prompts', []);
  const p = prompts.find(pr => pr.id === id);
  if (p) {
    p.status = status;
    if (status === 'done') p.completedAt = new Date().toISOString();
    store.set('prompts', prompts);
  }
  return { status: 'ok' };
});

ipcMain.handle('self-elevate', async () => {
  // Relaunch as admin using PowerShell Start-Process -Verb RunAs
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  try {
    await runPowerShell(
      `Start-Process '${exePath}' -ArgumentList '"${appPath}"' -Verb RunAs`
    );
    app.isQuitting = true;
    app.quit();
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

// --- Single instance lock ---

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Another instance is already running — show a dialog and quit
  app.whenReady().then(() => {
    const { dialog } = require('electron');
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Bandwidth Governor',
      message: 'Bandwidth Governor is already running!',
      detail: 'Another instance is active in the system tray. Running multiple instances causes QoS policy conflicts.\n\nClick OK to close this duplicate.',
      buttons: ['OK'],
    });
    app.quit();
  });
} else {
  // When a second instance tries to launch, focus the existing window
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// --- App lifecycle ---

if (gotLock) {
  app.whenReady().then(async () => {
    createTray();

    const settings = store.get('settings');

    // Auto-apply policies on launch
    if (isEnabled && settings.autoApplyOnLaunch) {
      await reapplyPolicies();
    }

    // Show window unless start-minimized is on
    if (!settings.startMinimized) {
      createWindow();
    }
  });
}

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', () => { if (gotLock) createWindow(); });
app.on('before-quit', () => { app.isQuitting = true; });
