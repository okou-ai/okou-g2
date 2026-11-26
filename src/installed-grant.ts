import { DEVICE_CLIENT_ID, DEVICE_SCOPE, MCP_URL, OAUTH_ISSUER } from './config'
import { DEVICE_GRANT, McpConsentRequired, deviceCodeHash, parseDeviceCode, parseSession } from './device-protocol'
import type { DeviceAuthorizationResponse, DeviceSession } from './types'
import { connectBridge } from './glasses'
import { grantKey, migrateGrant, parseGrant, put, type Grant, type InstallStorage } from './install-storage'

export class AuthError extends Error {
  constructor(readonly code: string, readonly status: number, message = code) { super(message) }
}

async function clerk(path: string, params: Record<string, string>) {
  const response = await fetch(OAUTH_ISSUER + path, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    // The iOS WebView bridge can turn URLSearchParams into a string before fetch sets its media type.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DEVICE_CLIENT_ID, ...params }).toString(),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new AuthError(body?.error ?? 'token_request_failed', response.status)
  }
  return response
}

export class InstalledGrant {
  private memoryOnly?: { grant: Grant; previousSlot: string }
  private revision = 0

  constructor(private readonly storage: () => Promise<InstallStorage | null> = connectBridge) {}

  async device() {
    const response = await clerk('/oauth/device_authorization', { scope: DEVICE_SCOPE, resource: MCP_URL })
    try {
      return parseDeviceCode(await response.json() as DeviceAuthorizationResponse)
    } catch {
      throw new AuthError('invalid_device_response', response.status)
    }
  }

  private async slot(storage: InstallStorage | null): Promise<string> {
    if (!storage) return ''
    const raw = await storage.getLocalStorage(grantKey)
    return raw || migrateGrant(storage)
  }

  private async read(): Promise<Grant | undefined> {
    const raw = await this.slot(await this.storage())
    if (this.memoryOnly?.previousSlot === raw) return this.memoryOnly.grant
    this.memoryOnly = undefined
    try { return parseGrant(raw) } catch { return undefined }
  }

  private async exchange(params: Record<string, string>, hash: string, previous?: Grant, retry = true): Promise<DeviceSession> {
    const revision = this.revision
    const storage = await this.storage()
    const original = await this.slot(storage)
    if (previous && !this.memoryOnly && parseGrant(original)?.deviceHash !== hash) throw new AuthError('signed_out', 401)
    let response: Response
    try {
      response = await clerk('/oauth/token', params)
    } catch (error) {
      if (previous && error instanceof AuthError && ['invalid_target', 'invalid_scope'].includes(error.code)) {
        throw new AuthError('mcp_grant_required', 401)
      }
      if (previous && error instanceof AuthError && ['invalid_grant', 'access_denied', 'expired_token'].includes(error.code)) {
        // An older WebView may lose a rotation race. Never erase a newer grant on a stale rejection.
        const latest = await this.read()
        if (retry && latest?.deviceHash === hash && latest.refreshToken !== previous.refreshToken) return this.renew(latest, false)
        this.memoryOnly = undefined
        throw new AuthError('signed_out', 401)
      }
      throw error
    }
    const body = await response.json() as Record<string, unknown>
    let session: DeviceSession
    try { session = parseSession(body, DEVICE_CLIENT_ID) }
    catch (error) {
      if (!(error instanceof McpConsentRequired)) throw new AuthError('workspace_grant_required', 401)
      if (previous) throw new AuthError('mcp_grant_required', 401)
      throw new AuthError('mcp_grant_incomplete', 401, error.message)
    }
    const token = body.refresh_token ?? previous?.refreshToken
    if (typeof token !== 'string' || !token) throw new AuthError('offline_grant_required', 401)
    const grant = { refreshToken: token, deviceHash: hash }
    if (revision !== this.revision) throw new AuthError('signed_out', 401)
    if (storage) {
      try {
        const current = await this.slot(storage)
        if (current !== original) {
          if (previous && parseGrant(current)?.deviceHash === hash) return session
          throw new AuthError('signed_out', 401)
        }
        await put(storage, grantKey, JSON.stringify(grant))
        this.memoryOnly = undefined
        return session
      } catch (error) {
        if (error instanceof AuthError) throw error
        // The issuer already consumed the code or rotated the token. Keep this session usable.
      }
    }
    this.memoryOnly = { grant, previousSlot: original }
    return { ...session, temporary: true }
  }

  async token(deviceCode: string) {
    const hash = await deviceCodeHash(deviceCode)
    // An explicit sign-in can replace an unreadable installation.
    const saved = await this.read().catch(() => undefined)
    if (saved?.deviceHash === hash) return this.renew(saved)
    return this.exchange({ grant_type: DEVICE_GRANT, device_code: deviceCode, resource: MCP_URL }, hash)
  }

  private renew(grant: Grant, retry = true): Promise<DeviceSession> {
    // Omitting resource on refresh inherits the original Clerk grant, including a device grant without aud.
    return this.exchange({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }, grant.deviceHash, grant, retry)
  }

  async refresh() {
    const saved = await this.read()
    if (!saved) throw new AuthError('signed_out', 401)
    return this.renew(saved)
  }

  async logout() {
    const storage = await this.storage()
    this.revision++
    let saved: Grant | undefined
    try {
      saved = await this.read()
    } finally {
      this.memoryOnly = undefined
      try {
        // An explicit empty grant also prevents importing a superseded legacy login.
        if (storage) await put(storage, grantKey, 'null')
      } finally {
        if (saved) await clerk('/oauth/token/revoke', { token: saved.refreshToken, token_type_hint: 'refresh_token' })
      }
    }
  }
}
