/* Pure state transitions. Browser event handlers can keep these records and
 * never mutate a persisted order/trade in place. */
open RescriptCore

type action =
  | SetAccountValue(float)
  | SetCashBalance(float)
  | RecordRealizedPnl(float)
  | SetTransactionCosts(Domain.transactionCosts)
  | ReplaceState(Domain.state)
  | SetIndexBars(array<Domain.indexBar>)
  | SetCandidates(array<Domain.candidate>)
  | ImportCandidates(array<Domain.candidate>)
  | AddPending(Domain.pendingOrder)
  | CancelPending(string)
  | CancelPendingOn(string, string, float, float)
  | LogNoFill(string, string)
  | RepricePending(string, float, float)
  | LogPendingDay(string, string, float, float, option<(int, float)>)
  | ApplyPendingFill(string, string, int, float, float, float)
  | DailyUpdate(string, string, float, float)
  | Sell(string, int, float, string)
  | SellOn(string, string, int, float, string)
  | Reset

type transition = {state: Domain.state, accepted: bool, reason: string}

type domainError =
  | InvalidNumber(string)
  | InvalidDate(string)
  | InvalidOrder(string)
  | InvalidFill(string)
  | InvalidSale(string)
  | NotFound(string)
  | CashCap(float)
  | DuplicateTicker(string)
  | SlotLimit

let initialState = Domain.defaultState()
let finite = (x: float): bool => Float.isFinite(x)
let normalizeCandidates = (items: array<Domain.candidate>): array<Domain.candidate> =>
  items->Array.map(c => {...c, ticker: Domain.normalizeTicker(c.ticker)})
let candidateJson = (c: Domain.candidate): JSON.t =>
  Domain.jsonObject([
    ("ticker", Domain.jsonString(c.ticker)),
    ("tt", Domain.jsonFloat(c.tt)),
    ("rs", Domain.jsonFloat(c.rs)),
    ("vcp", Domain.jsonFloat(c.vcp)),
  ])
let normalizeIndexBars = (items: array<Domain.indexBar>): array<JSON.t> =>
  Domain.normalizeIndexBars(items->Array.map(Domain.indexBarJson))->Array.map(Domain.indexBarJson)
let validOptionalISO = (value: option<string>): bool =>
  switch value {
  | None => true
  | Some(iso) => Domain.validISODate(iso)
  }
let validCosts = (costs: Domain.transactionCosts): bool =>
  finite(costs.brokeragePct) &&
  finite(costs.regulatoryFeePct) &&
  finite(costs.dpChargePerSell) &&
  finite(costs.capitalGainsTaxPct) &&
  costs.brokeragePct >= 0.0 &&
  costs.regulatoryFeePct >= 0.0 &&
  costs.dpChargePerSell >= 0.0 &&
  costs.capitalGainsTaxPct >= 0.0
let validBar = (bar: Domain.indexBar): bool =>
  Domain.validISODate(bar.date) &&
  finite(bar.close) &&
  bar.close > 0.0 &&
  finite(bar.volume) &&
  bar.volume >= 0.0
let validCandidate = (candidate: Domain.candidate): bool =>
  Domain.normalizeTicker(candidate.ticker) != "" &&
  finite(candidate.tt) &&
  finite(candidate.rs) &&
  finite(candidate.vcp)
let validOrder = (order: Domain.pendingOrder): bool =>
  Domain.normalizeTicker(order.ticker) != "" &&
  finite(order.plannedEntry) &&
  order.plannedEntry > 0.0 &&
  finite(order.plannedStop) &&
  order.plannedStop > 0.0 &&
  finite(order.atr) &&
  order.atr > 0.0 &&
  order.shares > 0 &&
  order.filledShares >= 0 &&
  order.filledShares <= order.shares &&
  finite(order.filledValue) &&
  order.filledValue >= 0.0 &&
  finite(order.filledCost) &&
  order.filledCost >= 0.0 &&
  validOptionalISO(order.placedISO) &&
  validOptionalISO(order.firstFillISO) &&
  validOptionalISO(order.lastLoggedISO)
