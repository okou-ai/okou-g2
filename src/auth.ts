import { MCP_GRANT_PROMPT } from './device-protocol'
import type { DeviceCode, DeviceSession } from './types'
import { AuthError, InstalledGrant } from './installed-grant'
import { exclusive } from './install-storage'
import { version } from '../app.json'

interface Challenge extends DeviceCode {
  expiresAt: number
  nextPollAt: number
}

export type LoginState =
  | { phase: 'loading' }
  | { phase: 'signed-out'; error?: string }
  | { phase: 'verify'; challenge: Challenge; notice?: string }
  | { phase: 'ready'; session: DeviceSession }

const CHALLENGE = 'okou-g2/device-code'
const SIGNED_OUT = 'okou-g2/signed-out'

function deviceStartError(error: unknown) {
  const origin = typeof location === 'undefined' ? '' : ' · ' + location.origin
  const build = 'G2 ' + version + origin
  if (!(error instanceof AuthError)) return 'Could not reach clerk.okou.ai. ' + build
  if (error.code === 'invalid_device_response') return 'Unreadable device code from Clerk (HTTP ' + error.status + '). ' + build
  const publicCodes = ['invalid_request', 'invalid_client', 'invalid_scope', 'unauthorized_client', 'access_denied', 'temporarily_unavailable', 'server_error', 'slow_down']
  const reason = publicCodes.includes(error.code) ? ', ' + error.code : ''
  return 'Device sign-in failed (HTTP ' + error.status + reason + '). ' + build
}

export class DeviceAuth {
  constructor(private readonly grants = new InstalledGrant()) {}
  private state: LoginState = { phase: 'loading' }
  private listeners = new Set<() => void>()
  private revision = 0
  private checking?: Challenge
  private refreshing: Promise<DeviceSession> | null = null

  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(state: LoginState) {
    this.state = state
    this.listeners.forEach((listener) => listener())
  }

  async restore() {
    const revision = ++this.revision
    this.set({ phase: 'loading' })
    try {
      let consentError: string | undefined
      let signedOut = false
      try { signedOut = !!localStorage.getItem(SIGNED_OUT) } catch { /* Even's install store is independent. */ }
      if (!signedOut || await this.grants.hasInstalledSession()) {
        try {
          const session = await exclusive('okou-g2/oauth', () => this.grants.refresh())
          if (this.revision !== revision) return
          this.accept(session)
          return
        } catch (error) {
          if (!(error instanceof AuthError && error.status === 401)) throw error
          if (error.code === 'mcp_grant_required') consentError = MCP_GRANT_PROMPT
        }
      }
      if (this.revision !== revision) return
      const data = sessionStorage.getItem(CHALLENGE)
      if (data) {
        const challenge: Challenge = JSON.parse(data)
        if (challenge.expiresAt > Date.now()) {
          this.wait(challenge)
          await this.check()
          return
        }
        sessionStorage.removeItem(CHALLENGE)
      }
      this.set({ phase: 'signed-out', error: consentError })
    } catch {
      if (revision === this.revision) this.set({ phase: 'signed-out', error: 'Could not restore sign-in. Check your connection and try again.' })
    }
  }

  async begin() {
    const revision = ++this.revision
    this.set({ phase: 'loading' })
    try {
      const code = await this.grants.device()
      if (revision !== this.revision) return
      this.wait({ ...code, expiresAt: Date.now() + code.expires_in * 1000, nextPollAt: Date.now() + code.interval * 1000 })
    } catch (error) {
      if (this.revision !== revision) return
      this.set({ phase: 'signed-out', error: deviceStartError(error) })
    }
  }

  private wait(challenge: Challenge, notice?: string) {
    try { sessionStorage.setItem(CHALLENGE, JSON.stringify(challenge)) } catch { /* Keep the challenge in memory. */ }
    this.set({ phase: 'verify', challenge, notice })
  }

