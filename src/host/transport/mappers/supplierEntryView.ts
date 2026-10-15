// The `SupplierEntry` (06 §0.2, the suppliers module's answer) → `SupplierEntryView` (14 §3.6,
// frozen) mapping of B-M37 `suppliers.launchable`. It lives in host/transport, not in the module
// (05 R9; ISSUE-163):
//
// - `models`: one `ModelOptionView` per model id of the entry, in the entry's order, with the
//   model's label and its own COMPLETE and ORDERED effort ladder from the catalog `ModelEntry`
//   (15 §1.2; ADR-028; A-37 merged into A-36). A model id the catalog lists no `ModelEntry` for
//   keeps the provider's own ladder (`SupplierEntry.efforts`, ADR-009 D1 `ProviderProfile.efforts`);
// - `offeredModes`: the permission modes the app can honour at this moment, which is the entry's
//   `permissionModes` (06 INV-42; ADR-011 item 1): the module already filtered them by the
//   effective capabilities and the answer-channel gate;
// - `answerChannel` and `gatingIntegration`: the entry's own, derived by the module from the
//   effective capabilities and the integration gate on this call (16 §4.4; ADR-011 item 7), never
//   from the catalog ceiling.
//
// Data only: no provider id is special here (R12).
import type { ModelOptionView, SupplierEntryView } from '@dwarfai/contracts'
import type { ModelEntry, SupplierEntry } from '../../modules/suppliers'

export function toSupplierEntryView(
  entry: SupplierEntry,
  catalogModels: readonly ModelEntry[]
): SupplierEntryView {
  const byId = new Map(catalogModels.map((model) => [model.id, model]))
  const models = entry.models.map((id): ModelOptionView => {
    const model = byId.get(id)
    return model === undefined
      ? { value: id, efforts: [...entry.efforts] }
      : { value: id, label: model.label, efforts: [...model.efforts] }
  })
  return {
    providerId: entry.providerId,
    label: entry.label,
    permissionModes: [...entry.permissionModes],
    installed: entry.installed,
    publicLaunch: entry.publicLaunch,
    answerChannel: entry.answerChannel,
    ...(entry.gatingIntegration !== undefined
      ? { gatingIntegration: entry.gatingIntegration }
      : {}),
    models,
    offeredModes: [...entry.permissionModes]
  }
}
