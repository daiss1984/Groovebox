// The endpoints and payload fields are defined by the Baidu Netdisk OpenAPI SDK.
// https://github.com/baidu-netdisk/mcp/blob/main/src/baidu-netdisk/openapi_client/api/auth_api.py
const oauthRoot = 'https://openapi.baidu.com/oauth/2.0/'
const verificationUrl = 'https://openapi.baidu.com/device'
const minimumInterval = 5
const maxLifetime = 900

export class BaiduDeviceError extends Error {
  constructor(status, message, upstreamCode) {
    super(message)
    this.status = status
    this.upstreamCode = upstreamCode
  }
}

const expired = code => new BaiduDeviceError(410, '百度设备授权已过期，请重新开始。', code)
const unavailable = () => new BaiduDeviceError(502, '百度设备授权服务暂时不可用，请稍后再试。')

function endpoint(path, params) {
  const url = new URL(path, oauthRoot)
  url.search = new URLSearchParams({ ...params, openapi: 'xpansdk' })
  return url
}

function providerError(code) {
  switch (code) {
    case 'access_denied':
    case 'authorization_declined':
      return new BaiduDeviceError(403, '百度设备授权已取消，请重新开始。', code)
    case 'expired_token':
    case 'expired_device_code':
    case 'code_expired':
    case 'invalid_grant':
      return expired(code)
    case 'invalid_client':
    case 'unauthorized_client':
    case 'invalid_scope':
      return new BaiduDeviceError(401, '百度拒绝了应用的设备授权，请检查应用配置和网盘权限。', code)
    default:
      return unavailable()
  }
}

const isPositiveInteger = value => Number.isSafeInteger(value) && value > 0

export function createBaiduDeviceFlow({ clientId, clientSecret, request, now = Date.now }) {
  const grants = new WeakMap()

  async function start() {
    let response
    try {
      response = await request(endpoint('device/code', {
        response_type: 'device_code', client_id: clientId, scope: 'basic,netdisk',
      }))
    } catch {
      throw unavailable()
    }

    const value = response?.value
    if (!response?.ok || value?.error) throw providerError(value?.error)
    if (typeof value?.user_code !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(value.user_code) ||
        typeof value.device_code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.device_code) ||
        value.device_code === value.user_code ||
        ![verificationUrl, verificationUrl + '/'].includes(value.verification_url) ||
        !isPositiveInteger(value.expires_in) ||
        (value.interval !== undefined && !isPositiveInteger(value.interval))) throw unavailable()

    const expiresIn = Math.min(maxLifetime, value.expires_in)
    const interval = Math.min(expiresIn, Math.max(minimumInterval, value.interval ?? minimumInterval))
    const started = now()
    const pending = { expiresAt: started + expiresIn * 1000 }
    grants.set(pending, { code: value.device_code, interval, nextPoll: started + interval * 1000, polling: false })
    return { pending, publicInfo: { userCode: value.user_code, verificationUrl, expiresIn, interval } }
  }

  function waitUntil(pending, grant, seconds) {
    grant.interval = Math.min(maxLifetime, seconds)
    grant.nextPoll = Math.min(pending.expiresAt, now() + grant.interval * 1000)
    return { status: 'pending', retryAfter: Math.max(1, Math.ceil((grant.nextPoll - now()) / 1000)) }
  }

  async function poll(pending) {
    const grant = grants.get(pending)
    if (!grant || now() >= pending.expiresAt) {
      grants.delete(pending)
      throw expired()
    }
    if (grant.polling || now() < grant.nextPoll) {
      return { status: 'pending', retryAfter: Math.max(1, Math.ceil((grant.nextPoll - now()) / 1000)) }
    }

    let response
    grant.polling = true
    try {
      response = await request(endpoint('token', {
        grant_type: 'device_token', code: grant.code, client_id: clientId, client_secret: clientSecret,
      }))
    } catch {
      // Wait longer after a connection failure before retrying the provider.
    } finally {
      grant.polling = false
    }

    if (now() >= pending.expiresAt) {
      grants.delete(pending)
      throw expired()
    }
    const { value, status } = response ?? {}
    if (value?.error === 'slow_down' || status === 429) return waitUntil(pending, grant, grant.interval + 5)
    if (value?.error === 'authorization_pending') return waitUntil(pending, grant, grant.interval)
    if (!response || status >= 500) return waitUntil(pending, grant, grant.interval * 2)

    grants.delete(pending)
    if (response.ok && !value?.error && typeof value?.access_token === 'string' && value.access_token) {
      return { status: 'authorized', value }
    }
    throw providerError(value?.error)
  }

  return { start, poll }
}
