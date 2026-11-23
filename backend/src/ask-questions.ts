// The one-shot question token (X01-R8, D10). The Broker's callers name IDs only, so a question reaches the
// Broker as the candidate `question:<token>`: the text lives in this module's memory while the request that
// holds it lives, the Broker's candidate lookup reads it once, and nothing is stored. The text has no source
// of its own, so the Broker grades it as the strictest class (the same rule as any unsourced name).
import type { CandidateItems } from "@pki/providers";
import { randomUUID } from "node:crypto";

const PREFIX = "question:";

export function createQuestionTokens() {
  const open = new Map<string, string>();
  return {
    /** Holds `question` under a fresh token while `use` runs; the token is gone when it settles. */
    async hold<T>(question: string, use: (token: string) => Promise<T>): Promise<T> {
      const token = `${PREFIX}${randomUUID()}`;
      open.set(token, question);
      try {
        return await use(token);
      } finally {
        open.delete(token);
      }
    },
    /** The question of a token, once: a second read, or a token nobody holds, is undefined. */
    take(token: string): string | undefined {
      const question = open.get(token);
      open.delete(token);
      return question;
    },
  };
}

/** The tokens of this process: composition.ts's Broker and the ask path share them. */
export const askQuestions = createQuestionTokens();

/** The Broker's candidate lookup with `question:` tokens read here and every other ID left to `inner`. */
export function withAskQuestions(
  inner: CandidateItems,
  tokens: Pick<ReturnType<typeof createQuestionTokens>, "take"> = askQuestions,
): CandidateItems {
  return {
    lookup(id) {
      if (!id.startsWith(PREFIX)) return inner.lookup(id);
      const question = tokens.take(id);
      return question === undefined
        ? undefined
        : { name: question, evidenceSourceVersionIds: [], nameUnsourced: true };
    },
  };
}
