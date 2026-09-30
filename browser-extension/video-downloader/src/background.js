// MV3 service worker: context menus, pre-flight, confirmation, tracking.

import {
  ACTIVE_STATUSES,
  collectSiteCookies,
  DEFAULT_SETTINGS,
  STATUS_LABELS,
  dianFetch,
  extractUrlsFromText,
  formatBytes,
  loadSettings,
  looksLikePlaylistUrl,
  newIdempotencyKey,
  truncate,
} from './common.js'

const POLL_ALARM = 'dian115-poll'
const CONFIRM_NOTIFICATION = 'dian115-confirm'
const STATUS_NOTIFICATION = 'dian115-status'

const MENU_PAGE = 'dian115-push-page'
const MENU_LIST = 'dian115-push-list'
const MENU_LINK = 'dian115-push-link'
const MENU_SELECTION = 'dian115-push-selection'

const MAX_TRACKED = 30

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap()
})

chrome.runtime.onStartup.addListener(() => {
  void bootstrap()
})

async function bootstrap() {
  const stored = await chrome.storage.local.get(['settings', 'tracked', 'pendingPush'])
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } })
  }
  if (!Array.isArray(stored.tracked)) {
    await chrome.storage.local.set({ tracked: [] })
  }
  await buildMenus()
  await schedulePoll()
  await refreshBadge()
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return
  void schedulePoll()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void pollTracked()
})

async function buildMenus() {
  await chrome.contextMenus.removeAll()
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: '推送到 DIAN115 下载',
    contexts: ['page', 'video', 'audio'],
  })
  chrome.contextMenus.create({
    id: MENU_LIST,
    title: '推送当前页面节目单（列表探测）',
    contexts: ['page'],
  })
  chrome.contextMenus.create({
    id: MENU_LINK,
    title: '推送此链接到 DIAN115',
    contexts: ['link'],
  })
  chrome.contextMenus.create({
    id: MENU_SELECTION,
    title: '推送选中的链接到 DIAN115',
    contexts: ['selection'],
  })
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleMenuClick(info, tab)
})

async function handleMenuClick(info, tab) {
  if (info.menuItemId === MENU_LINK && info.linkUrl) {
    await startPush([info.linkUrl], { source: 'link' })
    return
  }
  if (info.menuItemId === MENU_SELECTION) {
    const urls = extractUrlsFromText(info.selectionText)
    if (!urls.length) {
      await notify('没有可推送的链接', '选中的文字里没有找到 http/https 链接。')
      return
    }
    await startPush(urls, { source: 'selection' })
    return
  }
  const pageUrl = info.pageUrl || (tab && tab.url) || ''
  if (!pageUrl) return
  if (info.menuItemId === MENU_LIST) {
    await startPush([pageUrl], { source: 'menu-list', probe: 'list' })
    return
  }
  await startPush([pageUrl], { source: 'menu' })
}

// --------------------------------------------------------------- push flow

async function startPush(rawUrls, options = {}) {
  const urls = (rawUrls || []).map((u) => String(u || '').trim()).filter(Boolean)
  if (!urls.length) return { ok: false, code: 'no_url' }
  const settings = await loadSettings()
  if (!settings.baseUrl || !settings.apiKey) {
    await notify(
      '尚未配置 DIAN115',
      '请先在扩展设置里填写服务器地址和 OpenAPI Key。',
      { openOptions: true },
    )
    return { ok: false, code: 'not_configured' }
  }

  let preview = null
  // 「推送时同时更新站点 CK」默认关闭。开启后先把该站点的 Cookie 同步到服务端，
  // 但这是尽力而为：同步失败不影响推送本身。
  let cookieSync = null
  if (settings.updateCookies && urls.length === 1) {
    cookieSync = await syncSiteCookies(settings, urls[0])
  }
  if (urls.length === 1) {
    const probe = options.probe
      || (settings.autoListProbe && looksLikePlaylistUrl(urls[0]) ? 'list' : 'quick')
    const res = await dianFetch(settings, '/quick', {
      method: 'POST',
      body: {
        url: urls[0],
        probe,
        mode: settings.mode,
        ...(settings.cookieProfileId ? { cookie_profile_id: settings.cookieProfileId } : {}),
      },
      timeoutMs: 180000,
    })
    if (!res.ok) {
      await notify('推送失败：无法预检', res.message || 'DIAN115 返回了错误。')
      return { ok: false, code: res.code }
    }
    preview = res.data && res.data.result ? res.data.result : null
  }

  if (preview && needsLocalConfirmation(settings, preview)) {
    return await openConfirmation({
      urls,
      preview,
      confirmToken: preview.confirm_token || '',
      reason: 'local',
    })
  }

  return await submitBatch(urls, preview, settings, '', cookieSync)
}

