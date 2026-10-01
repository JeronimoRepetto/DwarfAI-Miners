import { runScreenAreaProviderContract } from '../screenAreaProvider.contract'
import { FakeScreenAreaProvider } from './FakeScreenAreaProvider'

runScreenAreaProviderContract(
  'FakeScreenAreaProvider',
  () =>
    new FakeScreenAreaProvider([
      {
        displayKey: 'primary',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        primary: true
      },
      {
        displayKey: 'second',
        bounds: { x: -2560, y: 0, width: 2560, height: 1440 },
        workArea: { x: -2560, y: 25, width: 2560, height: 1391 },
        primary: false
      }
    ])
)
