import { describe, expect, it } from 'vitest'
import {
  buildAccessOfflineValue,
  decideOfflineCodeRequest,
  decideOfflineVerify,
  isPullThePlugEmail,
  parseAccessOfflineValue,
} from '../accessOffline.js'

describe('isPullThePlugEmail', () => {
  it('matches the panic email case-insensitively with surrounding whitespace', () => {
    expect(isPullThePlugEmail('pulltheplug@quadreal.com')).toBe(true)
    expect(isPullThePlugEmail('  PullThePlug@QuadReal.com  ')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isPullThePlugEmail('robert.piwin@quadreal.com')).toBe(false)
    expect(isPullThePlugEmail('')).toBe(false)
    expect(isPullThePlugEmail(undefined)).toBe(false)
  })
})

describe('parseAccessOfflineValue', () => {
  it('parses a JSON string with offline: true', () => {
    expect(parseAccessOfflineValue('{"offline":true,"setAt":"x"}')).toBe(true)
  })

  it('returns false for offline: false, malformed JSON, or non-objects', () => {
    expect(parseAccessOfflineValue('{"offline":false}')).toBe(false)
    expect(parseAccessOfflineValue('not json')).toBe(false)
    expect(parseAccessOfflineValue(null)).toBe(false)
    expect(parseAccessOfflineValue(42)).toBe(false)
  })

  it('accepts an already-parsed object', () => {
    expect(parseAccessOfflineValue({ offline: true })).toBe(true)
  })
})

describe('buildAccessOfflineValue', () => {
  it('normalizes setBy and stamps offline flag', () => {
    const value = buildAccessOfflineValue(true, { setBy: '  Robert.Piwin@QuadReal.com ' })
    expect(value.offline).toBe(true)
    expect(value.setBy).toBe('robert.piwin@quadreal.com')
    expect(typeof value.setAt).toBe('string')
  })

  it('omits setBy when not provided', () => {
    const value = buildAccessOfflineValue(false)
    expect(value.offline).toBe(false)
    expect(value.setBy).toBeUndefined()
  })
})

describe('decideOfflineCodeRequest', () => {
  it('pulls the plug regardless of current offline state', () => {
    expect(
      decideOfflineCodeRequest({ email: 'pulltheplug@quadreal.com', offline: false, isAdmin: false }),
    ).toEqual({ action: 'pull_plug' })
  })

  it('continues when online', () => {
    expect(
      decideOfflineCodeRequest({ email: 'member@quadreal.com', offline: false, isAdmin: false }),
    ).toEqual({ action: 'continue' })
  })

  it('blocks non-admins while offline', () => {
    const result = decideOfflineCodeRequest({ email: 'member@quadreal.com', offline: true, isAdmin: false })
    expect(result.action).toBe('block_non_admin')
  })

  it('lets admins continue while offline', () => {
    expect(
      decideOfflineCodeRequest({ email: 'admin@quadreal.com', offline: true, isAdmin: true }),
    ).toEqual({ action: 'continue' })
  })
})

describe('decideOfflineVerify', () => {
  it('continues when online', () => {
    expect(decideOfflineVerify({ offline: false, isAdmin: false })).toEqual({ action: 'continue' })
  })

  it('refuses non-admins while offline', () => {
    const result = decideOfflineVerify({ offline: true, isAdmin: false })
    expect(result.action).toBe('refuse')
  })

  it('clears offline for an admin verifying while offline', () => {
    expect(decideOfflineVerify({ offline: true, isAdmin: true })).toEqual({ action: 'clear_offline' })
  })
})