  async check() {
    if (this.state.phase !== 'verify') return
    const { challenge } = this.state
    if (this.checking === challenge) return
    const remaining = Math.min(challenge.nextPollAt, challenge.expiresAt) - Date.now()
    if (remaining > 0) {
      this.set({ phase: 'verify', challenge, notice: 'Check again in ' + Math.ceil(remaining / 1000) + 's.' })
      return
    }
    this.checking = challenge
    try { await this.poll(challenge, this.revision) }
    finally { if (this.checking === challenge) this.checking = undefined }
  }

  private async poll(challenge: Challenge, revision: number) {
    if (revision !== this.revision || this.state.phase !== 'verify') return
    let message = 'This device code expired. Start sign-in again.'
    if (Date.now() < challenge.expiresAt) {
      try {
        const session = await exclusive('okou-g2/oauth', async () => {
          if (revision !== this.revision || this.state.phase !== 'verify') throw new Error('Cancelled')
          return this.grants.token(challenge.device_code)
        })
        if (revision === this.revision) this.accept(session)
        return
      } catch (error) {
        if (revision !== this.revision || this.state.phase !== 'verify') return
        const code = error instanceof AuthError ? error.code : ''
        if (code === 'authorization_pending' || code === 'slow_down' ||
            !(error instanceof AuthError) || error.status === 429 || error.status >= 500) {
          const interval = code === 'authorization_pending' ? challenge.interval : Math.min(60, challenge.interval + 5)
          this.wait({ ...challenge, interval, nextPollAt: Date.now() + interval * 1000 }, 'Authorization is pending. Check again after approving.')
          return
        }
        if (code === 'access_denied') message = 'Authorization was declined.'
        else if (code === 'invalid_grant') message = 'This device code is no longer valid. Start a new sign-in in the Even App.'
        else if (code === 'mcp_grant_required') message = MCP_GRANT_PROMPT
        else if (error instanceof AuthError && code === 'mcp_grant_incomplete') message = error.message
        else if (code === 'workspace_grant_required') message = 'Authorize again and choose an Okou workspace.'
        else if (code !== 'expired_token') message = 'Could not finish device sign-in. Start again.'
      }
    }
    sessionStorage.removeItem(CHALLENGE)
    this.set({ phase: 'signed-out', error: message })
  }

  private accept(session: DeviceSession) {
    try {
      sessionStorage.removeItem(CHALLENGE)
      localStorage.removeItem(SIGNED_OUT)
    } catch {
      // A WebView storage error must not turn an issued session into another token poll.
    }
    this.set({ phase: 'ready', session })
  }

  async accessToken(userId: string, orgId: string) {
    const current = this.state
    if (current.phase !== 'ready' || current.session.userId !== userId || current.session.orgId !== orgId) {
      throw new Error('Sign in to this workspace again')
    }
    if (current.session.expiresAt > Date.now() + 30_000) return current.session.accessToken
    const revision = this.revision
    this.refreshing ??= exclusive('okou-g2/oauth', () => this.grants.refresh()).finally(() => { this.refreshing = null })
    let next: DeviceSession
    try {
      next = await this.refreshing
    } catch (error) {
      if (revision === this.revision && error instanceof AuthError && error.status === 401) {
        this.set({ phase: 'signed-out', error: error.code === 'mcp_grant_required' ? MCP_GRANT_PROMPT : 'Your session expired. Sign in again.' })
      }
      throw error
    }
    if (revision !== this.revision) throw new Error('Session changed')
    this.accept(next)
    if (next.userId !== userId || next.orgId !== orgId) throw new Error('Workspace changed')
    return next.accessToken
  }

  async signOut() {
    const revision = ++this.revision
    try { localStorage.setItem(SIGNED_OUT, '1') } catch { /* A memory-only session can still sign out. */ }
    try { sessionStorage.removeItem(CHALLENGE) } catch { /* Revocation still proceeds. */ }
    this.set({ phase: 'loading' })
    try {
      await exclusive('okou-g2/oauth', () => this.grants.logout())
      if (revision === this.revision) this.set({ phase: 'signed-out' })
    } catch {
      if (revision === this.revision) this.set({ phase: 'signed-out', error: 'Signed out locally. Remote revocation could not be confirmed.' })
    }
  }
}
