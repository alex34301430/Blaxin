import { describe, it, expect } from 'vitest';
import {
  capabilitiesFromTools, hasCapability, toolAllowedByCapabilities,
  describeCapabilities,
} from '../../distributed/capabilities.js';
import type { CapabilitySet } from '../../distributed/types.js';

describe('body capabilities', () => {
  it('derives the advertised capability set from enabled tool names', () => {
    const caps = capabilitiesFromTools(['filesystem', 'terminal', 'screenshot', 'unknown-tool']);
    expect(caps).toContain('filesystem');
    expect(caps).toContain('terminal');
    expect(caps).toContain('screenshot');
    expect(caps).not.toContain('unknown-tool');
    expect(caps).not.toContain('camera'); // reserved capabilities never auto-advertised
  });

  it('reports membership', () => {
    const caps: CapabilitySet = ['filesystem', 'browser'];
    expect(hasCapability(caps, 'filesystem')).toBe(true);
    expect(hasCapability(caps, 'terminal')).toBe(false);
  });

  it('maps a requested tool onto an advertised capability', () => {
    const caps: CapabilitySet = ['filesystem'];
    expect(toolAllowedByCapabilities(caps, 'filesystem')).toBe(true);
    expect(toolAllowedByCapabilities(caps, 'terminal')).toBe(false);
    expect(toolAllowedByCapabilities(caps, 'mystery-tool')).toBe(false);
    const caps2: CapabilitySet = ['filesystem', 'terminal'];
    expect(toolAllowedByCapabilities(caps2, 'terminal')).toBe(true);
  });

  it('lists the canonical capability table with availability', () => {
    const listing = describeCapabilities(['filesystem'] as CapabilitySet);
    const fs = listing.find((c) => c.id === 'filesystem');
    const cam = listing.find((c) => c.id === 'camera');
    expect(fs?.available).toBe(true);
    expect(cam?.available).toBe(false);
  });
});
