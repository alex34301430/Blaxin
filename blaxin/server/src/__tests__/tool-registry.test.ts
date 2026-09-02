import { describe, it, expect } from 'vitest';
import { toolRegistry } from '../tools/index.js';

describe('ToolRegistry', () => {
  it('should have all tools registered', () => {
    const tools = toolRegistry.getAllTools();
    
    expect(tools.length).toBeGreaterThan(0);
    
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('terminal');
    expect(toolNames).toContain('filesystem');
    expect(toolNames).toContain('screenshot');
    expect(toolNames).toContain('computer-control');
    expect(toolNames).toContain('browser');
    expect(toolNames).toContain('clipboard');
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('system-info');
  });

  it('should return tool definitions', () => {
    const definitions = toolRegistry.getToolDefinitions();
    
    expect(definitions.length).toBeGreaterThan(0);
    expect(definitions[0]).toHaveProperty('type', 'function');
    expect(definitions[0]).toHaveProperty('function');
    expect(definitions[0].function).toHaveProperty('name');
    expect(definitions[0].function).toHaveProperty('description');
    expect(definitions[0].function).toHaveProperty('parameters');
  });

  it('should enable/disable tools', () => {
    const initialStatus = toolRegistry.getEnabledStatus();
    expect(initialStatus['terminal']).toBe(true);
    
    toolRegistry.setEnabled('terminal', false);
    expect(toolRegistry.getEnabledStatus()['terminal']).toBe(false);
    
    toolRegistry.setEnabled('terminal', true);
    expect(toolRegistry.getEnabledStatus()['terminal']).toBe(true);
  });

  it('should not return disabled tools in getAllTools', () => {
    toolRegistry.setEnabled('clipboard', false);
    
    const tools = toolRegistry.getAllTools();
    const toolNames = tools.map(t => t.name);
    expect(toolNames).not.toContain('clipboard');
    
    // Restore
    toolRegistry.setEnabled('clipboard', true);
  });

  it('should detect dangerous terminal commands', () => {
    const terminalTool = toolRegistry.getTool('terminal');
    expect(terminalTool).toBeDefined();
    
    // Dangerous commands should require confirmation
    expect(terminalTool!.requiresConfirmation!({ command: 'rm -rf /' })).toBe(true);
    expect(terminalTool!.requiresConfirmation!({ command: 'sudo rm -rf /home' })).toBe(true);
    expect(terminalTool!.requiresConfirmation!({ command: 'mkfs.ext4 /dev/sda' })).toBe(true);
    
    // Safe commands should not require confirmation
    expect(terminalTool!.requiresConfirmation!({ command: 'ls -la' })).toBe(false);
    expect(terminalTool!.requiresConfirmation!({ command: 'cat file.txt' })).toBe(false);
  });

  it('should return error for unknown tool', async () => {
    const result = await toolRegistry.execute('nonexistent-tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('should return error for disabled tool', async () => {
    toolRegistry.setEnabled('clipboard', false);
    
    const result = await toolRegistry.execute('clipboard', { action: 'read' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
    
    // Restore
    toolRegistry.setEnabled('clipboard', true);
  });
});
