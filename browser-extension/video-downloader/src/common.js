// Shared helpers for the DIAN115 video push extension.
//
// Everything here is dependency free so it can be imported from the MV3
// service worker and from both extension pages.

export const API_PREFIX = '/api/openapi/v1/video-downloads'

export const ACTIVE_STATUSES = ['queued', 'resolving', 'downloading', 'postprocessing', 'paused']

export const STATUS_LABELS = {
  queued: '排队中',
  resolving: '解析中',
  downloading: '下载中',
  postprocessing: '处理中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

export const DEFAULT_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  mode: 'video',
  quality: '',
  destinationId: '',
  cookieProfileId: '',
  autoListProbe: true,
  localConfirmThreshold: 5,
  confirmBytes: 20 * 1024 * 1024 * 1024,
  pollSeconds: 20,
  notifyOnComplete: true,
  notifyOnFailed: true,
  notifyOnQueued: true,
  // 推送时同时把当前站点 Cookie 同步到 DIAN115（默认关闭，需用户显式开启）。
  updateCookies: false,
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get('settings')
  return { ...DEFAULT_SETTINGS, ...(stored && stored.settings ? stored.settings : {}) }
}

export async function saveSettings(patch) {
  const current = await loadSettings()
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ settings: next })
  return next
}

// Drop trailing slashes so `${base}${path}` is always well formed.
export function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '')
  if (!value) return ''
  if (!/^https?:\/\//i.test(value)) return ''
  return value
}

// buildApiUrl joins the configured server with one OpenAPI path.
export function buildApiUrl(settings, path) {
  const base = normalizeBaseUrl(settings.baseUrl)
  if (!base) return ''
  return base + API_PREFIX + path
}

export function newIdempotencyKey() {
  const uuid = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
  // The server requires 16-128 printable ASCII characters.
  return ('dian115-ext-' + uuid).slice(0, 120)
}

/**
 * dianFetch performs one OpenAPI call. It never throws for an HTTP error
 * status: callers inspect `ok`, `status` and the parsed `code` instead.
 */
export async function dianFetch(settings, path, options = {}) {
  const url = buildApiUrl(settings, path)
  if (!url) {
    return { ok: false, status: 0, code: 'not_configured', message: '尚未配置 DIAN115 服务器地址', data: null }
  }
  if (!settings.apiKey) {
    return { ok: false, status: 0, code: 'not_configured', message: '尚未配置 OpenAPI Key', data: null }
  }
  const method = options.method || 'GET'
  const headers = {
    'X-OpenAPI-Key': settings.apiKey,
    Accept: 'application/json',
  }
  if (options.body !== undefined && options.body !== null) {
    headers['Content-Type'] = 'application/json'
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey
  }
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs === 0 ? 0 : (options.timeoutMs || 120000)
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined || options.body === null ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    })
    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { raw: text.slice(0, 500) }
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      code: data && data.code ? data.code : '',
      message: data && data.message ? data.message : '',
      data,
    }
  } catch (error) {
    const aborted = error && error.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      code: aborted ? 'timeout' : 'network_error',
      message: aborted ? '请求超时，视频站点响应太慢' : '无法连接 DIAN115 服务器：' + (error && error.message ? error.message : '未知网络错误'),
      data: null,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function formatBytes(value) {
  const n = Number(value || 0)
  if (!n || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = n
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const digits = size >= 100 || unit === 0 ? 0 : 1
  return size.toFixed(digits) + ' ' + units[unit]
}

export function formatDuration(seconds) {
  const total = Math.round(Number(seconds || 0))
  if (!total || total < 0) return ''
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

const PLAYLIST_HINTS = [
  'list=', '/playlist', '/playlists', '/channel/', '/channels/', '/space/',
  '/album/', '/series', '/season', '/collection', '/mix', '/sets/', '/show/',
  '/bangumi/', '/media/', 'space.bilibili.com', 'medialist',
]

export function looksLikePlaylistUrl(raw) {
  const lower = String(raw || '').toLowerCase()
  if (!lower) return false
  return PLAYLIST_HINTS.some((hint) => lower.includes(hint))
}

export function hostOf(raw) {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

// extractUrlsFromText pulls http(s) links out of a text selection so a user can
// select a block of links on a page and push them in one go.
export function extractUrlsFromText(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"'）)】\]]+/gi)
  if (!found) return []
  const seen = new Set()
  const urls = []
  for (const raw of found) {
    const cleaned = raw.replace(/[.,;:]+$/, '')
    if (!seen.has(cleaned)) {
      seen.add(cleaned)
      urls.push(cleaned)
    }
  }
  return urls.slice(0, 100)
}

export function truncate(text, max) {
  const value = String(text || '')
  if (value.length <= max) return value
  return value.slice(0, Math.max(1, max - 1)) + '…'
}

/**
 * 读取某个页面所属站点的 Cookie。
 * 只有在用户开启「推送时同时更新 CK」后才会被调用；返回值直接对应服务端
 * /cookies 接口的 cookies 字段。需要 manifest 里的 "cookies" 权限。
 */
export async function collectSiteCookies(pageUrl) {
  const host = hostOf(pageUrl)
  if (!host) return { host: '', cookies: [] }
  const list = await chrome.cookies.getAll({ url: pageUrl })
  const cookies = (list || [])
    .filter((item) => item && item.name)
    .map((item) => ({
      name: String(item.name),
      value: String(item.value ?? ''),
      domain: String(item.domain || host),
      path: String(item.path || '/'),
      expires: Number(item.expirationDate || 0),
      secure: item.secure === true,
      httpOnly: item.httpOnly === true,
    }))
  return { host, cookies }
}
