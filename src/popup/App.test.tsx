import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupApp } from './App';

describe('PopupApp default bridge', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads context once when the default bridge state update rerenders the popup', async () => {
    const query = vi.fn(async () => [{ id: 7 }]);
    const sendMessage = vi.fn(async () => ({
      ok: true,
      result: {
        tabId: 7,
        windowId: 1,
        connection: 'unsupported',
        title: 'Synthetic unsupported page',
        courseLabel: null,
        relevantSessionId: null,
        relevantSessionTitle: null,
      },
    }));
    vi.stubGlobal('chrome', {
      tabs: { query },
      runtime: { sendMessage },
      sidePanel: { open: vi.fn() },
    });

    render(<PopupApp />);

    await screen.findByText(
      'Motion works on Brightspace course sites: *.brightspace.com, *.desire2learn.com, and institution deployments such as mylearningspace.wlu.ca. Open your Brightspace course, then reopen Motion.',
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('shows a context failure with Retry and keeps Open Motion available', async () => {
    const user = userEvent.setup();
    const query = vi.fn(async () => [{ id: 7, windowId: 3 }]);
    let answer: unknown = { ok: false, error: 'The background worker did not respond.' };
    const sendMessage = vi.fn(async () => answer);
    const open = vi.fn(async () => undefined);
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    vi.stubGlobal('chrome', { tabs: { query }, runtime: { sendMessage }, sidePanel: { open } });

    render(<PopupApp />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The background worker did not respond.');
    expect(screen.queryByText('Loading page context…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Motion' }));
    expect(open).toHaveBeenCalledWith({ windowId: 3 });
    await waitFor(() => expect(close).toHaveBeenCalled());

    answer = {
      ok: true,
      result: {
        tabId: 7, windowId: 3, connection: 'idle', title: '', courseLabel: null,
        relevantSessionId: null, relevantSessionTitle: null,
      },
    };
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Open your Brightspace course, then reopen Motion\./)).toBeInTheDocument();
    close.mockRestore();
  });
});
