import type {
  Claim,
  ClaimStatus,
  LedgerEntry,
  LineOfBusiness,
  ReservePoint,
  StatusEvent,
  Scenario,
  Workbook,
} from '../domain/types'
import { DATA_SEED, LATE_REPORT_DAYS, QUARTERS, VALUATION_DATE } from '../domain/constants'
import type { DevelopmentBasis, FactorRow, FactorSetting } from '../domain/types'
import { buildTriangle } from '../domain/triangle'
import { computeAutoFactors } from '../domain/development'
import {
  addDays,
  dayInMonth,
  daysBetween,
  monthIndex,
  quarterStart,
  toISO,
  parseISO,
} from '../domain/dates'

/**
 * 虚构脱敏数据生成器。
 *
 * 所有赔案号、金额、日期均为程序生成，不含任何真实保单/个人/车辆信息。
 * 同一 seed 生成完全一致的数据，便于测试与复现。
 *
 * 刻意覆盖的业务场景：
 * - 迟报（报案延迟 > 45 天）
 * - 拒赔（含从未支付即拒赔，形成「金额 0」单元格，与缺口区分）
 * - 拒赔后重开（重开后重新评估并继续支付）
 * - 跨险种调整（非现金，仅改变归属，不重复计入已付）
 * - 赔款冲销（冲回原支付，绝不作为新的正向支付累计）
 * - 未决评估不完整（第三方定损未回函等）
 * - 估值日前未报案（不进入三角，计入样本外提示）
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LINES: LineOfBusiness[] = ['auto', 'property', 'liability', 'marine']

const LINE_WEIGHTS: Record<LineOfBusiness, number> = {
  auto: 0.44,
  property: 0.24,
  liability: 0.22,
  marine: 0.1,
}

const SEVERITY_RANGE: Record<LineOfBusiness, [number, number]> = {
  auto: [12_000, 90_000],
  property: [45_000, 320_000],
  liability: [110_000, 620_000],
  marine: [55_000, 240_000],
}

const CLOSE_AGE_RANGE: Record<LineOfBusiness, [number, number]> = {
  auto: [3, 9],
  property: [4, 11],
  liability: [7, 15],
  marine: [4, 10],
}

/** 累计已付比例：index 0 = 报案当月月末。 */
const PAID_FRACTION = [0.04, 0.2, 0.37, 0.51, 0.63, 0.73, 0.8, 0.86, 0.9, 0.94, 0.965, 0.982, 0.99]

/** 未决评估相对最终赔款的倍数：早期偏高，逐渐释放。 */
const RESERVE_MULTIPLIER = [1.34, 1.22, 1.12, 1.06, 1.03, 1.01, 1.0]

function pickLine(rnd: () => number): LineOfBusiness {
  let r = rnd()
  for (const line of LINES) {
    if (r < LINE_WEIGHTS[line]) return line
    r -= LINE_WEIGHTS[line]
  }
  return 'auto'
}

function intBetween(rnd: () => number, min: number, max: number): number {
  return Math.floor(rnd() * (max - min + 1)) + min
}

function pick<T>(rnd: () => number, items: readonly T[]): T {
  return items[Math.floor(rnd() * items.length)]
}

function roundHundred(v: number): number {
  return Math.round(v / 100) * 100
}

function interpolate(table: number[], x: number): number {
  const clamped = Math.max(0, x)
  const lo = Math.floor(clamped)
  const hi = Math.min(table.length - 1, lo + 1)
  const t = clamped - lo
  return table[Math.min(table.length - 1, lo)] + (table[hi] - table[Math.min(table.length - 1, lo)]) * t
}

type Termination = 'normal' | 'denied_only' | 'denied_reopen'

interface ClaimSpec {
  quarter: string
  line: LineOfBusiness
  severity: number
  /** 赔付节奏（1 = 标准） */
  pace: number
  closeAge: number
  lagDays: number
  termination?: Termination
  lateMarker?: boolean
  lineAdjustment?: boolean
  correctionReversal?: boolean
  incompleteRecent?: boolean
  /** 强制报案日（用于估值日后报案的样本） */
  reportDate?: string
  /** 事故日：季度内的第 n 天（0..89） */
  accidentOffset?: number
}

