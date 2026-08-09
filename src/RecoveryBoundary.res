type storage
type fileBlob
type domDocument
type domUrl
type anchor
type location

@val external localStorage: storage = "localStorage"
@send external getItem: (storage, string) => option<string> = "getItem"
@send external setItem: (storage, string, string) => unit = "setItem"
@val external document: domDocument = "document"
@val external url: domUrl = "URL"
@val external location: location = "location"
@new external makeBlob: (array<string>, dict<string>) => fileBlob = "Blob"
@send external createObjectURL: (domUrl, fileBlob) => string = "createObjectURL"
@send external revokeObjectURL: (domUrl, string) => unit = "revokeObjectURL"
@send external createElement: (domDocument, string) => anchor = "createElement"
@set external anchorHref: (anchor, string) => unit = "href"
@set external anchorDownload: (anchor, string) => unit = "download"
@send external anchorClick: anchor => unit = "click"
@send external reload: location => unit = "reload"

let raw = (key: string): option<string> =>
  try {getItem(localStorage, key)} catch {
  | _ => None
  }

let download = (key: string, filename: string) =>
  switch raw(key) {
  | Some(value) => {
      let blob = makeBlob([value], Dict.fromArray([("type", "application/json")]))
      let objectUrl = createObjectURL(url, blob)
      let link = createElement(document, "a")
      anchorHref(link, objectUrl)
      anchorDownload(link, filename)
      anchorClick(link)
      revokeObjectURL(url, objectUrl)
    }
  | None => ()
  }

let openRecovery = () => {
  try {setItem(localStorage, "atr-desk:open-recovery", "1")} catch {
  | _ => ()
  }
  reload(location)
}

module RecoveryScreen = {
  @react.component
  let make = () =>
    <main className="recovery-screen" role="alert" ariaLabelledby="recovery-title">
      <p className="eyebrow"> {React.string("// RECOVERY MODE")} </p>
      <h1 id="recovery-title"> {React.string("The desk hit a recoverable error.")} </h1>
      <p>
        {React.string(
          "Your local ledger is still on this device. Export both raw slots before reloading or opening recovery.",
        )}
      </p>
      <div className="button-row">
        <button
          className="secondary"
          onClick={_ => download(Storage.primaryStorageKey, "atr-desk-primary.json")}
        >
          {React.string("Export primary")}
        </button>
        <button
          className="secondary"
          onClick={_ => download(Storage.backupStorageKey, "atr-desk-backup.json")}
        >
          {React.string("Export backup")}
        </button>
        <button className="primary" onClick={_ => openRecovery()}>
          {React.string("Open recovery")}
        </button>
        <button className="quiet" onClick={_ => reload(location)}>
          {React.string("Reload app")}
        </button>
      </div>
    </main>
}

@react.component
let make = (~children: React.element) =>
  <RescriptReactErrorBoundary fallback={_error => <RecoveryScreen />}>
    {children}
  </RescriptReactErrorBoundary>
