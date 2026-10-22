const paths: Record<string, string> = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  capture:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/><rect x="7" y="7" width="10" height="10" rx="2"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  inbox: '<path d="M4 4h16l2 12v4H2v-4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  settings:
    '<path d="m9 3-1 3-3 1v4l-2 1 2 3v3l3 1 1 2h6l1-2 3-1v-3l2-3-2-1V7l-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  export:
    '<path d="M12 16V3m-5 5 5-5 5 5M4 14v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  rename: '<path d="m15 4 5 5M4 15 15 4a2 2 0 0 1 5 5L9 20l-6 1Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  wave: '<path d="M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  link: '<path d="m10 13 4-4m-5 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1"/>',
};
export const icon = (name: string, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.capture}</svg>`;
