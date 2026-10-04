import { describe, expect, it } from 'vitest';
import { parseXml } from './xml';

describe('bounded OOXML data tokenizer', () => {
  it('preserves Unicode, entities, CDATA and namespace-qualified attributes', () => {
    const xml = parseXml(
      '<?xml version="1.0" encoding="UTF-8"?><p:root xmlns:p="urn:synthetic" xmlns:r="urn:relationships" r:id="rId1"><p:t>café &amp; &#x1F393; <![CDATA[<synthetic>]]></p:t></p:root>',
    );
    expect(xml.namespace).toBe('urn:synthetic');
    expect(xml.attributes.get('{urn:relationships}id')).toBe('rId1');
    expect(xml.children[0]?.text).toBe('café & 🎓 <synthetic>');
  });

  it.each([
    '<!DOCTYPE x [<!ENTITY y SYSTEM "https://example.invalid">]><x>&y;</x>',
    '<x>&unknown;</x>',
    '<x>&#0;</x>',
    '<x>&#x110000;</x>',
    '<x>\u0001</x>',
    '<x><y></x></y>',
    '<x/><y/>',
    '<x a="1" a="2"/>',
    '<p:x/>',
    '<x p:a="1"/>',
    '<x xmlns:a="urn:x" xmlns:b="urn:x" a:v="1" b:v="2"/>',
    '<x>unfinished',
    '<x a="unfinished>',
    '<x><![CDATA[unfinished</x>',
    '<x><!-- unfinished</x>',
    '<x><!-- a--b --></x>',
    '<x>]]></x>',
    '<x a="<element"/>',
    '<?xml-stylesheet href="https://example.invalid"?><x/>',
    '<?xml version="1.0" encoding="ISO-8859-1"?><x/>',
  ])('rejects unsupported or invalid XML as data: %s', (input) => {
    expect(() => parseXml(input)).toThrow('invalid or unsupported XML');
  });

  it('enforces XML size, node and nesting budgets', () => {
    expect(() => parseXml(`<x>${'a'.repeat(2_000_000)}</x>`)).toThrow();
    expect(() => parseXml(`${'<x>'.repeat(129)}${'</x>'.repeat(129)}`)).toThrow();
    expect(() => parseXml(`<x>${'<y/>'.repeat(50_000)}</x>`)).toThrow();
  });
});
