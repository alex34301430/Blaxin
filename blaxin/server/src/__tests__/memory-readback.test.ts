import { describe, it, expect } from 'vitest';
import { AgentOrchestrator } from '../orchestrator/index.js';
import { buildFakes, FakeProvider } from './helpers/orchestrator-fakes.js';

// Durable memory must actually reach the model: preferences/facts/lessons
// recorded in earlier tasks are read back into the system prompt (framed
// as background data), and an empty store injects nothing.

interface Ev { event: string; data: any }

function makeOrchestrator(fakes: ReturnType<typeof buildFakes>, events: Ev[]) {
  const orch = new AgentOrchestrator({
    providers: fakes.providers,
    toolRegistry: fakes.tools,
    sessionState: fakes.session,
    memoryStore: fakes.memory,
    getConfig: () => fakes.config,
  });
  orch.setEventCallback((event, data) => events.push({ event, data }));
  return orch;
}

describe('memory read-back into the agent prompt', () => {
  it('includes durable memory in the system prompt when entries exist', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({ content: 'Done.' });

    // Seed durable memory from an earlier session/task.
    fakes.memory.entries.push(
      { type: 'preference', content: 'User prefers terse replies', source: 'user', lastUsedAt: Date.now() },
      { type: 'action-result', content: 'Task failed: push — auth expired', source: 'agent', lastUsedAt: Date.now() - 1000 },
    );

    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    await orch.processMessage('please handle this task');

    const system = provider.lastMessages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toContain('REMEMBERED CONTEXT');
    expect(system!.content).toContain('[preference] User prefers terse replies');
    expect(system!.content).toContain('[lesson] Task failed: push — auth expired');
  });

  it('injects nothing when the store is empty', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({ content: 'Done.' });

    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    await orch.processMessage('please handle this task');

    const system = provider.lastMessages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).not.toContain('REMEMBERED CONTEXT');
  });
});
