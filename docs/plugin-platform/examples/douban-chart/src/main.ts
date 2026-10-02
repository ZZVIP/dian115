import { createApp, defineComponent, h, reactive } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import AppPage from './AppPage.vue'

const previewState = reactive<Record<string, unknown>>({
  chart: 'showing',
  subscribed: false,
  updated_at: '',
  catalog: [
    { key: 'showing', label: '正在上映', selected: true },
    { key: 'weekly', label: '一周口碑榜', selected: false },
  ],
  items: [
    { id: 'preview-1', title: '本地预览条目', year: '2026', rating: '7.5', url: 'https://movie.douban.com/' },
  ],
})

const previewBridge = {
  async getState() {
    return { state: previewState, state_version: 'preview-v1', etag: '"preview-v1"' }
  },
  async invokeAction(action: string) {
    previewState.updated_at = '本地预览'
    return { result: { status: 'succeeded' as const, message: `本地预览已执行 ${action}` } }
  },
  async refresh() {
    return previewState
  },
}

// This entry is only for local preview and type checking. The signed package
// loads the exposed Federation module declared in manifest.template.json.
const Preview = defineComponent({
  setup: () => () => h(NConfigProvider, null, {
    default: () => h(NMessageProvider, null, {
      default: () => h(NNotificationProvider, null, {
        default: () => h(NDialogProvider, null, {
          default: () => h(AppPage, {
            api: previewBridge,
            hostApi: previewBridge,
            installationId: 1,
            pluginId: 'example.douban-chart',
            runtime: { health_status: 'healthy', process_state: 'running' },
            runtimeState: previewState,
            navKey: 'main',
            themeContract: 'dian115-theme-v1',
          }),
        }),
      }),
    }),
  }),
})

createApp(Preview).mount('#app')
