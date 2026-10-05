// layer: L3
import { runNotificationDisplayContract } from '../../testing/notificationDisplay.contract'
import { RecordingNotificationDisplay } from './RecordingNotificationDisplay'

runNotificationDisplayContract('RecordingNotificationDisplay', () => {
  const display = new RecordingNotificationDisplay()
  return {
    display,
    drawn: () => display.shown.map(({ title, body }) => ({ title, body })),
    onScreen: () => display.onScreen().map(({ title, body }) => ({ title, body })),
    click: (index) => {
      const key = display.shown[index]?.key
      if (typeof key === 'string') display.click(key)
    }
  }
})
