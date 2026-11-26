/**
 * Even App bridge discovery.
 *
 * The same build has to run in three places: the Even App WebView on a phone
 * paired with G2, a plain desktop browser during development, and the Even Hub
 * simulator. This module answers "is there a host at all" so everything above
 * it can degrade cleanly. Screen rendering and input live in `src/lens/`.
 */
import {
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

export function hasEvenAppHost(): boolean {
  const host = (window as { flutter_inappwebview?: { callHandler?: unknown } }).flutter_inappwebview
  return typeof host?.callHandler === 'function'
}

export async function connectBridge(): Promise<EvenAppBridge | null> {
  if (typeof window === 'undefined' || !hasEvenAppHost()) return null
  return waitForEvenAppBridge()
}
