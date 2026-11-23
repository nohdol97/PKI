// A list read in pages (X02B-R12): the first page, then "더 보기" reads the next with `before` = the last answer's
// `next` and appends it. A new read (first page again) or a later one wins; an answer to a request that is no longer
// the latest is dropped.
import { useCallback, useEffect, useRef, useState } from "react";

export interface Paged<T> {
  rows: T[];
  next: number | null;
}

/** The pages read so far plus the one after them; `shown` undefined reads the first page. */
export async function nextPage<T>(
  read: (before?: number) => Promise<Paged<T>>,
  shown: Paged<T> | undefined,
): Promise<Paged<T>> {
  if (shown?.next === null) return shown;
  const page = await read(shown?.next);
  return { rows: [...(shown?.rows ?? []), ...page.rows], next: page.next };
}

export function MoreButton({
  next,
  loading,
  onMore,
  label,
}: {
  next: number | null;
  loading: boolean;
  onMore: () => void;
  /** What the list is: the button is named by it, so two lists on a screen do not share a name. */
  label: string;
}) {
  if (next === null) return null;
  return (
    <button type="button" aria-label={`${label} 더 보기`} disabled={loading} onClick={onMore}>
      더 보기
    </button>
  );
}

/** The state of a paged list: `reload` starts again from the first page, `more` appends the next one. */
export function usePaged<T>(read: (before?: number) => Promise<Paged<T>>) {
  const [state, setState] = useState<{ shown?: Paged<T>; error?: string; loading: boolean }>({
    loading: true,
  });
  const latest = useRef(0);
  const shownRef = useRef<Paged<T> | undefined>(undefined);
  const run = useCallback(
    (from: Paged<T> | undefined) => {
      const mine = ++latest.current;
      setState((s) => ({ ...s, loading: true }));
      nextPage(read, from).then(
        (shown) => {
          if (mine !== latest.current) return;
          shownRef.current = shown;
          setState({ shown, loading: false });
        },
        (e: unknown) => {
          if (mine !== latest.current) return;
          setState({
            ...(from ? { shown: from } : {}),
            error: e instanceof Error ? e.message : String(e),
            loading: false,
          });
        },
      );
    },
    [read],
  );
  const reload = useCallback(() => run(undefined), [run]);
  const more = useCallback(() => run(shownRef.current), [run]);
  useEffect(() => {
    reload();
    return () => {
      latest.current++; // leaving: a late answer is not wanted
    };
  }, [reload]);
  return { ...state, reload, more };
}
