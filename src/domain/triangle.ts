import type {
  CellAggregate,
  Claim,
  Scenario,
  Triangle,
  TriangleMetric,
  TriangleRowMeta,
} from './types'
import { HORIZON, LATE_REPORT_DAYS, QUARTERS } from './constants'
import { ledgerThrough, statusAt } from './ledger'
import type { ClaimStatus } from './types'
import { ageEndDate, elapsedMonths, monthIndex, quarterEnd, quarterIndex, quarterStart } from './dates'

export { HORIZON, QUARTERS }

/**
 * 三角口径：
 * - paid（已付）：正现金流净额（正向支付 - 有效冲销）
 * - incurred（已付+未决）：净额 + 该期未决估算
 */
export function mergeMetric(paid: number, reserve: number, metric: TriangleMetric): number {
  return metric === 'paid' ? paid : paid + reserve
}

export const METRIC_LABELS: Record<TriangleMetric, string> = {
  paid: '已付',
  incurred: '已付 + 未决',
}

export interface ReportedClaim {
  claim: Claim
  /** 截至估值日已经过的月数（未封顶） */
  latestAge: number
  cohortQuarter: string
}

export function quarterInRange(quarter: string): boolean {
  return (QUARTERS as readonly string[]).includes(quarter)
}

/** 截至估值日已报案、且事故季度在范围内的理赔，按报案日排序。 */
export function reportedClaims(claims: Claim[], valuationDate: string): ReportedClaim[] {
  return claims
    .filter((c) => c.reportDate <= valuationDate && quarterInRange(c.accidentQuarter))
    .sort(
      (a, b) =>
        a.reportDate.localeCompare(b.reportDate) || a.claimNumber.localeCompare(b.claimNumber),
    )
    .map((claim) => ({
      claim,
      latestAge: Math.max(0, elapsedMonths(claim.reportDate, valuationDate)),
      cohortQuarter: claim.accidentQuarter,
    }))
}

export interface ClaimCellValue {
  claim: Claim
  age: number
  /** 该期观察月末 */
  asOf: string
  latestAge: number
  paid: number
  grossPaid: number
  reversedAmount: number
  caseReserve: number
  incurred: number
  status: ClaimStatus
  /** 赔案尚未到达该期，按最新可得期取值（截尾） */
  censored: boolean
  lateReported: boolean
  deniedEver: boolean
  reopened: boolean
  /** 跨险种调整笔数（非现金） */
  adjustmentCount: number
  /** 跨险种调整金额合计（非现金，不计入已付） */
  adjustedAmount: number
  paymentCount: number
  reversalCount: number
  /** 未被采用的冲销笔数（找不到原支付 / 超额冲销） */
  ignoredReversalCount: number
  /** 该期未决评估不完整 */
  incomplete: boolean
  incompleteReason?: string
}

function reservePointAt(claim: Claim, asOf: string) {
  let point
  for (const p of claim.reserveHistory) {
    if (p.valueDate > asOf) break
    point = p
  }
  return point
}

/**
 * 单个理赔在某发展期（报案后第 age 个月，观察月末）的累计值。
 * 状态、金额均按该期末时点计算：拒赔期未决为 0，重开后重新计量，
 * 冲销逐笔冲减已付（不新增正向支付），跨险种调整只改变归属。
 */
