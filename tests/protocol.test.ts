import { describe, expect, it } from 'vitest';
import {
  BASE_PROMPT,
  BOX_CLICK_RULE,
  buildSystemPrompt,
  COMPUTER_TOOL,
  SYSTEM_RULES,
} from '../src/agent/protocol';
import { migrateSystemPrompt, sanitizeSettings } from '../src/hooks/useSettings';
import { parsePlan } from '../src/agent/taskSchema';

// What the Rust client does to the prompt when the server constrains output
// to JSON (protocol.rs structured_prompt).
const constrained = (prompt: string) =>
  prompt.replaceAll('<tool_call>', '').replaceAll('</tool_call>', '');

describe('model wire instructions', () => {
  it('always sends the one current tool definition and keeps user instructions', () => {
    for (const extra of [
      '',
      'Use Firefox.\n<tools>{"old":"schema"}</tools>',
      'Use Firefox.',
    ]) {
      const prompt = buildSystemPrompt(extra);
      expect(prompt.startsWith(BASE_PROMPT)).toBe(true);
      const definitions = [...prompt.matchAll(/<tools>([\s\S]*?)<\/tools>/g)];
      expect(definitions).toHaveLength(1);
      expect(JSON.parse(definitions[0][1])).toEqual(COMPUTER_TOOL);
      expect(prompt).not.toContain('"old":"schema"');
      if (extra)
        expect(prompt).toContain(
          'Additional instructions from the user:\nUse Firefox.',
        );
      else expect(prompt).not.toContain('Additional instructions');
    }
    expect(buildSystemPrompt('', { boxClicks: true }).endsWith(BOX_CLICK_RULE)).toBe(
      true,
    );
  });

  it('has no transport wording that JSON-constrained output would contradict', () => {
    const prompt = constrained(buildSystemPrompt('Use Firefox.'));
    expect(prompt).not.toMatch(/tags/i);
    expect(prompt).not.toMatch(/already completed/i);
    // Stripped examples remain valid JSON actions.
    const examples = prompt
      .split('\n')
      .filter((line) => line.startsWith('{"name":"computer"'));
    expect(examples).toHaveLength(3);
    for (const line of examples) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('migrates saved prompts: defaults are dropped, custom text is kept', () => {
    expect(
      migrateSystemPrompt(
        'You are a desktop control agent. Your sole purpose...\n<tools>{}</tools>',
      ),
    ).toBe('');
    expect(migrateSystemPrompt('Use Firefox.\n<tools>{"old":1}</tools>')).toBe(
      'Use Firefox.',
    );
    expect(migrateSystemPrompt(undefined)).toBe('');
    const settings = sanitizeSettings({ systemPrompt: 'Be brief.' });
    expect(settings.extraInstructions).toBe('Be brief.');
    expect(settings).not.toHaveProperty('systemPrompt');
    // Once migrated, the saved field wins over any leftover legacy prompt.
    expect(
      sanitizeSettings({ systemPrompt: 'old', extraInstructions: '' })
        .extraInstructions,
    ).toBe('');
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
