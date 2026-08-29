<script setup lang="ts">
import { computed } from 'vue'
import { statusAnimationClass } from '../lib/presentation'
import type { Dwarf } from '../types'
import DwarfTooltip from './DwarfTooltip.vue'
import SpeechBubble from './SpeechBubble.vue'

const props = defineProps<{
  dwarf: Dwarf
  bubbleText?: string
  activating?: boolean
}>()

const emit = defineEmits<{ activate: [] }>()

const isForeman = computed(() => props.dwarf.role === 'foreman')
const rootClasses = computed(() => [
  statusAnimationClass(props.dwarf.status),
  `provider-${props.dwarf.provider}`,
  { 'is-foreman': isForeman.value, 'is-activating': props.activating }
])
const ariaLabel = computed(
  () =>
    `Open ${props.dwarf.name} (${props.dwarf.role}, ${props.dwarf.provider}) — ${props.dwarf.status}`
)
</script>

<template>
  <div class="dwarf-sprite" :class="rootClasses">
    <SpeechBubble v-if="bubbleText" class="bubble-holder" :text="bubbleText" />
    <button class="dwarf-hit" type="button" :aria-label="ariaLabel" @click="emit('activate')">
      <svg class="dwarf-figure" viewBox="0 0 96 104" aria-hidden="true">
        <g class="figure-inner">
          <!-- pickaxe behind the body so the handle reads as held -->
          <g v-if="!isForeman" class="pickaxe">
            <rect x="64" y="26" width="4.5" height="40" rx="2" fill="#8a6538" />
            <path d="M50 30 Q66 18 82 30 Q66 25 50 30 Z" fill="#9aa3ad" />
          </g>
          <!-- boots -->
          <rect x="33" y="86" width="12" height="9" rx="3" fill="#2c211a" />
          <rect x="51" y="86" width="12" height="9" rx="3" fill="#2c211a" />
          <!-- stocky tunic body -->
          <rect x="29" y="55" width="38" height="34" rx="9" fill="#7a5233" />
          <rect x="29" y="72" width="38" height="6" fill="#3a2b1d" />
          <rect x="43" y="71.5" width="10" height="7" rx="1.5" fill="#caa04a" />
          <!-- arms -->
          <rect x="23" y="57" width="9" height="19" rx="4.5" fill="#6b4526" />
          <rect x="64" y="57" width="9" height="19" rx="4.5" fill="#6b4526" />
          <!-- the beard makes the dwarf -->
          <path class="beard" d="M30 42 Q28 68 48 73 Q68 68 66 42 Z" />
          <!-- face -->
          <rect x="34" y="29" width="28" height="21" rx="9" fill="#e2ab7f" />
          <circle cx="42" cy="38" r="1.9" fill="#23170f" />
          <circle cx="54" cy="38" r="1.9" fill="#23170f" />
          <circle cx="48" cy="45" r="4.6" fill="#d99a6c" />
          <!-- helmet with lantern -->
          <path class="helmet" d="M30 31 Q30 13 48 13 Q66 13 66 31 Z" />
          <rect class="helmet-brim" x="26" y="29" width="44" height="5.5" rx="2.75" />
          <circle class="lamp-glow" cx="48" cy="21" r="8" />
          <circle cx="48" cy="21" r="3.4" fill="#ffe9a8" />
          <!-- foreman paperwork -->
          <g v-if="isForeman" class="clipboard">
            <rect x="37" y="52" width="23" height="27" rx="2" fill="#b98b4e" />
            <rect x="40" y="56" width="17" height="20" fill="#f0e3c8" />
            <rect x="42" y="60" width="13" height="1.6" fill="#9c8a68" />
            <rect x="42" y="64" width="13" height="1.6" fill="#9c8a68" />
            <rect x="42" y="68" width="9" height="1.6" fill="#9c8a68" />
            <rect x="44" y="50" width="9" height="4" rx="1.4" fill="#8f9aa4" />
          </g>
        </g>
        <!-- pick-impact sparks (visible while working) -->
        <g v-if="!isForeman" class="sparks">
          <circle class="spark spark-a" cx="84" cy="60" r="1.8" />
          <circle class="spark spark-b" cx="86" cy="64" r="1.4" />
          <circle class="spark spark-c" cx="82" cy="66" r="1.2" />
        </g>
      </svg>
      <span v-if="dwarf.status === 'waiting'" class="zzz" aria-hidden="true">z z z</span>
    </button>
    <span class="dwarf-name">{{ dwarf.name }}</span>
    <DwarfTooltip class="tooltip-holder" :dwarf="dwarf" />
  </div>
</template>

