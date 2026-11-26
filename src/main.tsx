import { createRoot } from 'react-dom/client'
import App from './App'
import { DeviceAuth } from './auth'
import { hasEvenAppHost } from './glasses'
import './styles.css'

const auth = new DeviceAuth()
const root = createRoot(document.getElementById('root')!)
let startedWithHost: boolean | undefined
function start() {
  const installed = hasEvenAppHost()
  if (startedWithHost === installed || startedWithHost === true) return
  startedWithHost = installed
  void auth.restore()
  root.render(<App key={installed ? 'installed' : 'preview'} auth={auth} />)
}

// Flutter can inject its handler after document load. Upgrade a browser
// preview to the installed session exactly once when the native host is ready.
window.addEventListener('flutterInAppWebViewPlatformReady', start)
if (document.readyState === 'complete' || hasEvenAppHost()) start()
else window.addEventListener('load', start, { once: true })
window.addEventListener('focus', () => void auth.check())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void auth.check()
})
