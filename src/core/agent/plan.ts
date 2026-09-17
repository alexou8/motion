import { z } from 'zod';
import { toolCallSchema, type ToolCall } from './tools';

/**
 * The model's structured response shape (VISION §20) and a tolerant parser
 * for it.
 *
 * The model is asked to answer with a single JSON object, but a real model
 * response is not a trusted API payload: it can arrive wrapped in prose or a
 * fenced code block, and an individual step can reference an unknown tool or
 * carry extra fields (either an honest model mistake, or page content that
 * successfully talked the model into requesting something it shouldn't have).
 * `parseAgentResponse` never throws — every failure mode becomes `{ok:false}`
 * — and a single bad step does not sink an otherwise-usable plan (see the
 * "coherent" note below).
 */

const planStepInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  rationale: z.string().trim().max(300).optional(),
  call: z.unknown(),
});

const agentResponseInputSchema = z.object({
  reply: z.string().max(2000),
  // Not `.max(8)` here: an oversized plan is truncated to the first 8 steps
  // below (see MAX_PLAN_STEPS), not treated as a hard parse failure — a model
  // that over-produces steps still yields a usable, bounded plan.
  plan: z.array(planStepInputSchema).default([]),
});

export const MAX_PLAN_STEPS = 8;

export interface AgentPlanStep {
  title: string;
  rationale?: string;
  call: ToolCall;
}

export interface AgentResponse {
  reply: string;
  plan: AgentPlanStep[];
}

export const agentResponseSchema = agentResponseInputSchema;

export type ParsedAgentResponse =
  | { ok: true; response: AgentResponse; droppedSteps: number }
  | { ok: false; reason: string };

/**
 * Extracts a JSON object substring from `raw`, tolerating:
 *   - a fenced code block (```json ... ``` or ``` ... ```)
 *   - leading/trailing prose around the object
 *   - the raw text already being exactly one JSON object
 *
 * Returns null when nothing that looks like a JSON object can be found — the
 * caller turns that into `{ok:false}` rather than throwing.
 */
function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const searchSpace = fenced ? fenced[1]!.trim() : trimmed;

  const start = searchSpace.indexOf('{');
  if (start === -1) return null;

  // Balanced-brace scan from the first '{' so trailing prose after the JSON
  // object (e.g. "Let me know if that works.") doesn't break JSON.parse.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < searchSpace.length; i += 1) {
    const ch = searchSpace[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return searchSpace.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parses one plan step's `call` against {@link toolCallSchema}. Unknown tools
 * and extra fields are rejected (the union is `.strict()` per-variant), which
 * is what keeps a page-injected instruction like `{"tool":"click","url":"..."}`
 * from ever becoming a usable step.
 */
function parseStepCall(call: unknown): ToolCall | null {
  const result = toolCallSchema.safeParse(call);
  return result.success ? result.data : null;
}

/**
 * Design choice: a single invalid step (unknown tool, extra/forged fields, a
 * malformed call) is dropped rather than failing the whole response. The
 * rest of the plan is kept only when the response is still structurally
 * coherent — i.e. `reply` parsed and the surviving steps are each internally
 * valid in isolation; Motion does not try to infer whether steps depended on
 * each other, since the guard/policy layer (guard.ts) re-validates every
 * step's refs independently anyway. This means a prompt-injected step mixed
 * into an otherwise sound plan cannot poison the steps around it, while an
 * honest model typo doesn't throw away a whole turn's work.
 */
export function parseAgentResponse(raw: string): ParsedAgentResponse {
  let candidate: string;
  try {
    const extracted = extractJsonCandidate(raw);
    if (extracted === null) return { ok: false, reason: 'no JSON object found in model output' };
    candidate = extracted;
  } catch {
    return { ok: false, reason: 'failed to scan model output for JSON' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: 'model output was not valid JSON' };
  }

  const shapeResult = agentResponseInputSchema.safeParse(parsedJson);
  if (!shapeResult.success) {
    return { ok: false, reason: 'model output did not match the response shape' };
  }

  const steps: AgentPlanStep[] = [];
  let dropped = 0;
  for (const step of shapeResult.data.plan.slice(0, MAX_PLAN_STEPS)) {
    const call = parseStepCall(step.call);
    if (!call) {
      dropped += 1;
      continue;
    }
    steps.push({ title: step.title, rationale: step.rationale, call });
  }

  return {
    ok: true,
    response: { reply: shapeResult.data.reply, plan: steps },
    droppedSteps: dropped,
  };
}
