// Turns a spoken (or typed) sentence into a draft item. Nothing here saves anything:
// the form shows the draft, highlights uncertain or missing fields, and the person confirms.
//
// Example: "Home improvement, 1959, February 2nd, $7,200, new roof."
//   -> category roofing, date February 2, 1959, cost $7,200.00, title "New roof".

import { validatePartialDate } from "./dates";
import type { Category } from "./types";
import { MAX_COST_CENTS } from "./types";

export type DraftField = "title" | "category" | "date" | "costCents";

export interface VoiceDraft {
  title: string | null;
  category: Category | null;
  year: number | null;
  month: number | null;
  day: number | null;
  costCents: number | null;
  /** Fields the parser filled but isn't sure about. */
  uncertain: DraftField[];
  /** Fields it could not find at all. */
  missing: DraftField[];
  /** Short explanations to show beside highlighted fields. */
  hints: Partial<Record<DraftField, string>>;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?";

// Keyword -> category, most specific first.
const CATEGORY_KEYWORDS: [RegExp, Category][] = [
  [/\broof(s|ing)?\b|\bshingles?\b|\bgutters?\b/, "roofing"],
  [/\bfurnace\b|\bair condition(er|ing)?\b|\bhvac\b|\bheat pump\b|\bboiler\b|\bheating\b|\bduct(s|work)?\b/, "heating_cooling"],
  [/\bplumb(ing|er)?\b|\bpipes?\b|\bwater heater\b|\bsewer\b|\bseptic\b|\bwell pump\b/, "plumbing"],
  [/\belectric(al|ian)?\b|\bwiring\b|\brewir(e|ing)\b|\bbreaker\b|\bpanel\b|\boutlets?\b/, "electrical"],
  [/\bwindows?\b|\bdoors?\b|\bstorm windows?\b|\bskylights?\b/, "windows_doors"],
  [/\baddition\b|\badded (a )?room\b|\bnew room\b|\bgarage\b|\bporch\b|\bsunroom\b/, "addition"],
  [/\bkitchen\b|\bbath(room)?\b|\bcabinets?\b|\bcounter(top)?s?\b/, "kitchen_bath"],
  [/\bfloor(s|ing)?\b|\bcarpet(ing)?\b|\bhardwood\b|\btile\b/, "flooring"],
  [/\blandscap(e|ing)\b|\bfenc(e|ing)\b|\bdriveway\b|\bpatio\b|\bsprinklers?\b|\bdeck\b|\byard\b|\btrees?\b|\bwalkway\b/, "landscaping"],
];

// --- Number words ---------------------------------------------------------

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};

/** Converts a run of number words into a number. Handles "seven thousand two hundred" and years like "nineteen fifty nine". */
function wordsToNumber(words: string[]): number | null {
  const parts = words.filter((w) => w !== "and");
  if (parts.length === 0) return null;
  const hasScale = parts.some((w) => w in SCALES);
  if (!hasScale) {
    // Split into two-digit chunks: "nineteen fifty nine" -> [19, 59]; "twenty twenty" -> [20, 20].
    const chunks: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const w = parts[i];
      if (w in TENS) {
        let v = TENS[w];
        const next = parts[i + 1];
        if (next && next in SMALL && SMALL[next] > 0 && SMALL[next] < 10 && next !== "oh") { v += SMALL[next]; i++; }
        chunks.push(v);
      } else if (w === "oh" && parts[i + 1] && parts[i + 1] in SMALL) {
        chunks.push(SMALL[parts[i + 1]]); i++; // "nineteen oh five" -> 1905
      } else if (w in SMALL) {
        chunks.push(SMALL[w]);
      } else return null;
    }
    if (chunks.length === 1) return chunks[0];
    if (chunks.length === 2 && chunks[0] >= 10) return chunks[0] * 100 + chunks[1];
    return null;
  }
  let total = 0;
  let current = 0;
  for (const w of parts) {
    if (w in SMALL) current += SMALL[w];
    else if (w in TENS) current += TENS[w];
    else if (w === "hundred") current = (current || 1) * 100;
    else if (w in SCALES) { total += (current || 1) * SCALES[w]; current = 0; }
    else return null;
  }
  return total + current;
}

