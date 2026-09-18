import { render, screen, waitFor } from '@testing-library/react';
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

    await screen.findByText('Motion focuses on supported LMS pages. You can still open your workspace.');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(query).toHaveBeenCalledTimes(1);
  });
});
