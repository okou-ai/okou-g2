import { UnsecuredJWT } from 'jose'
import { afterEach, expect, it, vi } from 'vitest'
import { CHAT_SCOPES, DEVICE_CLIENT_ID, DEVICE_SCOPE, MCP_URL, OAUTH_ISSUER } from '../config'
import { InstalledGrant } from '../installed-grant'

import { host } from './install-fixture'
const access = new UnsecuredJWT({ sub: 'user_fixture', org_id: 'org_fixture', client_id: DEVICE_CLIENT_ID, aud: MCP_URL, scope: DEVICE_SCOPE })
  .setExpirationTime('1h').encode()
const grant = (refresh_token?: string) => Response.json({ access_token: access, token_type: 'Bearer', refresh_token })
afterEach(() => vi.unstubAllGlobals())

it('starts at the issuer from a static package and distinguishes pending approval', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({}))
  fetch.mockResolvedValueOnce(Response.json({ device_code: 'fixture', user_code: 'TEST', expires_in: 90,
    verification_uri: 'https://accounts.okou.ai/activate' }))
    .mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }, { status: 400 }))
  vi.stubGlobal('fetch', fetch)
  const client = new InstalledGrant()
  expect(await client.device()).toMatchObject({ interval: 5,
    verification_uri_complete: 'https://accounts.okou.ai/activate?user_code=TEST' })
  await expect(client.token('fixture')).rejects.toMatchObject({ code: 'authorization_pending' })
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([OAUTH_ISSUER + '/oauth/device_authorization', OAUTH_ISSUER + '/oauth/token'])
  for (const [, init] of fetch.mock.calls) {
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', method: 'POST' })
    expect(typeof init.body).toBe('string')
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
  }
  expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0][1].body)))).toEqual({ client_id: DEVICE_CLIENT_ID, scope: DEVICE_SCOPE, resource: MCP_URL })
})

it('uses the complete verification URL issued by Clerk with its original parameters', async () => {
  const link = 'https://accounts.okou.ai/device?user_code=A%2BB&lang=en'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    device_code: 'private-fixture', user_code: 'A+B', expires_in: 90,
    verification_uri: 'https://accounts.okou.ai/device', verification_uri_complete: link,
  })))
  expect((await new InstalledGrant().device()).verification_uri_complete).toBe(link)
})

it('restores chat with an existing MCP grant and requests consent if its audience is incompatible', async () => {
  const installed = host()
  const response = (aud: string | string[] | undefined, scopes = CHAT_SCOPES) => {
    const jwt = new UnsecuredJWT({ aud, sub: 'user_fixture', org_id: 'org_fixture',
      client_id: DEVICE_CLIENT_ID, scp: scopes }).setExpirationTime('1h').encode()
    return Response.json({ access_token: jwt, token_type: 'Bearer', refresh_token: 'rotating-fixture' })
  }
  const fetch = vi.fn().mockResolvedValueOnce(grant('first-fixture'))
    .mockResolvedValueOnce(response([MCP_URL])).mockResolvedValueOnce(response('https://other.example'))
    .mockResolvedValueOnce(response(['https://other.example'])).mockResolvedValueOnce(response(undefined, ['user:org:read', 'okou:chat:read']))
  vi.stubGlobal('fetch', fetch)
  await new InstalledGrant(installed.open).token('fixture')
  expect(await new InstalledGrant(installed.open).refresh()).toMatchObject({ userId: 'user_fixture' })
  await expect(new InstalledGrant(installed.open).refresh()).rejects.toMatchObject({ code: 'mcp_grant_required', status: 401 })
  await expect(new InstalledGrant(installed.open).token('new-code')).rejects.toMatchObject({
    code: 'mcp_grant_incomplete', message: expect.stringContaining('different resource'),
  })
  await expect(new InstalledGrant(installed.open).token('another-code')).rejects.toMatchObject({
    code: 'mcp_grant_incomplete', message: expect.stringContaining('okou:chat:send'),
  })
})

it('restores a rotating native grant after a reload and revokes the latest credential on sign-out', async () => {
  const installed = host()
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({}))
  fetch.mockResolvedValueOnce(grant('first-fixture')).mockResolvedValueOnce(grant('next-fixture'))
    .mockResolvedValueOnce(grant()).mockResolvedValueOnce(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  expect(await new InstalledGrant(installed.open).token('fixture')).toMatchObject({ userId: 'user_fixture', orgId: 'org_fixture' })
  const reopened = new InstalledGrant(installed.open)
  await reopened.refresh()
  await reopened.token('fixture')
  await reopened.logout()
  await expect(new InstalledGrant(installed.open).refresh()).rejects.toMatchObject({ code: 'signed_out' })
  const forms = fetch.mock.calls.map(([, init]) => Object.fromEntries(new URLSearchParams(String(init.body))))
  expect(forms[0]).toMatchObject({ resource: MCP_URL })
  expect(forms[1]).toEqual({ client_id: DEVICE_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'first-fixture' })
  expect(forms[2]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'next-fixture' })
  expect(forms[3]).toMatchObject({ token: 'next-fixture', token_type_hint: 'refresh_token' })
  expect(forms[3]).not.toHaveProperty('resource')
  expect(fetch.mock.calls[3][0]).toBe(OAUTH_ISSUER + '/oauth/token/revoke')
})
