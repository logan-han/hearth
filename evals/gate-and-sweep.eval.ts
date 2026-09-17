import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { liveChainConfigured } from './harness'
import { record, printSummary } from './scorers'

const { freshDb, closeDb } = await import('@/tests/helpers/db')
const q = await import('@/lib/db/queries')
const { shouldChimeIn, runAgent } = await import('@/lib/agent')

let client: PGlite
beforeEach(async () => {
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))
afterAll(() => printSummary('gate and sweep'))

describe.skipIf(!liveChainConfigured())('ambient gate', () => {
  it('stays out of banter', async () => {
    await q.recordMessage({ chatId: '-100', authorName: 'Sam', role: 'user', content: 'that movie was so bad' })
    const r = await shouldChimeIn({ chatId: '-100', text: 'lol same', memberName: 'Rowan' })
    record({ case: 'gate: banter stays silent', hard: r === false ? 'pass' : 'fail' })
    expect(r).toBe(false)
  })

  it('answers a request aimed at it', async () => {
    const r = await shouldChimeIn({ chatId: '-100', text: 'can someone put swimming on the family calendar for Saturday 9am?', memberName: 'Rowan' })
    record({ case: 'gate: calendar request replies', hard: r === true ? 'pass' : 'fail' })
    expect(r).toBe(true)
  })
})

describe.skipIf(!liveChainConfigured())('nightly memory sweep', () => {
  it('replaces a corrected fact and files a new one, without re-filing the known', async () => {
    const old = await q.addMemory('Bin night is Tuesday')
    await q.addMemory('Juno goes to Riverbend College')
    const transcript = [
      '[-100] Rowan: bins go out Monday now, council changed the day',
      '[-100] Sam: ok. also Juno is at Riverbend College, remember that for the school forms',
      '[-100] Rowan: dentist for Ada is Thursday 2pm',
      "[-100] Sam: Ada's allergic to peanuts, the new carer needs to know",
    ].join('\n')
    const r = await runAgent({
      chatId: 'memory-sweep', chatType: 'private', member: null, memberName: 'the household', mode: 'sweep', history: false,
      text: "Nightly memory pass. Yesterday's household talk follows; the Known household facts are in your context.\n\n" + transcript,
    })
    const current = await q.listMemories()
    const facts = current.map((m) => m.content)
    const monday = facts.some((f) => /monday/i.test(f) && /bin/i.test(f))
    const tuesdayGone = !current.some((m) => m.id === old.id)
    const peanuts = facts.some((f) => /peanut/i.test(f))
    const schoolOnce = facts.filter((f) => /riverbend/i.test(f)).length === 1
    const noAppointment = !facts.some((f) => /dentist/i.test(f))
    const hard = monday && tuesdayGone && peanuts && schoolOnce
    record({ case: 'sweep: correction, new fact, no dupes', hard: hard ? 'pass' : 'fail', model: r.model, note: `${facts.length} facts; dentist filed=${!noAppointment}` })
    expect(monday).toBe(true)
    expect(tuesdayGone).toBe(true)
    expect(peanuts).toBe(true)
    expect(schoolOnce).toBe(true)
  })

  it("asks rather than guesses when a school turns up in a parent's mail, and files nothing from a one-off booking", async () => {
    const transcript = [
      "[-100] you: Morning brief. Rowan's mail: Hillside Grammar tuition for Term 4 is due Monday 5 October. Sam's mail: a booking confirms the Junior School Father's Day Breakfast in the Riverbend College Dining Room, Gate 5 off Elm Road, Friday 7:30am. Drama school absences: call the venue manager on 0400 000 000.",
      '[-100] Rowan: thanks, will pay it this week',
    ].join('\n')
    const r = await runAgent({
      chatId: 'memory-sweep', chatType: 'private', member: null, memberName: 'the household', mode: 'sweep', history: false,
      text: "Nightly memory pass. Yesterday's household talk follows; the Known household facts are in your context.\n\n" + transcript,
    })
    const facts = (await q.listMemories()).map((m) => m.content)
    const open = await q.openQuestions()
    const nothingFiled = facts.length === 0
    const askedAboutSchool = open.some((o) => /hillside/i.test(o.question) || /hillside/i.test(o.candidate))
    const trivia = /gate 5|elm road|0400|breakfast|venue manager/i
    const noTrivia = !facts.some((f) => trivia.test(f)) && !open.some((o) => trivia.test(o.candidate))
    record({
      case: 'sweep: mail-borne school becomes a question, event trivia dropped',
      hard: nothingFiled && askedAboutSchool && noTrivia ? 'pass' : 'fail',
      model: r.model,
      note: `${facts.length} facts, ${open.length} questions`,
    })
    expect(nothingFiled).toBe(true)
    expect(askedAboutSchool).toBe(true)
    expect(noTrivia).toBe(true)
  })
})
