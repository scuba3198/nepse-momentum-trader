/* Typed, pure strategy domain. JSON is decoded only at the persistence edge. */
open RescriptCore

type transactionCosts = {
  brokeragePct: float,
  regulatoryFeePct: float,
  dpChargePerSell: float,
  capitalGainsTaxPct: float,
}
type indexBar = {date: string, close: float, volume: float}
type candidate = {ticker: string, tt: float, rs: float, vcp: float}
type fill = {dateISO: string, date: string, shares: int, price: float}
type tradeUpdate = {dateISO: string, date: string, close: float, atr: float, trailingStop: float}

type pendingOrder = {
  ticker: string,
  plannedEntry: float,
  plannedStop: float,
  atr: float,
  shares: int,
  filledShares: int,
  filledValue: float,
  filledCost: float,
  daysWaiting: int,
  placedDate: string,
  placedISO: option<string>,
  firstFillDate: string,
  firstFillISO: option<string>,
  fillLog: array<fill>,
  lastLoggedDate: string,
  lastLoggedISO: option<string>,
  accountValueAtEntry: float,
  entryReason: string,
  transactionCostsApplied: bool,
}

type trade = {
  ticker: string,
  plannedEntry: float,
  actualPrice: float,
  shares: int,
  initialAtr: float,
  initialStop: float,
  replayStopFloor: float,
  trailingStop: float,
  highestClose: float,
  lastClose: float,
  lastAtr: option<float>,
  entryDate: string,
  entryISO: option<string>,
  lastUpdatedDate: string,
  lastUpdatedISO: option<string>,
  accountValueAtEntry: float,
  entryReason: string,
  exitReasonDraft: string,
  soldShares: int,
  soldValue: float,
  soldNetValue: float,
  entryShares: int,
  entryGrossValue: float,
  entryCost: float,
  transactionCostsApplied: bool,
  updateLog: array<tradeUpdate>,
}

type historyItem = {
  ticker: string,
  entryPrice: float,
  entryDate: string,
  entryISO: option<string>,
  exitPrice: float,
  exitDate: string,
  exitISO: option<string>,
  shares: int,
  totalRisk: float,
  actualRiskPct: option<float>,
  pnl: float,
  returnPct: float,
  netPnl: float,
  grossPnl: float,
  netEntryCost: float,
  netExitValue: float,
  pnlBasis: string,
  transactionCostsApplied: bool,
  entryReason: string,
  exitReason: string,
}

/* App.res intentionally keeps these two collections JSON-shaped while the
 * persistence core decodes each element into typed records. */
type state = {
  accountValue: float,
  cashBalance: float,
  realizedPnl: float,
  transactionCosts: transactionCosts,
  transactionCostsConfigured: bool,
  indexBars: array<JSON.t>,
  pendingOrders: array<pendingOrder>,
  activeTrades: array<trade>,
  history: array<historyItem>,
  screenerCandidates: array<JSON.t>,
}
type dropCounts = {pendingOrders: int, activeTrades: int, history: int, duplicateTickers: int}
type normalization = {
  state: state,
  dropped: dropCounts,
  droppedPending: int,
  droppedActive: int,
  droppedHistory: int,
  duplicateTickers: int,
}
type distribution = {
  distributionDays: int,
  status: string,
  sufficientHistory: bool,
  followThroughDay: bool,
}
type distributionDetails = {
  count: int,
  level: string,
  flagged: array<indexBar>,
  ftdDate: option<string>,
  marketState: string,
}
type sizing = {
  stop: float,
  riskPerShare: float,
  maxRisk: float,
  shares: int,
  requiredCapital: float,
  minLotWarning: bool,
  affordable: bool,
}
type liquidity = {avg: float, min: float, max: float, count: int}
type macroGate = {blocked: bool, count: int, level: string, insufficientHistory: bool}
type fillCheck = {ok: bool, required: float, available: float}
type exitAccounting = {
  totalSharesSold: int,
  totalCost: float,
  totalRevenue: float,
  netRevenue: float,
  netEntryCost: float,
  grossPnl: float,
  pnl: float,
  returnPct: float,
  avgExitPrice: float,
}
type parsedIndexBars = {bars: array<indexBar>, skippedCount: int}
type parsedScreener = {results: array<candidate>, skipped: array<string>}
type flaggedBar = {bar: indexBar, index: int}
type replayAccumulator = {highest: float, stop: float, rebuilt: array<tradeUpdate>}

let portfolioSlots = 5
let atrMultiplier = 2.5
let riskPerPositionPct = 0.01
let minLotSize = 10
let maxDayOrderAttempts = 5
let storageKey = "atr-desk:state:v2"
let legacyStorageKey = "nepse_efficient_trader_state"
let storageVersion = 2
let exportSchemaVersion = 1
let portfolioSlotCount = portfolioSlots
let storageKeyValue = storageKey

let round2 = (value: float): float => Math.floor(value *. 100.0 +. 0.5) /. 100.0
let max0 = (value: float): float => Math.max(0.0, value)
let finite = (value: float): bool => Float.isFinite(value)
let floorInt = (value: float): int => Math.floor(value)->Int.fromFloat
let validISODate = (value: string): bool => {
  if (
    String.length(value) != 10 ||
    String.getUnsafe(value, 4) != "-" ||
    String.getUnsafe(value, 7) != "-"
  ) {
    false
  } else {
    switch (
      value->String.slice(~start=0, ~end=4)->Int.fromString,
      value->String.slice(~start=5, ~end=7)->Int.fromString,
      value->String.slice(~start=8, ~end=10)->Int.fromString,
    ) {
    | (Some(y), Some(m), Some(d)) if m >= 1 && m <= 12 && d >= 1 && d <= 31 =>
      let x = Date.makeWithYMD(~year=y, ~month=m - 1, ~date=d)
      Date.getFullYear(x) == y && Date.getMonth(x) == m - 1 && Date.getDate(x) == d
    | _ => false
    }
  }
}
let displayDate = (iso: string): string =>
  validISODate(iso)
    ? iso->String.slice(~start=8, ~end=10) ++
      "/" ++
      iso->String.slice(~start=5, ~end=7) ++
      "/" ++
      iso->String.slice(~start=0, ~end=4)
    : ""
let normalizeTicker = (value: string): string => value->String.trim->String.toUpperCase
let defaultCosts: transactionCosts = {
  brokeragePct: 0.0,
  regulatoryFeePct: 0.0,
  dpChargePerSell: 0.0,
  capitalGainsTaxPct: 0.0,
}
let defaultState = (): state => {
  accountValue: 1000000.0,
  cashBalance: 1000000.0,
  realizedPnl: 0.0,
  transactionCosts: defaultCosts,
  transactionCostsConfigured: false,
  indexBars: [],
  pendingOrders: [],
  activeTrades: [],
  history: [],
  screenerCandidates: [],
}

let jsonObject = (entries: array<(string, JSON.t)>): JSON.t =>
  Dict.fromArray(entries)->JSON.Encode.object
