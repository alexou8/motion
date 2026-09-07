import { useCallback, useEffect, useState } from 'react';
import { supportedHosts } from '@/core/adapters';

/**
 * Settings and data controls.
 *
 * This page exists to make three promises inspectable rather than merely
 * documented: exactly which sites Motion can read, that access can be revoked,
 * and that "delete my data" removes everything.
 */

interface Grant {
  origin: string;
  builtIn: boolean;
}

export function App(): JSX.Element {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(async () => {
    const all = await chrome.permissions.getAll();
    const optional = (all.origins ?? []).map((origin) => ({
      origin,
      builtIn: supportedHosts.some((host) => origin.includes(host.replace('*.', ''))),
    }));
    setGrants(optional);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('motion');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    await chrome.storage.session.clear();
    await chrome.storage.local.clear();
    setConfirmingDelete(false);
    setStatus('Deleted every course, task, note and workflow Motion had stored.');
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-6 py-8 text-ink">
      <h1 className="text-lg font-semibold">Motion settings</h1>

      <section className="mt-8" aria-labelledby="access-heading">
        <h2 id="access-heading" className="text-md font-medium">
          What Motion can read
        </h2>
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
                onClick={() => void revoke(grant.origin)}
                className="min-h-[24px] rounded border border-edge px-3 py-1 text-sm hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                Remove access
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="data-heading">
        <h2 id="data-heading" className="text-md font-medium">
          Your data
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Everything Motion stores stays in this browser. There is no account and no server, so
          nothing is uploaded and nothing syncs between devices.
        </p>
        <p className="mt-2 text-sm text-ink-muted">
          Stored data is protected by your browser profile. It is not separately encrypted, so
          anyone who can use this signed-in profile can read it.
        </p>

        {!confirmingDelete ? (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="mt-4 min-h-[24px] rounded border border-danger px-3 py-1.5 text-sm text-danger hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
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
                onClick={() => void deleteEverything()}
                className="min-h-[24px] rounded bg-danger px-3 py-1.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
              >
                Delete everything
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="min-h-[24px] rounded border border-edge px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                Keep my data
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="limits-heading">
        <h2 id="limits-heading" className="text-md font-medium">
          What Motion will not do
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
          <li>Submit an assignment, or answer or act inside a graded quiz.</li>
          <li>Modify or delete anything in your LMS.</li>
          <li>Post or send anything without showing you exactly what it will send first.</li>
        </ul>
      </section>

      {/* Announced rather than shown silently, so a revoke or delete is confirmed. */}
      <p role="status" aria-live="polite" className="mt-8 text-sm text-ink-muted">
        {status}
      </p>
    </main>
  );
}
