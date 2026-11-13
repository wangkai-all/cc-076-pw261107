import type {
  Claim,
  DevelopmentBasis,
  FactorRow,
  FactorSetting,
  Scenario,
  ScenarioQuarterResult,
  ScenarioResult,
  Triangle,
  TriangleMetric,
  TriangleRowMeta,
} from './types'
import { HORIZON, MIN_SAMPLE_ROWS, QUARTERS } from './constants'
import { quarterIndex } from './dates'
import { statusAt, ledgerThrough, reserveAmountAt } from './ledger'

/** 发展因子计算口径。 */
export const BASIS_LABELS: Record<DevelopmentBasis, string> = {
  'volume-weighted': '金额加权',
  'simple-average': '简单平均',
  'last-3-weighted': '最近三期加权',
  'latest-row': '最新一行',
}

export const BASIS_ORDER: DevelopmentBasis[] = [
  'volume-weighted',
  'simple-average',
  'last-3-weighted',
  'latest-row',
]

export const BASIS_DESCRIPTIONS: Record<DevelopmentBasis, string> = {
  'volume-weighted': '各完整行的逐期合计金额相除，金额大的行权重更高。',
  'simple-average': '各完整行逐期比率取算术平均，每行等权。',
  'last-3-weighted': '只取最近 3 个完整行再按金额加权，更贴近当期趋势。',
  'latest-row': '只取最近 1 个完整行，最灵敏也最不稳定。',
}

/** 某期因子的一对完整样本。 */
export interface EligiblePair {
  quarter: string
  fromValue: number
  toValue: number
  ratio: number
}

function cellValue(triangle: Triangle, q: string, age: number): number | undefined {
  const cell = triangle.rows[q]?.[age] ?? null
  if (!cell || cell.partial || cell.incompleteCount > 0) return undefined
  return triangle.metric === 'paid' ? cell.paid : cell.incurred
}

/**
 * 参与某期因子计算的历史完整行。
 * 只接受相邻两期都完整、无缺失评估、样本数一致的行。
 * 缺口、部分单元格与不完整评估一律排除。
 */
export function eligiblePairs(triangle: Triangle, from: number): EligiblePair[] {
  const out: EligiblePair[] = []
  for (const q of triangle.quarters) {
    const fromCell = triangle.rows[q]?.[from] ?? null
    const toCell = triangle.rows[q]?.[from + 1] ?? null
    if (!fromCell || !toCell) continue
    if (fromCell.partial || toCell.partial) continue
    if (fromCell.incompleteCount > 0 || toCell.incompleteCount > 0) continue
    if (fromCell.matureCount !== toCell.matureCount) continue
    const fromValue = cellValue(triangle, q, from)
    const toValue = cellValue(triangle, q, from + 1)
    if (fromValue === undefined || toValue === undefined || fromValue <= 0) continue
    out.push({ quarter: q, fromValue, toValue, ratio: toValue / fromValue })
  }
  return out.sort((a, b) => quarterIndex(a.quarter) - quarterIndex(b.quarter))
}

function computeAutoFactor(
  pairs: EligiblePair[],
  basis: DevelopmentBasis,
): { factor: number; used: EligiblePair[]; note: string } {
  if (pairs.length === 0) {
    return { factor: 1, used: [], note: '无完整样本，按 1.0000 处理' }
  }
  if (basis === 'latest-row') {
    const last = pairs[pairs.length - 1]
    return { factor: last.ratio, used: [last], note: `取 ${last.quarter}` }
  }
  if (basis === 'last-3-weighted') {
    const used = pairs.slice(-3)
    const denom = used.reduce((s, p) => s + p.fromValue, 0)
    const numer = used.reduce((s, p) => s + p.toValue, 0)
    return {
      factor: denom > 0 ? numer / denom : 1,
      used,
      note: `最近 ${used.length} 行合并`,
    }
  }
  if (basis === 'simple-average') {
    const factor = pairs.reduce((s, p) => s + p.ratio, 0) / pairs.length
    return { factor, used: pairs, note: `${pairs.length} 行等权平均` }
  }
  const denom = pairs.reduce((s, p) => s + p.fromValue, 0)
  const numer = pairs.reduce((s, p) => s + p.toValue, 0)
  return { factor: denom > 0 ? numer / denom : 1, used: pairs, note: `${pairs.length} 行金额加权` }
}