let duplicateTicker = (tickers: array<string>): option<string> => {
  let seen: Dict.t<bool> = Dict.make()
  let duplicate: ref<option<string>> = ref(None)
  tickers->Array.forEach(ticker => {
    let normalized = Domain.normalizeTicker(ticker)
    if duplicate.contents == None && normalized != "" {
      switch Dict.get(seen, normalized) {
      | Some(_) => duplicate := Some(normalized)
      | None => seen->Dict.set(normalized, true)
      }
    }
  })
  duplicate.contents
}
let duplicateInState = (state: Domain.state): option<string> => {
  let activeTickers = state.activeTrades->Array.map(t => t.ticker)
  let pendingTickers = state.pendingOrders->Array.map(o => o.ticker)
  switch duplicateTicker(activeTickers) {
  | Some(ticker) => Some(ticker)
  | None =>
    switch duplicateTicker(pendingTickers) {
    | Some(ticker) => Some(ticker)
    | None => duplicateTicker(activeTickers->Array.concat(pendingTickers))
    }
  }
}
let transitionError = (reason: string): domainError =>
  switch reason {
  | "order-not-found" => NotFound("pending order")
  | "cash-cap" => CashCap(0.0)
  | "invalid-fill" => InvalidFill("fill values/date")
  | "fill-date-order" => InvalidDate("fill must be a new chronological session")
  | _ => InvalidOrder(reason)
  }
let transitionResult = (value: transition): result<Domain.state, domainError> =>
  value.accepted ? Ok(value.state) : Error(transitionError(value.reason))

let recordFill = (
  state: Domain.state,
  ~ticker: string,
  ~dateISO: string,
  ~fillShares: int,
  ~fillPrice: float,
  ~todayClose: float,
  ~todayAtr: float,
): transition => {
  let index = state.pendingOrders->Array.findIndex(o => o.ticker == Domain.normalizeTicker(ticker))
  if index < 0 {
    {state, accepted: false, reason: "order-not-found"}
  } else {
    let order = state.pendingOrders->Array.getUnsafe(index)
    let qty = fillShares < 0 ? 0 : fillShares
    let price = fillPrice
    let dateOrderOk = switch order.lastLoggedISO {
    | Some(lastDate) => dateISO > lastDate
    | None => true
    }
    if (
      qty <= 0 ||
      !finite(price) ||
      price <= 0.0 ||
      qty > order.shares - order.filledShares ||
      !Domain.validISODate(dateISO) ||
      !dateOrderOk
    ) {
      {state, accepted: false, reason: !dateOrderOk ? "fill-date-order" : "invalid-fill"}
    } else {
      let check = Domain.validatePendingFillCashForOrders(
        ~cashBalance=state.cashBalance,
        ~costs=state.transactionCosts,
        ~order,
        ~fillShares=qty,
        ~fillPrice=price,
        ~pendingOrders=state.pendingOrders,
      )
      if !check.ok {
        {state, accepted: false, reason: "cash-cap"}
      } else {
        let nextFilledShares = order.filledShares + qty
        let nextValue = order.filledValue +. qty->Int.toFloat *. price
        let nextCost =
          order.filledCost +.
          Domain.buyNetCost(~gross=qty->Int.toFloat *. price, ~costs=state.transactionCosts)
        let fill: Domain.fill = {dateISO, date: Domain.displayDate(dateISO), shares: qty, price}
        let nextOrder = {
          ...order,
          filledShares: nextFilledShares,
          filledValue: nextValue,
          filledCost: nextCost,
          fillLog: order.fillLog->Array.concat([fill]),
          firstFillISO: order.firstFillISO == None ? Some(dateISO) : order.firstFillISO,
          firstFillDate: order.firstFillISO == None
            ? Domain.displayDate(dateISO)
            : order.firstFillDate,
          lastLoggedISO: Some(dateISO),
          lastLoggedDate: Domain.displayDate(dateISO),
        }
        let nextPending =
          state.pendingOrders->Array.mapWithIndex((value, i) => i == index ? nextOrder : value)
        let cash = state.cashBalance -. (nextCost -. order.filledCost)
        if nextFilledShares >= order.shares {
          let trade = Domain.convertOrderToActiveTrade(
            ~order=nextOrder,
            ~todayClose=?Some(todayClose),
            ~todayAtr=?Some(todayAtr),
            ~fillDateISO=?Some(dateISO),
          )
          {
            state: {
              ...state,
              cashBalance: cash,
              activeTrades: state.activeTrades->Array.concat([trade]),
              pendingOrders: nextPending->Array.filter(o => o.ticker != order.ticker),
            },
            accepted: true,
            reason: "filled",
          }
        } else {
          {
            state: {...state, cashBalance: cash, pendingOrders: nextPending},
            accepted: true,
            reason: "partial-fill",
          }
        }
      }
    }
  }
}

