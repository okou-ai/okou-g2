import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceAuth } from '../auth'
import { AuthError, InstalledGrant } from '../installed-grant'
import { version } from '../../app.json'
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

it('reports the installed build, origin and a safe OAuth failure without exposing provider text', async () => {
  vi.stubGlobal('location', new URL('http://127.0.0.1:50496/private?q=fixture'))
  const grants = new InstalledGrant()
  vi.spyOn(grants, 'device').mockRejectedValueOnce(new AuthError('invalid_request', 400))
    .mockRejectedValueOnce(new AuthError('untrusted response details', 403))
  const auth = new DeviceAuth(grants)
  await auth.begin()
  expect(auth.snapshot()).toMatchObject({ error: 'Device sign-in failed (HTTP 400, invalid_request). G2 ' + version + ' · http://127.0.0.1:50496' })
  await auth.begin()
  expect(auth.snapshot()).toMatchObject({ error: 'Device sign-in failed (HTTP 403). G2 ' + version + ' · http://127.0.0.1:50496' })
})

it('honours the device interval, slow_down and a workspace grant', async () => {
  const grants = new InstalledGrant()
  vi.spyOn(grants, 'device').mockResolvedValue(code)
  const token = vi.spyOn(grants, 'token')
    .mockRejectedValueOnce(new AuthError('authorization_pending', 400))
    .mockRejectedValueOnce(new AuthError('slow_down', 400)).mockResolvedValueOnce(session())
  const auth = new DeviceAuth(grants)
  await auth.begin()
  expect(auth.snapshot().phase).toBe('verify')
  await vi.advanceTimersByTimeAsync(1999)
  expect(token).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2001)
  expect(token).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(6999)
  expect(token).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(auth.snapshot()).toMatchObject({ phase: 'ready', session: { orgId: 'org_test' } })
  expect(sessionStorage.getItem('okou-g2/device-code')).toBeNull()
})

it('restores the pending code on return to the WebView and stops polling after denial', async () => {
  const grants = new InstalledGrant()
  vi.spyOn(grants, 'refresh').mockRejectedValue(new AuthError('signed_out', 401))
  const token = vi.spyOn(grants, 'token').mockRejectedValue(new AuthError('access_denied', 400))
  sessionStorage.setItem('okou-g2/device-code', JSON.stringify({ ...code, nextPollAt: Date.now() + 2000, expiresAt: Date.now() + 90_000 }))
  const auth = new DeviceAuth(grants)
  await auth.restore()
  expect(auth.snapshot().phase).toBe('verify')
  await vi.advanceTimersByTimeAsync(100_000)
  expect(auth.snapshot()).toMatchObject({ phase: 'signed-out', error: 'Authorization was declined.' })
  expect(token).toHaveBeenCalledTimes(1)
})

it('keeps an issued session if the WebView cannot clear its pending code', async () => {
  const grants = new InstalledGrant()
  vi.spyOn(grants, 'device').mockResolvedValue(code)
  const token = vi.spyOn(grants, 'token').mockResolvedValue(session())
  const auth = new DeviceAuth(grants)
  await auth.begin()
  vi.spyOn(sessionStorage, 'removeItem').mockImplementation(() => { throw new Error('Storage unavailable') })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(auth.snapshot()).toMatchObject({ phase: 'ready', session: { orgId: 'org_test' } })
  expect(token).toHaveBeenCalledTimes(1)
})

it('shares a rotating refresh across API and realtime callers and rejects an old workspace', async () => {
  const grants = new InstalledGrant()
  const refresh = vi.spyOn(grants, 'refresh').mockResolvedValueOnce({ ...session(), expiresAt: Date.now() + 500 })
    .mockResolvedValueOnce({ ...session(), accessToken: 'renewed' })
  const auth = new DeviceAuth(grants)
  await auth.restore()
  expect(await Promise.all([auth.accessToken('user_test', 'org_test'), auth.accessToken('user_test', 'org_test')]))
    .toEqual(['renewed', 'renewed'])
  expect(refresh).toHaveBeenCalledTimes(2)
  await expect(auth.accessToken('user_test', 'org_other')).rejects.toThrow('workspace')
})
