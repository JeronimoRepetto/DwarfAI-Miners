import { runCopyPreparerContract } from '../testing/copyPreparer.contract'
import { FakeCopyPreparer } from './FakeCopyPreparer'

runCopyPreparerContract('FakeCopyPreparer', () => {
  const sourceDir = '/opt/DwarfAI-Miners'
  const copyDir = '/home/j/.local/share/dwarfai/host/1.4.0'
  const copy = new FakeCopyPreparer(sourceDir, copyDir)
  return Promise.resolve({
    prepare: copy.prepare,
    sourceDir,
    copyDir,
    breakCopy: () => {
      copy.outcome = { ok: false, errCode: 'COPY_ENOSPC' }
    }
  })
})
