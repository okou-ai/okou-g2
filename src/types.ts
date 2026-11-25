export interface Identity {
  readonly userId: string
  readonly orgId: string
}

export interface DeviceSession extends Identity {
  readonly accessToken: string
  readonly expiresAt: number
}

export interface DeviceCode {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly expires_in: number
  readonly interval: number
}

export interface ChatEventRow {
  readonly id: string
  readonly chatThreadId: string
  readonly runId: string | null
  readonly revokesEventId: string | null
  readonly eventType: string
  readonly seqId: number
  readonly createdAt: string
  readonly payload: {
    readonly content?: string
    readonly userMessage?: unknown
    readonly error?: string
  } | null
}

export interface ChatEventCursor {
  readonly lastEventId: string | null
  readonly lastSeqId: number
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value)
}