function accidentDateFor(rnd: () => number, quarter: string, offset?: number): string {
  const startMonth = monthIndex(quarterStart(quarter))
  const dayOffset = offset ?? intBetween(rnd, 0, 86)
  return dayInMonth(startMonth + Math.floor(dayOffset / 30), (dayOffset % 30) + 1)
}

interface BuiltClaim {
  claim: Claim
  /** 结案日（用于数据版本/快照说明；未结案为 undefined） */
  closedAt?: string
}

function buildClaim(rnd: () => number, index: number, spec: ClaimSpec): BuiltClaim {
  const { quarter, line, severity, pace, closeAge } = spec
  const accidentDate = accidentDateFor(rnd, quarter, spec.accidentOffset)
  const reportDate = spec.reportDate ?? addDays(accidentDate, spec.lagDays)
  const reportLagDays = daysBetween(accidentDate, reportDate)
  const reportMonth = monthIndex(reportDate)
  const claimNumber = `SYN-${quarter.replace('-', '')}-${String(index).padStart(4, '0')}`
  const id = `clm-${String(index).padStart(3, '0')}`
  const valuationMonth = monthIndex(VALUATION_DATE)

  const termination: Termination = spec.termination ?? 'normal'

  const statusHistory: StatusEvent[] = [
    { id: `${id}-st-open`, at: reportDate, status: 'open', reason: '报案受理' },
  ]
  const late = spec.lateMarker || reportLagDays > LATE_REPORT_DAYS
  if (late) {
    statusHistory.push({
      id: `${id}-st-late`,
      at: reportDate,
      status: 'late_reported',
      reason: `报案延迟 ${reportLagDays} 天`,
    })
  }

  const ledger: LedgerEntry[] = []
  const reserveHistory: ReservePoint[] = []
  const lineAdjustments = []

  // ---- 拒赔 / 重开时间点 ----
  let deniedAt: string | undefined
  let reopenAt: string | undefined
  if (termination === 'denied_only') {
    deniedAt = dayInMonth(reportMonth + intBetween(rnd, 1, 2), intBetween(rnd, 8, 24))
    statusHistory.push({
      id: `${id}-st-deny`,
      at: deniedAt,
      status: 'denied',
      reason: pick(rnd, ['不属于保险责任', '未如实告知标的', '责任免除条款适用']),
    })
  } else if (termination === 'denied_reopen') {
    deniedAt = dayInMonth(reportMonth + intBetween(rnd, 1, 2), intBetween(rnd, 8, 24))
    statusHistory.push({
      id: `${id}-st-deny`,
      at: deniedAt,
      status: 'denied',
      reason: '资料不足，暂拒赔',
    })
    reopenAt = dayInMonth(monthIndex(deniedAt) + intBetween(rnd, 2, 3), intBetween(rnd, 4, 20))
    statusHistory.push({
      id: `${id}-st-reopen`,
      at: reopenAt,
      status: 'reopened',
      reason: '复议通过，重新立案',
    })
  }

  // 结案日：正常赔案按 closeAge；重开赔案顺延
  const baseCloseAt = dayInMonth(reportMonth + closeAge, intBetween(rnd, 20, 27))
  let closeAt: string | undefined
  if (termination === 'normal') {
    closeAt = baseCloseAt
  } else if (termination === 'denied_reopen') {
    closeAt = addDays(reopenAt!, intBetween(rnd, 32, 78))
  } else {
    closeAt = undefined
  }
  if (closeAt && closeAt > VALUATION_DATE) closeAt = undefined
  if (closeAt) {
    statusHistory.push({ id: `${id}-st-close`, at: closeAt, status: 'closed', reason: '结案' })
  }

  // ---- 支付计划 ----
  const payments: { at: string; amount: number; note?: string }[] = []
  const isDeniedOnly = termination === 'denied_only'
  if (!isDeniedOnly && severity > 0) {
    const horizonAge = closeAt ? Math.max(0, monthIndex(closeAt) - reportMonth) : closeAge
    let paidSoFar = 0
    for (let age = 0; age < Math.max(1, horizonAge); age++) {
      const at = dayInMonth(reportMonth + age, intBetween(rnd, 3, 26))
      if (deniedAt && at > deniedAt) break
      if (at > VALUATION_DATE) break
      const target = roundHundred(severity * interpolate(PAID_FRACTION, age * pace))
      const amount = Math.max(0, target - paidSoFar)
      if (amount <= 0) continue
      payments.push({
        at,
        amount,
        note: amount >= 150_000 ? '大额预付' : undefined,
      })
      paidSoFar += amount
    }
    if (closeAt) {
      const trueUp = roundHundred(severity - paidSoFar)
      if (trueUp > 0) {
        payments.push({
          at: toISO(parseISO(closeAt)),
          amount: trueUp,
          note: trueUp >= 150_000 ? '结案大额补付' : undefined,
        })
      }
    }
  }

  for (const [i, p] of payments.entries()) {
    ledger.push({
      id: `${id}-pay-${i + 1}`,
      kind: 'payment',
      amount: p.amount,
      valueDate: p.at,
      line,
      note: p.note,
    })
  }

  // ---- 拒赔：冲回已付款（逐笔冲销，不合并为新支付） ----
  if (deniedAt) {
    const returned = payments.filter((p) => p.at < deniedAt)
    const reversalAt = dayInMonth(monthIndex(deniedAt), intBetween(rnd, 23, 27))
    if (reversalAt <= VALUATION_DATE) {
      for (const [i, p] of returned.entries()) {
        ledger.push({
          id: `${id}-rev-${i + 1}`,
          kind: 'reversal',
          reverses: `${id}-pay-${payments.indexOf(p) + 1}`,
          amount: p.amount,
          valueDate: reversalAt,
          line,
          note: '拒赔后退回已付款',
        })
      }
    }
  }

  // ---- 普通赔案：一笔部分冲销 + 后续独立补付 ----
  if (spec.correctionReversal) {
    const first = ledger.find((e) => e.kind === 'payment')
    if (first) {
      const reverseAt = dayInMonth(monthIndex(first.valueDate) + 1, intBetween(rnd, 6, 18))
      const reverseAmount = roundHundred(first.amount * 0.45)
      if (reverseAt <= VALUATION_DATE && reverseAmount > 0) {
        ledger.push({
          id: `${id}-rev-corr`,
          kind: 'reversal',
          reverses: first.id,
          amount: reverseAmount,
          valueDate: reverseAt,
          line,
          note: '重复支付追回',
        })
        const makeUpAt = dayInMonth(monthIndex(reverseAt) + 1, intBetween(rnd, 5, 20))
        if (makeUpAt <= VALUATION_DATE) {
          ledger.push({
            id: `${id}-pay-corr`,
            kind: 'payment',
            amount: roundHundred(reverseAmount * 0.9),
            valueDate: makeUpAt,
            line,
            note: '追补差额',
          })
        }
      }
    }
  }

  // ---- 跨险种调整（非现金） ----
  if (spec.lineAdjustment) {
    const at = dayInMonth(reportMonth + intBetween(rnd, 1, 3), intBetween(rnd, 8, 22))
    if (at <= VALUATION_DATE) {
      const toLine: LineOfBusiness =
        line === 'auto' ? 'property' : line === 'property' ? 'liability' : 'marine'
      const paidAt = ledger
        .filter((e) => e.valueDate <= at)
        .reduce((s, e) => s + (e.kind === 'payment' ? e.amount : -e.amount), 0)
      lineAdjustments.push({
        id: `${id}-adj-1`,
        at,
        fromLine: line,
        toLine,
        paidAtAdjustment: roundHundred(Math.max(0, paidAt)),
        reason: '事故原因复核后调整险种归属',
      })
    }
  }

  // ---- 未决评估（逐月，不覆盖历史） ----
  const lastAge = closeAt
    ? Math.max(0, monthIndex(closeAt) - reportMonth)
    : Math.max(0, valuationMonth - reportMonth)
  for (let age = 0; age <= lastAge; age++) {
    const asOf = dayInMonth(reportMonth + age, 31)
    if (asOf > VALUATION_DATE) break
    if (closeAt && asOf >= closeAt) break
    if (deniedAt && !reopenAt && asOf >= deniedAt) break
    if (reopenAt && asOf < reopenAt) continue
    if (severity <= 0) continue
    const netPaid = ledger
      .filter((e) => e.valueDate <= asOf)
      .filter((e) => !(deniedAt && !reopenAt && e.valueDate >= deniedAt))
      .reduce((s, e) => s + (e.kind === 'payment' ? e.amount : -e.amount), 0)
    const estimate = roundHundred(
      severity * interpolate(RESERVE_MULTIPLIER, age) * (0.97 + rnd() * 0.06),
    )
    const amount = Math.max(0, roundHundred(estimate - netPaid))
    const nearValuation = valuationMonth - monthIndex(asOf) <= 1
    const incomplete = Boolean(spec.incompleteRecent) && nearValuation && amount > 0
    reserveHistory.push({
      valueDate: asOf,
      amount,
      line,
      incomplete,
      incompleteReason: incomplete
        ? pick(rnd, ['第三方定损未回函', '估损复核中', '残值待拍卖结果'])
        : undefined,
    })
  }

  const currentLine = lineAdjustments.length
    ? lineAdjustments[lineAdjustments.length - 1].toLine
    : line

  const claim: Claim = {
    id,
    claimNumber,
    accidentQuarter: quarter,
    accidentDate,
    reportDate,
    reportLagDays,
    originalLineOfBusiness: currentLine,
    statusHistory: statusHistory.sort((a, b) => a.at.localeCompare(b.at)),
    lineAdjustments,
    ledger: ledger.sort(
      (a, b) => a.valueDate.localeCompare(b.valueDate) || a.id.localeCompare(b.id),
    ),
    reserveHistory: reserveHistory.sort((a, b) => a.valueDate.localeCompare(b.valueDate)),
  }

  return { claim, closedAt: closeAt }
}

