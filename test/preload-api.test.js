/**
 * @name         Bandwidth Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Tests for the preload API surface — verifies all IPC channels are exposed.
 * @author       Cloud Nimbus LLC
 */

const fs = require('fs');
const path = require('path');

const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// Extract API method names from preload.js
const apiMethodRegex = /(\w+):\s*\(/g;
const preloadMethods = [];
let match;
while ((match = apiMethodRegex.exec(preloadSource)) !== null) {
  // Skip the 'api' key in contextBridge.exposeInMainWorld('api', {
  if (match[1] !== 'api') {
    preloadMethods.push(match[1]);
  }
}

// Extract IPC channel names from ipcMain.handle calls in main.js
const ipcHandleRegex = /ipcMain\.handle\('([^']+)'/g;
const mainChannels = [];
while ((match = ipcHandleRegex.exec(mainSource)) !== null) {
  mainChannels.push(match[1]);
}

// Extract IPC channel names from ipcRenderer.invoke calls in preload.js
const invokeRegex = /ipcRenderer\.invoke\('([^']+)'/g;
const preloadChannels = [];
while ((match = invokeRegex.exec(preloadSource)) !== null) {
  preloadChannels.push(match[1]);
}

describe('preload API surface', () => {
  test('exposes at least 15 API methods', () => {
    expect(preloadMethods.length).toBeGreaterThanOrEqual(15);
  });

  test('exposes bandwidth management methods', () => {
    expect(preloadMethods).toContain('checkAdmin');
    expect(preloadMethods).toContain('createPolicy');
    expect(preloadMethods).toContain('removePolicy');
    expect(preloadMethods).toContain('removeAllPolicies');
    expect(preloadMethods).toContain('getSavedPolicies');
    expect(preloadMethods).toContain('getBandwidth');
  });

  test('exposes toggle and settings methods', () => {
    expect(preloadMethods).toContain('getEnabled');
    expect(preloadMethods).toContain('toggleEnabled');
    expect(preloadMethods).toContain('getSettings');
    expect(preloadMethods).toContain('saveSettings');
    expect(preloadMethods).toContain('setAutoStart');
  });

  test('exposes preset and Claude methods', () => {
    expect(preloadMethods).toContain('applyPreset');
    expect(preloadMethods).toContain('quickLimitApp');
    expect(preloadMethods).toContain('configureClaude');
    expect(preloadMethods).toContain('runSpeedTest');
  });

  test('exposes launcher methods', () => {
    expect(preloadMethods).toContain('getLaunchers');
    expect(preloadMethods).toContain('saveLauncher');
    expect(preloadMethods).toContain('removeLauncher');
    expect(preloadMethods).toContain('launchClaude');
    expect(preloadMethods).toContain('browseFolder');
  });

  test('exposes prompt backlog methods', () => {
    expect(preloadMethods).toContain('getPrompts');
    expect(preloadMethods).toContain('savePrompt');
    expect(preloadMethods).toContain('removePrompt');
    expect(preloadMethods).toContain('reorderPrompts');
    expect(preloadMethods).toContain('updatePromptStatus');
  });
});

describe('IPC channel alignment', () => {
  test('every preload invoke channel has a matching main.js handler', () => {
    for (const channel of preloadChannels) {
      expect(mainChannels).toContain(channel);
    }
  });

  test('every main.js handler has a matching preload invoke', () => {
    for (const channel of mainChannels) {
      expect(preloadChannels).toContain(channel);
    }
  });

  test('channel count matches between preload and main', () => {
    // Unique channels
    const uniquePreload = [...new Set(preloadChannels)];
    const uniqueMain = [...new Set(mainChannels)];
    expect(uniquePreload.length).toBe(uniqueMain.length);
  });
});
