import type { DwarfAiMinersApi } from './index'

declare global {
  interface Window {
    api: DwarfAiMinersApi
  }
}

export {}
