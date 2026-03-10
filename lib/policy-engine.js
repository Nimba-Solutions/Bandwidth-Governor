/**
 * @name         Bandwidth Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Policy engine — pure business logic for bandwidth policy management.
 * @author       Cloud Nimbus LLC
 */

/**
 * Build a PowerShell command string for creating a QoS policy.
 */
function buildCreatePolicyCmd(policyName, bitsPerSec, appPath) {
  let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
  if (appPath) cmd += ` -AppPathNameMatchCondition '${appPath}'`;
  cmd += ' -PolicyStore ActiveStore';
  return cmd;
}

/**
 * Build a PowerShell command string for removing a QoS policy.
 */
function buildRemovePolicyCmd(policyName) {
  return `Remove-NetQosPolicy -Name '${policyName}' -PolicyStore ActiveStore -Confirm:$false`;
}

/**
 * Convert Mbps to bits per second.
 */
function mbpsToBps(mbps) {
  return Math.round(mbps * 1000000);
}

/**
 * Generate policy names (upload + download) from a base name.
 */
function getPolicyNames(name) {
  return {
    upload: `BG_UL_${name}`,
    download: `BG_DL_${name}`,
  };
}

/**
 * Parse bandwidth stats and compute rates between two snapshots.
 */
function computeBandwidthRates(currentStats, previousStats, elapsedSeconds) {
  if (!previousStats || !currentStats || elapsedSeconds <= 0) return null;

  return currentStats.map(s => {
    const prev = previousStats.find(p => p.Name === s.Name);
    if (!prev) return { name: s.Name, uploadMbps: 0, downloadMbps: 0 };
    const uploadBytes = s.SentBytes - prev.SentBytes;
    const downloadBytes = s.ReceivedBytes - prev.ReceivedBytes;
    return {
      name: s.Name,
      uploadMbps: Math.max(0, (uploadBytes * 8 / 1000000) / elapsedSeconds),
      downloadMbps: Math.max(0, (downloadBytes * 8 / 1000000) / elapsedSeconds),
    };
  });
}

/**
 * Calculate the Claude upload limit from speed test results.
 */
function calculateClaudeLimit(uploadSpeedMbps, capPercent) {
  const percent = capPercent || 50;
  return Math.max(0.5, Math.round(uploadSpeedMbps * (percent / 100) * 10) / 10);
}

/**
 * List of Claude-related process names.
 */
const CLAUDE_APPS = ['node.exe', 'claude.exe', 'git.exe', 'git-remote-https.exe', 'ssh.exe', 'scp.exe'];

/**
 * Available bandwidth presets.
 */
const PRESETS = {
  'upload-only-light':  { upload: 10, download: 0, label: 'Upload Light (10 Mbps)' },
  'upload-only-medium': { upload: 5,  download: 0, label: 'Upload Medium (5 Mbps)' },
  'upload-only-strict': { upload: 2,  download: 0, label: 'Upload Strict (2 Mbps)' },
  'balanced-light':     { upload: 10, download: 50, label: 'Balanced Light' },
  'balanced-medium':    { upload: 5,  download: 20, label: 'Balanced Medium' },
  'balanced-strict':    { upload: 2,  download: 10, label: 'Balanced Strict' },
};

/**
 * Validate a policy config object. Returns an error string or null if valid.
 */
function validatePolicyConfig({ name, uploadLimitMbps, downloadLimitMbps }) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return 'Policy name is required';
  }
  if (name.includes("'") || name.includes('"') || name.includes('`')) {
    return 'Policy name must not contain quotes';
  }
  if ((!uploadLimitMbps || uploadLimitMbps <= 0) && (!downloadLimitMbps || downloadLimitMbps <= 0)) {
    return 'At least one limit (upload or download) must be greater than zero';
  }
  if (uploadLimitMbps && (typeof uploadLimitMbps !== 'number' || uploadLimitMbps < 0)) {
    return 'Upload limit must be a positive number';
  }
  if (downloadLimitMbps && (typeof downloadLimitMbps !== 'number' || downloadLimitMbps < 0)) {
    return 'Download limit must be a positive number';
  }
  return null;
}

/**
 * Merge a policy into a saved policies array (upsert by name).
 */
function upsertPolicy(savedPolicies, newPolicy) {
  const result = [...savedPolicies];
  const existing = result.findIndex(p => p.name === newPolicy.name);
  if (existing >= 0) {
    result[existing] = newPolicy;
  } else {
    result.push(newPolicy);
  }
  return result;
}

/**
 * Remove a policy from a saved policies array by name.
 */
function removePolicyFromList(savedPolicies, name) {
  return savedPolicies.filter(p => p.name !== name);
}

/**
 * Reorder a list of items by an array of IDs.
 */
function reorderByIds(items, ids, idField = 'id') {
  const reordered = ids
    .map((id, i) => {
      const item = items.find(it => it[idField] === id);
      if (item) return { ...item, priority: i };
      return null;
    })
    .filter(Boolean);

  // Append any items not in the reorder list
  for (const item of items) {
    if (!ids.includes(item[idField])) {
      reordered.push(item);
    }
  }

  return reordered;
}

module.exports = {
  buildCreatePolicyCmd,
  buildRemovePolicyCmd,
  mbpsToBps,
  getPolicyNames,
  computeBandwidthRates,
  calculateClaudeLimit,
  validatePolicyConfig,
  upsertPolicy,
  removePolicyFromList,
  reorderByIds,
  CLAUDE_APPS,
  PRESETS,
};
