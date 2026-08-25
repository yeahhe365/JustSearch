# Settings Icon Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make JustSearch Settings icons pixel-identical to AMC-WebUI by replacing 5 tab icons + all in-panel action icons with AMC's exact SVG paths.

**Architecture:** New `settings-icons.js` ESM module exports AMC SVG factories (StrokeIcon base + lucide/custom paths). `index.html` hard-codes 5 tab SVGs, `settings-modal.js` imports factories for dynamic DOM, CSS adds `svg` sizing alongside existing `.material-symbols-rounded` rules.

**Tech Stack:** Vanilla JS ESM, inline SVG (no dependencies), CSS, HTML — no lucide-react runtime, no backend.

## Global Constraints

- Do not modify files outside Settings (sidebar, chat input, overlays, toasts, backend Python).
- Do not add `lucide-react` dependency.
- Tab mapping is locked: `general→LayoutPanelLeft`, `api→KeyRound`, `bridge→IconMcp`, `system→IconData`, `about→IconAbout`.
- SVG base must match `iconPrimitives.ts:StrokeIcon`: `viewBox 0 0 24 24`, `fill none`, `stroke currentColor`, `strokeWidth 2` (2.2 active), `strokeLinecap round`, `strokeLinejoin round`, `aria-hidden true`.
- Keep `material-symbols.woff2` and existing `.material-symbols-rounded` CSS for non-Settings areas.

---

### Task 1: Create `settings-icons.js` module

**Files:**
- Create: `backend/static/js/modules/settings-icons.js`
- Test: `tests/frontend/settings-icons.test.mjs` (new)

**Interfaces:**
- Consumes: nothing (pure SVG strings)
- Produces:
  - `createSettingsTabIcon(tabId: string): SVGSVGElement` — returns tab SVG (18×18, strokeWidth 2)
  - `createActionIcon(name: 'delete'|'add'|'expand_more'|'expand_less'|'check'|'settings'|'verified'|'check_circle'|'error'|'progress_activity'|'network_check', size?: number): SVGSVGElement`
  - `SETTINGS_TAB_ICONS: Record<string, string>` — raw path strings for HTML hard-coding

- [ ] **Step 1: Write failing test**

```js
// tests/frontend/settings-icons.test.mjs
import assert from 'node:assert';
import { test } from 'node:test';
import { createSettingsTabIcon, createActionIcon } from '../../backend/static/js/modules/settings-icons.js';

test('createSettingsTabIcon general returns LayoutPanelLeft SVG', () => {
  const el = createSettingsTabIcon('general');
  assert.equal(el.tagName.toLowerCase(), 'svg');
  assert.equal(el.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(el.getAttribute('fill'), 'none');
  assert.equal(el.getAttribute('stroke'), 'currentColor');
  // LayoutPanelLeft contains two <rect> or <path> for panel — check child count
  assert.ok(el.innerHTML.includes('M3') || el.innerHTML.includes('rect'));
});

test('createSettingsTabIcon bridge returns IconMcp (not extension)', () => {
  const el = createSettingsTabIcon('bridge');
  assert.ok(el.innerHTML.includes('M15.688')); // IconMcp path prefix
});

test('createActionIcon delete returns Trash2 path', () => {
  const el = createActionIcon('delete', 16);
  assert.equal(el.getAttribute('width'), '16');
  assert.equal(el.getAttribute('height'), '16');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/frontend/settings-icons.test.mjs`
Expected: FAIL with `Cannot find module '../../backend/static/js/modules/settings-icons.js'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/static/js/modules/settings-icons.js`:

