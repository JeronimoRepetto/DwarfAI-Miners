import { runClipboardContract } from '../clipboard.contract'
import { FakeClipboard } from './FakeClipboard'

runClipboardContract('FakeClipboard', () => {
  const clipboard = new FakeClipboard()
  return {
    clipboard,
    received: () => [...clipboard.written],
    refuseWrites: () => {
      clipboard.failWith = new Error('no clipboard owner')
    }
  }
})
