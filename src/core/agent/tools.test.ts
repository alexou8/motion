import { describe, expect, it } from 'vitest';
import { toolCallSchema, TOOL_ACTION, actionForTool } from './tools';

describe('toolCallSchema', () => {
  it('accepts a well-formed call for every tool', () => {
    const samples: unknown[] = [
      { tool: 'open_assignment_resources' },
      { tool: 'open_assignment_resources', taskRef: 'task-1' },
      { tool: 'open_course_page', page: 'assignments' },
      { tool: 'open_link', linkRef: 'L1' },
      { tool: 'read_page', tabRef: 'T1' },
      { tool: 'read_assignment_instructions' },
      { tool: 'read_rubric', linkRef: 'L2' },
      { tool: 'build_checklist' },
      { tool: 'create_note', title: 'Notes', text: 'hello' },
      { tool: 'draft', kind: 'outline' },
      { tool: 'review_draft' },
      { tool: 'summarize_sources' },
      { tool: 'list_deadlines', range: 'week' },
      { tool: 'snapshot_tab', tabRef: 'T1' },
      { tool: 'fill_field', tabRef: 'T1', handle: 'e1', value: 'hi' },
      { tool: 'select_option', tabRef: 'T1', handle: 'e1', value: 'opt' },
      { tool: 'toggle_control', tabRef: 'T1', handle: 'e1', checked: true },
      { tool: 'click', tabRef: 'T1', handle: 'e1' },
      { tool: 'save_discussion_draft', tabRef: 'T1', handle: 'e1', text: 'reply' },
      { tool: 'submit_assignment', tabRef: 'T1', handle: 'e1' },
      { tool: 'post_discussion', tabRef: 'T1', handle: 'e1' },
    ];
    for (const sample of samples) {
      const result = toolCallSchema.safeParse(sample);
      expect(result.success, JSON.stringify(sample)).toBe(true);
    }
  });

  it('rejects an unknown tool name', () => {
    const result = toolCallSchema.safeParse({ tool: 'delete_everything' });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields smuggling a url, selector, or script', () => {
    const withUrl = toolCallSchema.safeParse({ tool: 'open_link', linkRef: 'L1', url: 'https://evil.example' });
    const withSelector = toolCallSchema.safeParse({ tool: 'click', tabRef: 'T1', handle: 'e1', selector: '#submit' });
    const withScript = toolCallSchema.safeParse({
      tool: 'fill_field',
      tabRef: 'T1',
      handle: 'e1',
      value: 'x',
      script: 'alert(1)',
    });
    expect(withUrl.success).toBe(false);
    expect(withSelector.success).toBe(false);
    expect(withScript.success).toBe(false);
  });

  it('rejects tab ids passed in place of a tabRef-shaped string', () => {
    const result = toolCallSchema.safeParse({ tool: 'read_page', tabRef: '' });
    expect(result.success).toBe(false);
  });

  it('bounds string field lengths', () => {
    const tooLong = 'x'.repeat(20_001);
    const result = toolCallSchema.safeParse({ tool: 'create_note', title: 'ok', text: tooLong });
    expect(result.success).toBe(false);
  });

  it('every tool has a mapped policy action', () => {
    for (const [tool, action] of Object.entries(TOOL_ACTION)) {
      expect(actionForTool(tool as never)).toBe(action);
    }
  });
});