let applySale = (
  current: Domain.state,
  ticker: string,
  exitDateISO: string,
  shares: int,
  price: float,
  reason: string,
): result<Domain.state, domainError> => {
  if shares <= 0 || !finite(price) || price <= 0.0 || !Domain.validISODate(exitDateISO) {
    shares <= 0 || !finite(price) || price <= 0.0
      ? Error(InvalidSale("shares/price"))
      : Error(InvalidDate(exitDateISO))
  } else {
    let normalizedTicker = Domain.normalizeTicker(ticker)
    switch current.activeTrades->Array.find(t => t.ticker == normalizedTicker) {
    | None => Error(NotFound("active trade"))
    | Some(trade) =>
      if shares > trade.shares {
        Error(InvalidSale("shares exceed position"))
      } else {
        let (next, pnl) = Domain.sellStateUpdate(
          ~trade,
          ~soldShares=shares,
          ~exitPrice=price,
          ~costs=current.transactionCosts,
          ~exitReason=reason,
        )
        let soldThis = next.soldShares - trade.soldShares
        let grossThis = next.soldValue -. trade.soldValue
        let entryShares = trade.entryShares < 1 ? 1 : trade.entryShares
        let basisThis = trade.entryCost *. soldThis->Int.toFloat /. entryShares->Int.toFloat
        let netThis = Domain.sellNetProceeds(
          ~gross=grossThis,
          ~basis=basisThis,
          ~costs=current.transactionCosts,
        )
        let updated = {
          ...current,
          cashBalance: current.cashBalance +. netThis,
          realizedPnl: current.realizedPnl +. pnl,
          accountValue: Domain.max0(current.accountValue +. pnl),
        }
        if next.shares > 0 {
          Ok({
            ...updated,
            activeTrades: updated.activeTrades->Array.map(t => t.ticker == next.ticker ? next : t),
          })
        } else {
          let nextHistory = switch Domain.historyFromClosedTrade(
            ~trade=next,
            ~exitDateISO,
            ~exitReason=next.exitReasonDraft,
          ) {
          | Some(row) => [row]->Array.concat(current.history)
          | None => current.history
          }
          Ok({
            ...updated,
            activeTrades: updated.activeTrades->Array.filter(t => t.ticker != next.ticker),
            history: nextHistory,
          })
        }
      }
    }
  }
}

let logNoFill = (current: Domain.state, ticker: string, dateISO: string): result<
  Domain.state,
  domainError,
> => {
  if !Domain.validISODate(dateISO) {
    Error(InvalidDate(dateISO))
  } else {
    let normalizedTicker = Domain.normalizeTicker(ticker)
    switch current.pendingOrders->Array.findIndex(o => o.ticker == normalizedTicker) {
    | -1 => Error(NotFound("pending order"))
    | index =>
      let order = current.pendingOrders->Array.getUnsafe(index)
      switch order.lastLoggedISO {
      | Some(lastDate) if lastDate == dateISO => Ok(current)
      | Some(lastDate) if dateISO < lastDate => Error(InvalidDate("no-fill date is out of order"))
      | _ =>
        let attempts = order.daysWaiting + 1
        if attempts >= Domain.maxDayOrderAttempts {
          order.filledShares > 0
            ? Error(InvalidOrder("partial order requires LogPendingDay for conversion"))
            : Ok({
                ...current,
                pendingOrders: current.pendingOrders->Array.filter(o => o.ticker != order.ticker),
              })
        } else {
          let updatedOrder = {
            ...order,
            daysWaiting: attempts,
            lastLoggedISO: Some(dateISO),
            lastLoggedDate: Domain.displayDate(dateISO),
          }
          Ok({
            ...current,
            pendingOrders: current.pendingOrders->Array.mapWithIndex((value, i) =>
              i == index ? updatedOrder : value
            ),
          })
        }
      }
    }
  }
}

let repricePending = (current: Domain.state, ticker: string, entry: float, atr: float): result<
  Domain.state,
  domainError,
