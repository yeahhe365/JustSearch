# Settings Icon Alignment with AMC — Design

**Date:** 2026-08-25
**Status:** Approved (4/4 sections confirmed)
**Scope:** Settings UI icon parity between JustSearch and AMC-WebUI
**Approach:** B — Settings full SVG replacement (Tab + internal buttons)

## 1. Goal & Non-Goals

**Goal:** Make every icon in JustSearch Settings visually indistinguishable from AMC-WebUI's equivalent. Cover 5 tabs (`general`/`api`/`bridge`/`system`/`about`) and all reusable in-panel action icons (delete/add/test/verified/expand/collapse/refresh/etc.) by reusing AMC's exact SVG paths and stroke parameters (`size 18` for tabs, `16` for inline, `strokeWidth 2` idle / `2.2` active, `stroke currentColor`, `fill none`, `linecap/linejoin round`).

**Non-Goals:**
- No changes outside Settings (sidebar, chat input, overlays, toasts).
- No `lucide-react` runtime dependency.
- No backend changes.

**Tab mapping (locked):**
| JustSearch | AMC counterpart | AMC icon source |
|---|---|---|
| `general` | `interface` | `LayoutPanelLeft` (lucide) |
| `api` | `api` | `KeyRound` (lucide) |
| `bridge` | `mcp` | `IconMcp` (custom `src/components/icons/groups/GeneralIcons.tsx`) |
| `system` | `data` | `IconData` (`SettingsIcons.tsx` — database stack) |
| `about` | `about` | `IconAbout` (`SettingsIcons.tsx` — info circle) |

Internal generic mapping (representative): `Trash2` → delete, `Plus` → add, `CheckCircle2`/`XCircle` → verified/failed, `Loader2` → `progress_activity`, `RefreshCw` → `refresh`, `ChevronDown` → `expand_more`.

## 2. Architecture & Files

**New:**
- `backend/static/js/modules/settings-icons.js` — zero-dependency ESM module exporting SVG creation helpers. Each icon is a function `createIcon(name, size, strokeWidth, className?)` returning an `SVGSVGElement` via `createElementNS`. Base attributes mirror `iconPrimitives.ts:StrokeIcon`: `viewBox 0 0 24 24`, `fill none`, `stroke currentColor`, `strokeWidth`, `strokeLinecap round`, `strokeLinejoin round`, `aria-hidden true`, `width/height = size`. Paths are copied verbatim from AMC:
  - `IconData`, `IconAbout` — from `SettingsIcons.tsx`
  - `IconMcp` — from `GeneralIcons.tsx`
  - `KeyRound`, `Cloud`, `LayoutPanelLeft`, `Command` — lucide SVG paths (pinned versions from AMC's `lucide-react`)
  - Internal icons — lucide paths for `Trash2`, `Plus`, `CheckCircle2`, `XCircle`, `Loader2`, `RefreshCw`, `ChevronDown`, `Search`, `X`, `Settings2`, `Shield`, etc. Only those actually used in `settings-modal.js` are included.

**Modified:**
1. `backend/static/index.html` — 5× `.settings-tab-btn` children: replace `<span class="material-symbols-rounded">name</span>` with inline `<svg>...</svg>` (hard-coded SVG for static HTML, matching the paths exported by `settings-icons.js` for consistency). Keep label `<span data-i18n>` unchanged.
2. `backend/static/js/modules/settings-modal.js` — add `import { createSettingsTabIcon, createActionIcon } from './settings-icons.js'`; replace every `createElement('span')` + `class material-symbols-rounded` + `textContent = 'iconName'` that lives inside Settings DOM (provider card, model row, test result, collapse btn, etc.) with `createActionIcon(...)`. Preserve existing class names for test hooks where needed (e.g., `provider-collapse-icon`).
3. `backend/static/css/sections/input-modal.css` + `polish.css` — add `svg` sizing rules side-by-side with existing `.material-symbols-rounded` rules:
   ```css
   .settings-tab-btn svg { width:18px; height:18px; flex-shrink:0; }
   .settings-tab-btn.active svg { stroke-width:2.2; }
   .provider-card .provider-collapse-icon svg,
   .model-row svg { width:16px; height:16px; }
   ```
   Keep original `.material-symbols-rounded` rules for non-Settings areas; do not delete `material-symbols.woff2`.

**Not touched:** `backend/static/fonts/fonts.css`, `backend/static/dist/*` (generated), backend Python.

## 3. Rendering & Style Details

- Unified base: all Settings SVGs use `stroke currentColor` so they inherit `color` from parent (matches AMC's `className="text-[var(--theme-text-primary)]"` pattern via CSS `color`).
- Active tab stroke: `2.2` when `.active`, `2` otherwise — mirrors `SettingsSidebar.tsx:78: strokeWidth={isActive ? 2.2 : 2}`.
- Decorative only: every injected SVG has `aria-hidden="true"`; buttons retain `aria-label`/`title`.
- No font fallback needed for Settings tabs — if `material-symbols.woff2` fails, Settings icons still render.
- Compatibility: non-Settings icons (toasts, chat, etc.) continue using `material-symbols-rounded` font; no global regression.

## 4. Error Handling & Fallbacks

- If `settings-icons.js` fails to load (network error), `settings-modal.js` import will throw at module evaluation — Settings modal will not open. This is acceptable for a static asset 404 and will surface in console; no silent fallback to font icons to avoid mixed styles.
- Unknown icon name → `createActionIcon` returns a minimal empty `<svg>` (16×16) and logs `console.warn` — does not crash caller.
- `index.html` hard-coded SVGs are static — no JS dependency, so tabs render even if JS fails.

## 5. Testing & Acceptance

- **Visual:** Open `http://127.0.0.1:8001`, open Settings, screenshot 5 tabs side-by-side with AMC screenshot; stroke and size must match.
- **Functional:** Tab switching, provider expand/collapse, add/delete provider, add/delete model, test connection, model manager modal, search, close — all work, no icon flicker.
- **Regression:** `PYTHONPATH=. ./venv/bin/python -m pytest -k live_artifacts` (hygiene) and `node --test tests/frontend/live-artifacts.test.mjs --test-name-pattern="Phase 2.2"` (representative) still pass — this change touches only static assets.
- **Build:** `npm run build` or container-internal `npm ci && npm run build` produces no 404; `backend/static/dist/css/style.css` and `js` chunks reference new module.

## 6. Alternatives Considered

- **A — Tabs only:** Minimal 5-line HTML change. Rejected: leaves internal icons mismatched, fails "full Settings alignment" scope.
- **C — Global migration:** Replace all `material-symbols-rounded` with lucide SVGs. Rejected: large blast radius, high regression risk, out of scope.
- **B — Selected:** Achieves pixel-perfect parity for Settings with isolated blast radius.

## 7. Open Questions (resolved)

- Bridge → `IconMcp`: confirmed to use AMC's custom MCP SVG, not `extension`, per user approval 2026-08-25.
- Style → exact SVG, not font-name swap, per user approval.

## 8. Implementation Order

1. Create `settings-icons.js`
2. Patch `index.html` (5 tabs)
3. Patch `settings-modal.js` (dynamic icons)
4. Patch CSS (`input-modal.css`, `polish.css`)
5. Build & verify, then `docker compose up -d --build`