let jsonString = (x: string): JSON.t => JSON.Encode.string(x)
let jsonFloat = (x: float): JSON.t => JSON.Encode.float(x)
let jsonInt = (x: int): JSON.t => JSON.Encode.int(x)
let jsonBool = (x: bool): JSON.t => JSON.Encode.bool(x)
let jsonNull: JSON.t = JSON.Encode.null
let decodeObject = (value: JSON.t): option<Dict.t<JSON.t>> => JSON.Decode.object(value)
let dictValue = (d: Dict.t<JSON.t>, key: string): option<JSON.t> => Dict.get(d, key)
let decodeString = (value: option<JSON.t>, fallback: string): string =>
  switch value {
  | Some(v) => JSON.Decode.string(v)->Option.getOr(fallback)
  | None => fallback
  }
let decodeFloat = (value: option<JSON.t>, fallback: float): float =>
  switch value {
  | Some(v) =>
    switch JSON.Decode.float(v) {
    | Some(n) if finite(n) => n
    | _ =>
      switch JSON.Decode.string(v) {
      | Some(s) =>
        switch Float.parseFloat(s) {
        | n if finite(n) => n
        | _ => fallback
        }
      | None => fallback
      }
    }
  | None => fallback
  }
let decodeBool = (value: option<JSON.t>, fallback: bool): bool =>
  switch value {
  | Some(v) => JSON.Decode.bool(v)->Option.getOr(fallback)
  | None => fallback
  }
let decodeArray = (value: option<JSON.t>): array<JSON.t> =>
  switch value {
  | Some(v) => JSON.Decode.array(v)->Option.getOr([])
  | None => []
  }

let normalizeCosts = (raw: option<JSON.t>): transactionCosts => {
  let obj = switch raw {
  | Some(v) => decodeObject(v)
  | None => None
  }
  let get = (key, fallback) =>
    switch obj {
    | Some(d) => decodeFloat(dictValue(d, key), fallback)
    | None => fallback
    }
  {
    brokeragePct: Math.min(100.0, max0(get("brokeragePct", 0.0))),
    regulatoryFeePct: Math.min(100.0, max0(get("regulatoryFeePct", 0.0))),
    dpChargePerSell: max0(get("dpChargePerSell", 0.0)),
    capitalGainsTaxPct: Math.min(100.0, max0(get("capitalGainsTaxPct", 0.0))),
  }
}
let buyNetCost = (~gross: float, ~costs: transactionCosts=defaultCosts): float => {
  let x = max0(gross)
  round2(x +. x *. (max0(costs.brokeragePct) +. max0(costs.regulatoryFeePct)) /. 100.0)
}
let sellNetProceeds = (
  ~gross: float,
  ~basis: float,
  ~costs: transactionCosts=defaultCosts,
): float => {
  let x = max0(gross)
  let fees =
    x *. (max0(costs.brokeragePct) +. max0(costs.regulatoryFeePct)) /. 100.0 +.
    max0(costs.dpChargePerSell) +.
    max0(x -. max0(basis)) *. max0(costs.capitalGainsTaxPct) /. 100.0
  round2(max0(x -. fees))
}
let calculatePosition = (
  ~accountValue: float,
  ~entry: float,
  ~atr: float,
  ~cashAvailable: float=1e30,
): sizing => {
  let stop = entry -. atrMultiplier *. atr
  let risk = max0(entry -. stop)
  let maxRisk = max0(accountValue) *. riskPerPositionPct
  let shares = risk > 0.0 ? floorInt(maxRisk /. risk) : 0
  let required = buyNetCost(~gross=shares->Int.toFloat *. max0(entry))
  {
    stop: round2(stop),
    riskPerShare: round2(risk),
    maxRisk: round2(maxRisk),
    shares,
    requiredCapital: required,
    minLotWarning: shares > 0 && shares < minLotSize,
    affordable: required <= max0(cashAvailable),
  }
}

let indexBarFromJson = (value: JSON.t): option<indexBar> =>
  switch decodeObject(value) {
  | Some(d) =>
    let date = decodeString(dictValue(d, "date"), decodeString(dictValue(d, "dateISO"), ""))
    let close = decodeFloat(dictValue(d, "close"), 0.0)
    let volume = decodeFloat(dictValue(d, "volume"), 0.0)
    validISODate(date) && close > 0.0 && volume >= 0.0 ? Some({date, close, volume}) : None
  | None => None
  }
let indexBarJson = (bar: indexBar): JSON.t =>
  jsonObject([
    ("date", jsonString(bar.date)),
    ("dateISO", jsonString(bar.date)),
    ("close", jsonFloat(bar.close)),
    ("volume", jsonFloat(bar.volume)),
  ])
let normalizeIndexBars = (rawBars: array<JSON.t>): array<indexBar> => {
  let byDate: Dict.t<indexBar> = Dict.make()
  rawBars->Array.forEach(v =>
    switch indexBarFromJson(v) {
    | Some(b) => byDate->Dict.set(b.date, b)
    | None => ()
    }
  )
  byDate->Dict.valuesToArray->Array.toSorted((a, b) => String.compare(a.date, b.date))
}

let parseFill = (value: JSON.t): option<fill> =>
  switch decodeObject(value) {
  | Some(d) =>
    let iso = decodeString(dictValue(d, "dateISO"), "")
    let date = decodeString(dictValue(d, "date"), displayDate(iso))
    let shares = floorInt(decodeFloat(dictValue(d, "shares"), 0.0))
    let price = decodeFloat(dictValue(d, "price"), 0.0)
    validISODate(iso) && shares > 0 && price > 0.0
      ? Some({dateISO: iso, date, shares, price})
      : None
  | None => None
  }
let encodeFill = (f: fill): JSON.t =>
  jsonObject([
    ("dateISO", jsonString(f.dateISO)),
    ("date", jsonString(f.date)),
    ("shares", jsonInt(f.shares)),
    ("price", jsonFloat(f.price)),
  ])

