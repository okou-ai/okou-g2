import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DeviceConnectType } from '@evenrealities/even_hub_sdk'
import { DeviceAuth } from './auth'
import { connectBridge } from './glasses'
import { SignIn } from './phone/SignIn'
import { HowToUse } from './phone/HowToUse'
import { LensController, type LensView } from './lens/controller'
import { DeviceChat, initialChat } from './sync/engine'

export default function App({ auth }: { auth: DeviceAuth }) {
  const login = useSyncExternalStore(auth.subscribe, auth.snapshot)
  const userId = login.phase === 'ready' ? login.session.userId : null
  const orgId = login.phase === 'ready' ? login.session.orgId : null
  const engine = useRef<DeviceChat | null>(null)
  const controller = useRef<LensController | null>(null)
  const [chat, setChat] = useState(initialChat)
  const [lensError, setLensError] = useState('')
  const [connection, setConnection] = useState<DeviceConnectType>()

  useLayoutEffect(() => {
    setChat(initialChat)
    if (!userId || !orgId) return
    const client = new DeviceChat({ userId, orgId }, () => auth.accessToken(userId, orgId), setChat)
    engine.current = client
    void client.refresh()
    const resume = () => {
      // Phone visibility does not determine whether the wearer is using the lens.
      if (document.visibilityState === 'visible') void client.refresh()
    }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      engine.current = null
      client.close()
    }
  }, [auth, userId, orgId])

  const status = login.phase === 'loading' ? 'Opening Okou…'
    : login.phase !== 'ready' ? 'Sign in on your phone'
    : chat.error ? 'Sync failed · tap to retry'
    : !chat.thread ? 'Opening conversation…'
    : chat.syncing && !chat.reply && !chat.working ? 'Loading messages…' : ''
  const view: LensView = { thread: userId ? chat.thread : null, reply: userId ? chat.reply : null,
    task: userId ? chat.task : null, working: !!userId && chat.working, status,
    pending: !!userId && chat.pending, canRecord: !!userId && !!chat.thread && !chat.error }
  const currentView = useRef(view)
  useLayoutEffect(() => {
    currentView.current = view
    controller.current?.update(view)
  })

  useEffect(() => {
    let disposed = false
    let detach: (() => void) | undefined
    let lens: LensController | undefined
    const onError = (message: string) => {
      if (!disposed) setLensError(message)
    }
    void (async () => {
      const bridge = await connectBridge()
      if (disposed) return
      if (!bridge) return
      detach = bridge.onDeviceStatusChanged(status => setConnection(status.connectType))
      lens = new LensController(bridge, async (id, audio) => {
        const client = engine.current
        if (!client) throw new Error('Sign in before sending a recording')
        return client.sendVoice(id, audio)
      }, () => void engine.current?.refresh(), onError, async (thread, target) => {
        await engine.current?.cancelTask(thread, target)
      })
      controller.current = lens
      lens.update(currentView.current)
      await lens.start()
    })().catch(() => onError('Could not open the glasses display. Reopen Okou in the Even App.'))
    return () => { disposed = true; detach?.(); lens?.close(); controller.current = null }
  }, [])

  return <main>
    {login.phase === 'ready' ? <>
      <HowToUse onSignOut={() => void auth.signOut()} />
      {login.session.temporary && <p className="phone-notice" role="status">Signed in for this launch only. Even App could not save your session.</p>}
      {chat.error && <div className="phone-notice" role="alert">
        <p>{chat.error}</p>
        <button type="button" className="text-link" disabled={chat.syncing} onClick={() => void engine.current?.refresh()}>
          {chat.syncing ? 'Refreshing…' : 'Refresh conversation'}
        </button>
      </div>}
      {chat.pending && <div className="phone-notice" role="status">
        <p>Checking the last voice message for delivery…</p>
        <button type="button" className="text-link" onClick={() => void engine.current?.retryPending()
          .catch((error: Error) => setLensError(error.message))}>Retry the same voice message</button>
      </div>}
    </> : <SignIn auth={auth} login={login} />}
    {connection === DeviceConnectType.Disconnected && <p className="phone-notice" role="status">G2 disconnected.</p>}
    {connection === DeviceConnectType.ConnectionFailed && <p className="phone-notice" role="alert">G2 connection failed.</p>}
    {lensError && <p className="phone-notice problem" role="alert">{lensError}</p>}
  </main>
}
