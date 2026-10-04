import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_PANEL_STATE } from '@/core/view';
import { summarizeDocument, type IndexedDocument } from '@/core/documents/library';
import type { MotionBridge, MotionCommand, UiCommandResult } from '../bridge';
import { LibraryView } from './LibraryView';
import { App } from '../App';

const document: IndexedDocument = {
  id: 'synthetic-document',
  title: 'Synthetic lecture.pdf',
  format: 'pdf',
  courseId: null,
  sourceUrl: null,
  sourcePageUrl: null,
  capturedAt: '2026-10-03T12:00:00Z',
  units: [
    { number: 1, text: 'Synthetic introductory text' },
    { number: 2, text: 'Synthetic quasar explanation' },
  ],
  totalUnits: 2,
  truncated: false,
  warnings: [],
};
function fixtureBridge() {
  const commands: MotionCommand[] = [];
  let documents = [document];
  const bridge: MotionBridge = {
    getState: () => EMPTY_PANEL_STATE,
    subscribe: () => () => {},
    send: vi.fn(async () => ({ ok: true as const })),
    request: async <T,>(command: MotionCommand): Promise<UiCommandResult<T>> => {
      commands.push(command);
      let data: unknown;
      if (command.type === 'get-documents')
        data = {
          documents: documents
            .map((item) => summarizeDocument(item, command.query))
            .filter(Boolean),
          total: documents.filter((item) => summarizeDocument(item, command.query)).length,
          truncated: false,
        };
      if (command.type === 'get-document') data = { document };
      if (command.type === 'delete-document') {
        documents = [];
        data = { deleted: true };
      }
      return { ok: true, data: data as T };
    },
  };
  return { bridge, commands };
}

describe('material library', () => {
  it('searches text with page provenance and provides a keyboard focused preview', async () => {
    const user = userEvent.setup();
    const { bridge, commands } = fixtureBridge();
    render(<LibraryView state={EMPTY_PANEL_STATE} bridge={bridge} />);
    await screen.findByRole('heading', { name: document.title });
    await user.type(screen.getByLabelText('Search document text'), 'quasar');
    await user.click(screen.getByRole('button', { name: 'Search library' }));
    await waitFor(() =>
      expect(commands).toContainEqual({ type: 'get-documents', query: 'quasar' }),
    );
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Read text from ${document.title}` }));
    await screen.findByRole('heading', { name: `Text from ${document.title}` });
    expect(screen.getByLabelText('Page')).toHaveValue('2');
    expect(screen.getByRole('heading', { name: `Text from ${document.title}` })).toHaveFocus();
    await user.selectOptions(screen.getByLabelText('Page'), '1');
    expect(screen.getByText('Synthetic introductory text')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Remove ${document.title}` }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: document.title })).not.toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Page')).not.toBeInTheDocument();
  });

  it('represents the no-course filter as null and shows worker failures beside controls', async () => {
    const user = userEvent.setup();
    const { bridge, commands } = fixtureBridge();
    render(<LibraryView state={EMPTY_PANEL_STATE} bridge={bridge} />);
    await screen.findByRole('heading', { name: document.title });
    await user.selectOptions(screen.getByLabelText('Course', { exact: true }), '');
    await user.click(screen.getByRole('button', { name: 'Search library' }));
    expect(commands).toContainEqual({ type: 'get-documents', query: '', courseId: null });
    bridge.request = async () => ({
      ok: false,
      code: 'unavailable',
      message: 'Synthetic worker is unavailable.',
    });
    await user.click(screen.getByRole('button', { name: 'Search library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic worker is unavailable.');
  });

  it('cancels parsing and removes the library on a restricted assessment transition', async () => {
    const user = userEvent.setup();
    const { bridge } = fixtureBridge();
    const cancel = vi.fn();
    bridge.cancelDocumentImport = cancel;
    let state = EMPTY_PANEL_STATE;
    let listener = () => {};
    bridge.getState = () => state;
    bridge.subscribe = (next) => {
      listener = next;
      return () => {};
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Library' }));
    await screen.findByRole('heading', { name: document.title });
    act(() => {
      state = { ...EMPTY_PANEL_STATE, connection: 'restricted' };
      listener();
    });
    expect(screen.getByRole('heading', { name: 'Restricted mode' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: document.title })).not.toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not restore deleted text from a late preview reply', async () => {
    const user = userEvent.setup();
    const { bridge } = fixtureBridge();
    let notify = () => {};
    bridge.subscribeDocuments = (listener) => {
      notify = listener;
      return () => {};
    };
    let release!: (result: UiCommandResult<unknown>) => void;
    let deleted = false;
    const original = bridge.request!;
    bridge.request = async <T,>(command: MotionCommand): Promise<UiCommandResult<T>> =>
      command.type === 'get-document'
        ? new Promise((resolve) => {
            release = resolve as typeof release;
          })
        : deleted
          ? { ok: true, data: { documents: [], total: 0, truncated: false } as T }
          : original<T>(command);
    render(<LibraryView state={EMPTY_PANEL_STATE} bridge={bridge} />);
    await screen.findByRole('heading', { name: document.title });
    await user.click(screen.getByRole('button', { name: `Read text from ${document.title}` }));
    act(() => {
      deleted = true;
      notify();
    });
    await act(async () => {
      release({ ok: true, data: { document } });
    });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: document.title })).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('heading', { name: `Text from ${document.title}` }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Synthetic introductory text')).not.toBeInTheDocument();
  });
});
