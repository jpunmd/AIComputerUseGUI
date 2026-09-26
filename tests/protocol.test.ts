import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  COMPUTER_TOOL,
  SYSTEM_RULES,
} from '../src/agent/protocol';
import { DEFAULT_SYSTEM_PROMPT } from '../src/hooks/useSettings';
import { parsePlan } from '../src/agent/taskSchema';

describe('model wire instructions', () => {
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

  it('is flat: examples use only schema fields and nest no deeper than a string list', () => {
    const fields = Object.keys(COMPUTER_TOOL.function.parameters.properties);
    expect(fields).not.toContain('progress');
    expect(buildSystemPrompt('x')).not.toContain('progress');
    const examples = [...SYSTEM_RULES.matchAll(/<tool_call>(.*?)<\/tool_call>/g)];
    expect(examples).toHaveLength(3);
    for (const [, json] of examples) {
      const call = JSON.parse(json);
      expect(call.name).toBe('computer');
      for (const [key, value] of Object.entries(call.arguments)) {
        expect(fields).toContain(key);
        if (Array.isArray(value))
          expect(value.every((v) => typeof v !== 'object')).toBe(true);
        else expect(typeof value === 'object' && value !== null).toBe(false);
      }
    }
  });

  it('examples list fields in schema order, which constrained decoding enforces', () => {
    const order = Object.keys(COMPUTER_TOOL.function.parameters.properties);
    for (const [, json] of SYSTEM_RULES.matchAll(/<tool_call>(.*?)<\/tool_call>/g)) {
      const positions = Object.keys(JSON.parse(json).arguments).map((k) =>
        order.indexOf(k),
      );
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it('routes answers through done, which the controller verifies, not none', () => {
    expect(SYSTEM_RULES).toContain('done: text (the answer or result');
    expect(SYSTEM_RULES).not.toMatch(/none: text \([^)]*answer/);
    expect(SYSTEM_RULES).toContain('one fresh screenshot to confirm');
  });

  it('the plan example parses into steps with success conditions', () => {
    const plan = [...SYSTEM_RULES.matchAll(/<tool_call>(.*?)<\/tool_call>/g)]
      .map(([, json]) => JSON.parse(json).arguments)
      .find((args) => args.action === 'plan');
    expect(parsePlan(plan.steps).steps).toEqual([
      { title: 'Open Chrome', successCriteria: 'a Chrome window is visible' },
      {
        title: 'Search for weather Philadelphia',
        successCriteria: 'the forecast is shown',
      },
    ]);
  });
});