let parsePending = (value: JSON.t, accountValue: float): option<pendingOrder> =>
  switch decodeObject(value) {
  | Some(d) =>
    let ticker = normalizeTicker(decodeString(dictValue(d, "ticker"), ""))
    let plannedEntry = decodeFloat(dictValue(d, "plannedEntry"), 0.0)
    let atr = decodeFloat(dictValue(d, "atr"), 0.0)
    let shares = floorInt(decodeFloat(dictValue(d, "shares"), 0.0))
    if ticker == "" || plannedEntry <= 0.0 || atr <= 0.0 || shares <= 0 {
      None
    } else {
      let filledShares = {
        let n = floorInt(decodeFloat(dictValue(d, "filledShares"), 0.0))
        n < 0 ? 0 : n > shares ? shares : n
      }
      let filledValue = decodeFloat(dictValue(d, "filledValue"), 0.0)
      if filledShares > 0 && filledValue <= 0.0 {
        None
      } else {
        let filledCost =
          filledShares > 0
            ? Math.max(filledValue, decodeFloat(dictValue(d, "filledCost"), filledValue))
            : 0.0
        let fallbackStop = plannedEntry -. atrMultiplier *. atr
        let plannedStop = Math.max(0.01, decodeFloat(dictValue(d, "plannedStop"), fallbackStop))
        let placedISO = decodeString(dictValue(d, "placedISO"), "")
        let firstFillISO = decodeString(
          dictValue(d, "firstFillISO"),
          decodeString(dictValue(d, "fillDateISO"), ""),
        )
        let lastLoggedISO = decodeString(dictValue(d, "lastLoggedISO"), "")
        let fills = decodeArray(dictValue(d, "fillLog"))->Array.filterMap(parseFill)
        let firstFillISO = if validISODate(firstFillISO) {
          Some(firstFillISO)
        } else {
          fills->Array.get(0)->Option.map(f => f.dateISO)
        }
        let placedISO = validISODate(placedISO) ? Some(placedISO) : None
        let lastLoggedISO = validISODate(lastLoggedISO) ? Some(lastLoggedISO) : None
        let waitingRaw = floorInt(decodeFloat(dictValue(d, "daysWaiting"), 0.0))
        let daysWaiting =
          waitingRaw < 0 ? 0 : waitingRaw > maxDayOrderAttempts ? maxDayOrderAttempts : waitingRaw
        Some({
          ticker,
          plannedEntry,
          plannedStop,
          atr,
          shares,
          filledShares,
          filledValue: filledShares > 0 ? filledValue : 0.0,
          filledCost,
          daysWaiting,
          placedDate: decodeString(
            dictValue(d, "placedDate"),
            placedISO->Option.map(displayDate)->Option.getOr(""),
          ),
          placedISO,
          firstFillDate: decodeString(
            dictValue(d, "firstFillDate"),
            firstFillISO->Option.map(displayDate)->Option.getOr(""),
          ),
          firstFillISO,
          fillLog: fills,
          lastLoggedDate: decodeString(
            dictValue(d, "lastLoggedDate"),
            lastLoggedISO->Option.map(displayDate)->Option.getOr(""),
          ),
          lastLoggedISO,
          accountValueAtEntry: max0(decodeFloat(dictValue(d, "accountValueAtEntry"), accountValue)),
          entryReason: decodeString(dictValue(d, "entryReason"), "")->String.trim,
          transactionCostsApplied: Dict.get(d, "filledCost")->Option.isSome,
        })
      }
    }
  | None => None
  }
let encodePending = (o: pendingOrder): JSON.t =>
  jsonObject([
    ("ticker", jsonString(o.ticker)),
    ("plannedEntry", jsonFloat(o.plannedEntry)),
    ("plannedStop", jsonFloat(o.plannedStop)),
    ("atr", jsonFloat(o.atr)),
    ("shares", jsonInt(o.shares)),
    ("filledShares", jsonInt(o.filledShares)),
    ("filledValue", jsonFloat(o.filledValue)),
    ("filledCost", jsonFloat(o.filledCost)),
    ("daysWaiting", jsonInt(o.daysWaiting)),
    ("placedDate", jsonString(o.placedDate)),
    ("placedISO", o.placedISO->Option.map(jsonString)->Option.getOr(jsonNull)),
    ("firstFillDate", jsonString(o.firstFillDate)),
    ("firstFillISO", o.firstFillISO->Option.map(jsonString)->Option.getOr(jsonNull)),
    ("fillLog", o.fillLog->Array.map(encodeFill)->JSON.Encode.array),
    ("lastLoggedDate", jsonString(o.lastLoggedDate)),
    ("lastLoggedISO", o.lastLoggedISO->Option.map(jsonString)->Option.getOr(jsonNull)),
    ("accountValueAtEntry", jsonFloat(o.accountValueAtEntry)),
    ("entryReason", jsonString(o.entryReason)),
    ("transactionCostsApplied", jsonBool(o.transactionCostsApplied)),
  ])

let parseUpdate = (value: JSON.t): option<tradeUpdate> =>
  switch decodeObject(value) {
  | Some(d) =>
    let iso = decodeString(dictValue(d, "dateISO"), "")
    let date = decodeString(dictValue(d, "date"), displayDate(iso))
    let close = decodeFloat(dictValue(d, "close"), 0.0)
    let atr = decodeFloat(dictValue(d, "atr"), 0.0)
    validISODate(iso) && close > 0.0 && atr > 0.0
      ? Some({
          dateISO: iso,
          date,
          close,
          atr,
          trailingStop: decodeFloat(dictValue(d, "trailingStop"), 0.0),
        })
      : None
  | None => None
  }
let encodeUpdate = (u: tradeUpdate): JSON.t =>
  jsonObject([
    ("dateISO", jsonString(u.dateISO)),
    ("date", jsonString(u.date)),
    ("close", jsonFloat(u.close)),
    ("atr", jsonFloat(u.atr)),
    ("trailingStop", jsonFloat(u.trailingStop)),
  ])

let recomputeTradeFromUpdateLog = (trade: trade): trade => {
  let unique: Dict.t<tradeUpdate> = Dict.make()
  trade.updateLog->Array.forEach(u =>
    if validISODate(u.dateISO) && u.close > 0.0 && u.atr > 0.0 {
      unique->Dict.set(u.dateISO, u)
    }
  )
  let ordered =
    unique->Dict.valuesToArray->Array.toSorted((a, b) => String.compare(a.dateISO, b.dateISO))
  let floor = Math.max(trade.initialStop, trade.replayStopFloor)
  let initial: replayAccumulator = {highest: trade.actualPrice, stop: floor, rebuilt: []}
  let result = ordered->Array.reduce(initial, (acc, u) => {
    let high = Math.max(acc.highest, u.close)
    let nextStop = Math.max(acc.stop, high -. atrMultiplier *. u.atr)
    {
      highest: high,
      stop: nextStop,
      rebuilt: acc.rebuilt->Array.concat([{...u, trailingStop: round2(nextStop)}]),
    }
  })
  let highest = result.highest
  let stop = result.stop
  let rebuilt = result.rebuilt
  let latest = rebuilt->Array.get(rebuilt->Array.length - 1)
  {
    ...trade,
    updateLog: rebuilt,
    highestClose: round2(highest),
    trailingStop: round2(stop),
    lastClose: latest->Option.map(u => u.close)->Option.getOr(trade.lastClose),
    lastAtr: latest->Option.map(u => u.atr),
    lastUpdatedISO: latest->Option.map(u => u.dateISO),
    lastUpdatedDate: latest->Option.map(u => u.date)->Option.getOr(trade.lastUpdatedDate),
  }
}

