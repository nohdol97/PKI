// The pieces every pane is built from (UI01-R5, R6, R8): a head bar, a list row, a properties grid and the detail
// pane with its pinned action bar. They hold no state and make no requests; a screen gives them its own words.
import type { ReactNode } from "react";

/** The 48px bar on top of a pane: title, an optional count, and what belongs at the right (a switch, an action). */
export function PaneHead({
  title,
  count,
  as: Title = "h2",
  id,
  children,
}: {
  title: string;
  count?: string | number | undefined;
  as?: "h1" | "h2" | "p" | undefined;
  id?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="pane-head">
      <Title id={id} className="pane-title">
        {title}
        {count !== undefined && <span> {count}</span>}
      </Title>
      {children}
    </div>
  );
}

/**
 * One row of a list: the whole row is one button. `prefix` is words for assistive technology only, put in front of
 * the visible text so the name starts with what the button does.
 */
export function Row({
  title,
  meta,
  time,
  prefix,
  selected,
  onClick,
}: {
  title: ReactNode;
  meta?: ReactNode;
  time?: ReactNode;
  prefix?: string | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="row"
      {...(selected && { "aria-current": "true" as const })}
      onClick={onClick}
    >
      {prefix !== undefined && <span className="sr-only">{prefix}</span>}
      <span className="row-line">
        <span className="row-title">{title}</span>
        {time !== undefined && <span className="row-time">{time}</span>}
      </span>
      {meta !== undefined && <span className="row-meta">{meta}</span>}
    </button>
  );
}

/** The properties grid under a detail's title: label and value pairs. */
export function Props({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="props">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The right-hand pane: head bar, scrolling body, and the action bar pinned under it. */
export function DetailPane({
  label,
  head,
  actions,
  children,
}: {
  label: string;
  /** `right` is what the head bar holds at its right (an action that belongs to the whole pane). */
  head: { title: string; count?: string | undefined; right?: ReactNode };
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pane-detail" aria-label={label}>
      <PaneHead title={head.title} count={head.count} as="p">
        {head.right}
      </PaneHead>
      <div className="pane-body">{children}</div>
      {actions}
    </section>
  );
}

export const DETAIL_HINT = "왼쪽 목록에서 고르면 여기에 보입니다.";
