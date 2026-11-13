import type {
  Claim,
  ClaimStatus,
  LedgerEntry,
  LineAdjustment,
  LineOfBusiness,
  ReservePoint,
  StatusEvent,
} from './types'
import { LATE_REPORT_DAYS } from './constants'
import { daysBetween, elapsedMonths } from './dates'

export const LINE_LABELS: Record<LineOfBusiness, string> = {
  auto: '车险',
  property: '财产险',
  liability: '责任险',
  marine: '水险',
}

export const LINE_SHORT: Record<LineOfBusiness, string> = {
  auto: '车',
  property: '财',
  liability: '责',
  marine: '水',
}

export const STATUS_LABELS: Record<ClaimStatus, string> = {
  open: '在查',
  closed: '已结案',
  denied: '拒赔',
  reopened: '拒赔后重开',
}

export const LINES: LineOfBusiness[] = ['auto', 'property', 'liability', 'marine']

export function statusAt(claim: Claim, atDate: string): ClaimStatus {
  let status: ClaimStatus = 'open'
  for (const event of claim.statusHistory) {
    if (event.at > atDate) break
    if (
      event.status === 'open' ||
      event.status === 'closed' ||
      event.status === 'denied' ||
      event.status === 'reopened'
    ) {
      status = event.status
    }
  }
  return status
}

/** 理赔在该时点是否已报案。 */
export function isReportedAt(claim: Claim, atDate: string): boolean {
  return claim.reportDate <= atDate
}

/** 理赔在某时点的归属险种（最后一次该日期前的跨险种调整决定）。 */
export function lineAt(claim: Claim, atDate: string): LineOfBusiness {
  let line = claim.originalLineOfBusiness
  for (const adj of claim.lineAdjustments) {
    if (adj.at > atDate) break
    line = adj.toLine
  }
  return line
}

export function isLateReported(claim: Claim, atDate: string): boolean {
  if (!isReportedAt(claim, atDate)) return false
  if (claim.reportLagDays > LATE_REPORT_DAYS) return true
  return claim.statusHistory.some((e) => e.at <= atDate && e.status === 'late_reported')
}

export function everDenied(claim: Claim, atDate: string): boolean {
  return claim.statusHistory.some((e) => e.at <= atDate && e.status === 'denied')
}

export function wasReopened(claim: Claim, atDate: string): boolean {
  return claim.statusHistory.some((e) => e.at <= atDate && e.status === 'reopened')
}

export interface LedgerResult {
  /** 参与净额计算的流水：正向支付 + 有效冲销（金额为负） */
  effective: LedgerEntry[]
  payments: LedgerEntry[]
  /** 有效冲销，金额为负 */
  reversals: LedgerEntry[]
  /** 未被采用的冲销（找不到原支付、超额、或早于原支付） */
  ignoredReversals: LedgerEntry[]
  paid: number
  grossPaid: number
  /** 有效冲销合计，正数 */
  reversedAmount: number
}

/**
 * 现金流水净额。
 *
 * 规则（防止「冲销被当成新的正向支付重复累计」）：
 * 1. 冲销必须通过 reverses 指向一笔已存在的正向支付；找不到就忽略，不计入已付。
 * 2. 冲销不得早于原支付；累计冲销不得超过原支付金额，超出部分忽略。
 * 3. 冲销以负额参与净额，绝不作为正向支付加入 grossPaid。
 */
export function applyLedger(entries: LedgerEntry[]): LedgerResult {
  const payments = entries.filter((e) => e.kind === 'payment' && e.amount > 0)
  const paymentById = new Map(payments.map((p) => [p.id, p]))
  const reversedByPayment = new Map<string, number>()
  const effectiveReversals: LedgerEntry[] = []
  const ignoredReversals: LedgerEntry[] = []

  for (const rev of entries.filter((e) => e.kind === 'reversal')) {
    const original = rev.reverses ? paymentById.get(rev.reverses) : undefined
    if (!original || rev.valueDate < original.valueDate || Math.abs(rev.amount) === 0) {
      ignoredReversals.push(rev)
      continue
    }
    const already = reversedByPayment.get(original.id) ?? 0
    const room = original.amount - already
    // 超额冲销视为数据错误：整笔忽略，不做部分抵扣
    if (room <= 0 || Math.abs(rev.amount) > room) {
      ignoredReversals.push(rev)
      continue
    }
    const applied = Math.abs(rev.amount)
    reversedByPayment.set(original.id, already + applied)
    effectiveReversals.push({ ...rev, amount: -applied })
  }

  const grossPaid = payments.reduce((s, p) => s + p.amount, 0)
  const reversedAmount = [...reversedByPayment.values()].reduce((s, v) => s + v, 0)

  return {
    effective: [...payments, ...effectiveReversals],
    payments,
    reversals: effectiveReversals,
    ignoredReversals,
    grossPaid,
    reversedAmount,
    paid: grossPaid - reversedAmount,
  }
}

/** 截至某日（含）的现金流净额。 */
export function ledgerThrough(claim: Claim, throughDate: string): LedgerResult {
  return applyLedger(claim.ledger.filter((e) => e.valueDate <= throughDate))
}

