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
  private authorizationTimer?: ReturnType<typeof setTimeout>
  private refreshing: Promise<DeviceSession> | null = null

  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(state: LoginState) {
    clearTimeout(this.authorizationTimer)
    this.authorizationTimer = undefined
    this.state = state
    this.listeners.forEach((listener) => listener())
  }

  async restore() {
    const previous = this.state
    const checkingApproval = this.authorizationTimer !== undefined || this.checking !== undefined
    const revision = ++this.revision
    if (previous.phase !== 'verify') this.set({ phase: 'loading' })
    try {
      const session = await exclusive('okou-g2/oauth', () => this.grants.refresh())
      if (this.revision === revision) this.accept(session)
    } catch (error) {
      if (this.revision !== revision) return
      if (error instanceof AuthError && error.status === 401) {
        if (error.code === 'signed_out') {
          // A late Even bridge can reveal a saved session. If it has none,
          // keep watching the very link the wearer may already have copied.
          if (previous.phase === 'verify' && previous.challenge.expiresAt > Date.now()) {
            if (checkingApproval) this.scheduleCheck(previous.challenge)
            return
          }
          return this.begin()
        }
        this.set({ phase: 'signed-out', error: error.code === 'mcp_grant_required' ? MCP_GRANT_PROMPT : undefined })
      } else {
        this.set({ phase: 'signed-out', error: 'Could not restore sign-in. Check your connection and try again.' })
      }
    }
  }

  async begin(notice?: string) {
    const revision = ++this.revision
    this.set({ phase: 'loading' })
    try {
      const code = await this.grants.device()
      if (revision !== this.revision) return
      this.set({ phase: 'verify', challenge: { ...code, expiresAt: Date.now() + code.expires_in * 1000,
        nextPollAt: Date.now() + code.interval * 1000 }, notice })
    } catch (error) {
      if (this.revision !== revision) return
      this.set({ phase: 'signed-out', error: deviceStartError(error) })
    }
  }

  private scheduleCheck(challenge: Challenge) {
    clearTimeout(this.authorizationTimer)
    const delay = Math.min(challenge.nextPollAt, challenge.expiresAt) - Date.now()
    this.authorizationTimer = setTimeout(() => void this.check(), Math.max(0, delay))
  }

  async check() {
    if (this.state.phase !== 'verify') return
    const { challenge } = this.state
    if (this.checking === challenge) return
    const remaining = Math.min(challenge.nextPollAt, challenge.expiresAt) - Date.now()
    if (remaining > 0) {
      this.scheduleCheck(challenge)
      return
    }
    this.checking = challenge
    try { await this.poll(challenge, this.revision) }
    finally { if (this.checking === challenge) this.checking = undefined }
  }

  private async poll(challenge: Challenge, revision: number) {
    if (revision !== this.revision || this.state.phase !== 'verify') return
    let message = 'This sign-in link expired.'
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
          const next = { ...challenge, interval, nextPollAt: Date.now() + interval * 1000 }
          this.set({ phase: 'verify', challenge: next })
          this.scheduleCheck(next)
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
    this.set({ phase: 'signed-out', error: message })
  }

  private accept(session: DeviceSession) {
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
    this.set({ phase: 'loading' })
    try {
      await exclusive('okou-g2/oauth', () => this.grants.logout())
      if (revision === this.revision) await this.begin()
    } catch {
      if (revision === this.revision) this.set({ phase: 'signed-out', error: 'Signed out locally. Remote revocation could not be confirmed.' })
    }
  }
}
