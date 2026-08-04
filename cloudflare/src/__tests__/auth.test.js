import { describe, expect, it } from 'vitest'
import {
  OTP_REQUEST_MAX_PER_HOUR,
  decideOtpRequestThrottle,
} from '../auth.js'

const NOW = 1_700_000_000_000
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

describe('decideOtpRequestThrottle', () => {
  it('allows the very first request for an email', () => {
    const result = decideOtpRequestThrottle({ nowMs: NOW })
    expect(result.allowed).toBe(true)
    expect(result.nextRequestCount).toBe(1)
    expect(result.nextWindowStartedAtMs).toBe(NOW)
  })

  it('blocks a second request inside the cooldown window', () => {
    const result = decideOtpRequestThrottle({
      lastCreatedAtMs: NOW - 10 * SECOND,
      requestCount: 1,
      windowStartedAtMs: NOW - 10 * SECOND,
      nowMs: NOW,
    })
    expect(result.allowed).toBe(false)
    expect(result.error).toMatch(/wait/i)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('allows a request exactly at the cooldown boundary', () => {
    const result = decideOtpRequestThrottle({
      lastCreatedAtMs: NOW - 30 * SECOND,
      requestCount: 1,
      windowStartedAtMs: NOW - 30 * SECOND,
      nowMs: NOW,
    })
    expect(result.allowed).toBe(true)
  })

  it('blocks once the hourly cap is reached, even past cooldown', () => {
    const result = decideOtpRequestThrottle({
      lastCreatedAtMs: NOW - 40 * SECOND,
      requestCount: OTP_REQUEST_MAX_PER_HOUR,
      windowStartedAtMs: NOW - 10 * MINUTE,
      nowMs: NOW,
    })
    expect(result.allowed).toBe(false)
    expect(result.error).toMatch(/too many/i)
  })

  it('resets the count once the hour window has expired', () => {
    const result = decideOtpRequestThrottle({
      lastCreatedAtMs: NOW - 40 * SECOND,
      requestCount: OTP_REQUEST_MAX_PER_HOUR,
      windowStartedAtMs: NOW - (HOUR + MINUTE),
      nowMs: NOW,
    })
    expect(result.allowed).toBe(true)
    expect(result.nextRequestCount).toBe(1)
    expect(result.nextWindowStartedAtMs).toBe(NOW)
  })

  it('keeps counting within an active window', () => {
    const result = decideOtpRequestThrottle({
      lastCreatedAtMs: NOW - 40 * SECOND,
      requestCount: 2,
      windowStartedAtMs: NOW - 10 * MINUTE,
      nowMs: NOW,
    })
    expect(result.allowed).toBe(true)
    expect(result.nextRequestCount).toBe(3)
    expect(result.nextWindowStartedAtMs).toBe(NOW - 10 * MINUTE)
  })
})
