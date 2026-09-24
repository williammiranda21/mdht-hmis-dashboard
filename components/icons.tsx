/** Shared stroke icons (2026-09-24 emoji sweep) — one visual language across
 *  every control: 24-viewBox feather-style paths, currentColor, stroke 2.
 *  Same rendering on county Windows, iPhones, and Android — emojis weren't.
 *  Usage: <IconPrinter /> (defaults 13px) or <IconPrinter size={14} />. */

const P = (size: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none' as const,
  stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  'aria-hidden': true as const, style: { flexShrink: 0 },
});

export const IconPrinter = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
);
export const IconDownload = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
);
export const IconSmartphone = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
);
export const IconSearch = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
);
export const IconPencil = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
);
export const IconTrash = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
);
export const IconMapPin = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>
);
export const IconMap = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21"/><line x1="8" y1="3" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="21"/></svg>
);
export const IconCompass = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
);
export const IconLink = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
);
export const IconQr = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="14" y1="14" x2="17" y2="14"/><line x1="21" y1="14" x2="21" y2="17"/><line x1="14" y1="17" x2="14" y2="21"/><line x1="17" y1="21" x2="21" y2="21"/></svg>
);
export const IconHome = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
);
export const IconSliders = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
);
export const IconTrendUp = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
);
export const IconAlertTriangle = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
);
export const IconClock = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
);
export const IconInflow = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
);
export const IconShuffle = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
);
export const IconFunnel = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
);
export const IconTarget = ({ size = 13 }: { size?: number }) => (
  <svg {...P(size)}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
);
