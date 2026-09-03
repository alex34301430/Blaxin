import { describe, it, expect } from 'vitest';
import { ChatMessage } from '../types.js';
import {
  toOpenAICompatibleMessages,
  toAnthropicMessages,
  toGeminiMessages,
  toOllamaMessages,
} from '../providers/messages.js';

function msg(partial: Partial<ChatMessage> & { id: string; role: ChatMessage['role']; content: string }): ChatMessage {
  return { timestamp: Date.now(), ...partial } as ChatMessage;
}

const user: ChatMessage = msg({ id: 'u1', role: 'user', content: 'List my files' });
const assistantWithTools: ChatMessage = msg({
  id: 'a1',
  role: 'assistant',
  content: 'I will list the files.',
  toolCalls: [
    { id: 'call_1', type: 'function', function: { name: 'filesystem', arguments: JSON.stringify({ operation: 'list', path: '/home' }) } },
    { id: 'call_2', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'ls -la' }) } },
  ],
});
const toolResult1: ChatMessage = msg({ id: 't1', role: 'tool', toolCallId: 'call_1', name: 'filesystem', content: '[DIR] home' });
const toolResult2: ChatMessage = msg({ id: 't2', role: 'tool', toolCallId: 'call_2', name: 'terminal', content: 'drwxr-xr-x' });

describe('toOpenAICompatibleMessages', () => {
  it('maps assistant tool_calls and matching tool results', () => {
    const out = toOpenAICompatibleMessages([user, assistantWithTools, toolResult1, toolResult2]);

    expect(out[0]).toEqual({ role: 'user', content: 'List my files' });
    const asst = out[1];
    expect(asst.role).toBe('assistant');
    expect(asst.tool_calls).toHaveLength(2);
    expect(asst.tool_calls[0].id).toBe('call_1');
    expect(asst.tool_calls[0].function.name).toBe('filesystem');
    expect(JSON.parse(asst.tool_calls[0].function.arguments).operation).toBe('list');

    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '[DIR] home' });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'drwxr-xr-x' });
  });

  it('preserves system messages at the front', () => {
    const system = msg({ id: 's1', role: 'system', content: 'You are BLAXIN' });
    const out = toOpenAICompatibleMessages([system, user]);
    expect(out[0]).toEqual({ role: 'system', content: 'You are BLAXIN' });
  });
});

describe('toAnthropicMessages', () => {
  it('turns tool results into tool_result blocks inside a user message', () => {
    const { system, messages } = toAnthropicMessages([user, assistantWithTools, toolResult1, toolResult2]);

    expect(system).toBeUndefined();
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');

    const asstContent = messages[1].content as Array<Record<string, unknown>>;
    expect(asstContent).toHaveLength(3); // text + 2 tool_use blocks
    expect(asstContent[0]).toMatchObject({ type: 'text', text: 'I will list the files.' });
    expect(asstContent[1]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'filesystem' });

    const finalUser = messages[2].content as Array<Record<string, unknown>>;
    expect(finalUser).toHaveLength(2);
    expect(finalUser[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: '[DIR] home' });
    expect(finalUser[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_2', content: 'drwxr-xr-x' });
  });

  it('separates the system prompt', () => {
    const system = msg({ id: 's1', role: 'system', content: 'You are BLAXIN' });
    const { system: sys, messages } = toAnthropicMessages([system, user]);
    expect(sys).toBe('You are BLAXIN');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('handles tool results as the final history entries', () => {
    const { messages } = toAnthropicMessages([assistantWithTools, toolResult1]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'user' });
  });
});

describe('toGeminiMessages', () => {
  it('maps functionCall and functionResponse parts', () => {
    const { contents } = toGeminiMessages([user, assistantWithTools, toolResult1]);

    expect(contents[0]).toMatchObject({ role: 'user', parts: [{ text: 'List my files' }] });
    const model = contents[1];
    expect(model.role).toBe('model');
    expect(model.parts[0]).toEqual({ text: 'I will list the files.' });
    expect(model.parts[1]).toMatchObject({ functionCall: { name: 'filesystem' } });

    const toolTurn = contents[2];
    expect(toolTurn.role).toBe('user');
    expect(toolTurn.parts[0]).toMatchObject({ functionResponse: { name: 'filesystem' } });
  });

  it('merges consecutive tool results into a single user turn', () => {
    const { contents } = toGeminiMessages([assistantWithTools, toolResult1, toolResult2]);
    expect(contents.filter((c) => c.role === 'user')).toHaveLength(1);
    expect(contents[0].parts).toHaveLength(3); // text + 2 functionCalls
    expect(contents[1].parts).toHaveLength(2); // 2 functionResponses
  });
});

describe('toOllamaMessages', () => {
  it('omits the outer type on tool_calls and keeps tool role results', () => {
    const out = toOllamaMessages([assistantWithTools, toolResult1]);
    expect(out[0].tool_calls[0]).toMatchObject({ function: { name: 'filesystem' } });
    expect(out[0].tool_calls[0].function.arguments).toMatchObject({ operation: 'list' });
    expect(out[0].tool_calls[0].type).toBeUndefined();
    expect(out[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });
});
