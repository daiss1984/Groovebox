import assert from 'node:assert/strict'
import test from 'node:test'
import { BaiduDeviceError, createBaiduDeviceFlow } from '../server/baidu-device.mjs'

const grant = {
  device_code: 'device-code-secret',
  user_code: 'ABCD-1234',
  verification_url: 'https://openapi.baidu.com/device',
  qrcode_url: 'https://openapi.baidu.com/device/qrcode/device-code-secret/ABCD-1234',
  expires_in: 300,
  interval: 5,
}

function fixture(reply, initial = grant) {
  let time = 1_000
  const urls = []
  const device = createBaiduDeviceFlow({
    clientId: 'fixture-app',
    clientSecret: 'fixture-secret',
    now: () => time,
    async request(url) {
      urls.push(url)
      if (urls.length === 1) return { ok: true, status: 200, value: initial }
      return reply?.(url, urls.length - 1)
    },
  })
  return { ...device, advance: seconds => { time += seconds * 1000 }, urls }
}

test('requests only the official OAuth endpoints and exposes only display fields', async () => {
  const token = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 30 }
  const flow = fixture(() => ({ ok: true, status: 200, value: token }))
  const { pending, publicInfo } = await flow.start()
  assert.deepEqual(publicInfo, {
    userCode: 'ABCD-1234', verificationUrl: 'https://openapi.baidu.com/device', expiresIn: 300, interval: 5,
  })
  assert.deepEqual(pending, { expiresAt: 301_000 })
  assert.equal(flow.urls[0].origin + flow.urls[0].pathname, 'https://openapi.baidu.com/oauth/2.0/device/code')
  assert.deepEqual(Object.fromEntries(flow.urls[0].searchParams), {
    response_type: 'device_code', client_id: 'fixture-app', scope: 'basic,netdisk', openapi: 'xpansdk',
  })
  assert.deepEqual(await flow.poll(pending), { status: 'pending', retryAfter: 5 })
  assert.equal(flow.urls.length, 1)
  flow.advance(5)
  assert.deepEqual(await flow.poll(pending), { status: 'authorized', value: token })
  assert.equal(flow.urls[1].origin + flow.urls[1].pathname, 'https://openapi.baidu.com/oauth/2.0/token')
  assert.deepEqual(Object.fromEntries(flow.urls[1].searchParams), {
    grant_type: 'device_token', code: grant.device_code, client_id: 'fixture-app',
    client_secret: 'fixture-secret', openapi: 'xpansdk',
  })
  await assert.rejects(flow.poll(pending), { status: 410 })
  assert.equal(flow.urls.length, 2)
})

test('honors pending polls and provider slow-down, with backoff on connection errors', async () => {
  const flow = fixture((url, attempt) => {
    if (attempt === 1) return { ok: false, status: 400, value: { error: 'authorization_pending' } }
    if (attempt === 2) return { ok: false, status: 429, value: { error: 'slow_down' } }
    throw new Error(String(url))
  })
  const { pending } = await flow.start()
  flow.advance(5)
  assert.deepEqual(await flow.poll(pending), { status: 'pending', retryAfter: 5 })
  flow.advance(3)
  assert.deepEqual(await flow.poll(pending), { status: 'pending', retryAfter: 2 })
  flow.advance(2)
  assert.deepEqual(await flow.poll(pending), { status: 'pending', retryAfter: 10 })
  flow.advance(10)
  assert.deepEqual(await flow.poll(pending), { status: 'pending', retryAfter: 20 })
  assert.equal(flow.urls.length, 4)
})

test('does not forward provider descriptions or reuse denied and expired grants', async () => {
  const denied = fixture(() => ({
    ok: false, status: 400, value: { error: 'access_denied', error_description: 'device-code-secret: fixture-secret' },
  }))
  const { pending } = await denied.start()
  denied.advance(5)
  await assert.rejects(denied.poll(pending), error => error instanceof BaiduDeviceError &&
    error.status === 403 && error.upstreamCode === 'access_denied' &&
    !error.message.includes('fixture-secret'))
  await assert.rejects(denied.poll(pending), { status: 410 })
  assert.equal(denied.urls.length, 2)

  const neverPolled = fixture()
  const started = await neverPolled.start()
  neverPolled.advance(300)
  await assert.rejects(neverPolled.poll(started.pending), { status: 410 })
  assert.equal(neverPolled.urls.length, 1)

  const unknown = fixture(() => ({
    ok: false, status: 400, value: { error: 'fixture-secret', error_description: 'device-code-secret' },
  }))
  const another = await unknown.start()
  unknown.advance(5)
  await assert.rejects(unknown.poll(another.pending), error => error instanceof BaiduDeviceError &&
    error.status === 502 && error.upstreamCode === undefined && !error.message.includes('fixture-secret'))
})

test('rejects malformed responses and limits browser-visible timing', async () => {
  for (const fields of [
    { verification_url: 'https://openapi.baidu.com.evil.invalid/device' },
    { verification_url: 'https://openapi.baidu.com/device?code=secret' },
    { user_code: '<img>' },
    { device_code: grant.user_code },
    { expires_in: -1 },
    { interval: '5' },
  ]) await assert.rejects(fixture(null, { ...grant, ...fields }).start(), { status: 502 })
  const long = await fixture(null, { ...grant, expires_in: 20_000, interval: 1000 }).start()
  assert.equal(long.publicInfo.expiresIn, 900)
  assert.equal(long.publicInfo.interval, 900)
})

test('coalesces concurrent polls and rejects a response arriving after expiry', async () => {
  let release
  const flow = fixture(() => new Promise(resolve => { release = resolve }))
  const { pending } = await flow.start()
  flow.advance(5)
  const first = flow.poll(pending)
  assert.equal((await flow.poll(pending)).status, 'pending')
  assert.equal(flow.urls.length, 2)
  flow.advance(295)
  release({ ok: true, status: 200, value: { access_token: 'fixture-access' } })
  await assert.rejects(first, { status: 410 })
})
