import { DocumentParseError } from '@/core/documents/contracts';

export interface XmlElement {
  name: string;
  localName: string;
  namespace: string;
  attributes: ReadonlyMap<string, string>;
  children: XmlElement[];
  text: string;
}

const XML_LIMITS = { chars: 2_000_000, nodes: 50_000, depth: 128, attributes: 100 } as const;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function invalid(): never {
  throw new DocumentParseError('The slide document contains invalid or unsupported XML.');
}

function validCodePoint(value: number): boolean {
  return (
    value === 9 ||
    value === 10 ||
    value === 13 ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}

function decodeText(raw: string): string {
  let result = '';
  for (let i = 0; i < raw.length;) {
    const code = raw.codePointAt(i)!;
    if (!validCodePoint(code)) invalid();
    if (code !== 38) {
      result += String.fromCodePoint(code);
      i += code > 0xffff ? 2 : 1;
      continue;
    }
    const end = raw.indexOf(';', i + 1);
    if (end < 0 || end - i > 16) invalid();
    const entity = raw.slice(i + 1, end);
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) result += predefined[entity];
    else {
      if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) invalid();
      const value = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!validCodePoint(value)) invalid();
      result += String.fromCodePoint(value);
    }
    i = end + 1;
  }
  return result;
}

function splitName(name: string): [string, string] {
  const parts = name.split(':');
  if (parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(part))) invalid();
  return parts.length === 2 ? [parts[0]!, parts[1]!] : ['', name];
}

/**
 * Restricted XML 1.0 tokenizer for OOXML data, following W3C XML productions.
 * DTDs, custom entities and external resources are rejected, and no DOM exists.
 * OOXML's ASCII tag vocabulary is accepted; arbitrary Unicode remains valid text.
 */
export function parseXml(source: string): XmlElement {
  if (source.length > XML_LIMITS.chars) invalid();
  const input = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let position = 0;
  let nodes = 0;
  let root: XmlElement | undefined;
  const stack: { element: XmlElement; namespaces: Map<string, string> }[] = [];
  const whitespace = () => {
    while (/[ \t\n\r]/.test(input[position] ?? '') && position < input.length) position++;
  };
  const readName = (): string => {
    const start = position;
    if (!/[A-Za-z_]/.test(input[position] ?? '')) invalid();
    position++;
    while (/[A-Za-z0-9_.:-]/.test(input[position] ?? '') && position < input.length) position++;
    const name = input.slice(start, position);
    splitName(name);
    return name;
  };
  while (position < input.length) {
    if (input[position] !== '<') {
      const next = input.indexOf('<', position);
      const raw = input.slice(position, next < 0 ? input.length : next);
      if (raw.includes(']]>')) invalid();
      const text = decodeText(raw);
      if (stack.length) stack[stack.length - 1]!.element.text += text;
      else if (text.trim()) invalid();
      position = next < 0 ? input.length : next;
      continue;
    }
    if (input.startsWith('<!--', position)) {
      const end = input.indexOf('-->', position + 4);
      if (end < 0 || input.slice(position + 4, end).includes('--')) invalid();
      position = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', position)) {
      if (!stack.length) invalid();
      const end = input.indexOf(']]>', position + 9);
      if (end < 0) invalid();
      const text = input.slice(position + 9, end);
      for (const character of text) if (!validCodePoint(character.codePointAt(0)!)) invalid();
      stack[stack.length - 1]!.element.text += text;
      position = end + 3;
      continue;
    }
    if (input.startsWith('<?', position)) {
      const end = input.indexOf('?>', position + 2);
      if (end < 0) invalid();
      const instruction = input.slice(position + 2, end);
      // Only the declaration is relevant to OOXML; other processing instructions
      // are unsupported rather than interpreted or exposed to a browser.
      if (
        position !== 0 ||
        !/^xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])utf-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*$/i.test(
          instruction,
        )
      )
        invalid();
      position = end + 2;
      continue;
    }
    if (input.startsWith('<!', position)) invalid();
    if (input.startsWith('</', position)) {
      position += 2;
      const name = readName();
      whitespace();
      if (input[position++] !== '>' || stack.pop()?.element.name !== name) invalid();
      continue;
    }
    position++;
    const name = readName();
    const rawAttributes = new Map<string, string>();
    let selfClosing = false;
    while (position < input.length) {
      const previousPosition = position;
      whitespace();
      if (input.startsWith('/>', position)) {
        position += 2;
        selfClosing = true;
        break;
      }
      if (input[position] === '>') {
        position++;
        break;
      }
      if (previousPosition === position || rawAttributes.size >= XML_LIMITS.attributes) invalid();
      const attributeName = readName();
      if (rawAttributes.has(attributeName)) invalid();
      whitespace();
      if (input[position++] !== '=') invalid();
      whitespace();
      const quote = input[position++];
      if (quote !== '"' && quote !== "'") invalid();
      const end = input.indexOf(quote, position);
      if (end < 0 || input.slice(position, end).includes('<')) invalid();
      rawAttributes.set(
        attributeName,
        decodeText(input.slice(position, end)).replace(/[\n\t]/g, ' '),
      );
      position = end + 1;
    }
    if (
      input[position - 1] !== '>' ||
      ++nodes > XML_LIMITS.nodes ||
      stack.length >= XML_LIMITS.depth
    )
      invalid();
    const namespaces = new Map(stack[stack.length - 1]?.namespaces ?? [['xml', XML_NS]]);
    for (const [key, value] of rawAttributes) {
      if (key === 'xmlns') namespaces.set('', value);
      else if (key.startsWith('xmlns:')) {
        const prefix = key.slice(6);
        if (prefix === 'xmlns' || (prefix === 'xml' && value !== XML_NS) || !value) invalid();
        namespaces.set(prefix, value);
      }
    }
    const [prefix, localName] = splitName(name);
    if (prefix && !namespaces.has(prefix)) invalid();
    const attributes = new Map<string, string>();
    for (const [key, value] of rawAttributes) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const [attributePrefix, attributeLocal] = splitName(key);
      if (attributePrefix && !namespaces.has(attributePrefix)) invalid();
      const expanded = attributePrefix
        ? `{${namespaces.get(attributePrefix)}}${attributeLocal}`
        : attributeLocal;
      if (attributes.has(expanded)) invalid();
      attributes.set(expanded, value);
    }
    const element: XmlElement = {
      name,
      localName,
      namespace: namespaces.get(prefix) ?? '',
      attributes,
      children: [],
      text: '',
    };
    if (stack.length) stack[stack.length - 1]!.element.children.push(element);
    else if (root) invalid();
    else root = element;
    if (!selfClosing) stack.push({ element, namespaces });
  }
  if (!root || stack.length) invalid();
  return root;
}
