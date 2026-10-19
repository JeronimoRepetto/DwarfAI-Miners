// R19 (ADR-019 item 1): a BrowserWindow built outside secureWindowOptions must fail the lint.
import { BrowserWindow } from 'electron'

export const window = new BrowserWindow({ webPreferences: { sandbox: false } })
