/* Versioned persistence primitives.  Browser adapters can keep their
 * localStorage calls at the edge and use these pure plans/results. */
open RescriptCore

type envelope = {
  app: string,
  schemaVersion: int,
}

type storageError =
  | Missing
  | Corrupt(string)
  | QuotaExceeded
  | Unavailable(string)

type records = {
  primary: option<string>,
  legacy: option<string>,
  recovery: option<string>,
  backup: option<string>,
}

type decoded = {
  state: Domain.state,
  normalization: Domain.normalization,
}

type loadResult = {
  state: option<Domain.state>,
  source: string,
  dropped: Domain.dropCounts,
  recovered: bool,
  error: option<storageError>,
}

type writePlan = {
  primaryKey: string,
  primaryValue: string,
  legacyKey: string,
  recoveryKey: string,
  recoveryValue: option<string>,
  backupKey: string,
  backupValue: option<string>,
}

let primaryStorageKey = Domain.storageKey
let storageKey = primaryStorageKey
let legacyStorageKey = Domain.legacyStorageKey
let recoveryStorageKey = primaryStorageKey ++ ":recovery"
let backupStorageKey = primaryStorageKey ++ ":backup"
let resetKeys = [primaryStorageKey, legacyStorageKey, recoveryStorageKey, backupStorageKey]
let currentVersion = Domain.storageVersion
let exportVersion = Domain.exportSchemaVersion

let makeEnvelope = (): envelope => {app: "atr-desk", schemaVersion: currentVersion}
let makeExportEnvelope = (): envelope => {app: "atr-desk", schemaVersion: exportVersion}

let emptyRecords = (): records => {
  primary: None,
  legacy: None,
  recovery: None,
  backup: None,
}

let emptyDropCounts = (): Domain.dropCounts => {
  pendingOrders: 0,
  activeTrades: 0,
  history: 0,
  duplicateTickers: 0,
}

let parseJson = (raw: string): option<JSON.t> =>
  try {
    Some(JSON.parseExn(raw))
  } catch {
  | _ => None
  }

let unwrapState = (value: JSON.t): JSON.t =>
  switch JSON.Decode.object(value) {
  | None => value
  | Some(root) =>
    switch Dict.get(root, "state") {
    | Some(inner) => inner
    | None => value
    }
  }

let hasRequiredStateFields = (value: JSON.t): bool =>
  switch JSON.Decode.object(unwrapState(value)) {
  | None => false
  | Some(root) =>
    Dict.get(root, "accountValue")->Option.isSome &&
    Dict.get(root, "activeTrades")->Option.isSome &&
    Dict.get(root, "pendingOrders")->Option.isSome &&
    Dict.get(root, "history")->Option.isSome
  }

let decodeStored = (raw: string): option<decoded> =>
  switch parseJson(raw) {
  | None => None
  | Some(value) =>
    if !Domain.envelopeSupported(value) || !hasRequiredStateFields(value) {
      None
    } else {
      let normalized = Domain.normalizePersistedState(value)
      Some({state: normalized.state, normalization: normalized})
    }
  }

let serializeState = (state: Domain.state): string =>
  JSON.stringify(Domain.exportEnvelope(Domain.encodeState(state)))

let serializeStorageState = (state: Domain.state): string =>
  JSON.stringify(Domain.storageEnvelope(Domain.encodeState(state)))

let encodeState = serializeState

let deserializeState = (raw: string): option<Domain.state> =>
  decodeStored(raw)->Option.map(decoded => decoded.state)

let classifyStorageError = (name: string): storageError => {
  let lowered = name->String.toLowerCase
  if lowered->String.includes("quota") || lowered->String.includes("exceed") {
    QuotaExceeded
  } else {
    Unavailable(name)
  }
}

let isQuotaExceeded = (name: string): bool =>
  switch classifyStorageError(name) {
  | QuotaExceeded => true
  | _ => false
  }

let loadFromRecords = (values: records): loadResult => {
  /* Once a primary key exists it is the canonical namespace: a corrupt
   * primary falls through to rolling backup then untouched recovery, never
   * resurrecting the legacy key. Legacy is consulted only on first migration
   * when the primary key is absent. */
  let candidates = switch (values.primary, values.backup, values.recovery) {
  | (Some(primary), backup, recovery) => [
      ("primary", Some(primary), false),
      ("backup", backup, true),
      ("recovery", recovery, true),
    ]
  | (None, Some(backup), recovery) => [("backup", Some(backup), true), ("recovery", recovery, true)]
  | (None, None, Some(recovery)) => [("recovery", Some(recovery), true)]
  | (None, None, None) => [("legacy", values.legacy, false)]
  }
  let resultRef = ref(None)
  let error = ref(None)
  candidates->Array.forEach(((label, value, fallback)) => {
    switch resultRef.contents {
    | Some(_) => ()
    | None =>
      switch value {
      | None => ()
      | Some(raw) =>
        switch decodeStored(raw) {
        | Some(decoded) => resultRef.contents = Some((label, decoded, fallback))
        | None => error.contents = error.contents == None ? Some(Corrupt(label)) : error.contents
        }
      }
    }
  })
  switch resultRef.contents {
  | None => {
      state: None,
      source: "",
      dropped: emptyDropCounts(),
      recovered: false,
      error: error.contents == None ? Some(Missing) : error.contents,
    }
  | Some((source, decoded, recovered)) => {
      state: Some(decoded.state),
      source,
      dropped: decoded.normalization.dropped,
      recovered,
      error: error.contents,
    }
  }
}

let loadFromValues = loadFromRecords
let load = loadFromRecords

/* A save always writes the new primary key.  An existing valid primary is
 * copied to the rolling backup.  The recovery slot is deliberately untouched
 * once present, so a failed migration can always be retried. */
let planWrite = (~values: records, ~state: Domain.state): writePlan => {
  let primaryValue = serializeStorageState(state)
  let previousValid = switch values.primary {
  | Some(raw) =>
    switch decodeStored(raw) {
    | Some(_) => Some(raw)
    | None => None
    }
  | None => None
  }
  let recoveryValue = switch values.recovery {
  | Some(raw) => Some(raw)
  | None =>
    switch previousValid {
    | Some(raw) => Some(raw)
    | None => values.legacy
    }
  }
  {
    primaryKey: primaryStorageKey,
    primaryValue,
    legacyKey: legacyStorageKey,
    recoveryKey: recoveryStorageKey,
    recoveryValue,
    backupKey: backupStorageKey,
    backupValue: previousValid,
  }
}

let prepareWrite = planWrite

let resetStorageKeys = (): array<string> => resetKeys

let stateForStorage = (state: Domain.state): JSON.t =>
  Domain.exportEnvelope(Domain.encodeState(state))
