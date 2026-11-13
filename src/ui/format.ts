import { formatAmount } from '../domain/dates'

export function formatSignedAmount(value: number, compact = true): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${formatAmount(Math.abs(value), { compact })}`
}

export function formatCompact(value: number): string {
  return formatAmount(value, { compact: true })
}

function pctDigits(value: number, digits: number): number {
  const abs = Math.abs(value)
  return abs < 0.0005 ? 3 : abs < 0.01 ? 2 : digits
}

export function formatPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(pctDigits(value, digits))}%`
}

export function formatSignedPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.00005) return '≈0%'
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value * 100).toFixed(pctDigits(value, digits))}%`
}

export { formatAmount, formatFactor, formatPercent, formatSignedPercent } from '../domain/dates'
