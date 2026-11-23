// Menu icons (UI01-R1, R3): inline SVG drawn from the adopted mockup, lines only, hidden from assistive technology.
import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 8l5-4.5L13 8v5H3z" />,
  sources: (
    <>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </>
  ),
  notifications: (
    <>
      <path d="M4 11V7a4 4 0 018 0v4l1 1H3z" />
      <path d="M6.5 14h3" />
    </>
  ),
  wiki: (
    <path d="M2.5 3.5h4a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 00-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 008 5v8a1.5 1.5 0 011.5-1.5h4z" />
  ),
  lint: <path d="M3 8.5l3.2 3L13 4.5" />,
  ask: <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />,
  explore: (
    <>
      <circle cx="4" cy="8" r="1.6" />
      <circle cx="12" cy="4" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M5.5 7.3l5-2.6M5.5 8.7l5 2.6" />
    </>
  ),
  semantic: <path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11l-3.4 1.9.7-3.8L2.5 6.5l3.8-.5z" />,
  ontology: (
    <>
      <rect x="2.5" y="2.5" width="4" height="4" />
      <rect x="9.5" y="9.5" width="4" height="4" />
      <path d="M6.5 4.5h3v5" />
    </>
  ),
  activity: <path d="M2 8h3l2-4.5 2.5 9L11 8h3" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2v1.8M8 12.2V14M2 8h1.8M12.2 8H14M3.8 3.8l1.3 1.3M10.9 10.9l1.3 1.3M12.2 3.8l-1.3 1.3M5.1 10.9l-1.3 1.3" />
    </>
  ),
};

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
