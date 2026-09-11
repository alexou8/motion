import { useCallback, useEffect, useState } from 'react';
import { supportedHosts } from '@/core/adapters';

/**
 * Settings and data controls.
 *
 * This page exists to make three promises inspectable rather than merely
 * documented: exactly which sites Motion can read, that access can be revoked,
 * and that "delete my data" removes everything — or says plainly what it could
 * not remove.
 */

interface Grant {
  origin: string;
  builtIn: boolean;
}
type Section = 'permissions' | 'privacy' | 'capabilities' | 'about';
const sections: Array<{ id: Section; label: string }> = [
  { id: 'permissions', label: 'Permissions' },
  { id: 'privacy', label: 'Privacy & data' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'about', label: 'About' },
];
const card = 'rounded border border-rule bg-surface p-5';
const focus =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
function sectionFromHash(): Section {
  const id = window.location.hash.slice(1) as Section;
  return sections.some((s) => s.id === id) ? id : 'permissions';
}

export function App(): JSX.Element {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [section, setSection] = useState<Section>(sectionFromHash);
  const load = useCallback(async () => {
    const all = await chrome.permissions.getAll();
    setGrants(
      (all.origins ?? []).map((origin) => ({
        origin,
        builtIn: supportedHosts.some((host) => origin.includes(host.replace('*.', ''))),
      })),
    );
  }, []);
  useEffect(() => {
    void load();
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [load]);
  const select = (id: Section) => {
    window.location.hash = id;
    setSection(id);
  };
  const revoke = useCallback(
    async (origin: string) => {
      const removed = await chrome.permissions.remove({ origins: [origin] });
      setStatus(
        removed
          ? `Motion can no longer read ${origin}.`
          : `${origin} is built in and cannot be removed here. Remove Motion to revoke it.`,
      );
      await load();
    },
    [load],
  );
  const deleteEverything = useCallback(async () => {
    let outcome: 'success' | 'error' | 'blocked' = 'success';
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('motion');
      request.onsuccess = () => resolve();
      request.onerror = () => {
        outcome = 'error';
        resolve();
      };
      request.onblocked = () => {
        outcome = 'blocked';
        resolve();
      };
    });
    await chrome.storage.session.clear();
    await chrome.storage.local.clear();
    setConfirmingDelete(false);
    setStatus(
      outcome === 'success'
        ? 'Deleted every course, task, note and workflow Motion had stored.'
        : outcome === 'blocked'
          ? 'Motion could not delete its database because another Motion page is open. Close the side panel and try again. Session and local storage were deleted.'
          : 'Motion could not delete its database. Session and local storage were deleted, but stored database data may remain.',
    );
  }, []);
  const version = chrome.runtime.getManifest().version;
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-ink">
      <header className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-medium">Settings</h1>
        <span className="text-sm text-ink-muted">Motion {version}</span>
      </header>
      <div className="mt-8 grid gap-8 md:grid-cols-[12rem_1fr]">
        <nav aria-label="Settings sections" className="flex flex-wrap gap-1 md:block md:space-y-1">
          {sections.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? 'page' : undefined}
              onClick={() => select(id)}
              className={`min-h-[24px] rounded px-3 py-2 text-left text-sm ${focus} ${section === id ? 'bg-sunken text-ink font-medium' : 'text-ink-muted hover:bg-sunken'}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {section === 'permissions' && <Permissions grants={grants} revoke={revoke} />}
          {section === 'privacy' && (
            <Privacy
              confirming={confirmingDelete}
              setConfirming={setConfirmingDelete}
              deleteEverything={deleteEverything}
            />
          )}
          {section === 'capabilities' && <Capabilities />}
          {section === 'about' && <About version={version} />}
          <p role="status" aria-live="polite" className="mt-8 text-sm text-ink-muted">
            {status}
          </p>
        </div>
      </div>
    </main>
  );
}

function Permissions({ grants, revoke }: { grants: Grant[]; revoke: (origin: string) => void }) {
  return (
    <section aria-labelledby="permissions-heading">
      <h2 id="permissions-heading" className="font-serif text-lg">
        Permissions
      </h2>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">What Motion can read</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Motion only reads pages on these sites, and only while you have them open. It never
          collects browsing outside them.
        </p>
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {grants.length === 0 && (
            <li className="py-3 text-sm text-ink-muted">
              No site access granted yet. Motion asks when you first open a course page.
            </li>
          )}
          {grants.map((grant) => (
            <li key={grant.origin} className="flex items-center justify-between gap-4 py-3">
              <span className="font-mono text-sm">{grant.origin}</span>
              <button
                type="button"
                onClick={() => revoke(grant.origin)}
                className={`min-h-[24px] rounded border border-edge px-3 py-1 text-sm hover:bg-sunken ${focus}`}
              >
                Remove access
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">What Motion will not do</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
          <li>Submit an assignment, or answer or act inside a graded quiz.</li>
          <li>Modify or delete anything in your LMS.</li>
          <li>Post or send anything without showing you exactly what it will send first.</li>
        </ul>
      </div>
    </section>
  );
}
function Privacy({
  confirming,
  setConfirming,
  deleteEverything,
}: {
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  deleteEverything: () => void;
}) {
  return (
    <section aria-labelledby="data-heading">
      <h2 id="data-heading" className="font-serif text-lg">
        Privacy &amp; data
      </h2>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Your data</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Everything Motion stores stays in this browser. There is no account and no server, so
          nothing is uploaded and nothing syncs between devices.
        </p>
        <p className="mt-2 text-sm text-ink-muted">
          Stored data is protected by your browser profile. It is not separately encrypted, so
          anyone who can use this signed-in profile can read it.
        </p>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={`mt-4 min-h-[24px] rounded border border-danger px-3 py-1.5 text-sm text-danger hover:bg-sunken ${focus}`}
          >
            Delete all Motion data
          </button>
        ) : (
          <div className="mt-4 rounded border border-danger p-4">
            <p className="text-sm">
              This permanently deletes every course, deadline, note, checklist and workflow Motion
              has stored. It cannot be undone, and it does not touch anything in your LMS.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={deleteEverything}
                className={`min-h-[24px] rounded border border-danger bg-surface px-3 py-1.5 text-sm font-medium text-danger ${focus}`}
              >
                Delete everything
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className={`min-h-[24px] rounded border border-edge px-3 py-1.5 text-sm ${focus}`}
              >
                Keep my data
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
function Capabilities() {
  return (
    <section aria-labelledby="capabilities-heading">
      <h2 id="capabilities-heading" className="font-serif text-lg">
        Capabilities
      </h2>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Optional capabilities</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Each optional capability is off until you turn it on, and can be turned off here at any
          time. Consent to one is not consent to another.
        </p>
      </div>
      <div className={`${card} mt-4`}>
        <p className="text-sm text-ink-muted">
          No optional capabilities yet. Everything Motion does today — reading supported course
          pages, organising its own tabs, and drafting with Chrome&apos;s on-device model — works
          without sending anything off this device.
        </p>
      </div>
    </section>
  );
}
function About({ version }: { version: string }) {
  return (
    <section aria-labelledby="about-heading">
      <h2 id="about-heading" className="font-serif text-lg">
        About
      </h2>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Motion {version}</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Motion helps you organise coursework on supported learning sites. It keeps everything in
          this browser.
        </p>
        <p className="mt-2 text-sm text-ink-muted">There is no account and no server.</p>
      </div>
    </section>
  );
}
