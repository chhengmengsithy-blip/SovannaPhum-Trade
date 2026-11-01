export const CAMBODIA_TIME_ZONE = 'Asia/Phnom_Penh'

const CRYPTO_SYMBOLS = new Set(['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD'])
const INDEX_SYMBOLS = new Set(['US100'])
const ENERGY_SYMBOLS = new Set(['USOIL'])

type ZonedParts = {
  weekday: string
  hour: number
  minute: number
}

export type MarketSession = {
  open: boolean
  label: 'Live' | 'Closed'
  reason: string
}

const newYorkFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function newYorkParts(date: Date): ZonedParts {
  const parts = newYorkFormatter.formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return {
    weekday: value('weekday'),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
  }
}

function weekendReason(day: string): string {
  return day === 'Sat' || day === 'Sun' ? 'Weekend' : 'Outside market hours'
}

/**
 * Display-only exchange session status. Quotes still come from the server.
 * Forex/metals use the New York 17:00 weekly boundary; US100 uses the regular
 * Nasdaq cash session. New York conversion handles DST while Cambodia stays UTC+7.
 */
export function marketSession(symbol: string, date = new Date()): MarketSession {
  const upper = symbol.toUpperCase()
  if (CRYPTO_SYMBOLS.has(upper)) return { open: true, label: 'Live', reason: 'Crypto trades 24/7' }

  const ny = newYorkParts(date)
  if (INDEX_SYMBOLS.has(upper)) {
    const weekday = !['Sat', 'Sun'].includes(ny.weekday)
    const minuteOfDay = ny.hour * 60 + ny.minute
    const open = weekday && minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60
    return {
      open,
      label: open ? 'Live' : 'Closed',
      reason: open ? 'Nasdaq regular session' : weekendReason(ny.weekday),
    }
  }

  if (ENERGY_SYMBOLS.has(upper)) {
    const minuteOfDay = ny.hour * 60 + ny.minute
    const dailyPause = minuteOfDay >= 17 * 60 && minuteOfDay < 18 * 60
    const open = ny.weekday === 'Sun'
      ? minuteOfDay >= 18 * 60
      : ny.weekday === 'Fri'
        ? minuteOfDay < 17 * 60
        : !['Sat'].includes(ny.weekday) && !dailyPause
    return {
      open,
      label: open ? 'Live' : 'Closed',
      reason: open ? 'WTI futures session' : weekendReason(ny.weekday),
    }
  }

  const open = ny.weekday === 'Sun'
    ? ny.hour >= 17
    : ny.weekday === 'Fri'
      ? ny.hour < 17
      : ny.weekday !== 'Sat'

  return {
    open,
    label: open ? 'Live' : 'Closed',
    reason: open ? 'Forex/metals weekly session' : weekendReason(ny.weekday),
  }
}

export function formatCambodiaTime(date: Date, withSeconds = true): string {
  return date.toLocaleTimeString('en-GB', {
    timeZone: CAMBODIA_TIME_ZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
  })
}

export function formatCambodiaDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    timeZone: CAMBODIA_TIME_ZONE,
    day: '2-digit',
    month: 'short',
  })
}

export function formatCambodiaChartTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('en-GB', {
    timeZone: CAMBODIA_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
