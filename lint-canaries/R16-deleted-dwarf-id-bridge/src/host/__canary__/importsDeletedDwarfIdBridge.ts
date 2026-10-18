// ISSUE-241 (TC-241-02): `LegacyDwarfIdBridge`, `LegacyEndFirstAdapter`, `LegacyAgentRegistryFeed`, `LegacyAskRelay`
// and `LegacyAnswerShapeAdapter` left the tree at the end of cut 4. Only the composition roots may import
// src/legacy-bridge, so an import of a deleted bridge's path from anywhere else fails lint (R16).
import { createLegacyDwarfIdBridge } from '../../legacy-bridge/LegacyDwarfIdBridge'

export const host = createLegacyDwarfIdBridge
