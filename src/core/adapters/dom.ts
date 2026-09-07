/** DOM utilities are intentionally read-only; adapters run against the live LMS page. */

export function firstMatch(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

export function allMatches(root: ParentNode, selectors: readonly string[]): Element[] {
  const seen = new Set<Element>();
  const matches: Element[] = [];
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      if (!seen.has(element)) {
        seen.add(element);
        matches.push(element);
      }
    }
  }
  return matches;
}

export function normalizedText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

export function attributeText(element: Element, names: readonly string[]): string {
  for (const name of names) {
    const value = element.getAttribute(name)?.trim();
    if (value) return value;
  }
  return '';
}

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function absoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export function courseIdFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\/d2l\/(?:home|le\/content|le)\/(\d+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function extractWeight(text: string): number | null {
  const match = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match?.[1]) return null;
  const weight = Number(match[1]);
  return weight >= 0 && weight <= 100 ? weight : null;
}

export function readablePageText(document: Document): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const region = firstMatch(document, ['main', '[role="main"]', '.d2l-page-main', '#d2l-main-wrapper']);
  const source = region ?? document.body;
  if (!region) warnings.push('Main content region was not found; captured the document body.');
  if (!source) return { text: '', warnings: [...warnings, 'Document body is not available.'] };

  // Clone before removing navigation and scripts: the content script must not
  // alter a D2L skin, because skins often share nodes with its own controls.
  const copy = source.cloneNode(true) as Element;
  for (const element of copy.querySelectorAll('script, style, noscript, nav, header, footer, [aria-hidden="true"]')) element.remove();
  const text = normalizedText(copy).slice(0, 20_000);
  if (!text) warnings.push('Readable content was empty or the page is still loading.');
  return { text, warnings };
}
