import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { z } from 'zod';
import type { PanelState } from '../../core/view/state';
import { cn } from '../../ui/components/cn';
import type { MotionBridge } from '../bridge';

/**
 * The chat about the current page.
 *
 * The conversation lives only in this panel's memory: nothing is stored, and a
 * new chat or closing the panel forgets it. The worker decides what the model
 * may see — on a graded attempt it reads nothing and answers nothing — so the
 * composer's own checks exist to be honest about that up front, not to enforce
 * it.
 */

export interface ChatTurn {
  id: string;
  role: 'student' | 'motion';
  text: string;
  /** Shown under a generated answer. */
  label?: string;
  /** The page an answer was about, so an old answer is not read as current. */
  pageTitle?: string;
  /** Motion declined or failed; the text is the reason, not an answer. */
  declined?: boolean;
}

/**
 * The worker is Motion's own code but still a boundary: after an update the
 * panel and worker can disagree about a shape. Anything unrecognised is treated
 * as "no answer" rather than rendered.
 */
const askAboutPageResultSchema = z.object({
  answer: z.string().max(20_000).nullable(),
  reason: z.string().max(1_000).optional(),
  label: z.string().max(1_000).optional(),
});

const modelStatusSchema = z.object({
  availability: z.enum(['available', 'downloadable', 'downloading', 'unavailable']),
  explanation: z.string().max(1_000),
});
type ModelStatus = z.infer<typeof modelStatusSchema>;

/** Bounds the worker's schema enforces; kept here so the panel never sends more. */
const QUESTION_MAX = 2_000;
const HISTORY_TURNS = 12;
const HISTORY_CHARS = 4_000;

/** Why the composer is off on this page, or null when the student can ask. */
export function composerBlockedReason(state: PanelState): string | null {
  switch (state.connection) {
    case 'supported':
      return null;
    case 'restricted':
      return 'Chat is off beside a graded attempt. Motion does not read or answer questions about this page.';
    case 'signed-out':
      return 'Sign in to D2L again, then ask about the page.';
    case 'permission-needed':
      return 'Allow Motion to read this site, then ask about the page.';
    default:
      return 'Open a course page Motion can read to ask about it.';
  }
}

export function useChat(bridge: MotionBridge, state: PanelState) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [pending, setPending] = useState(false);
  const nextId = useRef(0);
  const id = () => `turn-${nextId.current++}`;

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim().slice(0, QUESTION_MAX);
      if (!trimmed || pending) return;
      // Declined turns are Motion explaining itself, not conversation, so they
      // are not sent back as history.
      const history = turns
        .filter((turn) => !turn.declined)
        .slice(-HISTORY_TURNS)
        .map((turn) => ({ role: turn.role, text: turn.text.slice(0, HISTORY_CHARS) }));
      const pageTitle = state.page.title;

      setTurns((current) => [...current, { id: id(), role: 'student', text: trimmed }]);
      setPending(true);
      const raw = bridge.request
        ? await bridge.request<unknown>({ type: 'ask-about-page', question: trimmed, history })
        : null;
      setPending(false);

      const parsed = askAboutPageResultSchema.safeParse(raw);
      const result = parsed.success ? parsed.data : null;
      const reply: ChatTurn = result?.answer
        ? { id: id(), role: 'motion', text: result.answer, pageTitle, ...(result.label ? { label: result.label } : {}) }
        : {
            id: id(),
            role: 'motion',
            text: result?.reason ?? 'Motion could not answer that. Try again.',
            declined: true,
          };
      setTurns((current) => [...current, reply]);
    },
    [bridge, pending, state.page.title, turns],
  );

  const reset = useCallback(() => setTurns([]), []);

  return { turns, pending, ask, reset };
}

export function Conversation({ turns, pending }: { turns: ChatTurn[]; pending: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [turns.length, pending]);

  if (turns.length === 0 && !pending) return null;

  return (
    <section aria-label="Conversation about this page" className="grid gap-4">
      {/* A log, so a screen reader hears each answer arrive without hunting. */}
      <ol role="log" aria-live="polite" className="grid gap-4">
        {turns.map((turn) =>
          turn.role === 'student' ? (
            <li key={turn.id} className="ml-8 justify-self-end rounded bg-sunken px-3 py-2 text-sm text-ink whitespace-pre-wrap break-words">
              <span className="sr-only">You asked: </span>
              {turn.text}
            </li>
          ) : (
            <li key={turn.id} className="grid gap-1">
              <span className="sr-only">Motion: </span>
              <p className={cn('text-sm whitespace-pre-wrap break-words', turn.declined ? 'text-ink-muted' : 'text-ink')}>
                {turn.text}
              </p>
              {turn.label ? (
                <p className="text-xs text-ink-muted">
                  {turn.pageTitle ? `About “${turn.pageTitle}”. ` : null}
                  {turn.label}
                </p>
              ) : null}
            </li>
          ),
        )}
        {pending ? (
          <li className="text-sm text-ink-muted" aria-label="Motion is answering">
            Reading the page…
          </li>
        ) : null}
      </ol>
      <div ref={end} />
    </section>
  );
}

export interface ComposerProps {
  bridge: MotionBridge;
  state: PanelState;
  pending: boolean;
  onAsk: (question: string) => void;
}

export function Composer({ bridge, state, pending, onAsk }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState<ModelStatus | null>(null);
  const blocked = composerBlockedReason(state);

  // Ask once per supported page whether the on-device model exists at all, so
  // the composer can say so before the student types a question.
  useEffect(() => {
    if (blocked || !bridge.request) return;
    let cancelled = false;
    void bridge.request<unknown>({ type: 'model-status' }).then((status) => {
      const parsed = modelStatusSchema.safeParse(status);
      if (!cancelled && parsed.success) setModel(parsed.data);
    });
    return () => {
      cancelled = true;
    };
  }, [blocked, bridge]);

  const modelMissing = model !== null && model.availability !== 'available';
  const reason = blocked ?? (modelMissing ? model.explanation : null);
  const disabled = reason !== null;
  const canSend = !disabled && !pending && draft.trim().length > 0;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onAsk(draft);
    setDraft('');
  };

  // Beside a graded attempt there is no composer at all, not a disabled one:
  // a field that looks like it could take a question about the attempt teaches
  // the wrong thing, the same reason restricted mode offers no page actions.
  if (state.connection === 'restricted') {
    return <p className="text-xs text-ink-muted text-pretty">{reason}</p>;
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter keeps a newline; IME composition is left alone.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <form onSubmit={submit} className="grid gap-2" aria-label="Ask about this page">
      {reason ? (
        <p id="composer-reason" className="text-xs text-ink-muted text-pretty">
          {reason}
        </p>
      ) : null}
      <div className="flex items-end gap-2 rounded border border-edge bg-surface p-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
        <label htmlFor="composer-input" className="sr-only">
          Ask about this page
        </label>
        <textarea
          id="composer-input"
          rows={2}
          maxLength={QUESTION_MAX}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? 'Chat is unavailable here' : 'Ask about this page'}
          {...(reason ? { 'aria-describedby': 'composer-reason' } : {})}
          className="min-h-10 flex-1 resize-none bg-transparent px-1 text-sm text-ink placeholder:text-ink-muted focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send question"
          title="Send"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm bg-signal text-on-signal hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
          </svg>
        </button>
      </div>
    </form>
  );
}
