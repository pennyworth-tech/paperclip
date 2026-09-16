/**
 * PR review verdict opener — a shape guard for the instance's review protocol.
 *
 * Three responsibilities, kept in one module because the module is small and
 * the title predicate is the guard's whole blast radius:
 *
 *   1. `parseReviewVerdictOpener` — does the first non-blank line of a comment
 *      match the verdict opener the review protocol prescribes?
 *
 *   2. `isReviewIssueTitle` — does this issue's title identify it as a PR
 *      review issue? The predicate is the only thing that decides which
 *      issues the guard touches.
 *
 *   3. `firstNonBlankLine` — small helper because both the opener parser
 *      and any future chrome-stripper need it.
 *
 * The opener parser is shape-only. Whether the named sha is the pull request's
 * current head is a separate concern for whatever reconciles the two: Paperclip
 * performs no network calls and must not start here.
 */

export type ReviewVerdictKind = "APPROVE" | "REQUEST CHANGES" | "NEEDS INFO";

export interface ReviewVerdictOpener {
  kind: ReviewVerdictKind;
  prNumber: number;
  headSha: string;
}

/**
 * Verdict-opener format:
 *
 *   <APPROVE|REQUEST CHANGES|NEEDS INFO> — PR #<n> at head <40-hex-sha>
 *
 * The em-dash is `—` (U+2014), not ASCII `-`. Three verdict kinds,
 * deliberately not two: NEEDS INFO is a first-class abstention, and a
 * two-kind regex would force a reviewer to invent an APPROVE or REQUEST
 * CHANGES just to close the issue, which is strictly worse than the defect
 * being fixed. The sha is required and is exactly 40 lowercase hex chars;
 * freshness is checked elsewhere.
 */
const VERDICT_OPENER_REGEX =
  /^\s*(APPROVE|REQUEST CHANGES|NEEDS INFO)\s+—\s+PR\s*#(\d+)\s+at\s+head\s+([0-9a-f]{40})\s*$/;

export function parseReviewVerdictOpener(input: string): ReviewVerdictOpener | null {
  if (typeof input !== "string") return null;
  const match = VERDICT_OPENER_REGEX.exec(input);
  if (!match) return null;
  return {
    kind: match[1] as ReviewVerdictKind,
    prNumber: Number(match[2]),
    headSha: match[3],
  };
}

/**
 * Identify a PR review issue by title. The predicate is the guard's blast
 * radius — every title the guard blocks must match it; every title that does
 * not match must be untouched. The canonical shapes are:
 *
 *   1. `Review PR #<n> (<repo>) — <subject>, head <sha>`
 *   2. same as 1 without the sha
 *   3. `Re-review PR #<n> …`
 *   4. `Re-verify PR #<n> …`
 *
 * Plus two older shapes that must keep matching:
 *
 *   5. `<role>: review PR #<n> (…)` (a role-prefixed canonical)
 *   6. `Review ENG-26 spec (PR #<n>): …` (a spec-review-of-a-PR hybrid,
 *      treated as a PR review because of the `PR #<n>`)
 *
 * **The verb is anchored at the start of the title.** An earlier form matched
 * a review verb (`review`, `verify`, `re-…`) ANYWHERE in the title, which
 * produced live false positives: a landing issue titled "Pin PR #<n>'s … and
 * clear four review nits" matched because `review` appears later in prose, and
 * a relay issue titled "Overlay housekeeping from the PR #<n> review: …"
 * matched because `review` appears immediately after a `PR #<n>`. Both would
 * have been refused by the guard with the flag on, forcing the reviewer to
 * invent an `APPROVE` opener purely to close the issue — which is the defect
 * the guard exists to prevent.
 *
 * The predicate is the conjunction of two cheap checks:
 *
 *   - the title contains `PR #<n>` (digit-terminated), AND
 *   - the title starts with `Review | Re-review | Re-view | Re-verify |
 *     Verify | Reverify` (case-insensitive, word-boundary at the tail),
 *     either at index 0 or immediately after a short role prefix of the
 *     shape "<role>: " (≤ 48 non-colon chars, then a single colon, then a
 *     single whitespace run).
 *
 * Two consequences of the bounded role-prefix strip:
 *
 *   - `Review ENG-26 spec (PR #<n>): the claim` — the `:` is well inside the
 *     bound, so the engine could in principle strip that prefix; the
 *     remainder "the claim" does NOT start with a review verb, so the engine
 *     tries the next alternative (no role prefix) and matches "Review" at
 *     index 0. Accepted, as intended.
 *   - `Overlay housekeeping from the PR #<n> review: <subject>` — the `:` IS
 *     inside the bound, so the strip looks viable; the remainder does not
 *     start with a review verb, the engine falls back to no role prefix, and
 *     "Overlay" still does not match. Rejected, as intended.
 *
 * The `PR #<n>` term is digit-anchored at the right because `PR #163` must not
 * match `PR #1639` once a caller parses a specific number; for the guard, any
 * `PR #<n>` with at least one digit is enough. The verb term ends with `\b` so
 * a stray trailing letter (`views`, `viewed`, `viewer`, …) does not slip
 * through.
 */
const REVIEW_TITLE_PR_REGEX = /\bPR\s*#\d+/;
// Anchored at the start: an optional short "<role>: " prefix (≤ 48 chars,
// no colons inside), then the verb cluster `re-?` zero or more times, then
// `view` or `verify` as a complete word. The trailing `\b` keeps `views`,
// `viewed`, `viewer`, etc. from leaking through; `(?:re-?)*` admits the
// double-prefix `Re-review` (matches as "Re-" + "re-" + "view") and the
// single-prefix `Re-verify` ("Re-" + "verify").
const REVIEW_TITLE_VERB_ANCHORED_REGEX =
  /^(?:[^:]{1,48}:\s+)?(?:re-?)*(?:view|verify)\b/i;

export function isReviewIssueTitle(title: string): boolean {
  if (typeof title !== "string") return false;
  if (!REVIEW_TITLE_PR_REGEX.test(title)) return false;
  return REVIEW_TITLE_VERB_ANCHORED_REGEX.test(title);
}

/**
 * First non-blank line of a comment body. Comments may legitimately start
 * with whitespace, a leading blank line, or a fenced code block; the
 * spec's "and nothing before it" applies to the first *meaningful* line.
 * Returns `""` when the body is empty / whitespace-only.
 */
export function firstNonBlankLine(body: string): string {
  if (typeof body !== "string") return "";
  for (const line of body.split(/\r?\n/)) {
    if (line.trim().length > 0) return line;
  }
  return "";
}

/**
 * Stable identifier string used in error details and activity-log rows.
 * Public so tests and the issue-service can assert on it without depending
 * on internal regex literals.
 */
export const REVIEW_VERDICT_OPENER_GUARD_CODE = "review_verdict_opener_missing" as const;
