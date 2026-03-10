/**
 * @name         Bandwidth Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Tests for the policy engine — core business logic.
 * @author       Cloud Nimbus LLC
 */

const {
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
} = require('../lib/policy-engine');

// --- buildCreatePolicyCmd ---

describe('buildCreatePolicyCmd', () => {
  test('builds global policy command without app path', () => {
    const cmd = buildCreatePolicyCmd('BG_UL_Test', 5000000, null);
    expect(cmd).toBe(
      "New-NetQosPolicy -Name 'BG_UL_Test' -ThrottleRateActionBitsPerSecond 5000000 -PolicyStore ActiveStore"
    );
  });

  test('builds per-app policy command with app path', () => {
    const cmd = buildCreatePolicyCmd('BG_UL_Node', 5000000, 'node.exe');
    expect(cmd).toContain("-AppPathNameMatchCondition 'node.exe'");
    expect(cmd).toContain('-PolicyStore ActiveStore');
  });

  test('includes correct policy name', () => {
    const cmd = buildCreatePolicyCmd('BG_DL_Custom', 10000000, null);
    expect(cmd).toContain("'BG_DL_Custom'");
  });
});

// --- buildRemovePolicyCmd ---

describe('buildRemovePolicyCmd', () => {
  test('builds remove command with confirm bypass', () => {
    const cmd = buildRemovePolicyCmd('BG_UL_Test');
    expect(cmd).toBe(
      "Remove-NetQosPolicy -Name 'BG_UL_Test' -PolicyStore ActiveStore -Confirm:$false"
    );
  });
});

// --- mbpsToBps ---

describe('mbpsToBps', () => {
  test('converts 5 Mbps to 5000000 bps', () => {
    expect(mbpsToBps(5)).toBe(5000000);
  });

  test('converts 0.5 Mbps to 500000 bps', () => {
    expect(mbpsToBps(0.5)).toBe(500000);
  });

  test('converts 100 Mbps to 100000000 bps', () => {
    expect(mbpsToBps(100)).toBe(100000000);
  });

  test('handles fractional values with rounding', () => {
    expect(mbpsToBps(2.5)).toBe(2500000);
  });

  test('handles zero', () => {
    expect(mbpsToBps(0)).toBe(0);
  });
});

// --- getPolicyNames ---

describe('getPolicyNames', () => {
  test('generates upload and download policy names', () => {
    const names = getPolicyNames('MyRule');
    expect(names.upload).toBe('BG_UL_MyRule');
    expect(names.download).toBe('BG_DL_MyRule');
  });

  test('handles names with underscores', () => {
    const names = getPolicyNames('Claude_node');
    expect(names.upload).toBe('BG_UL_Claude_node');
    expect(names.download).toBe('BG_DL_Claude_node');
  });
});

// --- computeBandwidthRates ---

describe('computeBandwidthRates', () => {
  test('computes rates from two snapshots', () => {
    const prev = [{ Name: 'Ethernet', SentBytes: 1000000, ReceivedBytes: 2000000 }];
    const curr = [{ Name: 'Ethernet', SentBytes: 1625000, ReceivedBytes: 3250000 }];
    const rates = computeBandwidthRates(curr, prev, 1.0);

    expect(rates).toHaveLength(1);
    expect(rates[0].name).toBe('Ethernet');
    expect(rates[0].uploadMbps).toBe(5); // 625000 bytes * 8 / 1000000 = 5 Mbps
    expect(rates[0].downloadMbps).toBe(10); // 1250000 bytes * 8 / 1000000 = 10 Mbps
  });

  test('handles multiple adapters', () => {
    const prev = [
      { Name: 'Ethernet', SentBytes: 100, ReceivedBytes: 200 },
      { Name: 'Wi-Fi', SentBytes: 300, ReceivedBytes: 400 },
    ];
    const curr = [
      { Name: 'Ethernet', SentBytes: 225100, ReceivedBytes: 200 },
      { Name: 'Wi-Fi', SentBytes: 300, ReceivedBytes: 650400 },
    ];
    const rates = computeBandwidthRates(curr, prev, 2.0);

    expect(rates).toHaveLength(2);
    // Ethernet: 225000 bytes sent in 2s = 112500 B/s * 8 / 1e6 = 0.9 Mbps
    expect(rates[0].uploadMbps).toBeCloseTo(0.9, 1);
    // Wi-Fi: 250000 bytes received in 2s = 125000 B/s * 8 / 1e6 = 1.0 Mbps
    // Actual: 650000 bytes / 2s * 8 / 1e6 = 2.6 Mbps
    expect(rates[1].downloadMbps).toBeCloseTo(2.6, 1);
  });

  test('returns null when no previous stats', () => {
    const curr = [{ Name: 'Ethernet', SentBytes: 1000, ReceivedBytes: 2000 }];
    expect(computeBandwidthRates(curr, null, 1.0)).toBeNull();
  });

  test('returns null when elapsed is zero', () => {
    const stats = [{ Name: 'Ethernet', SentBytes: 1000, ReceivedBytes: 2000 }];
    expect(computeBandwidthRates(stats, stats, 0)).toBeNull();
  });

  test('clamps negative rates to zero', () => {
    const prev = [{ Name: 'Ethernet', SentBytes: 1000, ReceivedBytes: 2000 }];
    const curr = [{ Name: 'Ethernet', SentBytes: 500, ReceivedBytes: 1000 }];
    const rates = computeBandwidthRates(curr, prev, 1.0);

    expect(rates[0].uploadMbps).toBe(0);
    expect(rates[0].downloadMbps).toBe(0);
  });

  test('returns zero for unmatched adapter', () => {
    const prev = [{ Name: 'Ethernet', SentBytes: 1000, ReceivedBytes: 2000 }];
    const curr = [{ Name: 'Wi-Fi', SentBytes: 5000, ReceivedBytes: 6000 }];
    const rates = computeBandwidthRates(curr, prev, 1.0);

    expect(rates[0].uploadMbps).toBe(0);
    expect(rates[0].downloadMbps).toBe(0);
  });
});

