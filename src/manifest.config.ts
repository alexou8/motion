import type { ManifestV3Export } from '@crxjs/vite-plugin';

/**
 * Motion's manifest is hand-authored rather than generated, because the
 * permission set is a privacy commitment we make to students and defend in a
 * Chrome Web Store review. A permission should only ever appear here because a
 * person added it, visibly, in a diff. See docs/adr/0001-build-tooling.md.
 */
/**
 * Test-only: adds a declared (not optional) host permission for the OpenAI
 * API, used ONLY by `npm run build:e2e-provider-hosts` to produce a separate
 * `dist-e2e-provider/` build for the provider stream/stop browser check
 * (`test/e2e/provider-stream.mjs`). Headless Chromium cannot grant an
 * optional host permission without a user gesture Playwright can drive, so
 * this variant declares the host up front instead. `npm run build` (the
 * production build) never sets this env var, and
 * `src/manifest.config.test.ts` asserts the shipped manifest never contains
 * this host.
 */
const E2E_PROVIDER_BASE_URL = process.env.MOTION_E2E_PROVIDER_BASE_URL ?? 'http://127.0.0.1:8934';
const E2E_PROVIDER_HOST_PERMISSIONS =
  process.env.MOTION_E2E_PROVIDER_HOSTS === '1' ? ([`${E2E_PROVIDER_BASE_URL}/*`] as const) : ([] as const);

const manifest: ManifestV3Export = {
  manifest_version: 3,
  name: 'Motion — From Coursework to Completion',
  short_name: 'Motion',
  version: '0.1.1',
  description:
    'Organizes your LMS coursework: deadlines with sources, notes linked to the page they came from, and background work you can watch and control.',
  // chrome.sidePanel requires 114+; opening it from an action requires 116.
  minimum_chrome_version: '116',

  /**
   * Declared with no `default_popup` on purpose. The service worker handles
   * `action.onClicked` and opens the panel directly; a popup would consume that
   * event and duplicate what the panel already provides.
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
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },

  /**
   * `tabs` is required to read `tab.url` at all — without it the property is
   * silently `undefined`, which would look like a bug rather than a permission
   * problem. `activeTab` is deliberately absent: it grants access only on a
   * direct user gesture and does not work from a side panel, so depending on it
   * would be a defect wearing a permission's clothes.
   */
  permissions: ['storage', 'sidePanel', 'tabs', 'tabGroups', 'scripting', 'alarms', 'notifications'],

  /** Built-in access is limited to D2L Brightspace hosts and nothing else. */
  host_permissions: [
    'https://*.brightspace.com/*',
    'https://*.desire2learn.com/*',
    'https://mylearningspace.wlu.ca/*',
    ...E2E_PROVIDER_HOST_PERMISSIONS,
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
      js: ['src/content/content-script.ts'],
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
