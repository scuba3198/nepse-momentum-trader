type registerOptions = {
  onNeedRefresh: unit => unit,
  onOfflineReady: unit => unit,
}

@module("virtual:pwa-register")
external registerSW: registerOptions => unit => Promise.t<unit> = "registerSW"

@react.component
let make = () => {
  let (needRefresh, setNeedRefresh) = React.useState(() => false)
  let (offlineReady, setOfflineReady) = React.useState(() => false)
  let (update, setUpdate) = React.useState(() => None)
  React.useEffect0(() => {
    let updateSW = registerSW({
      onNeedRefresh: () => setNeedRefresh(_ => true),
      onOfflineReady: () => setOfflineReady(_ => true),
    })
    setUpdate(_ => Some(updateSW))
    None
  })
  switch (needRefresh, offlineReady) {
  | (true, _) =>
    <div className="pwa-prompt" role="status">
      <span> {React.string("A new desk build is ready.")} </span>
      <button
        className="secondary"
        onClick={_ =>
          switch update {
          | Some(reload) =>
            let _ = reload()
          | None => ()
          }}
      >
        {React.string("Reload")}
      </button>
      <button className="quiet" onClick={_ => setNeedRefresh(_ => false)}>
        {React.string("Later")}
      </button>
    </div>
  | (false, true) =>
    <div className="pwa-prompt" role="status">
      <span> {React.string("Desk is ready for offline use.")} </span>
      <button className="quiet" onClick={_ => setOfflineReady(_ => false)}>
        {React.string("Dismiss")}
      </button>
    </div>
  | _ => React.null
  }
}
