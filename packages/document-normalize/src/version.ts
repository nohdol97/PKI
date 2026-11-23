// The normalizer's version (I02B-R14): a number the file index records beside a file's content hash.
// A change that can alter what `normalizeDocument` returns for the same bytes raises it, so the
// collector can tell "the file changed" from "the parser changed".
export const NORMALIZER_VERSION = 2;
// 2: DOCX comments are restored with `participants`, and `docx.comments-omitted` gives way to `xlsx.comments-omitted` (I02B-T05).
