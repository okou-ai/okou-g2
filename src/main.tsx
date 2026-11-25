import { createRoot } from 'react-dom/client'
import App from './App'
import { DeviceAuth } from './auth'
import './styles.css'

const auth = new DeviceAuth()
window.addEventListener('storage', (event) => {
  if (event.key === 'okou-g2/signed-out') void auth.restore()
})
createRoot(document.getElementById('root')!).render(<App auth={auth} />)
void auth.restore()
