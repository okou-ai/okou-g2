import 'fake-indexeddb/auto'
import { clear, createStore, get } from 'idb-keyval'
import { UnsecuredJWT } from 'jose'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OkouApiClient } from '../api/client'
import { DEVICE_CLIENT_ID, DEVICE_SCOPE, MCP_URL } from '../config'
import { InstalledGrant } from '../installed-grant'
import { rpc, toolResult } from './mcp-fixture'
import type { InstallStorage } from '../install-storage'
import { DeviceStore } from '../store'

const authDatabase = createStore('okou-g2-auth', 'grants')
const threadDatabase = createStore('okou-g2-device', 'chat')
const owner = { userId: 'user_fixture', orgId: 'org_fixture' }
// Clerk device-code grants may include the requested scopes without an audience.
const access = new UnsecuredJWT({ sub: owner.userId, org_id: owner.orgId, client_id: DEVICE_CLIENT_ID, scope: DEVICE_SCOPE })
  .setExpirationTime('1h').encode()
const grant = (refresh_token: string) => Response.json({ access_token: access, token_type: 'Bearer', refresh_token })
const api = new OkouApiClient(async () => access, new AbortController().signal)

function host() {
  const records = new Map<string, string>()
  const storage: InstallStorage = {
    getLocalStorage: async (key) => records.get(key) ?? '',
    setLocalStorage: async (key, value) => { records.set(key, value); return true },
  }
  return { records, storage, open: async () => storage }
}

function browserCookies() {
  let current = ''
  return {
    get cookie() { return current },
    set cookie(value: string) { current = value.includes('Max-Age=0') ? '' : value.split(';')[0] },
  }
}
beforeEach(async () => {
  await Promise.all([clear(authDatabase), clear(threadDatabase)])
  vi.stubGlobal('document', browserCookies())
  vi.stubGlobal('location', new URL('http://127.0.0.1:56844/'))
})
afterEach(() => vi.unstubAllGlobals())

it('requires both the package store and the host cookie to use a rotating grant, and revokes it across ports', async () => {
  const installed = host()
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response())
    .mockResolvedValueOnce(grant('fixture-first')).mockResolvedValueOnce(grant('fixture-rotated'))
  vi.stubGlobal('fetch', fetch)
  expect((await new InstalledGrant(installed.open).token('fixture-device')).temporary).toBeUndefined()
  const cookie = document.cookie
  const records = JSON.stringify([...installed.records])
  expect(cookie).toBeTruthy()
  expect(records).not.toContain(cookie.split('=')[1])
  expect(records + cookie).not.toContain('fixture-first')
  expect(records + cookie).not.toContain(access)
  await expect(new InstalledGrant(host().open).refresh()).rejects.toMatchObject({ code: 'signed_out' })
  document.cookie = ''
  await expect(new InstalledGrant(installed.open).refresh()).rejects.toMatchObject({ code: 'signed_out' })
  expect(fetch).toHaveBeenCalledTimes(1)
  document.cookie = cookie
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

it('carries an accessible 0.4.3 grant and thread into the package before the old origin is lost', async () => {
  const installed = host()
  const browser = async () => null
  const create = vi.fn()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth/token')) return grant('fixture-latest')
    expect(url).toBe(MCP_URL)
    const message = rpc(init)
    expect(message.params.name).toBe('create_chat_thread')
    const threadId = message.params.arguments.clientThreadId
    create(threadId)
    return toolResult(init, { threadId })
  })
  await new InstalledGrant(browser).token('fixture-device')
  const legacy = await new DeviceStore(owner, browser).fixedThread(api)
  await new InstalledGrant(installed.open).refresh()
  expect(await get(DEVICE_CLIENT_ID, authDatabase)).toBeUndefined()
  expect(await new DeviceStore(owner, installed.open).fixedThread(api)).toBe(legacy)
  await Promise.all([clear(authDatabase), clear(threadDatabase)])
  vi.stubGlobal('location', new URL('http://127.0.0.1:57984/'))
  expect(await new InstalledGrant(installed.open).refresh()).toMatchObject(owner)
  expect(await new DeviceStore(owner, installed.open).fixedThread(api)).toBe(legacy)
  expect(create.mock.calls).toEqual([[legacy]])
  const other = await new DeviceStore({ ...owner, orgId: 'org_other' }, installed.open).fixedThread(api)
  expect(other).not.toBe(legacy)
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

it('keeps a redeemed code usable for this launch when the WebView disallows the cookie', async () => {
  const installed = host()
  vi.stubGlobal('document', { get cookie() { return '' }, set cookie(_value: string) { /* rejected by host */ } })
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

it('allows a new interactive sign-in after a sealed package record becomes unreadable', async () => {
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
