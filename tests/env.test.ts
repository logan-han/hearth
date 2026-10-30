import { describe, it, expect, beforeEach, vi } from 'vitest'
import { required, optional, appUrl, idSet, reasoningLevel, timezone, isTimeZone, canonicalTimeZone, isAssistantName, assistantName, assistantPersona, opensWithName } from '@/lib/env'

const KEYS = ['APP_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL', 'SOME_KEY', 'LLM_REASONING']

beforeEach(() => {
  for (const k of KEYS) delete process.env[k]
})

describe('required', () => {
  it('returns the value when set', () => {
    process.env.SOME_KEY = 'v'
    expect(required('SOME_KEY')).toBe('v')
  })

  it('names the missing variable, so the failure is actionable', () => {
    expect(() => required('SOME_KEY')).toThrow(/Missing required env var: SOME_KEY/)
  })

  it('treats an empty string as missing', () => {
    process.env.SOME_KEY = ''
    expect(() => required('SOME_KEY')).toThrow()
  })
})

describe('optional', () => {
  it('falls back when unset', () => {
    expect(optional('SOME_KEY', 'fallback')).toBe('fallback')
    expect(optional('SOME_KEY')).toBe('')
  })

  it('prefers the set value', () => {
    process.env.SOME_KEY = 'v'
    expect(optional('SOME_KEY', 'fallback')).toBe('v')
  })
})

describe('appUrl', () => {
  it('prefers APP_URL and strips a trailing slash', () => {
    process.env.APP_URL = 'https://hearth.example/'
    expect(appUrl()).toBe('https://hearth.example')
  })

  it('falls back to the Vercel production domain', () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'hearth.vercel.app'
    expect(appUrl()).toBe('https://hearth.vercel.app')
  })

  it('then to the per-deployment domain', () => {
    process.env.VERCEL_URL = 'hearth-abc.vercel.app'
    expect(appUrl()).toBe('https://hearth-abc.vercel.app')
  })

  it('and finally to localhost for development', () => {
    expect(appUrl()).toBe('http://localhost:3000')
  })
})

describe('timezone', () => {
  it('is the household\'s zone, trimmed, and Melbourne when unset', () => {
    process.env.TIMEZONE = ' Europe/London '
    expect(timezone()).toBe('Europe/London')
    delete process.env.TIMEZONE
    expect(timezone()).toBe('Australia/Melbourne')
  })

  it('falls back to the default for a zone no clock knows, saying so once rather than throwing everywhere', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.TIMEZONE = 'Melbourne'
    expect(timezone()).toBe('Australia/Melbourne')
    expect(timezone()).toBe('Australia/Melbourne')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Melbourne" is not a time zone'))
    delete process.env.TIMEZONE
  })

  it('knows a zone from a name that is not one', () => {
    expect(isTimeZone('Australia/Perth')).toBe(true)
    expect(isTimeZone('australia/perth')).toBe(true)
    expect(isTimeZone('Perth')).toBe(false)
    expect(isTimeZone('')).toBe(false)
  })

  it('gives a zone its own name, and refuses an offset, which knows nothing of daylight saving', () => {
    expect(canonicalTimeZone(' australia/perth ')).toBe('Australia/Perth')
    expect(canonicalTimeZone('utc')).toBe('UTC')
    expect(canonicalTimeZone('+10:00')).toBeNull()
    expect(canonicalTimeZone('-05:00')).toBeNull()
    // And the household's zone is read under that name, whatever the case it was stored in.
    process.env.TIMEZONE = 'australia/perth'
    expect(timezone()).toBe('Australia/Perth')
    delete process.env.TIMEZONE
  })
})

describe('idSet', () => {
  it('is a set, so duplicates collapse', () => {
    process.env.SOME_KEY = '1,1,2'
    expect(idSet('SOME_KEY').size).toBe(2)
  })
})

describe('reasoningLevel', () => {
  it('returns the level when it is one of the known ones', () => {
    process.env.LLM_REASONING = 'high'
    expect(reasoningLevel()).toBe('high')
  })

  it('is undefined when unset or not a recognised level', () => {
    expect(reasoningLevel()).toBeUndefined()
    process.env.LLM_REASONING = 'extreme'
    expect(reasoningLevel()).toBeUndefined()
  })
})

describe('the assistant\'s name and manner', () => {
  beforeEach(() => {
    delete process.env.ASSISTANT_NAME
    delete process.env.ASSISTANT_PERSONA
  })

  it('is Hearth until the household names it, and only by a name it can answer to', () => {
    expect(assistantName()).toBe('Hearth')
    process.env.ASSISTANT_NAME = ' Pip '
    expect(assistantName()).toBe('Pip')
    process.env.ASSISTANT_NAME = 'R2-D2!'
    expect(assistantName()).toBe('Hearth')
  })

  it('takes one or two words of letters, in any script', () => {
    for (const ok of ['Pip', 'Aunty Bot', "O'Brien", 'Zoë', 'ハル']) expect(isAssistantName(ok), ok).toBe(true)
    for (const bad of ['', 'a b c', 'Pip!', '42', 'x'.repeat(25), '-Pip']) expect(isAssistantName(bad), bad).toBe(false)
  })

  it('keeps the manner to a line or two', () => {
    expect(assistantPersona()).toBe('')
    process.env.ASSISTANT_PERSONA = `  warm ${'x'.repeat(400)}`
    expect(assistantPersona()).toHaveLength(300)
  })

  it('hears its name called at the start, not talked about', () => {
    for (const called of ['Pip, what is on today?', 'pip: bins?', 'Pip?', 'Pip', 'hey Pip what is on', 'Hi, Pip.', 'ok @Pip add milk', '  PIP, hi']) {
      expect(opensWithName(called, 'Pip'), called).toBe(true)
    }
    for (const about of ['Pip is great', 'I told Pip about it', 'Pippa, come here', 'pipe the water', 'hey Pippa']) {
      expect(opensWithName(about, 'Pip'), about).toBe(false)
    }
    expect(opensWithName('Aunty Bot, hello', 'Aunty Bot')).toBe(true)
    expect(opensWithName('Aunty, hello', 'Aunty Bot')).toBe(false)
    expect(opensWithName('anything', ' ')).toBe(false)
    // A name with a character a pattern would read as its own is found as written.
    expect(opensWithName('Dr.Who, hi', 'Dr.Who')).toBe(true)
    expect(opensWithName('DrxWho, hi', 'Dr.Who')).toBe(false)
  })
})