function needsLocalConfirmation(settings, preview) {
  const total = Number(preview.total_items || 1)
  if (preview.requires_confirmation) return true
  if (total > Number(settings.localConfirmThreshold || 0)) return true
  const bytes = Number(preview.estimated_bytes || 0)
  if (bytes > 0 && Number(settings.confirmBytes || 0) > 0 && bytes > Number(settings.confirmBytes)) return true
  if (total > Number(preview.queue_free || 0)) return true
  return false
}

async function submitBatch(urls, preview, settings, confirmToken, cookieSync = null) {
  const body = {
    urls,
    mode: settings.mode,
    playlist: false,
    dedupe: true,
  }
  if (settings.quality) body.quality = settings.quality
  if (settings.destinationId) body.destination_id = settings.destinationId
  if (settings.cookieProfileId) body.cookie_profile_id = settings.cookieProfileId
  if (urls.length === 1 && preview && Number(preview.total_items || 0) > 1) {
    body.playlist = true
    body.batch_url = urls[0]
  } else if (urls.length > 1) {
    body.batch_url = urls[0]
  }
  if (confirmToken) body.confirm_token = confirmToken

  const res = await dianFetch(settings, '/tasks', {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
    timeoutMs: 60000,
  })

  if (res.status === 409 && res.code === 'confirmation_required') {
    const info = (res.data && res.data.result) || {}
    return await openConfirmation({
      urls,
      preview: {
        title: (preview && preview.title) || urls[0],
        total_items: Number(info.total_items || 0),
        estimated_bytes: Number(info.estimated_bytes || 0),
        queue_free: Number(info.queue_free || 0),
      },
      confirmToken: info.confirm_token || '',
      expiresAt: info.confirm_expires_at || '',
      reason: 'server',
    })
  }

  if (!res.ok) {
    await notify('推送失败', res.message || 'DIAN115 返回了错误。')
    return { ok: false, code: res.code }
  }

  const result = (res.data && res.data.result) || {}
  await trackTasks(result, urls)
  await chrome.storage.local.remove('pendingPush')
  const accepted = Number(result.accepted || 0)
  const duplicates = Number(result.duplicates || 0)
  if (settings.notifyOnQueued) {
    const parts = [`已加入 ${accepted} 个任务`]
    if (duplicates > 0) parts.push(`其中 ${duplicates} 个已存在，未重复创建`)
    if (Number(result.rejected || 0) > 0) parts.push(`${result.rejected} 个被拒绝`)
    if (cookieSync && cookieSync.ok) parts.push(`已同步站点 CK ${cookieSync.count} 条`)
    if (cookieSync && cookieSync.ok === false) parts.push('站点 CK 同步失败：' + (cookieSync.message || '未知错误'))
    await notify('已推送到 DIAN115', parts.join('，'))
  }
  await refreshBadge()
  return { ok: true, accepted, duplicates }
}

/**
 * 把当前站点 Cookie 同步到 DIAN115（仅在设置里开启时调用）。
 * 任何失败都只记录，不影响推送流程。
 */
async function syncSiteCookies(settings, pageUrl) {
  try {
    const { host, cookies } = await collectSiteCookies(pageUrl)
    if (!host || !cookies.length) return null
    const res = await dianFetch(settings, '/cookies', {
      method: 'POST',
      body: { host, cookies, name: host + '（浏览器同步）' },
      idempotencyKey: newIdempotencyKey(),
      timeoutMs: 30000,
    })
    if (!res.ok) return { ok: false, message: res.message || res.code || '同步失败' }
    return { ok: true, host, count: cookies.length }
  } catch (error) {
    return { ok: false, message: (error && error.message) || '同步失败' }
  }
}

