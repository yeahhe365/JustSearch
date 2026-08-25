// Settings icons aligned with AMC-WebUI
// Base mirrors AMC iconPrimitives StrokeIcon: viewBox 0 0 24 24, fill none, stroke currentColor, strokeWidth 2, linecap/linejoin round
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

function filledSvg(size = 18, className = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

// AMC SettingsIcons — IconData (database stack)
const ICON_DATA_INNER = '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>';
const ICON_ABOUT_INNER = '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>';
// AMC GeneralIcons — IconMcp (filled)
const ICON_MCP_INNER = '<path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z"/><path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z"/>';
// lucide — LayoutPanelLeft (AMC interface)
const LUCIDE_LAYOUT_PANEL_LEFT = '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>';

// lucide — Cloud (AMC models) — aligned with lucide-react Cloud
const LUCIDE_CLOUD = '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>';

// lucide — KeyRound (AMC api) — kept for reference, api tab now uses Cloud
const LUCIDE_KEY_ROUND = '<path d="M2.586 17.414a2 2 0 0 0 2.828 0l6-6a2 2 0 0 0 0-2.828l-1.414-1.414a2 2 0 0 0-2.828 0l-6 6a2 2 0 0 0 0 2.828z"/><circle cx="7.5" cy="7.5" r="1.5"/><path d="M14 7h4"/><path d="M17 7v4"/>';

// lucide generic
const LUCIDE_TRASH2 = '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>';
const LUCIDE_PLUS = '<path d="M5 12h14"/><path d="M12 5v14"/>';
const LUCIDE_CHEVRON_DOWN = '<path d="m6 9 6 6 6-6"/>';
const LUCIDE_CHEVRON_UP = '<path d="m6 15 6-6 6 6"/>';
const LUCIDE_CHECK = '<path d="M20 6 9 17l-5-5"/>';
const LUCIDE_CHECK_CIRCLE = '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>';
const LUCIDE_ERROR = '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>';
const LUCIDE_PROGRESS = '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>';
const LUCIDE_NETWORK_CHECK = '<path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16"/><path d="M12 12v4"/><path d="M12 8h.01"/>';
const LUCIDE_VERIFIED = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>';
const LUCIDE_SETTINGS = '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>';

const TAB_MAP = {
  general: LUCIDE_SETTINGS,
  api: LUCIDE_CLOUD,
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
  expand_less: LUCIDE_CHEVRON_UP,
  check_circle: LUCIDE_CHECK_CIRCLE,
  error: LUCIDE_ERROR,
  progress_activity: LUCIDE_PROGRESS,
  network_check: LUCIDE_NETWORK_CHECK,
};

export const SETTINGS_TAB_ICONS = TAB_MAP;

export function createSettingsTabIcon(tabId, size = 18, strokeWidth = 2) {
  const inner = TAB_MAP[tabId];
  if (!inner) {
    console.warn('[settings-icons] unknown tab', tabId);
    return baseSvg(size, strokeWidth);
  }
  // bridge is filled icon
  if (tabId === 'bridge') {
    const svg = filledSvg(size);
    svg.innerHTML = inner;
    return svg;
  }
  const svg = baseSvg(size, strokeWidth);
  svg.innerHTML = inner;
  return svg;
}

export function createActionIcon(name, size = 16, strokeWidth = 2, className = '') {
  const inner = ACTION_MAP[name];
  if (!inner) {
    console.warn('[settings-icons] unknown action', name);
    return baseSvg(size, strokeWidth, className);
  }
  const svg = baseSvg(size, strokeWidth, className);
  svg.innerHTML = inner;
  return svg;
}
