/**
 * @name         Bandwidth Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Electron main process — cross-platform bandwidth policy management.
 *               Windows: QoS policies. macOS: pfctl/dnctl. Linux: tc (traffic control).
 * @author       Cloud Nimbus LLC
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');
const guard = require('./process-guard');

const platform = process.platform; // 'win32', 'darwin', 'linux'

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
      notificationThreshold: 1,   // 1-5, only notify for priorities <= this value
    },
    enabled: true,  // master on/off
    launchers: [],  // { id, name, folder, claudeArgs }
    prompts: [],    // { id, text, priority, status, createdAt, tags }
    claudeConfig: null, // { speed: {download, upload}, percent, limitMbps, testedAt }
    pipeCounter: 100, // macOS: next available dnctl pipe number
  },
});

let mainWindow = null;
let tray = null;
let isEnabled = store.get('enabled', true);

// --- Claude session tracking ---
const activeSessions = new Map(); // id -> { pid, launcherId, name, folder, color, priority, state: 'active'|'idle', startedAt, lastActive, idleSeconds, cpuSnapshots }
let sessionPollInterval = null;

function startSessionPolling() {
  if (sessionPollInterval) return;
  sessionPollInterval = setInterval(pollSessions, 10000);
}

function stopSessionPolling() {
  if (sessionPollInterval) {
    clearInterval(sessionPollInterval);
    sessionPollInterval = null;
  }
}

function pollSessions() {
  if (activeSessions.size === 0) {
    stopSessionPolling();
    return;
  }

  activeSessions.forEach((session, id) => {
    const pid = parseInt(session.pid);
    if (!pid || pid <= 0) {
      activeSessions.delete(id);
      return;
    }
    if (platform === 'win32') {
      // Use lightweight wmic instead of PowerShell to avoid CPU spike
      guard.exec(
        `wmic process where ProcessId=${pid} get KernelModeTime,UserModeTime /format:csv 2>NUL`,
        { windowsHide: true, timeout: 5000 },
        (err, stdout) => {
          if (err || !stdout || !stdout.includes(',')) {
            activeSessions.delete(id);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('session-ended', { id, name: session.name });
            }
            if (activeSessions.size === 0) stopSessionPolling();
            return;
          }
          // Parse CSV: Node,KernelModeTime,UserModeTime
          const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.startsWith('Node'));
          if (lines.length === 0) {
            activeSessions.delete(id);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('session-ended', { id, name: session.name });
            }
            if (activeSessions.size === 0) stopSessionPolling();
            return;
          }
          const parts = lines[0].trim().split(',');
          const kernel = parseInt(parts[1]) || 0;
          const user = parseInt(parts[2]) || 0;
          const totalCpu = kernel + user; // in 100-nanosecond units
          updateSessionActivity(id, session, totalCpu);
        }
      );
    } else {
      // macOS / Linux
      guard.exec(`ps -p ${session.pid} -o %cpu=`, (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          activeSessions.delete(id);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('session-ended', { id, name: session.name });
          }
          if (activeSessions.size === 0) stopSessionPolling();
          return;
        }
        const cpu = parseFloat(stdout.trim()) || 0;
        updateSessionActivity(id, session, cpu);
      });
    }
  });
}

function updateSessionActivity(id, session, cpuValue) {
  session.lastActive = Date.now();

  // Track CPU snapshots (keep last 3 for idle detection)
  if (!session.cpuSnapshots) session.cpuSnapshots = [];
  session.cpuSnapshots.push(cpuValue);
  if (session.cpuSnapshots.length > 3) session.cpuSnapshots.shift();

  // Determine if idle: CPU < 1% for 3 consecutive polls (15 seconds)
  const isCurrentlyIdle = session.cpuSnapshots.length >= 3 &&
    session.cpuSnapshots.every(cpu => {
      // On Windows, CPU is cumulative processor time — check delta
      // On Unix, it's instantaneous percentage
      if (platform === 'win32') {
        return true; // handled via delta below
      }
      return cpu < 1;
    });

  // On Windows, CPU is cumulative — check if delta across snapshots is near zero
  let windowsIdle = false;
  if (platform === 'win32' && session.cpuSnapshots.length >= 3) {
    const oldest = session.cpuSnapshots[0];
    const newest = session.cpuSnapshots[session.cpuSnapshots.length - 1];
    windowsIdle = (newest - oldest) < 1;
  }

  const idle = platform === 'win32' ? windowsIdle : isCurrentlyIdle;
  const prevState = session.state;

  if (idle && prevState === 'active') {
    session.state = 'idle';
    session.idleSeconds = 15;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-idle', {
        id, name: session.name, color: session.color, priority: session.priority,
      });
    }
  } else if (!idle && prevState === 'idle') {
    session.state = 'active';
    session.idleSeconds = 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-active', { id, name: session.name });
    }
  } else if (idle) {
    session.idleSeconds = (session.idleSeconds || 0) + 5;
  } else {
    session.idleSeconds = 0;
  }
}

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

// --- Shell command helpers ---

/**
 * Run a PowerShell command (Windows only).
 */