/** 按口径计算全部自动因子（数据版本变化时会随之改变）。 */
export function computeAutoFactors(triangle: Triangle, basis: DevelopmentBasis): FactorRow[] {
  const rows: FactorRow[] = []
  for (let from = 0; from < HORIZON - 1; from++) {
    const pairs = eligiblePairs(triangle, from)
    const auto = computeAutoFactor(pairs, basis)
    rows.push({
      from,
      to: from + 1,
      factor: auto.factor,
      autoFactor: auto.factor,
      sampleSize: auto.used.length,
      sampleQuarters: auto.used.map((p) => p.quarter),
      basis,
      mode: 'auto',
      insufficient: auto.used.length < MIN_SAMPLE_ROWS,
      detail: auto.note,
    })
  }
  return rows
}

export interface ResolvedFactors {
  rows: FactorRow[]
  /** 自动样本不足的期数 */
  insufficientAutoCount: number
  /** 手动/锁定覆盖的期数 */
  overriddenCount: number
  /** 锁定值相对当前自动值出现漂移的期数 */
  driftedCount: number
}

/** 把情景的设置应用到自动因子上，得到实际采用的因子。 */
export function resolveFactors(autoRows: FactorRow[], settings: Record<string, FactorSetting>): ResolvedFactors {
  const rows = autoRows.map((row) => {
    const setting = settings[String(row.from)]
    if (!setting || setting.mode === 'auto') {
      return { ...row, mode: 'auto' as const, factor: row.autoFactor }
    }
    return {
      ...row,
      factor: setting.value,
      mode: setting.mode,
      lockedAtVersion: setting.lockedAtVersion,
      lockedAtDate: setting.lockedAtDate,
    }
  })
  return {
    rows,
    insufficientAutoCount: rows.filter((r) => r.insufficient).length,
    overriddenCount: rows.filter((r) => r.mode !== 'auto').length,
    driftedCount: rows.filter((r) => r.mode === 'locked' && Math.abs(r.factor - r.autoFactor) > 0.005).length,
  }
}

/** 从 fromAge 到 horizon-1 的剩余因子链乘积。 */
export function cumulativeFactor(rows: FactorRow[], fromAge: number, horizon: number = HORIZON): number {
  let factor = 1
  for (let age = Math.max(0, fromAge); age < horizon - 1; age++) {
    factor *= rows[age]?.factor ?? 1
  }
  return factor
}

export interface ClaimProjection {
  claim: Claim
  quarter: string
  /** 报案后经过月数（封顶 horizon-1） */
  age: number
  /** 已结案/拒赔：不外推 */
  settled: boolean
  paid: number
  caseReserve: number
  /** 估值日实际累计值（按口径） */
  currentValue: number
  remainingFactor: number
  /** 最终估计 */
  ultimate: number
  /** 需补提准备金 */
  ibnr: number
}

/**
 * 逐理赔（pointwise）投影。
 *
 * 每一笔理赔按自己报案后经过的月数，套用该情景的剩余因子链；
 * 同一事故季度内报案时点不同的赔案各自从自己的对角位置出发，
 * 不用一个"季度最深期"把年轻赔案一并外推。
 *
 * 已结案/拒赔的理赔不再发展（剩余因子 = 1）；
 * 已超过 horizon 的理赔也按 1 处理（因子链到此为止）。
 */
export function projectClaim(
  claim: Claim,
  valuationDate: string,
  metric: TriangleMetric,
  factors: FactorRow[],
): ClaimProjection | null {
  if (claim.reportDate > valuationDate) return null
  const status = statusAt(claim, valuationDate)
  const settled = status === 'closed' || status === 'denied'
  const paid = ledgerThrough(claim, valuationDate).paid
  const caseReserve = settled ? 0 : reserveAmountAt(claim, valuationDate)
  const currentValue = metric === 'paid' ? paid : paid + caseReserve
  const rawAge = monthAge(claim, valuationDate)
  const age = Math.min(HORIZON - 1, rawAge)
  const remainingFactor = settled ? 1 : cumulativeFactor(factors, age)
  const ultimate = currentValue * remainingFactor
  return {
    claim,
    quarter: claim.accidentQuarter,
    age,
    settled,
    paid,
    caseReserve,
    currentValue,
    remainingFactor,
    ultimate,
    ibnr: ultimate - currentValue,
  }
}

