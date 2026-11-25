import 'fake-indexeddb/auto'
import { clear, createStore, get } from 'idb-keyval'
import { UnsecuredJWT } from 'jose'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEVICE_CLIENT_ID, DEVICE_SCOPE, OAUTH_ISSUER } from '../config'
import { InstalledGrant } from '../installed-grant'

const store = createStore('okou-g2-auth', 'grants')
const access = new UnsecuredJWT({ sub: 'user_fixture', org_id: 'org_fixture', client_id: DEVICE_CLIENT_ID })
  .setExpirationTime('1h').encode()
const grant = (refresh_token?: string) => Response.json({ access_token: access, token_type: 'Bearer', refresh_token })
beforeEach(() => clear(store))
afterEach(() => vi.unstubAllGlobals())

it('starts at the issuer from a static package and distinguishes pending approval', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({}))
  fetch.mockResolvedValueOnce(Response.json({ device_code: 'fixture', user_code: 'TEST', expires_in: 90,
    verification_uri: 'https://accounts.okou.ai/activate' }))
    .mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }, { status: 400 }))
  vi.stubGlobal('fetch', fetch)
  const client = new InstalledGrant()
  expect(await client.device()).toMatchObject({ interval: 5, user_code: 'TEST' })
  await expect(client.token('fixture')).rejects.toMatchObject({ code: 'authorization_pending' })
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([OAUTH_ISSUER + '/oauth/device_authorization', OAUTH_ISSUER + '/oauth/token'])
  for (const [, init] of fetch.mock.calls) {
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', method: 'POST' })
    expect(typeof init.body).toBe('string')
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
  }
  expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0][1].body)))).toEqual({ client_id: DEVICE_CLIENT_ID, scope: DEVICE_SCOPE })
})

it('restores a sealed rotating grant after a reload and revokes the latest credential on sign-out', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({}))
  fetch.mockResolvedValueOnce(grant('first-fixture')).mockResolvedValueOnce(grant('next-fixture'))
    .mockResolvedValueOnce(grant()).mockResolvedValueOnce(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  expect(await new InstalledGrant().token('fixture')).toMatchObject({ userId: 'user_fixture', orgId: 'org_fixture' })
  const saved = await get(DEVICE_CLIENT_ID, store)
  expect(saved.key.extractable).toBe(false)
  expect(saved.ciphertext.byteLength).toBeGreaterThan(0)
  expect(JSON.stringify(saved)).not.toContain('first-fixture')
  const reopened = new InstalledGrant()
  await reopened.refresh()
  await reopened.token('fixture')
  await reopened.logout()
  await expect(new InstalledGrant().refresh()).rejects.toMatchObject({ code: 'signed_out' })
  const forms = fetch.mock.calls.map(([, init]) => Object.fromEntries(new URLSearchParams(String(init.body))))
  expect(forms[1]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'first-fixture' })
  expect(forms[2]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'next-fixture' })
  expect(forms[3]).toMatchObject({ token: 'next-fixture', token_type_hint: 'refresh_token' })
  expect(fetch.mock.calls[3][0]).toBe(OAUTH_ISSUER + '/oauth/token/revoke')
  expect(await get(DEVICE_CLIENT_ID, store)).toBeUndefined()
})