export interface DataSet {
  claims: Claim[]
  /** 已经发生的理赔状态（用于状态标签/时间线） */
  closedAt: Record<string, string | undefined>
}

interface GenerateOptions {
  seed?: number
  /** 数据版本（影响追加赔案数量） */
  dataVersion?: number
  /** 额外追加的补报案赔案数量 */
  extraArrivals?: number
  startIndex?: number
}

const BASE_QUARTER_COUNT = 8


export function generateClaims(options: GenerateOptions = {}): DataSet {
  const seed = (options.seed ?? DATA_SEED) + Math.max(0, (options.dataVersion ?? 1) - 1) * 7919
  const rnd = mulberry32(seed)
  const claims: Claim[] = []
  const closedAt: Record<string, string | undefined> = {}
  let index = options.startIndex ?? 1

  for (const [qi, quarter] of QUARTERS.entries()) {
    // 2024-Q3：同一批事故的 4 笔报案因责任免除全部拒赔，
    // 形成「已到达但金额为 0」的行为样本，用来和「缺口」区分。
    const deniedBatch = quarter === '2024-Q3'
    // 无赔案流向该发展期的季度：单元格在金额上保持为 0，与缺口（null）形成对照
    const zeroBatch = quarter === '2024-Q2'
    const batchSize = deniedBatch || zeroBatch ? 4 : BASE_QUARTER_COUNT
    if (zeroBatch) {
      for (let i = 0; i < batchSize; i++) {
        const built = buildClaim(rnd, index++, {
          quarter,
          line: 'auto',
          severity: 0,
          pace: 1,
          closeAge: 2,
          lagDays: intBetween(rnd, 6, 20),
          termination: 'denied_only',
          accidentOffset: 10 + i * 12,
        })
        claims.push(built.claim)
        closedAt[built.claim.id] = built.closedAt
      }
      continue
    }
    for (let i = 0; i < batchSize; i++) {
      if (deniedBatch) {
        const built = buildClaim(rnd, index++, {
          quarter,
          line: pickLine(rnd),
          severity: 0,
          pace: 1,
          closeAge: 2,
          lagDays: intBetween(rnd, 5, 30),
          termination: 'denied_only',
        })
        claims.push(built.claim)
        closedAt[built.claim.id] = built.closedAt
        continue
      }
      const line = pickLine(rnd)
      const [minSev, maxSev] = SEVERITY_RANGE[line]
      const severity = roundHundred(minSev + rnd() * (maxSev - minSev))
      const [minClose, maxClose] = CLOSE_AGE_RANGE[line]
      // 2025 年后的季度赔付节奏略慢，给发展因子带来可观察的漂移
      const paceBase = qi >= 8 ? 0.9 : 1.05
      // 迟报率约 13%，但延迟控制在 1 个季度内，避免大量赔案在事故季度一年后才进入三角
      const late = rnd() < 0.13
      const built = buildClaim(rnd, index++, {
        quarter,
        line,
        severity,
        pace: paceBase * (0.9 + rnd() * 0.2),
        closeAge: Math.max(3, intBetween(rnd, minClose, maxClose)),
        lagDays: late ? intBetween(rnd, 46, 96) : intBetween(rnd, 1, 38),
        lateMarker: late,
        incompleteRecent: qi >= 9 && i % 3 === 0,
      })
      claims.push(built.claim)
      closedAt[built.claim.id] = built.closedAt
    }
  }

  // ---- 显式构造的特殊赔案（保证每种场景都有样本） ----
  const specials: ClaimSpec[] = [
    {
      quarter: '2023-Q2',
      line: 'property',
      severity: 186_000,
      pace: 1,
      closeAge: 6,
      lagDays: 62,
      termination: 'denied_reopen',
      lateMarker: true,
    },
    {
      quarter: '2024-Q1',
      line: 'auto',
      severity: 0,
      pace: 1,
      closeAge: 3,
      lagDays: 12,
      termination: 'denied_only',
    },
    {
      quarter: '2024-Q2',
      line: 'marine',
      severity: 0,
      pace: 1,
      closeAge: 4,
      lagDays: 30,
      termination: 'denied_only',
    },
    {
      quarter: '2024-Q3',
      line: 'liability',
      severity: 420_000,
      pace: 1.1,
      closeAge: 10,
      lagDays: 74,
      lateMarker: true,
      incompleteRecent: true,
    },
    {
      quarter: '2024-Q4',
      line: 'marine',
      severity: 168_000,
      pace: 1,
      closeAge: 7,
      lagDays: 18,
      lineAdjustment: true,
    },
    {
      quarter: '2023-Q4',
      line: 'property',
      severity: 232_000,
      pace: 0.95,
      closeAge: 8,
      lagDays: 25,
      correctionReversal: true,
    },
    {
      quarter: '2025-Q2',
      line: 'auto',
      severity: 56_000,
      pace: 0.9,
      closeAge: 5,
      lagDays: 8,
      incompleteRecent: true,
    },
    {
      quarter: '2025-Q3',
      line: 'liability',
      severity: 310_000,
      pace: 0.9,
      closeAge: 9,
      lagDays: 41,
      incompleteRecent: true,
    },
    {
      quarter: '2023-Q1',
      line: 'auto',
      severity: 34_000,
      pace: 1.15,
      closeAge: 4,
      lagDays: 21,
      termination: 'denied_reopen',
    },
    {
      quarter: '2025-Q4',
      line: 'property',
      severity: 205_000,
      pace: 1,
      closeAge: 6,
      lagDays: 20,
      incompleteRecent: true,
    },
  ]
  for (const spec of specials) {
    const built = buildClaim(rnd, index++, spec)
    claims.push(built.claim)
    closedAt[built.claim.id] = built.closedAt
  }

  // ---- 估值日后才报案的赔案（不进入三角，用于样本外提示） ----
  const unreportedSpecs: ClaimSpec[] = [
    { quarter: '2025-Q4', line: 'property', severity: 260_000, pace: 1, closeAge: 8, lagDays: 92 },
    { quarter: '2025-Q4', line: 'auto', severity: 48_000, pace: 1, closeAge: 6, lagDays: 100 },
    { quarter: '2025-Q4', line: 'liability', severity: 380_000, pace: 1, closeAge: 11, lagDays: 96 },
  ]
  for (const [i, spec] of unreportedSpecs.entries()) {
    const built = buildClaim(rnd, index++, {
      ...spec,
      accidentOffset: 62 + i * 6,
      reportDate: addDays(VALUATION_DATE, 12 + i * 19),
    })
    claims.push(built.claim)
    closedAt[built.claim.id] = built.closedAt
  }

  // ---- 事故季度在范围外的旧赔案（不进入三角） ----
  const oldBuilt = buildClaim(rnd, index++, {
    quarter: '2022-Q4',
    line: 'property',
    severity: 90_000,
    pace: 1,
    closeAge: 5,
    lagDays: 20,
  })
  claims.push(oldBuilt.claim)
  closedAt[oldBuilt.claim.id] = oldBuilt.closedAt

  // ---- 数据版本推进：追加补报案赔案 ----
  const extras = options.extraArrivals ?? 0
  for (let i = 0; i < extras; i++) {
    const quarter = pick(rnd, ['2025-Q3', '2025-Q4', '2025-Q2', '2025-Q1'])
    const line = pickLine(rnd)
    const [minSev, maxSev] = SEVERITY_RANGE[line]
    const [minClose, maxClose] = CLOSE_AGE_RANGE[line]
    const built = buildClaim(rnd, index++, {
      quarter,
      line,
      severity: roundHundred(minSev + rnd() * (maxSev - minSev)),
      pace: 0.95,
      closeAge: intBetween(rnd, minClose, maxClose),
      lagDays: intBetween(rnd, 20, 90),
      incompleteRecent: i % 3 === 0,
      reportDate: addDays(quarterStart(quarter), intBetween(rnd, 40, 89)),
    })
    claims.push(built.claim)
    closedAt[built.claim.id] = built.closedAt
  }

  return { claims, closedAt }
}