function monthAge(claim: Claim, valuationDate: string): number {
  const [ry, rm] = claim.reportDate.split('-').map(Number)
  const [vy, vm] = valuationDate.split('-').map(Number)
  return Math.max(0, vy * 12 + vm - (ry * 12 + rm))
}

export interface ScenarioComputeInput {
  scenario: Scenario
  autoFactors: FactorRow[]
  claims: Claim[]
  valuationDate: string
  metric: TriangleMetric
  triangle: Triangle
  dataVersion: number
}

/**
 * 情景准备金计算（逐理赔投影后按季度汇总）。
 *
 * 最终估计 = Σ 各理赔「估值日累计值 × 自身剩余因子」。
 * 需补提准备金 = 最终估计 − 已付 −（已付+未决口径下的）未决持有。
 */
export function computeScenarioResult(input: ScenarioComputeInput): ScenarioResult {
  const { scenario, autoFactors, claims, valuationDate, metric, triangle, dataVersion } = input
  const resolved = resolveFactors(autoFactors, scenario.settings)
  const projections = claims
    .map((c) => projectClaim(c, valuationDate, metric, resolved.rows))
    .filter((p): p is ClaimProjection => p !== null)

  const byQuarter: ScenarioQuarterResult[] = []
  for (const q of QUARTERS) {
    const meta: TriangleRowMeta = triangle.meta[q]
    const qp = projections.filter((p) => p.quarter === q)
    const unreportedCount = claims.filter(
      (c) => c.accidentQuarter === q && c.reportDate > valuationDate,
    ).length
    const paid = qp.reduce((s, p) => s + p.paid, 0)
    const caseReserve = qp.reduce((s, p) => s + p.caseReserve, 0)
    const currentValue = qp.reduce((s, p) => s + p.currentValue, 0)
    const ultimate = qp.reduce((s, p) => s + p.ultimate, 0)
    const settledCount = qp.filter((p) => p.settled).length
    const immature = qp.filter((p) => !p.settled)
    const latestAge = qp.length ? Math.max(...qp.map((p) => p.age)) : meta.latestAge
    const remainingFactor =
      currentValue > 0
        ? ultimate / currentValue
        : immature.length > 0
          ? immature.reduce((s, p) => s + p.remainingFactor, 0) / immature.length
          : 1
    byQuarter.push({
      quarter: q,
      claimCount: qp.length,
      unreportedCount,
      settledCount,
      immatureCount: immature.length,
      latestAge,
      currentValue,
      remainingFactor,
      ultimate,
      paid,
      caseReserve,
      ibnr: metric === 'paid' ? ultimate - paid : ultimate - paid - caseReserve,
    })
  }

  const ultimate = byQuarter.reduce((s, q) => s + q.ultimate, 0)
  const paidToDate = byQuarter.reduce((s, q) => s + q.paid, 0)
  const caseHeld = byQuarter.reduce((s, q) => s + q.caseReserve, 0)
  const ibnr = metric === 'paid' ? ultimate - paidToDate : ultimate - paidToDate - caseHeld
  const partialRows = triangle.quarters.filter((q) => triangle.meta[q].diagonalPartial)

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    isBaseline: scenario.isBaseline,
    colorSlot: scenario.colorSlot,
    metric,
    basis: scenario.basis,
    factors: resolved.rows,
    ultimate,
    ibnr,
    paidToDate,
    caseHeld,
    requiredReserve: ibnr,
    partialRows,
    incompleteCells: triangle.quarters.reduce((s, q) => s + triangle.meta[q].incompleteCells, 0),
    unreportedCount: triangle.quarters.reduce((s, q) => s + triangle.meta[q].unreportedCount, 0),
    byQuarter,
    dataVersion,
  }
}

export function scenarioDelta(current: number, baseline: number): { amount: number; percent: number } {
  return {
    amount: current - baseline,
    percent: baseline !== 0 ? (current - baseline) / baseline : Number.NaN,
  }
}

export function pickBaseline(scenarios: Scenario[]): Scenario {
  return scenarios.find((s) => s.isBaseline) ?? scenarios[0]
}