// --- calculateClaudeLimit ---

describe('calculateClaudeLimit', () => {
  test('calculates 50% of 100 Mbps = 50 Mbps', () => {
    expect(calculateClaudeLimit(100, 50)).toBe(50);
  });

  test('calculates 25% of 20 Mbps = 5 Mbps', () => {
    expect(calculateClaudeLimit(20, 25)).toBe(5);
  });

  test('defaults to 50% when capPercent is falsy', () => {
    expect(calculateClaudeLimit(10, null)).toBe(5);
    expect(calculateClaudeLimit(10, 0)).toBe(5);
    expect(calculateClaudeLimit(10, undefined)).toBe(5);
  });

  test('enforces minimum of 0.5 Mbps', () => {
    expect(calculateClaudeLimit(0.1, 10)).toBe(0.5);
    expect(calculateClaudeLimit(0.5, 1)).toBe(0.5);
  });

  test('rounds to one decimal place', () => {
    expect(calculateClaudeLimit(33, 33)).toBe(10.9);
  });
});

// --- validatePolicyConfig ---

describe('validatePolicyConfig', () => {
  test('valid config returns null', () => {
    expect(validatePolicyConfig({
      name: 'TestRule',
      uploadLimitMbps: 5,
      downloadLimitMbps: 0,
    })).toBeNull();
  });

  test('rejects empty name', () => {
    expect(validatePolicyConfig({
      name: '',
      uploadLimitMbps: 5,
    })).toContain('name is required');
  });

  test('rejects null name', () => {
    expect(validatePolicyConfig({
      name: null,
      uploadLimitMbps: 5,
    })).toContain('name is required');
  });

  test('rejects name with single quotes (injection prevention)', () => {
    expect(validatePolicyConfig({
      name: "test'; Drop-NetQosPolicy",
      uploadLimitMbps: 5,
    })).toContain('quotes');
  });

  test('rejects name with double quotes', () => {
    expect(validatePolicyConfig({
      name: 'test"bad',
      uploadLimitMbps: 5,
    })).toContain('quotes');
  });

  test('rejects name with backticks', () => {
    expect(validatePolicyConfig({
      name: 'test`cmd`',
      uploadLimitMbps: 5,
    })).toContain('quotes');
  });

  test('rejects zero for both limits', () => {
    expect(validatePolicyConfig({
      name: 'Test',
      uploadLimitMbps: 0,
      downloadLimitMbps: 0,
    })).toContain('At least one limit');
  });

  test('rejects negative upload', () => {
    expect(validatePolicyConfig({
      name: 'Test',
      uploadLimitMbps: -5,
      downloadLimitMbps: 0,
    })).toContain('At least one limit');
  });

  test('accepts upload-only config', () => {
    expect(validatePolicyConfig({
      name: 'UploadOnly',
      uploadLimitMbps: 5,
      downloadLimitMbps: 0,
    })).toBeNull();
  });

  test('rejects non-number upload limit', () => {
    expect(validatePolicyConfig({
      name: 'Test',
      uploadLimitMbps: 'five',
      downloadLimitMbps: 0,
    })).toContain('Upload limit must be a positive number');
  });

  test('rejects non-number download limit', () => {
    expect(validatePolicyConfig({
      name: 'Test',
      uploadLimitMbps: 0,
      downloadLimitMbps: 'ten',
    })).toContain('Download limit must be a positive number');
  });

  test('accepts download-only config', () => {
    expect(validatePolicyConfig({
      name: 'DownloadOnly',
      uploadLimitMbps: 0,
      downloadLimitMbps: 10,
    })).toBeNull();
  });
});

