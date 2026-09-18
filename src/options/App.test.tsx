import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { DEFAULT_REMINDER_PREFERENCES, REMINDER_PREFERENCES_KEY } from '@/core/reminders';

let origins: string[];
const sessionClear = vi.fn(async () => undefined);
const localClear = vi.fn(async () => undefined);
const permissionsRequest = vi.fn(async () => true);
const reminderStorageGet = vi.fn(async (key: string) => ({ [key]: { ...DEFAULT_REMINDER_PREFERENCES } }));
const reminderStorageSet = vi.fn(async () => undefined);
const notificationCreate = vi.fn(async () => 'test-notification');
let sendMessage: (message: unknown) => Promise<unknown>;

const aiStatus = {
  selected: 'chrome-local',
  model: 'recommended',
  models: [{ id: 'chrome-on-device', label: 'On-device (Chrome)', recommended: true }],
  providers: [
    {
      providerId: 'chrome-local',
      displayName: "Chrome's built-in model",
      cloud: false,
      configured: true,
      status: 'available',
      message: "Chrome's on-device model is ready.",
      backgroundExecution: false,
      disclosureAccepted: true,
    },
    {
      providerId: 'openai',
      displayName: 'OpenAI',
      cloud: true,
      configured: false,
      status: 'not-configured',
      message: 'OpenAI isn’t set up yet. Add an API key in Motion’s settings to use it.',
      backgroundExecution: true,
      disclosureAccepted: false,
    },
    {
      providerId: 'anthropic',
      displayName: 'Anthropic',
      cloud: true,
      configured: false,
      status: 'not-configured',
      message: 'Anthropic isn’t set up yet. Add an API key in Motion’s settings to use it.',
      backgroundExecution: true,
      disclosureAccepted: false,
    },
  ],
  autoOpenRelatedTabs: false,
  showOnPagePointer: true,
  allowedConfigurableActions: [],
  lmsAccess: [{ origin: 'https://mylearningspace.wlu.ca/*', granted: true }],
};

beforeEach(() => {
  origins = ['https://courses.example.test/*', 'https://mylearningspace.wlu.ca/*'];
  sessionClear.mockClear();
  localClear.mockClear();
  permissionsRequest.mockClear();
  reminderStorageGet.mockClear();
  reminderStorageSet.mockClear();
  notificationCreate.mockClear();
  let status = structuredClone(aiStatus);
  sendMessage = vi.fn(async (message: unknown) => {
    const msg = message as { type: string; [key: string]: unknown };
    switch (msg.type) {
      case 'ai-status':
        return { ok: true, result: status };
      case 'set-ai-preferences': {
        if (typeof msg.providerId === 'string') status = { ...status, selected: msg.providerId as never };
        if (typeof msg.model === 'string') status = { ...status, model: msg.model };
        if (Array.isArray(msg.allowedConfigurableActions)) status = { ...status, allowedConfigurableActions: msg.allowedConfigurableActions as never };
        if (typeof msg.autoOpenRelatedTabs === 'boolean') status = { ...status, autoOpenRelatedTabs: msg.autoOpenRelatedTabs };
        if (typeof msg.showOnPagePointer === 'boolean') status = { ...status, showOnPagePointer: msg.showOnPagePointer };
        return { ok: true };
      }
      case 'accept-cloud-disclosure': {
        status = {
          ...status,
          providers: status.providers.map((p) => (p.providerId === msg.providerId ? { ...p, disclosureAccepted: msg.accepted as boolean } : p)),
        };
        return { ok: true };
      }
      case 'set-provider-key': {
        status = {
          ...status,
          providers: status.providers.map((p) => (p.providerId === msg.providerId ? { ...p, configured: true, status: 'available', message: 'Ready.' } : p)),
        };
        return { ok: true };
      }
      case 'forget-provider-key': {
        status = {
          ...status,
          providers: status.providers.map((p) => (p.providerId === msg.providerId ? { ...p, configured: false, status: 'not-configured' } : p)),
        };
        return { ok: true };
      }
      case 'test-provider':
        return { ok: true };
      case 'delete-local-data':
        return { ok: true };
      default:
        return { ok: true };
    }
  });
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
        request: permissionsRequest,
      },
      storage: {
        session: { clear: sessionClear },
        local: { clear: localClear, get: reminderStorageGet, set: reminderStorageSet },
      },
      notifications: { create: notificationCreate },
      runtime: { getManifest: () => ({ version: '0.1.1' }), sendMessage: (m: unknown) => sendMessage(m) },
    },
  });
  window.location.hash = '';
});

describe('browser access', () => {
  it('lists origins and revokes removable access', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Browser access' }));
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
    await user.click(screen.getByRole('button', { name: 'Browser access' }));
    await screen.findByText('https://mylearningspace.wlu.ca/*');
    await user.click(screen.getAllByRole('button', { name: 'Remove access' })[1]!);
    expect(screen.getByText('https://mylearningspace.wlu.ca/*')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('built in and cannot be removed here');
  });
});

