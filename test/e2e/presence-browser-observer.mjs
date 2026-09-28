/**
 * Read-only CDP observer for Motion's intentionally closed presence shadow
 * root. This is test-browser inspection only: it neither opens the root to
 * page code nor sends a message to the content actor.
 */
function attributes(node) {
  const result = {};
  for (let index = 0; index < (node.attributes?.length ?? 0); index += 2)
    result[node.attributes[index]] = node.attributes[index + 1];
  return result;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
  for (const shadow of node.shadowRoots ?? []) walk(shadow, visit);
}

function declaration(style, name) {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style ?? '');
  return match ? Number.parseFloat(match[1]) : Number.NaN;
}

function textContent(node) {
  return [node.nodeValue ?? '', ...(node.children ?? []).map(textContent)].join('');
}

function inspect(document) {
  let host = null;
  walk(document, (node) => {
    if (attributes(node).id === 'motion-presence-root') host = node;
  });
  if (!host) return null;

  const layers = [];
  for (const root of host.shadowRoots ?? []) {
    walk(root, (node) => {
      const attrs = attributes(node);
      if (!attrs.class?.includes('motion-presence')) return;
      layers.push({
        className: attrs.class,
        text: textContent(node),
        left: declaration(attrs.style, 'left'),
        top: declaration(attrs.style, 'top'),
        width: declaration(attrs.style, 'width'),
        height: declaration(attrs.style, 'height'),
      });
    });
  }
  return { host: attributes(host), layers };
}

export async function observePresence(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');

  async function snapshot() {
    // `pierce` is CDP-only observation. Chromium includes closed roots in this
    // protocol tree while the page's `host.shadowRoot` remains null.
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    return inspect(root);
  }

  async function during(trigger, timeoutMs = 3_000) {
    const action = Promise.resolve().then(trigger);
    const deadline = Date.now() + timeoutMs;
    let seen = null;
    while (Date.now() < deadline && !seen) {
      seen = await snapshot();
      if (!seen) await page.waitForTimeout(16);
    }
    await action;
    return seen;
  }

  return { snapshot, during, close: () => cdp.detach().catch(() => undefined) };
}
