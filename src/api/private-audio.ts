const ACCOUNT_HOST = '98b0b14cee451004596479a689d2071b.r2.cloudflarestorage.com'
const PRIVATE_BUCKET = 'user-artifact-private-prod'

export function isPrivateAudioUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    (url.hostname === PRIVATE_BUCKET + '.' + ACCOUNT_HOST ||
      (url.hostname === ACCOUNT_HOST && url.pathname.startsWith('/' + PRIVATE_BUCKET + '/')))
}