> => {
  if !finite(entry) || !finite(atr) || entry <= 0.0 || atr <= 0.0 {
    Error(InvalidNumber("pending repricing"))
  } else {
    let normalizedTicker = Domain.normalizeTicker(ticker)
    switch current.pendingOrders->Array.findIndex(o => o.ticker == normalizedTicker) {
    | -1 => Error(NotFound("pending order"))
    | index =>
      let order = current.pendingOrders->Array.getUnsafe(index)
      /* The current order's reservation is released while sizing the new
       * quote, but all other pending reservations remain committed.  This
       * prevents repricing one order from silently spending another order's
       * cash. */
      let available = Domain.getPendingReservedCash(
        ~cashBalance=current.cashBalance,
        ~costs=current.transactionCosts,
        ~excludeTicker=Some(normalizedTicker),
        ~orders=current.pendingOrders,
      )
      let sizing = Domain.calculatePosition(
        ~accountValue=current.accountValue,
        ~entry,
        ~atr,
        ~cashAvailable=available,
      )
      let perShare = Domain.buyNetCost(~gross=entry, ~costs=current.transactionCosts)
      let affordableShares =
        order.filledShares + (perShare > 0.0 ? Domain.floorInt(available /. perShare) : 0)
      let cappedShares = sizing.shares < affordableShares ? sizing.shares : affordableShares
      let targetShares = order.filledShares > cappedShares ? order.filledShares : cappedShares
      if targetShares < Domain.minLotSize && order.filledShares <= 0 {
        Error(
          CashCap(
            Domain.buyNetCost(
              ~gross=Domain.minLotSize->Int.toFloat *. entry,
              ~costs=current.transactionCosts,
            ),
          ),
        )
      } else {
        let plannedStop = Domain.max0(entry -. Domain.atrMultiplier *. atr)
        let nextOrder = {
          ...order,
          plannedEntry: entry,
          plannedStop: plannedStop <= 0.0 ? 0.01 : plannedStop,
          atr,
          shares: targetShares,
          accountValueAtEntry: current.accountValue,
        }
        Ok({
          ...current,
          pendingOrders: current.pendingOrders->Array.mapWithIndex((value, i) =>
            i == index ? nextOrder : value
          ),
        })
      }
    }
  }
}

let cancelPendingOn = (
  current: Domain.state,
  ticker: string,
  dateISO: string,
  close: float,
  atr: float,
): result<Domain.state, domainError> => {
  if !Domain.validISODate(dateISO) {
    Error(InvalidDate(dateISO))
  } else if !finite(close) || !finite(atr) || close <= 0.0 || atr <= 0.0 {
    Error(InvalidNumber("cancel conversion"))
  } else {
    let normalizedTicker = Domain.normalizeTicker(ticker)
    switch current.pendingOrders->Array.find(o => o.ticker == normalizedTicker) {
    | None => Error(NotFound("pending order"))
    | Some(order) =>
      if order.filledShares <= 0 {
        Ok({
          ...current,
          pendingOrders: current.pendingOrders->Array.filter(o => o.ticker != normalizedTicker),
        })
      } else {
        let trade = Domain.convertOrderToActiveTrade(
          ~order,
          ~todayClose=?Some(close),
          ~todayAtr=?Some(atr),
          ~fillDateISO=?Some(dateISO),
        )
        Ok({
          ...current,
          pendingOrders: current.pendingOrders->Array.filter(o => o.ticker != normalizedTicker),
          activeTrades: current.activeTrades->Array.concat([trade]),
        })
      }
    }
  }
}

