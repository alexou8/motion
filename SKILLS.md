# Skills

Agent skills installed for this repository, at project scope for both Claude
Code (`.claude/skills/`, symlinked) and Codex (`.agents/skills/`). Versions are
pinned in [`skills-lock.json`](skills-lock.json).

Installing a skill is not the point — applying it is. The "Applied to" column
records where each one actually changed the work, and says so plainly when a
skill has not been exercised yet.

## Installed

| Skill | Source | Used in Motion for | Applied to |
| --- | --- | --- | --- |
| `chrome-extensions` | `googlechrome/modern-web-guidance` | MV3 rules, side-panel and permission constraints, CWS readiness | Manifest permission set; dropping `activeTab`; side-panel open trigger; "icons must be real files"; service-worker state rules in `docs/ARCHITECTURE.md` |
| `frontend-design` | `anthropics/skills` | Establish an intentional visual direction, avoid templated defaults | Rejecting the generated teal/orange + Plus Jakarta Sans direction; the track motif; IBM Plex choice — see `docs/DESIGN.md` |
| `ui-ux-pro-max` | `nextlevelbuilder/ui-ux-pro-max-skill` | Product-specific UX and design-system generation | Ran `--design-system`; output was landing-page shaped and rejected per the skill's own query contract. Checklist retained |
| `design-system` | `nextlevelbuilder/ui-ux-pro-max-skill` | Token architecture | Three-layer primitive → semantic → component tokens in `src/ui/tokens.css` |
| `ui-styling` | `nextlevelbuilder/ui-ux-pro-max-skill` | Keep implementation consistent with the tokens | Pending — panel components not yet built |
| `brand` | `nextlevelbuilder/ui-ux-pro-max-skill` | A restrained identity, not a generic AI-product look | Voice rules for UI copy and docs; single-accent discipline |
| `web-design-guidelines` | `vercel-labs/agent-skills` | Interface quality audit | Pending — needs rendered UI |
| `vercel-react-best-practices` | `vercel-labs/agent-skills` | React structure, rendering, bundle size | Pending — panel not yet built |
| `vercel-composition-patterns` | `vercel-labs/agent-skills` | Composable component APIs, no boolean-prop sprawl | Pending — panel not yet built |
| `accessibility` | `addyosmani/web-quality-skills` | WCAG 2.2 audit | Split of `rule` vs `edge` tokens after a failed 1.4.11 check; native `<dialog>` for approvals; contrast enforced by test |
| `performance` | `addyosmani/web-quality-skills` | Startup, content-script overhead, asset cost | Font subsetting and variable-file dedup (84KB vs 166KB) |
| `baseline-ui` | `ibelick/ui-skills` | Prevent generated-interface mistakes | Fixed z-scale; no gradients; `tabular-nums` for data; animation limited to compositor properties |
| `fixing-motion-performance` | `ibelick/ui-skills` | Compositor-friendly, reduced-motion-safe animation | Pending — no animation implemented yet |
| `webapp-testing` | `anthropics/skills` | Browser-level validation | Pending — needs a build to drive |
| `find-skills` | `vercel-labs/skills` | Discover genuine gaps | Used to find `chrome-extensions`; security-skill candidates evaluated and rejected |

## Deliberately not installed

Per the conditional rules, and because an unused skill is a maintenance cost:

- **`prisma-cli`** — no database; the MVP is local-first ([ADR 0002](docs/adr/0002-local-first-no-backend.md)).
- **ReLab Go skills** — no Go service.
- **`seo`** — a side panel is not indexable. Reconsider only for a public marketing page.
- **Three.js skills** — decorative 3D is against the design direction.
- **`react-view-transitions`** — not justified inside a narrow panel with strict motion limits.
- **`banner-design`, `slides`** — no launch or store-listing deliverable yet.
- **Security skills from the ecosystem** — searched via `find-skills`; the
  candidates were offensive-security oriented or low-install, and none cleared
  the quality bar. Security is handled through `docs/THREAT_MODEL.md` and
  adversarial review instead.

## When to invoke which

| Situation | Skill |
| --- | --- |
| Touching `manifest.config.ts`, the worker, or permissions | `chrome-extensions` |
| Building or restyling any panel UI | `frontend-design`, `design-system`, `ui-styling`, `baseline-ui` |
| Before calling UI work done | `accessibility`, `web-design-guidelines` |
| Writing React components | `vercel-react-best-practices`, `vercel-composition-patterns` |
| Adding animation | `fixing-motion-performance`, `baseline-ui` |
| Bundle or startup cost regressions | `performance` |
| End-to-end verification of a build | `webapp-testing` |
