type storage
@val external localStorage: storage = "localStorage"
@send external getItem: (storage, string) => option<string> = "getItem"
@send external setItem: (storage, string, string) => unit = "setItem"
@send external removeItem: (storage, string) => unit = "removeItem"
@get external exceptionName: exn => option<string> = "name"
type file
type fileList
type fileReader
type blob
type domDocument
type domUrl
type anchor
type focusable
type nodeList
@get external files: {..} => fileList = "files"
@send external fileAt: (fileList, int) => option<file> = "item"
@new external makeReader: unit => fileReader = "FileReader"
@set external setReaderOnload: (fileReader, unit => unit) => unit = "onload"
@get external readerResult: fileReader => option<string> = "result"
@send external readAsText: (fileReader, file) => unit = "readAsText"
@val external document: domDocument = "document"
@val external url: domUrl = "URL"
@new external makeBlob: (array<string>, dict<string>) => blob = "Blob"
@send external createObjectURL: (domUrl, blob) => string = "createObjectURL"
@send external revokeObjectURL: (domUrl, string) => unit = "revokeObjectURL"
@send external createElement: (domDocument, string) => anchor = "createElement"
@set external anchorHref: (anchor, string) => unit = "href"
@set external anchorDownload: (anchor, string) => unit = "download"
@send external anchorClick: anchor => unit = "click"
@raises @val external parseJson: string => JSON.t = "JSON.parse"
@val external activeElement: option<focusable> = "document.activeElement"
@send external focus: focusable => unit = "focus"
@send external querySelectorAll: (domDocument, string) => nodeList = "querySelectorAll"
@get external nodeListLength: nodeList => int = "length"
@send external nodeAt: (nodeList, int) => option<focusable> = "item"

let safeGet = (key: string): option<string> =>
  try {getItem(localStorage, key)} catch {
  | _ => None
  }
let safeSet = (key: string, value: string): result<unit, Storage.storageError> =>
  try {
    setItem(localStorage, key, value)
    Ok()
  } catch {
  | error =>
    Error(
      exceptionName(error)
      ->Option.map(Storage.classifyStorageError)
      ->Option.getOr(Storage.Unavailable("localStorage write failed")),
    )
  }
let safeRemove = (key: string): unit =>
  try {removeItem(localStorage, key)} catch {
  | _ => ()
  }
let fmt = (x: float) => `NPR ${x->Float.toString}`
let number = (s: string) =>
  switch Float.parseFloat(s) {
  | x if Float.isFinite(x) => x
  | _ => 0.0
  }
let intNumber = (s: string) =>
  switch Int.fromString(s) {
  | Some(x) => x
  | None => 0
  }
let today = () => Domain.todayKathmanduISO()
let readFile = (event: ReactEvent.Form.t, onText: string => unit) => {
  let reader = makeReader()
  setReaderOnload(reader, () =>
    switch readerResult(reader) {
    | Some(text) => onText(text)
    | None => ()
    }
  )
  switch fileAt(files(ReactEvent.Form.target(event)), 0) {
  | Some(file) => readAsText(reader, file)
  | None => ()
  }
}
let focusSelector = "[role=dialog] button, [role=dialog] input, [role=dialog] textarea, [role=dialog] select, [role=dialog] [href], [role=dialog] [tabindex]:not([tabindex='-1'])"
let dialogFocusables = () => querySelectorAll(document, focusSelector)
let focusFirst = () => {
  let nodes = dialogFocusables()
  switch nodeAt(nodes, 0) {
  | Some(target) => focus(target)
  | None => ()
  }
}
let focusLast = () => {
  let nodes = dialogFocusables()
  switch nodeAt(nodes, nodeListLength(nodes) - 1) {
  | Some(target) => focus(target)
  | None => ()
  }
}
let downloadExport = (state: Domain.state) => {
  let blob = makeBlob(
    [Storage.serializeState(state)],
    Dict.fromArray([("type", "application/json")]),
  )
  let objectUrl = createObjectURL(url, blob)
  let anchor = createElement(document, "a")
  anchorHref(anchor, objectUrl)
  anchorDownload(anchor, "atr-desk-export.json")
  anchorClick(anchor)
  revokeObjectURL(url, objectUrl)
}

let records = (): Storage.records => {
  primary: safeGet(Storage.primaryStorageKey),
  legacy: safeGet(Storage.legacyStorageKey),
  recovery: safeGet(Storage.recoveryStorageKey),
  backup: safeGet(Storage.backupStorageKey),
}
let loadMessage = (r: Storage.loadResult): string => {
  let dropped =
    r.dropped.pendingOrders +
    r.dropped.activeTrades +
    r.dropped.history +
    r.dropped.duplicateTickers
  let dropMessage =
    dropped > 0 ? ` Dropped ${dropped->Int.toString} malformed or duplicate records.` : ""
  let errorMessage = switch r.error {
  | Some(Storage.Corrupt(label)) => ` Rejected malformed ${label} storage.`
  | Some(Storage.Missing) => ""
  | Some(Storage.QuotaExceeded) => " Storage quota was exceeded; export a backup before continuing."
  | Some(Storage.Unavailable(
      _,
    )) => " Local storage is unavailable; export a backup before continuing."
  | None => ""
  }
  let recoveryMessage = r.recovered ? " Recovered from a rolling backup." : ""
  errorMessage ++ recoveryMessage ++ dropMessage
}
let storageErrorLabel = (error: Storage.storageError): string =>
  switch error {
  | Storage.QuotaExceeded => "Storage quota exceeded. Export a backup and clear space before continuing."
  | Storage.Unavailable(
      _,
    ) => "Local storage is unavailable. Export a backup and use recovery before continuing."
  | Storage.Corrupt(label) =>
    `Storage rejected malformed ${label} data. Open recovery to restore a backup.`
  | Storage.Missing => "No local storage was found."
  }
