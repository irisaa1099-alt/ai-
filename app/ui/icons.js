/**
 * 内联 SVG 图标表（契约 3.4）。
 * 全部使用 stroke="currentColor"，24x24 视图框，随字号变色变大小。
 * 图标路径来自 Lucide/Feather 风格的手工精简版，无外部依赖。
 */

const S = (paths, fill = 'none') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const icons = {
  send: S('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>'),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="2"/>', 'currentColor'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  search: S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  settings: S(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'
  ),
  edit: S('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: S('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
  copy: S('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  refresh: S('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>'),
  star: S('<path d="m12 3 2.9 5.9 6.5.9-4.7 4.5 1.1 6.5L12 17.8 6.2 20.8l1.1-6.5L2.6 9.8l6.5-.9Z"/>'),
  bookmark: S('<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/>'),
  'bookmark-on': S('<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" fill="currentColor"/>'),
  pin: S('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3Z"/>'),
  bell: S('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>'),
  belloff: S('<path d="M8.7 3.7A6 6 0 0 1 18 8c0 7 3 7 3 9H8"/><path d="M3 3l18 18"/><path d="M6 8c0 7-3 7-3 9h9"/>'),
  mic: S('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4M8 22h8"/>'),
  'mic-off': S('<path d="M3 3l18 18"/><path d="M9 5a3 3 0 0 1 6 0v6"/><path d="M15 15a3 3 0 0 1-6-2V9"/><path d="M5 11a7 7 0 0 0 11 5.3"/><path d="M19 11a7 7 0 0 1-.3 2"/><path d="M12 18v4M8 22h8"/>'),
  speaker: S('<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  'speaker-off': S('<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M22 9l-5 6M17 9l5 6"/>'),
  moon: S('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>'),
  sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: S('<path d="M4 12.5 9 18 20 6"/>'),
  'chevron-down': S('<path d="m6 9 6 6 6-6"/>'),
  'chevron-up': S('<path d="m6 15 6-6 6 6"/>'),
  'chevron-left': S('<path d="m15 6-6 6 6 6"/>'),
  'chevron-right': S('<path d="m9 6 6 6-6 6"/>'),
  user: S('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  users: S('<circle cx="9" cy="8" r="3.5"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M17 5.5a3.5 3.5 0 0 1 0 6.5"/><path d="M19 21a6 6 0 0 0-2-4.5"/>'),
  image: S('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 2-2 5 5"/>'),
  download: S('<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>'),
  upload: S('<path d="M12 20V8"/><path d="m7 12 5-5 5 5"/><path d="M4 4h16"/>'),
  dice: S('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/><circle cx="12" cy="12" r="1"/>'),
  sparkles: S('<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>'),
  brain: S('<path d="M9.5 4A3.5 3.5 0 0 0 6 7.5 3 3 0 0 0 4 10.3 3 3 0 0 0 6 13a3 3 0 0 0 1.5 5.2A3.5 3.5 0 0 0 12 20V4.5A1.5 1.5 0 0 0 9.5 4Z"/><path d="M14.5 4A3.5 3.5 0 0 1 18 7.5a3 3 0 0 1 2 2.8A3 3 0 0 1 18 13a3 3 0 0 1-1.5 5.2A3.5 3.5 0 0 1 12 20"/>'),
  clock: S('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  heart: S('<path d="M12 20S3.5 14.5 3.5 9.2A4.7 4.7 0 0 1 12 6.5a4.7 4.7 0 0 1 8.5 2.7C20.5 14.5 12 20 12 20Z"/>'),
  smile: S('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>'),
  book: S('<path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2Z"/><path d="M8 3v16"/>'),
  menu: S('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  more: S('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
  link: S('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19.5"/>'),
  globe: S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>'),
  shield: S('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z"/><path d="m9 12 2 2 4-4"/>'),
  key: S('<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 2 2-2 2-2-2-2 2"/>'),
  chart: S('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  wand: S('<path d="m4 20 10-10"/><path d="m14 6 1.5-1.5"/><path d="M17 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1Z"/><path d="M19 14l.7 1.3 1.3.7-1.3.7-.7 1.3-.7-1.3-1.3-.7 1.3-.7Z"/>'),
  group: S('<path d="M3 7h7l2 2h9v10H3Z"/><path d="M3 7V5h7l2 2"/>'),
  'arrow-left': S('<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>'),
  'arrow-right': S('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
  paperclip: S('<path d="M20 11.5 11.5 20a5.5 5.5 0 1 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 1 1-2.6-2.6L14.5 7"/>'),
  refreshCw: S('<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 4.5V10h-5.5"/>'),
  quote: S('<path d="M7 7h4v5a4 4 0 0 1-4 4"/><path d="M14 7h4v5a4 4 0 0 1-4 4"/>'),
  play: S('<path d="M7 5l12 7-12 7Z"/>'),
  pause: S('<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>'),
  layers: S('<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>'),
  filter: S('<path d="M3 5h18l-7 8v6l-4-2v-4Z"/>'),
  // ---- 群聊相关 ----
  at: S('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
  'user-plus': S('<circle cx="10" cy="8" r="4"/><path d="M2 21a8 8 0 0 1 13-6.2"/><path d="M19 14v6M16 17h6"/>'),
  theater: S('<path d="M3 4h8v6a4 4 0 0 1-8 0Z"/><path d="M13 4h8v6a4 4 0 0 1-8 0Z"/><path d="M5.8 7.2h.01M8.2 7.2h.01"/><path d="M5 10.4c.9.7 2.1.7 3 0"/><path d="M15.8 7.2h.01M18.2 7.2h.01"/><path d="M15 10.4c.9.7 2.1.7 3 0"/>'),
};

/**
 * 取图标元素
 * @param {string} name
 * @param {number} size
 * @param {string} extraClass
 * @returns {HTMLElement}
 */
export function icon(name, size = 18, extraClass = '') {
  const svg = icons[name] || icons.sparkles;
  const wrap = document.createElement('span');
  wrap.className = `ic${extraClass ? ' ' + extraClass : ''}`;
  wrap.style.display = 'inline-flex';
  wrap.style.alignItems = 'center';
  wrap.style.justifyContent = 'center';
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.style.flex = '0 0 auto';
  wrap.innerHTML = svg;
  const svgEl = wrap.firstElementChild;
  if (svgEl) {
    svgEl.setAttribute('width', String(size));
    svgEl.setAttribute('height', String(size));
  }
  return wrap;
}
