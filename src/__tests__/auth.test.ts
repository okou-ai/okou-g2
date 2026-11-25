import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceAuth } from '../auth'
const memory = () => {
  const map = new Map<string, string>()
  return { setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key), getItem: (key: string) => map.get(key) ?? null }
}
const code = { user_code: 'FIXTURE', device_code: 'fixture-only', verification_uri: 'https://example.test/activate',
  expires_in: 90, interval: 2 }
const session = () => ({ accessToken: 'test-access', userId: 'user_test', orgId: 'org_test', expiresAt: Date.now() + 60_000 })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', memory()); vi.stubGlobal('sessionStorage', memory())
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('honours the device interval, slow_down and a workspace grant', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(code))
    .mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ error: 'slow_down' }, { status: 400 }))
    .mockResolvedValueOnce(Response.json(session()))
  vi.stubGlobal('fetch', fetch)
  const auth = new DeviceAuth()
  await auth.begin()
  expect(auth.snapshot().phase).toBe('verify')
  await vi.advanceTimersByTimeAsync(1999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2001)
  expect(fetch).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(6999)
  expect(fetch).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(auth.snapshot()).toMatchObject({ phase: 'ready', session: { orgId: 'org_test' } })
  expect(sessionStorage.getItem('okou-g2/device-code')).toBeNull()
})

it('restores the pending code on return to the WebView and stops polling after denial', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'signed_out' }, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ error: 'access_denied' }, { status: 400 }))
  vi.stubGlobal('fetch', fetch)
  sessionStorage.setItem('okou-g2/device-code', JSON.stringify({ ...code, nextPollAt: Date.now() + 2000, expiresAt: Date.now() + 90_000 }))
  const auth = new DeviceAuth()
  await auth.restore()
  expect(auth.snapshot().phase).toBe('verify')
  await vi.advanceTimersByTimeAsync(100_000)
  expect(auth.snapshot()).toMatchObject({ phase: 'signed-out', error: 'Authorization was declined.' })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('keeps an issued session if the WebView cannot clear its pending code', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(code)).mockResolvedValueOnce(Response.json(session()))
  vi.stubGlobal('fetch', fetch)
  const auth = new DeviceAuth()
  await auth.begin()
  vi.spyOn(sessionStorage, 'removeItem').mockImplementation(() => { throw new Error('Storage unavailable') })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(auth.snapshot()).toMatchObject({ phase: 'ready', session: { orgId: 'org_test' } })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('shares a rotating refresh across API and realtime callers and rejects an old workspace', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...session(), expiresAt: Date.now() + 500 }))
    .mockResolvedValueOnce(Response.json({ ...session(), accessToken: 'renewed' }))
  vi.stubGlobal('fetch', fetch)
  const auth = new DeviceAuth()
  await auth.restore()
  expect(await Promise.all([auth.accessToken('user_test', 'org_test'), auth.accessToken('user_test', 'org_test')]))
    .toEqual(['renewed', 'renewed'])
  expect(fetch).toHaveBeenCalledTimes(2)
  await expect(auth.accessToken('user_test', 'org_other')).rejects.toThrow('workspace')
})
