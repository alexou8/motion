import { describe, expect, it } from 'vitest';
import { supportedSitesSentence } from './supportedSites';

describe('supportedSitesSentence', () => {
  it('names the Brightspace domains and institution deployments Motion reads', () => {
    expect(supportedSitesSentence()).toBe(
      'Motion works on Brightspace course sites: *.brightspace.com, *.desire2learn.com, and institution deployments such as mylearningspace.wlu.ca.',
    );
  });

  it('stays readable for shorter host lists', () => {
    expect(supportedSitesSentence(['*.brightspace.com'])).toBe(
      'Motion works on Brightspace course sites: *.brightspace.com.',
    );
    expect(supportedSitesSentence(['*.brightspace.com', 'courses.example.test'])).toBe(
      'Motion works on Brightspace course sites: *.brightspace.com and institution deployments such as courses.example.test.',
    );
    expect(supportedSitesSentence([])).toBe('Motion works on Brightspace course sites.');
  });
});
