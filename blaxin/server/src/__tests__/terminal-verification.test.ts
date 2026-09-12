import { describe, it, expect } from 'vitest';
import { TerminalTool } from '../tools/terminal.js';

// Verification-in-depth (§12): the terminal tool must distinguish
// ACTION EXECUTED (exit 0) from ACTION FAILED (nonzero/timeout) —
// never report success merely because a command produced output.

describe('terminal exit-code verification', () => {
  const tool = new TerminalTool();

  it('exit 0 with stdout is a success and reports exitCode 0', async () => {
    const r = await tool.execute({ command: 'echo hello' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('hello');
    expect((r.data as any)?.exitCode).toBe(0);
  });

  it('nonzero exit code is a FAILURE even when stdout exists (grep -q pattern)', async () => {
    // grep -q prints nothing on no-match and exits 1 — the old code saw
    // "no stdout, no stderr" as an oddity but exited success on stdout-only.
    const r = await tool.execute({ command: 'echo something | grep -q NOPE; echo before-fail; false' });
    expect(r.success).toBe(false);
    expect((r.data as any)?.exitCode).toBe(1);
    expect(r.error).toContain('exit code 1');
  });

  it('failing command with stdout reports the real code, stdout kept for diagnosis', async () => {
    const r = await tool.execute({ command: 'echo partial-output; exit 3' });
    expect(r.success).toBe(false);
    expect((r.data as any)?.exitCode).toBe(3);
    expect(r.output).toContain('partial-output');
  });

  it('timeout kill is an honest failure (never success)', async () => {
    const r = await tool.execute({ command: 'echo started; sleep 5', timeout: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('did not complete');
    expect(r.error).toContain('timed out');
  });

  it('spawn errors (missing binary) remain failures with diagnostics', async () => {
    const r = await tool.execute({ command: 'definitely-not-a-real-binary-xyz' });
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('dangerous commands still require confirmation', () => {
    expect(tool.requiresConfirmation({ command: 'sudo rm -rf /tmp/x' })).toBe(true);
    expect(tool.requiresConfirmation({ command: 'ls -la' })).toBe(false);
  });
});
