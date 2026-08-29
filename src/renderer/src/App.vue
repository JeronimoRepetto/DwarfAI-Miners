<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import FeedModal from './components/FeedModal.vue'
import MapView from './components/MapView.vue'
import MineScene from './components/MineScene.vue'
import { useMines } from './composables/useMines'
import { useView } from './composables/useView'
import type { Dwarf, FeedMessage, Mine } from './types'

const { state, setMines } = useMines()
const { state: viewState, openMine, showMap, syncWithMines } = useView()

const loading = ref(true)
const error = ref<string | null>(null)
const activating = ref<string | null>(null)
const feed = ref<FeedMessage[]>([])
const feedFor = ref<string | null>(null)
let unsubscribe: (() => void) | undefined

const currentMine = computed<Mine | undefined>(() => {
  const view = viewState.view
  return view.kind === 'mine' ? state.mines.find((mine) => mine.id === view.mineId) : undefined
})

function hidePanel(): void {
  window.api.hidePanel()
}

function update(mines: Mine[]): void {
  setMines(mines)
  loading.value = false
  syncWithMines(mines.map((mine) => mine.id))
  if (import.meta.env.DEV) {
    console.log(
      '[renderer] mines:',
      mines.map((mine) => `${mine.name} (${mine.tier}, ${mine.dwarfs.length} dwarfs)`).join('; ') ||
        'none'
    )
  }
}

async function load(): Promise<void> {
  try {
    update(await window.api.getMines())
  } catch {
    error.value = 'AgentName could not load active mines. It will keep trying as activity changes.'
    loading.value = false
  }
}

function enterMine(mineId: string): void {
  openMine(mineId)
  error.value = null
}

function backToMap(): void {
  showMap()
  error.value = null
}

function closeFeed(): void {
  feed.value = []
  feedFor.value = null
}

async function activate(dwarf: Dwarf): Promise<void> {
  activating.value = dwarf.id
  error.value = null
  try {
    const result = await window.api.activateDwarf(dwarf.id)
    if (result.focused) {
      hidePanel()
      return
    }
    if (result.feed.length) {
      feed.value = result.feed
      feedFor.value = dwarf.name
    } else {
      error.value = 'The agent terminal is unavailable.'
    }
  } catch {
    error.value = 'The agent terminal could not be opened.'
  } finally {
    activating.value = null
  }
}

onMounted(() => {
  void load()
  unsubscribe = window.api.onMinesUpdated(update)
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div class="panel">
    <header class="titlebar">
      <span class="title"><i aria-hidden="true"></i>AgentName</span>
      <button class="close" type="button" aria-label="Hide panel" @click="hidePanel">
        &times;
      </button>
    </header>
    <main class="content">
      <div v-if="loading" class="loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <p>Scanning the hills for active agents...</p>
      </div>
      <MineScene
        v-else-if="currentMine"
        :mine="currentMine"
        :activating-id="activating"
        @back="backToMap"
        @activate="activate"
      />
      <MapView v-else :mines="state.mines" @open="enterMine" />
      <p v-if="error" class="notice" role="alert">{{ error }}</p>
    </main>
    <FeedModal v-if="feedFor" :title="feedFor" :messages="feed" @close="closeFeed" />
  </div>
</template>

<style scoped>
.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  color: var(--ink);
  background: var(--bg-panel);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
}
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line-soft);
  -webkit-app-region: drag;
}
.title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.04em;
}
.title i {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--lantern);
  transform: rotate(45deg);
  box-shadow: 0 0 10px var(--lantern);
}
.close {
  -webkit-app-region: no-drag;
  padding: 2px 8px;
  border: 0;
  border-radius: 7px;
  color: var(--ink-dim);
  cursor: pointer;
  background: transparent;
  font: inherit;
  font-size: 22px;
}
.close:hover {
  color: #fff;
  background: #4b3c28;
}
.close:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 2px;
}
.content {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
.content > * {
  flex: 1;
}
.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ink-dim);
  font-size: 13px;
}
.loading p {
  margin: 0;
}
.spinner {
  width: 25px;
  height: 25px;
  border: 3px solid #655139;
  border-top-color: #f4c76a;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.notice {
  position: absolute;
  z-index: 90;
  right: 14px;
  bottom: 12px;
  left: 14px;
  flex: none;
  margin: 0;
  padding: 9px 10px;
  border-left: 3px solid var(--danger-line);
  border-radius: 4px;
  color: var(--danger-ink);
  background: var(--danger-bg);
  font-size: 12px;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