let logPendingDay = (
  current: Domain.state,
  ticker: string,
  dateISO: string,
  close: float,
  atr: float,
  fill: option<(int, float)>,
): result<Domain.state, domainError> => {
  if !Domain.validISODate(dateISO) {
    Error(InvalidDate(dateISO))
  } else if !finite(close) || !finite(atr) || close <= 0.0 || atr <= 0.0 {
    Error(InvalidNumber("pending daily close/ATR"))
  } else {
    let normalizedTicker = Domain.normalizeTicker(ticker)
    switch current.pendingOrders->Array.find(o => o.ticker == normalizedTicker) {
    | None => Error(NotFound("pending order"))
    | Some(existing) =>
      switch existing.lastLoggedISO {
      | Some(lastDate) if dateISO == lastDate => Ok(current)
      | Some(lastDate) if dateISO < lastDate => Error(InvalidDate("pending day is out of order"))
      | _ => {
          let withFill = switch fill {
          | None => Ok(current)
          | Some((fillShares, fillPrice)) =>
            transitionResult(
              recordFill(
                current,
                ~ticker,
                ~dateISO,
                ~fillShares,
                ~fillPrice,
                ~todayClose=close,
                ~todayAtr=atr,
              ),
            )
          }
          switch withFill {
          | Error(error) => Error(error)
          | Ok(afterFill) =>
            switch afterFill.pendingOrders->Array.find(o => o.ticker == normalizedTicker) {
            | None => Ok(afterFill)
            | Some(order) =>
              let attempts = order.daysWaiting + 1
              let convertFilled = () => {
                if order.filledShares <= 0 {
                  Ok({
                    ...afterFill,
                    pendingOrders: afterFill.pendingOrders->Array.filter(o =>
                      o.ticker != normalizedTicker
                    ),
                  })
                } else {
                  let trade = Domain.convertOrderToActiveTrade(
                    ~order,
                    ~todayClose=?Some(close),
                    ~todayAtr=?Some(atr),
                    ~fillDateISO=?Some(dateISO),
                  )
                  Ok({
                    ...afterFill,
                    pendingOrders: afterFill.pendingOrders->Array.filter(o =>
                      o.ticker != normalizedTicker
                    ),
                    activeTrades: afterFill.activeTrades->Array.concat([trade]),
                  })
                }
              }
              if close < order.plannedStop || attempts >= Domain.maxDayOrderAttempts {
                convertFilled()
              } else {
                let available = Domain.getPendingReservedCash(
                  ~cashBalance=afterFill.cashBalance,
                  ~costs=afterFill.transactionCosts,
                  ~excludeTicker=Some(normalizedTicker),
                  ~orders=afterFill.pendingOrders,
                )
                let sizing = Domain.calculatePosition(
                  ~accountValue=afterFill.accountValue,
                  ~entry=close,
                  ~atr,
                  ~cashAvailable=available,
                )
                let perShare = Domain.buyNetCost(~gross=close, ~costs=afterFill.transactionCosts)
                let affordableShares =
                  order.filledShares + (perShare > 0.0 ? Domain.floorInt(available /. perShare) : 0)
                let cappedShares =
                  sizing.shares < affordableShares ? sizing.shares : affordableShares
                let targetShares =
                  cappedShares < order.filledShares ? order.filledShares : cappedShares
                if targetShares <= order.filledShares && order.filledShares > 0 {
                  convertFilled()
                } else if targetShares < Domain.minLotSize {
                  Ok({
                    ...afterFill,
                    pendingOrders: afterFill.pendingOrders->Array.filter(o =>
                      o.ticker != normalizedTicker
                    ),
                  })
                } else {
                  let updatedOrder = {
                    ...order,
                    plannedEntry: close,
                    plannedStop: Domain.max0(close -. Domain.atrMultiplier *. atr),
                    atr,
                    shares: targetShares,
                    daysWaiting: attempts,
                    lastLoggedISO: Some(dateISO),
                    lastLoggedDate: Domain.displayDate(dateISO),
                    accountValueAtEntry: afterFill.accountValue,
                  }
                  Ok({
                    ...afterFill,
                    pendingOrders: afterFill.pendingOrders->Array.map(o =>
                      o.ticker == normalizedTicker ? updatedOrder : o
                    ),
                  })
                }
              }
            }
          }
        }
      }
    }
  }
}

