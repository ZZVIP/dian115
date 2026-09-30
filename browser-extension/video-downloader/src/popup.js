import {
  ACTIVE_STATUSES,
  STATUS_LABELS,
  formatBytes,
  formatDuration,
  hostOf,
  truncate,
} from './common.js'

const el = (id) => document.getElementById(id)

let runtimeId = ''
let currentTab = null
let lastPreview = null

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || { ok: false })))
}

function toast(text) {
  const node = el('toast')
  node.textContent = text
  node.classList.add('show')
  setTimeout(() => node.classList.remove('show'), 2600)
}

function statusTag(status) {
  const label = STATUS_LABELS[status] || status
  const cls = status === 'completed' ? 'ok' : (status === 'failed' || status === 'cancelled' ? 'fail' : (status === 'paused' || status === 'interrupted' ? 'warn' : ''))
  return `<span class="tag ${cls}">${label}</span>`
}

function renderPending(pending) {
  const card = el('pending-card')
  if (!pending) {
    card.hidden = true
    return
  }
  const preview = pending.preview || {}
  const total = Number(preview.total_items || pending.urls.length || 1)
  const bytes = Number(preview.estimated_bytes || 0)
  const parts = [`本次将加入 ${total} 个任务`]
  if (bytes > 0) parts.push(`预计 ${formatBytes(bytes)}`)
  parts.push(`队列剩余 ${Number(preview.queue_free || 0)} 个名额`)
  if (pending.expiresAt) parts.push(`确认有效期至 ${pending.expiresAt}`)
  el('pending-text').textContent = parts.join('，') + '。'
  card.hidden = false
}

function renderTasks(tracked) {
  const host = el('tasks')
  if (!tracked || !tracked.length) {
    host.innerHTML = '<div class="empty">还没有推送记录。</div>'
    return
  }
  const batches = new Map()
  const loose = []
  for (const item of tracked) {
    if (item.batchId) {
      if (!batches.has(item.batchId)) batches.set(item.batchId, [])
      batches.get(item.batchId).push(item)
    } else {
      loose.push(item)
    }
  }

  const rows = []
  for (const [batchId, items] of batches) {
    const done = items.filter((i) => i.status === 'completed').length
    const failed = items.filter((i) => i.status === 'failed').length
    const percent = items.length ? Math.round(items.reduce((sum, i) => sum + Number(i.progress || 0), 0) / items.length) : 0
    const cls = failed > 0 ? 'fail' : (done === items.length ? 'done' : '')
    rows.push(`
      <div class="task">
        <div class="row between">
          <div class="grow ellipsis small">${escapeHtml(truncate(items[0].title || items[0].url, 60))}</div>
          <span class="tag">批次 ${items.length} 项</span>
        </div>
        <div class="small muted">${done}/${items.length} 已完成${failed ? '，' + failed + ' 个失败' : ''}</div>
        <div class="bar ${cls}"><i style="width:${percent}%"></i></div>
      </div>`)
  }
  for (const item of loose) {
    const progress = Math.max(0, Math.min(100, Number(item.progress || 0)))
    const cls = item.status === 'completed' ? 'done' : (item.status === 'failed' ? 'fail' : '')
    const stalled = item.status === 'downloading' && Number(item.speedBytes || 0) === 0
    rows.push(`
      <div class="task">
        <div class="row between">
          <div class="grow ellipsis small">${escapeHtml(truncate(item.title || item.url, 60))}</div>
          ${statusTag(item.status)}
        </div>
        <div class="small muted">
          ${item.duplicate ? '已存在，未重复创建 · ' : ''}
          ${ACTIVE_STATUSES.includes(item.status) ? progress.toFixed(0) + '%' : ''}
          ${stalled ? ' · 疑似停滞' : ''}
        </div>
        <div class="bar ${cls}"><i style="width:${progress}%"></i></div>
      </div>`)
  }
  host.innerHTML = rows.join('')
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderPreview(preview, probe) {
  const card = el('preview-card')
  if (!preview) {
    card.hidden = true
    return
  }
  lastPreview = { preview, probe }
  el('preview-title').textContent = preview.title || '(未命名)'
  el('preview-probe').textContent = probe === 'list' ? '节目单' : '单个视频'
  const source = [preview.extractor, hostOf(preview.webpage_url || '')].filter(Boolean).join(' · ')
  el('preview-source').textContent = source
  if (preview.thumbnail) {
    const img = el('preview-thumb')
    img.src = preview.thumbnail
    img.hidden = false
  } else {
    el('preview-thumb').hidden = true
  }
  const stats = []
  stats.push(`<div><b>${Number(preview.total_items || 1)}</b>条目</div>`)
  if (Number(preview.estimated_bytes || 0) > 0) stats.push(`<div><b>${formatBytes(preview.estimated_bytes)}</b>预计体积</div>`)
  stats.push(`<div><b>${Number(preview.queue_free || 0)}</b>队列剩余</div>`)
  if (preview.duration) stats.push(`<div><b>${formatDuration(preview.duration)}</b>时长</div>`)
  if (preview.is_live) stats.push('<div><b>直播</b>进行中</div>')
  el('preview-stats').innerHTML = stats.join('')
  const list = el('preview-items')
  if (Array.isArray(preview.items) && preview.items.length) {
    list.innerHTML = preview.items.slice(0, 30).map((item) => `
      <li>
        <span class="idx">${Number(item.index || 0) + 1}</span>
        <span class="grow ellipsis">${escapeHtml(item.title || item.url || '')}</span>
        <span class="muted">${formatDuration(item.duration)}</span>
      </li>`).join('') + (preview.playlist_truncated ? '<li><span class="idx">…</span><span class="grow muted">列表已截断，仅显示前若干项</span></li>' : '')
    list.hidden = false
  } else {
    list.hidden = true
  }
  card.hidden = false
}

async function loadState() {
  const state = await send({ type: 'state' })
  if (!state.ok) return
  runtimeId = state.runtimeId || ''
  el('conn-dot').className = 'dot ' + (state.configured ? 'ok' : 'off')
  renderPending(state.pending)
  renderTasks(state.tracked)
  if (state.settings && state.settings.mode) el('mode').value = state.settings.mode
  if (state.settings && state.settings.baseUrl) {
    const link = el('open-in-server')
    link.href = state.settings.baseUrl
    link.hidden = false
  }
}

async function loadTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  currentTab = tabs && tabs[0] ? tabs[0] : null
  if (currentTab) {
    el('page-title').textContent = currentTab.title || '(无标题)'
    el('page-url').textContent = hostOf(currentTab.url || '') || currentTab.url || ''
  }
}