```js
// Reuse AMC iconPrimitives StrokeIcon base + AMC icon paths verbatim
const NS = 'http://www.w3.org/2000/svg';

function baseSvg(size = 18, strokeWidth = 2, className = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

// AMC SettingsIcons.tsx — IconData (database stack) paths
const ICON_DATA_INNER = `<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>`;
const ICON_ABOUT_INNER = `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`;
// AMC GeneralIcons.tsx — IconMcp paths
const ICON_MCP_INNER = `<path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z"/><path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z"/>`;
// lucide paths — pinned from AMC's lucide-react version (use exact paths from node_modules/lucide)
const LUCIDE_LAYOUT_PANEL_LEFT = `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>`;
const LUCIDE_KEY_ROUND = `<path d="M2 18l1.4-1.4a3 3 0 0 1 3-3H10l.5-3.5a3 3 0 0 1 3-3H20a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2.5a3 3 0 0 0-3 3V18a3 3 0 0 1-3 3 3 3 0 0 1-3-3z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>`;
const LUCIDE_TRASH2 = `<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`;
const LUCIDE_PLUS = `<path d="M5 12h14"/><path d="M12 5v14"/>`;
const LUCIDE_CHEVRON_DOWN = `<path d="M6 9l6 6 6-6"/>`;
const LUCIDE_CHECK = `<path d="M20 6L9 17l-5-5"/>`;
const LUCIDE_SETTINGS = `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 9 15a1.65 1.65 0 0 0-1-1.51A1.65 1.65 0 0 0 6.18 13l-.06-.06A2 2 0 1 1 8.95 10.11l.06.06A1.65 1.65 0 0 0 10.83 10.5a1.65 1.65 0 0 0 1-1.51V9a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06A2 2 0 1 1 21.83 12.94l-.06.06A1.65 1.65 0 0 0 19.4 15z"/>`;
const LUCIDE_VERIFIED = `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="M9 12l2 2 4-4"/>`;

const TAB_MAP = {
  general: LUCIDE_LAYOUT_PANEL_LEFT,
  api: LUCIDE_KEY_ROUND,
  bridge: ICON_MCP_INNER,
  system: ICON_DATA_INNER,
  about: ICON_ABOUT_INNER,
};
const ACTION_MAP = {
  delete: LUCIDE_TRASH2,
  add: LUCIDE_PLUS,
  check: LUCIDE_CHECK,
  settings: LUCIDE_SETTINGS,
  verified: LUCIDE_VERIFIED,
  expand_more: LUCIDE_CHEVRON_DOWN,
  expand_less: `<path d="M6 15l6-6 6 6"/>`,
  check_circle: `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>`,
  error: `<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/>`,
  progress_activity: `<path d="M21 12a9 9 0 1 1-6.219-8.56"/>`,
  network_check: `<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2 6A2 2 0 0 1 13.66 21H12"/>`,
};

export function createSettingsTabIcon(tabId, size=18, strokeWidth=2) {
  const inner = TAB_MAP[tabId];
  if (!inner) { console.warn('[settings-icons] unknown tab', tabId); const s=baseSvg(size,strokeWidth); return s; }
  const svg = baseSvg(size, strokeWidth);
  svg.innerHTML = inner;
  return svg;
}
export function createActionIcon(name, size=16, strokeWidth=2, className='') {
  const inner = ACTION_MAP[name];
  if (!inner) { console.warn('[settings-icons] unknown action', name); return baseSvg(size,strokeWidth,className); }
  const svg = baseSvg(size, strokeWidth, className);
  svg.innerHTML = inner;
  return svg;
}
export const SETTINGS_TAB_ICONS = TAB_MAP;
```

Note: before committing, verify lucide paths by opening `node_modules/lucide/dist/esm/icons/layout-panel-left.js` etc. — if path differs, copy exact `d` attribute.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/frontend/settings-icons.test.mjs`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WD_BLACK/Code/JustSearch add backend/static/js/modules/settings-icons.js tests/frontend/settings-icons.test.mjs
git -C /Volumes/WD_BLACK/Code/JustSearch commit -m "feat(settings): add settings-icons SVG module aligned with AMC"
```

---

### Task 2: Patch `index.html` — 5 tab icons

**Files:**
- Modify: `backend/static/index.html:391-414` (the 5 `.settings-tab-btn` blocks)

**Interfaces:**
- Consumes: raw SVG strings from Task 1 (hard-coded for no-JS render)
- Produces: static HTML with inline SVGs (no JS dependency)

- [ ] **Step 1: Write failing visual test (manual)**

Before change, open `http://127.0.0.1:8001`, screenshot Settings tabs. Note `general` shows `settings` gear — this is the bug.

- [ ] **Step 2: Patch HTML**

Replace each tab's `<span class="material-symbols-rounded">NAME</span>`:

```html
<!-- general: was <span>settings</span> -->
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>

<!-- api: keep key but now SVG instead of font -->
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18l1.4-1.4a3 3 0 0 1 3-3H10l.5-3.5a3 3 0 0 1 3-3H20a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2.5a3 3 0 0 0-3 3V18a3 3 0 0 1-3 3 3 3 0 0 1-3-3z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></svg>

<!-- bridge: was extension → now IconMcp -->
<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z"/><path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z"/></svg>

<!-- system: database -->
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>

<!-- about: info circle -->
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
```

