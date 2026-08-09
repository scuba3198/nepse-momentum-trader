import React from 'react'
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

let App
let Domain
let Pwa
let pwaMock

beforeAll(async () => {
  ;[App, Domain, Pwa, pwaMock] = await Promise.all([
    import('../src/App.res.mjs'),
    import('../src/Domain.res.mjs'),
    import('../src/Pwa.res.mjs'),
    import('./pwa-register.mock.js'),
  ])
})

beforeEach(() => {
  document.body.innerHTML = ''
  pwaMock.resetPwaMock()
})

describe('PWA lifecycle prompt', () => {
  test('defers an update until the user explicitly reloads', async () => {
    render(React.createElement(Pwa.make))
    await act(async () => pwaMock.triggerNeedRefresh())
    expect(screen.getByText('A new desk build is ready.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText('A new desk build is ready.')).toBeNull()
    expect(pwaMock.getUpdateCalls()).toBe(0)

    await act(async () => pwaMock.triggerNeedRefresh())
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(pwaMock.getUpdateCalls()).toBe(1)
  })
})

describe('dialog keyboard behavior', () => {
  test('focuses first control, traps Tab, closes on Escape, and restores focus', () => {
    function Harness() {
      const [visible, setVisible] = React.useState(false)
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', { onClick: () => setVisible(true) }, 'Open settings'),
        React.createElement(
          App.Dialog.make,
          { visible, title: 'Settings', onClose: () => setVisible(false) },
          React.createElement('button', null, 'Save settings'),
        ),
      )
    }

    render(React.createElement(Harness))
    const trigger = screen.getByRole('button', { name: 'Open settings' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    const close = screen.getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(close)

    const save = screen.getByRole('button', { name: 'Save settings' })
    expect(document.activeElement).toBe(close)

    const naturalTab = createEvent.keyDown(dialog, { key: 'Tab' })
    fireEvent(dialog, naturalTab)
    expect(naturalTab.defaultPrevented).toBe(false)

    save.focus()
    const wrappedForward = createEvent.keyDown(dialog, { key: 'Tab' })
    fireEvent(dialog, wrappedForward)
    expect(wrappedForward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)

    close.focus()
    const wrappedBackward = createEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    fireEvent(dialog, wrappedBackward)
    expect(wrappedBackward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(save)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('holiday unavailable order guard', () => {
  test('accepts legacy unversioned calendars and rejects unsupported versions', () => {
    const legacy = JSON.stringify({ source: 'test', syncedAt: '2026-08-06T00:00:00Z', holidays: [{ date: '2026-08-06' }] })
    const unsupported = JSON.stringify({ schemaVersion: 2, holidays: [{ date: '2026-08-06' }] })
    expect(App.holidayCount(legacy)).toBe(1)
    expect(App.holidayCount(unsupported)).toBeUndefined()
  })

  test('keeps new-order action disabled while the calendar is unavailable', () => {
    const state = Domain.defaultState()
    render(
      React.createElement(App.Order.make, {
        state,
        candidate: undefined,
        blocked: false,
        holidayUnavailable: true,
        holidayLoading: false,
        sessionClosed: false,
        place: vi.fn(),
      }),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Ticker' }), { target: { value: 'NABIL' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Planned entry' }), { target: { value: '100' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'ATR (14)' }), { target: { value: '1' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Holiday calendar unavailable')
    expect(screen.getByRole('button', { name: /Resolve guards to place/i })).toBeDisabled()
  })
})
