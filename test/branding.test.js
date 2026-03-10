/**
 * @name         Bandwidth Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Tests for license compliance, branding, and link correctness.
 * @author       Cloud Nimbus LLC
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SOURCE_FILES = ['main.js', 'preload.js', 'create-icon.js', 'lib/policy-engine.js'];
const HTML_FILE = path.join(ROOT, 'index.html');
const LICENSE_FILE = path.join(ROOT, 'LICENSE.md');
const PACKAGE_FILE = path.join(ROOT, 'package.json');

describe('BSL 1.1 license headers', () => {
  test.each(SOURCE_FILES)('%s has BSL 1.1 license header', (file) => {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(content).toContain('@name         Bandwidth Governor');
    expect(content).toContain('@license      BSL 1.1');
    expect(content).toContain('LICENSE.md');
    expect(content).toContain('@author       Cloud Nimbus LLC');
  });

  test('index.html has BSL 1.1 license header', () => {
    const content = fs.readFileSync(HTML_FILE, 'utf8');
    expect(content).toContain('@name         Bandwidth Governor');
    expect(content).toContain('@license      BSL 1.1');
    expect(content).toContain('@author       Cloud Nimbus LLC');
  });
});

describe('LICENSE.md', () => {
  let content;

  beforeAll(() => {
    content = fs.readFileSync(LICENSE_FILE, 'utf8');
  });

  test('exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100);
  });

  test('identifies BSL 1.1', () => {
    expect(content).toContain('Business Source License 1.1');
  });

  test('lists Cloud Nimbus LLC as licensor', () => {
    expect(content).toContain('Cloud Nimbus LLC');
  });

  test('specifies change to Apache 2.0', () => {
    expect(content).toContain('Apache License, Version 2.0');
  });

  test('includes attribution requirement', () => {
    expect(content.toLowerCase()).toContain('attribution');
  });

  test('includes disclaimer', () => {
    expect(content).toContain('AS IS');
  });
});

describe('package.json metadata', () => {
  let pkg;

  beforeAll(() => {
    pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
  });

  test('has BSL-1.1 license', () => {
    expect(pkg.license).toBe('BSL-1.1');
  });

  test('has Cloud Nimbus LLC as author', () => {
    expect(pkg.author).toContain('Cloud Nimbus LLC');
  });

  test('homepage points to cloudnimbusllc.com', () => {
    expect(pkg.homepage).toContain('cloudnimbusllc.com');
  });

  test('repo points to Nimba-Solutions org', () => {
    expect(pkg.repository.url).toContain('Nimba-Solutions/Bandwidth-Governor');
  });
});

describe('UI branding and links', () => {
  let html;

  beforeAll(() => {
    html = fs.readFileSync(HTML_FILE, 'utf8');
  });

  test('footer contains "Powered by" Cloud Nimbus LLC', () => {
    expect(html).toContain('Powered by');
    expect(html).toContain('Cloud Nimbus LLC');
  });

  test('links to cloudnimbusllc.com (not cloudnimbus.com)', () => {
    expect(html).toContain('cloudnimbusllc.com');
    expect(html).not.toContain('"https://cloudnimbus.com"');
  });

  test('links to GitHub repo', () => {
    expect(html).toContain('github.com/Nimba-Solutions/Bandwidth-Governor');
  });

  test('has "Free & Open Source" text', () => {
    expect(html).toContain('Free');
    expect(html).toContain('Open Source');
  });
});
