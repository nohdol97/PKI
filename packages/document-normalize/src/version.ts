// The normalizer's version (I02B-R14): a number the file index records beside a file's content hash.
// A change that can alter what `normalizeDocument` returns for the same bytes raises it, so the
// collector can tell "the file changed" from "the parser changed".
export const NORMALIZER_VERSION = 1;