async function probe(probeName) {
  if (!currentTab || !currentTab.url) return
  el('probe-list').disabled = true
  el('push-page').disabled = true
  try {
    const res = await send({ type: 'preview', url: currentTab.url, probe: probeName })
    if (!res.ok) {
      toast(res.message || '预检失败')
      return
    }
    renderPreview(res.preview, res.probe || probeName)
  } finally {
    el('probe-list').disabled = false
    el('push-page').disabled = false
  }
}

el('push-page').addEventListener('click', async () => {
  if (!currentTab || !currentTab.url) return
  const res = await send({ type: 'push', urls: [currentTab.url], probe: 'quick' })
  if (res && res.pending) toast('需要确认后才会开始下载')
  else if (res && res.ok) toast('已加入下载队列')
  await loadState()
})

el('probe-list').addEventListener('click', () => void probe('list'))

el('preview-push').addEventListener('click', async () => {
  if (!lastPreview || !currentTab) return
  const res = await send({ type: 'push', urls: [currentTab.url], probe: lastPreview.probe })
  if (res && res.pending) toast('需要确认后才会开始下载')
  else if (res && res.ok) toast('已加入下载队列')
  else if (res && res.message) toast(res.message)
  await loadState()
})

el('preview-close').addEventListener('click', () => {
  lastPreview = null
  el('preview-card').hidden = true
})

el('pending-confirm').addEventListener('click', async () => {
  const res = await send({ type: 'confirm' })
  toast(res && res.ok ? '已确认，开始下载' : '确认失败')
  await loadState()
})

el('pending-cancel').addEventListener('click', async () => {
  await send({ type: 'cancel' })
  toast('已取消')
  await loadState()
})

el('refresh').addEventListener('click', async () => {
  await send({ type: 'refresh' })
  await loadState()
})

el('clear').addEventListener('click', async () => {
  await send({ type: 'clearTracked' })
  await loadState()
})

el('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage())

el('copy-id').addEventListener('click', async (event) => {
  event.preventDefault()
  const value = 'chrome-extension://' + runtimeId
  try {
    await navigator.clipboard.writeText(value)
    toast('已复制：' + value)
  } catch {
    toast(value)
  }
})

el('mode').addEventListener('change', async () => {
  await chrome.storage.local.get('settings').then((stored) => {
    const settings = { ...(stored.settings || {}), mode: el('mode').value }
    return chrome.storage.local.set({ settings })
  })
})

void loadTab()
void loadState()
setInterval(() => void loadState(), 5000)