describe('privacy & data', () => {
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
});

describe('navigation', () => {
  it('navigates by hash and defaults to AI', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole('heading', { name: 'AI' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Privacy & data' }));
    expect(screen.getByRole('heading', { name: 'Privacy & data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Privacy & data' })).toHaveAttribute('aria-current', 'page');
    expect(window.location.hash).toBe('#privacy');
    window.location.hash = '#about';
    await waitFor(() => expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument());
  });
});

describe('reminders', () => {
  it('renders an opt-in semantic timing matrix and saves changes locally', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Reminders' }));
    expect(screen.getByRole('heading', { name: 'Reminders' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Reminder timing by item type' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Send deadline reminders' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Send deadline reminders' }));
    await waitFor(() => expect(reminderStorageSet).toHaveBeenCalledWith(expect.objectContaining({ [REMINDER_PREFERENCES_KEY]: expect.objectContaining({ enabled: true }) })));
  });

  it('sends a test notification through the native notification API', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Reminders' }));
    await user.click(screen.getByRole('button', { name: 'Send a test reminder' }));
    expect(notificationCreate).toHaveBeenCalledWith(expect.stringContaining('motion-test-reminder-'), expect.objectContaining({ type: 'basic' }));
    expect(screen.getByRole('status')).toHaveTextContent('Test reminder sent.');
  });
});

describe('AI settings', () => {
  it('saves the on-page pointer preference and keeps authority copy explicit', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Agent behaviour' }));
    const pointer = screen.getByRole('checkbox', { name: 'Show Motion on-page pointer' });
    expect(pointer).toBeChecked();
    await user.click(pointer);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'set-ai-preferences', showOnPagePointer: false }));
    expect(screen.getByRole('status')).toHaveTextContent('on-page pointer is off');
    expect(document.getElementById('show-on-page-pointer-description')).toHaveTextContent('It does not change what Motion is allowed to do.');
  });

  it('keeps the existing pointer value and surfaces a save failure', async () => {
    const original = sendMessage;
    sendMessage = vi.fn(async (message: unknown) => {
      if ((message as { type?: string }).type === 'set-ai-preferences')
        return { ok: false, error: 'Storage is unavailable. Try again.' };
      return original(message);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Agent behaviour' }));
    const pointer = screen.getByRole('checkbox', { name: 'Show Motion on-page pointer' });
    await user.click(pointer);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('could not save the on-page pointer setting'));
    expect(pointer).toBeChecked();
  });

  it('clears the key input after saving and never re-renders it', async () => {
    const user = userEvent.setup();
    render(<App />);
    const openaiKey = await screen.findByLabelText('API key', { selector: '#openai-key' });
    await user.type(openaiKey, 'sk-super-secret-key-value');
    await user.click(within(openaiKey.closest('form')!).getByRole('button', { name: 'Save for this browser session' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('key saved'));
    expect(openaiKey).toHaveValue('');
    expect(document.body.textContent).not.toContain('sk-super-secret-key-value');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set-provider-key', providerId: 'openai', key: 'sk-super-secret-key-value' }),
    );
  });

  it('forgets a saved key', async () => {
    const user = userEvent.setup();
    render(<App />);
    const openaiKey = await screen.findByLabelText('API key', { selector: '#openai-key' });
    const form = openaiKey.closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Forget key' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('key forgotten'));
  });

  it('requires the disclosure before selecting a cloud provider', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText('API key', { selector: '#openai-key' });
    const radios = screen.getAllByRole('radio');
    const openaiRadio = radios.find((r) => r.closest('div.grid')?.textContent?.includes('OpenAI'))!;

    await user.click(openaiRadio);
    expect(screen.getByRole('status')).toHaveTextContent('Accept the cloud-processing disclosure');
    expect(permissionsRequest).not.toHaveBeenCalled();

    const openaiCard = openaiRadio.closest('div.grid') as HTMLElement;
    const checkbox = within(openaiCard).getByText('This provider processes the content you send using its cloud service.').closest('label')!.querySelector('input')!;
    await user.click(checkbox);
    await user.click(openaiRadio);
    await waitFor(() => expect(permissionsRequest).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] }));
  });
});

describe('About', () => {
  it('renders the diagnostics table with provider statuses', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'About' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Chrome built-in AI')).toBeInTheDocument();
    expect(within(table).getByText('OpenAI')).toBeInTheDocument();
    expect(within(table).getByText('Anthropic')).toBeInTheDocument();
    expect(within(table).getByText('D2L access')).toBeInTheDocument();
    expect(within(table).getByText('Granted')).toBeInTheDocument();
  });
});
