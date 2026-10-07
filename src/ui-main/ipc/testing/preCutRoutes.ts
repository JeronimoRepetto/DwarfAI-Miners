// The route table as it stood before the cut-0 switch (ISSUE-043; 21 §2 "Pre-cut 0"), for the suites written against
// it: every today row of 14 §2.1 and the two legacy rows of 14 §8 I-21 `legacy` with today's shape, and the NEW rows
// with no route (they were listed in `unrouted.ts` until cut 0 routed them). It is also the table a rollback build of
// cut 0 serves (21 §2.1: the cut's router rows flipped back to `legacy`). Test-only (R14): production never imports it.
//
// AMENDED for ISSUE-123 (was: derived from the release's `ROUTES`): from cut 1 the release table has no route for the
// rows it retired (A-14, A-16, A-17, A-18, A-P5), so the pre-cut table is derived from the registry itself.
import { CHANNELS, type ChannelKey } from '@dwarfai/contracts'
import type { ChannelRoute } from '../channelRoute'

export const PRE_CUT_0_ROUTES: readonly ChannelRoute[] = (Object.keys(CHANNELS) as ChannelKey[])
  .filter((channel) => CHANNELS[channel].status !== 'new')
  .map((channel): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'pre-cut-0',
    parity: 'n/a',
    shape: 'today'
  }))
