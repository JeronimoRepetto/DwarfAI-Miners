<script setup lang="ts">
import { useMines } from './composables/useMines'

const { state } = useMines()

function hidePanel(): void {
  window.api.hidePanel()
}
</script>

<template>
  <div class="panel">
    <header class="titlebar">
      <span class="title">
        <span class="title-gem" aria-hidden="true"></span>
        AgentName
      </span>
      <button class="close-btn" type="button" aria-label="Hide panel" @click="hidePanel">✕</button>
    </header>

    <main class="mines">
      <div v-if="state.mines.length === 0" class="empty">
        <span class="empty-icon" aria-hidden="true">⛏️</span>
        <p class="empty-title">No active mines</p>
        <p class="empty-hint">
          AI coding agents running on this PC will show up here as dwarfs at work.
        </p>
      </div>
      <div v-else class="mines-grid">
        <article v-for="mine in state.mines" :key="mine.id" class="mine-card">
          <h2 class="mine-label">{{ mine.label }}</h2>
          <p class="mine-count">{{ mine.dwarfs.length }} dwarfs</p>
        </article>
      </div>
    </main>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: rgba(24, 20, 14, 0.97);
  border: 1px solid #3d3526;
  border-radius: 12px;
  overflow: hidden;
  color: #e8e0d0;
}

.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #2c2619;
  -webkit-app-region: drag;
}

.title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.title-gem {
  width: 10px;
  height: 10px;
  background: #f5a623;
  transform: rotate(45deg);
  border-radius: 2px;
  box-shadow: 0 0 8px rgba(245, 166, 35, 0.6);
}

.close-btn {
  -webkit-app-region: no-drag;
  background: transparent;
  border: none;
  color: #a89c86;
  font-size: 13px;
  line-height: 1;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.close-btn:hover {
  background: #3d3526;
  color: #e8e0d0;
}

.mines {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  gap: 6px;
}

.empty-icon {
  font-size: 34px;
  opacity: 0.85;
}

.empty-title {
  margin: 6px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: #cfc4ad;
}

.empty-hint {
  margin: 0;
  max-width: 260px;
  font-size: 12px;
  line-height: 1.5;
  color: #7d7361;
}

.mines-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.mine-card {
  background: #221d14;
  border: 1px solid #3d3526;
  border-radius: 10px;
  padding: 12px;
}

.mine-label {
  margin: 0 0 4px;
  font-size: 13px;
  color: #f5a623;
}

.mine-count {
  margin: 0;
  font-size: 12px;
  color: #a89c86;
}
</style>