// --- upsertPolicy ---

describe('upsertPolicy', () => {
  test('adds new policy to empty list', () => {
    const result = upsertPolicy([], { name: 'A', uploadLimitMbps: 5 });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('A');
  });

  test('appends new policy to existing list', () => {
    const existing = [{ name: 'A', uploadLimitMbps: 5 }];
    const result = upsertPolicy(existing, { name: 'B', uploadLimitMbps: 10 });
    expect(result).toHaveLength(2);
    expect(result[1].name).toBe('B');
  });

  test('updates existing policy by name', () => {
    const existing = [
      { name: 'A', uploadLimitMbps: 5 },
      { name: 'B', uploadLimitMbps: 10 },
    ];
    const result = upsertPolicy(existing, { name: 'A', uploadLimitMbps: 20 });
    expect(result).toHaveLength(2);
    expect(result[0].uploadLimitMbps).toBe(20);
  });

  test('does not mutate original array', () => {
    const original = [{ name: 'A', uploadLimitMbps: 5 }];
    const result = upsertPolicy(original, { name: 'B', uploadLimitMbps: 10 });
    expect(original).toHaveLength(1);
    expect(result).toHaveLength(2);
  });
});

// --- removePolicyFromList ---

describe('removePolicyFromList', () => {
  test('removes policy by name', () => {
    const list = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
    const result = removePolicyFromList(list, 'B');
    expect(result).toHaveLength(2);
    expect(result.find(p => p.name === 'B')).toBeUndefined();
  });

  test('returns same list if name not found', () => {
    const list = [{ name: 'A' }, { name: 'B' }];
    const result = removePolicyFromList(list, 'Z');
    expect(result).toHaveLength(2);
  });

  test('handles empty list', () => {
    expect(removePolicyFromList([], 'A')).toEqual([]);
  });
});

// --- reorderByIds ---

describe('reorderByIds', () => {
  test('reorders items by ID list', () => {
    const items = [
      { id: 'a', text: 'First' },
      { id: 'b', text: 'Second' },
      { id: 'c', text: 'Third' },
    ];
    const result = reorderByIds(items, ['c', 'a', 'b']);
    expect(result[0].id).toBe('c');
    expect(result[0].priority).toBe(0);
    expect(result[1].id).toBe('a');
    expect(result[1].priority).toBe(1);
    expect(result[2].id).toBe('b');
    expect(result[2].priority).toBe(2);
  });

  test('appends items not in ID list', () => {
    const items = [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
      { id: 'c', text: 'C' },
    ];
    const result = reorderByIds(items, ['b']);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('b');
    expect(result[1].id).toBe('a');
    expect(result[2].id).toBe('c');
  });

  test('ignores IDs not found in items', () => {
    const items = [{ id: 'a', text: 'A' }];
    const result = reorderByIds(items, ['z', 'a', 'y']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  test('handles empty items', () => {
    expect(reorderByIds([], ['a', 'b'])).toEqual([]);
  });
});

// --- Constants ---

describe('CLAUDE_APPS', () => {
  test('includes expected Claude-related processes', () => {
    expect(CLAUDE_APPS).toContain('node.exe');
    expect(CLAUDE_APPS).toContain('claude.exe');
    expect(CLAUDE_APPS).toContain('git.exe');
    expect(CLAUDE_APPS).toContain('git-remote-https.exe');
    expect(CLAUDE_APPS).toContain('ssh.exe');
    expect(CLAUDE_APPS).toContain('scp.exe');
  });

  test('has 6 entries', () => {
    expect(CLAUDE_APPS).toHaveLength(6);
  });
});

describe('PRESETS', () => {
  test('has 6 presets', () => {
    expect(Object.keys(PRESETS)).toHaveLength(6);
  });

  test('upload-only presets have zero download', () => {
    expect(PRESETS['upload-only-light'].download).toBe(0);
    expect(PRESETS['upload-only-medium'].download).toBe(0);
    expect(PRESETS['upload-only-strict'].download).toBe(0);
  });

  test('balanced presets have non-zero download', () => {
    expect(PRESETS['balanced-light'].download).toBeGreaterThan(0);
    expect(PRESETS['balanced-medium'].download).toBeGreaterThan(0);
    expect(PRESETS['balanced-strict'].download).toBeGreaterThan(0);
  });

  test('strict presets have lowest upload values', () => {
    expect(PRESETS['upload-only-strict'].upload).toBeLessThan(PRESETS['upload-only-medium'].upload);
    expect(PRESETS['upload-only-medium'].upload).toBeLessThan(PRESETS['upload-only-light'].upload);
  });

  test('all presets have labels', () => {
    for (const key of Object.keys(PRESETS)) {
      expect(PRESETS[key].label).toBeTruthy();
    }
  });
});
