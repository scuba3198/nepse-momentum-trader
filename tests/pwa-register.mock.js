let callbacks
let updateCalls = 0

export function registerSW(options) {
  callbacks = options
  return async () => {
    updateCalls += 1
  }
}

export function triggerNeedRefresh() {
  callbacks?.onNeedRefresh()
}

export function getUpdateCalls() {
  return updateCalls
}

export function resetPwaMock() {
  callbacks = undefined
  updateCalls = 0
}
