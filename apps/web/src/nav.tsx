// Moving between screens (X02-R5, D8): one way, `go(screen, target)`. The target (an item for 탐색, a page key for
// 위키) waits for the screen it names; once the user is on another screen it is dropped, so opening that screen
// from the navigation afterwards shows it plain. Nothing is stored and there is no URL or back stack.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type NavScreen = "explore" | "wiki";
export interface NavTarget {
  itemId?: number;
  wikiKey?: string;
}
export interface NavState {
  screen: NavScreen;
  target: NavTarget;
}
export interface Nav {
  go(screen: NavScreen, target: NavTarget): void;
  /** The target waiting for `screen`, if one was sent there and the user is still on it. */
  target(screen: NavScreen): NavTarget | undefined;
}

/** `pending` while `current` is the screen it names; otherwise nothing: it is dropped. */
export const pendingFor = (pending: NavState | undefined, current: string) =>
  pending?.screen === current ? pending : undefined;

const NavContext = createContext<Nav>({ go: () => undefined, target: () => undefined });
export const useNav = () => useContext(NavContext);

export function NavProvider({
  screen,
  onScreen,
  children,
}: {
  /** The screen the app shows now. */
  screen: string;
  onScreen: (screen: NavScreen) => void;
  children: ReactNode;
}) {
  const [pending, setPending] = useState<NavState>();
  useEffect(() => setPending((p) => pendingFor(p, screen)), [screen]);
  const go = useCallback(
    (to: NavScreen, target: NavTarget) => {
      setPending({ screen: to, target });
      onScreen(to);
    },
    [onScreen],
  );
  const value = useMemo<Nav>(
    () => ({ go, target: (to) => (pending?.screen === to ? pending.target : undefined) }),
    [go, pending],
  );
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
