import { describe, it, expect } from 'vitest';
import { compareVersions, isVersionNewer, isMajorVersionUpgrade } from '../utils/semver.js';
import { looksSensitive, memoryStore } from '../utils/memory.js';

describe('semver helpers', () => {
  it('parses v-prefixed and 2-part versions', () => {
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('orders versions correctly', () => {
    expect(isVersionNewer('1.0.9', '1.0.8')).toBe(true);
    expect(isVersionNewer('1.1.0', '1.0.99')).toBe(true);
    expect(isVersionNewer('1.0.8', '1.0.8')).toBe(false);
    // A local build ahead of the last release must not look like an update
    expect(isVersionNewer('1.0.8', '1.1.0')).toBe(false);
  });

  it('detects major upgrades', () => {
    expect(isMajorVersionUpgrade('2.0.0', '1.9.9')).toBe(true);
    expect(isMajorVersionUpgrade('1.9.0', '1.9.9')).toBe(false);
  });

  it('returns 0 for unparseable versions (never offers a bogus update)', () => {
    expect(compareVersions('beta', '1.0.0')).toBe(0);
    expect(isVersionNewer('latest', '1.0.0')).toBe(false);
  });
});

describe('memory safety', () => {
  it('flags secret-looking content', () => {
    expect(looksSensitive('my key is sk-or-v1-abcdef0123456789abcdef0123456789')).toBe(true);
    expect(looksSensitive('BEGIN RSA PRIVATE KEY')).toBe(true);
    expect(looksSensitive('Bearer abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
    expect(looksSensitive('the user prefers dark mode')).toBe(false);
  });

  it('refuses to store secret-looking content', () => {
    const entry = memoryStore.add('fact', 'the api key is sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { source: 'agent' });
    expect(entry).toBeNull();
  });

  it('stores, searches and clears non-sensitive entries', () => {
    memoryStore.clear();
    const e = memoryStore.add('preference', 'User prefers concise answers', { source: 'user', scope: 'chat' });
    expect(e).not.toBeNull();
    const found = memoryStore.search('concise');
    expect(found.length).toBeGreaterThan(0);
    expect(memoryStore.search('zzz-nonexistent')).toHaveLength(0);
    memoryStore.clear();
    expect(memoryStore.getAll()).toHaveLength(0);
  });

  it('deduplicates identical content', () => {
    memoryStore.clear();
    memoryStore.add('fact', 'Project uses TypeScript', { source: 'agent' });
    const second = memoryStore.add('fact', 'Project uses TypeScript', { source: 'agent' });
    const all = memoryStore.getAll();
    expect(all).toHaveLength(1);
    expect(second).not.toBeNull();
    memoryStore.clear();
  });
});