async function openConfirmation(pending) {
  const record = {
    id: 'pending-' + Date.now(),
    urls: pending.urls,
    preview: pending.preview || {},
    confirmToken: pending.confirmToken || '',
    expiresAt: pending.expiresAt || '',
    reason: pending.reason || '',
    createdAt: Date.now(),
  }
  await chrome.storage.local.set({ pendingPush: record })
  const total = Number(record.preview.total_items || record.urls.length || 1)
  const bytes = Number(record.preview.estimated_bytes || 0)
  const message = [
    `本次将加入 ${total} 个任务`,
    bytes > 0 ? `预计 ${formatBytes(bytes)}` : '',
    `队列剩余 ${Number(record.preview.queue_free || 0)} 个名额`,
  ].filter(Boolean).join('，') + '。确认后开始下载。'
  try {
    await chrome.notifications.create(CONFIRM_NOTIFICATION, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'DIAN115 需要确认',
      message: truncate(message, 220),
      buttons: [{ title: '确认加入' }, { title: '取消' }],
      requireInteraction: true,
    })
  } catch {
    // Notifications are best effort; the popup still shows the confirmation.
  }
  return { ok: true, pending: true, total }
}

async function resolvePending(approve) {
  const stored = await chrome.storage.local.get('pendingPush')
  const pending = stored.pendingPush
  if (!pending) return { ok: false, code: 'no_pending' }
  await chrome.notifications.clear(CONFIRM_NOTIFICATION).catch(() => {})
  if (!approve) {
    await chrome.storage.local.remove('pendingPush')
    return { ok: true, cancelled: true }
  }
  const settings = await loadSettings()
  return await submitBatch(pending.urls, pending.preview, settings, pending.confirmToken)
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId !== CONFIRM_NOTIFICATION) return
  void resolvePending(buttonIndex === 0)
})

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === CONFIRM_NOTIFICATION) {
    void chrome.runtime.openOptionsPage().catch(() => {})
  }
})

// -------------------------------------------------------------- task stats

async function getTracked() {
  const stored = await chrome.storage.local.get('tracked')
  return Array.isArray(stored.tracked) ? stored.tracked : []
}

async function trackTasks(result, urls) {
  const tracked = await getTracked()
  const byId = new Map(tracked.map((item) => [String(item.id), item]))
  const batchId = result.batch_id || ''
  for (const task of result.tasks || []) {
    if (!task || task.id === undefined || task.id === null) continue
    const key = String(task.id)
    const existing = byId.get(key)
    if (existing) {
      existing.batchId = existing.batchId || task.batch_id || batchId
      continue
    }
    byId.set(key, {
      id: task.id,
      url: task.url || urls[0],
      title: task.title || task.url || urls[0],
      status: task.status || 'queued',
      progress: Number(task.progress || 0),
      duplicate: !!task.duplicate,
      batchId: task.batch_id || batchId,
      createdAt: Date.now(),
      notifiedTerminal: false,
      misses: 0,
    })
  }
  const merged = Array.from(byId.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_TRACKED)
  await chrome.storage.local.set({ tracked: merged })
}

async function pollTracked() {
  const settings = await loadSettings()
  if (!settings.baseUrl || !settings.apiKey) return
  const tracked = await getTracked()
  if (!tracked.length) return

  let changed = false
  const finished = []
  const active = tracked.filter((item) => ACTIVE_STATUSES.includes(item.status))
  for (const item of active) {
    const res = await dianFetch(settings, '/tasks/' + encodeURIComponent(String(item.id)), { timeoutMs: 20000 })
    if (!res.ok) {
      if (res.status === 404) {
        item.misses = (item.misses || 0) + 1
        changed = true
      }
      continue
    }
    const task = (res.data && res.data.task) || null
    if (!task) continue
    const nextStatus = task.status || item.status
    if (nextStatus !== item.status) {
      item.status = nextStatus
      changed = true
      if (nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'cancelled' || nextStatus === 'interrupted') {
        finished.push(item)
      }
    }
    const nextProgress = Number(task.progress || 0)
    if (Math.abs(nextProgress - Number(item.progress || 0)) > 0.01) {
      item.progress = nextProgress
      changed = true
    }
    if (task.title && task.title !== item.title) {
      item.title = task.title
      changed = true
    }
    if (task.speed_bytes !== undefined) item.speedBytes = Number(task.speed_bytes || 0)
  }

  if (changed) await chrome.storage.local.set({ tracked })

  for (const item of finished) {
    if (item.notifiedTerminal) continue
    item.notifiedTerminal = true
    if (item.status === 'completed' && settings.notifyOnComplete) {
      await notify('视频下载完成', truncate(item.title || item.url, 180))
    } else if (item.status === 'failed' && settings.notifyOnFailed) {
      await notify('视频下载失败', truncate(item.title || item.url, 180))
    }
  }
  if (finished.length) await chrome.storage.local.set({ tracked })
  await refreshBadge()
}

