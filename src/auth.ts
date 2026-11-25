import type { DeviceCode, DeviceSession } from './types'
import { AuthError, InstalledGrant } from './installed-grant'

interface Challenge extends DeviceCode {
  expiresAt: number
  nextPollAt: number
}

export type LoginState =
  | { phase: 'loading' }
  | { phase: 'signed-out'; error?: string }
  | { phase: 'verify'; challenge: Challenge }
  | { phase: 'ready'; session: DeviceSession }

const CHALLENGE = 'okou-g2/device-code'
const SIGNED_OUT = 'okou-g2/signed-out'

// Serialize token rotation across tabs, or inside a single older WebView.
let localGrants = Promise.resolve()
function grantLock<T>(work: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request('okou-g2/oauth', work)
  const result = localGrants.then(work)
  localGrants = result.then(() => {}, () => {})
  return result
}

export class DeviceAuth {
  constructor(private readonly grants = new InstalledGrant()) {}
  private state: LoginState = { phase: 'loading' }
  private listeners = new Set<() => void>()
  private revision = 0
  private timer?: ReturnType<typeof setTimeout>
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
    clearTimeout(this.timer)
    this.set({ phase: 'loading' })
    try {
      if (!localStorage.getItem(SIGNED_OUT)) {
        try {
          const session = await grantLock(() => this.grants.refresh())
          if (this.revision !== revision) return
          this.accept(session)
          return
        } catch (error) {
          if (!(error instanceof AuthError && error.status === 401)) throw error
        }
      }
      if (this.revision !== revision) return
      const data = sessionStorage.getItem(CHALLENGE)
      if (data) {
        const challenge: Challenge = JSON.parse(data)
        if (challenge.expiresAt > Date.now()) {
          this.wait(challenge, revision)
          return
        }
        sessionStorage.removeItem(CHALLENGE)
      }
      this.set({ phase: 'signed-out' })
    } catch {
      if (revision === this.revision) this.set({ phase: 'signed-out', error: 'Could not restore sign-in. Check your connection and try again.' })
    }
  }

  async begin() {
    const revision = ++this.revision
    clearTimeout(this.timer)
    this.set({ phase: 'loading' })
    try {
      const code = await this.grants.device()
      if (revision !== this.revision) return
      this.wait({ ...code, expiresAt: Date.now() + code.expires_in * 1000, nextPollAt: Date.now() + code.interval * 1000 }, revision)
    } catch (error) {
      if (this.revision !== revision) return
      const message = error instanceof TypeError && typeof location !== 'undefined'
        ? 'Could not reach clerk.okou.ai from ' + location.origin + '.'
        : 'Could not start device sign-in. Try again.'
      this.set({ phase: 'signed-out', error: message })
    }
  }

  private wait(challenge: Challenge, revision: number) {
    try { sessionStorage.setItem(CHALLENGE, JSON.stringify(challenge)) } catch { /* The open page can still poll. */ }
    this.set({ phase: 'verify', challenge })
    this.timer = setTimeout(() => void this.poll(challenge, revision),
      Math.max(0, Math.min(challenge.nextPollAt, challenge.expiresAt) - Date.now()))
  }

  private async poll(challenge: Challenge, revision: number) {
    if (revision !== this.revision || this.state.phase !== 'verify') return
    let message = 'This device code expired. Start sign-in again.'
    if (Date.now() < challenge.expiresAt) {
      try {
        const session = await grantLock(async () => {
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
          this.wait({ ...challenge, interval, nextPollAt: Date.now() + interval * 1000 }, revision)
          return
        }
        if (code === 'access_denied') message = 'Authorization was declined.'
        else if (code === 'invalid_grant') message = 'This device code is no longer valid. Start a new sign-in in the Even App.'
        else if (code === 'workspace_grant_required') message = 'Authorize again and choose an Okou workspace.'
        else if (code !== 'expired_token') message = 'Could not finish device sign-in. Start again.'
      }
    }
    sessionStorage.removeItem(CHALLENGE)
    this.set({ phase: 'signed-out', error: message })
  }

  private accept(session: DeviceSession) {
    clearTimeout(this.timer)
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
    this.refreshing ??= grantLock(() => this.grants.refresh()).finally(() => { this.refreshing = null })
    let next: DeviceSession
    try {
      next = await this.refreshing
    } catch (error) {
      if (revision === this.revision && error instanceof AuthError && error.status === 401) {
        this.set({ phase: 'signed-out', error: 'Your session expired. Sign in again.' })
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
    clearTimeout(this.timer)
    try { localStorage.setItem(SIGNED_OUT, '1') } catch { /* A memory-only session can still sign out. */ }
    try { sessionStorage.removeItem(CHALLENGE) } catch { /* Revocation still proceeds. */ }
    this.set({ phase: 'loading' })
    try {
      await grantLock(() => this.grants.logout())
      if (revision === this.revision) this.set({ phase: 'signed-out' })
    } catch {
      if (revision === this.revision) this.set({ phase: 'signed-out', error: 'Signed out locally. Remote revocation could not be confirmed.' })
    }
  }
}