let reducerErrorLabel = (error: Reducer.domainError): string =>
  switch error {
  | Reducer.InvalidNumber(reason) => `Action rejected: invalid ${reason}.`
  | Reducer.InvalidDate(reason) => `Action rejected: invalid date (${reason}).`
  | Reducer.InvalidOrder(reason) => `Action rejected: invalid order (${reason}).`
  | Reducer.InvalidFill(reason) => `Action rejected: invalid fill (${reason}).`
  | Reducer.InvalidSale(reason) => `Action rejected: invalid sale (${reason}).`
  | Reducer.NotFound(reason) => `Action rejected: ${reason} was not found.`
  | Reducer.CashCap(_) => "Action rejected: fill exceeds available cash."
  | Reducer.DuplicateTicker(ticker) => `Action rejected: ${ticker} is already tracked.`
  | Reducer.SlotLimit => "Action rejected: all five portfolio slots are occupied."
  }
let load = (): (Domain.state, string, string) => {
  let r = Storage.loadFromRecords(records())
  switch r.state {
  | Some(s) => (s, r.source, loadMessage(r))
  | None => (Domain.defaultState(), "new", loadMessage(r))
  }
}
type persistResult = Saved | Failed(Storage.storageError)
let persist = (s: Domain.state): persistResult => {
  let p = Storage.planWrite(~values=records(), ~state=s)
  let firstError = ref(None)
  let write = (key: string, value: string) =>
    switch safeSet(key, value) {
    | Ok(_) => ()
    | Error(error) =>
      if firstError.contents == None {
        firstError.contents = Some(error)
      }
    }
  write(p.primaryKey, p.primaryValue)
  switch p.recoveryValue {
  | Some(v) => write(p.recoveryKey, v)
  | None => ()
  }
  switch p.backupValue {
  | Some(v) => write(p.backupKey, v)
  | None => ()
  }
  switch firstError.contents {
  | Some(error) => Failed(error)
  | None => Saved
  }
}
let candidate = (j: JSON.t): option<Domain.candidate> =>
  switch Domain.decodeObject(j) {
  | Some(d) =>
    let t = Domain.decodeString(Domain.dictValue(d, "ticker"), "")
    t == ""
      ? None
      : Some({
          ticker: t,
          tt: Domain.decodeFloat(Domain.dictValue(d, "tt"), 0.0),
          rs: Domain.decodeFloat(Domain.dictValue(d, "rs"), 0.0),
          vcp: Domain.decodeFloat(Domain.dictValue(d, "vcp"), 0.0),
        })
  | None => None
  }
let sampleBars: array<Domain.indexBar> = [
  {date: "2026-07-30", close: 2800.0, volume: 120000.0},
  {date: "2026-07-31", close: 2744.0, volume: 118000.0},
  {date: "2026-08-03", close: 2760.0, volume: 119000.0},
  {date: "2026-08-04", close: 2780.0, volume: 121000.0},
  {date: "2026-08-05", close: 2800.0, volume: 123000.0},
  {date: "2026-08-06", close: 2845.0, volume: 140000.0},
]

type holidayCalendar = {count: int, dates: array<string>}
type holidayStatus = Loading | Ready(holidayCalendar) | OfflineCached(holidayCalendar) | Unavailable
let holidayCacheKey = "atr-desk:holidays:last-valid"
let holidayData = (raw: string): option<holidayCalendar> =>
  try {
    let parsed = parseJson(raw)
    switch JSON.Decode.object(parsed) {
    | Some(root) =>
      let schemaOk = switch Dict.get(root, "schemaVersion") {
      | Some(value) => JSON.Decode.float(value)->Option.map(v => v == 1.0)->Option.getOr(false)
      | None => true
      }
      switch Dict.get(root, "holidays") {
      | Some(value) if schemaOk =>
        switch JSON.Decode.array(value) {
        | Some(rows) => {
            let dates = rows->Array.reduce([], (acc, row) =>
              switch JSON.Decode.object(row) {
              | Some(item) =>
                switch Dict.get(item, "date") {
                | Some(date) =>
                  switch JSON.Decode.string(date) {
                  | Some(value) =>
                    let normalized = value->String.trim
                    Domain.validISODate(normalized) ? acc->Array.concat([normalized]) : acc
                  | None => acc
                  }
                | None => acc
                }
              | None => acc
              }
            )
            rows->Array.length == 0 || dates->Array.length == rows->Array.length
              ? Some({count: dates->Array.length, dates})
              : None
          }
        | None => None
        }
      | _ => None
      }
    | None => None
    }
  } catch {
  | _ => None
  }
let holidayCount = (raw: string): option<int> => holidayData(raw)->Option.map(v => v.count)
let holidayLabel = (status: holidayStatus): (string, string) =>
  switch status {
  | Loading => ("Holidays: loading", "neutral")
  | Ready(calendar) => (`Holidays: ready (${calendar.count->Int.toString})`, "good")
  | OfflineCached(calendar) => (`Holidays: offline cache (${calendar.count->Int.toString})`, "warn")
  | Unavailable => ("Holidays: unavailable", "danger")
  }
let holidayFromCache = (setStatus: holidayStatus => unit) =>
  switch safeGet(holidayCacheKey) {
  | Some(raw) =>
    switch holidayData(raw) {
    | Some(calendar) => setStatus(OfflineCached(calendar))
    | None => setStatus(Unavailable)
    }
  | None => setStatus(Unavailable)
  }
let loadHolidays = (setStatus: holidayStatus => unit) => {
  setStatus(Loading)
  if Browser.online {
    let _ =
      Browser.fetch(`${Browser.baseUrl}holidays.json`)
      ->Promise.then(response =>
        Browser.ok(response) ? Browser.text(response) : Promise.resolve("")
      )
      ->Promise.thenResolve(raw =>
        switch holidayData(raw) {
        | Some(calendar) => {
            let _ = safeSet(holidayCacheKey, raw)
            setStatus(Ready(calendar))
          }
        | None => holidayFromCache(setStatus)
        }
      )
      ->Promise.catch(_ => {
        holidayFromCache(setStatus)
        Promise.resolve()
      })
  } else {
    holidayFromCache(setStatus)
  }
}