async function refreshBadge() {
  const tracked = await getTracked()
  const active = tracked.filter((item) => ACTIVE_STATUSES.includes(item.status)).length
  await chrome.action.setBadgeBackgroundColor({ color: active > 0 ? '#2f7cf6' : '#6b7280' }).catch(() => {})
  await chrome.action.setBadgeText({ text: active > 0 ? String(active) : '' }).catch(() => {})
}

async function schedulePoll() {
  const settings = await loadSettings()
  const seconds = Math.max(30, Number(settings.pollSeconds) || 20)
  await chrome.alarms.clear(POLL_ALARM)
  chrome.alarms.create(POLL_ALARM, {
    periodInMinutes: Math.max(0.5, seconds / 60),
    delayInMinutes: Math.max(0.5, seconds / 60),
  })
}

// ------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    const type = message && message.type
    if (type === 'state') {
      const settings = await loadSettings()
      const stored = await chrome.storage.local.get(['tracked', 'pendingPush'])
      sendResponse({
        ok: true,
        runtimeId: chrome.runtime.id,
        settings: { ...settings, apiKey: settings.apiKey ? maskKey(settings.apiKey) : '' },
        configured: !!(settings.baseUrl && settings.apiKey),
        tracked: Array.isArray(stored.tracked) ? stored.tracked : [],
        pending: stored.pendingPush || null,
      })
      return
    }
    if (type === 'preview') {
      const settings = await loadSettings()
      const url = String((message && message.url) || '').trim()
      if (!url) {
        sendResponse({ ok: false, code: 'no_url' })
        return
      }
      const probe = (message && message.probe) || (settings.autoListProbe && looksLikePlaylistUrl(url) ? 'list' : 'quick')
      const res = await dianFetch(settings, '/quick', {
        method: 'POST',
        body: { url, probe, mode: settings.mode, ...(settings.cookieProfileId ? { cookie_profile_id: settings.cookieProfileId } : {}) },
        timeoutMs: 180000,
      })
      sendResponse({ ok: res.ok, code: res.code, message: res.message, preview: res.data && res.data.result ? res.data.result : null, probe })
      return
    }
    if (type === 'push') {
      const result = await startPush((message && message.urls) || [], { probe: message && message.probe, source: 'popup' })
      sendResponse(result || { ok: true })
      return
    }
    if (type === 'confirm') {
      sendResponse(await resolvePending(true))
      return
    }
    if (type === 'cancel') {
      sendResponse(await resolvePending(false))
      return
    }
    if (type === 'refresh') {
      await pollTracked()
      sendResponse({ ok: true })
      return
    }
    if (type === 'clearTracked') {
      await chrome.storage.local.set({ tracked: [] })
      await refreshBadge()
      sendResponse({ ok: true })
      return
    }
    sendResponse({ ok: false, code: 'unknown_message' })
  })()
  return true
})

function maskKey(key) {
  const value = String(key)
  if (value.length <= 8) return '****'
  return value.slice(0, 4) + '****' + value.slice(-4)
}

// ------------------------------------------------------------ notifications

async function notify(title, message, options = {}) {
  try {
    await chrome.notifications.create(STATUS_NOTIFICATION + '-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: truncate(title, 80),
      message: truncate(message, 220),
      priority: 0,
    })
  } catch {
    // Ignore: the popup still reports the same information.
  }
  if (options.openOptions) {
    await chrome.runtime.openOptionsPage().catch(() => {})
  }
}

export const __statusLabels = STATUS_LABELS
