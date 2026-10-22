/*
 * The default degradation of the Control-room mosaic (ADR-034 item 5; ISSUE-298, S-034-1): a column
 * outside the viewport pauses its sprite frame clock and paints its last frame; every column stays
 * in the DOM (no virtualization). With the switch off, every column's clock runs wherever it is.
 */
export function columnClockRuns(degradation: boolean, inView: boolean): boolean {
  return !degradation || inView
}
