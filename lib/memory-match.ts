/**
 * Cheap likeness between two facts, for catching a re-filed memory before it
 * lands. Word overlap after dropping filler and crude plural endings: no model
 * call, no embeddings, good enough to tell "bin night is Monday" from "Bin
 * night is Monday by the way" (a duplicate) and from "bin night is Tuesday"
 * (a correction, which the caller decides about).
 */
const FILLER = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for',
  'with', 'by', 'it', 'its', 'this', 'that', 'our', 'we', 'us', 'they', 'their', 'has', 'have', 'had', 'from',
  'as', 'now', 'way', 'also', 'just', 'very', 'so', 'but', 'if', 'then', 'than', 'too',
])

const NEGATORS = ['not', 'no', 'never']

function stem(word: string): string {
  if (word.length <= 3) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  // Unless that leaves a negator: "notes" are notes, not a "not".
  if (word.endsWith('es') && !NEGATORS.includes(word.slice(0, -2))) return word.slice(0, -2)
  if (word.endsWith('s')) return word.slice(0, -1)
  return word
}

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      // Spelt out, the "not" of a contraction is kept rather than lost as a
      // stray "t", with or without its apostrophe. "Cant" and "wont" are words
      // too, but in a family chat they are nearly always a missed apostrophe.
      .replace(/\bcan['’]?t\b|\bcannot\b/g, 'can not')
      .replace(/\bwon['’]?t\b/g, 'will not')
      .replace(/n['’]t\b/g, ' not')
      .replace(/\b(is|are|was|were|do|does|did|has|have|had|could|should|would)nt\b/g, '$1 not')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      // A lone digit stays: "size 7" and "size 8" are different facts.
      .filter((w) => (w.length > 1 || /\p{N}/u.test(w)) && !FILLER.has(w))
      .map(stem),
  )
}

/**
 * Whether two facts part ways on a "not" or a number. A correction often
 * changes nothing else ("Ada can't have dairy", "Ada wears size 8"), so word
 * overlap alone would take it for the fact it corrects.
 */
function contradicts(ta: Set<string>, tb: Set<string>): boolean {
  const negated = (t: Set<string>) => NEGATORS.some((w) => t.has(w))
  return negated(ta) !== negated(tb) || numbers(ta).join(' ') !== numbers(tb).join(' ')
}

/** The numbers in a fact, each once and sorted: "7:30" is 7 and 30, "4pm" is 4. */
function numbers(t: Set<string>): string[] {
  return [...new Set([...t].flatMap((w) => w.match(/\p{N}+/gu) ?? []))].sort()
}

/**
 * Jaccard overlap of the two token sets, 0 to 1, held just short of a
 * duplicate when one fact contradicts the other: still related, so the
 * caller can offer the old one to forget, but never turned away as known.
 */
export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  const score = overlap(ta, tb)
  return contradicts(ta, tb) ? Math.min(score, DUPLICATE - 0.01) : score
}

function overlap(ta: Set<string>, tb: Set<string>, counts: (word: string) => boolean = countsToOverlap): number {
  const pa = [...ta].filter(counts)
  const pb = new Set([...tb].filter(counts))
  if (pa.length === 0 || pb.size === 0) return 0
  let shared = 0
  for (const t of pa) if (pb.has(t)) shared++
  return shared / (pa.length + pb.size - shared)
}

/**
 * A negator or a lone digit matters only when the two facts disagree on it,
 * which contradicts() sees. Shared, it is too common to make two facts one:
 * "Ada is in year 3" and "Juno is in year 3" are about different children.
 */
function countsToOverlap(word: string): boolean {
  return !NEGATORS.includes(word) && !/^\p{N}$/u.test(word)
}

/**
 * Stricter, for findCorrected(): no word with a digit in it counts, as
 * contradicts() has already compared the numbers, so "size 10" and "size 11"
 * part ways on nothing else. similarity() still counts a "4pm", since "4pm"
 * and "4am" hold the same number and say different things.
 */
function isWording(word: string): boolean {
  return !NEGATORS.includes(word) && !/\p{N}/u.test(word)
}

/** At or above this, the new fact is the old fact reworded. */
export const DUPLICATE = 0.7
/** At or above this, the two facts are probably about the same thing. */
export const RELATED = 0.35

/**
 * The row that `fact` corrects, if any: one that would be a duplicate but for
 * a "not" or a number, the closest if several would. similarity() holds such a
 * pair short of a duplicate so the correction is not turned away; this finds
 * the old fact so the caller can retire it rather than keep both as Known.
 *
 * Only a row the fact says again in full is retired: every word of it still
 * there, and as many numbers, changed or not. A fact that corrects one part of
 * a row ("Ada is not allergic to eggs" against "Ada is allergic to peanuts and
 * eggs") or leaves a number out ("piano on Tuesday" against "piano on Tuesday
 * at 4") would take the rest of the row with it, so both stand instead.
 */
export function findCorrected<T extends { content: string }>(fact: string, rows: readonly T[]): T | undefined {
  const tf = tokens(fact)
  return rows
    .map((row) => {
      const tr = tokens(row.content)
      const restated = [...tr].filter(isWording).every((w) => tf.has(w)) && numbers(tf).length >= numbers(tr).length
      return { row, score: restated && contradicts(tf, tr) ? overlap(tf, tr, isWording) : 0 }
    })
    .filter((x) => x.score >= DUPLICATE)
    .sort((a, b) => b.score - a.score)[0]?.row
}

export function rankSimilar<T extends { content: string }>(
  candidate: string,
  rows: readonly T[],
  limit = 3,
): { row: T; score: number }[] {
  return rows
    .map((row) => ({ row, score: similarity(candidate, row.content) }))
    .filter((x) => x.score >= RELATED)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
