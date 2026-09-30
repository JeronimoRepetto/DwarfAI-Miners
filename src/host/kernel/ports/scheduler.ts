// Kernel driven port (05 §3, 16 §3): every timeout of 16 §2.6 is a task on it.
export interface Scheduler {
  after(ms: number, task: () => void): { cancel(): void }
}
