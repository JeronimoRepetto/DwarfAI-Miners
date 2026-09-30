// The seam-B method catalog (14 §3.4): one `'<name>': { params; result }` entry per UI → Host request.
// Each entry lands here, in this file, with the issue that serves its handler (hot spot, 22 §5); `hello` is the
// first frame, not a method. HostMethod, HostParams and HostResult derive from it once, in envelope.ts.

// An interface, not a type alias, so that entries merge into it; it stays empty until the first handler issue.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HostMethods {}