For `IconMcp` (bridge) keep `fill="currentColor"` as in AMC (it is a filled icon, not stroke).

- [ ] **Step 3: Verify manually**

Open `http://127.0.0.1:8001`, Settings tabs now show AMC-equivalent icons, no font flash.

- [ ] **Step 4: Commit**

```bash
git -C /Volumes/WD_BLACK/Code/JustSearch add backend/static/index.html
git -C /Volumes/WD_BLACK/Code/JustSearch commit -m "feat(settings): align 5 tab icons to AMC SVG (index.html)"
```

---

### Task 3: Patch `settings-modal.js` — dynamic icons

**Files:**
- Modify: `backend/static/js/modules/settings-modal.js` (imports + every `createElement span.material-symbols-rounded` site)

**Interfaces:**
- Consumes: `createActionIcon` from Task 1
- Produces: same DOM structure but with `<svg>` instead of `<span>`

- [ ] **Step 1: Write failing test (existing behavior)**

Add to `tests/frontend/settings-icons.test.mjs`:

```js
test('settings-modal dynamic icons use SVG not font', async () => {
  // This test will be added after patch — before patch it fails because settings-modal still creates spans
  const js = await import('node:fs').then(m => m.readFileSync('backend/static/js/modules/settings-modal.js','utf8'));
  assert.ok(!js.includes('provider-collapse-icon">expand_more'), 'should not contain raw expand_more span');
  assert.ok(js.includes('createActionIcon'), 'should import createActionIcon');
});
```

Run: `node --test tests/frontend/settings-icons.test.mjs` → FAIL (still contains span)

- [ ] **Step 2: Implement patch**

Top of `backend/static/js/modules/settings-modal.js`, add:

```js
import { createActionIcon } from './settings-icons.js';
```

Then for each site (line numbers from current file, search `material-symbols`):

- `~1227: <span class="material-symbols-rounded provider-collapse-icon">expand_more</span>` → create via `createActionIcon('expand_more',18,2,'provider-collapse-icon')` and append; for the toggle logic that does `icon.textContent = collapsed ? 'expand_more' : 'expand_less'`, replace with re-creating SVG or swapping innerHTML via `createActionIcon(collapsed? 'expand_more':'expand_less',18,2,'provider-collapse-icon')`.

Simplest: keep a container `<span class="provider-collapse-icon">` but put SVG inside. Replace the text-swap with:

```js
const iconSlot = collapseBtn.querySelector('.provider-collapse-icon');
function setCollapsedIcon(collapsed) {
  iconSlot.replaceChildren(createActionIcon(collapsed ? 'expand_more' : 'expand_less', 18, 2));
}
```

Do similarly for:
- `delete` buttons (provider card, model row, manager row) — `createActionIcon('delete',16)`
- `check` in `.provider-key-check` — `createActionIcon('check',16)`
- `model-panel-icon expand_more` — same as collapse
- `settings` (manage models) — `createActionIcon('settings',16)`
- `add` (add model) — `createActionIcon('add',16)`
- `verified` (test) — `createActionIcon('verified',16)`
- `renderConnectionTestResult` — `icon` is created via `document.createElement('span')` + `className='material-symbols-rounded'` + `textContent` → replace with `createActionIcon(state==='success'?'check_circle': state==='error'?'error':'progress_activity',16)`
- `renderEngineCheckStatus` / `renderEngineCheckResults` — same
- `setSettingsSaveStatus` — `icon.textContent = stateConfig.icon` is font name → replace with mapping: `saved→check_circle`, `pending→progress_activity`, `saving→progress_activity`, `invalid→error`, `error→error` (pick closest lucide)

Keep function signatures unchanged.

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test tests/frontend/settings-icons.test.mjs`
Expected: PASS

Also run existing: `node --test tests/frontend/live-artifacts.test.mjs --test-name-pattern="Phase 2.2"` → still PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Volumes/WD_BLACK/Code/JustSearch add backend/static/js/modules/settings-modal.js tests/frontend/settings-icons.test.mjs
git -C /Volumes/WD_BLACK/Code/JustSearch commit -m "feat(settings): replace dynamic material-symbols with AMC SVG in settings-modal"
```

