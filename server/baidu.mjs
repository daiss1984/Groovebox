import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createSessionStore } from './oauth-session-store.mjs'
import { BaiduDeviceError, createBaiduDeviceFlow } from './baidu-device.mjs'
import { imageSignature } from './artwork.mjs'
import { createBaiduBackup, baiduBackupError } from './baidu-backup.mjs'

const prefix = '/api/baidu'
const sessionCookie = 'musicer_baidu'
const oauthCookie = 'musicer_baidu_oauth'
const sessionLifetime = 30 * 86400
const authorizationLifetime = 600
const codeInputLimit = 8192
const localhost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const lyricsLimit = 1_000_000
const coverLimit = 8 * 1024 * 1024
const folderCoverTypes = new Map([['cover.png', 'image/png'], ['cover.jpg', 'image/jpeg'], ['cover.jpeg', 'image/jpeg']])
const baiduApi = 'https://pan.baidu.com/rest/2.0/xpan/'
const oauthApi = 'https://openapi.baidu.com/oauth/2.0/'
const audioTypes = new Map(Object.entries({
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.alac': 'audio/mp4',
  '.ape': 'audio/x-ape',
  '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
}))

const allowedMethods = {
  [prefix + '/status']: 'GET',
  [prefix + '/connect']: 'GET',
  [prefix + '/callback']: 'GET',
  [prefix + '/code/start']: 'POST',
  [prefix + '/code/complete']: 'POST',
  [prefix + '/device/start']: 'POST',
  [prefix + '/device/poll']: 'POST',
  [prefix + '/disconnect']: 'POST',
  [prefix + '/list']: 'GET',
  [prefix + '/backup']: 'GET, PUT',
  [prefix + '/cover']: 'GET, HEAD',
  [prefix + '/stream']: 'GET, HEAD',
}

class BaiduError extends Error {
  constructor(status, message, upstreamCode) {
    super(message)
    this.status = status
    this.upstreamCode = upstreamCode
  }
}

const authorizationCodeErrors = new Map([
  ['invalid_grant', '百度拒绝了这次授权码。请重新打开百度授权页面，同意授权后立即粘贴页面显示的新授权码。'],
  ['invalid_client', '百度拒绝了应用凭据。请在更改应用配置中核对同一百度应用的 AppKey 和当前 SecretKey。'],
  ['unauthorized_client', '该百度应用没有获准使用此授权方式。请在百度开放平台检查应用状态和网盘接口权限。'],
  ['invalid_scope', '该百度应用可能缺少网盘授权权限。请在百度开放平台检查应用的网盘接口权限。'],
  ['redirect_uri_mismatch', '百度判定本次授权方式与授权码不匹配。请从播放器生成新的授权页面。'],
]);

function endpoint(base, path, parameters) {
  const url = new URL(path, base)
  url.search = new URLSearchParams(parameters).toString()
  return url
}

function readCookie(req, name) {
  const prefix = name + '='
  const entry = req.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(prefix))
  const value = entry?.slice(prefix.length)
  return /^[A-Za-z0-9_-]{43}$/.test(value ?? '') ? value : ''
}

function cookie(name, value, maxAge, secure) {
  return [
    name + '=' + value,
    'Path=' + prefix,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAge,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

function createKey() {
  return randomBytes(32).toString('base64url')
}

function stateMatches(received, expected) {
  return /^[A-Za-z0-9_-]{43}$/.test(received ?? '') &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected))
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function redirect(res, location, cookies = []) {
  res.setHeader('Location', location)
  if (cookies.length) res.setHeader('Set-Cookie', cookies)
  res.writeHead(303)
  res.end()
}

function callbackURL(value) {
  try {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const supportedProtocol = url.protocol === 'https:' || (loopback && url.protocol === 'http:')
    if (supportedProtocol && url.pathname === prefix + '/callback' &&
        !url.username && !url.password && !url.hash && !url.search) return url
  } catch {
    return null
  }
  return null
}

function loopbackOrigin(req) {
  const host = req.headers.host
  const forwarded = req.headers.forwarded || req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']
  if (forwarded || !loopback.has(req.socket.remoteAddress) || !localhost.test(host ?? '')) return null
  try {
    return new URL((req.socket.encrypted ? 'https://' : 'http://') + host).origin
  } catch {
    return null
  }
}

function sameLocalOrigin(req) {
  const origin = loopbackOrigin(req)
  const fetchSite = req.headers['sec-fetch-site']
  return origin && req.headers.origin === origin && (!fetchSite || fetchSite === 'same-origin') ? origin : null
}

function localCodeOrigin(req) {
  const origin = sameLocalOrigin(req)
  if (!origin) {
    throw new BaiduError(403, '请在本机 Groovebox 的同一页面完成百度网盘授权。')
  }
  return origin
}

async function readCodeInput(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new BaiduError(415, '请使用 Groovebox 授权表单提交授权码。')
  }
  if (Number(req.headers['content-length']) > codeInputLimit) {
    throw new BaiduError(413, '百度授权内容过长。')
  }
  let length = 0
  const chunks = []
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length
    if (length > codeInputLimit) throw new BaiduError(413, '百度授权内容过长。')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BaiduError(400, '无法读取百度授权内容。')
  }
}

