import { TypeSafeClient, choice, noul, APIError, type EntryType, type Questions, type SystemOneResult } from '@typesafe-ai/sdk'
import type { PropagateAttributesParams } from '@langfuse/tracing'
import { recordModelEvent } from './model-events'
import { traced, observed } from './telemetry'
import { describeError } from './errors'

/**
 * TypeSafe's Jev, for the questions Hearth asks with a yes or a name for an
 * answer. Jev is a System One model: it does not write, it judges. Given a
 * state and typed questions it returns a calibrated probability for each, in
 * about a tenth of a second and for a fraction of a cent. These decisions used
 * to be structured outputs from the chat chain, and a free-tier model asked
 * for a JSON object answers with prose often enough that every decision
 * carried a wasted call and a fall-through; Jev answers the question as asked,
 * and says how sure it is.
 *
 * What it decides, when a key is set: whether an unaddressed group message is
 * for the assistant (the gate), whether a chat reply reports a change no tool
 * made (the reply check), whether each statement in a watcher draft is in its
 * evidence, and whether the draft as a whole is (the post decision). Without a
 * key each falls back to the chain as before, and a Jev call that fails hands
 * the same question to the chain or falls the safe way, decision by decision.
 *
 * Every question and every threshold lives in this file, so what the bot asks
 * and where it draws each line can be read in one place.
 */

/**
 * Where each probability turns into an action. Jev reads a question literally
 * and its probabilities are meant to be taken at face value, so each line is
 * set by what a mistake costs on either side: a bot that butts into family
 * talk is worse than one that misses a question, and a purpose invented for a
 * payment is worse than a figure cut from a post.
 */
export const THRESHOLDS = {
  /**
   * p(the newest group message is for the assistant) at or above this replies.
   * First live probe, with no conversation given: banter and a request to
   * another person sit at 0.02 to 0.06; "can someone put swimming on the
   * calendar" at 0.41, "someone" being the people in the chat; a plain
   * question the bot can answer ("is it going to rain tomorrow", "how much
   * did we spend on groceries this month") at 0.65 to 0.75; a bare imperative
   * at 0.78, a reminder at 0.89, the bot's name at 0.97. The line sits under
   * the questions and well above the ambiguity.
   */
  gateReply: 0.6,
  /** p(the reply reports a change as made) at or above this sends the reply back for the tool call. */
  claimsChange: 0.7,
  /** p(the evidence supports the statement) below this cuts the statement from the post. */
  claimSupported: 0.6,
  /** p(the draft says something the evidence does not) at or above this decides skip. */
  postInvented: 0.5,
  /** p(the draft only says there is nothing new) at or above this decides skip. */
  postNothingNew: 0.7,
} as const

/** Per attempt; the SDK retries twice on 408, 429 and 5xx. Every caller has somewhere else to turn, so nothing waits long. */
const TIMEOUT_MS = 15_000
const DEFAULT_MODEL = 'jev-latest'

export function jevConfigured(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY)
}

/** jev-latest unless pinned: the alias advances without notice, and a pinned version keeps the evals comparable. */
export function jevModel(): string {
  return process.env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL
}

/** The name Jev's calls are recorded under, beside the chat models in the chain health. */
export function jevSlot(): string {
  return `jev:${jevModel()}`
}

let cached: { key: string; model: string; client: TypeSafeClient } | null = null

/** One client per key and model; a key changed in the dashboard gets a fresh one. */
function client(): TypeSafeClient {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new Error('TypeSafe is not configured: set TYPESAFE_API_KEY')
  const model = jevModel()
  if (!cached || cached.key !== key || cached.model !== model) {
    cached = { key, model, client: new TypeSafeClient({ apiKey: key, defaultModel: model, timeout: TIMEOUT_MS }) }
  }
  return cached.client
}

/** Test seam: forget the client, so the next call reads the key again. */
export function resetJevClient(): void {
  cached = null
}

/** The status first, so the chain health can tell a rate limit from a refused key. */
function describeJevError(err: unknown): string {
  if (err instanceof APIError) {
    return err.message.includes(String(err.status)) ? err.message : `HTTP ${err.status}: ${err.message}`
  }
  return describeError(err)
}

/**
 * One call to Jev, recorded like any model call: a row in the chain health
 * under Jev's own slot, and a generation in the trace when tracing is on. The
 * error is rethrown with its description, so the caller's log line and the
 * chain health say the same thing.
 */
