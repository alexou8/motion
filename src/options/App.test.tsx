import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

let origins: string[];
const sessionClear = vi.fn(async () => undefined);
const localClear = vi.fn(async () => undefined);

beforeEach(() => {
  origins = ['https://courses.example.test/*', 'https://mylearningspace.wlu.ca/*'];
  sessionClear.mockClear();
  localClear.mockClear();
  Object.defineProperty(window, 'chrome', {
    configurable: true,
    value: {
      permissions: {
        getAll: vi.fn(async () => ({ origins })),
        remove: vi.fn(async ({ origins: removed }: { origins: string[] }) => {
          const existed = origins.every((origin) => origins.includes(origin));
          const removable = removed[0] !== 'https://mylearningspace.wlu.ca/*';
          if (removable) origins = origins.filter((origin) => !removed.includes(origin));
          return existed && removable;
        }),
      },
      storage: { session: { clear: sessionClear }, local: { clear: localClear } },
      runtime: { getManifest: () => ({ version: '0.1.1' }) },
    },
  });
  window.location.hash = '';
});

describe('options settings', () => {
  it('lists origins and revokes removable access', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('https://mylearningspace.wlu.ca/*');
    expect(await screen.findByText('https://courses.example.test/*')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Remove access' })[0]!);
    await waitFor(() =>
      expect(screen.queryByText('https://courses.example.test/*')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Motion can no longer read https://courses.example.test/*',
    );
  });

  it('keeps built-in access when removal returns false', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('https://mylearningspace.wlu.ca/*');
    await user.click(screen.getAllByRole('button', { name: 'Remove access' })[1]!);
    expect(screen.getByText('https://mylearningspace.wlu.ca/*')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('built in and cannot be removed here');
  });

  it('requires confirmation and deletes the database and storage', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('motion', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('items');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Privacy & data' }));
    await user.click(screen.getByRole('button', { name: 'Delete all Motion data' }));
    expect(sessionClear).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete everything' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Deleted every course'),
    );
    expect(sessionClear).toHaveBeenCalled();
    expect(localClear).toHaveBeenCalled();
    const reopened = await new Promise<IDBOpenDBRequest>((resolve) => {
      const r = indexedDB.open('motion');
      r.onsuccess = () => resolve(r);
    });
    expect(reopened.result.objectStoreNames).toHaveLength(0);
    reopened.result.close();
  });

  it('does not claim deletion when the database is blocked', async () => {
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      const request = {
        onblocked: null,
        onerror: null,
        onsuccess: null,
      } as unknown as IDBOpenDBRequest;
      setTimeout(() => request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent), 0);
      return request;
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Privacy & data' }));
    await user.click(screen.getByRole('button', { name: 'Delete all Motion data' }));
    await user.click(screen.getByRole('button', { name: 'Delete everything' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('another Motion page is open'),
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('Deleted every course');
    vi.restoreAllMocks();
  });

  it('cancels deletion with Keep my data', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Privacy & data' }));
    await user.click(screen.getByRole('button', { name: 'Delete all Motion data' }));
    await user.click(screen.getByRole('button', { name: 'Keep my data' }));
    expect(screen.getByRole('button', { name: 'Delete all Motion data' })).toBeInTheDocument();
    expect(sessionClear).not.toHaveBeenCalled();
  });

  it('navigates by hash and has no capability controls', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Privacy & data' }));
    expect(screen.getByRole('heading', { name: 'Privacy & data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Privacy & data' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(window.location.hash).toBe('#privacy');
    expect(screen.queryByRole('heading', { name: 'Permissions' })).not.toBeInTheDocument();
    window.location.hash = '#capabilities';
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeInTheDocument(),
    );
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
