// BLAXIN transport policy — unit tests
// =============================================================
// The rule that closes the documented plaintext-MITM gap: a non-loopback
// Brain must be reached over wss:// with certificate validation, unless
// an explicit dev override is set. ws:// survives only for loopback
// development.
// =============================================================

import { describe, it, expect } from 'vitest';
import {
  classifyBrainUrl, isLoopbackHost, validateBrainUrl,
  PLAINTEXT_REMOTE_ERROR,
} from '../../distributed/transport-policy.js';
import { looksLikeTlsFailure } from '../../distributed/body-link.js';

describe('brain URL transport policy', () => {
  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('foo.localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackHost('192.168.0.106')).toBe(false);
    expect(isLoopbackHost('brain.example.com')).toBe(false);
  });

  it('accepts wss:// anywhere (loopback and remote)', () => {
    for (const url of [
      'wss://127.0.0.1:3100/ws/brain',
      'wss://192.168.0.106:3100/ws/brain',
      'wss://brain.example.com:3100/ws/brain',
    ]) {
      const v = validateBrainUrl(url);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.info.scheme).toBe('wss');
    }
  });

  it('allows ws:// on loopback for development', () => {
    for (const url of [
      'ws://127.0.0.1:3100/ws/brain',
      'ws://localhost:3100/ws/brain',
      'ws://127.0.0.2:3100/ws/brain',
      'ws://[::1]:3100/ws/brain',
    ]) {
      expect(validateBrainUrl(url).ok).toBe(true);
    }
  });

  it('REFUSES plaintext ws:// to a non-loopback Brain (the MITM fix)', () => {
    for (const url of [
      'ws://192.168.0.106:3100/ws/brain',
      'ws://brain.example.com:3100/ws/brain',
    ]) {
      const v = validateBrainUrl(url);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.code).toBe('PLAINTEXT_REMOTE');
        expect(v.error).toContain('wss://');
        expect(v.error).toBe(PLAINTEXT_REMOTE_ERROR);
      }
    }
  });

  it('honours the explicit development override', () => {
    const v = validateBrainUrl('ws://192.168.0.106:3100/ws/brain', { allowInsecure: true });
    expect(v.ok).toBe(true);
  });

  it('rejects non-ws schemes and malformed URLs', () => {
    expect(classifyBrainUrl('http://192.168.0.106:3100').ok).toBe(false);
    expect(classifyBrainUrl('ftp://x').ok).toBe(false);
    expect(classifyBrainUrl('not a url').ok).toBe(false);
  });

  it('rejects embedded credentials in the URL', () => {
    const v = classifyBrainUrl('wss://user:secret@brain.example.com:3100/ws/brain');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('CREDENTIALS_IN_URL');
  });

  it('exposes the scheme + loopback classification', () => {
    const v = classifyBrainUrl('WSS://Brain.Example.com:3100/ws/brain');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.info.scheme).toBe('wss');
      expect(v.info.loopback).toBe(false);
      expect(v.info.hostname).toBe('brain.example.com');
    }
  });

  it('classifies TLS certificate failures as terminal (never a transient blip)', () => {
    expect(looksLikeTlsFailure('self-signed certificate')).toBe(true);
    expect(looksLikeTlsFailure('unable to verify the first certificate')).toBe(true);
    expect(looksLikeTlsFailure('Hostname/IP does not match certificate altnames')).toBe(true);
    expect(looksLikeTlsFailure('certificate has expired')).toBe(true);
    expect(looksLikeTlsFailure('connect ECONNREFUSED 127.0.0.1:3100')).toBe(false);
    expect(looksLikeTlsFailure('getaddrinfo ENOTFOUND brain.example.com')).toBe(false);
    expect(looksLikeTlsFailure('socket hang up')).toBe(false);
  });
});
