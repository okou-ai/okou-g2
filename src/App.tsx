import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { DeviceAuth } from './auth'
import { connectBridge, describeConnection, initialGlassesState, onDeviceStatus } from './glasses'
import { LensController, type LensView } from './lens/controller'
import { currentTask, toLensMessages } from './lens/messages'
import { DeviceChat, initialChat } from './sync/engine'

export default function App({ auth }: { auth: DeviceAuth }) {
  const login = useSyncExternalStore(auth.subscribe, auth.snapshot)
  const userId = login.phase === 'ready' ? login.session.userId : null
  const orgId = login.phase === 'ready' ? login.session.orgId : null
  const engine = useRef<DeviceChat | null>(null)
  const controller = useRef<LensController | null>(null)
  const [chat, setChat] = useState(initialChat)
  const [glasses, setGlasses] = useState(initialGlassesState)
  const messages = useMemo(() => toLensMessages(chat.rows), [chat.rows])
  const task = useMemo(() => currentTask(chat.rows), [chat.rows])

  useLayoutEffect(() => {
    setChat(initialChat)
    if (!userId || !orgId) return
    const client = new DeviceChat({ userId, orgId }, () => auth.accessToken(userId, orgId), setChat)
    engine.current = client
    void client.start()
    const resume = () => {
      if (document.visibilityState === 'visible') void client.refresh()
      else controller.current?.suspend()
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
    : chat.syncing && !messages.length ? 'Loading messages…' : ''
  const view: LensView = { thread: userId ? chat.thread : null, messages: userId ? messages : [],
    task: userId ? task : null, status, pending: chat.pending, canRecord: !!userId && !!chat.thread && !chat.error }
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
      if (!disposed) setGlasses((state) => state.error === message ? state : { ...state, error: message })
    }
    void (async () => {
      const bridge = await connectBridge()
      if (disposed) return
      if (!bridge) { setGlasses((s) => ({ ...s, phase: 'unavailable' })); return }
      setGlasses((s) => ({ ...s, phase: 'ready' }))
      detach = onDeviceStatus(bridge, ({ connectType, batteryLevel, isWearing }) =>
        setGlasses((s) => ({ ...s, connectType, batteryLevel, isWearing })))
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
      if (!disposed) setGlasses((s) => ({ ...s, pageReady: true }))
    })().catch(() => onError('Could not open the glasses display. Reopen Okou in the Even App.'))
    return () => { disposed = true; detach?.(); lens?.close(); controller.current = null }
  }, [])

  const lastReply = messages.findLast((m) => m.role === 'assistant')
  return <main>
    <header><h1>Okou for Even G2</h1><p className="hint">{describeConnection(glasses)}</p></header>
    {login.phase === 'loading' && <section className="card" role="status">Opening Okou…</section>}
    {login.phase === 'signed-out' && <section className="card">
      <h2>Connect your glasses</h2>
      <p className="hint">Sign in to Okou and choose the workspace for your G2 conversation.</p>
      <button onClick={() => void auth.begin()}>Sign in with Okou</button>
      {login.error && <p className="error" role="alert">{login.error}</p>}
    </section>}
    {login.phase === 'verify' && <section className="card">
      <h2>Authorize this G2</h2>
      <p>Enter this code on the Okou authorization page, choose a workspace, then return here.</p>
      <p className="device-code">{login.challenge.user_code}</p>
      <a className="button" href={login.challenge.verification_uri} target="_blank" rel="noopener noreferrer">Open authorization page</a>
      <p className="hint verification-url">{login.challenge.verification_uri}</p>
      <button className="link" onClick={() => void auth.signOut()}>Cancel</button>
    </section>}
    {login.phase === 'ready' && <>
      {login.session.temporary && <p className="error" role="status">Signed in for this launch only. Even App could not save your session.</p>}
      <section className="card">
        <h2>Even G2 conversation</h2>
        {chat.thread && <p className="mono">{chat.thread}</p>}
        <p role="status">{chat.pending ? 'Checking the last voice message for delivery…'
          : chat.error ? 'Could not sync this conversation.' : !chat.thread ? 'Opening conversation…'
          : chat.live ? 'Listening for replies' : 'Checking for replies'}</p>
        {chat.error && <p className="error" role="alert">{chat.error}</p>}
        {chat.pending && <button onClick={() => void engine.current?.retryPending().catch((error: Error) =>
          setGlasses((state) => ({ ...state, error: error.message })))}>Retry the same voice message</button>}
        {lastReply && <p className="reply">{lastReply.text}</p>}
        <button className="link" disabled={chat.syncing} onClick={() => void engine.current?.refresh()}>
          {chat.syncing ? 'Refreshing…' : 'Refresh conversation'}
        </button>
      </section>
      <section className="card">
        <h2>On the glasses</h2>
        <p>Tap to read the latest reply. Swipe to scroll it, or double-tap to go quiet. Tap again from the reader to record. Long-press for actions while reading or recording.</p>
        <p className="hint">Workspace <span className="mono">{orgId}</span></p>
        <button className="link" onClick={() => void auth.signOut()}>Sign out</button>
      </section>
    </>}
    {glasses.error && <p className="error" role="alert">{glasses.error}</p>}
  </main>
}
