// The one stack of the window's open dialogs (lib/overlay/dialogStack.ts; ISSUE-141), shared by every ModalDialog,
// and the counter that tells Vue it changed.
import { shallowRef } from 'vue'
import { createDialogStack } from '../../lib/overlay/dialogStack'

export const dialogStack = createDialogStack()

/** Bumped on every open and close, so each dialog's place in the stack is read again. */
export const stackChanged = shallowRef(0)

let minted = 0

/** One id per ModalDialog instance. */
export function nextDialogId(): number {
  return ++minted
}
