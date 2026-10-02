import { runFilePickerContract } from '../filePicker.contract'
import { FakeFilePicker } from './FakeFilePicker'

runFilePickerContract('FakeFilePicker', (chosen) => {
  const picker = new FakeFilePicker(chosen)
  return { picker, attachedTo: () => [...picker.parents] }
})