module Pill = {
  @react.component
  let make = (~text: string, ~tone: string="neutral") =>
    <span className={`pill pill-${tone}`}> {React.string(text)} </span>
}
module Metric = {
  @react.component
  let make = (~label: string, ~value: string) =>
    <div className="metric">
      <span> {React.string(label)} </span>
      <strong> {React.string(value)} </strong>
    </div>
}
module HolidayStatus = {
  @react.component
  let make = (~status: holidayStatus) => {
    let (text, tone) = holidayLabel(status)
    <div className="status-row holiday-status" role="status">
      <Pill text tone />
      <span className="muted">
        {React.string(
          status == Loading
            ? "Fetching the latest exchange calendar."
            : status == Unavailable
            ? "New entries stay blocked until a valid calendar is available."
            : "Network-first calendar with a last-valid local fallback.",
        )}
      </span>
    </div>
  }
}

module Intro = {
  @react.component
  let make = (~enter: unit => unit, ~settings: unit => unit) =>
    <section className="intro" ariaLabelledby="intro-title">
      <div className="ascii" ariaHidden={true}>
        {React.string(
          "┌──────────────────────────────┐\n│  ATR DESK / SIGNAL CONSOLE   │\n│  trend → risk → execution    │\n└──────────────────────────────┘",
        )}
      </div>
      <p className="eyebrow"> {React.string("// NEPSE · DISCRETIONARY MOMENTUM DESK")} </p>
      <h1 id="intro-title"> {React.string("Trend is the only edge.")} </h1>
      <p>
        {React.string(
          "A local-first cockpit for distribution risk, ATR-sized entries, and disciplined exits.",
        )}
      </p>
      <div className="intro-actions">
        <button className="primary" onClick={_ => enter()}>
          {React.string("Enter the desk ↘")}
        </button>
        <button className="quiet" onClick={_ => settings()}>
          {React.string("Account setup")}
        </button>
      </div>
    </section>
}