export function claimCellValue(item: ReportedClaim, age: number, metric: TriangleMetric): ClaimCellValue {
  const claim = item.claim
  // 尚未到达该期的赔案，按它自己的最新可得期（估值日）取值并标记为截尾，
  // 保证单元格覆盖该季度全部已报案理赔，行内金额可横向比较。
  const censored = item.latestAge < age
  const observedAge = censored ? item.latestAge : age
  const asOf = ageEndDate(claim.reportDate, observedAge)
  const status = statusAt(claim, asOf)
  const ledger = ledgerThrough(claim, asOf)
  const settled = status === 'closed' || status === 'denied'
  const point = settled ? undefined : reservePointAt(claim, asOf)
  const reserve = settled ? 0 : Math.max(0, point?.amount ?? 0)
  const adjustments = claim.lineAdjustments.filter((a) => a.at <= asOf)
  const incomplete = !settled && Boolean(point?.incomplete)

  return {
    claim,
    age,
    asOf,
    latestAge: item.latestAge,
    paid: ledger.paid,
    grossPaid: ledger.grossPaid,
    reversedAmount: ledger.reversedAmount,
    caseReserve: reserve,
    incurred: mergeMetric(ledger.paid, reserve, metric),
    status,
    censored,
    lateReported: claim.reportLagDays > LATE_REPORT_DAYS,
    deniedEver: claim.statusHistory.some((e) => e.at <= asOf && e.status === 'denied'),
    reopened: claim.statusHistory.some((e) => e.at <= asOf && e.status === 'reopened'),
    adjustmentCount: adjustments.length,
    adjustedAmount: adjustments.reduce((s, a) => s + a.paidAtAdjustment, 0),
    paymentCount: ledger.payments.length,
    reversalCount: ledger.reversals.length,
    ignoredReversalCount: ledger.ignoredReversals.length,
    incomplete,
    incompleteReason: incomplete ? point?.incompleteReason : undefined,
  }
}

export function claimsInCell(
  claims: Claim[],
  valuationDate: string,
  quarter: string,
  age: number,
  metric: TriangleMetric,
): ClaimCellValue[] {
  const cohort = cohortClaims(claims, valuationDate, quarter)
  if (cohort.length === 0 || age > Math.max(...cohort.map((r) => r.latestAge))) return []
  return cohort.map((r) => claimCellValue(r, age, metric))
}

/** 该季度截至估值日的全部已报案理赔（含尚未到达某发展期的）。 */
export function cohortClaims(claims: Claim[], valuationDate: string, quarter: string): ReportedClaim[] {
  return reportedClaims(claims, valuationDate).filter((r) => r.cohortQuarter === quarter)
}

function aggregateValues(values: ClaimCellValue[], cohortCount: number, metric: TriangleMetric): CellAggregate {
  const mature = values.filter((v) => !v.censored)
  const censored = values.filter((v) => v.censored)
  return {
    // 单元格金额覆盖该季度全部已报案理赔：未满该期的赔案按其最新可得值延续，
    // 否则同一季度越深的期数样本越少、金额会无故下降，与缺口/零金额混淆。
    claimCount: values.length,
    matureCount: mature.length,
    censoredCount: censored.length,
    cohortCount,
    partial: censored.length > 0,
    paid: values.reduce((s, v) => s + v.paid, 0),
    grossPaid: values.reduce((s, v) => s + v.grossPaid, 0),
    reversedAmount: values.reduce((s, v) => s + v.reversedAmount, 0),
    caseReserve: values.reduce((s, v) => s + v.caseReserve, 0),
    incurred: values.reduce((s, v) => s + mergeMetric(v.paid, v.caseReserve, metric), 0),
    openCount: values.filter((v) => v.status === 'open').length,
    closedCount: values.filter((v) => v.status === 'closed').length,
    deniedCount: values.filter((v) => v.status === 'denied').length,
    reopenedCount: values.filter((v) => v.status === 'reopened').length,
    lateReportedCount: values.filter((v) => v.lateReported).length,
    // 含截尾计入的赔案：其值同样取自不完整的未决评估，单元格整体不能当作完整样本
    incompleteCount: values.filter((v) => v.incomplete).length,
    paymentCount: values.reduce((s, v) => s + v.paymentCount, 0),
    reversalCount: values.reduce((s, v) => s + v.reversalCount, 0),
    adjustmentCount: values.reduce((s, v) => s + v.adjustmentCount, 0),
    adjustedAmount: values.reduce((s, v) => s + v.adjustedAmount, 0),
    claimIds: values.map((v) => v.claim.id),
  }
}

