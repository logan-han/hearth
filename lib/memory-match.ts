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
  const numbers = (t: Set<string>) => [...new Set([...t].flatMap((w) => w.match(/\p{N}+/gu) ?? []))].sort().join(' ')
  return negated(ta) !== negated(tb) || numbers(ta) !== numbers(tb)
}

/**
 * Jaccard overlap of the two token sets, 0 to 1, held just short of a
 * duplicate when one fact contradicts the other: still related, so the
 * caller can offer the old one to forget, but never turned away as known.
 */
export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  const pa = [...ta].filter(countsToOverlap)
  const pb = new Set([...tb].filter(countsToOverlap))
  if (pa.length === 0 || pb.size === 0) return 0
  let shared = 0
  for (const t of pa) if (pb.has(t)) shared++
  const overlap = shared / (pa.length + pb.size - shared)
  return contradicts(ta, tb) ? Math.min(overlap, DUPLICATE - 0.01) : overlap
}

/**
 * A negator or a lone digit matters only when the two facts disagree on it,
 * which contradicts() sees. Shared, it is too common to make two facts one:
 * "Ada is in year 3" and "Juno is in year 3" are about different children.
 */
function countsToOverlap(word: string): boolean {
  return !NEGATORS.includes(word) && !/^\p{N}$/u.test(word)
}

/** At or above this, the new fact is the old fact reworded. */
export const DUPLICATE = 0.7
/** At or above this, the two facts are probably about the same thing. */
export const RELATED = 0.35

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