function getAudioType(name) {
  return audioTypes.get(posix.extname(name).toLowerCase())
}

function isLyrics(name) {
  return /\.(?:lrc|vtt)$/i.test(name)
}

function decodeLyrics(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  }
}

function decodeText(value) {
  if (typeof value !== 'string') return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function netdiskId(raw) {
  const value = String(raw ?? '')
  return /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
    ? value : ''
}

function listItem(file) {
  const path = decodeText(file.path)
  const name = decodeText(file.server_filename) || posix.basename(path)
  const id = netdiskId(file.fs_id)
  const folder = Number(file.isdir) === 1
  if (!id || !name || !path) return null
  return {
    id, name, path, folder, size: Number(file.size) || 0,
    streamUrl: !folder && (getAudioType(name) || isLyrics(name)) ? prefix + '/stream?id=' + id : null,
  }
}

function coverDirectory(path) {
  if (!path.startsWith('/') || /[\\\0]|(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) return ''
  return path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
}

function folderCoverDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22)
}

function folderCoverName(path) {
  if (path.endsWith('/')) return undefined
  const name = posix.basename(path).toLowerCase()
  return folderCoverTypes.has(name) ? name : undefined
}

function remember(store, key, entry) {
  for (const [id, value] of store) {
    if (value.expiresAt <= Date.now()) store.delete(id)
  }
  if (store.size >= 5000) store.delete(store.keys().next().value)
  store.set(key, entry)
}

function lookup(store, key) {
  const entry = store.get(key)
  if (!entry || entry.expiresAt > Date.now()) return entry
  store.delete(key)
}

function downloadURL(value, redirectFrom) {
  const url = new URL(value, redirectFrom)
  const allowedInitial = ['d.pcs.baidu.com', 'pcs.baidu.com'].includes(url.hostname)
  const allowedRedirect = /(?:^|\.)(?:baidu\.com|baidupcs\.com|baidubce\.com)$/.test(url.hostname)
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !(redirectFrom ? allowedRedirect : allowedInitial)) {
    throw new BaiduError(502, '百度网盘返回了无效的下载地址。')
  }
  return url
}

function authorizedDownload(file, token) {
  if (typeof file.dlink !== 'string') {
    throw new BaiduError(502, '百度网盘未签发下载链接，请检查应用的下载权限。')
  }
  const download = downloadURL(file.dlink)
  download.search += (download.search ? '&' : '?') + 'access_token=' + encodeURIComponent(token)
  return download
}

async function readDownloadBytes(upstream, limit, oversizeMessage) {
  if (Number(upstream.headers.get('content-length')) > limit) {
    await upstream.body.cancel()
    throw new BaiduError(413, oversizeMessage)
  }
  const reader = upstream.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new BaiduError(413, oversizeMessage)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    reader.releaseLock()
  }
}