<style scoped>
.dwarf-sprite {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 76px;
}
.dwarf-hit {
  position: relative;
  width: 66px;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: transparent;
}
.dwarf-hit:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 3px;
  border-radius: 8px;
}
.dwarf-figure {
  display: block;
  width: 100%;
  overflow: visible;
}
.dwarf-name {
  max-width: 76px;
  margin-top: 2px;
  overflow: hidden;
  color: var(--ink-dim);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.beard {
  fill: var(--beard, #cbb790);
}
.provider-claude {
  --beard: #c98d4b;
}
.provider-codex {
  --beard: #aeb6bd;
}
.helmet {
  fill: #d9a441;
}
.helmet-brim {
  fill: #a87c2c;
}
.is-foreman .helmet {
  fill: #7898ad;
}
.is-foreman .helmet-brim {
  fill: #52707f;
}
.lamp-glow {
  fill: #ffe9a8;
  opacity: 0.22;
}
.is-activating {
  opacity: 0.55;
}

/* Animated groups pivot inside their own bounding box. */
.pickaxe,
.clipboard,
.figure-inner {
  transform-box: fill-box;
}
.pickaxe {
  transform-origin: 50% 92%;
  rotate: -24deg;
}

/* working: rhythmic pick swing, slight body lean, spark pops */
.figure-inner {
  transform-origin: 50% 100%;
  animation: idle-bob 3s ease-in-out infinite;
}
.is-working .figure-inner {
  animation: dig-lean 1.1s ease-in-out infinite;
}
.is-working .pickaxe {
  animation: pick-swing 1.1s ease-in-out infinite;
}
.spark {
  fill: #ffd873;
  opacity: 0;
}
.is-working .spark-a {
  animation: spark-pop 1.1s ease-out infinite;
}
.is-working .spark-b {
  animation: spark-pop 1.1s ease-out infinite;
  animation-delay: 0.08s;
}
.is-working .spark-c {
  animation: spark-pop 1.1s ease-out infinite;
  animation-delay: 0.16s;
}

/* waiting: pick planted, subtle bob, Zzz drifting up */
.is-waiting .pickaxe {
  rotate: 40deg;
  translate: -5px 3px;
}
.zzz {
  position: absolute;
  top: -12px;
  right: -4px;
  color: var(--ink-dim);
  font-size: 11px;
  font-style: italic;
  letter-spacing: 0.12em;
  pointer-events: none;
  animation: zzz-float 3.2s ease-in-out infinite;
}

/* foreman: stands apart, occasionally checks the clipboard */
.clipboard {
  transform-origin: 50% 80%;
  animation: clipboard-check 7s ease-in-out infinite;
}

/* leaving: walks toward the exit and fades within the runtime grace window */
.is-leaving {
  animation: walk-out 16s linear forwards;
  pointer-events: none;
}
.is-leaving .dwarf-figure {
  scale: -1 1;
}
.is-leaving .figure-inner {
  animation: walk-step 0.55s ease-in-out infinite;
}
.is-leaving .pickaxe {
  rotate: 8deg;
}

@keyframes idle-bob {
  50% {
    transform: translateY(-2px);
  }
}
@keyframes dig-lean {
  50% {
    transform: translateY(1.5px) rotate(2.5deg);
  }
}
@keyframes pick-swing {
  0%,
  100% {
    transform: rotate(-16deg);
  }
  45% {
    transform: rotate(42deg);
  }
  58% {
    transform: rotate(38deg);
  }
}
@keyframes spark-pop {
  0%,
  38% {
    opacity: 0;
    transform: translate(0, 0);
  }
  46% {
    opacity: 1;
  }
  70% {
    opacity: 0;
    transform: translate(6px, -7px);
  }
  100% {
    opacity: 0;
  }
}
@keyframes zzz-float {
  0% {
    opacity: 0;
    transform: translateY(4px);
  }
  30% {
    opacity: 0.9;
  }
  70% {
    opacity: 0;
    transform: translateY(-9px);
  }
  100% {
    opacity: 0;
  }
}
@keyframes clipboard-check {
  0%,
  62%,
  100% {
    transform: rotate(0deg) translateY(0);
  }
  70%,
  86% {
    transform: rotate(-7deg) translateY(-2.5px);
  }
}
@keyframes walk-step {
  50% {
    transform: translateY(-2.5px);
  }
}
@keyframes walk-out {
  0% {
    opacity: 1;
    translate: 0 0;
  }
  85% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    translate: -480px 0;
  }
}

.bubble-holder {
  position: absolute;
  z-index: 20;
  bottom: calc(100% + 2px);
  left: 46%;
}
.tooltip-holder {
  position: absolute;
  z-index: 30;
  bottom: calc(100% + 6px);
  left: 50%;
  opacity: 0;
  pointer-events: none;
  translate: -50% 0;
  transition: opacity 0.15s;
}
.dwarf-hit:hover ~ .tooltip-holder,
.dwarf-hit:focus-visible ~ .tooltip-holder {
  opacity: 1;
}
</style>