/** 默认情景：基准 / 保守（后期因子上调并锁定）/ 乐观（后期因子下调并锁定）。 */
export function defaultScenarios(autos?: Record<DevelopmentBasis, FactorRow[]>): Scenario[] {
  const now = '2026-03-31T00:00:00.000Z'
  /** 只有仍未发展的理赔才会被因子外推，因此锁定后期（M+3 起）才能真正拉开情景差异。 */
  const LATE_FROM = 3
  const shift = (basis: DevelopmentBasis, delta: number): Record<string, FactorSetting> => {
    const rows = autos?.[basis]
    if (!rows) return {}
    const settings: Record<string, FactorSetting> = {}
    for (const row of rows) {
      if (row.from < LATE_FROM) continue
      settings[String(row.from)] = {
        mode: 'locked',
        value: Number((row.autoFactor * (1 + delta)).toFixed(4)),
        lockedAtVersion: 1,
        lockedAtDate: VALUATION_DATE,
        lockedFromAuto: row.autoFactor,
      }
    }
    return settings
  }
  return [
    {
      id: 'sc-baseline',
      name: '基准情景',
      basis: 'volume-weighted',
      isBaseline: true,
      settings: {},
      colorSlot: 1,
      createdAt: now,
      note: '金额加权、全自动因子，作为对照基准。',
    },
    {
      id: 'sc-conservative',
      name: '保守情景',
      basis: 'volume-weighted',
      isBaseline: false,
      settings: shift('volume-weighted', 0.035),
      colorSlot: 2,
      createdAt: now,
      note: '金额加权，但把 M+3 及之后的因子在期初上调 3.5% 并锁定，假设赔付尾部变长。',
    },
    {
      id: 'sc-optimistic',
      name: '乐观情景',
      basis: 'volume-weighted',
      isBaseline: false,
      settings: shift('volume-weighted', -0.025),
      colorSlot: 3,
      createdAt: now,
      note: '金额加权，但把 M+3 及之后的因子在期初下调 2.5% 并锁定，假设结案提速。',
    },
  ]
}

