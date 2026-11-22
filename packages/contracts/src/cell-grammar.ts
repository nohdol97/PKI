// The grammar of a number and of a date in a table cell (S03-R3). One definition for
// the header-row judgement (S03-R5) and the aggregation check (S03-R10), so the two
// cannot disagree on what a cell is. A cell is compared after its surrounding
// whitespace is trimmed. XLSX numbers and dates are written in this shape by I02A-R12,
// and a CSV cell is the original text (I02A-R13), so only text that fits is a number
// or a date.

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function isNumberText(cell: string): boolean {
  return NUMBER.test(cell.trim());
}

/** The shape of S03-R3 and a day that exists in the calendar (the time of day is not range-checked). */
export function isDateText(cell: string): boolean {
  const match = DATE.exec(cell.trim());
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