export interface BuildTriangleOptions {
  valuationDate: string
  metric: TriangleMetric
  horizon?: number
}

/**
 * 发展三角。
 *
 * 单元格 (事故季度 Q, 报案后 age 个月) 汇总该季度截至估值日已报案的理赔，
 * 每笔理赔取其「报案月 + age」的月末时点（不晚于估值日）。
 * - 行深度 = 该季度最新报案理赔的已过月数；超过深度的格为缺口（null）。
 * - 缺口与金额 0 严格区分：没有理赔到达该期 ≠ 金额为零。
 * - 未决评估不完整的格单独计数，不当作完整样本。
 */
export function buildTriangle(claims: Claim[], options: BuildTriangleOptions): Triangle {
  const { valuationDate, metric } = options
  const horizon = options.horizon ?? HORIZON
  const quarters = [...QUARTERS].sort((a, b) => quarterIndex(a) - quarterIndex(b))
  const rows: Record<string, (CellAggregate | null)[]> = {}
  const meta: Record<string, TriangleRowMeta> = {}
  let maxValue = 0

  for (const q of quarters) {
    const allInQuarter = claims.filter((c) => c.accidentQuarter === q)
    const known = allInQuarter.filter((c) => c.reportDate <= valuationDate)
    const unreportedCount = allInQuarter.length - known.length
    const row: (CellAggregate | null)[] = Array.from({ length: horizon }, () => null)
    let incompleteCellCount = 0
    let latestAge = -1
    let latestClaimCount = 0
    let latestEnded = ''

    const items: ReportedClaim[] = known.map((claim) => ({
      claim,
      latestAge: Math.max(0, elapsedMonths(claim.reportDate, valuationDate)),
      cohortQuarter: q,
    }))

    let actualLatestAge = 0
    if (items.length > 0) {
      // 行深度 = 该季度理赔已到达的最深期；
      // 报案较晚的理赔尚未到达的早期格为部分单元格（partial），不会显示成缺口
      actualLatestAge = Math.max(...items.map((r) => r.latestAge))
      latestAge = Math.min(horizon - 1, actualLatestAge)
    }

    for (let age = 0; age <= latestAge; age++) {
      // 全部已报案赔案都进入单元格：未满该期的按最新值截尾计入，并标记为部分样本
      const values = items.map((r) => claimCellValue(r, age, metric))
      if (values.length === 0) continue
      const agg = aggregateValues(values, known.length, metric)
      if (agg.incompleteCount > 0) incompleteCellCount += 1
      row[age] = agg
      latestClaimCount = agg.matureCount
      latestEnded = values.reduce((latest, v) => (!v.censored && v.asOf > latest ? v.asOf : latest), '')
      maxValue = Math.max(maxValue, agg.paid, agg.caseReserve, agg.incurred)
    }

    let completeThrough = -1
    for (let age = 0; age < horizon; age++) {
      const cell = row[age]
      if (!cell) break
      if (!cell.partial && cell.incompleteCount === 0) completeThrough = age
      else break
    }

    rows[q] = row
    meta[q] = {
      quarter: q,
      cohortCount: known.length,
      unreportedCount,
      actualLatestAge: Math.max(0, actualLatestAge),
      latestAge: Math.max(0, latestAge),
      latestClaimCount,
      completeThrough,
      diagonalPartial: Boolean(row[Math.max(0, latestAge)]?.partial),
      incompleteCells: incompleteCellCount,
      latestEnded,
    }
  }

  return { horizon, metric, rows, meta, quarters, maxValue }
}

export interface QuarterValuationTotals {
  quarter: string
  paid: number
  caseReserve: number
  incurred: number
  claimCount: number
  unreportedCount: number
  incompleteCount: number
  /** 该季度理赔的最小已过月数（封顶 horizon-1），即三角行深度 */
  latestAge: number
}

