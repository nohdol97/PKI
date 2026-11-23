// X01-R2: the route is a code rule over the question's words, a pure function. No model is called.
import { normalizeForLinking } from "@pki/storage";

/** Words that ask how things relate (D7, provisional). */
export const RELATION_WORDS = [
  "의존",
  "영향",
  "담당",
  "원인",
  "관계",
  "연결",
  "소속",
  "기대",
  "때문",
  "책임",
  "누가",
  "depend",
  "impact",
  "owner",
  "cause",
  "relat",
] as const;
/** Words that point at a date or a time. */
export const TEMPORAL_WORDS = [
  "최근",
  "지난",
  "이후",
  "이전",
  "바뀐",
  "바뀌",
  "변경",
  "변했",
  "언제",
  "올해",
  "작년",
  "오늘",
  "어제",
  "현재",
  "요즘",
  "대체",
  "recent",
  "latest",
  "changed",
  "since",
  "when",
] as const;
/** The subset of temporal words that ask for what replaced what. */
export const CHANGE_WORDS = ["바뀐", "바뀌", "변경", "변했", "대체", "changed"] as const;
/** Words that ask for the whole picture. */
export const CONTEXT_WORDS = [
  "전체",
  "맥락",
  "정리",
  "개요",
  "요약",
  "배경",
  "overview",
  "summary",
  "context",
] as const;
const DATE = /\d{4}-\d{2}(?:-\d{2})?|\d{1,2}월/u;
const ISO_DATE = /\d{4}-\d{2}(?:-\d{2})?/gu;

/** Words that carry no content of their own: question words and the cues above (they steer the route, not the text match). */
const QUESTION_WORDS = [
  "무엇",
  "뭐",
  "무슨",
  "어떤",
  "어느",
  "누구",
  "어디",
  "왜",
  "어떻게",
  "알려",
  "주세요",
  "해줘",
  "인가",
  "있나",
];
const NOISE = new Set<string>([
  ...QUESTION_WORDS,
  ...RELATION_WORDS,
  ...TEMPORAL_WORDS,
  ...CONTEXT_WORDS,
]);
/** Endings stripped once from a word (the longest first) so "프로젝트는" matches "프로젝트". */
const PARTICLES = [
  "에서",
  "으로",
  "까지",
  "부터",
  "에게",
  "이다",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "도",
  "와",
  "과",
  "로",
  "만",
];
const MAX_TOKENS = 8;

const hasAny = (text: string, words: readonly string[]) => words.some((w) => text.includes(w));

export interface Wanted {
  concept: boolean;
  graph: boolean;
  temporal: boolean;
  wiki: boolean;
  vector: boolean;
}

/** Which routed strategies the question calls for, given how many items its words name. */
export function routeQuestion(question: string, itemCount: number): Wanted {
  const text = normalizeForLinking(question);
  return {
    concept: itemCount >= 1,
    graph: itemCount >= 2 || (itemCount === 1 && hasAny(text, RELATION_WORDS)),
    temporal: hasAny(text, TEMPORAL_WORDS) || DATE.test(text),
    wiki: itemCount >= 1 && hasAny(text, CONTEXT_WORDS),
    vector: true,
  };
}

export const hasChangeWord = (question: string) =>
  hasAny(normalizeForLinking(question), CHANGE_WORDS);

/** The dates (`YYYY-MM` or `YYYY-MM-DD`) the question names. */
export const explicitDates = (question: string): string[] => question.match(ISO_DATE) ?? [];

/** The content words of a question for the keyword index: normalized, noise dropped, one ending stripped, at most MAX_TOKENS. */
export function keywordTokens(question: string): string[] {
  const words = normalizeForLinking(question)
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((w) => w.length >= 2);
  const stripped = words.flatMap((w) => {
    const ending = PARTICLES.find((p) => w.endsWith(p) && w.length - p.length >= 2);
    const base = ending ? w.slice(0, -ending.length) : w;
    // X01-R21: a noise word is dropped only when the whole word (with or without one particle) is that word
    return NOISE.has(w) || NOISE.has(base) ? [] : [base];
  });
  return [...new Set(stripped)].slice(0, MAX_TOKENS);
}
