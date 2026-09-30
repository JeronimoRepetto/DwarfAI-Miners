// The seam-B frame catalog (14 §3.5): one `'<name>': <payload>` entry per Host → UI evt frame.
// Each entry lands here, in this file, with the issue that publishes it (hot spot, 22 §5).
// HostFrameName and HostFrameData derive from it once, in envelope.ts.

// An interface, not a type alias, so that entries merge into it; it stays empty until the first frame issue.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HostFrames {}
