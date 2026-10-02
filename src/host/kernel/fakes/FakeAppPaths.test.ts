import { runAppPathsContract } from '../testing/appPaths.contract'
import { FakeAppPaths } from './FakeAppPaths'

runAppPathsContract((values) => new FakeAppPaths(values))
