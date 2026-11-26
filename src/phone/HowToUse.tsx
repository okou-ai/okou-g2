import { useRef, useState } from 'react'
import { Brand } from './Brand'
import readLens from './assets/read-lens.png'
import recordLens from './assets/record-lens.png'
import sendLens from './assets/send-lens.png'

const steps = [
  { title: 'Read a reply', help: 'The latest reply opens first. Swipe for more.', icon: 'read', image: readLens,
    alt: 'A reply about Orion’s belt, with Tap to speak and Hold: menu in the footer.',
    detail: 'Hold for the menu or double-tap for the system exit prompt. After 15 seconds idle, any gesture wakes the reader.' },
  { title: 'Tap to record', help: 'Speak while the reply stays in view. Hold to discard.', icon: 'record', image: recordLens,
    alt: 'The same reply with Listening 00:06 in the header and Tap to send and Hold: discard in the footer.',
    detail: 'You can keep turning pages while recording. Tap to send, or hold to discard and return to the reply.' },
  { title: 'Tap again to send', help: 'Okou’s next reply appears on your glasses.', icon: 'send', image: sendLens,
    alt: 'Sending appears in the upper right while the previous reply remains on the lens.',
    detail: 'You can keep reading while the recording sends. The next reply opens on its first page.' },
] as const

export function HowToUse({ onSignOut }: { onSignOut: () => void }) {
  const [index, setIndex] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const swiped = useRef(false)
  const step = steps[index]
  function advance(by: number) { setIndex(current => (current + by + steps.length) % steps.length) }

  return <section className="guide" aria-labelledby="guide-heading">
    <header className="guide-bar"><Brand />
      <button type="button" className="text-link sign-out" onClick={onSignOut}>Sign out</button>
    </header>
    <h1 id="guide-heading">How to use</h1>
    <button type="button" className="lens-box" aria-label={'Enlarge screenshot: ' + step.title}
      onPointerDown={event => {
        swiped.current = false
        touch.current = event.isPrimary ? { x: event.clientX, y: event.clientY } : null
      }}
      onPointerCancel={() => { touch.current = null }}
      onPointerUp={event => {
        const start = touch.current
        touch.current = null
        if (!start || !event.isPrimary) return
        const dx = event.clientX - start.x
        if (Math.abs(dx) < 38 || Math.abs(dx) < 1.6 * Math.abs(event.clientY - start.y)) return
        swiped.current = true
        advance(dx < 0 ? 1 : -1)
      }}
      onClick={event => { if (!swiped.current || event.detail === 0) dialog.current?.showModal() }}>
      <img src={step.image} alt={step.alt} width="576" height="288" />
      <span aria-hidden="true" className="enlarge"><span className="icon expand" /></span>
    </button>
    <ol className="steps" aria-label="Choose a gesture to see it on the lens">
      {steps.map((item, i) => <li key={item.icon}>
        <button type="button" className="step" aria-pressed={i === index} onClick={() => setIndex(i)}>
          <span className={'icon ' + item.icon} aria-hidden="true" />
          <span><strong>{item.title}</strong><small>{item.help}</small></span>
          <span className="icon next" aria-hidden="true" />
        </button>
      </li>)}
    </ol>
    <dialog ref={dialog} className="lens-dialog" aria-labelledby="lens-heading"
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          advance(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close() }}>
      <div className="dialog-inner">
        <header><h2 id="lens-heading">{step.title}</h2>
          <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}><span className="icon close" /></button>
        </header>
        <div className="full-lens" key={index}><img src={step.image} alt={step.alt} width="576" height="288" /></div>
        <p className="pan-hint">Swipe across the image to see the full lens.</p>
        <footer>
          <button type="button" aria-label="Previous" onClick={() => advance(-1)}><span className="icon previous" /></button>
          <p>{step.detail}</p>
          <button type="button" aria-label="Next" onClick={() => advance(1)}><span className="icon next" /></button>
        </footer>
      </div>
    </dialog>
  </section>
}