/**
 * 估值日各季度的实际累计数（含超过发展三角窗口的后续支付/评估），
 * 用于「已付」「未决持有」以及已发展季度的最终估计。
 */
export function valuationTotals(
  claims: Claim[],
  valuationDate: string,
  metric: TriangleMetric,
  horizon: number = HORIZON,
): { byQuarter: Record<string, QuarterValuationTotals>; total: QuarterValuationTotals } {
  const byQuarter: Record<string, QuarterValuationTotals> = {}
  const total: QuarterValuationTotals = {
    quarter: '合计',
    paid: 0,
    caseReserve: 0,
    incurred: 0,
    claimCount: 0,
    unreportedCount: 0,
    incompleteCount: 0,
    latestAge: horizon - 1,
  }

  for (const q of QUARTERS) {
    const allInQuarter = claims.filter((c) => c.accidentQuarter === q)
    const known = allInQuarter.filter((c) => c.reportDate <= valuationDate)
    let paid = 0
    let caseReserve = 0
    let incompleteCount = 0
    let latestAge = horizon - 1
    if (known.length > 0) {
      latestAge = Math.min(
        horizon - 1,
        Math.min(...known.map((c) => Math.max(0, elapsedMonths(c.reportDate, valuationDate)))),
      )
    }
    for (const claim of known) {
      paid += ledgerThrough(claim, valuationDate).paid
      const status = statusAt(claim, valuationDate)
      if (status === 'closed' || status === 'denied') continue
      const point = reservePointAtOrAfterReopen(claim, valuationDate)
      caseReserve += Math.max(0, point?.amount ?? 0)
      if (point?.incomplete) incompleteCount += 1
    }
    const totals: QuarterValuationTotals = {
      quarter: q,
      paid,
      caseReserve,
      incurred: mergeMetric(paid, caseReserve, metric),
      claimCount: known.length,
      unreportedCount: allInQuarter.length - known.length,
      incompleteCount,
      latestAge,
    }
    byQuarter[q] = totals
    total.paid += paid
    total.caseReserve += caseReserve
    total.claimCount += known.length
    total.unreportedCount += totals.unreportedCount
    total.incompleteCount += incompleteCount
    total.latestAge = Math.min(total.latestAge, latestAge)
  }
  total.incurred = mergeMetric(total.paid, total.caseReserve, metric)
  return { byQuarter, total }
}

function reservePointAtOrAfterReopen(claim: Claim, atDate: string) {
  const status = statusAt(claim, atDate)
  let point
  for (const p of claim.reserveHistory) {
    if (p.valueDate > atDate) break
    point = p
  }
  if (status === 'reopened') {
    const reopenAt = [...claim.statusHistory]
      .filter((e) => e.at <= atDate && e.status === 'reopened')
      .map((e) => e.at)
      .sort()
      .pop()
    if (!reopenAt || !point || point.valueDate < reopenAt) return undefined
  }
  return point
}

/** 选中单元格的汇总（与三角同口径，用于明细面板核对）。 */
export function aggregateForSelection(
  claims: Claim[],
  valuationDate: string,
  quarter: string,
  age: number,
  metric: TriangleMetric,
): CellAggregate | null {
  const cohort = cohortClaims(claims, valuationDate, quarter)
  if (cohort.length === 0 || age > Math.max(...cohort.map((r) => r.latestAge))) return null
  return aggregateValues(
    cohort.map((r) => claimCellValue(r, age, metric)),
    cohort.length,
    metric,
  )
}

export function quarterBounds(quarter: string): { start: string; end: string } {
  return { start: quarterStart(quarter), end: quarterEnd(quarter) }
}

export function ageWindowEnd(reportDate: string, age: number): string {
  return ageEndDate(reportDate, age)
}

export function reportMonth(claim: Claim): number {
  return monthIndex(claim.reportDate)
}

export type { Scenario }