export function generateWorkbook(options: GenerateOptions = {}): Workbook {
  const dataVersion = options.dataVersion ?? 1
  const base = buildVersionOne(options)
  let workbook = base
  for (let v = 2; v <= dataVersion; v++) {
    workbook = arriveNewClaims(workbook, options.extraArrivals ?? 4)
  }
  return workbook
}

function buildVersionOne(options: GenerateOptions): Workbook {
  const dataVersion = 1
  const { claims, closedAt } = generateClaims({ ...options, dataVersion })
  void closedAt
  const triangle = buildTriangle(claims, { valuationDate: VALUATION_DATE, metric: 'paid' })
  const autoFor = (basis: DevelopmentBasis) => computeAutoFactors(triangle, basis)
  const autos = {
    'volume-weighted': autoFor('volume-weighted'),
    'simple-average': autoFor('simple-average'),
    'last-3-weighted': autoFor('last-3-weighted'),
    'latest-row': autoFor('latest-row'),
  } satisfies Record<DevelopmentBasis, FactorRow[]>
  return {
    schemaVersion: 2,
    valuationDate: VALUATION_DATE,
    dataVersion,
    seed: options.seed ?? DATA_SEED,
    claims,
    scenarios: defaultScenarios(autos),
    snapshots: [],
    events: [
      {
        version: dataVersion,
        at: VALUATION_DATE,
        kind: dataVersion === 1 ? 'init' : 'arrival',
        message:
          dataVersion === 1
            ? `初始化虚构数据集：${claims.length} 笔赔案（含估值日后报案）`
            : `数据版本 v${dataVersion} 到达：新增 ${options.extraArrivals ?? 0} 笔补报案赔案`,
      },
    ],
    metric: 'paid',
    basis: 'volume-weighted',
    createdAt: '2026-03-31T00:00:00.000Z',
  }
}

