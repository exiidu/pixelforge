/** Photoshop 风格单色线性工具图标（16×16，stroke 用 currentColor）。 */

const svg = (body: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;

export const ICONS: Record<string, string> = {
  move: svg('<path d="M8 1.5v13M1.5 8h13M8 1.5 6.2 3.3M8 1.5l1.8 1.8M8 14.5l-1.8-1.8M8 14.5l1.8-1.8M1.5 8l1.8-1.8M1.5 8l1.8 1.8M14.5 8l-1.8-1.8M14.5 8l-1.8 1.8"/>'),
  select: svg('<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2.2 1.6"/>'),
  pencil: svg('<path d="M3 13.2 4 9.8l6.6-6.6a1.55 1.55 0 0 1 2.2 2.2L6.2 12 3 13.2Z"/><path d="M9.5 4.3l2.2 2.2"/>'),
  eraser: svg('<path d="M9.3 3.2l3.5 3.5-5.3 5.3H4.6l-1.9-1.9 6.6-6.9Z"/><path d="M6.4 6.4l3.4 3.4M2.5 13.5h11"/>'),
  bucket: svg('<path d="M8.3 2.6l5 5-5.1 5.1a1.4 1.4 0 0 1-2 0L3.1 9.6l5.2-5Z"/><path d="M3.4 9.6h9.2"/><path d="M14 10.6s.9 1.1.9 1.9a.95.95 0 1 1-1.9 0c0-.8 1-1.9 1-1.9Z" fill="currentColor" stroke="none"/>'),
  picker: svg('<path d="M13.4 2.6a1.8 1.8 0 0 0-2.6 0L9.4 4l.8.8-6.1 6.1-.4 2.1 2.1-.4 6.1-6.1.8.8L14 5.9a1.8 1.8 0 0 0-.6-3.3Z"/><path d="M3.7 12.3 3 13"/>'),
  detail: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14M7 5.2v3.6M5.2 7h3.6"/>'),
  alpha: svg('<rect x="2.5" y="2.5" width="11" height="11"/><path d="M2.8 13.2 13.2 2.8"/><path d="M2.5 2.5h5.5v5.5z" fill="currentColor" stroke="none" opacity=".45"/>'),
  undo: svg('<path d="M3.2 6.5h6.3a3.5 3.5 0 1 1 0 7H6.2"/><path d="M6.2 3.5l-3 3 3 3"/>'),
  redo: svg('<path d="M12.8 6.5H6.5a3.5 3.5 0 1 0 0 7h3.3"/><path d="M9.8 3.5l3 3-3 3"/>'),
  line: svg('<path d="M3 13 13 3"/>'),
  rect: svg('<rect x="2.5" y="4.5" width="11" height="7"/>'),
  ellipse: svg('<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>'),
  lasso: svg('<path d="M5 2.5v5.2a3 3 0 0 0 6 0V2.5"/><path d="M5 5.4h2.5M8.5 5.4H11"/><path d="M8 10.7v1.1"/><circle cx="8" cy="13.4" r="1"/>'),
  hand: svg('<path d="M5.5 8V3.9a1 1 0 0 1 2 0V7M7.5 6.7V3a1 1 0 0 1 2 0v4M9.5 7V3.7a1 1 0 0 1 2 0V8"/><path d="M11.5 8V6.4a1 1 0 0 1 2 0v2.8c0 2.6-1.8 4.3-4.2 4.3-2.1 0-3.2-.8-4.1-2.4L3.6 8.5c-.5-.9.6-1.8 1.4-1.2L5.5 8"/>'),
};
