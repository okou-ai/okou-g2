import { auth, json } from './oauth'
import { uploadVoice } from './voice'

export interface Env {
  OAUTH_CLIENT_ID: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) {
      return new Response('This QR link is retired. Open the Even Realities app and go to Me → Beta tester → Okou → Install.\n', {
        status: 410,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    if (url.pathname === '/api/health') return json({ ok: true })
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    if (request.headers.get('origin') !== url.origin) return json({ error: 'invalid_origin' }, 403)
    try {
      if (url.pathname === '/api/voice') return await uploadVoice(request)
      if (url.pathname.startsWith('/api/auth/')) return await auth(request, url.pathname.slice(10), env.OAUTH_CLIENT_ID)
      return json({ error: 'not_found' }, 404)
    } catch {
      return json({ error: 'upstream_unavailable' }, 502)
    }
  },
} satisfies ExportedHandler<Env>