let parseTrade = (value: JSON.t, accountValue: float): option<trade> =>
  switch decodeObject(value) {
  | Some(d) =>
    let ticker = normalizeTicker(decodeString(dictValue(d, "ticker"), ""))
    let actualPrice = decodeFloat(dictValue(d, "actualPrice"), 0.0)
    let shares = floorInt(decodeFloat(dictValue(d, "shares"), 0.0))
    if ticker == "" || actualPrice <= 0.0 || shares <= 0 {
      None
    } else {
      let initialAtr = max0(decodeFloat(dictValue(d, "initialAtr"), 0.0))
      let initialStop = decodeFloat(
        dictValue(d, "initialStop"),
        actualPrice -. atrMultiplier *. initialAtr,
      )
      let updates = decodeArray(dictValue(d, "updateLog"))->Array.filterMap(parseUpdate)
      let replayFloor =
        updates->Array.length > 0
          ? initialStop
          : Math.max(initialStop, decodeFloat(dictValue(d, "trailingStop"), initialStop))
      let entryISOraw = decodeString(dictValue(d, "entryISO"), "")
      let lastISOraw = decodeString(dictValue(d, "lastUpdatedISO"), "")
      let entryISO = validISODate(entryISOraw) ? Some(entryISOraw) : None
      let lastUpdatedISO = validISODate(lastISOraw) ? Some(lastISOraw) : None
      let soldSharesRaw = floorInt(decodeFloat(dictValue(d, "soldShares"), 0.0))
      let soldShares = soldSharesRaw < 0 ? 0 : soldSharesRaw
      let entryShares = {
        let n = floorInt(
          decodeFloat(dictValue(d, "entryShares"), (shares + soldShares)->Int.toFloat),
        )
        n < shares ? shares : n
      }
      let entryGross = max0(
        decodeFloat(dictValue(d, "entryGrossValue"), actualPrice *. entryShares->Int.toFloat),
      )
      let entryCost = max0(decodeFloat(dictValue(d, "entryCost"), entryGross))
      let normalized: trade = {
        ticker,
        plannedEntry: decodeFloat(dictValue(d, "plannedEntry"), actualPrice),
        actualPrice,
        shares,
        initialAtr,
        initialStop,
        replayStopFloor: replayFloor,
        trailingStop: decodeFloat(dictValue(d, "trailingStop"), initialStop),
        highestClose: decodeFloat(dictValue(d, "highestClose"), actualPrice),
        lastClose: decodeFloat(dictValue(d, "lastClose"), actualPrice),
        lastAtr: switch JSON.Decode.float(dictValue(d, "lastAtr")->Option.getOr(jsonNull)) {
        | Some(n) => Some(n)
        | None => None
        },
        entryDate: decodeString(
          dictValue(d, "entryDate"),
          entryISO->Option.map(displayDate)->Option.getOr(""),
        ),
        entryISO,
        lastUpdatedDate: decodeString(
          dictValue(d, "lastUpdatedDate"),
          lastUpdatedISO->Option.map(displayDate)->Option.getOr(""),
        ),
        lastUpdatedISO,
        accountValueAtEntry: max0(decodeFloat(dictValue(d, "accountValueAtEntry"), accountValue)),
        entryReason: decodeString(dictValue(d, "entryReason"), "")->String.trim,
        exitReasonDraft: decodeString(dictValue(d, "exitReasonDraft"), "")->String.trim,
        soldShares,
        soldValue: max0(decodeFloat(dictValue(d, "soldValue"), 0.0)),
        soldNetValue: max0(
          decodeFloat(dictValue(d, "soldNetValue"), decodeFloat(dictValue(d, "soldValue"), 0.0)),
        ),
        entryShares,
        entryGrossValue: entryGross,
        entryCost,
        transactionCostsApplied: Dict.get(d, "entryCost")->Option.isSome ||
          Dict.get(d, "soldNetValue")->Option.isSome,
        updateLog: updates,
      }
      Some(recomputeTradeFromUpdateLog(normalized))
    }
  | None => None
  }
let encodeTrade = (t: trade): JSON.t =>
  jsonObject([
    ("ticker", jsonString(t.ticker)),
    ("plannedEntry", jsonFloat(t.plannedEntry)),
    ("actualPrice", jsonFloat(t.actualPrice)),
    ("shares", jsonInt(t.shares)),
    ("initialAtr", jsonFloat(t.initialAtr)),
    ("initialStop", jsonFloat(t.initialStop)),
    ("replayStopFloor", jsonFloat(t.replayStopFloor)),
    ("trailingStop", jsonFloat(t.trailingStop)),
    ("highestClose", jsonFloat(t.highestClose)),
    ("lastClose", jsonFloat(t.lastClose)),
    ("lastAtr", t.lastAtr->Option.map(jsonFloat)->Option.getOr(jsonNull)),
    ("entryDate", jsonString(t.entryDate)),
    ("entryISO", t.entryISO->Option.map(jsonString)->Option.getOr(jsonNull)),
    ("lastUpdatedDate", jsonString(t.lastUpdatedDate)),
    ("lastUpdatedISO", t.lastUpdatedISO->Option.map(jsonString)->Option.getOr(jsonNull)),
    ("accountValueAtEntry", jsonFloat(t.accountValueAtEntry)),
    ("entryReason", jsonString(t.entryReason)),
    ("exitReasonDraft", jsonString(t.exitReasonDraft)),
    ("soldShares", jsonInt(t.soldShares)),
    ("soldValue", jsonFloat(t.soldValue)),
    ("soldNetValue", jsonFloat(t.soldNetValue)),
    ("entryShares", jsonInt(t.entryShares)),
    ("entryGrossValue", jsonFloat(t.entryGrossValue)),
    ("entryCost", jsonFloat(t.entryCost)),
    ("transactionCostsApplied", jsonBool(t.transactionCostsApplied)),
    ("updateLog", t.updateLog->Array.map(encodeUpdate)->JSON.Encode.array),
  ])

let parseHistory = (value: JSON.t): option<historyItem> =>
  switch decodeObject(value) {
  | Some(d) =>
    let ticker = normalizeTicker(decodeString(dictValue(d, "ticker"), ""))
    let entryPrice = decodeFloat(dictValue(d, "entryPrice"), 0.0)
    let exitPrice = decodeFloat(dictValue(d, "exitPrice"), 0.0)
    let shares = floorInt(decodeFloat(dictValue(d, "shares"), 0.0))
    let risk = decodeFloat(dictValue(d, "totalRisk"), 0.0)
    let pnl = decodeFloat(dictValue(d, "pnl"), 0.0)
    let returnPct = decodeFloat(dictValue(d, "returnPct"), 0.0)
    if (
      ticker == "" ||
      entryPrice <= 0.0 ||
      exitPrice <= 0.0 ||
      shares <= 0 ||
      risk < 0.0 ||
      !finite(pnl) ||
      !finite(returnPct)
    ) {
      None
    } else {
      let entryISOraw = decodeString(dictValue(d, "entryISO"), "")
      let exitISOraw = decodeString(dictValue(d, "exitISO"), "")
      let entryISO = validISODate(entryISOraw) ? Some(entryISOraw) : None
      let exitISO = validISODate(exitISOraw) ? Some(exitISOraw) : None
      Some({
        ticker,
        entryPrice,
        entryDate: decodeString(
          dictValue(d, "entryDate"),
          entryISO->Option.map(displayDate)->Option.getOr(""),
        ),
        entryISO,
        exitPrice,
        exitDate: decodeString(
          dictValue(d, "exitDate"),
          exitISO->Option.map(displayDate)->Option.getOr(""),
        ),
        exitISO,
        shares,
        totalRisk: risk,
        actualRiskPct: switch JSON.Decode.float(
          dictValue(d, "actualRiskPct")->Option.getOr(jsonNull),
        ) {
        | Some(n) => Some(n)
        | None => None
        },
        pnl,
        returnPct,
        netPnl: decodeFloat(dictValue(d, "netPnl"), pnl),
        grossPnl: decodeFloat(dictValue(d, "grossPnl"), pnl),
        netEntryCost: max0(
          decodeFloat(dictValue(d, "netEntryCost"), entryPrice *. shares->Int.toFloat),
        ),
        netExitValue: max0(
          decodeFloat(dictValue(d, "netExitValue"), exitPrice *. shares->Int.toFloat),
        ),
        pnlBasis: decodeString(dictValue(d, "pnlBasis"), "legacy-gross"),
        transactionCostsApplied: decodeBool(dictValue(d, "transactionCostsApplied"), false),
        entryReason: decodeString(dictValue(d, "entryReason"), "")->String.trim,
        exitReason: decodeString(dictValue(d, "exitReason"), "")->String.trim,
      })
    }
  | None => None
  }