export function createBaiduHandler({ env = process.env, request = globalThis.fetch, sessionFile,
  backupGenerationActive = () => true } = {}) {
  const clientId = env.BAIDU_CLIENT_ID?.trim()
  const clientSecret = env.BAIDU_CLIENT_SECRET?.trim()
  const redirectUri = env.BAIDU_REDIRECT_URI?.trim()
  const callback = callbackURL(redirectUri)
  const configured = Boolean(clientId && clientSecret && callback)
  const secure = callback?.protocol === 'https:'
  const publicCallback = configured && secure && !localhost.test(callback.host) ? redirectUri : undefined
  const authorizations = new Map()
  const sessionStore = configured && sessionFile
    ? createSessionStore(sessionFile, clientSecret, JSON.stringify([clientId, redirectUri])) : null
  const sessions = sessionStore ? sessionStore.read() : new Map()
  const deviceFlow = createBaiduDeviceFlow({ clientId, clientSecret, request: fetchJson })
  const backup = createBaiduBackup({
    appFolder: env.BAIDU_BACKUP_APP_FOLDER, request, getAudioType, decodeText, netdiskId,
    async readFile(file, token, signal) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (signal.aborted) abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        const upstream = await openDownload(authorizedDownload(file, token), { method: 'GET' }, controller)
        if (upstream.status !== 200 || !upstream.body || ![null, 'identity'].includes(upstream.headers.get('content-encoding')) ||
            /^text\/html\b/i.test(upstream.headers.get('content-type') ?? '')) {
          await upstream.body?.cancel()
          throw new BaiduError(502, '无法下载百度网盘备份。')
        }
        return await readDownloadBytes(upstream, backup.maxBytes, '百度网盘备份文件超过 1 MB。')
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },
  })

  function persistSessions() {
    try {
      sessionStore?.write(sessions)
    } catch {
      throw new BaiduError(503, '无法保存百度网盘授权，请检查服务端数据目录。')
    }
  }

  function beginAuthorization(req, mode, origin) {
    const state = createKey()
    const key = createKey()
    authorizations.delete(readCookie(req, oauthCookie))
    remember(authorizations, key, { mode, state, origin, expiresAt: Date.now() + authorizationLifetime * 1000 })
    const authorize = endpoint(oauthApi, 'authorize', {
      response_type: 'code', client_id: clientId, redirect_uri: mode === 'code' ? 'oob' : redirectUri,
      scope: 'basic,netdisk', display: 'page', state,
    })
    const secureCookie = mode === 'code' ? origin.startsWith('https://') : secure
    return { state, authorizeUrl: authorize.href, cookie: cookie(oauthCookie, key, authorizationLifetime, secureCookie) }
  }

  async function startDevice(req, res) {
    const origin = localCodeOrigin(req)
    const { pending, publicInfo } = await deviceFlow.start()
    const state = createKey()
    const key = createKey()
    authorizations.delete(readCookie(req, oauthCookie))
    remember(authorizations, key, {
      mode: 'device', state, origin, pending, expiresAt: Date.now() + publicInfo.expiresIn * 1000,
    })
    res.setHeader('Set-Cookie', cookie(oauthCookie, key, publicInfo.expiresIn, origin.startsWith('https://')))
    sendJson(res, 200, { state, ...publicInfo })
  }

  async function pollDevice(req, res, sessionId) {
    const origin = localCodeOrigin(req)
    const { state } = await readCodeInput(req) ?? {}
    const key = readCookie(req, oauthCookie)
    const authorization = lookup(authorizations, key)
    if (authorization?.mode !== 'device' || authorization.origin !== origin ||
        typeof state !== 'string' || !stateMatches(state, authorization.state)) {
      throw new BaiduError(400, '百度设备授权已过期或不匹配。请重新获取设备码。')
    }
    if (authorization.polling) {
      sendJson(res, 200, { status: 'pending', retryAfter: 5 })
      return
    }
    const secureCookie = origin.startsWith('https://')
    const cleared = cookie(oauthCookie, '', 0, secureCookie)
    authorization.polling = true
    try {
      const result = await deviceFlow.poll(authorization.pending)
      if (lookup(authorizations, key) !== authorization) {
        throw new BaiduError(400, '百度设备授权已过期或不匹配。请重新获取设备码。')
      }
      if (result.status === 'pending') {
        sendJson(res, 200, result)
        return
      }
      const token = readToken(result.value)
      if (!token) throw new BaiduError(502, '百度设备授权未返回有效的登录凭据。')
      authorizations.delete(key)
      res.setHeader('Set-Cookie', [cleared, establishSession(sessionId, token, secureCookie)])
      sendJson(res, 200, { status: 'authorized', configured, connected: true })
    } catch (error) {
      if (authorizations.get(key) === authorization) {
        authorizations.delete(key)
        res.setHeader('Set-Cookie', cleared)
      }
      throw error
    } finally {
      authorization.polling = false
    }
  }

  function establishSession(sessionId, token, secureCookie) {
    const id = createKey()
    const previous = sessions.get(sessionId)
    sessions.delete(sessionId)
    remember(sessions, id, { token, expiresAt: Date.now() + sessionLifetime * 1000 })
    try {
      persistSessions()
    } catch (error) {
      sessions.delete(id)
      if (previous) sessions.set(sessionId, previous)
      throw error
    }
    return cookie(sessionCookie, id, sessionLifetime, secureCookie)
  }

  async function completeManualCode(req, res, sessionId) {
    const origin = localCodeOrigin(req)
    const { state, code: pasted } = await readCodeInput(req) ?? {}
    const key = readCookie(req, oauthCookie)
    const authorization = lookup(authorizations, key)
    if (authorization?.mode !== 'code' || authorization.origin !== origin ||
        typeof state !== 'string' || !stateMatches(state, authorization.state)) {
      throw new BaiduError(400, '百度授权已过期或授权会话不匹配，请重新开始授权。')
    }
    const code = typeof pasted === 'string' ? pasted.trim() : ''
    if (code.length > 4096 || !/^[\x21-\x7e]+$/.test(code)) {
      throw new BaiduError(400, '请输入百度授权页面显示的授权码。')
    }

    // Reserve the attempt before contacting Baidu so the browser cannot replay it.
    authorizations.delete(key)
    const secureCookie = origin.startsWith('https://')
    const cleared = cookie(oauthCookie, '', 0, secureCookie)
    res.setHeader('Set-Cookie', cleared)
    const token = await exchange({ grant_type: 'authorization_code', code, redirect_uri: 'oob' })
    res.setHeader('Set-Cookie', [cleared, establishSession(sessionId, token, secureCookie)])
    sendJson(res, 200, { configured, connected: true })
  }

  async function fetchJson(url, signal) {
    const timeout = AbortSignal.timeout(12_000)
    const response = await request(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    })
    const content = await response.text()
    const value = JSON.parse(content, (key, parsed, context) => {
      if ((key === 'fs_id' || key === 'uk') && typeof parsed === 'number') return context.source
      return parsed
    })
    if (!value || typeof value !== 'object') throw new BaiduError(502, '百度网盘返回了无效响应。')
    return { ok: response.ok, status: response.status, value }
  }

  async function exchange(params) {
    const { ok, status, value } = await fetchJson(endpoint(oauthApi, 'token', {
      client_id: clientId, client_secret: clientSecret, ...params,
    }))
    if (status >= 500 || status === 429) throw new BaiduError(502, '百度授权服务暂时不可用，请稍后再试。')
    if (params.grant_type === 'authorization_code' && value.error) {
      const knownError = authorizationCodeErrors.get(value.error)
      if (knownError) throw new BaiduError(401, knownError, value.error)
      throw new BaiduError(502, '百度未能兑换授权码。请重新发起授权后再试。')
    }
    const token = ok && !value.error && readToken(value)
    if (!token) {
      throw new BaiduError(401, '百度网盘授权已失效，请重新连接。')
    }
    return token
  }

  function readToken(value) {
    const lifetime = Number(value?.expires_in)
    if (typeof value?.access_token !== 'string' || !value.access_token ||
        !Number.isSafeInteger(lifetime) || lifetime <= 0) return null
    return {
      accessToken: value.access_token,
      refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : '',
      expiresAt: Date.now() + lifetime * 1000,
    }
  }

  async function accessToken(session, rejectedToken) {
    if (session.refreshing) return session.refreshing
    const token = session.token
    if (token && token.accessToken !== rejectedToken && token.expiresAt > Date.now() + 30_000) {
      return token.accessToken
    }
    if (!token?.refreshToken) {
      session.token = null
      persistSessions()
      throw new BaiduError(401, '百度网盘授权已失效，请重新连接。')
    }
    session.refreshing = (async () => {
      try {
        const next = await exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken })
        session.token = { ...next, refreshToken: next.refreshToken || token.refreshToken }
        persistSessions()
        return next.accessToken
      } catch (error) {
        if (error instanceof BaiduError && error.status === 401) {
          session.token = null
          persistSessions()
        }
        throw error
      } finally {
        session.refreshing = null
      }
    })()
    return session.refreshing
  }

  async function queryNetdisk(session, route, params, signal, pinnedToken) {
    async function query(token) {
      return fetchJson(endpoint(baiduApi, route, { ...params, access_token: token }), signal)
    }

    let token = pinnedToken ?? await accessToken(session)
    let result = await query(token)
    if ([20016, 20017, 110, 111].includes(Number(result.value.errno ?? result.value.error_code))) {
      if (pinnedToken) throw new BaiduError(401, '百度网盘授权已失效，请重新连接。')
      token = await accessToken(session, token)
      result = await query(token)
    }

    const value = result.value
    const code = Number(value.errno ?? value.error_code ?? 0)
    if (code === -9 && (result.ok || result.status === 404)) throw new BaiduError(404, '百度网盘目录不存在。')
    if (code === 31034) throw new BaiduError(429, '百度网盘请求过于频繁，请稍后重试。', code)
    if (!result.ok || code !== 0) {
      throw new BaiduError(502, '百度网盘未能完成请求，请检查授权和应用权限。', code || undefined)
    }
    return { value, token }
  }

  async function backupIdentity(session, signal, pinnedToken) {
    const cached = session.backupIdentity
    if (cached?.token === (pinnedToken ?? session.token?.accessToken) && session.token?.expiresAt > Date.now() + 30_000) {
      return cached
    }
    const { value, token } = await queryNetdisk(session, 'nas', { method: 'uinfo' }, signal, pinnedToken)
    const uk = netdiskId(value.uk)
    if (!uk) throw new BaiduError(502, '百度网盘未返回可验证的账号。')
    const account = createHmac('sha256', clientSecret)
      .update(JSON.stringify(['Groovebox Baidu playlist backup', clientId, uk]))
      .digest('base64url')
    const identity = { account, token }
    if (session.token?.accessToken === token) session.backupIdentity = identity
    return identity
  }

  async function serveBackup(req, res, session, sessionId, url) {
    const fetchSite = req.headers['sec-fetch-site']
    const origin = req.headers.origin
    const trustedOrigin = origin && (origin === callback?.origin || sameLocalOrigin(req))
    if ((fetchSite && !['same-origin', 'none'].includes(fetchSite)) || (origin && !trustedOrigin) ||
        (req.method === 'PUT' && !trustedOrigin)) throw new BaiduError(403, '请在播放器中使用百度网盘备份。')
    let token
    const assertActive = () => {
      if (!backupGenerationActive() || lookup(sessions, sessionId) !== session || !session.token ||
          (token && session.token.accessToken !== token)) {
        throw new BaiduError(401, '百度网盘授权已变更，请重新打开备份。')
      }
    }
    try {
      return await backup.serve(req, res, url.searchParams, {
        assertActive,
        async identify(signal) {
          assertActive()
          const identity = await backupIdentity(session, signal)
          token = identity.token
          assertActive()
          return {
            ...identity, assertActive,
            query(route, params, signal) {
              assertActive()
              return queryNetdisk(session, route, params, signal, token)
            },
          }
        },
      })
    } catch (error) {
      if (error.code !== 'commit_unknown') assertActive()
      throw error
    }
  }

  function coverProof(sessionId, ids, folder, version) {
    return createHmac('sha256', clientSecret)
      .update(JSON.stringify(['Groovebox Baidu folder cover', clientId, redirectUri, sessionId, ids, folder, version]))
      .digest('base64url')
  }

  function attachFolderCover(items, candidates, directory, sessionId) {
    const selected = [...folderCoverTypes.keys()].map(name => candidates.get(name)).filter(Boolean)
    if (!selected.length) return items
    const ids = [...new Set(selected.map(({ id }) => id))].join(',')
    const folder = folderCoverDigest(directory)
    const v = folderCoverDigest(selected)
    const proof = coverProof(sessionId, ids, folder, v)
    const folderCover = prefix + '/cover?' + new URLSearchParams({ ids, folder, v, proof })
    return items.map(item => !item.folder && getAudioType(item.name) && coverDirectory(posix.dirname(item.path)) === directory
      ? { ...item, folderCover } : item)
  }

  async function list(session, sessionId, url) {
    const path = url.searchParams.get('path') ?? '/'
    if (!path.startsWith('/') || path.includes('\0') || path.length > 4096) {
      throw new BaiduError(400, '无效的百度网盘目录。')
    }
    const pageSize = 1000
    const items = new Map()
    const directory = coverDirectory(path)
    const candidates = new Map()
    const tokens = new Set()
    for (let start = 0; ; start += pageSize) {
      const { value, token } = await queryNetdisk(session, 'file', {
        method: 'list', dir: path, order: 'name', start, limit: pageSize,
      })
      if (backup.enabled && tokens.size < 2) tokens.add(token)
      if (!Array.isArray(value.list)) throw new BaiduError(502, '百度网盘未返回文件列表。')
      const previousSize = items.size
      for (const file of value.list) {
        const item = file && listItem(file)
        if (!item) continue
        items.set(item.id, item)
        if (!directory || item.folder || item.size > coverLimit || coverDirectory(posix.dirname(item.path)) !== directory) continue
        const name = folderCoverName(item.path)
        if (name && !candidates.has(name)) {
          candidates.set(name, { id: item.id, name, size: item.size, modified: Number(file.server_mtime) || 0,
            md5: typeof file.md5 === 'string' ? file.md5.slice(0, 32) : '' })
        }
      }
      if (value.list.length < pageSize) break
      if (items.size === previousSize) throw new BaiduError(502, '百度网盘未返回下一页文件。')
    }
    const listed = attachFolderCover([...items.values()], candidates, directory, sessionId)
    if (tokens.size !== 1 || !listed.some(item => !item.folder && getAudioType(item.name))) return listed
    const identity = await backupIdentity(session, AbortSignal.timeout(3000), tokens.values().next().value).catch(() => null)
    return identity ? listed.map(item => !item.folder && getAudioType(item.name)
      ? { ...item, backupAccount: identity.account } : item) : listed
  }

  async function openDownload(url, { method, range }, controller) {
    const headers = { 'User-Agent': 'pan.baidu.com', 'Accept-Encoding': 'identity' }
    if (range) headers.Range = range
    for (let count = 0; count < 6; count += 1) {
      const deadline = setTimeout(() => controller.abort(), 15_000)
      let response
      try {
        response = await request(url, {
          method, headers, redirect: 'manual', signal: controller.signal,
        })
      } finally {
        clearTimeout(deadline)
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) break
      url = downloadURL(location, url)
    }
    throw new BaiduError(502, '百度网盘未返回可用的文件流。')
  }

  async function serveLyrics(download, req, res, controller) {
    const deadline = setTimeout(() => controller.abort(), 15_000)
    try {
      const upstream = await openDownload(download, { method: 'GET' }, controller)
      const type = upstream.headers.get('content-type') ?? ''
      if (upstream.status !== 200 || !upstream.body ||
          /^(?:text\/html|application\/(?:json|xml))\b/i.test(type)) {
        await upstream.body?.cancel()
        throw new BaiduError(502, '百度网盘歌词下载失败。')
      }
      const bytes = await readDownloadBytes(upstream, lyricsLimit, '百度网盘歌词文件超过 1 MB。')
      let lyrics
      try {
        lyrics = decodeLyrics(bytes).replace(/\r\n?/g, '\n')
      } catch {
        throw new BaiduError(415, '不支持此百度网盘歌词文件编码。')
      }
      if (lyrics.includes('\0')) throw new BaiduError(415, '不支持此百度网盘歌词文件编码。')
      const body = Buffer.from(lyrics, 'utf8')
      if (body.byteLength > lyricsLimit) throw new BaiduError(413, '百度网盘歌词文件超过 1 MB。')
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.byteLength,
        'Content-Security-Policy': "default-src 'none'",
      }).end(req.method === 'HEAD' ? undefined : body)
    } finally {
      clearTimeout(deadline)
    }
  }

  async function coverBytes(file, type, token, controller) {
    try {
      const upstream = await openDownload(authorizedDownload(file, token), { method: 'GET' }, controller)
      const mime = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (upstream.status !== 200 || !upstream.body || ![null, 'identity'].includes(upstream.headers.get('content-encoding')) ||
          (mime && mime !== type && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream')) {
        await upstream.body?.cancel()
        return undefined
      }
      const bytes = await readDownloadBytes(upstream, coverLimit, '百度网盘封面文件超过 8 MB。')
      return imageSignature(bytes, type) ? bytes : undefined
    } catch (error) {
      if (controller.signal.aborted || !(error instanceof BaiduError || error instanceof TypeError)) throw error
      return undefined
    }
  }

  async function serveCover(req, res, session, sessionId, url) {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new BaiduError(403, '请在播放器中读取百度网盘封面。')
    const { searchParams: params } = url
    const ids = params.get('ids') || ''
    const folder = params.get('folder') || ''
    const v = params.get('v') || ''
    const proof = params.get('proof') || ''
    if (params.size !== 4 || !/^[1-9]\d{0,18}(?:,[1-9]\d{0,18}){0,2}$/.test(ids) ||
        !/^[\w-]{22}$/.test(folder) || !/^[\w-]{22}$/.test(v) ||
        !stateMatches(proof, coverProof(sessionId, ids, folder, v))) {
      throw new BaiduError(404, '找不到此百度网盘封面。')
    }
    const candidates = ids.split(',').map(netdiskId)
    if (candidates.some(id => !id) || new Set(candidates).size !== candidates.length) {
      throw new BaiduError(404, '找不到此百度网盘封面。')
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    const deadline = setTimeout(abort, 15_000)
    res.once('close', abort)
    try {
      const { value, token } = await queryNetdisk(session, 'multimedia', {
        method: 'filemetas', fsids: '[' + ids + ']', dlink: '1',
      }, controller.signal)
      const files = new Map((Array.isArray(value.list) ? value.list : []).filter(Boolean).map(file => [netdiskId(file.fs_id), file]))
      for (const id of candidates) {
        const file = files.get(id)
        if (!file || Number(file.errno ?? 0) !== 0 || Number(file.isdir) === 1 || Number(file.size) > coverLimit) continue
        const path = decodeText(file.path)
        const directory = coverDirectory(posix.dirname(path))
        const name = folderCoverName(path)
        const suppliedName = decodeText(file.filename ?? file.server_filename).toLowerCase()
        if (!directory || folderCoverDigest(directory) !== folder || !name || (suppliedName && suppliedName !== name)) continue
        const type = folderCoverTypes.get(name)
        const bytes = await coverBytes(file, type, token, controller)
        if (!bytes) continue
        return res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': bytes.length,
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        }).end(req.method === 'HEAD' ? undefined : bytes)
      }
      throw new BaiduError(404, '找不到有效的百度网盘目录封面。')
    } finally {
      clearTimeout(deadline)
      res.off('close', abort)
    }
  }

  async function stream(req, res, session, url) {
    const id = netdiskId(url.searchParams.get('id'))
    if (!id) throw new BaiduError(400, '无效的百度网盘文件 ID。')
    if (req.headers.range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(req.headers.range)) {
      throw new BaiduError(416, '不支持此音频字节范围。')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.once('close', abort)
    try {
      const { value, token } = await queryNetdisk(session, 'multimedia', {
        method: 'filemetas', fsids: '[' + id + ']', dlink: '1',
      }, controller.signal)
      const file = value.list?.[0]
      if (!file || Number(file.errno ?? 0) !== 0) throw new BaiduError(404, '找不到百度网盘文件。')
      const name = decodeText(file.filename ?? file.server_filename ?? file.path)
      const mime = getAudioType(name)
      const lyrics = isLyrics(name)
      if ((!mime && !lyrics) || Number(file.isdir) === 1) {
        throw new BaiduError(415, '请选择支持的音频或歌词文件。')
      }
      if (lyrics && Number(file.size) > lyricsLimit) {
        throw new BaiduError(413, '百度网盘歌词文件超过 1 MB。')
      }
      const download = authorizedDownload(file, token)
      if (lyrics) return await serveLyrics(download, req, res, controller)
      const upstream = await openDownload(download, { method: req.method, range: req.headers.range }, controller)
      const contentRange = upstream.headers.get('content-range')
      if (upstream.status === 416) {
        await upstream.body?.cancel()
        if (contentRange) res.setHeader('Content-Range', contentRange)
        res.writeHead(416).end()
        return
      }
      const badEncoding = ![null, 'identity'].includes(upstream.headers.get('content-encoding'))
      const errorContent = /^(?:text\/|application\/(?:json|xml))/.test(upstream.headers.get('content-type') ?? '')
      if (![200, 206].includes(upstream.status) || badEncoding || errorContent ||
          (req.method !== 'HEAD' && !upstream.body)) {
        await upstream.body?.cancel()
        throw new BaiduError(502, '百度网盘音频下载失败，请检查文件和下载权限。')
      }
      res.setHeader('Content-Type', mime)
      res.setHeader('Content-Security-Policy', "default-src 'none'")
      for (const header of ['content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header)
        if (value !== null) res.setHeader(header, value)
      }
      res.writeHead(upstream.status)
      if (req.method === 'HEAD') {
        await upstream.body?.cancel()
        res.end()
      } else {
        await pipeline(Readable.fromWeb(upstream.body), res)
      }
    } finally {
      res.off('close', abort)
    }
  }

  return async function baiduHandler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')

    const method = allowedMethods[url.pathname]
    if (!method) {
      sendJson(res, 404, { error: '百度网盘接口不存在。' })
      return true
    }
    if (!method.split(', ').includes(req.method)) {
      res.setHeader('Allow', method)
      sendJson(res, 405, { error: '此接口不支持该请求方法。' })
      return true
    }

    const sessionId = readCookie(req, sessionCookie)
    const session = lookup(sessions, sessionId)
    const action = url.pathname.slice(prefix.length + 1)
    try {
      if (action === 'status') {
        const token = session?.token
        const connected = Boolean(configured && token && (token.expiresAt > Date.now() || token.refreshToken))
        const codeAvailable = configured && loopbackOrigin(req) ? true : undefined
        const canBackup = connected && backup.enabled ? true : undefined
        sendJson(res, 200, { configured, connected, codeAvailable, deviceAvailable: codeAvailable, redirectUri: publicCallback, canBackup })
      } else if (action === 'disconnect') {
        const origin = req.headers.origin
        const localOrigin = sameLocalOrigin(req)
        if ((origin && origin !== callback?.origin && !localOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new BaiduError(403, '请在播放器中断开百度网盘。')
        }
        sessions.delete(sessionId)
        authorizations.delete(readCookie(req, oauthCookie))
        const secureCookie = localOrigin ? localOrigin.startsWith('https://') : secure
        res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0, secureCookie), cookie(oauthCookie, '', 0, secureCookie)])
        persistSessions()
        sendJson(res, 200, { configured, connected: false })
      } else if (!configured) {
        throw new BaiduError(503, '服务器尚未配置百度网盘授权。')
      } else if (action === 'connect') {
        const started = beginAuthorization(req, 'callback')
        redirect(res, started.authorizeUrl, [started.cookie])
      } else if (action === 'code/start') {
        const { authorizeUrl, state, cookie: pendingCookie } = beginAuthorization(req, 'code', localCodeOrigin(req))
        res.setHeader('Set-Cookie', pendingCookie)
        sendJson(res, 200, { authorizeUrl, state })
      } else if (action === 'code/complete') {
        await completeManualCode(req, res, sessionId)
      } else if (action === 'device/start') {
        await startDevice(req, res)
      } else if (action === 'device/poll') {
        await pollDevice(req, res, sessionId)
      } else if (action === 'callback') {
        const key = readCookie(req, oauthCookie)
        const authorization = lookup(authorizations, key)
        if (authorization?.mode !== 'callback' || !stateMatches(url.searchParams.get('state'), authorization.state)) {
          throw new BaiduError(400, '百度网盘授权已过期或回调不匹配，请重新连接。')
        }
        authorizations.delete(key)
        const cookies = [cookie(oauthCookie, '', 0, secure)]
        const code = url.searchParams.get('code')
        const providerError = url.searchParams.get('error')
        let result = 'error'
        if (providerError === 'access_denied') {
          result = 'denied'
        } else if (providerError === 'redirect_uri_mismatch') {
          result = 'redirect-mismatch'
        } else if (!providerError && code && code.length <= 4096) {
          try {
            const token = await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
            cookies.push(establishSession(sessionId, token, secure))
            result = 'connected'
          } catch (error) {
            if (error instanceof BaiduError && error.upstreamCode === 'redirect_uri_mismatch') result = 'redirect-mismatch'
          }
        }
        redirect(res, '/?baidu=' + result, cookies)
      } else if (!session?.token) {
        throw new BaiduError(401, '请先连接百度网盘。')
      } else if (action === 'list') {
        sendJson(res, 200, { items: await list(session, sessionId, url) })
      } else if (action === 'backup') {
        await serveBackup(req, res, session, sessionId, url)
      } else if (action === 'cover') {
        await serveCover(req, res, session, sessionId, url)
      } else {
        await stream(req, res, session, url)
      }
    } catch (error) {
      if (res.destroyed) return true
      if (res.headersSent) {
        res.destroy()
        return true
      }
      const backupFailure = baiduBackupError(error)
      if (backupFailure) {
        sendJson(res, backupFailure.status, { error: backupFailure.message, code: error.code })
      } else if (error instanceof BaiduError || error instanceof BaiduDeviceError) {
        sendJson(res, error.status, { error: error.message, upstreamCode: error.upstreamCode })
      } else {
        sendJson(res, 502, { error: '无法连接百度网盘，请稍后重试。' })
      }
    }
    return true
  }
}
