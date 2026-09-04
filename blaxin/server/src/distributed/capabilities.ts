// BLAXIN body capabilities
// =============================================================
// A Body advertises the capabilities it can actually execute. The
// Brain MUST NOT assume a capability exists: it checks the Body's
// advertised set before requesting an action, and the Body re-checks
// on every action. Unsupported actions are rejected safely.
//
// Capability ↔ tool mapping (mirrors the body tool registry; the
// registry is the authority at runtime — this table is only used to
// derive the advertised capability list).
// =============================================================

import {
  BodyCapability, CapabilitySet, KNOWN_CAPABILITIES,
} from './types.js';

/** Canonical tool name → capability that provides it. */
export const TOOL_TO_CAPABILITY: Record<string, BodyCapability> = {
  'filesystem': 'filesystem',
  'terminal': 'terminal',
  'browser': 'browser',
  'screenshot': 'screenshot',
  'computer-control': 'computer-control',
  'clipboard': 'clipboard',
  'search': 'search',
  'system-info': 'system-info',
};

export const CAPABILITY_TO_TOOLS: Record<BodyCapability, string[]> = {
  'filesystem': ['filesystem'],
  'terminal': ['terminal'],
  'browser': ['browser'],
  'screenshot': ['screenshot'],
  'computer-control': ['computer-control'],
  'microphone': [],   // reserved: no microphone tool on this build yet
  'camera': [],       // reserved
  'clipboard': ['clipboard'],
  'search': ['search'],
  'system-info': ['system-info'],
};

/** Derive the capability set from a list of enabled tool names. */
export function capabilitiesFromTools(toolNames: Iterable<string>): CapabilitySet {
  const seen = new Set<string>();
  const out: CapabilitySet = [];
  for (const name of toolNames) {
    const cap = TOOL_TO_CAPABILITY[name];
    if (cap && !seen.has(cap)) {
      seen.add(cap);
      out.push(cap);
    }
  }
  return out;
}

/** True when the body advertised the capability. */
export function hasCapability(caps: CapabilitySet, cap: BodyCapability): boolean {
  return caps.includes(cap);
}

/** Does a requested tool name map onto an advertised capability? */
export function toolAllowedByCapabilities(
  caps: CapabilitySet,
  toolName: string,
): boolean {
  const cap = TOOL_TO_CAPABILITY[toolName];
  return cap !== undefined && caps.includes(cap);
}

/** Human-readable listing (for /capabilities endpoints). */
export function describeCapabilities(caps: CapabilitySet): Array<{ id: string; available: boolean }> {
  return KNOWN_CAPABILITIES.map((c) => ({
    id: c,
    available: caps.includes(c),
  }));
}