function runPowerShell(command) {
  const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`;
  return guard.execPromise(psCmd).then(s => (s || '').trim());
}

/**
 * Run a shell command via bash (macOS/Linux).
 */
function runShell(command) {
  return guard.execPromise(command).then(s => (s || '').trim());
}

// --- Linux helper: get default network interface ---

async function getDefaultInterface() {
  try {
    const result = await runShell("ip route show default | awk '{print $5}' | head -n1");
    return result || 'eth0';
  } catch (e) {
    return 'eth0';
  }
}

// --- macOS helper: allocate a pipe number for dnctl ---

function allocatePipeNumber() {
  const num = store.get('pipeCounter', 100);
  store.set('pipeCounter', num + 1);
  return num;
}

// --- Policy management ---

async function createPolicy({ name, appPath, uploadLimitMbps, downloadLimitMbps }) {
  const results = [];

  if (platform === 'win32') {
    // Windows: QoS policies via PowerShell
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
  } else if (platform === 'darwin') {
    // macOS: pfctl + dnctl (dummynet pipes)
    // NOTE: Per-app bandwidth limiting is not supported on macOS via pfctl.
    // pfctl operates on ports/IPs, not application paths. All limits are applied globally.
    // The appPath parameter is stored but ignored for enforcement on macOS.
    try {
      if (uploadLimitMbps && uploadLimitMbps > 0) {
        const pipeNum = allocatePipeNumber();
        const rateKbit = Math.round(uploadLimitMbps * 1000);
        await runShell(`sudo dnctl pipe ${pipeNum} config bw ${rateKbit}Kbit/s`);
        await runShell(`echo "dummynet out proto tcp from any to any pipe ${pipeNum}" | sudo pfctl -a "bg/${name}_ul" -f -`);
        await runShell('sudo pfctl -e 2>/dev/null || true');
        results.push({ policy: `bg/${name}_ul`, pipe: pipeNum, status: 'created' });
      }

      if (downloadLimitMbps && downloadLimitMbps > 0) {
        const pipeNum = allocatePipeNumber();
        const rateKbit = Math.round(downloadLimitMbps * 1000);
        await runShell(`sudo dnctl pipe ${pipeNum} config bw ${rateKbit}Kbit/s`);
        await runShell(`echo "dummynet in proto tcp from any to any pipe ${pipeNum}" | sudo pfctl -a "bg/${name}_dl" -f -`);
        await runShell('sudo pfctl -e 2>/dev/null || true');
        results.push({ policy: `bg/${name}_dl`, pipe: pipeNum, status: 'created' });
      }
    } catch (e) {
      results.push({ policy: name, status: 'error', message: e.message });
    }
  } else if (platform === 'linux') {
    // Linux: tc (traffic control) with tbf qdisc for simple global limiting.
    // NOTE: Per-app bandwidth limiting on Linux would require cgroups + net_cls,
    // which is not implemented here. All limits are applied globally.
    // The appPath parameter is stored but ignored for enforcement on Linux.
    try {
      const iface = await getDefaultInterface();

      if (uploadLimitMbps && uploadLimitMbps > 0) {
        const rateKbit = Math.round(uploadLimitMbps * 1000);
        // Remove any existing root qdisc first (ignore errors if none exists)
        await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
        await runShell(`sudo tc qdisc add dev ${iface} root tbf rate ${rateKbit}kbit burst 32kbit latency 400ms`);
        results.push({ policy: `tc_ul_${name}`, iface, status: 'created' });
      }

      if (downloadLimitMbps && downloadLimitMbps > 0) {
        const rateKbit = Math.round(downloadLimitMbps * 1000);
        // For download limiting on Linux, use an IFB (intermediate functional block) device
        await runShell('sudo modprobe ifb 2>/dev/null || true');
        await runShell('sudo ip link set dev ifb0 up 2>/dev/null || true');
        await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
        await runShell(`sudo tc qdisc add dev ${iface} ingress`);
        await runShell(`sudo tc filter add dev ${iface} parent ffff: protocol ip u32 match u32 0 0 flowid 1:1 action mirred egress redirect dev ifb0`);
        await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
        await runShell(`sudo tc qdisc add dev ifb0 root tbf rate ${rateKbit}kbit burst 32kbit latency 400ms`);
        results.push({ policy: `tc_dl_${name}`, iface, status: 'created' });
      }
    } catch (e) {
      results.push({ policy: name, status: 'error', message: e.message });
    }
  }

  // Save to persistent store (avoid duplicates)
  const saved = store.get('policies', []);
  const existing = saved.findIndex(p => p.name === name);
  const entry = {
    name,
    appPath,
    uploadLimitMbps,
    downloadLimitMbps,
    createdAt: new Date().toISOString(),
    // Store platform-specific metadata
    platform,
    ...(platform === 'darwin' ? { pipes: results.filter(r => r.pipe).map(r => r.pipe) } : {}),
    ...(platform === 'linux' ? { iface: results.length > 0 ? results[0].iface : null } : {}),
  };
  if (existing >= 0) saved[existing] = entry;
  else saved.push(entry);
  store.set('policies', saved);

  return results;
}

async function removePolicy(name) {
  const results = [];
  const saved = store.get('policies', []);
  const policy = saved.find(p => p.name === name);

  if (platform === 'win32') {
    for (const prefix of ['BG_UL_', 'BG_DL_']) {
      const policyName = `${prefix}${name}`;
      try {
        await runPowerShell(`Remove-NetQosPolicy -Name '${policyName}' -PolicyStore ActiveStore -Confirm:$false`);
        results.push({ policy: policyName, status: 'removed' });
      } catch (e) {
        results.push({ policy: policyName, status: 'not_found' });
      }
    }
  } else if (platform === 'darwin') {
    // Remove pf anchor rules
    for (const suffix of ['_ul', '_dl']) {
      try {
        await runShell(`sudo pfctl -a "bg/${name}${suffix}" -F all 2>/dev/null || true`);
        results.push({ policy: `bg/${name}${suffix}`, status: 'removed' });
      } catch (e) {
        results.push({ policy: `bg/${name}${suffix}`, status: 'not_found' });
      }
    }
    // Delete associated dnctl pipes
    if (policy && policy.pipes) {
      for (const pipeNum of policy.pipes) {
        try {
          await runShell(`sudo dnctl pipe ${pipeNum} delete 2>/dev/null || true`);
        } catch (e) { /* ignore */ }
      }
    }
  } else if (platform === 'linux') {
    // Remove tc qdiscs — this removes all tc rules on the interface
    try {
      const iface = (policy && policy.iface) || await getDefaultInterface();
      await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
      results.push({ policy: `tc_${name}`, status: 'removed' });
    } catch (e) {
      results.push({ policy: `tc_${name}`, status: 'not_found' });
    }
  }

  store.set('policies', saved.filter(p => p.name !== name));
  return results;
}

async function removeAllPolicies() {
  try {
    if (platform === 'win32') {
      await runPowerShell(
        `Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'BG_*' } | Remove-NetQosPolicy -Confirm:$false`
      );
    } else if (platform === 'darwin') {
      // Flush all rules under the "bg" anchor and delete all associated pipes
      await runShell('sudo pfctl -a "bg" -F all 2>/dev/null || true');
      const saved = store.get('policies', []);
      for (const policy of saved) {
        if (policy.pipes) {
          for (const pipeNum of policy.pipes) {
            try {
              await runShell(`sudo dnctl pipe ${pipeNum} delete 2>/dev/null || true`);
            } catch (e) { /* ignore */ }
          }
        }
      }
      // Reset pipe counter
      store.set('pipeCounter', 100);
    } else if (platform === 'linux') {
      const iface = await getDefaultInterface();
      await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
    }

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
      if (platform === 'win32') {
        await runPowerShell(
          `Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'BG_*' } | Remove-NetQosPolicy -Confirm:$false`
        );
      } else if (platform === 'darwin') {
        await runShell('sudo pfctl -a "bg" -F all 2>/dev/null || true');
        const saved = store.get('policies', []);
        for (const policy of saved) {
          if (policy.pipes) {
            for (const pipeNum of policy.pipes) {
              try { await runShell(`sudo dnctl pipe ${pipeNum} delete 2>/dev/null || true`); } catch (e) { /* ignore */ }
            }
          }
        }
      } else if (platform === 'linux') {
        const iface = await getDefaultInterface();
        await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
        await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
        await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
      }
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

  if (platform === 'win32') {
    // Windows: create QoS policies for each saved entry
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
  } else {
    // macOS/Linux: re-create policies via the normal createPolicy flow.
    // We clear first, then re-apply each saved policy.
    // Temporarily save and restore the list since createPolicy modifies the store.
    const savedCopy = JSON.parse(JSON.stringify(saved));

    if (platform === 'darwin') {
      await runShell('sudo pfctl -a "bg" -F all 2>/dev/null || true');
      store.set('pipeCounter', 100);
    } else if (platform === 'linux') {
      const iface = await getDefaultInterface();
      await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
    }

    for (const p of savedCopy) {
      await createPolicy({
        name: p.name,
        appPath: p.appPath,
        uploadLimitMbps: p.uploadLimitMbps,
        downloadLimitMbps: p.downloadLimitMbps,
      });
    }
  }
}

// --- Auto-start ---

async function setAutoStart(enabled) {
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  // Use the electron exe with app path for dev, or packaged exe
  const launchCmd = exePath.includes('electron') ? `"${exePath}" "${appPath}"` : `"${exePath}"`;

  try {
    if (platform === 'win32') {
      // Windows: registry-based auto-start
      if (enabled) {
        await runPowerShell(
          `New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'BandwidthGovernor' -Value '${launchCmd}' -PropertyType String -Force`
        );
      } else {
        await runPowerShell(
          `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'BandwidthGovernor' -ErrorAction SilentlyContinue`
        );
      }
    } else if (platform === 'darwin') {
      // macOS: LaunchAgent plist
      const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      const plistPath = path.join(plistDir, 'com.cloudnimbus.bandwidth-governor.plist');
      if (enabled) {
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudnimbus.bandwidth-governor</string>
    <key>ProgramArguments</key>
    <array>
        <string>${exePath}</string>${exePath.includes('electron') ? `\n        <string>${appPath}</string>` : ''}
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>`;
        if (!fs.existsSync(plistDir)) {
          fs.mkdirSync(plistDir, { recursive: true });
        }
        fs.writeFileSync(plistPath, plistContent, 'utf8');
      } else {
        try { fs.unlinkSync(plistPath); } catch (e) { /* ignore if not found */ }
      }
    } else if (platform === 'linux') {
      // Linux: .desktop file in autostart directory
      const autostartDir = path.join(os.homedir(), '.config', 'autostart');
      const desktopPath = path.join(autostartDir, 'bandwidth-governor.desktop');
      if (enabled) {
        const desktopContent = `[Desktop Entry]
Type=Application
Name=Bandwidth Governor
Exec=${launchCmd}
X-GNOME-Autostart-enabled=true
Hidden=false
NoDisplay=false
Comment=Bandwidth limiting tool
`;
        if (!fs.existsSync(autostartDir)) {
          fs.mkdirSync(autostartDir, { recursive: true });
        }
        fs.writeFileSync(desktopPath, desktopContent, 'utf8');
      } else {
        try { fs.unlinkSync(desktopPath); } catch (e) { /* ignore if not found */ }
      }
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
    if (platform === 'win32') {
      // Windows: Get-NetAdapterStatistics via PowerShell
      const raw = await runPowerShell(
        `Get-NetAdapterStatistics | Select-Object Name, SentBytes, ReceivedBytes | ConvertTo-Json -Compress`
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const stats = Array.isArray(parsed) ? parsed : [parsed];
      const now = Date.now();

      if (lastStats && lastStatsTime) {
        const elapsed = (now - lastStatsTime) / 1000;
        const results = stats.map((s) => {
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

    } else if (platform === 'darwin') {
      // macOS: parse netstat -ib for interface byte counts
      const raw = await runShell('/usr/sbin/netstat -ib');
      const lines = raw.split('\n');
      // Header: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
      const stats = [];
      for (const line of lines.slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        // Only include entries with a Link#N address (physical interfaces)
        if (!parts[3] || !parts[3].startsWith('Link#')) continue;
        const name = parts[0];
        const receivedBytes = parseInt(parts[6], 10) || 0;
        const sentBytes = parseInt(parts[9], 10) || 0;
        stats.push({ Name: name, SentBytes: sentBytes, ReceivedBytes: receivedBytes });
      }
      if (stats.length === 0) return null;

      const now = Date.now();
      if (lastStats && lastStatsTime) {
        const elapsed = (now - lastStatsTime) / 1000;
        const results = stats.map((s) => {
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

    } else if (platform === 'linux') {
      // Linux: read /proc/net/dev for interface byte counts
      const raw = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = raw.split('\n');
      // Skip header lines (first 2 lines)
      const stats = [];
      for (const line of lines.slice(2)) {
        const match = line.trim().match(/^(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
        if (!match) continue;
        const name = match[1];
        if (name === 'lo') continue; // skip loopback
        const receivedBytes = parseInt(match[2], 10);
        const sentBytes = parseInt(match[3], 10);
        stats.push({ Name: name, SentBytes: sentBytes, ReceivedBytes: receivedBytes });
      }
      if (stats.length === 0) return null;

      const now = Date.now();
      if (lastStats && lastStatsTime) {
        const elapsed = (now - lastStatsTime) / 1000;
        const results = stats.map((s) => {
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
    }
  } catch (e) {
    return null;
  }
}

async function checkAdmin() {
  try {
    if (platform === 'win32') {
      const result = await runPowerShell(
        `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
      );
      return result === 'True';
    } else if (platform === 'darwin') {
      // Check if user is in the admin group
      const result = await runShell('id -Gn');
      return result.split(/\s+/).includes('admin');
    } else if (platform === 'linux') {
      // Check if running as root (uid 0)
      const result = await runShell('id -u');
      return result.trim() === '0';
    }
    return false;
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
ipcMain.handle('get-platform', () => platform);

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
    name: `App_${appName.replace(/\.exe$/i, '')}`,
    appPath: appName,
    uploadLimitMbps: uploadMbps,
    downloadLimitMbps: 0,
  });
});

// --- Speed test ---

async function runSpeedTest(progressCallback) {
  const results = { download: 0, upload: 0 };
  const nullDev = platform === 'win32' ? 'NUL' : '/dev/null';
  const hideOpts = platform === 'win32' ? { windowsHide: true, timeout: 30000 } : { timeout: 30000 };

  // Download test: fetch a 10MB file from Cloudflare and measure speed
  try {
    const dlResult = await new Promise((resolve, reject) => {
      const testSize = 10000000; // 10MB
      guard.exec(
        `curl -s -o ${nullDev} -w "%{speed_download}" "https://speed.cloudflare.com/__down?bytes=${testSize}"`,
        hideOpts,
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
      fs.writeFileSync(tempFile, Buffer.alloc(2000000, 0x41)); // 2MB of data

      guard.exec(
        `curl -s -w "%{speed_upload}" -X POST -F "file=@${tempFile.replace(/\\/g, '/')}" "https://speed.cloudflare.com/__up" -o ${nullDev}`,
        hideOpts,
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
  // On Windows, per-app limiting targets specific executables.
  // On macOS/Linux, per-app limiting is not available — a single global policy is used instead.
  if (platform === 'win32') {
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
  } else {
    // macOS/Linux: apply a single global upload limit (per-app not supported)
    try { await removePolicy('Claude_global'); } catch (e) {}

    const r = await createPolicy({
      name: 'Claude_global',
      appPath: null,
      uploadLimitMbps: limitMbps,
      downloadLimitMbps: 0,
    });

    isEnabled = true;
    store.set('enabled', true);
    updateTrayMenu();

    const claudeConfig = { speed, percent, limitMbps, testedAt: new Date().toISOString() };
    store.set('claudeConfig', claudeConfig);

    return {
      status: 'ok',
      speed,
      percent,
      limitMbps,
      results: [{ app: 'global', result: r }],
      usedSavedSpeed: !forceSpeedTest && savedConfig && savedConfig.speed && savedConfig.speed.upload > 0,
      note: 'Per-app limiting is only available on Windows. A global upload limit has been applied.',
    };
  }
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

  if (platform === 'win32') {
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
  } else {
    // macOS/Linux: single global limit (per-app not supported)
    try { await removePolicy('Claude_global'); } catch (e) {}
    await createPolicy({
      name: 'Claude_global',
      appPath: null,
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

  return {
    status: 'ok',
    speed,
    percent,
    limitMbps,
    ...(platform !== 'win32' ? { note: 'Per-app limiting is only available on Windows. A global upload limit has been applied.' } : {}),
  };
});

// --- Claude Launchers ---

ipcMain.handle('get-launchers', () => store.get('launchers', []));

ipcMain.handle('save-launcher', (_, launcher) => {
  if (!launcher.color) launcher.color = '#44cc44';
  if (launcher.priority == null) launcher.priority = 3;
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

  const args = launcher.claudeArgs || '--dangerously-skip-permissions';
  const color = launcher.color || '#44cc44';
  const priority = launcher.priority != null ? launcher.priority : 3;

  if (promptText) {
    const { clipboard } = require('electron');
    clipboard.writeText(promptText);
  }

  let child;
  const sessionId = `session_${Date.now()}`;

  if (platform === 'win32') {
    const folder = launcher.folder.replace(/\//g, '\\');
    const shellCmd = promptText
      ? `cd /d ${folder} && echo Prompt copied to clipboard. && claude ${args}`
      : `cd /d ${folder} && claude ${args}`;
    child = spawn('cmd.exe', ['/k', shellCmd], {
      detached: true,
      stdio: 'ignore',
      cwd: folder,
    });
    child.unref();
  } else if (platform === 'darwin') {
    // macOS: open a new Terminal.app window
    const folder = launcher.folder;
    const escapedFolder = folder.replace(/'/g, "'\\''");
    const termCmd = `cd '${escapedFolder}' && claude ${args}`;
    const cmd = `osascript -e 'tell application "Terminal" to do script "${termCmd.replace(/"/g, '\\"')}"'`;
    child = guard.exec(cmd, { shell: '/bin/bash' }, (err) => {
      if (err) console.error('Launch error:', err.message);
    });
  } else {
    // Linux: try common terminal emulators
    const folder = launcher.folder;
    const escapedFolder = folder.replace(/'/g, "'\\''");
    const innerCmd = `cd '${escapedFolder}' && claude ${args}`;
    const cmd = `x-terminal-emulator -e bash -c '${innerCmd.replace(/'/g, "'\\''")}; exec bash' 2>/dev/null || xterm -e bash -c '${innerCmd.replace(/'/g, "'\\''")}; exec bash' 2>/dev/null`;
    child = guard.exec(cmd, { shell: '/bin/bash' }, (err) => {
      if (err) console.error('Launch error:', err.message);
    });
  }

  const pid = child ? child.pid : null;
  const sessionInfo = {
    pid,
    launcherId: id,
    name: launcher.name || launcher.folder,
    folder: launcher.folder,
    color,
    priority,
    state: 'active',
    startedAt: new Date().toISOString(),
    lastActive: Date.now(),
    idleSeconds: 0,
    cpuSnapshots: [],
  };

  if (pid) {
    activeSessions.set(sessionId, sessionInfo);
    startSessionPolling();
  }

  return {
    status: 'ok',
    folder: launcher.folder,
    sessionId,
    session: { id: sessionId, ...sessionInfo },
  };
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

// --- Session IPC handlers ---

ipcMain.handle('get-sessions', () => {
  const sessions = [];
  activeSessions.forEach((s, id) => sessions.push({ id, ...s }));
  return sessions;
});

ipcMain.handle('focus-session', (_, id) => {
  const session = activeSessions.get(id);
  if (!session) return { status: 'error', message: 'Session not found' };
  // Best-effort: bring the terminal window to front (platform specific)
  if (platform === 'win32' && session.pid) {
    guard.exec(
      `powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate((Get-Process -Id ${session.pid} -ErrorAction SilentlyContinue).MainWindowTitle)"`,
      () => { /* best-effort, ignore errors */ }
    );
  }
  return { status: 'ok' };
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
  const exePath = process.execPath;
  const appPath = app.getAppPath();

  try {
    if (platform === 'win32') {
      // Windows: relaunch as admin using PowerShell Start-Process -Verb RunAs
      await runPowerShell(
        `Start-Process '${exePath}' -ArgumentList '"${appPath}"' -Verb RunAs`
      );
    } else if (platform === 'darwin') {
      // macOS: relaunch with admin privileges via osascript
      const launchCmd = exePath.includes('electron')
        ? `\\"${exePath}\\" \\"${appPath}\\"`
        : `open \\"${exePath}\\"`;
      await runShell(
        `osascript -e 'do shell script "${launchCmd}" with administrator privileges'`
      );
    } else if (platform === 'linux') {
      // Linux: relaunch with pkexec for graphical sudo
      const launchArgs = exePath.includes('electron') ? `"${exePath}" "${appPath}"` : `"${exePath}"`;
      await runShell(`pkexec ${launchArgs} &`);
    }

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
      detail: 'Another instance is active in the system tray. Running multiple instances causes policy conflicts.\n\nClick OK to close this duplicate.',
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
    guard.init(app);
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
