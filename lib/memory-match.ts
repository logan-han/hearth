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
  'as', 'not', 'no', 'now', 'way', 'also', 'just', 'very', 'so', 'but', 'if', 'then', 'than', 'too',
])

function stem(word: string): string {
  if (word.length <= 3) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('es')) return word.slice(0, -2)
  if (word.endsWith('s')) return word.slice(0, -1)
  return word
}

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !FILLER.has(w))
      .map(stem),
  )
}

/** Jaccard overlap of the two token sets, 0 to 1. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / (ta.size + tb.size - shared)
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
