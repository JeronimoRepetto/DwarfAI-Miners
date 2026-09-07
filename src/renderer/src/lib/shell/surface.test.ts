import { describe, expect, it } from 'vitest'
import { rendererSurface } from './surface'

describe('rendererSurface', () => {
  it('is the shell when nothing names a surface', () => {
    // The shell's own window is loaded with no query at all, and it is the
    // fallback for the same reason: a page that cannot tell which window it is
    // in is the main one, not a panel floating with no mine beside it.
    expect(rendererSurface('')).toBe('shell')
    expect(rendererSurface('?')).toBe('shell')
  })

  it('is the message panel when main said so', () => {
    expect(rendererSurface('?surface=message-panel')).toBe('message-panel')
  })

  it('reads the query without caring what else is in it', () => {
    // electron-vite's dev server appends its own parameters, and a packaged
    // load carries whatever `loadFile`'s search option was given.
    expect(rendererSurface('?surface=message-panel&t=1699')).toBe('message-panel')
    expect(rendererSurface('?t=1699&surface=message-panel')).toBe('message-panel')
  })

  it('takes a query with or without its leading question mark', () => {
    expect(rendererSurface('surface=message-panel')).toBe('message-panel')
  })

  it('falls back to the shell for a surface this build does not have', () => {
    // A surface nobody recognises must not leave the window blank: the shell
    // is the only root that draws itself from main's own state, so it is the
    // honest answer to a query that means nothing here.
    expect(rendererSurface('?surface=history-panel')).toBe('shell')
    expect(rendererSurface('?surface=')).toBe('shell')
  })
})
