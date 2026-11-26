import { UnsecuredJWT } from 'jose'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OkouApiClient } from '../api/client'
import { API_BASE_URL, DEVICE_CLIENT_ID, DEVICE_SCOPE } from '../config'
import { InstalledGrant } from '../installed-grant'
import { rpc, toolResult } from './mcp-fixture'
import { host } from './install-fixture'
import { DeviceStore } from '../store'

const owner = { userId: 'user_fixture', orgId: 'org_fixture' }
// Clerk device-code grants may include the requested scopes without an audience.
const access = new UnsecuredJWT({ sub: owner.userId, org_id: owner.orgId, client_id: DEVICE_CLIENT_ID, scope: DEVICE_SCOPE })
  .setExpirationTime('1h').encode()
const grant = (refresh_token: string) => Response.json({ access_token: access, token_type: 'Bearer', refresh_token })
const api = new OkouApiClient(async () => access, new AbortController().signal)

function browserCookies() {
  let current = ''
  return {
    get cookie() { return current },
    set cookie(value: string) { current = value.includes('Max-Age=0') ? '' : value.split(';')[0] },
  }
}
beforeEach(() => {
  vi.stubGlobal('document', browserCookies())
  vi.stubGlobal('location', new URL('http://127.0.0.1:56844/'))
})
afterEach(() => vi.unstubAllGlobals())

it('restores the rotating grant only in the same package and revokes it across ports', async () => {
  const installed = host()
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response())
    .mockResolvedValueOnce(grant('fixture-first')).mockResolvedValueOnce(grant('fixture-rotated'))
  vi.stubGlobal('fetch', fetch)
  expect((await new InstalledGrant(installed.open).token('fixture-device')).temporary).toBeUndefined()
  expect(document.cookie).toBe('')
  expect([...installed.records.values()].join('')).not.toContain(access)
  await expect(new InstalledGrant(host().open).refresh()).rejects.toMatchObject({ code: 'signed_out' })
  expect(fetch).toHaveBeenCalledTimes(1)
  vi.stubGlobal('location', new URL('http://127.0.0.1:57984/'))
  expect(await new InstalledGrant(installed.open).refresh()).toMatchObject(owner)
  await new InstalledGrant(installed.open).logout()
  vi.stubGlobal('location', new URL('http://127.0.0.1:56844/'))
  await expect(new InstalledGrant(installed.open).refresh()).rejects.toMatchObject({ code: 'signed_out' })
  expect(document.cookie).toBe('')
  expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[1][1].body)))).toEqual({
    client_id: DEVICE_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'fixture-first',
  })
  expect(new URLSearchParams(String(fetch.mock.calls[2][1].body)).get('token')).toBe('fixture-rotated')
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('opens the 0.4.17 encrypted native login and existing thread, then reopens on a new port with no cookie', async () => {
  const installed = host()
  const legacyThread = crypto.randomUUID()
  const account = JSON.stringify([API_BASE_URL, owner.userId, owner.orgId])
  installed.records.set('okou.g2.thread.v1.' + account, JSON.stringify({ id: legacyThread, ready: true }))
  // Real v1 encoding of a fixture grant with fixed test-only key shares and IV.
  const oldSlot = 'okou.g2.grant.v1.dYd7tB05O1-4RVzmDs2N2gAdBjFklrFN-n-JVlbuyko'
  installed.records.set('okou.g2.install.v1', 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE')
  installed.records.set(oldSlot, 'AwMDAwMDAwMDAwMD.d93tNrUoQgukdoHLANPCa39AxYTTwdq7Lqhofz_MiVFPf7rkUMwI1spHg_imKs5IFYbumKJmHqubFq-nUgwC0pvd9f5607eDlL9YVK0')
  document.cookie = 'okou_g2_session_' + DEVICE_CLIENT_ID + '=AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'
  const tokens: string[] = []
  const create = vi.fn()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth/token')) {
      tokens.push(new URLSearchParams(String(init.body)).get('refresh_token')!)
      return grant('fixture-latest')
    }
    const args = rpc(init).params.arguments
    create(args.clientThreadId)
    return toolResult(init, { threadId: args.clientThreadId })
  })
  expect(await new InstalledGrant(installed.open).refresh()).toMatchObject(owner)
  expect(document.cookie).toBe('')
  expect(installed.records.get(oldSlot)).toBe('')
  vi.stubGlobal('location', new URL('http://127.0.0.1:57984/'))
  expect(await new InstalledGrant(installed.open).refresh()).toMatchObject(owner)
  expect(await new DeviceStore(owner, installed.open).fixedThread(api)).toBe(legacyThread)
  expect(create).not.toHaveBeenCalled()
  expect(tokens).toEqual(['fixture-legacy', 'fixture-latest'])
  const other = await new DeviceStore({ ...owner, orgId: 'org_other' }, installed.open).fixedThread(api)
  expect(other).not.toBe(legacyThread)
})