let encodeHistory = (h: historyItem): JSON.t =>
  jsonObject([
    ("ticker", jsonString(h.ticker)),
    ("entryPrice", jsonFloat(h.entryPrice)),
    ("entryDate", jsonString(h.entryDate)),
    ("entryISO", h.entryISO->Option.map(jsonString)->Option.getOr(jsonNull)),
    ("exitPrice", jsonFloat(h.exitPrice)),
    ("exitDate", jsonString(h.exitDate)),
    ("exitISO", h.exitISO->Option.map(jsonString)->Option.getOr(jsonNull)),
    ("shares", jsonInt(h.shares)),
    ("totalRisk", jsonFloat(h.totalRisk)),
    ("actualRiskPct", h.actualRiskPct->Option.map(jsonFloat)->Option.getOr(jsonNull)),
    ("pnl", jsonFloat(h.pnl)),
    ("returnPct", jsonFloat(h.returnPct)),
    ("netPnl", jsonFloat(h.netPnl)),
    ("grossPnl", jsonFloat(h.grossPnl)),
    ("netEntryCost", jsonFloat(h.netEntryCost)),
    ("netExitValue", jsonFloat(h.netExitValue)),
    ("pnlBasis", jsonString(h.pnlBasis)),
    ("transactionCostsApplied", jsonBool(h.transactionCostsApplied)),
    ("entryReason", jsonString(h.entryReason)),
    ("exitReason", jsonString(h.exitReason)),
  ])

let encodeCosts = (c: transactionCosts): JSON.t =>
  jsonObject([
    ("brokeragePct", jsonFloat(c.brokeragePct)),
    ("regulatoryFeePct", jsonFloat(c.regulatoryFeePct)),
    ("dpChargePerSell", jsonFloat(c.dpChargePerSell)),
    ("capitalGainsTaxPct", jsonFloat(c.capitalGainsTaxPct)),
  ])
let encodeState = (s: state): JSON.t =>
  jsonObject([
    ("accountValue", jsonFloat(s.accountValue)),
    ("cashBalance", jsonFloat(s.cashBalance)),
    ("realizedPnl", jsonFloat(s.realizedPnl)),
    ("transactionCosts", encodeCosts(s.transactionCosts)),
    ("transactionCostsConfigured", jsonBool(s.transactionCostsConfigured)),
    ("indexBars", JSON.Encode.array(s.indexBars)),
    ("pendingOrders", s.pendingOrders->Array.map(encodePending)->JSON.Encode.array),
    ("activeTrades", s.activeTrades->Array.map(encodeTrade)->JSON.Encode.array),
    ("history", s.history->Array.map(encodeHistory)->JSON.Encode.array),
    ("screenerCandidates", JSON.Encode.array(s.screenerCandidates)),
  ])

let supportedSchema = (value: option<JSON.t>): bool =>
  switch value {
  | Some(raw) =>
    switch JSON.Decode.float(raw) {
    | Some(version) => version == 1.0 || version == 2.0
    | None => false
    }
  | None => false
  }

/* Raw state and the old `{state}` wrapper predate envelope metadata.  Once a
 * format/app marker is present it must identify atr-desk and a supported
 * schema; this prevents arbitrary JSON from being treated as a ledger. */
let envelopeSupported = (raw: JSON.t): bool =>
  switch decodeObject(raw) {
  | None => false
  | Some(root) =>
    switch (
      Dict.get(root, "format"),
      Dict.get(root, "app"),
      Dict.get(root, "schemaVersion"),
      Dict.get(root, "state"),
    ) {
    | (Some(format), _, Some(version), Some(_)) =>
      decodeString(Some(format), "") == "atr-desk" && supportedSchema(Some(version))
    | (None, Some(app), Some(version), Some(_)) =>
      decodeString(Some(app), "") == "atr-desk" && supportedSchema(Some(version))
    | (None, None, None, Some(_)) => true
    | (None, None, None, None) => true
    | _ => false
    }
  }

let deriveLegacyCash = (
  ~accountValue: float,
  ~activeTrades: array<trade>,
  ~pendingOrders: array<pendingOrder>,
): float => {
  let activeCommitted = activeTrades->Array.reduce(0.0, (sum, trade) => {
    let shares = trade.entryShares < 1 ? trade.shares + trade.soldShares : trade.entryShares
    let basis = trade.entryCost > 0.0 ? trade.entryCost : trade.actualPrice *. shares->Int.toFloat
    sum +. max0(basis) -. max0(trade.soldNetValue)
  })
  let pendingCommitted = pendingOrders->Array.reduce(0.0, (sum, order) => {
    let filled = max0(order.filledCost > 0.0 ? order.filledCost : order.filledValue)
    sum +. filled
  })
  max0(accountValue -. activeCommitted -. pendingCommitted)
}

