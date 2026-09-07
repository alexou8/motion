import type { ManifestV3Export } from '@crxjs/vite-plugin';

/**
 * Motion's manifest is hand-authored rather than generated, because the
 * permission set is a privacy commitment we make to students and defend in a
 * Chrome Web Store review. A permission should only ever appear here because a
 * person added it, visibly, in a diff. See docs/adr/0001-build-tooling.md.
 */
const manifest: ManifestV3Export = {
  manifest_version: 3,
  name: 'Motion — From Coursework to Completion',
  short_name: 'Motion',
  version: '0.1.0',
  description:
    'Organizes your LMS coursework: deadlines with sources, notes linked to the page they came from, and background work you can watch and control.',
  // chrome.sidePanel requires 114+; setPanelBehavior requires 116.
  minimum_chrome_version: '116',

  /**
   * Declared with no `default_popup` on purpose. The service worker calls
   * `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`, which only
   * works when no popup is registered — and a popup would duplicate the panel
   * rather than offer anything the panel does not.
   */
  action: {
    default_title: 'Open Motion',
    default_icon: {
      16: 'src/assets/icons/icon-16.png',
      32: 'src/assets/icons/icon-32.png',
    },
  },

  side_panel: { default_path: 'src/sidepanel/index.html' },
  options_page: 'src/options/index.html',

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  /**
   * `tabs` is required to read `tab.url` at all — without it the property is
   * silently `undefined`, which would look like a bug rather than a permission
   * problem. `activeTab` is deliberately absent: it grants access only on a
   * direct user gesture and does not work from a side panel, so depending on it
   * would be a defect wearing a permission's clothes.
   */
  permissions: ['storage', 'sidePanel', 'tabs', 'tabGroups', 'scripting', 'alarms'],

  /** Built-in access is limited to D2L Brightspace hosts and nothing else. */
  host_permissions: [
    'https://*.brightspace.com/*',
    'https://*.desire2learn.com/*',
    'https://mylearningspace.wlu.ca/*',
  ],

  /**
   * Institution deployments live on their own domains. Rather than shipping a
   * broad grant, Motion asks for one host at a time, from a user gesture, and
   * the student can revoke it.
   */
  optional_host_permissions: ['https://*/*'],

  content_scripts: [
    {
      matches: [
        'https://*.brightspace.com/*',
        'https://*.desire2learn.com/*',
        'https://mylearningspace.wlu.ca/*',
      ],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],

  icons: {
    16: 'src/assets/icons/icon-16.png',
    32: 'src/assets/icons/icon-32.png',
    48: 'src/assets/icons/icon-48.png',
    128: 'src/assets/icons/icon-128.png',
  },

  /** No remote code, no eval. Everything executable ships in the package. */
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'",
  },

  // `externally_connectable` is intentionally omitted so no web page can send
  // messages to the extension. See docs/THREAT_MODEL.md T2.
};

export default manifest;
