/**
 * @name         Process Guard
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Shared child process guard — tracks spawned children, enforces concurrency
 *               limits, cleans up orphans on startup, and kills all children on exit.
 * @author       Cloud Nimbus LLC
 */

const { exec, spawn } = require('child_process');
const os = require('os');

const platform = os.platform(); // 'win32', 'darwin', 'linux'

const MAX_CHILDREN = 20;
const ORPHAN_PROCESS_NAMES_WIN = ['powershell.exe', 'wmic.exe', 'conhost.exe'];
const ORPHAN_PROCESS_NAMES_MAC = []; // stale bash/zsh shells would be caught by generic patrol
const ORPHAN_WARN_THRESHOLD = 30;
const PATROL_INTERVAL_MS = 10000;

/** Set of currently tracked child PIDs */
const tracked = new Set();

/** Whether init() has been called */
let initialized = false;

/** Reference to the patrol interval */
let patrolTimer = null;

// ─── Helpers ────────────────────────────────────────────────────

function log(msg) {
  console.log(`[process-guard] ${msg}`);
}

function warn(msg) {
  console.warn(`[process-guard] WARNING: ${msg}`);
}

// ─── Track / untrack ────────────────────────────────────────────

function track(child) {
  if (!child || !child.pid) return;
  tracked.add(child.pid);
  child.on('exit', () => tracked.delete(child.pid));
  child.on('error', () => tracked.delete(child.pid));
}

/** Prune PIDs that are no longer alive (killed externally via taskkill etc.) */
function pruneDeadPids() {
  for (const pid of tracked) {
    try {
      process.kill(pid, 0); // signal 0 = just check if alive
    } catch (_) {
      tracked.delete(pid);
    }
  }
}

// ─── Guarded exec ───────────────────────────────────────────────

function guardedExec(command, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  callback = callback || (() => {});

  if (tracked.size >= MAX_CHILDREN) {
    // Before refusing, prune dead PIDs — they may have been killed externally
    pruneDeadPids();
  }

  if (tracked.size >= MAX_CHILDREN) {
    warn(`Refusing to spawn — ${tracked.size} child processes actually alive (limit: ${MAX_CHILDREN})`);
    const err = new Error(`Process guard: concurrency limit reached (${MAX_CHILDREN})`);
    return callback(err, '', '');
  }

  const child = exec(command, options, callback);
  track(child);
  return child;
}

// ─── Guarded execPromise ────────────────────────────────────────

function guardedExecPromise(command, timeout) {
  return new Promise((resolve, reject) => {
    if (tracked.size >= MAX_CHILDREN) {
      pruneDeadPids();
    }
    if (tracked.size >= MAX_CHILDREN) {
      warn(`Refusing to spawn — ${tracked.size} child processes actually alive (limit: ${MAX_CHILDREN})`);
      return reject(new Error(`Process guard: concurrency limit reached (${MAX_CHILDREN})`));
    }

    const opts = { windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
    if (timeout) opts.timeout = timeout;

    const child = exec(command, opts, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    track(child);
  });
}

// ─── Kill all tracked children ──────────────────────────────────

function killAll() {
  for (const pid of tracked) {
    try {
      process.kill(pid);
    } catch (_) { /* already dead */ }
  }
  tracked.clear();
}

// ─── Orphan cleanup (cross-platform) ────────────────────────────

function cleanupOrphans() {
  if (platform === 'win32') {
    // Use taskkill-based cleanup instead of PowerShell to avoid spawning more of the problem
    const cmd = `tasklist /fo csv /nh /fi "IMAGENAME eq powershell.exe" /fi "MEMUSAGE gt 0"`;

    exec(cmd, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return;
      const lines = (stdout || '').trim().split('\n').filter(l => l.includes(','));
      if (lines.length > ORPHAN_WARN_THRESHOLD) {
        log(`Found ${lines.length} powershell processes (threshold: ${ORPHAN_WARN_THRESHOLD}) — killing excess`);
        exec('taskkill /f /im powershell.exe /fi "WINDOWTITLE ne Administrator*"', { windowsHide: true, timeout: 10000 });
      }
    });
  } else if (platform === 'darwin' || platform === 'linux') {
    // macOS/Linux: check for excessive zombie or orphaned shell processes
    const shellName = platform === 'darwin' ? 'zsh' : 'bash';
    const cmd = `ps -eo pid,ppid,stat,comm | grep -E '(${shellName})' | grep -v grep`;

    exec(cmd, { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return;
      // Count orphaned shells (ppid=1 means adopted by init/launchd — true orphan)
      const lines = (stdout || '').trim().split('\n').filter(l => l.trim());
      const orphans = lines.filter(l => {
        const parts = l.trim().split(/\s+/);
        return parts[1] === '1' && parts[2] && parts[2].includes('Z'); // zombie with ppid=1
      });
      if (orphans.length > ORPHAN_WARN_THRESHOLD) {
        log(`Found ${orphans.length} orphaned ${shellName} processes (threshold: ${ORPHAN_WARN_THRESHOLD}) — killing excess`);
        for (const line of orphans) {
          const pid = parseInt(line.trim().split(/\s+/)[0]);
          if (pid > 1) {
            try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already dead */ }
          }
        }
      }
    });
  }
}