/** 某日尚无任何流水，补齐为 0（用于推测早期发展期）。 */
export function ledgerSnapshotAt(claim: Claim, throughDate: string) {
  const result = ledgerThrough(claim, throughDate)
  return {
    paid: result.paid,
    grossPaid: result.grossPaid,
    reversedAmount: result.reversedAmount,
    paymentCount: result.payments.length,
    reversalCount: result.reversals.length,
    ignoredReversalCount: result.ignoredReversals.length,
    ledger: result.effective,
    payments: result.payments,
    reversals: result.reversals,
  }
}

/** 某时点生效的未决估算（取该时点前最后一个评估）。 */
export function reserveAt(claim: Claim, atDate: string): ReservePoint | undefined {
  let point: ReservePoint | undefined
  for (const p of claim.reserveHistory) {
    if (p.valueDate > atDate) break
    point = p
  }
  return point
}

/** 该时点的未决金额：已结案/拒赔为 0；重开后按最新评估；在查按最新评估。 */
export function reserveAmountAt(claim: Claim, atDate: string): number {
  if (!isReportedAt(claim, atDate)) return 0
  const status = statusAt(claim, atDate)
  if (status === 'closed' || status === 'denied') return 0
  if (status === 'reopened') {
    // 重开时点前的最新评估可能早于拒赔；重开后以重开日之后的首个评估为准
    const reopenAt = [...claim.statusHistory]
      .filter((e) => e.at <= atDate && e.status === 'reopened')
      .map((e) => e.at)
      .sort()
      .pop()
    if (!reopenAt) return 0
    const point = reserveAt(claim, atDate)
    if (!point || point.valueDate < reopenAt) return 0
    return Math.max(0, point.amount)
  }
  return Math.max(0, reserveAt(claim, atDate)?.amount ?? 0)
}

export interface ClaimAtDate {
  claim: Claim
  atDate: string
  status: ClaimStatus
  line: LineOfBusiness
  lateReported: boolean
  deniedEver: boolean
  reopened: boolean
  reported: boolean
  /** 报案后经过月数（自然月差）；未报案为 -1 */
  age: number
  paid: number
  grossPaid: number
  reversedAmount: number
  reserve: number
  reserveIncomplete: boolean
  reserveIncompleteReason?: string
  reservePoint?: ReservePoint
  paymentCount: number
  reversalCount: number
  ignoredReversalCount: number
  adjustmentCount: number
  adjustments: LineAdjustment[]
  events: StatusEvent[]
  ledger: LedgerEntry[]
}

/** 把理赔折算到指定时点：只统计该时点前已报案、且已发生的部分。 */
export function projectClaim(claim: Claim, atDate: string): ClaimAtDate {
  const reported = isReportedAt(claim, atDate)
  const status = statusAt(claim, atDate)
  const line = lineAt(claim, atDate)
  const events = claim.statusHistory.filter((e) => e.at <= atDate)
  const adjustments = claim.lineAdjustments.filter((a) => a.at <= atDate)
  const snapshot = ledgerSnapshotAt(claim, reported ? atDate : claim.reportDate)
  const reservePoint = reserveAt(claim, atDate)
  const reserve = reserveAmountAt(claim, atDate)
  const settled = status === 'closed' || status === 'denied'

  return {
    claim,
    atDate,
    status,
    line,
    lateReported: isLateReported(claim, atDate),
    deniedEver: events.some((e) => e.status === 'denied'),
    reopened: events.some((e) => e.status === 'reopened'),
    reported,
    age: reported ? Math.max(0, elapsedMonths(claim.reportDate, atDate)) : -1,
    paid: reported ? snapshot.paid : 0,
    grossPaid: reported ? snapshot.grossPaid : 0,
    reversedAmount: reported ? snapshot.reversedAmount : 0,
    reserve,
    reserveIncomplete: !settled && Boolean(reservePoint?.incomplete),
    reserveIncompleteReason: !settled && reservePoint?.incomplete ? reservePoint.incompleteReason : undefined,
    reservePoint,
    paymentCount: reported ? snapshot.paymentCount : 0,
    reversalCount: reported ? snapshot.reversalCount : 0,
    ignoredReversalCount: reported ? snapshot.ignoredReversalCount : 0,
    adjustmentCount: adjustments.length,
    adjustments,
    events,
    ledger: reported ? snapshot.ledger : [],
  }
}

export function claimStatusTimeline(claim: Claim, atDate: string): { at: string; status: ClaimStatus; label: string }[] {
  return claim.statusHistory
    .filter((e): e is StatusEvent & { status: ClaimStatus } => {
      return (
        e.at <= atDate &&
        (e.status === 'open' || e.status === 'closed' || e.status === 'denied' || e.status === 'reopened')
      )
    })
    .map((e) => ({ at: e.at, status: e.status, label: STATUS_LABELS[e.status] }))
}

export function claimReportLag(claim: Claim): number {
  return daysBetween(claim.accidentDate, claim.reportDate)
}
