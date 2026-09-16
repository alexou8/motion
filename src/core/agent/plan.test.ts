import { describe, expect, it } from 'vitest';
import { parseAgentResponse } from './plan';

describe('parseAgentResponse', () => {
  it('parses a clean JSON object', () => {
    const raw = JSON.stringify({
      reply: 'Sure, I will get started.',
      plan: [{ title: 'Read instructions', call: { tool: 'read_assignment_instructions' } }],
    });
    const result = parseAgentResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.reply).toBe('Sure, I will get started.');
      expect(result.response.plan).toHaveLength(1);
      expect(result.droppedSteps).toBe(0);
    }
  });

  it('extracts JSON from a fenced code block with leading prose', () => {
    const raw = `Sure, here's the plan:\n\n\`\`\`json\n${JSON.stringify({
      reply: 'ok',
      plan: [],
    })}\n\`\`\`\nLet me know if that works.`;
    const result = parseAgentResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.reply).toBe('ok');
  });

  it('extracts a bare JSON object surrounded by prose with no fence', () => {
    const raw = `Thinking... ${JSON.stringify({ reply: 'ok', plan: [] })} done.`;
    const result = parseAgentResponse(raw);
    expect(result.ok).toBe(true);
  });

  it('never throws on garbage input', () => {
    expect(() => parseAgentResponse('')).not.toThrow();
    expect(() => parseAgentResponse('not json at all')).not.toThrow();
    expect(() => parseAgentResponse('{"reply": "unterminated')).not.toThrow();
    expect(parseAgentResponse('').ok).toBe(false);
    expect(parseAgentResponse('not json at all').ok).toBe(false);
  });

  it('drops an individual step with an unknown tool while keeping the rest', () => {
    const raw = JSON.stringify({
      reply: 'ok',
      plan: [
        { title: 'Good step', call: { tool: 'read_assignment_instructions' } },
        { title: 'Bad step', call: { tool: 'delete_everything' } },
      ],
    });
    const result = parseAgentResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.plan).toHaveLength(1);
      expect(result.response.plan[0]!.title).toBe('Good step');
      expect(result.droppedSteps).toBe(1);
    }
  });

  it('drops a step whose call carries forged extra fields', () => {
    const raw = JSON.stringify({
      reply: 'ok',
      plan: [{ title: 'Click submit', call: { tool: 'click', tabRef: 'T1', handle: 'e1', url: 'https://evil.example' } }],
    });
    const result = parseAgentResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.plan).toHaveLength(0);
      expect(result.droppedSteps).toBe(1);
    }
  });

  it('rejects a response missing reply entirely', () => {
    const result = parseAgentResponse(JSON.stringify({ plan: [] }));
    expect(result.ok).toBe(false);
  });

  it('truncates a plan beyond 8 steps', () => {
    const plan = Array.from({ length: 10 }, (_, i) => ({
      title: `Step ${i}`,
      call: { tool: 'summarize_sources' },
    }));
    const result = parseAgentResponse(JSON.stringify({ reply: 'ok', plan }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.plan.length).toBeLessThanOrEqual(8);
  });
});
