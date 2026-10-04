import {
  DOCUMENT_LIMITS,
  DocumentParseError,
  documentWarnings,
  parsedDocumentSchema,
} from '@/core/documents/contracts';
import type { ParsedDocument } from '@/core/documents/contracts';
import { parseXml } from './xml';
import type { XmlElement } from './xml';
import { SlideArchive } from './zip';

const PRESENTATION_NS = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const DRAWING_NS = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const OFFICE_REL_NS = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
];
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPE_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

function invalid(): never {
  throw new DocumentParseError('This file is not a supported PowerPoint slide document.');
}

function elements(root: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const pending = [root];
  while (pending.length) {
    const element = pending.pop()!;
    result.push(element);
    for (let index = element.children.length - 1; index >= 0; index--)
      pending.push(element.children[index]!);
  }
  return result;
}

function slideTarget(target: string): string {
  // Resolve only internal, canonical slide package parts. External targets,
  // parent traversal, URL encoding and alternate parts are never followed.
  const path = target.startsWith('/ppt/') ? target.slice(1) : `ppt/${target}`;
  if (!/^ppt\/slides\/slide[0-9]+\.xml$/.test(path)) invalid();
  return path;
}

/** OOXML slide order comes from presentation.xml's relationship IDs. */
export function parsePptx(bytes: Uint8Array): ParsedDocument {
  const archive = new SlideArchive(bytes);
  if (archive.names().some((name) => /(?:^|\/)vbaProject\.bin$/i.test(name))) invalid();
  const contentTypes = parseXml(archive.readXml('[Content_Types].xml'));
  if (contentTypes.namespace !== CONTENT_TYPE_NS || contentTypes.localName !== 'Types') invalid();
  const presentationType = contentTypes.children.find(
    (element) =>
      element.localName === 'Override' &&
      element.namespace === CONTENT_TYPE_NS &&
      element.attributes.get('PartName') === '/ppt/presentation.xml',
  );
  if (
    presentationType?.attributes.get('ContentType') !==
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
  )
    invalid();
  const presentation = parseXml(archive.readXml('ppt/presentation.xml'));
  if (!PRESENTATION_NS.has(presentation.namespace) || presentation.localName !== 'presentation')
    invalid();
  const slideList = presentation.children.find(
    (element) => PRESENTATION_NS.has(element.namespace) && element.localName === 'sldIdLst',
  );
  if (!slideList || slideList.children.length < 1 || slideList.children.length > 1_000_000)
    invalid();
  const ids = slideList.children.map((element) => {
    if (!PRESENTATION_NS.has(element.namespace) || element.localName !== 'sldId') invalid();
    const id = OFFICE_REL_NS.map((namespace) => element.attributes.get(`{${namespace}}id`)).find(
      Boolean,
    );
    if (!id) invalid();
    return id;
  });
  if (new Set(ids).size !== ids.length) invalid();
  const relationships = parseXml(archive.readXml('ppt/_rels/presentation.xml.rels'));
  if (relationships.namespace !== PACKAGE_REL_NS || relationships.localName !== 'Relationships')
    invalid();
  const targets = new Map<string, string>();
  const relationshipIds = new Set<string>();
  for (const element of relationships.children) {
    if (element.namespace !== PACKAGE_REL_NS || element.localName !== 'Relationship') invalid();
    const id = element.attributes.get('Id');
    const type = element.attributes.get('Type');
    if (!id || !type || relationshipIds.has(id)) invalid();
    relationshipIds.add(id);
    if (!OFFICE_REL_NS.some((namespace) => type === `${namespace}/slide`)) continue;
    if (element.attributes.has('TargetMode')) invalid();
    const target = element.attributes.get('Target');
    if (!target) invalid();
    targets.set(id, slideTarget(target));
  }
  if (
    ids.some((id) => !targets.has(id)) ||
    new Set(ids.map((id) => targets.get(id))).size !== ids.length
  )
    invalid();
  const units: ParsedDocument['units'] = [];
  let totalChars = 0;
  let truncated = ids.length > DOCUMENT_LIMITS.units;
  for (let index = 0; index < Math.min(ids.length, DOCUMENT_LIMITS.units); index++) {
    if (totalChars >= DOCUMENT_LIMITS.totalChars) {
      truncated = true;
      break;
    }
    const slide = parseXml(archive.readXml(targets.get(ids[index]!)!));
    if (!PRESENTATION_NS.has(slide.namespace) || slide.localName !== 'sld') invalid();
    const limit = Math.min(DOCUMENT_LIMITS.unitChars, DOCUMENT_LIMITS.totalChars - totalChars);
    let text = '';
    for (const element of elements(slide)) {
      if (DRAWING_NS.has(element.namespace) && element.localName === 't') {
        const addition = `${text ? ' ' : ''}${element.text}`;
        if (text.length + addition.length > limit) {
          truncated = true;
          text += addition.slice(0, limit - text.length);
          break;
        }
        text += addition;
      }
    }
    text = text.trim();
    totalChars += text.length;
    units.push({ number: index + 1, text });
  }
  const result = {
    format: 'pptx' as const,
    units,
    totalUnits: ids.length,
    truncated,
    warnings: [] as string[],
  };
  result.warnings = documentWarnings(result);
  return parsedDocumentSchema.parse(result);
}
