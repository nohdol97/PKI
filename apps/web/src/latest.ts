// Two small guards for screens whose requests can overlap (X02F-R4, R6). Kept out of the components: the web
// unit tests have no DOM, so a rule inside a hook would be out of their reach (X02F-D5).

/** `begin()` starts a request and returns a check that is true only while no later request has begun. */
export function createLatest(): { begin(): () => boolean } {
  let newest = 0;
  return {
    begin() {
      const mine = ++newest;
      return () => mine === newest;
    },
  };
}

/** Runs one job at a time: while one is out the next is not started and the answer is `undefined`. */
export function createBusy(): <T>(work: () => Promise<T>) => Promise<T> | undefined {
  let busy = false;
  return (work) => {
    if (busy) return undefined;
    busy = true;
    const release = () => {
      busy = false;
    };
    try {
      return work().finally(release);
    } catch (error) {
      release();
      throw error;
    }
  };
}
