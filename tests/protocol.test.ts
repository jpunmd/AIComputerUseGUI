import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  COMPUTER_TOOL,
  SIMPLE_COMPUTER_TOOL,
  SIMPLE_RULES,
  SYSTEM_RULES,
} from '../src/agent/protocol';
import { DEFAULT_SYSTEM_PROMPT } from '../src/hooks/useSettings';
import { parseProgress } from '../src/agent/taskSchema';
import { TaskMemory } from '../src/agent/memory';
import qwenResponses from './fixtures/qwen-progress.json';

describe('model wire instructions', () => {
  it('accepts actual local Qwen responses across an input and its observed result', () => {
    // Recorded from text-only simulated screen states; no desktop input was sent.
    const memory = new TaskMemory();
    memory.start('Find the weather in Philadelphia and San Diego', true);
    memory.observe('first-screen');
    memory.setPlan('Open Chrome browser\nSearch for weather in Philadelphia');
    expect(memory.prompt('Continue')).not.toContain('Required response field');
    for (const [index, response] of qwenResponses.entries()) {
      memory.observe('next-screen-' + index);
      const call = JSON.parse(response.replace(/<\/?tool_call>/g, ''));
      const { action, progress, ...args } = call.arguments;
      memory.applyProgress(progress);
      const input = { action, arguments: args };
      memory.submitted(input, memory.actionContext(input, progress));
      expect(memory.prompt('Continue')).toContain('arguments.progress.outcome');
    }
    expect(memory.task!.plan[0].status).toBe('completed');
    expect(memory.task!.receipts[0].outcome).toBe('succeeded');
    expect(memory.task!.receipts[1].outcome).toBe('unverified');
  });
  it('replaces stale saved tool definitions while preserving custom instructions', () => {
    for (const saved of [
      DEFAULT_SYSTEM_PROMPT,
      'Use Firefox.\n<tools>{"old":"schema"}</tools>',
      'Use Firefox.',
    ]) {
      const prompt = buildSystemPrompt(saved);
      const definitions = [...prompt.matchAll(/<tools>([\s\S]*?)<\/tools>/g)];
      expect(definitions).toHaveLength(1);
      expect(JSON.parse(definitions[0][1])).toEqual(COMPUTER_TOOL);
      expect(prompt).not.toContain('"old":"schema"');
      if (saved.includes('Firefox')) expect(prompt).toContain('Use Firefox.');
    }
  });

  it('provides complete JSON examples whose progress the controller accepts', () => {
    const examples = [
      ...SYSTEM_RULES.matchAll(/<tool_call>(.*?)<\/tool_call>/g),
    ];
    expect(examples).toHaveLength(2);
    for (const [, json] of examples) {
      const call = JSON.parse(json);
      expect(call.name).toBe('computer');
      expect(() => parseProgress(call.arguments.progress)).not.toThrow();
      expect(call).not.toHaveProperty('progress');
    }
  });

  it('simple format examples use only fields from the flat schema', () => {
    const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, true);
    const definitions = [...prompt.matchAll(/<tools>([\s\S]*?)<\/tools>/g)];
    expect(definitions).toHaveLength(1);
    expect(JSON.parse(definitions[0][1])).toEqual(SIMPLE_COMPUTER_TOOL);
    const fields = Object.keys(SIMPLE_COMPUTER_TOOL.function.parameters.properties);
    expect(fields).not.toContain('progress');
    const examples = [...SIMPLE_RULES.matchAll(/<tool_call>(.*?)<\/tool_call>/g)];
    expect(examples).toHaveLength(2);
    for (const [, json] of examples) {
      const call = JSON.parse(json);
      expect(call.name).toBe('computer');
      for (const key of Object.keys(call.arguments)) expect(fields).toContain(key);
    }
  });
});
