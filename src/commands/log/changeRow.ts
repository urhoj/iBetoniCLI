/**
 * The changeTracker (audit trail) row shapes and their projections — the one
 * home for how a `/api/changes/*` wire row becomes CLI output.
 *
 * Three commands read the same audit table through different routes
 * (`ib log *`, `ib customer history`, `ib person history`), and each had grown
 * its own copy of the raw row interface plus an inline projection. They are
 * shared here so a new changeTracker column is added once.
 *
 * Two projections, deliberately:
 *  - {@link projectChangeRow} — the FULL `ib log` row (entity identity, keikka
 *    context, palkki labels).
 *  - {@link projectHistoryRow} — the 10-key subset `customer history` /
 *    `person history` emit. Narrower on purpose: those commands already know
 *    which entity they asked about, so echoing entityType/entityId per row is
 *    noise.
 */

/** Raw wire row from /api/changes/* (superset across the routes). */
export interface RawChangeRow {
  changeId: number;
  entityType?: string | null;
  entityId?: number | null;
  changeType?: string | null;
  fieldName?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  personId?: number | null;
  personFullName?: string | null;
  timestamp?: string | null;
  description?: string | null;
  reason?: string | null;
  impersonatedByPersonName?: string | null;
  keikkaTilaContext?: number | null;
  deviceType?: string | null;
  entityDisplayName?: string | null;
  palkkiText?: string | null;
  palkkiVehicleRegNo?: string | null;
}

export interface ChangeItem {
  changeId: number;
  entityType: string | null;
  entityId: number | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  changeType: string | null;
  personId: number | null;
  personName: string | null;
  at: string | null;
  description: string | null;
  /** null until the 2026-06 aggregate-procs migration is deployed (aggregate views). */
  reason: string | null;
  impersonatedByPersonName: string | null;
  keikkaTilaContext?: number | null;
  deviceType?: string | null;
  entityDisplayName?: string;
  palkkiText?: string;
  palkkiVehicleRegNo?: string;
}

/** Full projection for `ib log *` — the optional display fields appear only when set. */
export function projectChangeRow(r: RawChangeRow): ChangeItem {
  const item: ChangeItem = {
    changeId: r.changeId,
    entityType: r.entityType ?? null,
    entityId: r.entityId ?? null,
    field: r.fieldName ?? null,
    oldValue: r.oldValue ?? null,
    newValue: r.newValue ?? null,
    changeType: r.changeType ?? null,
    personId: r.personId ?? null,
    personName: r.personFullName ?? null,
    at: r.timestamp ?? null,
    description: r.description ?? null,
    reason: r.reason ?? null,
    impersonatedByPersonName: r.impersonatedByPersonName ?? null,
    keikkaTilaContext: r.keikkaTilaContext ?? null,
    deviceType: r.deviceType ?? null,
  };
  if (r.entityDisplayName != null) item.entityDisplayName = r.entityDisplayName;
  if (r.palkkiText != null) item.palkkiText = r.palkkiText;
  if (r.palkkiVehicleRegNo != null) item.palkkiVehicleRegNo = r.palkkiVehicleRegNo;
  return item;
}

/** The narrowed audit row emitted by `ib customer history` / `ib person history`. */
export interface ChangeHistoryItem {
  changeId: number;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  changeType: string | null;
  personId: number | null;
  personName: string | null;
  at: string | null;
  description: string | null;
  reason: string | null;
}

/** Narrowing projection for the per-entity history commands. */
export function projectHistoryRow(r: RawChangeRow): ChangeHistoryItem {
  return {
    changeId: r.changeId,
    field: r.fieldName ?? null,
    oldValue: r.oldValue ?? null,
    newValue: r.newValue ?? null,
    changeType: r.changeType ?? null,
    personId: r.personId ?? null,
    personName: r.personFullName ?? null,
    at: r.timestamp ?? null,
    description: r.description ?? null,
    reason: r.reason ?? null,
  };
}
