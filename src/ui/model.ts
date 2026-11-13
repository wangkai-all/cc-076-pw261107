import type {
  CellAggregate,
  FactorRow,
  Snapshot,
  Triangle,
  TriangleMetric,
  Workbook,
  ScenarioResult,
} from '../domain/types'
import { HORIZON, QUARTERS } from '../domain/constants'
import { quarterIndex } from '../domain/dates'

/** 三角表格渲染用的单元格视图（现算与快照共用）。 */
export interface CellView {
  claimIds: string[]
  claimCount: number
  matureCount: number
  censoredCount: number
  cohortCount: number
  partial: boolean
  paid: number
  grossPaid: number
  reversedAmount: number
  caseReserve: number
  incurred: number
  incompleteCount: number
  lateReportedCount: number
  openCount: number
  closedCount: number
  deniedCount: number
  reopenedCount: number
  paymentCount: number
  reversalCount: number
  adjustmentCount: number
  adjustedAmount: number
}

export interface RowView {
  quarter: string
  cohortCount: number
  latestAge: number
  completeThrough: number
  incompleteCells: number
  unreportedCount: number
  cells: (CellView | null)[]
  /** 数据来源：现算或快照 */
  frozen: boolean
}

function liveCell(cell: CellAggregate): CellView {
  return {
    claimIds: cell.claimIds ?? [],
    claimCount: cell.claimCount,
    matureCount: cell.matureCount,
    censoredCount: cell.censoredCount,
    cohortCount: cell.cohortCount,
    partial: cell.partial,
    paid: cell.paid,
    grossPaid: cell.grossPaid,
    reversedAmount: cell.reversedAmount,
    caseReserve: cell.caseReserve,
    incurred: cell.incurred,
    incompleteCount: cell.incompleteCount,
    lateReportedCount: cell.lateReportedCount,
    openCount: cell.openCount,
    closedCount: cell.closedCount,
    deniedCount: cell.deniedCount,
    reopenedCount: cell.reopenedCount,
    paymentCount: cell.paymentCount,
    reversalCount: cell.reversalCount,
    adjustmentCount: cell.adjustmentCount,
    adjustedAmount: cell.adjustedAmount,
  }
}

export function liveRows(triangle: Triangle): RowView[] {
  return triangle.quarters.map((q) => {
    const meta = triangle.meta[q]
    const cells = (triangle.rows[q] ?? []).map((c) => (c ? liveCell(c) : null))
    return {
      quarter: q,
      cohortCount: meta.cohortCount,
      latestAge: meta.latestAge,
      completeThrough: meta.completeThrough,
      incompleteCells: meta.incompleteCells,
      unreportedCount: meta.unreportedCount,
      cells,
      frozen: false,
    }
  })
}

export function frozenRows(snapshot: Snapshot): RowView[] {
  return snapshot.rows.map((row) => {
    const cells = row.cells.map((c) =>
      c
        ? {
            claimIds: c.claimIds ?? [],
            claimCount: c.claimCount,
            matureCount: c.matureCount,
            censoredCount: c.censoredCount,
            cohortCount: c.cohortCount,
            partial: c.partial,
            paid: c.paid,
            grossPaid: c.grossPaid,
            reversedAmount: c.reversedAmount,
            caseReserve: c.caseReserve,
            incurred: snapshot.metric === 'paid' ? c.paid : c.paid + c.caseReserve,
            incompleteCount: c.incompleteCount,
            lateReportedCount: c.lateReportedCount,
            openCount: c.openCount,
            closedCount: c.closedCount,
            deniedCount: c.deniedCount,
            reopenedCount: c.reopenedCount,
            paymentCount: 0,
            reversalCount: 0,
            adjustmentCount: 0,
            adjustedAmount: 0,
          }
        : null,
    )
    const incompleteCells = cells.reduce((s, c) => s + (c && c.incompleteCount > 0 ? 1 : 0), 0)
    return {
      quarter: row.quarter,
      cohortCount: row.cohortCount,
      latestAge: row.latestAge,
      completeThrough: row.completeThrough,
      incompleteCells,
      unreportedCount: 0,
      cells,
      frozen: true,
    }
  })
}

export function currentMetricValue(cell: CellView, metric: TriangleMetric): number {
  return metric === 'paid' ? cell.paid : cell.incurred
}

export interface TripleStat {
  label: string
  value: number
}

/** 各季度按口径的合计（现算/快照）。 */
export function columnTotals(rows: RowView[], metric: TriangleMetric): { age: number; total: number; claims: number }[] {
  return Array.from({ length: HORIZON }, (_, age) => ({
    age,
    total: rows.reduce((s, r) => s + (r.cells[age] ? currentMetricValue(r.cells[age]!, metric) : 0), 0),
    claims: rows.reduce((s, r) => s + (r.cells[age]?.matureCount ?? 0), 0),
  }))
}

export function sampleSummary(workbook: Workbook, triangle?: Triangle) {
  const reported = workbook.claims.filter((c) => c.reportDate <= workbook.valuationDate)
  const unreported = workbook.claims.filter((c) => c.reportDate > workbook.valuationDate)
  return {
    reported: reported.length,
    unreported: unreported.length,
    total: workbook.claims.length,
    cohorts: QUARTERS.length,
    reportedInRange: reported.filter((c) => (QUARTERS as readonly string[]).includes(c.accidentQuarter)).length,
    cells: triangle ? triangle.quarters.reduce((s, q) => s + (triangle.rows[q] ?? []).filter(Boolean).length, 0) : 0,
  }
}

export interface FactorDisplayRow extends FactorRow {
  /** 锁定后自动因子发生的变化 */
  autoDrift: number
  /** 参与样本的季度（自动值） */
  sampleList: string
}

export function factorDisplayRows(
  auto: FactorRow[],
  applied: FactorRow[],
): FactorDisplayRow[] {
  return applied.map((row) => {
    const autoRow = auto[row.from]
    return {
      ...row,
      autoDrift: row.mode === 'locked' ? row.factor - (autoRow?.autoFactor ?? row.factor) : 0,
      sampleList: autoRow?.sampleQuarters.slice().sort((a, b) => quarterIndex(a) - quarterIndex(b)).join('、') ?? '',
    }
  })
}

export interface SeriesDatum {
  id: string
  label: string
  slot: number
  value: number
  secondary: number
  delta: number
  deltaPercent: number
  unit: string
}

export function scenarioSeries(
  results: ScenarioResult[],
  baseline: ScenarioResult | undefined,
  metric: TriangleMetric,
): SeriesDatum[] {
  const base = baseline?.ultimate ?? 0
  return results.map((r) => ({
    id: r.scenarioId,
    label: r.scenarioName,
    slot: r.colorSlot,
    value: r.ultimate,
    secondary: r.ibnr,
    delta: r.ultimate - base,
    deltaPercent: base !== 0 ? (r.ultimate - base) / base : Number.NaN,
    unit: metric === 'paid' ? '最终估计（已付口径）' : '最终估计（已付+未决口径）',
  }))
}

export function quarterCompare(
  results: ScenarioResult[],
): { quarter: string; values: { scenarioName: string; slot: number; ultimate: number; ibnr: number }[] }[] {
  return QUARTERS.map((q) => ({
    quarter: q,
    values: results.map((r) => ({
      scenarioName: r.scenarioName,
      slot: r.colorSlot,
      ultimate: r.byQuarter.find((x) => x.quarter === q)?.ultimate ?? 0,
      ibnr: r.byQuarter.find((x) => x.quarter === q)?.ibnr ?? 0,
    })),
  }))
}