let normalizePersistedState = (raw: JSON.t): normalization => {
  let root0 = decodeObject(raw)->Option.getOr(Dict.make())
  let root = switch Dict.get(root0, "state") {
  | Some(value) => decodeObject(value)->Option.getOr(root0)
  | None => root0
  }
  let accountRaw = decodeFloat(dictValue(root, "accountValue"), 1000000.0)
  let accountValue = accountRaw > 0.0 ? accountRaw : 1000000.0
  let rawPending = decodeArray(dictValue(root, "pendingOrders"))
  let rawActive = decodeArray(dictValue(root, "activeTrades"))
  let rawHistory = decodeArray(dictValue(root, "history"))
  let pending = rawPending->Array.filterMap(v => parsePending(v, accountValue))
  let active = rawActive->Array.filterMap(v => parseTrade(v, accountValue))
  let history = rawHistory->Array.filterMap(parseHistory)
  let seen: Dict.t<bool> = Dict.make()
  let dedupActive = active->Array.filter(t =>
    switch seen->Dict.get(t.ticker) {
    | Some(_) => false
    | None =>
      seen->Dict.set(t.ticker, true)
      true
    }
  )
  let dedupPending = pending->Array.filter(o =>
    switch seen->Dict.get(o.ticker) {
    | Some(_) => false
    | None =>
      seen->Dict.set(o.ticker, true)
      true
    }
  )
  let duplicateActive = active->Array.length - dedupActive->Array.length
  let duplicatePending = pending->Array.length - dedupPending->Array.length
  let dropped = {
    pendingOrders: rawPending->Array.length - pending->Array.length + duplicatePending,
    activeTrades: rawActive->Array.length - active->Array.length + duplicateActive,
    history: rawHistory->Array.length - history->Array.length,
    duplicateTickers: duplicateActive + duplicatePending,
  }
  let candidates = decodeArray(dictValue(root, "screenerCandidates"))->Array.filterMap(v =>
    switch decodeObject(v) {
    | Some(d) =>
      let t = normalizeTicker(decodeString(dictValue(d, "ticker"), ""))
      t == ""
        ? None
        : Some(
            jsonObject([
              ("ticker", jsonString(t)),
              ("tt", jsonFloat(decodeFloat(dictValue(d, "tt"), 0.0))),
              ("rs", jsonFloat(decodeFloat(dictValue(d, "rs"), 0.0))),
              ("vcp", jsonFloat(decodeFloat(dictValue(d, "vcp"), 0.0))),
            ]),
          )
    | None => None
    }
  )
  let costs = normalizeCosts(dictValue(root, "transactionCosts"))
  let cashBalance = switch Dict.get(root, "cashBalance") {
  | Some(value) => max0(decodeFloat(Some(value), accountValue))
  | None => deriveLegacyCash(~accountValue, ~activeTrades=dedupActive, ~pendingOrders=dedupPending)
  }
  let state: state = {
    accountValue,
    cashBalance,
    realizedPnl: decodeFloat(dictValue(root, "realizedPnl"), 0.0),
    transactionCosts: costs,
    transactionCostsConfigured: Dict.get(root, "transactionCosts")->Option.isSome,
    indexBars: normalizeIndexBars(decodeArray(dictValue(root, "indexBars")))->Array.map(
      indexBarJson,
    ),
    pendingOrders: dedupPending,
    activeTrades: dedupActive,
    history,
    screenerCandidates: candidates,
  }
  {
    state,
    dropped,
    droppedPending: dropped.pendingOrders,
    droppedActive: dropped.activeTrades,
    droppedHistory: dropped.history,
    duplicateTickers: dropped.duplicateTickers,
  }
}
let decodeState = (raw: JSON.t): option<state> =>
  envelopeSupported(raw) ? Some(normalizePersistedState(raw).state) : None
let exportEnvelope = (value: JSON.t): JSON.t =>
  jsonObject([
    ("format", jsonString("atr-desk")),
    ("schemaVersion", jsonInt(exportSchemaVersion)),
    ("exportedAt", jsonString(Date.toISOString(Date.make()))),
    ("state", value),
  ])
let storageEnvelope = (value: JSON.t): JSON.t =>
  jsonObject([
    ("format", jsonString("atr-desk")),
    ("schemaVersion", jsonInt(storageVersion)),
    ("state", value),
  ])

let applyDailyUpdate = (trade: trade, dateISO: string, close: float, atr: float): trade => {
  if !validISODate(dateISO) || close <= 0.0 || atr <= 0.0 {
    trade
  } else {
    let next = {
      dateISO,
      date: displayDate(dateISO),
      close: round2(close),
      atr: round2(atr),
      trailingStop: trade.trailingStop,
    }
    let kept = trade.updateLog->Array.filter(u => u.dateISO != dateISO)
    recomputeTradeFromUpdateLog({...trade, updateLog: kept->Array.concat([next])})
  }
}
let convertOrderToActiveTrade = (
  ~order: pendingOrder,
  ~todayClose: option<float>=?,
  ~todayAtr: option<float>=?,
  ~fillDateISO: option<string>=?,
): trade => {
  let shares = order.filledShares < 1 ? 1 : order.filledShares
  let vwap =
    order.filledShares > 0
      ? order.filledValue /. order.filledShares->Int.toFloat
      : order.plannedEntry
  let atr = todayAtr->Option.getOr(order.atr)
  let initialStop = vwap -. atrMultiplier *. atr
  let replayFloor = Math.max(initialStop, order.plannedStop)
  let initial: trade = {
    ticker: normalizeTicker(order.ticker),
    plannedEntry: order.plannedEntry,
    actualPrice: round2(vwap),
    shares,
    initialAtr: round2(atr),
    initialStop: round2(initialStop),
    replayStopFloor: replayFloor,
    trailingStop: round2(replayFloor),
    highestClose: round2(vwap),
    lastClose: todayClose->Option.getOr(vwap),
    lastAtr: None,
    entryDate: order.firstFillDate,
    entryISO: order.firstFillISO,
    lastUpdatedDate: "",
    lastUpdatedISO: None,
    accountValueAtEntry: order.accountValueAtEntry,
    entryReason: order.entryReason,
    exitReasonDraft: "",
    soldShares: 0,
    soldValue: 0.0,
    soldNetValue: 0.0,
    entryShares: shares,
    entryGrossValue: order.filledValue,
    entryCost: order.filledCost,
    transactionCostsApplied: order.transactionCostsApplied,
    updateLog: [],
  }
  switch (todayClose, todayAtr, fillDateISO) {
  | (Some(c), Some(a), Some(d)) => applyDailyUpdate(initial, d, c, a)
  | _ => initial
  }
}
let summarizeExitAccounting = (
  ~actualPrice: float,
  ~soldShares: int,
  ~soldValue: float,
  ~soldNetValue: float,
  ~entryCost: float,
): JSON.t => {
  let shares = soldShares < 0 ? 0 : soldShares
  let basis = max0(entryCost)
  jsonObject([
    ("netRevenue", jsonFloat(max0(soldNetValue))),
    ("pnl", jsonFloat(round2(max0(soldNetValue) -. basis))),
    ("entryCost", jsonFloat(basis)),
    ("soldShares", jsonInt(shares)),
    ("actualPrice", jsonFloat(actualPrice)),
    ("soldValue", jsonFloat(max0(soldValue))),
  ])
}
let summarizeExit = (
  ~_actualPrice: float,
  ~soldShares: int,
  ~soldValue: float,
  ~soldNetValue: float,
  ~entryCost: float,
): exitAccounting => {
  let shares = soldShares < 0 ? 0 : soldShares
  let basis = max0(entryCost)
  let revenue = max0(soldValue)
  let net = max0(soldNetValue)
  {
    totalSharesSold: shares,
    totalCost: basis,
    totalRevenue: revenue,
    netRevenue: net,
    netEntryCost: basis,
    grossPnl: round2(revenue -. basis),
    pnl: round2(net -. basis),
    returnPct: basis > 0.0 ? (net -. basis) /. basis *. 100.0 : 0.0,
    avgExitPrice: shares > 0 ? revenue /. shares->Int.toFloat : 0.0,
  }
}

