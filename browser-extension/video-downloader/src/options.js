import { DEFAULT_SETTINGS, dianFetch, loadSettings, normalizeBaseUrl, saveSettings } from './common.js'

const el = (id) => document.getElementById(id)
const GB = 1024 * 1024 * 1024

function showResult(text, kind) {
  const node = el('test-result')
  node.hidden = false
  node.textContent = text
  node.style.borderColor = kind === 'ok' ? 'var(--ok)' : 'var(--danger)'
  node.style.color = kind === 'ok' ? 'var(--ok)' : 'var(--danger)'
}

function readForm() {
  const confirmGb = Number(el('confirmGb').value || 0)
  return {
    baseUrl: normalizeBaseUrl(el('baseUrl').value),
    apiKey: el('apiKey').value.trim(),
    mode: el('mode').value,
    quality: el('quality').value.trim(),
    destinationId: el('destinationId').value.trim(),
    cookieProfileId: el('cookieProfileId').value.trim(),
    updateCookies: el('updateCookies').checked,
    autoListProbe: el('autoListProbe').checked,
    localConfirmThreshold: Math.max(1, Math.min(100, Number(el('localConfirmThreshold').value || DEFAULT_SETTINGS.localConfirmThreshold))),
    confirmBytes: Math.max(0, confirmGb) * GB,
    pollSeconds: Math.max(30, Math.min(3600, Number(el('pollSeconds').value || DEFAULT_SETTINGS.pollSeconds))),
    notifyOnQueued: el('notifyOnQueued').checked,
    notifyOnComplete: el('notifyOnComplete').checked,
    notifyOnFailed: el('notifyOnFailed').checked,
  }
}

function fillForm(settings) {
  el('baseUrl').value = settings.baseUrl || ''
  el('apiKey').value = settings.apiKey || ''
  el('mode').value = settings.mode || 'video'
  el('quality').value = settings.quality || ''
  el('destinationId').value = settings.destinationId || ''
  el('cookieProfileId').value = settings.cookieProfileId || ''
  el('updateCookies').checked = settings.updateCookies === true
  el('autoListProbe').checked = settings.autoListProbe !== false
  el('localConfirmThreshold').value = settings.localConfirmThreshold || DEFAULT_SETTINGS.localConfirmThreshold
  el('confirmGb').value = Math.round((Number(settings.confirmBytes || 0) / GB) * 10) / 10
  el('pollSeconds').value = settings.pollSeconds || DEFAULT_SETTINGS.pollSeconds
  el('notifyOnQueued').checked = settings.notifyOnQueued !== false
  el('notifyOnComplete').checked = settings.notifyOnComplete !== false
  el('notifyOnFailed').checked = settings.notifyOnFailed !== false
}

async function testConnection() {
  const draft = readForm()
  if (!draft.baseUrl) {
    showResult('请先填写一个 http(s) 服务器地址。', 'bad')
    return
  }
  if (!draft.apiKey) {
    showResult('请先填写 OpenAPI Key。', 'bad')
    return
  }
  // Querying a task that cannot exist proves key + origin + external API are
  // all accepted: a missing task answers 404 task_not_found, while a rejected
  // request answers 401/403 with a specific code.
  const res = await dianFetch(draft, '/tasks/0', { timeoutMs: 20000 })
  if (res.status === 404 || res.ok) {
    showResult('连接成功：鉴权与来源校验都已通过。', 'ok')
    return
  }
  if (res.status === 401) {
    showResult('鉴权失败：OpenAPI Key 不正确，请核对系统设置里的 openapi key。', 'bad')
    return
  }
  if (res.status === 403) {
    if (res.code === 'external_api_disabled') {
      showResult('服务器未启用外部 API，请到“视频下载器 → 外部 API”打开开关。', 'bad')
    } else if (res.code === 'origin_not_allowed' || res.code === 'origin_required') {
      showResult('来源未放行：把上面的 chrome-extension:// 来源加入“允许来源”。', 'bad')
    } else {
      showResult(res.message || '服务器拒绝了这次请求。', 'bad')
    }
    return
  }
  showResult(res.message || ('连接失败（HTTP ' + res.status + '）'), 'bad')
}

el('save').addEventListener('click', async () => {
  const draft = readForm()
  if (!draft.baseUrl) {
    showResult('服务器地址必须以 http:// 或 https:// 开头。', 'bad')
    return
  }
  await saveSettings(draft)
  showResult('已保存。', 'ok')
})

el('test').addEventListener('click', () => {
  void testConnection()
})

el('copy-origin').addEventListener('click', async () => {
  const value = 'chrome-extension://' + chrome.runtime.id
  try {
    await navigator.clipboard.writeText(value)
    showResult('已复制：' + value, 'ok')
  } catch {
    showResult(value, 'ok')
  }
})

el('origin').textContent = 'chrome-extension://' + chrome.runtime.id

void loadSettings().then(fillForm)
