import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import {
  documentSourcesResponseSchema,
  documentsResponseSchema,
  type IndexedDocument,
} from '@/core/documents/library';
import type { PanelState } from '@/core/view';
import { Button, SourceLink } from '@/ui/components';
import type { MotionBridge, MotionCommand } from '../bridge';

type Library = z.infer<typeof documentsResponseSchema>;
type Sources = z.infer<typeof documentSourcesResponseSchema>;

export function LibraryView({ state, bridge }: { state: PanelState; bridge: MotionBridge }) {
  const [library, setLibrary] = useState<Library>({ documents: [], total: 0, truncated: false });
  const [sources, setSources] = useState<Sources | null>(null);
  const [query, setQuery] = useState('');
  const [courseId, setCourseId] = useState('all');
  const [importCourseId, setImportCourseId] = useState(state.course?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [selected, setSelected] = useState<IndexedDocument | null>(null);
  const [unit, setUnit] = useState(1);
  const requestSequence = useRef(0);
  const libraryGeneration = useRef(0);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const currentPage = useRef(state.page.url);
  currentPage.current = state.page.url;
  const filters = useRef({ query, courseId });
  filters.current = { query, courseId };
  const courses = state.courses.some((course) => course.id === state.course?.id)
    ? state.courses
    : [...state.courses, ...(state.course ? [state.course] : [])];
  const courseNames = new Map(courses.map((course) => [course.id, course.code ?? course.name]));

  async function request<T>(command: MotionCommand): Promise<T> {
    if (!bridge.request) throw new Error('Refresh Motion to use the material library.');
    const result = await bridge.request<T>(command);
    if (!result.ok) throw new Error(result.message);
    if (!result.data) throw new Error('Motion did not return a result. Try again.');
    return result.data;
  }
  async function load(search = query, course = courseId) {
    const sequence = ++requestSequence.current;
    try {
      const result = await request<Library>({
        type: 'get-documents',
        query: search,
        ...(course === 'all' ? {} : { courseId: course || null }),
      });
      if (mounted.current && sequence === requestSequence.current) setLibrary(result);
    } catch (error) {
      if (mounted.current && sequence === requestSequence.current)
        setMessage({
          error: true,
          text: error instanceof Error ? error.message : 'The library could not be opened.',
        });
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load('', 'all');
    const unsubscribe = bridge.subscribeDocuments?.(() => {
      libraryGeneration.current += 1;
      setSelected(null);
      setSources(null);
      setLibrary({ documents: [], total: 0, truncated: false });
      void load(filters.current.query, filters.current.courseId);
    });
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
      libraryGeneration.current += 1;
      unsubscribe?.();
      bridge.cancelDocumentImport?.();
    };
    // A new bridge is a new extension connection. Search is submitted explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);
  useEffect(() => {
    setSources(null);
  }, [state.page.url]);
  useEffect(() => {
    if (selected) previewHeading.current?.focus();
  }, [selected]);

  async function perform(label: string, work: () => Promise<string | void>) {
    setBusy(label);
    setMessage(null);
    try {
      const text = await work();
      if (mounted.current && text) setMessage({ error: false, text });
    } catch (error) {
      if (mounted.current)
        setMessage({
          error: true,
          text: error instanceof Error ? error.message : 'This file could not be indexed.',
        });
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  async function indexed(document: IndexedDocument) {
    setSelected(null);
    await load();
    const label = document.format === 'pdf' ? 'pages' : 'slides';
    return `${document.title}: ${document.units.length} ${label} indexed locally${document.truncated ? ' (partial document)' : ''}.`;
  }
  const previewUnit = selected?.units.find((part) => part.number === unit);

  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <h1 className="font-serif text-xl font-semibold">Your material library</h1>
        <p className="text-sm text-ink-muted">
          Find a concept inside your lecture PDFs and slides.
        </p>
      </div>
      <p className="text-xs text-ink-muted">
        Files are parsed on this device and saved locally. Indexing does not send them to an AI
        provider. PDF and PowerPoint (.pptx), up to 20 MB per file; image text needs OCR.
      </p>
      <section aria-labelledby="library-add" className="grid gap-3 border-t border-rule pt-4">
        <h2 id="library-add" className="text-sm font-medium">
          Add course materials
        </h2>
        {state.connection === 'supported' ? (
          <Button
            type="button"
            variant="secondary"
            disabled={Boolean(busy)}
            onClick={() =>
              void perform('Looking for files…', async () => {
                const page = currentPage.current;
                const generation = libraryGeneration.current;
                const result = await request<Sources>({ type: 'get-document-sources' });
                if (page !== currentPage.current || generation !== libraryGeneration.current)
                  throw new Error('The page or library changed. Find files again.');
                if (mounted.current) setSources(result);
                return result.sources.length
                  ? undefined
                  : 'No PDF or PowerPoint file is exposed on this page. Open a lecture topic, or download its file and import it below.';
              })
            }
          >
            Find files on this page
          </Button>
        ) : (
          <p className="text-xs text-ink-muted">
            Open a MyLearningSpace lecture topic to find its file, or import a downloaded copy.
          </p>
        )}
        {sources?.sources.length ? (
          <ul className="grid gap-3" aria-label="Files on this page">
            {sources.sources.map((source) => (
              <li key={source.handle} className="grid gap-1 border-l border-rule pl-3">
                <p className="text-sm break-words">
                  {source.title}{' '}
                  <span className="text-xs text-ink-muted">{source.format.toUpperCase()}</span>
                </p>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void perform('Indexing file…', async () => {
                      const result = await request<{ document: IndexedDocument }>({
                        type: 'index-document-source',
                        handle: source.handle,
                      });
                      return indexed(result.document);
                    })
                  }
                >
                  Index {source.title}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid gap-1">
          <label htmlFor="library-import-course" className="text-xs font-medium">
            Course for imported files
          </label>
          <select
            id="library-import-course"
            className="motion-coursework-input"
            value={importCourseId}
            disabled={Boolean(busy)}
            onChange={(event) => setImportCourseId(event.target.value)}
          >
            <option value="">No course</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.code ?? course.name}
              </option>
            ))}
          </select>
        </div>
        <input
          ref={fileInput}
          id="library-file"
          hidden
          aria-label="Choose a PDF or PowerPoint"
          type="file"
          accept=".pdf,.pptx"
          disabled={Boolean(busy)}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            void perform('Indexing file…', async () => {
              if (!bridge.importDocument) throw new Error('Refresh Motion to import files.');
              const result = await bridge.importDocument(file, importCourseId || null);
              if (!result.ok) throw new Error(result.message);
              if (!result.data) throw new Error('Motion did not save the file.');
              return indexed(result.data.document);
            });
          }}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={Boolean(busy)}
          onClick={() => fileInput.current?.click()}
        >
          Import a PDF or PowerPoint
        </Button>
      </section>
      {busy ? (
        <div className="flex flex-wrap gap-3 items-center">
          <p role="status" className="text-sm text-ink-muted">
            {bridge.documentImportStatus?.() === 'saving' ? 'Saving index…' : busy}
          </p>
          {busy === 'Indexing file…' &&
          bridge.cancelDocumentImport &&
          bridge.documentImportStatus?.() !== 'saving' ? (
            <Button variant="quiet" onClick={() => bridge.cancelDocumentImport?.()}>
              Cancel indexing
            </Button>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p
          role={message.error ? 'alert' : 'status'}
          className={
            message.error
              ? 'text-sm text-attention break-words'
              : 'text-sm text-ink-muted break-words'
          }
        >
          {message.text}
        </p>
      ) : null}
      <form
        className="grid gap-3 border-t border-rule pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSelected(null);
          setMessage(null);
          void load();
        }}
      >
        <div className="grid gap-1">
          <label htmlFor="library-search" className="text-sm font-medium">
            Search document text
          </label>
          <input
            id="library-search"
            type="search"
            className="motion-coursework-input"
            value={query}
            maxLength={500}
            placeholder="A concept, phrase or file title"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="library-course" className="text-xs font-medium">
            Course
          </label>
          <select
            id="library-course"
            className="motion-coursework-input"
            value={courseId}
            onChange={(event) => setCourseId(event.target.value)}
          >
            <option value="all">All courses</option>
            <option value="">No course</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.code ?? course.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary" disabled={Boolean(busy)}>
          Search library
        </Button>
      </form>
      <p role="status" className="text-xs text-ink-muted">
        {library.total} {library.total === 1 ? 'document' : 'documents'}
        {library.truncated ? ' · Showing the first 40; refine your search' : ''}
      </p>
      {library.documents.length ? (
        <ul className="grid gap-5" aria-label="Indexed documents">
          {library.documents.map((document) => (
            <li key={document.id} className="grid gap-2 border-t border-rule pt-3">
              <h2 className="text-sm font-medium break-words">{document.title}</h2>
              <p className="text-xs text-ink-muted">
                {document.format.toUpperCase()} · {document.indexedUnitCount} of{' '}
                {document.totalUnits} {document.format === 'pdf' ? 'pages' : 'slides'} ·{' '}
                {courseNames.get(document.courseId ?? '') ?? 'No course'}
              </p>
              {document.warnings.map((warning, index) => (
                <p key={index} className="text-xs text-attention">
                  {warning}
                </p>
              ))}
              {document.matches.map((match) => (
                <div key={match.number} className="border-l border-rule pl-3">
                  <p className="text-xs text-ink-muted">
                    {document.format === 'pdf' ? 'Page' : 'Slide'} {match.number}
                  </p>
                  <p className="text-sm break-words whitespace-pre-wrap">{match.text}</p>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="quiet"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void perform('Opening text…', async () => {
                      const generation = libraryGeneration.current;
                      const result = await request<{ document: IndexedDocument | null }>({
                        type: 'get-document',
                        id: document.id,
                      });
                      if (generation !== libraryGeneration.current)
                        throw new Error('The library changed. Open the document again.');
                      if (!result.document) throw new Error('This document is no longer indexed.');
                      if (mounted.current) {
                        setSelected(result.document);
                        setUnit(
                          document.matches[0]?.number ?? result.document.units[0]?.number ?? 1,
                        );
                      }
                    })
                  }
                >
                  Read text from {document.title}
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void perform('Removing index…', async () => {
                      await request({ type: 'delete-document', id: document.id });
                      if (selected?.id === document.id) setSelected(null);
                      await load();
                      return 'Local index removed. You can import the file again.';
                    })
                  }
                >
                  Remove {document.title}
                </Button>
              </div>
              {document.sourcePageUrl ? (
                <SourceLink href={document.sourcePageUrl} pageTitle="Open source topic" />
              ) : (
                <p className="text-xs text-ink-muted">Imported from your device</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">
          No indexed documents match. Add a file or try another search.
        </p>
      )}
      {selected ? (
        <section aria-labelledby="library-preview" className="grid gap-3 border-t border-rule pt-4">
          <h2
            ref={previewHeading}
            tabIndex={-1}
            id="library-preview"
            className="font-serif text-lg break-words"
          >
            Text from {selected.title}
          </h2>
          <label htmlFor="library-unit" className="text-xs font-medium">
            {selected.format === 'pdf' ? 'Page' : 'Slide'}
          </label>
          <select
            id="library-unit"
            className="motion-coursework-input"
            value={unit}
            onChange={(event) => setUnit(Number(event.target.value))}
          >
            {selected.units.map((part) => (
              <option key={part.number} value={part.number}>
                {selected.format === 'pdf' ? 'Page' : 'Slide'} {part.number}
              </option>
            ))}
          </select>
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
            {previewUnit?.text.trim() || 'No selectable text on this page or slide.'}
          </p>
          <Button type="button" variant="quiet" onClick={() => setSelected(null)}>
            Close text preview
          </Button>
        </section>
      ) : null}
    </div>
  );
}
