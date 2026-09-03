import { describe, it, expect } from 'vitest';
import {
  isOriginAllowed,
  isStateChangingRequestAllowed,
  normalizeOrigin,
} from '../utils/security.js';

describe('origin allowlist', () => {
  it('allows non-browser clients (no Origin header)', () => {
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed('')).toBe(true);
    expect(isOriginAllowed('null')).toBe(true);
  });

  it('allows the Tauri desktop origins', () => {
    expect(isOriginAllowed('tauri://localhost')).toBe(true);
    expect(isOriginAllowed('http://tauri.localhost')).toBe(true);
    expect(isOriginAllowed('https://tauri.localhost')).toBe(true);
  });

  it('allows localhost and loopback origins on any port', () => {
    expect(isOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isOriginAllowed('http://localhost:80')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3001')).toBe(true);
    expect(isOriginAllowed('http://localhost')).toBe(true);
  });

  it('rejects arbitrary web origins by default', () => {
    expect(isOriginAllowed('https://evil.example.com')).toBe(false);
    expect(isOriginAllowed('http://192.168.1.10:8080')).toBe(false);
  });

  it('honours explicit extra allowed origins', () => {
    expect(isOriginAllowed('https://blaxin.example.com', ['https://blaxin.example.com'])).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', ['https://blaxin.example.com'])).toBe(false);
  });

  it('supports wildcard hosts in extra origins', () => {
    expect(isOriginAllowed('https://app.blaxin.example.com', ['https://*.blaxin.example.com'])).toBe(true);
  });

  it('supports the documented open deployment escape hatch', () => {
    expect(isOriginAllowed('https://anything.example.com', ['*'])).toBe(true);
  });

  it('normalizes trailing slashes', () => {
    expect(normalizeOrigin('https://blaxin.example.com/')).toBe('https://blaxin.example.com');
  });
});

describe('isStateChangingRequestAllowed (HTTP guard policy)', () => {
  it('allows state-changing requests from non-browser clients (no Origin)', () => {
    // curl, local scripts and the Node server itself send no Origin header.
    // Browsers always attach Origin to non-GET requests, so this branch
    // cannot be reached by a malicious web page.
    expect(isStateChangingRequestAllowed('POST', undefined)).toBe(true);
    expect(isStateChangingRequestAllowed('PUT', '')).toBe(true);
  });

  it('blocks state-changing requests from untrusted browser origins', () => {
    expect(isStateChangingRequestAllowed('POST', 'https://evil.example.com')).toBe(false);
    expect(isStateChangingRequestAllowed('DELETE', 'https://attacker.test')).toBe(false);
  });

  it('allows state-changing requests from localhost / tauri origins', () => {
    expect(isStateChangingRequestAllowed('POST', 'http://localhost:5173')).toBe(true);
    expect(isStateChangingRequestAllowed('POST', 'tauri://localhost')).toBe(true);
  });

  it('honours explicit extra origins from BLAXIN_ALLOWED_ORIGINS', () => {
    expect(isStateChangingRequestAllowed('POST', 'https://blaxin.example.com', ['https://blaxin.example.com'])).toBe(true);
    expect(isStateChangingRequestAllowed('POST', 'https://evil.example.com', ['https://blaxin.example.com'])).toBe(false);
  });

  it('always allows read-only methods regardless of origin', () => {
    expect(isStateChangingRequestAllowed('GET', 'https://evil.example.com')).toBe(true);
    expect(isStateChangingRequestAllowed('OPTIONS', 'https://evil.example.com')).toBe(true);
  });
});