let reducer = (current: Domain.state, action: action): result<Domain.state, domainError> =>
  switch action {
  | SetAccountValue(value) =>
    finite(value) ? Ok({...current, accountValue: value}) : Error(InvalidNumber("accountValue"))
  | SetCashBalance(value) =>
    finite(value)
      ? Ok({...current, cashBalance: Domain.max0(value)})
      : Error(InvalidNumber("cashBalance"))
  | RecordRealizedPnl(value) =>
    finite(value)
      ? Ok({
          ...current,
          realizedPnl: current.realizedPnl +. value,
          accountValue: Domain.max0(current.accountValue +. value),
        })
      : Error(InvalidNumber("realizedPnl"))
  | SetTransactionCosts(costs) =>
    validCosts(costs)
      ? Ok({...current, transactionCosts: costs, transactionCostsConfigured: true})
      : Error(InvalidNumber("transaction costs"))
  | ReplaceState(next) =>
    switch duplicateInState(next) {
    | Some(ticker) => Error(DuplicateTicker(ticker))
    | None => Ok(Domain.normalizePersistedState(Domain.encodeState(next)).state)
    }
  | SetIndexBars(items) =>
    items->Array.every(validBar)
      ? Ok({...current, indexBars: normalizeIndexBars(items)})
      : Error(InvalidDate("index bar"))
  | SetCandidates(items) =>
    switch items->Array.find(c => !validCandidate(c)) {
    | Some(_) => Error(InvalidNumber("candidate metrics"))
    | None =>
      switch duplicateTicker(items->Array.map(c => c.ticker)) {
      | Some(ticker) => Error(DuplicateTicker(ticker))
      | None =>
        Ok({
          ...current,
          screenerCandidates: normalizeCandidates(items)
          ->Domain.rankCandidates
          ->Array.map(candidateJson),
        })
      }
    }
  | ImportCandidates(items) =>
    items->Array.every(validCandidate)
      ? Ok({...current, screenerCandidates: normalizeCandidates(items)->Array.map(candidateJson)})
      : Error(InvalidNumber("candidate metrics"))
  | AddPending(order) =>
    if !validOrder(order) {
      Error(InvalidOrder("pending order fields"))
    } else if (
      current.pendingOrders->Array.length + current.activeTrades->Array.length >=
        Domain.portfolioSlots
    ) {
      Error(SlotLimit)
    } else if (
      duplicateTicker(
        [order.ticker]
        ->Array.concat(current.pendingOrders->Array.map(o => o.ticker))
        ->Array.concat(current.activeTrades->Array.map(t => t.ticker)),
      )->Option.isSome
    ) {
      Error(DuplicateTicker(Domain.normalizeTicker(order.ticker)))
    } else {
      let available = Domain.getPendingReservedCash(
        ~cashBalance=current.cashBalance,
        ~costs=current.transactionCosts,
        ~excludeTicker=None,
        ~orders=current.pendingOrders,
      )
      let remaining = order.shares - order.filledShares
      let required = Domain.buyNetCost(
        ~gross=remaining->Int.toFloat *. order.plannedEntry,
        ~costs=current.transactionCosts,
      )
      required <= available +. 1e-9
        ? Ok({...current, pendingOrders: current.pendingOrders->Array.concat([order])})
        : Error(CashCap(required))
    }
  | CancelPending(ticker) =>
    switch current.pendingOrders->Array.find(o => o.ticker == Domain.normalizeTicker(ticker)) {
    | None => Error(NotFound("pending order"))
    | Some(order) =>
      order.filledShares > 0
        ? Error(InvalidOrder("filled order requires CancelPendingOn"))
        : Ok({
            ...current,
            pendingOrders: current.pendingOrders->Array.filter(o =>
              o.ticker != Domain.normalizeTicker(ticker)
            ),
          })
    }
  | CancelPendingOn(ticker, dateISO, close, atr) =>
    cancelPendingOn(current, ticker, dateISO, close, atr)
  | LogNoFill(ticker, dateISO) => logNoFill(current, ticker, dateISO)
  | RepricePending(ticker, entry, atr) => repricePending(current, ticker, entry, atr)
  | LogPendingDay(ticker, dateISO, close, atr, fill) =>
    logPendingDay(current, ticker, dateISO, close, atr, fill)
  | ApplyPendingFill(ticker, dateISO, shares, price, todayClose, todayAtr) =>
    transitionResult(
      recordFill(
        current,
        ~ticker,
        ~dateISO,
        ~fillShares=shares,
        ~fillPrice=price,
        ~todayClose,
        ~todayAtr,
      ),
    )
  | DailyUpdate(ticker, dateISO, close, atr) =>
    if !Domain.validISODate(dateISO) {
      Error(InvalidDate(dateISO))
    } else if !finite(close) || !finite(atr) || close <= 0.0 || atr <= 0.0 {
      Error(InvalidNumber("daily update"))
    } else if (
      current.activeTrades
      ->Array.find(t => t.ticker == Domain.normalizeTicker(ticker))
      ->Option.isNone
    ) {
      Error(NotFound("active trade"))
    } else {
      Ok({
        ...current,
        activeTrades: current.activeTrades->Array.map(t =>
          t.ticker == Domain.normalizeTicker(ticker)
            ? Domain.applyDailyUpdate(t, dateISO, close, atr)
            : t
        ),
      })
    }
  | Sell(ticker, shares, price, reason) =>
    applySale(current, ticker, Domain.todayKathmanduISO(), shares, price, reason)
  | SellOn(ticker, dateISO, shares, price, reason) =>
    applySale(current, ticker, dateISO, shares, price, reason)
  | Reset => Ok(Domain.defaultState())
  }

let applyPendingFill = recordFill