export async function askJev<const Q extends Questions>(input: {
  purpose: string
  state: EntryType
  questions: Q
  trace: PropagateAttributesParams
}): Promise<SystemOneResult<Q>> {
  const slot = jevSlot()
  const started = Date.now()
  try {
    const result = await traced({ ...input.trace, metadata: { ...input.trace.metadata, model: slot } }, () =>
      observed(
        input.purpose,
        { model: jevModel(), input: { state: input.state, questions: input.questions } },
        () => client().systemOne({ state: input.state, questions: input.questions }),
        (r) => ({ output: r.answers, usage: { input: r.usage.input_tokens, output: r.usage.output_tokens } }),
      ),
    )
    await recordModelEvent({ slot, purpose: input.purpose, outcome: 'answered', ms: Date.now() - started })
    return result
  } catch (err) {
    const message = describeJevError(err)
    console.error(`[jev] ${input.purpose} failed:`, message)
    await recordModelEvent({ slot, purpose: input.purpose, outcome: 'failed', ms: Date.now() - started, error: message })
    throw new Error(message, { cause: err })
  }
}

const round = (n: number) => Math.round(n * 100) / 100

/* ------------------------------------------------------------ ambient gate */

/** The tail of the conversation, oldest first, then the message in question; each a "Name: text" line. */
export type GateState = { conversation: string[]; message: string }

/**
 * One absolute judgement, where the chain was asked from both sides: a forced
 * choice from a chat model leans towards whatever it was asked about, and
 * only a message that survived both framings got an answer. A noul carries
 * its own uncertainty, so the line is drawn on the probability instead.
 */
const GATE_QUESTION = noul(
  {
    question:
      'Is `message`, the newest message in a family group chat, meant for the household assistant bot rather than for the people in the chat?',
    about_the_bot:
      'The bot answers questions (a fact, the weather, what is on the calendar, what was spent, a lookup), takes requests (a reminder, a calendar entry, a list item, an email, a search) and is sometimes spoken to by name. `conversation` holds the messages just before, oldest first; the lines the bot wrote are marked "Hearth:".',
  },
  {
    true: 'The message asks something the bot could answer, asks the bot to do something, or speaks to the bot directly.',
    false:
      'The message is between the people in the chat: banter, a reaction, a greeting, news, plans, a question or request aimed at another person, or something the conversation has already answered.',
  },
)

export async function wantsAssistant(input: GateState & { chatId: string }): Promise<boolean> {
  const { answers } = await askJev({
    purpose: 'hearth.gate',
    state: { conversation: input.conversation, message: input.message },
    questions: { forAssistant: GATE_QUESTION },
    trace: { traceName: 'hearth.gate', sessionId: input.chatId, tags: ['gate'] },
  })
  const p = answers.forAssistant.noul
  const reply = p >= THRESHOLDS.gateReply
  console.info(`[gate] ${jevSlot()} p(for assistant)=${p.toFixed(2)} -> ${reply ? 'reply' : 'stay_silent'} chat=${input.chatId}`)
  return reply
}

/* -------------------------------------------------------------- reply check */

const REPLY_CHARS = 2_000

const CLAIM_QUESTION = noul(
  'Does `reply`, from a household assistant, report that the assistant has already made a change: added, changed, moved, cancelled, removed, sent, saved, scheduled, remembered or otherwise done something to a calendar, a list, an email, a reminder, its memory or a task board? The wording and the language do not matter.',
  {
    true: 'The reply states a change as done: "added", "replaced it", "sent", "I have moved it", "done", or the same in other words or another language.',
    false:
      'The reply answers a question, offers or asks to do something, asks for a yes first, or describes what already exists or what a lookup found, without saying that a change was made.',
  },
)

/** Whether a chat reply says a change was made; the caller knows whether one was. */
export async function claimsChange(input: { reply: string; chatId: string }): Promise<boolean> {
  const { answers } = await askJev({
    purpose: 'hearth.claim',
    state: { reply: input.reply.slice(0, REPLY_CHARS) },
    questions: { claimsChange: CLAIM_QUESTION },
    trace: { traceName: 'hearth.claim', sessionId: input.chatId, tags: ['claim'] },
  })
  return answers.claimsChange.noul >= THRESHOLDS.claimsChange
}

/* ------------------------------------------------------------- claim checks */

/** What counts as the evidence establishing a statement, shared by every check and by the post decision. */
const FORM_RULE =
  'Differences of form do not matter: case, punctuation, currency symbols, and a name that is part of a longer string in the evidence (<PAYEE> within <PAYEE CITY> in a bank feed) are the same thing.'
