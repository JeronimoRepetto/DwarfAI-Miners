import type { AgentNameApi } from './index'

declare global {
  interface Window {
    api: AgentNameApi
  }
}

export {}
