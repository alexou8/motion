/** DOM utilities are intentionally read-only; adapters run against the live LMS page. */

/** Native, open roots only; bounded even when a page has few matching controls. */
export function* openShadowMatches(root: ParentNode, selector: string): Generator<Element> {
  const pending: Element[] = [];
  let element = root.firstElementChild;
  let visited = 0;
  while (element && visited < 50_000) {
    visited += 1;
    if (element.matches(selector)) yield element;
    if (element.nextElementSibling) pending.push(element.nextElementSibling);
    const shadowChild = element.shadowRoot?.firstElementChild;
    const lightChild = element.firstElementChild;
    if (shadowChild && lightChild) pending.push(lightChild);
    element = shadowChild ?? lightChild ?? pending.pop() ?? null;
  }
}

export function composedParent(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** Link text can be projected through slots instead of stored on the anchor. */
export function elementLabelText(element: Element, limit = 500): string {
  return composedText(element, limit, false);
}

/** Assessment checks run on this bounded view before page content is stored. */
export function boundedVisibleText(document: Document, limit = 4_000): string {
  return document.body ? composedText(document.body, limit, true) : '';
}

function composedText(element: Element, limit: number, visibleOnly: boolean): string {
  const pending: Node[] = [element];
  const maxVisited = 50_000;
  let text = '';
  let visited = 0;
  while (pending.length && text.length < limit && visited < maxVisited) {
    const node = pending.pop()!;
    visited += 1;
    if (node.nodeType === Node.TEXT_NODE) {
      if (visibleOnly) {
        const root = node.getRootNode();
        const textParent = (node as Text).assignedSlot ?? node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        const style = textParent ? element.ownerDocument.defaultView?.getComputedStyle(textParent) : undefined;
        if (style?.visibility === 'hidden' || style?.visibility === 'collapse') continue;
      }
      text += ` ${node.textContent ?? ''}`.slice(0, limit - text.length);
      continue;
    }
    if (node instanceof Element) {
      if (node.matches('script, style, noscript, template')) continue;
      if (visibleOnly) {
        if (node.matches('[hidden]')) continue;
        const style = element.ownerDocument.defaultView?.getComputedStyle(node);
        // Descendants can override inherited visibility, unlike display:none.
        if (style?.display === 'none') continue;
      }
    }
    const assigned = node instanceof HTMLSlotElement ? node.assignedNodes() : [];
    const parent = node instanceof Element && node.shadowRoot ? node.shadowRoot : node;
    const children = assigned.length ? assigned : parent.childNodes;
    const remaining = maxVisited - visited - pending.length;
    for (let index = Math.min(children.length, remaining) - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  return text.replace(/\s+/g, ' ').trim();
}

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
    const match = path.match(/\/d2l\/(?:home|le\/content|le\/calendar|le)\/(\d+)(?:\/|$)/i);
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
  const text = normalizedText(copy).slice(0, 20_000) || boundedVisibleText(document, 20_000);
  if (!text) warnings.push('Readable content was empty or the page is still loading.');
  return { text, warnings };
}