it('does not resurrect a signed-out session when an earlier refresh later succeeds', async () => {
  const installed = host()
  const fetch = vi.fn(async () => new Response()).mockResolvedValueOnce(grant('fixture-old'))
  vi.stubGlobal('fetch', fetch)
  await new InstalledGrant(installed.open).token('fixture-device')
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  fetch.mockImplementationOnce(async () => { started.resolve(); return response.promise })
  const pending = new InstalledGrant(installed.open).refresh()
  await started.promise
  await new InstalledGrant(installed.open).logout()
  response.resolve(grant('fixture-delayed'))
  await expect(pending).rejects.toMatchObject({ code: 'signed_out' })
  await expect(new InstalledGrant(installed.open).refresh()).rejects.toMatchObject({ code: 'signed_out' })
})

it('keeps a redeemed code usable for this launch when the native store refuses a write', async () => {
  const installed = host()
  installed.storage.setLocalStorage = async () => false
  const fetch = vi.fn().mockResolvedValueOnce(grant('fixture-first')).mockResolvedValueOnce(grant('fixture-next'))
  vi.stubGlobal('fetch', fetch)
  const open = new InstalledGrant(installed.open)
  expect(await open.token('fixture-device')).toMatchObject({ ...owner, temporary: true })
  expect(await open.token('fixture-device')).toMatchObject({ ...owner, temporary: true })
  expect(new URLSearchParams(String(fetch.mock.calls[1][1].body)).get('grant_type')).toBe('refresh_token')
  await expect(new InstalledGrant(installed.open).refresh()).rejects.toMatchObject({ code: 'signed_out' })
})

it('keeps a newer rotation when another port receives a late invalid_grant', async () => {
  const installed = host()
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response()).mockResolvedValueOnce(grant('fixture-old'))
  vi.stubGlobal('fetch', fetch)
  await new InstalledGrant(installed.open).token('fixture-device')
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  fetch.mockImplementationOnce(async () => { started.resolve(); return response.promise })
    .mockResolvedValueOnce(grant('fixture-current')).mockResolvedValueOnce(grant('fixture-new'))
  const pending = new InstalledGrant(installed.open).refresh()
  await started.promise
  await new InstalledGrant(installed.open).refresh()
  response.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }))
  expect(await pending).toMatchObject(owner)
  expect(new URLSearchParams(String(fetch.mock.calls[3][1].body)).get('refresh_token')).toBe('fixture-current')
})

it('allows a new interactive sign-in after its native grant record becomes unreadable', async () => {
  const installed = host()
  const fetch = vi.fn().mockResolvedValueOnce(grant('fixture-first'))
    .mockResolvedValueOnce(grant('fixture-second')).mockResolvedValueOnce(grant('fixture-rotated'))
  vi.stubGlobal('fetch', fetch)
  await new InstalledGrant(installed.open).token('first-device-code')
  const slot = [...installed.records.keys()].find(key => key.startsWith('okou.g2.grant.'))!
  installed.records.set(slot, 'damaged')
  const reopened = new InstalledGrant(installed.open)
  await expect(reopened.refresh()).rejects.toMatchObject({ code: 'signed_out' })
  expect(await reopened.token('second-device-code')).toMatchObject(owner)
  expect(await new InstalledGrant(installed.open).refresh()).toMatchObject(owner)
})