/** 给现有工作簿追加一批新赔案，并推进数据版本。 */
export function arriveNewClaims(workbook: Workbook, count = 4): Workbook {
  const nextVersion = workbook.dataVersion + 1
  const rnd = mulberry32(workbook.seed + nextVersion * 104729)
  const startIndex = workbook.claims.length + 1
  const additions: Claim[] = []
  for (let i = 0; i < count; i++) {
    const quarter = pick(rnd, ['2025-Q4', '2025-Q3', '2025-Q2'])
    const line = pickLine(rnd)
    const [minSev, maxSev] = SEVERITY_RANGE[line]
    const [minClose, maxClose] = CLOSE_AGE_RANGE[line]
    const built = buildClaim(rnd, startIndex + i, {
      quarter,
      line,
      severity: roundHundred(minSev + rnd() * (maxSev - minSev)),
      pace: 0.95,
      closeAge: intBetween(rnd, minClose, maxClose),
      lagDays: intBetween(rnd, 25, 110),
      incompleteRecent: i % 2 === 0,
      reportDate: addDays(quarterStart(quarter), intBetween(rnd, 45, 89)),
    })
    additions.push(built.claim)
  }
  return {
    ...workbook,
    dataVersion: nextVersion,
    claims: [...workbook.claims, ...additions],
    events: [
      ...workbook.events,
      {
        version: nextVersion,
        at: VALUATION_DATE,
        kind: 'arrival',
        message: `数据版本 v${nextVersion}：新到 ${count} 笔补报案赔案（历史快照不受影响）`,
      },
    ],
  }
}

export { LATE_REPORT_DAYS }
export type { ClaimStatus }
