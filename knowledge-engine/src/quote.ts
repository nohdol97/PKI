// Evidence position from a quote (V02-R6): the code finds the quote in the stored
// body and counts [start, end) in Unicode code points, the unit of storage and of
// R05. Matching is exact (A21). A quote found nowhere or more than once is
// dropped, and so is one whose span storage could not check: a match splitting a
// surrogate pair, or text after a U+0000 (SQLite's length() stops there).

export type QuoteSpan = { start: number; end: number };
export type QuoteDrop = { dropped: "quote-missing" | "quote-ambiguous" };

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** A UTF-16 index that falls between the two halves of a surrogate pair. */
const splitsPair = (text: string, i: number) =>
  i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));

export function locateQuote(body: string, quote: string): QuoteSpan | QuoteDrop {
  if (quote === "") return { dropped: "quote-missing" };
  const first = body.indexOf(quote);
  if (first === -1) return { dropped: "quote-missing" };
  if (body.indexOf(quote, first + 1) !== -1) return { dropped: "quote-ambiguous" };
  const endUnit = first + quote.length;
  if (
    splitsPair(body, first) ||
    splitsPair(body, endUnit) ||
    body.slice(0, endUnit).includes("\u0000")
  ) {
    return { dropped: "quote-missing" };
  }
  const start = [...body.slice(0, first)].length;
  return { start, end: start + [...quote].length };
}
