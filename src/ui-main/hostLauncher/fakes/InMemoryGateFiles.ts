// The GateFiles double: one gate file held in memory, every operation atomic. Several launchers
// may share one instance, as several UIs share one run folder. Never imported by production code
// (R14).
import type { GateFiles } from '../ports'

export class InMemoryGateFiles implements GateFiles {
  content: string | null = null

  create(content: string): Promise<'created' | 'exists'> {
    if (this.content !== null) return Promise.resolve('exists')
    this.content = content
    return Promise.resolve('created')
  }

  read(): Promise<string | null> {
    return Promise.resolve(this.content)
  }

  removeIf(content: string): Promise<boolean> {
    if (this.content !== content) return Promise.resolve(false)
    this.content = null
    return Promise.resolve(true)
  }
}