/* Build the single history row emitted when a position's final tranche is
 * sold.  Cumulative sold fields make partial exits deterministic and retain
 * the original VWAP/cost ledger. */
let historyFromClosedTrade = (~trade: trade, ~exitDateISO: string, ~exitReason: string): option<
  historyItem,
> => {
  let entryShares = trade.entryShares < 1 ? trade.shares + trade.soldShares : trade.entryShares
  let soldSharesRaw = trade.soldShares < 0 ? 0 : trade.soldShares
  let soldShares = soldSharesRaw > entryShares ? entryShares : soldSharesRaw
  if !validISODate(exitDateISO) || soldShares <= 0 || trade.shares > 0 {
    None
  } else {
    let avgExitPrice = trade.soldValue /. soldShares->Int.toFloat
    let grossEntryCost = trade.actualPrice *. soldShares->Int.toFloat
    let netEntryCost = max0(trade.entryCost > 0.0 ? trade.entryCost : grossEntryCost)
    let netExitValue = max0(trade.soldNetValue)
    let grossPnl = round2(trade.soldValue -. grossEntryCost)
    let netPnl = round2(netExitValue -. netEntryCost)
    let totalRisk = max0(atrMultiplier *. trade.initialAtr *. soldShares->Int.toFloat)
    let actualRiskPct =
      trade.accountValueAtEntry > 0.0 ? Some(totalRisk /. trade.accountValueAtEntry *. 100.0) : None
    Some({
      ticker: normalizeTicker(trade.ticker),
      entryPrice: trade.actualPrice,
      entryDate: trade.entryDate,
      entryISO: trade.entryISO,
      exitPrice: round2(avgExitPrice),
      exitDate: displayDate(exitDateISO),
      exitISO: Some(exitDateISO),
      shares: soldShares,
      totalRisk: round2(totalRisk),
      actualRiskPct,
      pnl: netPnl,
      returnPct: netEntryCost > 0.0 ? netPnl /. netEntryCost *. 100.0 : 0.0,
      netPnl,
      grossPnl,
      netEntryCost,
      netExitValue,
      pnlBasis: trade.transactionCostsApplied ? "net" : "legacy-gross",
      transactionCostsApplied: trade.transactionCostsApplied,
      entryReason: trade.entryReason,
      exitReason: exitReason->String.trim,
    })
  }
}

let computeDistributionDays = (bars: array<indexBar>): distributionDetails => {
  if bars->Array.length < 2 {
    {count: 0, level: "distribution", flagged: [], ftdDate: None, marketState: "correction"}
  } else {
    let marketState = ref("correction")
    let attemptLow = ref(0.0)
    let attemptStart = ref(-1)
    let ftdDate: ref<option<string>> = ref(None)
    let active: ref<array<flaggedBar>> = ref([])
    for i in 1 to bars->Array.length - 1 {
      let prior = bars->Array.getUnsafe(i - 1)
      let cur = bars->Array.getUnsafe(i)
      if marketState.contents == "uptrend" {
        active.contents =
          active.contents->Array.filter((item: flaggedBar) =>
            i - item.index < 25 && cur.close < item.bar.close *. 1.06
          )
        if cur.close < prior.close && cur.volume > prior.volume {
          active.contents = active.contents->Array.concat([{bar: cur, index: i}])
        }
        if active.contents->Array.length >= 5 {
          marketState := "correction"
          attemptLow := 0.0
          attemptStart := -1
          ftdDate := None
          active := []
        }
      } else if marketState.contents == "correction" {
        let twoBackIndex = i - 2 < 0 ? 0 : i - 2
        let twoBack = bars->Array.getUnsafe(twoBackIndex)
        if cur.close > prior.close && prior.close < twoBack.close {
          marketState := "attempt"
          attemptStart := i
          attemptLow := prior.close
        }
      } else if cur.close < attemptLow.contents {
        marketState := "correction"
        attemptStart := -1
        attemptLow := 0.0
      } else {
        let rallyDay = i - attemptStart.contents + 1
        let pct = prior.close > 0.0 ? (cur.close -. prior.close) /. prior.close *. 100.0 : 0.0
        if rallyDay >= 4 && pct >= 1.5 && cur.volume > prior.volume {
          marketState := "uptrend"
          ftdDate := Some(cur.date)
          active := []
        }
      }
    }
    let count = active.contents->Array.length
    let level = if marketState.contents != "uptrend" || count >= 5 {
      "distribution"
    } else if count >= 3 {
      "caution"
    } else {
      "normal"
    }
    {
      count,
      level,
      flagged: active.contents->Array.map(item => item.bar),
      ftdDate: ftdDate.contents,
      marketState: marketState.contents,
    }
  }
}
let distributionSummary = (bars: array<JSON.t>): distribution => {
  let d = computeDistributionDays(normalizeIndexBars(bars))
  {
    distributionDays: d.count,
    status: d.level,
    sufficientHistory: bars->Array.length >= 2,
    followThroughDay: d.ftdDate->Option.isSome,
  }
}
let macroGateStatus = (bars: array<JSON.t>): macroGate => {
  let s = distributionSummary(bars)
  {
    blocked: !s.sufficientHistory || s.status == "distribution",
    count: s.distributionDays,
    level: s.status,
    insufficientHistory: !s.sufficientHistory,
  }
}

