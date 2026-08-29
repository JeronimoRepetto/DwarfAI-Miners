<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { truncate } from '../../shared/truncate'
import { useMines } from './composables/useMines'
import type { Dwarf, FeedMessage, Mine, MineTier } from './types'

const { state, setMines } = useMines()
const selectedId = ref<string | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const feed = ref<FeedMessage[]>([])
const activating = ref<string | null>(null)
let unsubscribe: (() => void) | undefined
const mine = computed(() => state.mines.find((item) => item.id === selectedId.value))

function hidePanel(): void {
  window.api.hidePanel()
}
function select(item: Mine): void {
  selectedId.value = item.id
  feed.value = []
  error.value = null
}
function back(): void {
  selectedId.value = null
  feed.value = []
  error.value = null
}
function update(mines: Mine[]): void {
  setMines(mines)
  loading.value = false
  if (selectedId.value && !mines.some((item) => item.id === selectedId.value)) back()
}
async function load(): Promise<void> {
  try {
    update(await window.api.getMines())
  } catch {
    error.value = 'AgentName could not load active mines. It will keep trying as activity changes.'
    loading.value = false
  }
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
    feed.value = result.feed
    if (!result.feed.length) error.value = 'The agent terminal is unavailable.'
  } catch {
    feed.value = []
    error.value = 'The agent terminal could not be opened.'
  } finally {
    activating.value = null
  }
}
function label(tier: MineTier): string {
  return tier.slice(0, 1).toUpperCase() + tier.slice(1)
}
function info(dwarf: Dwarf): string {
  return [
    dwarf.role === 'foreman' ? 'Foreman' : 'Worker',
    dwarf.provider,
    dwarf.model ?? 'Model unknown',
    dwarf.effort ?? 'Effort unknown'
  ].join(' / ')
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
      <span class="title"><i aria-hidden="true"></i>AgentName</span
      ><button class="close" type="button" aria-label="Hide panel" @click="hidePanel">
        &times;
      </button>
    </header>
    <main class="content">
      <section v-if="mine" class="scene" :data-tier="mine.tier" aria-labelledby="scene-title">
        <div class="toolbar">
          <button type="button" class="back" aria-label="Back to mines" @click="back">
            &larr; Mines</button
          ><span class="badge">{{ label(mine.tier) }} mine</span>
        </div>
        <header class="scene-head">
          <span class="entrance" aria-hidden="true"></span>
          <div>
            <h1 id="scene-title">{{ mine.name }}</h1>
            <p>{{ mine.path }}</p>
          </div>
        </header>
        <p v-if="error" class="notice" role="status">{{ error }}</p>
        <div v-if="mine.dwarfs.length === 0" class="empty scene-empty">
          <span aria-hidden="true">&#x1F56F;</span>
          <p>This mine is open, but no agents are working right now.</p>
        </div>
        <div v-else class="cavern" aria-label="Agents in this mine">
          <div v-for="dwarf in mine.dwarfs" :key="dwarf.id" class="dwarf-slot">
            <button
              class="dwarf-button"
              :class="[
                dwarf.status,
                { foreman: dwarf.role === 'foreman', activating: activating === dwarf.id }
              ]"
              type="button"
              :aria-label="'Open ' + dwarf.name + ': ' + info(dwarf)"
              :aria-describedby="'details-' + dwarf.id"
              @click="activate(dwarf)"
            >
              <b v-if="dwarf.role === 'foreman'" class="folder" aria-label="Foreman">&#x1F4C1;</b
              ><span class="dwarf" aria-hidden="true"
                ><span class="helmet"></span><span class="face"><i></i><i></i></span
                ><span class="beard"></span><span class="pick">&#x26CF;</span></span
              ><span class="dwarf-name">{{ dwarf.name }}</span>
            </button>
            <span :id="'details-' + dwarf.id" class="tooltip" role="tooltip">{{
              info(dwarf)
            }}</span>
            <p v-if="dwarf.lastMessage" class="bubble">{{ truncate(dwarf.lastMessage, 88) }}</p>
          </div>
        </div>
        <section v-if="feed.length" class="feed" aria-live="polite" aria-label="Agent activity">
          <h2>Latest activity</h2>
          <p v-for="(message, index) in feed.slice(-3)" :key="message.timestamp + index">
            <strong>{{ message.role === 'assistant' ? 'Agent' : 'Request' }}:</strong>
            {{ truncate(message.text, 180) }}
          </p>
        </section>
      </section>
      <section v-else class="list" aria-labelledby="mines-title">
        <header class="list-head">
          <div>
            <p>LIVE WORKSPACES</p>
            <h1 id="mines-title">Active mines</h1>
          </div>
          <b v-if="!loading">{{ state.mines.length }}</b>
        </header>
        <div v-if="loading" class="empty" role="status">
          <span class="spinner" aria-hidden="true"></span>
          <p>Looking for active agents...</p>
        </div>
        <div v-else-if="error" class="empty error" role="alert">
          <b>!</b>
          <p>{{ error }}</p>
        </div>
        <div v-else-if="state.mines.length === 0" class="empty">
          <span class="mine-icon" aria-hidden="true">&#x26CF;</span>
          <h2>No active mines</h2>
          <p>AI coding agents running on this PC will show up here as dwarfs at work.</p>
        </div>
        <div v-else class="mines">
          <button
            v-for="item in state.mines"
            :key="item.id"
            class="mine-card"
            :data-tier="item.tier"
            type="button"
            @click="select(item)"
          >
            <span class="crystal" aria-hidden="true">&#9670;</span
            ><span
              ><em>{{ label(item.tier) }}</em
              ><strong>{{ item.name }}</strong
              ><small
                >{{ item.dwarfs.length }} {{ item.dwarfs.length === 1 ? 'agent' : 'agents' }}</small
              ></span
            ><b aria-hidden="true">&rarr;</b>
          </button>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.panel {
  --accent: #b87936;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #f4ead8;
  background: radial-gradient(circle at 25% 0, #403120, #17120d 63%);
  border: 1px solid #665239;
  border-radius: 14px;
}
.titlebar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid #413321;
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
  background: #f6b644;
  transform: rotate(45deg);
  box-shadow: 0 0 10px #f6b644;
}
button {
  font: inherit;
}
.close,
.back {
  -webkit-app-region: no-drag;
  border: 0;
  border-radius: 7px;
  color: #d7c5aa;
  cursor: pointer;
  background: transparent;
}
.close {
  padding: 2px 8px;
  font-size: 22px;
}
.close:hover,
.back:hover {
  color: #fff;
  background: #4b3c28;
}
.close:focus-visible,
.back:focus-visible,
.mine-card:focus-visible,
.dwarf-button:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 3px;
}
.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.list,
.scene {
  min-height: 100%;
  padding: 18px;
}
.list-head,
.toolbar,
.scene-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.list-head p {
  margin: 0;
  color: #a99a7f;
  font-size: 11px;
  letter-spacing: 0.1em;
}
.list h1,
.scene h1 {
  margin: 2px 0 0;
  font-size: 22px;
}
.list-head > b {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid #69543a;
  border-radius: 50%;
  color: #e6c68d;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  max-width: 320px;
  margin: auto;
  color: #b9aa91;
  font-size: 13px;
  line-height: 1.55;
  text-align: center;
}
.empty p {
  margin: 5px 0;
}
.empty h2 {
  margin: 5px 0;
  color: #f4ead8;
  font-size: 16px;
}
.mine-icon {
  color: #e8b65c;
  font-size: 40px;
}
.spinner {
  width: 25px;
  height: 25px;
  border: 3px solid #655139;
  border-top-color: #f4c76a;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.error {
  color: #f0bfad;
}
.error > b {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  border-radius: 50%;
  color: white;
  background: #8f4234;
}
.mines {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
  margin-top: 18px;
}
.mine-card {
  --accent: #b87936;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 112px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 48%, #3c3021);
  border-radius: 12px;
  color: #f5ead6;
  text-align: left;
  cursor: pointer;
  background: linear-gradient(130deg, color-mix(in srgb, var(--accent) 16%, #271e15), #201912 70%);
  transition:
    transform 0.16s,
    border-color 0.16s;
}
.mine-card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
}
.mine-card[data-tier='copper'],
.scene[data-tier='copper'] {
  --accent: #c86e36;
}
.mine-card[data-tier='silver'],
.scene[data-tier='silver'] {
  --accent: #b7c7d1;
}
.mine-card[data-tier='gold'],
.scene[data-tier='gold'] {
  --accent: #e6b541;
}
.mine-card[data-tier='uranium'],
.scene[data-tier='uranium'] {
  --accent: #7cd68a;
}
.crystal {
  color: var(--accent);
  font-size: 40px;
  text-shadow: 0 0 17px var(--accent);
}
.mine-card > span:nth-child(2) {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.mine-card em,
.badge {
  color: var(--accent);
  font-size: 10px;
  font-style: normal;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.mine-card strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mine-card small {
  color: #b6a58b;
}
.mine-card > b {
  color: var(--accent);
  font-size: 22px;
}
.toolbar {
  margin-bottom: 16px;
}
.back {
  padding: 6px 8px;
  font-size: 13px;
}
.scene-head {
  justify-content: flex-start;
  margin-bottom: 16px;
}
.scene-head p {
  max-width: 300px;
  margin: 4px 0 0;
  overflow: hidden;
  color: #a99a7f;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entrance {
  width: 58px;
  height: 48px;
  border: 2px solid var(--accent);
  border-bottom: 0;
  border-radius: 30px 30px 0 0;
  box-shadow:
    inset 0 0 12px var(--accent),
    0 0 14px #000;
}
.notice {
  padding: 9px 10px;
  border-left: 3px solid #d78361;
  border-radius: 4px;
  color: #f1c9b9;
  background: #472c25;
  font-size: 12px;
}
.scene-empty {
  min-height: 250px;
}
.cavern {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 12px 20px;
  min-height: 230px;
  padding: 34px 12px 16px;
  border: 1px solid #4d3c28;
  border-radius: 14px;
  background: linear-gradient(#271d13 0 68%, #382516 69%, #24170d 100%);
  box-shadow: inset 0 0 45px #0008;
}
.dwarf-slot {
  position: relative;
  width: 84px;
  min-height: 140px;
}
.dwarf-button {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  border: 0;
  color: #f5ead6;
  cursor: pointer;
  background: transparent;
}
.dwarf {
  position: relative;
  display: block;
  width: 51px;
  height: 78px;
  animation: bob 2.4s ease-in-out infinite;
}
.helmet {
  position: absolute;
  z-index: 3;
  top: 2px;
  left: 5px;
  width: 41px;
  height: 23px;
  border: 3px solid #3e392d;
  border-bottom: 0;
  border-radius: 24px 24px 5px 5px;
  background: linear-gradient(#e0b64e, #8d6426);
}
.helmet::after {
  position: absolute;
  top: 6px;
  left: 17px;
  width: 4px;
  height: 18px;
  content: '';
  background: #f5dc79;
  box-shadow: 0 0 6px #f7dc73;
}
.face {
  position: absolute;
  z-index: 2;
  top: 19px;
  left: 12px;
  width: 28px;
  height: 27px;
  border-radius: 9px 9px 13px 13px;
  background: #e1aa80;
}
.face i {
  position: absolute;
  top: 10px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #2a1c14;
}
.face i:first-child {
  left: 6px;
}
.face i:last-child {
  right: 6px;
}
.beard {
  position: absolute;
  z-index: 1;
  top: 37px;
  left: 5px;
  width: 42px;
  height: 34px;
  border-radius: 8px 8px 20px 20px;
  background: repeating-linear-gradient(90deg, #c9c0ae 0 5px, #a69b88 5px 8px);
}
.pick {
  position: absolute;
  z-index: 4;
  top: 30px;
  right: -12px;
  color: #d9c5a0;
  font-size: 27px;
  transform: rotate(-28deg);
}
.working .dwarf {
  animation: dig 1.1s ease-in-out infinite;
}
.working .pick {
  animation: pick 1.1s ease-in-out infinite;
}
.activating .dwarf {
  opacity: 0.55;
}
.foreman .helmet {
  background: linear-gradient(#78a1bd, #365873);
}
.folder {
  position: absolute;
  z-index: 5;
  top: 18px;
  left: 2px;
  font-size: 14px;
}
.dwarf-name {
  max-width: 82px;
  margin-top: 4px;
  overflow: hidden;
  color: #e9d8ba;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tooltip {
  position: absolute;
  z-index: 10;
  bottom: 100%;
  left: 50%;
  width: max-content;
  max-width: 180px;
  padding: 6px 8px;
  border: 1px solid #766044;
  border-radius: 6px;
  color: #f5ead6;
  background: #15100b;
  font-size: 10px;
  text-align: center;
  transform: translate(-50%, -7px);
  opacity: 0;
  pointer-events: none;
}
.dwarf-slot:first-child .tooltip {
  left: 0;
  transform: translate(0, -7px);
}
.dwarf-slot:last-child:not(:first-child) .tooltip {
  right: 0;
  left: auto;
  transform: translate(0, -7px);
}
.dwarf-button:hover + .tooltip,
.dwarf-button:focus-visible + .tooltip {
  opacity: 1;
}
.bubble {
  position: absolute;
  z-index: 3;
  bottom: 100%;
  left: 47px;
  width: 125px;
  margin: 0 0 15px;
  padding: 7px 8px;
  border: 1px solid #ad9772;
  border-radius: 9px;
  color: #312416;
  background: #f6ead3;
  font-size: 10px;
  line-height: 1.3;
}
.bubble::after {
  position: absolute;
  bottom: -6px;
  left: 14px;
  content: '';
  border: 6px solid transparent;
  border-top-color: #f6ead3;
  border-bottom: 0;
}
.feed {
  margin-top: 14px;
  padding: 11px;
  border: 1px solid #5a4731;
  border-radius: 9px;
  background: #1a130d;
}
.feed h2 {
  margin: 0 0 7px;
  color: #d6bd90;
  font-size: 12px;
}
.feed p {
  margin: 5px 0;
  color: #cdbda5;
  font-size: 11px;
  line-height: 1.4;
}
.feed strong {
  color: #e6bb5d;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes bob {
  50% {
    transform: translateY(-3px);
  }
}
@keyframes dig {
  50% {
    transform: translateY(2px) rotate(2deg);
  }
}
@keyframes pick {
  50% {
    transform: rotate(22deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
