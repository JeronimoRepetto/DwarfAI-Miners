// Seam A channel registry and payload schemas (05 §2.1 `ipc/`; ADR-019 item 6; 14 §2.1).
export type { ChannelSpec } from './channelSpec'
export { CHANNELS, PRELOAD_HELPERS, todayShapeOf } from './channels'
export { TODAY_SHAPES, type TodayShape } from './todayShapes'
export { ROW_IDS, type RowId } from './rowIds'
export { RETIRED, STEP_ORDER, UNROUTED, type ChannelKey, type StepId } from './unrouted'
export * from './windowApi'
