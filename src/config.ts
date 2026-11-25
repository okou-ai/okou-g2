export const API_BASE_URL = 'https://api.okou.ai'
export const OAUTH_ISSUER = 'https://clerk.okou.ai'
export const DEVICE_CLIENT_ID = 'gglCdwYgeNKmJxdj'
export const DEVICE_SCOPE = 'openid profile offline_access user:org:read okou:chat:read okou:chat:send'
export const AUDIO_SAMPLE_RATE = 16_000
export const MAX_RECORDING_SECONDS = 60
export const MAX_WAV_BYTES = 44 + AUDIO_SAMPLE_RATE * 2 * MAX_RECORDING_SECONDS
