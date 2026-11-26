import { useEffect, useRef, useState } from 'react'
import type { DeviceAuth, LoginState } from '../auth'
import { Brand } from './Brand'
import glasses from './assets/glasses.webp'

type Verification = Extract<LoginState, { phase: 'verify' }>

function selectLink(field: HTMLTextAreaElement) {
  field.focus({ preventScroll: true })
  field.select()
  field.setSelectionRange(0, field.value.length)
}

function SignInLink({ auth, challenge }: { auth: DeviceAuth; challenge: Verification['challenge'] }) {
  const input = useRef<HTMLTextAreaElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [feedback, setFeedback] = useState<'copied' | 'manual' | null>(null)
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  function renewIfExpired() {
    if (Date.now() < challenge.expiresAt) return false
    void auth.begin('Your link expired. Copy the new link below.')
    return true
  }

  async function copy(selectFirst: boolean) {
    const field = input.current
    if (!field || renewIfExpired()) return
    if (selectFirst) selectLink(field)
    let copied = false
    try {
      await navigator.clipboard.writeText(field.value)
      copied = true
    } catch {
      if (input.current !== field) return
      selectLink(field)
      try { copied = document.execCommand('copy') } catch { /* The link stays selected for native Copy. */ }
    }
    if (input.current !== field) return
    clearTimeout(toastTimer.current)
    setFeedback(copied ? 'copied' : 'manual')
    if (copied) toastTimer.current = setTimeout(() => setFeedback(null), 2000)
    void auth.check()
  }

  return <div className="link-control">
    <textarea ref={input} aria-label="Sign-in link" rows={2} readOnly inputMode="none" wrap="soft" dir="ltr"
      spellCheck={false} autoCapitalize="off" autoComplete="off" value={challenge.verification_uri_complete}
      onClick={() => void copy(true)} onCopy={event => {
        if (renewIfExpired()) event.preventDefault()
        else void auth.check()
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void copy(true) }
      }} />
    <button className="primary" type="button" onClick={() => void copy(false)}>
      <span aria-hidden="true" className="icon copy" />Copy link
    </button>
    {feedback === 'manual' && <p className="notice" role="status">Link selected. Choose Copy.</p>}
    <div className="copy-toast" role="status" aria-atomic="true">
      {feedback === 'copied' && <><span aria-hidden="true" className="icon check" />Copied</>}
    </div>
  </div>
}

export function SignIn({ auth, login }: { auth: DeviceAuth; login: Exclude<LoginState, { phase: 'ready' }> }) {
  return <>
    <header className="hero">
      <Brand />
      <img className="hero-glasses" src={glasses} alt="Grey Even G2 glasses" width="1250" height="504" />
    </header>
    <section className="auth-body" aria-label="Device sign-in">
      {login.phase === 'loading' && <p role="status">Opening Okou…</p>}
      {login.phase === 'verify' && <>
        <h1>Paste this link into your browser to sign up or sign in.</h1>
        {login.notice && <p className="notice" role="status">{login.notice}</p>}
        <SignInLink key={login.challenge.verification_uri_complete} auth={auth} challenge={login.challenge} />
      </>}
      {login.phase === 'signed-out' && <>
        {login.error && <p className="problem" role="alert">{login.error}</p>}
        <button className="primary" type="button" onClick={() => void auth.begin()}>Get sign-in link</button>
      </>}
    </section>
  </>
}