---

### Task 4: Patch CSS — `input-modal.css` + `polish.css`

**Files:**
- Modify: `backend/static/css/sections/input-modal.css` (around 1115, 1210, 1403 etc.)
- Modify: `backend/static/css/sections/polish.css` (around 493, 582 etc.)
- Modify: `backend/static/css/style.css` is generated — do not edit manually (will be rebuilt)

**Interfaces:**
- Consumes: SVG elements produced by Tasks 2/3
- Produces: correctly sized/colored icons

- [ ] **Step 1: Write failing visual check**

Before patch, `settings-tab-btn svg` has no rule — icons will be 24×24 default, not 18×18, and color may not match.

- [ ] **Step 2: Implement**

In `backend/static/css/sections/input-modal.css`, after existing `.settings-tab-btn .material-symbols-rounded` block, add parallel `svg` rules:

```css
.settings-tab-btn .material-symbols-rounded,
.settings-tab-btn svg {
    color: var(--text-muted);
    font-size: 19px; /* for font fallback */
    transition: color var(--transition-fast);
    width: 18px;
    height: 18px;
    flex-shrink: 0;
}
.settings-tab-btn.active .material-symbols-rounded,
.settings-tab-btn.active svg {
    color: var(--text-primary);
}
/* AMC active strokeWidth 2.2 — emulate via stroke-width */
.settings-tab-btn.active svg {
    stroke-width: 2.2;
}
```

Similarly for other sites — add `svg` to existing selectors:

- `.settings-tab-btn .material-symbols-rounded` → `, .settings-tab-btn svg`
- `.settings-save-status .material-symbols-rounded` → `, .settings-save-status svg`
- `.engine-check-btn .material-symbols-rounded` → `, .engine-check-btn svg`
- `.provider-test-result .material-symbols-rounded` → `, .provider-test-result svg`
- `.provider-key-check .material-symbols-rounded` → `, .provider-key-check svg`
- `.model-manager-search-wrap .material-symbols-rounded` → `, .model-manager-search-wrap svg`

In `backend/static/css/sections/polish.css`, same pattern.

Do not delete existing `.material-symbols-rounded` rules.

- [ ] **Step 3: Manual verify + build**

Run: `npm run build` (workdir `/Volumes/WD_BLACK/Code/JustSearch` — must set `workdir`, not default Desktop)
Check: `backend/static/dist/css/style.css` contains `.settings-tab-btn svg`

- [ ] **Step 4: Commit**

```bash
git -C /Volumes/WD_BLACK/Code/JustSearch add backend/static/css/sections/input-modal.css backend/static/css/sections/polish.css
git -C /Volumes/WD_BLACK/Code/JustSearch commit -m "style(settings): add svg sizing alongside material-symbols for AMC alignment"
```

---

### Task 5: Build verification & Docker deploy

**Files:** none (verification only)

- [ ] **Step 1: Build**

```bash
workdir=/Volumes/WD_BLACK/Code/JustSearch npm run build
# Expected: app.js 19.x KiB, style.css 154.x KiB, no errors
```

- [ ] **Step 2: Run targeted tests**

```bash
node --test tests/frontend/settings-icons.test.mjs
PYTHONPATH=. ./venv/bin/python -m pytest -k live_artifacts -q
# Expected: all PASS (3/3 settings-icons, 2/2 hygiene)
```

- [ ] **Step 3: Docker deploy (must use PATH fix)**

```bash
env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin /usr/local/bin/docker compose up -d --build
# Expected: container justsearch Up (healthy)
curl -sf http://127.0.0.1:8001/api/health | jq
# Expected: {"status":"ok"}
```

- [ ] **Step 4: Final visual confirmation**

Open `http://127.0.0.1:8001`, open Settings, confirm 5 tabs + provider add/delete/expand + test connection icons all render as SVG and match AMC screenshots.

---

## Self-Review

- Spec coverage: All 4 sections mapped — Task1 (icons module), Task2 (static tabs), Task3 (dynamic), Task4 (CSS), Task5 (verification). No gaps.
- Placeholder scan: No TBD/TODO, all code blocks concrete, all file paths exact, all commands exact.
- Type consistency: `createSettingsTabIcon(tabId,size,strokeWidth)` and `createActionIcon(name,size,strokeWidth,className)` signatures consistent across tasks.
