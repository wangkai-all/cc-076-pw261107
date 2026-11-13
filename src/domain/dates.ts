/** 日期与金额工具。所有月份以 UTC 计算，避免时区漂移。 */

const MS_PER_DAY = 86_400_000

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
}

export function toISO(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  return toISO(new Date(parseISO(iso).getTime() + days * MS_PER_DAY))
}

export function daysBetween(fromISO: string, toISOValue: string): number {
  return Math.round((parseISO(toISOValue).getTime() - parseISO(fromISO).getTime()) / MS_PER_DAY)
}

/** 月份序号（自 1970-01 起算）。 */
export function monthIndex(iso: string): number {
  const d = parseISO(iso)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}

export function monthStartFromIndex(index: number): string {
  const y = Math.floor(index / 12)
  const m = (index % 12) + 1
  return `${y}-${String(m).padStart(2, '0')}-01`
}

/** 该月中的某一天（安全夹到月末）。 */
export function dayInMonth(index: number, day: number): string {
  const start = parseISO(monthStartFromIndex(index))
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
  return toISO(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), Math.min(day, lastDay))))
}

export function monthEndOf(iso: string): string {
  const index = monthIndex(iso)
  return dayInMonth(index, 31)
}

export function quarterOfDate(iso: string): string {
  const d = parseISO(iso)
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`
}

export function quarterStart(quarter: string): string {
  const [y, q] = quarter.split('-Q').map(Number)
  return `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`
}

export function quarterEnd(quarter: string): string {
  const start = parseISO(quarterStart(quarter))
  const lastMonthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 1))
  return monthEndOf(toISO(lastMonthStart))
}

export function quarterIndex(quarter: string): number {
  const [y, q] = quarter.split('-Q').map(Number)
  return y * 4 + (q - 1)
}

export function quarterFromIndex(index: number): string {
  const y = Math.floor(index / 4)
  return `${y}-Q${(index % 4) + 1}`
}

export function quartersBetween(from: string, to: string): string[] {
  const a = quarterIndex(from)
  const b = quarterIndex(to)
  const out: string[] = []
  for (let i = a; i <= b; i++) out.push(quarterFromIndex(i))
  return out
}

/** 报案后经过月数（自然月差）。0 = 报案当月。 */
export function elapsedMonths(reportDate: string, valuationDate: string): number {
  return monthIndex(valuationDate) - monthIndex(reportDate)
}

/** 某期（age）对应的观察月末日期。 */
export function ageEndDate(reportDate: string, age: number): string {
  return monthEndOf(monthStartFromIndex(monthIndex(reportDate) + age))
}

/** 三角展示用的月份标签：2024-03。 */
export function monthLabel(iso: string): string {
  return iso.slice(0, 7)
}

export function formatAmount(value: number, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const { compact = false, sign = false } = opts
  const abs = Math.abs(value)
  const prefix = value < 0 && sign ? '-' : ''
  if (compact && abs >= 1_000_000) {
    const v = abs / 1_000_000
    return `${prefix}${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}M`
  }
  if (compact && abs >= 10_000) {
    const v = abs / 10_000
    return `${prefix}${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}万`
  }
  return `${prefix}${abs.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
}

/** 三角单元格的紧凑金额：万，保留 1 位；0 显示 0。 */
export function cellAmount(value: number): string {
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 10_000) {
    const v = abs / 10_000
    return `${value < 0 ? '-' : ''}${v >= 100 ? v.toFixed(0) : v.toFixed(1)}`
  }
  return `${value < 0 ? '-' : ''}${Math.round(abs)}`
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const d = abs < 0.0005 ? 3 : abs < 0.01 ? 2 : digits
  return `${(value * 100).toFixed(d)}%`
}

export function formatFactor(value: number): string {
  return value.toFixed(4)
}

export function formatSignedPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.0005) return '≈0%'
  const abs = Math.abs(value)
  const d = abs < 0.01 ? 2 : digits
  const sign = value > 0 ? '+' : '−'
  return `${sign}${(abs * 100).toFixed(d)}%`
}

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