module Market = {
  @react.component
  let make = (~state: Domain.state, ~onParse: string => unit, ~onSample: unit => unit) => {
    let d = Domain.distributionSummary(state.indexBars)
    let tone = d.status == "normal" ? "good" : d.status == "caution" ? "warn" : "danger"
    let (text, setText) = React.useState(() => "")
    <section className="panel market" ariaLabelledby="market-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"> {React.string("01 / MARKET THROTTLE")} </p>
          <h2 id="market-heading"> {React.string("Distribution signal")} </h2>
        </div>
        <Pill text=d.status tone />
      </div>
      <div className="market-readout">
        <strong> {React.string(d.distributionDays->Int.toString)} </strong>
        <span>
          {React.string("distribution days")}
          <br />
          <small> {React.string("trailing 25 sessions")} </small>
        </span>
      </div>
      <p className="muted">
        {React.string(
          d.sufficientHistory
            ? "Market state is established."
            : "Upload at least two valid index sessions.",
        )}
      </p>
      <label className="field">
        <span> {React.string("Index CSV / paste")} </span>
        <textarea
          ariaLabel="Index CSV / paste"
          value=text
          onChange={e => setText(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="YYYY-MM-DD, close, volume"
        />
      </label>
      <div className="button-row">
        <button className="secondary" onClick={_ => onParse(text)}>
          {React.string("Parse index")}
        </button>
        <label className="secondary file-button">
          <span> {React.string("Upload CSV")} </span>
          <input
            ariaLabel="Upload index CSV"
            type_="file"
            accept=".csv,text/csv"
            onChange={e => readFile(e, onParse)}
          />
        </label>
        <button className="quiet" onClick={_ => onSample()}> {React.string("Load sample")} </button>
      </div>
      {d.status == "distribution"
        ? <div className="inline-alert danger" role="alert">
            {React.string("New entries blocked while distribution is elevated.")}
          </div>
        : React.null}
    </section>
  }
}

module Screener = {
  @react.component
  let make = (~state: Domain.state, ~onParse: string => unit, ~onUse: Domain.candidate => unit) => {
    let (text, setText) = React.useState(() => "")
    let all = state.screenerCandidates->Array.filterMap(candidate)
    let passing = Domain.filterCandidates(~mode="passing", all)
    <section className="panel screener" ariaLabelledby="screener-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"> {React.string("02 / SIGNAL BOARD")} </p>
          <h2 id="screener-heading"> {React.string("SEPA shortlist")} </h2>
        </div>
        <Pill text={`${passing->Array.length->Int.toString} passing`} tone="good" />
      </div>
      <p className="muted">
        {React.string("TT ≥ 75 and RS ≥ 75 pass; VCP ranks the shortlist.")}
      </p>
      <label className="field">
        <span> {React.string("Screener rows")} </span>
        <textarea
          ariaLabel="Screener rows"
          value=text
          onChange={e => setText(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="Ticker TT VCP ... RS"
        />
      </label>
      <button className="secondary" onClick={_ => onParse(text)}>
        {React.string("Parse screener")}
      </button>
      {passing->Array.length == 0
        ? <p className="empty"> {React.string("No passing candidates yet.")} </p>
        : <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th> {React.string("Ticker")} </th>
                  <th> {React.string("TT")} </th>
                  <th> {React.string("RS")} </th>
                  <th> {React.string("VCP")} </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {React.array(
                  passing->Array.map(c =>
                    <tr key={c.ticker}>
                      <td> {React.string(c.ticker)} </td>
                      <td> {React.string(c.tt->Float.toString)} </td>
                      <td> {React.string(c.rs->Float.toString)} </td>
                      <td> {React.string(c.vcp->Float.toString)} </td>
                      <td>
                        <button className="link" onClick={_ => onUse(c)}>
                          {React.string("Use")}
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>}
    </section>
  }
}

module Order = {
  @react.component
  let make = (
    ~state: Domain.state,
    ~candidate: option<Domain.candidate>,
    ~blocked: bool,
    ~holidayUnavailable: bool,
    ~holidayLoading: bool,
    ~sessionClosed: bool,
    ~place: (string, float, float, string, Domain.sizing) => unit,
  ) => {
    let (ticker, setTicker) = React.useState(() =>
      candidate->Option.map(c => c.ticker)->Option.getOr("")
    )
    let (tickerTouched, setTickerTouched) = React.useState(() => false)
    let (entryRaw, setEntry) = React.useState(() => "")
    let (atrRaw, setAtr) = React.useState(() => "")
    let (reason, setReason) = React.useState(() => "")
    React.useEffect1(() => {
      switch candidate {
      | Some(selected) if !tickerTouched => setTicker(_ => selected.ticker)
      | _ => ()
      }
      None
    }, [candidate])
    let entry = number(entryRaw)
    let atr = number(atrRaw)
    let availableCash = Domain.getPendingReservedCash(
      ~cashBalance=state.cashBalance,
      ~costs=state.transactionCosts,
      ~excludeTicker=None,
      ~orders=state.pendingOrders,
    )
    let size = Domain.calculatePosition(
      ~accountValue=state.accountValue,
      ~entry,
      ~atr,
      ~cashAvailable=availableCash,
    )
    let disabled =
      blocked ||
      holidayUnavailable ||
      holidayLoading ||
      sessionClosed ||
      ticker->String.trim == "" ||
      entry <= 0.0 ||
      atr <= 0.0 ||
      size.shares <= 0 ||
      !size.affordable ||
      size.minLotWarning
    <section className="panel order" ariaLabelledby="order-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"> {React.string("03 / EXECUTION PLAN")} </p>
          <h2 id="order-heading"> {React.string("Size an entry")} </h2>
        </div>
        <Pill text="1% max risk" />
      </div>
      <div className="form-grid">
        <label className="field">
          <span> {React.string("Ticker")} </span>
          <input
            ariaLabel="Ticker"
            value=ticker
            onChange={e => {
              setTickerTouched(_ => true)
              setTicker(_ => ReactEvent.Form.target(e)["value"])
            }}
            placeholder="NABIL"
          />
        </label>
        <label className="field">
          <span> {React.string("Planned entry")} </span>
          <input
            ariaLabel="Planned entry"
            value=entryRaw
            onChange={e => setEntry(_ => ReactEvent.Form.target(e)["value"])}
          />
        </label>
        <label className="field">
          <span> {React.string("ATR (14)")} </span>
          <input
            ariaLabel="ATR (14)"
            value=atrRaw
            onChange={e => setAtr(_ => ReactEvent.Form.target(e)["value"])}
          />
        </label>
      </div>
      <label className="field">
        <span> {React.string("Entry reason")} </span>
        <input
          ariaLabel="Entry reason"
          value=reason
          onChange={e => setReason(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="Breakout from tight VCP"
        />
      </label>
      <div className="calc-grid">
        <Metric label="Initial stop" value={fmt(size.stop)} />
        <Metric label="Risk / share" value={fmt(size.riskPerShare)} />
        <Metric label="Shares" value={size.shares->Int.toString} />
        <Metric label="Capital" value={fmt(size.requiredCapital)} />
      </div>
      {holidayLoading
        ? <div className="inline-alert warn" role="alert">
            {React.string(
              "Holiday calendar is loading; new entries remain blocked until it resolves.",
            )}
          </div>
        : holidayUnavailable
        ? <div className="inline-alert danger" role="alert">
          {React.string("Holiday calendar unavailable; new entries are blocked until it recovers.")}
        </div>
        : sessionClosed
        ? <div className="inline-alert warn" role="alert">
          {React.string(
            "Session closed: entries wait for a Kathmandu trading day and valid holiday calendar.",
          )}
        </div>
        : blocked
        ? <div className="inline-alert danger" role="alert">
          {React.string("Macro gate: index history is insufficient or in distribution.")}
        </div>
        : size.minLotWarning
        ? <div className="inline-alert warn" role="alert">
          {React.string("Minimum lot warning: size is below the exchange lot.")}
        </div>
        : React.null}
      <button
        className="primary"
        disabled=disabled
        onClick={_ => place(ticker->Domain.normalizeTicker, entry, atr, reason, size)}
      >
        {React.string(disabled ? "Resolve guards to place" : "Place pending order ↗")}
      </button>
    </section>
  }
}

module PendingRow = {
  @react.component
  let make = (
    ~order: Domain.pendingOrder,
    ~logDay: (string, string, float, float, option<(int, float)>) => unit,
    ~reprice: (string, float, float) => unit,
    ~cancel: (string, string, float, float) => unit,
  ) => {
    let (sessionDate, setSessionDate) = React.useState(() => today())
    let (sessionClose, setSessionClose) = React.useState(() => order.plannedEntry->Float.toString)
    let (sessionAtr, setSessionAtr) = React.useState(() => order.atr->Float.toString)
    let (fillShares, setFillShares) = React.useState(() =>
      (order.shares - order.filledShares)->Int.toString
    )
    let (fillPrice, setFillPrice) = React.useState(() => order.plannedEntry->Float.toString)
    let (repriceEntry, setRepriceEntry) = React.useState(() => order.plannedEntry->Float.toString)
    let (repriceAtr, setRepriceAtr) = React.useState(() => order.atr->Float.toString)
    let fill = if fillShares->String.trim == "" || fillPrice->String.trim == "" {
      None
    } else {
      Some((intNumber(fillShares), number(fillPrice)))
    }
    let sameDayLogged = order.lastLoggedISO == Some(sessionDate)
    <article className="position" key=order.ticker>
      <div>
        <strong> {React.string(order.ticker)} </strong>
        <span>
          {React.string(
            `${order.shares->Int.toString} shares @ ${order.plannedEntry->Float.toString}`,
          )}
        </span>
        <span>
          {React.string(
            `${order.filledShares->Int.toString}/${order.shares->Int.toString} filled · ${order.daysWaiting->Int.toString} daily attempt(s)`,
          )}
        </span>
        <span> {React.string(order.entryReason)} </span>
      </div>
      <div className="pending-actions">
        <div className="pending-fields">
          <input
            ariaLabel={`${order.ticker} session date`}
            type_="date"
            value=sessionDate
            onChange={e => setSessionDate(_ => ReactEvent.Form.target(e)["value"])}
          />
          <input
            ariaLabel={`${order.ticker} session close`}
            value=sessionClose
            onChange={e => setSessionClose(_ => ReactEvent.Form.target(e)["value"])}
            placeholder="Session close"
          />
          <input
            ariaLabel={`${order.ticker} session ATR`}
            value=sessionAtr
            onChange={e => setSessionAtr(_ => ReactEvent.Form.target(e)["value"])}
            placeholder="Session ATR"
          />
        </div>
        <div className="pending-fields">
          <input
            ariaLabel={`${order.ticker} fill shares`}
            value=fillShares
            onChange={e => setFillShares(_ => ReactEvent.Form.target(e)["value"])}
            placeholder="Fill shares"
          />
          <input
            ariaLabel={`${order.ticker} fill price`}
            value=fillPrice
            onChange={e => setFillPrice(_ => ReactEvent.Form.target(e)["value"])}
            placeholder="Fill price"
          />
          <button
            className="quiet"
            disabled=sameDayLogged
            onClick={_ =>
              logDay(order.ticker, sessionDate, number(sessionClose), number(sessionAtr), fill)}
          >
            {React.string(sameDayLogged ? "Session already logged" : "Log session")}
          </button>
        </div>
        <div className="pending-fields">
          <input
            ariaLabel={`${order.ticker} reprice entry`}
            value=repriceEntry
            onChange={e => setRepriceEntry(_ => ReactEvent.Form.target(e)["value"])}
            placeholder="New entry"
          />
          <input
            ariaLabel={`${order.ticker} reprice ATR`}
            value=repriceAtr
            onChange={e => setRepriceAtr(_ => ReactEvent.Form.target(e)["value"])}
            placeholder="New ATR"
          />
          <button
            className="quiet"
            onClick={_ => reprice(order.ticker, number(repriceEntry), number(repriceAtr))}
          >
            {React.string("Reprice")}
          </button>
        </div>
        <div className="button-row">
          <button
            className="quiet"
            disabled=sameDayLogged
            onClick={_ =>
              logDay(order.ticker, sessionDate, number(sessionClose), number(sessionAtr), None)}
          >
            {React.string("Log no-fill")}
          </button>
          <button
            className="quiet danger-text"
            onClick={_ =>
              cancel(order.ticker, sessionDate, number(sessionClose), number(sessionAtr))}
          >
            {React.string("Cancel")}
          </button>
        </div>
      </div>
    </article>
  }
}

module Pending = {
  @react.component
  let make = (
    ~state: Domain.state,
    ~logDay: (string, string, float, float, option<(int, float)>) => unit,
    ~reprice: (string, float, float) => unit,
    ~cancel: (string, string, float, float) => unit,
  ) =>
    <section className="panel pending" ariaLabelledby="pending-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"> {React.string("04 / ORDER LOG")} </p>
          <h2 id="pending-heading"> {React.string("Pending orders")} </h2>
        </div>
        <Pill text={`${state.pendingOrders->Array.length->Int.toString} waiting`} />
      </div>
      {state.pendingOrders->Array.length == 0
        ? <p className="empty"> {React.string("No pending orders.")} </p>
        : <div className="position-list">
            {React.array(
              state.pendingOrders->Array.map(o =>
                <PendingRow key=o.ticker order=o logDay reprice cancel />
              ),
            )}
          </div>}
    </section>
}

module ActiveRow = {
  @react.component
  let make = (
    ~trade: Domain.trade,
    ~update: (string, string, float, float) => unit,
    ~sell: (string, string, int, float, string) => unit,
  ) => {
    let (dateISO, setDateISO) = React.useState(() => today())
    let (closeRaw, setClose) = React.useState(() => "")
    let (atrRaw, setAtr) = React.useState(() => "")
    let (sellRaw, setSell) = React.useState(() => "")
    let (sharesRaw, setShares) = React.useState(() => "")
    let (reason, setReason) = React.useState(() => "")
    <article className="position" key=trade.ticker>
      <div>
        <strong> {React.string(trade.ticker)} </strong>
        <span>
          {React.string(
            `${trade.shares->Int.toString} shares · close ${trade.lastClose->Float.toString} · stop ${trade.trailingStop->Float.toString}`,
          )}
        </span>
        {trade.lastClose <= trade.trailingStop
          ? <span className="danger-text" role="alert">
              {React.string("EXIT SIGNAL — close below stop")}
            </span>
          : React.null}
      </div>
      <div className="trade-actions">
        <input
          ariaLabel={`${trade.ticker} update date`}
          type_="date"
          value=dateISO
          onChange={e => setDateISO(_ => ReactEvent.Form.target(e)["value"])}
        />
        <input
          ariaLabel={`${trade.ticker} close`}
          value=closeRaw
          onChange={e => setClose(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="Close"
        />
        <input
          ariaLabel={`${trade.ticker} ATR`}
          value=atrRaw
          onChange={e => setAtr(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="ATR"
        />
        <button
          className="quiet"
          onClick={_ => update(trade.ticker, dateISO, number(closeRaw), number(atrRaw))}
        >
          {React.string("Daily update")}
        </button>
        <input
          ariaLabel={`${trade.ticker} sale date`}
          type_="date"
          value=dateISO
          onChange={e => setDateISO(_ => ReactEvent.Form.target(e)["value"])}
        />
        <input
          ariaLabel={`${trade.ticker} sell shares`}
          value=sharesRaw
          onChange={e => setShares(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="Shares"
        />
        <input
          ariaLabel={`${trade.ticker} exit price`}
          value=sellRaw
          onChange={e => setSell(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="Exit price"
        />
        <input
          ariaLabel={`${trade.ticker} exit reason`}
          value=reason
          onChange={e => setReason(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="Exit reason"
        />
        <button
          className="secondary"
          onClick={_ => sell(trade.ticker, dateISO, intNumber(sharesRaw), number(sellRaw), reason)}
        >
          {React.string("Log sale")}
        </button>
      </div>
    </article>
  }
}

module Active = {
  @react.component
  let make = (
    ~state: Domain.state,
    ~update: (string, string, float, float) => unit,
    ~sell: (string, string, int, float, string) => unit,
  ) => {
    let rows = state.activeTrades->Array.map(t => <ActiveRow key=t.ticker trade=t update sell />)
    <section className="panel positions" ariaLabelledby="positions-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"> {React.string("05 / OPEN RISK")} </p>
          <h2 id="positions-heading"> {React.string("Active trades")} </h2>
        </div>
        <Pill text={`${state.activeTrades->Array.length->Int.toString} live`} tone="good" />
      </div>
      {state.activeTrades->Array.length == 0
        ? <p className="empty"> {React.string("No open positions.")} </p>
        : <div className="position-list"> {React.array(rows)} </div>}
    </section>
  }
}

module Dialog = {
  @react.component
  let make = (~visible: bool, ~title: string, ~onClose: unit => unit, ~children: React.element) => {
    let (previousFocus, setPreviousFocus) = React.useState(() => None)
    React.useEffect1(() => {
      if visible {
        setPreviousFocus(_ => activeElement)
        focusFirst()
        None
      } else {
        switch previousFocus {
        | Some(target) => focus(target)
        | None => ()
        }
        None
      }
    }, [visible])
    visible
      ? <div className="dialog-backdrop">
          <section
            className="dialog"
            role="dialog"
            ariaModal={true}
            ariaLabelledby="dialog-title"
            onKeyDown={e => {
              if ReactEvent.Keyboard.key(e) == "Escape" {
                ReactEvent.Keyboard.preventDefault(e)
                onClose()
              } else if ReactEvent.Keyboard.key(e) == "Tab" {
                let nodes = dialogFocusables()
                let first = nodeAt(nodes, 0)
                let last = nodeAt(nodes, nodeListLength(nodes) - 1)
                switch (activeElement, first, last, ReactEvent.Keyboard.shiftKey(e)) {
                | (Some(current), Some(target), Some(end), false) if current == end =>
                  ReactEvent.Keyboard.preventDefault(e)
                  focus(target)
                | (Some(current), Some(start), Some(target), true) if current == start =>
                  ReactEvent.Keyboard.preventDefault(e)
                  focus(target)
                | _ => ()
                }
              }
            }}
          >
            <div className="dialog-heading">
              <h2 id="dialog-title"> {React.string(title)} </h2>
              <button className="quiet" ariaLabel="Close" onClick={_ => onClose()}>
                {React.string("x")}
              </button>
            </div>
            {children}
          </section>
        </div>
      : React.null
  }
}

module AccountForm = {
  @react.component
  let make = (~state: Domain.state, ~save: (float, float, Domain.transactionCosts) => unit) => {
    let (account, setAccount) = React.useState(() => state.accountValue->Float.toString)
    let (cash, setCash) = React.useState(() => state.cashBalance->Float.toString)
    let (brokerage, setBrokerage) = React.useState(() =>
      state.transactionCosts.brokeragePct->Float.toString
    )
    let (regulatory, setRegulatory) = React.useState(() =>
      state.transactionCosts.regulatoryFeePct->Float.toString
    )
    let (dp, setDp) = React.useState(() => state.transactionCosts.dpChargePerSell->Float.toString)
    let (tax, setTax) = React.useState(() =>
      state.transactionCosts.capitalGainsTaxPct->Float.toString
    )
    <>
      <div className="form-grid">
        <label className="field">
          <span> {React.string("Account value")} </span>
          <input
            ariaLabel="Account value"
            value=account
            onChange={e => setAccount(_ => ReactEvent.Form.target(e)["value"])}
          />
        </label>
        <label className="field">
          <span> {React.string("Cash balance")} </span>
          <input
            ariaLabel="Cash balance"
            value=cash
            onChange={e => setCash(_ => ReactEvent.Form.target(e)["value"])}
          />
        </label>
      </div>
      <p className="eyebrow"> {React.string("Transaction costs")} </p>
      <div className="form-grid">
        <label className="field">
          <span> {React.string("Brokerage %")} </span>
          <input
            ariaLabel="Brokerage"
            value=brokerage
            onChange={e => setBrokerage(_ => ReactEvent.Form.target(e)["value"])}
          />
        </label>
        <label className="field">
          <span> {React.string("Regulatory %")} </span>
          <input
            ariaLabel="Regulatory"
            value=regulatory
            onChange={e => setRegulatory(_ => ReactEvent.Form.target(e)["value"])}
          />
        </label>
        <label className="field">
          <span> {React.string("DP sell charge")} </span>
          <input
            ariaLabel="DP sell charge"
            value=dp
            onChange={e => setDp(_ => ReactEvent.Form.target(e)["value"])}
          />
        </label>
        <label className="field">
          <span> {React.string("Capital gains %")} </span>
          <input
            ariaLabel="Capital gains"
            value=tax
            onChange={e => setTax(_ => ReactEvent.Form.target(e)["value"])}
          />
        </label>
      </div>
      <button
        className="primary"
        onClick={_ =>
          save(
            number(account),
            number(cash),
            {
              brokeragePct: number(brokerage),
              regulatoryFeePct: number(regulatory),
              dpChargePerSell: number(dp),
              capitalGainsTaxPct: number(tax),
            },
          )}
      >
        {React.string("Save account")}
      </button>
    </>
  }
}

module RecoveryForm = {
  @react.component
  let make = (
    ~state: Domain.state,
    ~import: string => unit,
    ~download: unit => unit,
    ~reset: unit => unit,
  ) => {
    let _ = state
    let (raw, setRaw) = React.useState(() => "")
    <>
      <p>
        {React.string(
          "Export the exact versioned atr-desk envelope or paste one back to restore. Invalid records leave your ledger untouched.",
        )}
      </p>
      <label className="field">
        <span> {React.string("Import envelope")} </span>
        <textarea
          ariaLabel="Import envelope"
          value=raw
          onChange={e => setRaw(_ => ReactEvent.Form.target(e)["value"])}
          placeholder="Paste atr-desk export JSON"
        />
      </label>
      <div className="button-row">
        <button className="primary" onClick={_ => import(raw)}> {React.string("Import")} </button>
        <label className="secondary file-button">
          <span> {React.string("Choose JSON")} </span>
          <input
            ariaLabel="Choose JSON backup"
            type_="file"
            accept="application/json,.json"
            onChange={e =>
              readFile(e, text => {
                setRaw(_ => text)
                import(text)
              })}
          />
        </label>
        <button className="secondary" onClick={_ => download()}>
          {React.string("Export JSON")}
        </button>
        <button className="quiet danger-text" onClick={_ => reset()}>
          {React.string("Reset all data")}
        </button>
      </div>
    </>
  }
}

@react.component
let make = () => {
  let (initial, source, loadNotice) = load()
  let reduce = (current: Domain.state, action: Reducer.action): Domain.state =>
    switch Reducer.reducer(current, action) {
    | Ok(next) => next
    | Error(_) => current
    }
  let (state, dispatch) = React.useReducer(reduce, initial)
  let (intro, setIntro) = React.useState(() => safeGet("atr-desk:intro-complete") != Some("1"))
  let (theme, setTheme) = React.useState(() => safeGet("atr-desk:theme")->Option.getOr("dark"))
  let (settings, setSettings) = React.useState(() => false)
  let (recovery, setRecovery) = React.useState(() => safeGet("atr-desk:open-recovery") == Some("1"))
  let (confirmReset, setConfirmReset) = React.useState(() => false)
  let (candidateUsed, setCandidate) = React.useState(() => None)
  let (holidayState, setHolidayState) = React.useState(() => Loading)
  let (storageFailure, setStorageFailure) = React.useState(() => None)
  let (notice, setNotice) = React.useState(() =>
    loadNotice != ""
      ? loadNotice
      : source == "legacy"
      ? "Migrated legacy ledger."
      : source == "recovery" || source == "backup"
      ? "Recovered from a rolling backup."
      : ""
  )
  React.useEffect0(() => {
    if source == "legacy" {
      switch persist(initial) {
      | Saved => ()
      | Failed(error) => setStorageFailure(_ => Some(error))
      }
      safeRemove("atr-desk:open-recovery")
    }
    loadHolidays(status => setHolidayState(_ => status))
    None
  })
  let commit = (a: Reducer.action): bool => {
    switch Reducer.reducer(state, a) {
    | Error(error) => {
        setNotice(_ => reducerErrorLabel(error))
        false
      }
    | Ok(next) => {
        dispatch(a)
        switch persist(next) {
        | Saved => setStorageFailure(_ => None)
        | Failed(error) => setStorageFailure(_ => Some(error))
        }
        true
      }
    }
  }
  let enter = () => {
    let _ = safeSet("atr-desk:intro-complete", "1")
    setIntro(_ => false)
  }
  let toggle = () => {
    let t = theme == "dark" ? "light" : "dark"
    let _ = safeSet("atr-desk:theme", t)
    setTheme(_ => t)
  }
  let performReset = () => {
    Storage.resetStorageKeys()->Array.forEach(safeRemove)
    let _ = commit(Reducer.Reset)
    setIntro(_ => true)
    setRecovery(_ => false)
    setConfirmReset(_ => false)
    setNotice(_ => "All local desk data reset.")
  }
  let requestReset = () => setConfirmReset(_ => true)
  let parseIndex = (text: string) => {
    let p = Domain.parsePastedIndexBars(text)
    if commit(Reducer.SetIndexBars(p.bars)) {
      setNotice(_ =>
        `${p.bars
          ->Array.length
          ->Int.toString} index sessions parsed (${p.skippedCount->Int.toString} skipped).`
      )
    }
  }
  let parseScreen = (text: string) => {
    let p = Domain.parsePastedScreenerText(text)
    if commit(Reducer.SetCandidates(p.results)) {
      setNotice(_ => `${p.results->Array.length->Int.toString} candidates imported.`)
    }
  }
  let place = (ticker: string, entry: float, atr: float, reason: string, size: Domain.sizing) => {
    let o: Domain.pendingOrder = {
      ticker,
      plannedEntry: entry,
      plannedStop: size.stop,
      atr,
      shares: size.shares,
      filledShares: 0,
      filledValue: 0.0,
      filledCost: 0.0,
      daysWaiting: 0,
      placedDate: Domain.displayDate(today()),
      placedISO: Some(today()),
      firstFillDate: "",
      firstFillISO: None,
      fillLog: [],
      lastLoggedDate: Domain.displayDate(today()),
      lastLoggedISO: None,
      accountValueAtEntry: state.accountValue,
      entryReason: reason,
      transactionCostsApplied: state.transactionCostsConfigured,
    }
    if commit(Reducer.AddPending(o)) {
      setNotice(_ => `${ticker} pending order logged.`)
    }
  }
  let logDay = (
    ticker: string,
    dateISO: string,
    close: float,
    atr: float,
    fill: option<(int, float)>,
  ) => {
    if commit(Reducer.LogPendingDay(ticker, dateISO, close, atr, fill)) {
      setNotice(_ =>
        fill == None ? `${ticker} no-fill attempt logged.` : `${ticker} session and fill recorded.`
      )
    }
  }
  let update = (ticker: string, dateISO: string, close: float, atr: float) => {
    if commit(Reducer.DailyUpdate(ticker, dateISO, close, atr)) {
      setNotice(_ => `${ticker} daily update logged.`)
    }
  }
  let sell = (ticker: string, dateISO: string, shares: int, price: float, reason: string) => {
    if commit(Reducer.SellOn(ticker, dateISO, shares, price, reason)) {
      setNotice(_ => `${ticker} sale logged.`)
    }
  }
  let cancelPending = (ticker: string, dateISO: string, close: float, atr: float) => {
    let action = switch state.pendingOrders->Array.find(o =>
      o.ticker == Domain.normalizeTicker(ticker)
    ) {
    | Some(order) if order.filledShares > 0 => Reducer.CancelPendingOn(ticker, dateISO, close, atr)
    | _ => Reducer.CancelPending(ticker)
    }
    if commit(action) {
      setNotice(_ => `${ticker} pending order cancelled.`)
    }
  }
  let reprice = (ticker: string, entry: float, atr: float) => {
    if commit(Reducer.RepricePending(ticker, entry, atr)) {
      setNotice(_ => `${ticker} pending order repriced.`)
    }
  }
  let saveAccount = (account: float, cash: float, costs: Domain.transactionCosts) => {
    let next = {
      ...state,
      accountValue: account,
      cashBalance: Domain.max0(cash),
      transactionCosts: costs,
      transactionCostsConfigured: true,
    }
    if commit(Reducer.ReplaceState(next)) {
      setSettings(_ => false)
      setNotice(_ => "Account and transaction costs saved.")
    }
  }
  let importState = (raw: string) =>
    switch Storage.deserializeState(raw) {
    | Some(next) =>
      if commit(Reducer.ReplaceState(next)) {
        setRecovery(_ => false)
        setNotice(_ => "Import complete. Versioned envelope restored.")
      }
    | None => setNotice(_ => "Import rejected: invalid atr-desk envelope.")
    }
  if intro {
    <div className={`app theme-${theme}`}>
      <Intro enter settings={_ => setSettings(_ => true)} />
      <Pwa />
      <Dialog visible=settings title="Account & costs" onClose={_ => setSettings(_ => false)}>
        <AccountForm state save=saveAccount />
      </Dialog>
      <Dialog
        visible=confirmReset title="Reset all local data" onClose={_ => setConfirmReset(_ => false)}
      >
        <p>
          {React.string(
            "This permanently clears the primary ledger, recovery, backup, and legacy keys from this device.",
          )}
        </p>
        <div className="button-row">
          <button className="quiet" onClick={_ => setConfirmReset(_ => false)}>
            {React.string("Keep my data")}
          </button>
          <button className="primary danger-button" onClick={_ => performReset()}>
            {React.string("Erase all local data")}
          </button>
        </div>
      </Dialog>
    </div>
  } else {
    let gate = Domain.macroGateStatus(state.indexBars)
    let sessionDate = today()
    let sessionClosed = switch holidayState {
    | Ready(calendar) | OfflineCached(calendar) =>
      !Domain.tradingDay(sessionDate) || calendar.dates->Array.some(date => date == sessionDate)
    | Loading => !Domain.tradingDay(sessionDate)
    | Unavailable => !Domain.tradingDay(sessionDate)
    }
    <div className={`app theme-${theme}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"> {React.string("↗")} </span>
          <div>
            <strong> {React.string("ATR Desk")} </strong>
            <small> {React.string("NEPSE / MOMENTUM TRACKER")} </small>
          </div>
        </div>
        <div className="header-metrics">
          <Metric label="Equity" value={fmt(state.accountValue)} />
          <Metric label="Cash" value={fmt(state.cashBalance)} />
          <Metric
            label="Slots"
            value={`${(state.activeTrades->Array.length + state.pendingOrders->Array.length)
                ->Int.toString}/5`}
          />
        </div>
        <nav>
          <button className="quiet" ariaLabel="Toggle theme" onClick={_ => toggle()}>
            {React.string(theme == "dark" ? "☼" : "☾")}
          </button>
          <button className="quiet" onClick={_ => setSettings(_ => true)}>
            {React.string("Account")}
          </button>
          <button className="quiet" onClick={_ => setRecovery(_ => true)}>
            {React.string("Backup")}
          </button>
          <button className="quiet" onClick={_ => requestReset()}> {React.string("Reset")} </button>
        </nav>
      </header>
      <Pwa />
      <main className="desk">
        <aside>
          <div className="rail-note"> {React.string("LOCAL-FIRST / KATHMANDU")} </div>
        </aside>
        <div className="content">
          <div className="desk-intro">
            <div>
              <p className="eyebrow"> {React.string("SIGNAL DESK / DAILY LOOP")} </p>
              <h1> {React.string("Earn your slot.")} </h1>
            </div>
            <p>
              {React.string(
                "Read the tape, size with ATR, log the close. The desk keeps the math visible and the data on this device.",
              )}
            </p>
          </div>
          <HolidayStatus status=holidayState />
          <div className="notice" role="status">
            {React.string(
              "Offline-ready shell • PWA updates prompt when a new build is available.",
            )}
          </div>
          {notice != ""
            ? <div className="notice" role="status"> {React.string(notice)} </div>
            : React.null}
          {switch storageFailure {
          | Some(error) =>
            <div className="notice danger-notice" role="alert">
              <span> {React.string(storageErrorLabel(error))} </span>
              <button className="quiet" onClick={_ => setRecovery(_ => true)}>
                {React.string("Open recovery")}
              </button>
            </div>
          | None => React.null
          }}
          <div className="grid">
            <Market
              state
              onParse=parseIndex
              onSample={_ => {
                if commit(Reducer.SetIndexBars(sampleBars)) {
                  setNotice(_ => "Sample tape loaded.")
                }
              }}
            />
            <Screener state onParse=parseScreen onUse={c => setCandidate(_ => Some(c))} />
            <Order
              state
              candidate=candidateUsed
              blocked=gate.blocked
              holidayUnavailable={switch holidayState {
              | Unavailable | Loading => true
              | _ => false
              }}
              holidayLoading={switch holidayState {
              | Loading => true
              | _ => false
              }}
              sessionClosed
              place
            />
            <Pending state logDay reprice cancel=cancelPending />
            <Active state update sell />
            <section className="panel history">
              <div className="panel-heading">
                <h2> {React.string("Closed trades")} </h2>
                <Pill text={`${state.history->Array.length->Int.toString} archived`} />
              </div>
              {state.history->Array.length == 0
                ? <p className="empty">
                    {React.string("Completed exits will appear here with net P/L and reasons.")}
                  </p>
                : <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th> {React.string("Ticker")} </th>
                          <th> {React.string("Exit")} </th>
                          <th> {React.string("Net P/L")} </th>
                        </tr>
                      </thead>
                      <tbody>
                        {React.array(
                          state.history->Array.map(h =>
                            <tr key={`${h.ticker}-${h.exitDate}`}>
                              <td> {React.string(h.ticker)} </td>
                              <td> {React.string(h.exitDate)} </td>
                              <td className={h.netPnl >= 0.0 ? "positive" : "danger-text"}>
                                {React.string(fmt(h.netPnl))}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>}
            </section>
          </div>
        </div>
      </main>
      <Dialog visible=settings title="Account & costs" onClose={_ => setSettings(_ => false)}>
        <AccountForm state save=saveAccount />
      </Dialog>
      <Dialog visible=recovery title="Backup & recovery" onClose={_ => setRecovery(_ => false)}>
        <RecoveryForm
          state import=importState download={_ => downloadExport(state)} reset=requestReset
        />
      </Dialog>
      <Dialog
        visible=confirmReset title="Reset all local data" onClose={_ => setConfirmReset(_ => false)}
      >
        <p>
          {React.string(
            "This permanently clears the primary ledger, recovery, backup, and legacy keys from this device.",
          )}
        </p>
        <div className="button-row">
          <button className="quiet" onClick={_ => setConfirmReset(_ => false)}>
            {React.string("Keep my data")}
          </button>
          <button className="primary danger-button" onClick={_ => performReset()}>
            {React.string("Erase all local data")}
          </button>
        </div>
      </Dialog>
    </div>
  }
}
