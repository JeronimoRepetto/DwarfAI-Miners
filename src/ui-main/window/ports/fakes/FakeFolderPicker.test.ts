import { runFolderPickerContract } from '../folderPicker.contract'
import { FakeFolderPicker } from './FakeFolderPicker'

runFolderPickerContract('FakeFolderPicker', (chosen) => {
  const picker = new FakeFolderPicker(chosen)
  return { picker, attachedTo: () => [...picker.parents] }
})
