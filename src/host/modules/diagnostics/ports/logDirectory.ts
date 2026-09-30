// The diagnostics module's driven port (05 §3.13, 16 §4.13): the segment listing of the shared
// `logs/` folder that the Host's SegmentWriter hands to `planPrune`. Listing only; an `ENOENT`
// race with another writer's prune is benign (the file is simply not listed).

// verbatim: 05 §3.13 (LogDirectory)
// prettier-ignore
export interface LogDirectory { segments(): readonly { name: string; bytes: number; firstTs: string }[] } // driven: segment listing that the Host's SegmentWriter hands to planPrune
// end verbatim
