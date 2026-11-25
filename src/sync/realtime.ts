import * as Ably from 'ably'
import type { OkouApiClient } from '../api/client'
import type { Identity } from '../types'

export function watchThread(client: OkouApiClient, identity: Identity, thread: string,
  refresh: () => void, status: (connected: boolean) => void): () => void {
  const ably = new Ably.Realtime({
    authCallback: (_params, done) => {
      void client.call<Ably.TokenRequest>('get_chat_realtime_token', {}).then(
        (request) => done(null, request), (error) => done(error, null))
    },
  })
  const channel = ably.channels.get('user-org:' + identity.userId + ':' + identity.orgId, { modes: ['subscribe'] })
  channel.on('attached', () => { status(true); refresh() })
  channel.on('update', (change) => { if (!change.resumed) refresh() })
  ably.connection.on((change) => {
    if (change.current !== 'connected') status(false)
    else if (channel.state === 'attached') { status(true); refresh() }
  })
  channel.on(['detached', 'suspended', 'failed'], () => status(false))
  void channel.subscribe(['chatThreadMessageCreated:' + thread, 'chatThreadDetailChanged:' + thread], refresh)
    .catch(() => status(false))
  return () => { channel.unsubscribe(); channel.off(); ably.connection.off(); ably.close() }
}
