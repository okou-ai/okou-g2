/**
 * Bridge discovery and device status.
 *
 * The same build has to run in three places: the Even App WebView on a phone
 * paired with G2, a plain desktop browser during development, and the Even Hub
 * simulator. This module answers "is there a host at all" so everything above
 * it can degrade cleanly. Screen rendering and input live in `src/lens/`.
 */
import {
  DeviceConnectType,
  waitForEvenAppBridge,
  type DeviceStatus,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

/**
 * `detecting` is a real state, not a placeholder: the Even App injects its host
 * handler some time after the page loads, so an early read cannot tell "no
 * glasses" apart from "not injected yet".
 */
export type BridgePhase = 'detecting' | 'unavailable' | 'ready'

export interface GlassesState {
  phase: BridgePhase
  /** Whether the startup page container has been created. */
  pageReady: boolean
  connectType: DeviceConnectType
  batteryLevel?: number
  isWearing?: boolean
  error?: string
}

export const initialGlassesState: GlassesState = {
  phase: 'detecting',
  pageReady: false,
  connectType: DeviceConnectType.None,
}

export function hasEvenAppHost(): boolean {
  const host = (window as { flutter_inappwebview?: { callHandler?: unknown } }).flutter_inappwebview
  return typeof host?.callHandler === 'function'
}

export async function connectBridge(): Promise<EvenAppBridge | null> {
  if (typeof window === 'undefined' || !hasEvenAppHost()) return null
  return waitForEvenAppBridge()
}

export function onDeviceStatus(
  bridge: EvenAppBridge,
  callback: (status: DeviceStatus) => void,
): () => void {
  return bridge.onDeviceStatusChanged(callback)
}

export function describeConnection(state: GlassesState): string {
  if (state.phase === 'detecting') return 'Looking for Even App…'
  if (state.phase === 'unavailable') return 'Not running inside Even App'
  switch (state.connectType) {
    case DeviceConnectType.Connected:
      return state.batteryLevel === undefined
        ? 'G2 connected'
        : `G2 connected · ${state.batteryLevel}%`
    case DeviceConnectType.Connecting:
      return 'Connecting to G2…'
    case DeviceConnectType.Disconnected:
      return 'G2 disconnected'
    case DeviceConnectType.ConnectionFailed:
      return 'G2 connection failed'
    default:
      return 'Waiting for G2'
  }
}
