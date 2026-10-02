<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NEmpty, NTag, useMessage } from 'naive-ui'
import { RefreshCw, Star, StarOff } from '@lucide/vue'

interface RuntimeCallback {
  invocation_id?: string
  replayed?: boolean
  result?: {
    status?: 'succeeded' | 'failed' | 'accepted' | 'skipped'
    message?: string
    count?: number
    [key: string]: unknown
  }
}

interface HostBridge {
  getState(view?: string): Promise<{ state?: Record<string, unknown>; state_version?: string; etag?: string }>
  invokeAction(action: string, input?: unknown): Promise<RuntimeCallback>
  refresh(): Promise<Record<string, unknown>>
}

interface ChartEntry {
  key?: string
  label?: string
  selected?: boolean
}

interface ChartItem {
  id?: string
  title?: string
  year?: string
  rating?: string
  url?: string
}

const props = defineProps<{
  api: HostBridge
  hostApi?: HostBridge
  installationId?: number
  pluginId?: string
  runtime?: Record<string, unknown> | null
  runtimeState?: Record<string, unknown>
  navKey?: string
  themeContract?: string
}>()

const message = useMessage()
const busy = ref('')
const state = computed(() => props.runtimeState || {})
const catalog = computed<ChartEntry[]>(() => (Array.isArray(state.value.catalog) ? (state.value.catalog as ChartEntry[]) : []))
const items = computed<ChartItem[]>(() => (Array.isArray(state.value.items) ? (state.value.items as ChartItem[]) : []))
const subscribed = computed(() => state.value.subscribed === true)
const updatedAt = computed(() => String(state.value.updated_at || ''))
const currentLabel = computed(() => catalog.value.find((entry) => entry.selected)?.label || '未选择榜单')

async function run(action: string, input: Record<string, unknown> = {}) {
  busy.value = action
  try {
    const response = await props.api.invokeAction(action, input)
    const result = response.result || {}
    if (result.status === 'failed') throw new Error(String(result.message || '插件动作失败'))
    await props.api.refresh()
    message.success(String(result.message || '操作完成'))
  } catch (error: any) {
    message.error(String(error?.message || '操作失败'))
  } finally {
    busy.value = ''
  }
}

function selectChart(key?: string) {
  if (!key) return
  void run('select', { chart: key })
}

function toggleSubscription() {
  void run(subscribed.value ? 'unsubscribe' : 'subscribe')
}
</script>

<template>
  <div class="douban-chart">
    <header class="douban-chart__header">
      <div>
        <h2>豆瓣最新榜单订阅</h2>
        <p class="douban-chart__hint">
          选一个榜单，订阅后由宿主每小时复查一次；出现新条目时通过宿主通知提醒你。
        </p>
      </div>
      <NTag :type="subscribed ? 'success' : 'default'" size="small" round>
        {{ subscribed ? '已订阅' : '未订阅' }}
      </NTag>
    </header>

    <div class="douban-chart__catalog">
      <NButton
        v-for="entry in catalog"
        :key="entry.key"
        size="small"
        :type="entry.selected ? 'primary' : 'default'"
        :secondary="!entry.selected"
        :disabled="busy !== ''"
        @click="selectChart(entry.key)"
      >
        {{ entry.label }}
      </NButton>
    </div>

    <div class="douban-chart__actions">
      <NButton :loading="busy === 'refresh'" :disabled="busy !== ''" @click="run('refresh')">
        <template #icon><RefreshCw :size="16" /></template>
        立即刷新
      </NButton>
      <NButton
        :type="subscribed ? 'default' : 'primary'"
        :loading="busy === 'subscribe' || busy === 'unsubscribe'"
        :disabled="busy !== ''"
        @click="toggleSubscription"
      >
        <template #icon>
          <StarOff v-if="subscribed" :size="16" />
          <Star v-else :size="16" />
        </template>
        {{ subscribed ? '取消订阅' : '订阅新条目' }}
      </NButton>
    </div>

    <NAlert v-if="updatedAt" type="info" :bordered="false" class="douban-chart__updated">
      当前榜单：{{ currentLabel }} · 最近更新 {{ updatedAt }}
    </NAlert>

    <section v-if="items.length" class="douban-chart__list">
      <article v-for="(item, index) in items" :key="item.id || index" class="douban-chart__item">
        <span class="douban-chart__rank">{{ index + 1 }}</span>
        <div class="douban-chart__meta">
          <a v-if="item.url" :href="item.url" target="_blank" rel="noreferrer noopener">{{ item.title }}</a>
          <span v-else>{{ item.title }}</span>
          <span class="douban-chart__sub">
            {{ item.year || '—' }}
            <template v-if="item.rating"> · 评分 {{ item.rating }}</template>
          </span>
        </div>
      </article>
    </section>
    <NEmpty v-else description="还没有数据，先点“立即刷新”" class="douban-chart__empty" />
  </div>
</template>

<style scoped>
.douban-chart {
  display: flex;
  flex-direction: column;
  gap: var(--dian-space-4, 16px);
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.douban-chart__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--dian-space-3, 12px);
  flex-wrap: wrap;
}

.douban-chart__header h2 {
  margin: 0;
  font-size: 18px;
  color: var(--dian-text-primary);
}

.douban-chart__hint {
  margin: var(--dian-space-1, 4px) 0 0;
  color: var(--dian-text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.douban-chart__catalog,
.douban-chart__actions {
  display: flex;
  gap: var(--dian-space-2, 8px);
  flex-wrap: wrap;
}

.douban-chart__list {
  display: flex;
  flex-direction: column;
  gap: var(--dian-space-2, 8px);
}

.douban-chart__item {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3, 12px);
  padding: var(--dian-space-3, 12px);
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-md, 12px);
  background: var(--dian-surface);
}

.douban-chart__rank {
  min-width: 24px;
  color: var(--dian-text-muted);
  font-family: var(--dian-font-mono, monospace);
}

.douban-chart__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.douban-chart__meta a {
  color: var(--dian-text-primary);
  text-decoration: none;
}

.douban-chart__meta a:hover {
  color: var(--dian-primary);
}

.douban-chart__sub {
  color: var(--dian-text-muted);
  font-size: 12px;
}

.douban-chart__empty {
  padding: var(--dian-space-6, 24px) 0;
}
</style>