let parseLiquidityStats = (raw: string): option<liquidity> => {
  let values =
    raw
    ->String.split(",")
    ->Array.filterMap(s =>
      switch Float.parseFloat(s->String.trim) {
      | n if finite(n) && n > 0.0 => Some(n *. 100000.0)
      | _ => None
      }
    )
  if values->Array.length == 0 {
    None
  } else {
    let total = values->Array.reduce(0.0, (a, b) => a +. b)
    Some({
      avg: total /. values->Array.length->Int.toFloat,
      min: values->Array.reduce(1e300, Math.min),
      max: values->Array.reduce(0.0, Math.max),
      count: values->Array.length,
    })
  }
}
let parsePastedIndexBars = (text: string): parsedIndexBars => {
  let bars = ref([])
  let skipped = ref(0)
  text
  ->String.split("\n")
  ->Array.forEach(line => {
    let t = line->String.trim
    if t != "" {
      let comma = t->String.split(",")->Array.map(String.trim)
      let (date, closeRaw, volumeRaw) = if comma->Array.length >= 8 {
        (comma->Array.getUnsafe(1), comma->Array.getUnsafe(5), comma->Array.getUnsafe(7))
      } else {
        let p = t->String.split("\t")
        let p = p->Array.length >= 3 ? p : t->String.split(" ")->Array.filter(x => x != "")
        (
          p->Array.get(0)->Option.getOr(""),
          p->Array.get(1)->Option.getOr(""),
          p->Array.get(2)->Option.getOr(""),
        )
      }
      let close = Float.parseFloat(closeRaw->String.replaceRegExp(/[^0-9.-]/g, ""))
      let volume = Float.parseFloat(volumeRaw->String.replaceRegExp(/[^0-9.-]/g, ""))
      if validISODate(date) && finite(close) && close > 0.0 && finite(volume) && volume >= 0.0 {
        bars := bars.contents->Array.concat([{date, close, volume}])
      } else {
        skipped := skipped.contents + 1
      }
    }
  })
  {bars: normalizeIndexBars(bars.contents->Array.map(indexBarJson)), skippedCount: skipped.contents}
}
let parsePastedScreenerText = (text: string): parsedScreener => {
  let tokens =
    text
    ->String.split("\n")
    ->Array.flatMap(line => line->String.trim->String.split("\t"))
    ->Array.flatMap(token => token->String.trim->String.split(" ")->Array.filter(x => x != ""))
  let results = ref([])
  let skipped = ref(0)
  let i = ref(0)
  while i.contents < tokens->Array.length {
    let symbol = tokens->Array.getUnsafe(i.contents)
    let looks =
      String.length(symbol) >= 2 &&
      String.length(symbol) <= 10 &&
      symbol
      ->String.get(0)
      ->Option.map(c => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z"))
      ->Option.getOr(false)
    if looks && i.contents + 7 < tokens->Array.length {
      let vals =
        tokens
        ->Array.slice(~start=i.contents + 1, ~end=i.contents + 8)
        ->Array.map(t => Float.parseFloat(t->String.replaceRegExp(/[^0-9.-]/g, "")))
      if vals->Array.every(finite) {
        results :=
          results.contents->Array.concat([
            {
              ticker: normalizeTicker(symbol),
              tt: vals->Array.getUnsafe(1),
              vcp: vals->Array.getUnsafe(2),
              rs: vals->Array.getUnsafe(6),
            },
          ])
        i := i.contents + 8
      } else {
        skipped := skipped.contents + 1
        i := i.contents + 1
      }
    } else {
      skipped := skipped.contents + 1
      i := i.contents + 1
    }
  }
  {
    results: results.contents,
    skipped: skipped.contents > 0
      ? [skipped.contents->Int.toString ++ " unmatched token(s) ignored (likely headers/labels)"]
      : [],
  }
}
let rankCandidates = (items: array<candidate>): array<candidate> =>
  items->Array.toSorted((a, b) => {
    let x = b.rs -. a.rs
    x != 0.0 ? x : b.vcp -. a.vcp
  })
let filterCandidates = (~mode: string="top5", items: array<candidate>): array<candidate> => {
  let pass = items->Array.filter(c => c.tt >= 75.0 && c.rs >= 75.0)->rankCandidates
  let fail = items->Array.filter(c => c.tt < 75.0 || c.rs < 75.0)->rankCandidates
  switch mode {
  | "passing" => pass
  | "failing" => fail
  | "all" => pass->Array.concat(fail)
  | _ => pass->Array.filter(c => c.rs >= 90.0 && c.vcp >= 75.0)->Array.slice(~start=0, ~end=5)
  }
}

let getPendingReservedCash = (
  ~cashBalance: float,
  ~costs: transactionCosts,
  ~excludeTicker: option<string>,
  ~orders: array<pendingOrder>,
): float => {
  let reserved =
    orders->Array.reduce(0.0, (sum, o) =>
      excludeTicker == Some(o.ticker)
        ? sum
        : sum +.
          buyNetCost(~gross=(o.shares - o.filledShares)->Int.toFloat *. o.plannedEntry, ~costs)
    )
  max0(cashBalance -. reserved)
}
let validatePendingFillCash = (
  ~cashBalance: float,
  ~costs: transactionCosts=defaultCosts,
  ~order: pendingOrder,
  ~fillShares: int,
  ~fillPrice: float,
): fillCheck => {
  /* Kept as the compatibility helper for callers that only have the current
   * order.  Reducer transitions use validatePendingFillCashForOrders below so
   * every reservation is accounted for before a fill mutates cash. */
  let fillCount = fillShares < 0 ? 0 : fillShares
  let required = buyNetCost(~gross=fillCount->Int.toFloat *. max0(fillPrice), ~costs)
  let available = getPendingReservedCash(
    ~cashBalance,
    ~costs,
    ~excludeTicker=Some(order.ticker),
    ~orders=[order],
  )
  {ok: required <= available +. 1e-9, required, available}
}
let validatePendingFillCashForOrders = (
  ~cashBalance: float,
  ~costs: transactionCosts=defaultCosts,
  ~order: pendingOrder,
  ~fillShares: int,
  ~fillPrice: float,
  ~pendingOrders: array<pendingOrder>,
): fillCheck => {
  let fillCount = fillShares < 0 ? 0 : fillShares
  let required = buyNetCost(~gross=fillCount->Int.toFloat *. max0(fillPrice), ~costs)
  let available = getPendingReservedCash(
    ~cashBalance,
    ~costs,
    ~excludeTicker=Some(order.ticker),
    ~orders=pendingOrders,
  )
  {ok: required <= available +. 1e-9, required, available}
}
let sellStateUpdate = (
  ~trade: trade,
  ~soldShares: int,
  ~exitPrice: float,
  ~costs: transactionCosts=defaultCosts,
  ~exitReason: string="",
): (trade, float) => {
  let shares = soldShares < 0 ? 0 : soldShares > trade.shares ? trade.shares : soldShares
  if shares <= 0 || !finite(exitPrice) || exitPrice <= 0.0 {
    (trade, 0.0)
  } else {
    let gross = exitPrice *. shares->Int.toFloat
    let entryShares = trade.entryShares < 1 ? 1 : trade.entryShares
    let basis = trade.entryCost *. shares->Int.toFloat /. entryShares->Int.toFloat
    let net = sellNetProceeds(~gross, ~basis, ~costs)
    let trimmedReason = exitReason->String.trim
    let nextReason = trimmedReason == "" ? trade.exitReasonDraft : trimmedReason
    (
      {
        ...trade,
        shares: trade.shares - shares,
        soldShares: trade.soldShares + shares,
        soldValue: trade.soldValue +. gross,
        soldNetValue: trade.soldNetValue +. net,
        exitReasonDraft: nextReason,
      },
      net -. basis,
    )
  }
}

let tradingDay = (iso: string): bool => {
  if !validISODate(iso) {
    false
  } else {
    let d = Date.fromString(iso ++ "T00:00:00+05:45")
    let day = Date.getDay(d)
    day >= 1 && day <= 5
  }
}
let kathmanduISODate = (date: Date.t): string => {
  let d = Date.fromTime(Date.getTime(date) +. 20700000.0)
  let y = Date.getUTCFullYear(d)->Int.toString
  let m = (Date.getUTCMonth(d) + 1)->Int.toString
  let day = Date.getUTCDate(d)->Int.toString
  y ++
  "-" ++
  (String.length(m) == 1 ? "0" ++ m : m) ++
  "-" ++ (String.length(day) == 1 ? "0" ++ day : day)
}
let todayKathmanduISO = (): string => kathmanduISODate(Date.make())