const NUM_WORD = `(?:${[...Object.keys(SMALL), ...Object.keys(TENS), ...Object.keys(SCALES)].join("|")})`;
const NUM_RUN = new RegExp(`\\b${NUM_WORD}(?:(?:\\s+|-)(?:and\\s+)?${NUM_WORD})*\\b`, "gi");

/** Replaces spelled-out numbers with digits; leaves everything else alone. */
export function normalizeNumberWords(text: string): string {
  return text.replace(NUM_RUN, (run) => {
    const n = wordsToNumber(run.toLowerCase().split(/[\s-]+/));
    return n === null ? run : String(n);
  });
}

function ordinalWordToNumber(s: string): number | null {
  const w = s.toLowerCase().replace(/\s+/g, "-");
  if (w in ORDINALS) return ORDINALS[w];
  const m = /^(twenty|thirty)-(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/.exec(w);
  if (m) return TENS[m[1]] + ORDINALS[m[2]];
  return null;
}

const ORDINAL_WORD_RE =
  "((?:twenty|thirty)[\\s-](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)";

// --- Main parser ----------------------------------------------------------

export function parseTranscript(transcript: string, now: Date = new Date()): VoiceDraft {
  const draft: VoiceDraft = {
    title: null, category: null, year: null, month: null, day: null, costCents: null,
    uncertain: [], missing: [], hints: {},
  };
  const flag = (f: DraftField, hint: string) => {
    if (!draft.uncertain.includes(f)) draft.uncertain.push(f);
    draft.hints[f] = hint;
  };

  // Work on a lower-case copy; "removed" spans become commas so leftovers split cleanly into phrases.
  let s = " " + transcript.toLowerCase().replace(/[“”"]/g, " ") + " ";

  // 1. Ordinal day words right after a month name ("february second", "march twenty-first").
  s = s.replace(new RegExp(`\\b${MONTH_RE}\\s+(?:the\\s+)?${ORDINAL_WORD_RE}\\b`, "g"), (_m, mon, ord) => {
    const n = ordinalWordToNumber(ord);
    return n === null ? _m : `${mon} ${n}`;
  });
  s = s.replace(new RegExp(`\\b(?:the\\s+)?${ORDINAL_WORD_RE}\\s+of\\s+${MONTH_RE}`, "g"), (_m, ord, mon) => {
    const n = ordinalWordToNumber(ord);
    return n === null ? _m : `${mon} ${n}`;
  });

  // 2. Spelled-out numbers -> digits.
  s = normalizeNumberWords(s);

  const remove = (re: RegExp) => { s = s.replace(re, " , "); };

  // 3. Amount: "$7,200", "$7200.50", "7,200 dollars", "7200 dollars and 50 cents".
  const amountRes = [
    /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s*(?:dollars?|bucks))?(?:\s+and\s+(\d{1,2})\s+cents?)?/,
    /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:dollars?|bucks)(?:\s+and\s+(\d{1,2})\s+cents?)?/,
  ];
  const amounts: number[] = [];
  for (const re of amountRes) {
    const g = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(s))) {
      const whole = Number(m[1].replace(/,/g, ""));
      const cents = m[2] ? Number(m[2].padEnd(2, "0")) : m[3] ? Number(m[3]) : 0;
      amounts.push(whole * 100 + cents);
    }
    s = s.replace(g, " , ");
  }
  if (amounts.length >= 1) {
    draft.costCents = amounts[0];
    if (amounts.length > 1) flag("costCents", "More than one amount was heard; using the first. Please check.");
    if (draft.costCents > MAX_COST_CENTS || draft.costCents === 0) {
      flag("costCents", "This amount looks unusual. Please check.");
    }
  }

  // 4. Numeric dates: 2/2/1959 or 2-2-1959.
  const numericDate = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(s);
  if (numericDate) {
    draft.month = Number(numericDate[1]);
    draft.day = Number(numericDate[2]);
    draft.year = Number(numericDate[3]);
    remove(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  }

  // 5. Month name with optional day: "february 2nd", "feb 2", "2nd of february".
  if (draft.month === null) {
    const monthDay = new RegExp(`\\b${MONTH_RE}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\d)`);
    const dayMonth = new RegExp(`\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}`);
    const onlyMonth = new RegExp(`\\b${MONTH_RE}(?=[\\s,.;]|$)`);
    let m: RegExpExecArray | null;
    if ((m = monthDay.exec(s)) && Number(m[2]) <= 31) {
      draft.month = MONTHS[m[1]];
      draft.day = Number(m[2]);
      remove(monthDay);
    } else if ((m = dayMonth.exec(s)) && Number(m[1]) <= 31) {
      draft.month = MONTHS[m[2]];
      draft.day = Number(m[1]);
      remove(dayMonth);
    } else if ((m = onlyMonth.exec(s))) {
      // "may" is also an ordinary word; only trust it next to a year.
      const word = m[1];
      if (word !== "may" || /\bmay\s*,?\s*\d{4}\b/.test(s)) {
        draft.month = MONTHS[word];
        remove(new RegExp(`\\b${word}\\.?(?=[\\s,.;]|$)`));
      }
    }
  }

  // 6. Year: a four-digit number in range.
  if (draft.year === null) {
    const years = [...s.matchAll(/\b(1[89]\d{2}|2[01]\d{2})\b/g)].map((m) => Number(m[1]));
    if (years.length) {
      draft.year = years[0];
      if (years.length > 1) flag("date", "More than one year was heard; using the first. Please check.");
      s = s.replace(new RegExp(`\\b${draft.year}\\b`), " , ");
    }
  }

  // A day like "2nd" with no month: don't guess the month.
  if (draft.day !== null && draft.month === null) draft.day = null;

  if (draft.year !== null) {
    const err = validatePartialDate({ year: draft.year, month: draft.month, day: draft.day }, now);
    if (err) {
      flag("date", `${err} Please check.`);
      if (draft.day !== null && err.includes("days")) draft.day = null;
    }
  } else if (draft.month !== null) {
    flag("date", "A month was heard but no year. Please enter the year.");
  }

  // 7. Any leftover bare number could be an amount said without "dollars"; offer it, but flag it.
  if (draft.costCents === null) {
    const bare = /\b(\d{1,3}(?:,\d{3})+|\d{2,})(?:\.(\d{1,2}))?\b/.exec(s);
    if (bare) {
      draft.costCents = Number(bare[1].replace(/,/g, "")) * 100 + (bare[2] ? Number(bare[2].padEnd(2, "0")) : 0);
      flag("costCents", "No “dollars” was heard, so this number may not be the amount. Please check.");
      s = s.replace(bare[0], " , ");
    }
  }

  // 8. Category from keywords (look at the whole original sentence).
  const lowered = transcript.toLowerCase();
  const said = { homeImprovement: /\bhome improvements?\b/.test(lowered) };
  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (re.test(lowered)) { draft.category = cat; break; }
  }
  if (draft.category === null && said.homeImprovement) {
    draft.category = "general";
    flag("category", "Only “home improvement” was heard. Pick a more specific category if one fits.");
  }

  // 9. Title: whatever meaningful phrase is left over.
  s = s.replace(/\bhome improvements?\b/g, " , ");
  const filler = /^(?:(?:and|for|on|in|the|a|an|of|at|it|was|is|cost|costs|paid|spent|total|about|date|dated|amount|category|item|we|i|got|had|did|done|by|with|to)\b\s*)+/;
  const phrases = s
    .split(/[,;:.!?]+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .map((p) => p.replace(filler, "").replace(/\s+(?:and|for|on|in|the|a|of|at|by|with|to)$/, "").trim())
    .filter((p) => p.length > 1 && /[a-z]/.test(p));
  if (phrases.length) {
    const chosen = phrases.join(", ");
    draft.title = chosen.charAt(0).toUpperCase() + chosen.slice(1);
    if (draft.title.length > 80) {
      draft.title = draft.title.slice(0, 80).trim();
      flag("title", "The name was long and was shortened. Please check.");
    } else if (phrases.length > 1) {
      flag("title", "Several phrases were left over and combined. Please shorten the name.");
    }
  }

  if (draft.title === null) draft.missing.push("title");
  if (draft.category === null) draft.missing.push("category");
  if (draft.year === null) draft.missing.push("date");
  if (draft.costCents === null) draft.missing.push("costCents");
  return draft;
}