// ─── Proactive patrol ───────────────────────────────────────────

function startPatrol() {
  if (patrolTimer) return;

  patrolTimer = setInterval(() => {
    if (platform === 'win32') {
      // Use tasklist instead of PowerShell to avoid spawning more of the problem
      exec('tasklist /fo csv /nh /fi "IMAGENAME eq powershell.exe"', { windowsHide: true, timeout: 10000 }, (err, stdout) => {
        if (err) return;
        const lines = (stdout || '').trim().split('\n').filter(l => l.includes('powershell'));
        if (lines.length > ORPHAN_WARN_THRESHOLD) {
          warn(`${lines.length} powershell processes detected (threshold: ${ORPHAN_WARN_THRESHOLD}) — killing excess`);
          exec('taskkill /f /im powershell.exe', { windowsHide: true, timeout: 10000 });
        }
      });
    } else {
      // macOS/Linux: use ps + kill to check for zombie/orphaned shell processes
      const shellName = platform === 'darwin' ? 'zsh' : 'bash';
      exec(`ps -eo pid,ppid,stat,comm | grep -c '${shellName}'`, { timeout: 10000 }, (err, stdout) => {
        if (err) return;
        const count = parseInt((stdout || '').trim()) || 0;
        if (count > ORPHAN_WARN_THRESHOLD) {
          warn(`${count} ${shellName} processes detected (threshold: ${ORPHAN_WARN_THRESHOLD}) — running orphan cleanup`);
          cleanupOrphans();
        }
      });
    }
  }, PATROL_INTERVAL_MS);

  // Don't let the patrol timer keep the process alive
  if (patrolTimer.unref) patrolTimer.unref();
}

// ─── Init ───────────────────────────────────────────────────────

function init(electronApp) {
  if (initialized) return;
  initialized = true;

  // Kill all tracked children on exit signals
  const onExit = () => {
    killAll();
    if (patrolTimer) {
      clearInterval(patrolTimer);
      patrolTimer = null;
    }
  };

  process.on('SIGTERM', onExit);
  process.on('SIGINT', onExit);
  process.on('uncaughtException', (err) => {
    warn(`Uncaught exception — killing tracked children: ${err.message}`);
    onExit();
  });

  if (electronApp) {
    electronApp.on('before-quit', onExit);
  }

  // Orphan cleanup on startup
  cleanupOrphans();

  // Start proactive patrol
  startPatrol();

  log(`Initialized (max ${MAX_CHILDREN} concurrent children)`);
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
  init,
  exec: guardedExec,
  execPromise: guardedExecPromise,
  killAll,
  get tracked() { return tracked; },
};
