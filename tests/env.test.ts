import { describe, it, expect, beforeEach, vi } from 'vitest'
import { required, optional, appUrl, idSet } from '@/lib/env'

const KEYS = ['APP_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL', 'SOME_KEY']

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
    process.env.APP_URL = 'https://hearth.han.life/'
    expect(appUrl()).toBe('https://hearth.han.life')
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

describe('idSet', () => {
  it('is a set, so duplicates collapse', () => {
    process.env.SOME_KEY = '1,1,2'
    expect(idSet('SOME_KEY').size).toBe(2)
  })
})
