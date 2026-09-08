import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '../orchestrator/index.js';
import { BRAIN_SYSTEM_PROMPT } from '../distributed/brain-drivers.js';

// The prompt-injection boundary is a security invariant: tool output and
// external content must be treated as untrusted DATA, never instructions.
// These tests fail loudly if either prompt ever loses that guarantee.

describe('prompt injection boundary', () => {
  const prompts = [
    { name: 'orchestrator SYSTEM_PROMPT', prompt: SYSTEM_PROMPT },
    { name: 'brain BRAIN_SYSTEM_PROMPT', prompt: BRAIN_SYSTEM_PROMPT },
  ];

  for (const { name, prompt } of prompts) {
    describe(name, () => {
      it('labels external/tool content as untrusted data', () => {
        expect(prompt.toLowerCase()).toMatch(/untrusted data/);
      });

      it('forbids following instructions embedded in external content', () => {
        expect(prompt.toLowerCase()).toContain('ignore previous instructions');
      });

      it('states external content cannot override user instruction or policy', () => {
        const lower = prompt.toLowerCase();
        expect(lower).toMatch(/external content/);
        expect(lower).toMatch(/override/);
        expect(lower).toMatch(/never|can't|cannot/);
      });

      it('forbids revealing secrets regardless of external claims', () => {
        expect(prompt.toLowerCase()).toMatch(/never expose|never reveal/);
      });
    });
  }
});