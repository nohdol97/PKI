// The Connector kinds and instance ids the public code owns (I05-R7, R8): a deployment fork's
// registration can take none of them, because each carries a promise the product keeps itself
// (the synthetic class of the test kind, the user's path approval of an import kind). The one place
// they are listed: a public change that adds a kind or an instance adds it here, and
// public-kinds.test.ts fails when it does not (I05-C14 ①). Placeholders (`site-*`) are not public
// kinds: a fork replaces them by registering the same name.
/** The placeholders' names: the fork's collectors go in their place (V01-R18, ownership.md). Here, not in an adapter, so any module can read them. */
export const SITE_CONNECTOR_KINDS = ["site-mail", "site-messenger", "site-wiki"] as const;

/** Every kind name the public code uses that is not a placeholder: the composition points', the import's, the test kind. */
export const PUBLIC_CONNECTOR_KINDS: readonly string[] = [
  "jsonl-import",
  "local-files",
  "test-fixtures",
];

/** The ids of the instances a public composition point makes at the start (a source run's `fixtures`, the one `local-files`). */
export const PUBLIC_INSTANCE_IDS: readonly string[] = ["fixtures", "local-files"];

/**
 * The prefix of the id of the instance an approved JSONL file location makes while the backend runs (I02B-R41,
 * R51): the prefix, then the location's id. The one place the text is written; the code that makes the id and
 * the predicate below both read it, so a fork cannot register an id that a later approval would collide with.
 */
export const JSONL_FILE_INSTANCE_PREFIX = "jsonl-file:";

/** Whether `id` is an instance of an approved JSONL file location (I02B-R41). */
export const isJsonlFileInstanceId = (id: string): boolean =>
  id.startsWith(JSONL_FILE_INSTANCE_PREFIX);

/** The prefixes the public code gives the ids of instances it makes while running. */
export const PUBLIC_INSTANCE_ID_PREFIXES: readonly string[] = [JSONL_FILE_INSTANCE_PREFIX];

/**
 * Whether `id` is a public instance's: a public composition point's, one with a reserved prefix, or a
 * placeholder's own id. A placeholder that a registration replaced (`replaced` holds its name) frees
 * its id for the fork's own instance.
 */
export function isPublicInstanceId(
  id: string,
  replaced: ReadonlySet<string> = new Set(),
  prefixes: readonly string[] = PUBLIC_INSTANCE_ID_PREFIXES,
): boolean {
  return (
    PUBLIC_INSTANCE_IDS.includes(id) ||
    prefixes.some((prefix) => id.startsWith(prefix)) ||
    ((SITE_CONNECTOR_KINDS as readonly string[]).includes(id) && !replaced.has(id))
  );
}