const SUBSTANCE_RULE =
  'Differences of substance do: a purpose, place, trip, plan or cause is established only if the evidence names it. A payee string is a trading name and a registered city, not a place anyone went.'
const WHOLE_RULE = 'A statement with any part the evidence does not establish is not supported. Use nothing but the evidence.'

/**
 * One choice per statement, all against the same evidence in one call: the
 * evidence is sent once and the statements are judged in parallel. The
 * checker never sees the draft, only the evidence and one statement, so it
 * cannot be talked into agreeing with the post.
 */
const checkQuestion = (statement: string) =>
  choice(
    { statement, question: 'Does `evidence` establish `statement`?', rules: [FORM_RULE, SUBSTANCE_RULE, WHOLE_RULE] },
    {
      supported:
        'The evidence states it, or it follows directly: a figure that appears, a date that appears, an instruction that says to post exactly this, a sum of listed figures.',
      contradicted: 'The evidence says something incompatible with it.',
      not_in_evidence: 'The evidence does not say it, in whole or in part.',
    },
  )

export type ClaimCheck = { claim: string; supported: boolean; p: number }

export async function checkClaims(input: { label: string; claims: string[]; evidence: string }): Promise<ClaimCheck[]> {
  if (input.claims.length === 0) return []
  const questions = Object.fromEntries(input.claims.map((claim, i) => [`c${i}`, checkQuestion(claim)]))
  const { answers } = await askJev({
    purpose: 'hearth.verify',
    state: { evidence: input.evidence },
    questions,
    trace: { traceName: 'hearth.verify', tags: ['verify', 'check'], metadata: { label: input.label } },
  })
  return input.claims.map((claim, i) => {
    const p = answers[`c${i}`].probabilities.supported
    return { claim, supported: p >= THRESHOLDS.claimSupported, p: round(p) }
  })
}

/* ------------------------------------------------------------ post decision */

const INVENTED_QUESTION = noul(
  {
    question: 'Does `draft`, a post written from `evidence`, state anything about the world that the evidence does not contain?',
    rules: [
      'A name, amount, date, time, place, purpose, description or flag in the draft that no part of the evidence gives counts, and so does a guess made as a hedge or a question.',
      'Saying that something is not known ("purpose not recorded") is not a claim, and wording the instruction in the evidence asked for is grounded in the instruction. Which items the draft chose to mention is not the question.',
      FORM_RULE,
      SUBSTANCE_RULE,
    ],
  },
  {
    true: 'Something the draft says is not in the evidence.',
    false: 'Everything the draft says is in the evidence or follows from it directly.',
  },
)

const NOTHING_NEW_QUESTION = noul('Does `draft` only say that there is nothing new, nothing to report or nothing worth posting?')

export type JevPostDecision = { decision: 'post' | 'skip'; confidence: number; reason?: string; model: string }

/** Why a draft is held back, in the same words whichever judge answered. */
export const POST_REASONS = {
  nothingNew: 'the draft only says there is nothing new',
  invented: 'the draft states something the evidence does not contain',
  unsure: 'the judge was not sure enough of its answers',
} as const

/**
 * Two absolute judgements combined in code, the same two the chain is asked
 * in its place: is anything in the draft not in the evidence, and does the
 * draft say only that there is nothing new. Post or skip is all it decides,
 * on grounding alone; what to include was the writer's call. The lines are
 * drawn here and nowhere else: the tick posts what comes back as decided, and
 * the confidence is the probability behind the decision, for the log and the
 * admin's note. The first live run put a grounded, paraphrased brief at
 * p(invented) 0.37 and the same brief with one invented figure at 0.93, which
 * is what the 0.5 line separates.
 */
export async function decidePost(input: { label: string; draft: string; evidence: string }): Promise<JevPostDecision> {
  const { answers } = await askJev({
    purpose: 'hearth.decision',
    state: { draft: input.draft, evidence: input.evidence },
    questions: { invented: INVENTED_QUESTION, nothingNew: NOTHING_NEW_QUESTION },
    trace: { traceName: 'hearth.decision', tags: ['decision'], metadata: { label: input.label } },
  })
  const invented = answers.invented.noul
  const nothingNew = answers.nothingNew.noul
  const model = jevSlot()
  if (nothingNew >= THRESHOLDS.postNothingNew) {
    return { decision: 'skip', confidence: round(nothingNew), reason: POST_REASONS.nothingNew, model }
  }
  if (invented >= THRESHOLDS.postInvented) {
    return { decision: 'skip', confidence: round(invented), reason: POST_REASONS.invented, model }
  }
  return { decision: 'post', confidence: round(1 - invented), model }
}
