import type {
  FrozenCell,
  FrozenQuarterRow,
  ScenarioResult,
  Snapshot,
  Triangle,
  TriangleMetric,
  DevelopmentBasis,
  FactorRow,
} from '../domain/types'

/**
 * 快照：冻结三角、因子与各情景结果。
 *
 * 关键约束：快照内一切数值都是创建时的副本；
 * 后续数据版本推进（新理赔到达）不会改写快照，
 * 只能通过「快照对比」看到新数据与快照的差异。
 */
export function freezeRows(triangle: Triangle): FrozenQuarterRow[] {
  return triangle.quarters.map((q) => {
    const meta = triangle.meta[q]
    const cells: (FrozenCell | null)[] = (triangle.rows[q] ?? []).map((cell, age) =>
      cell
        ? {
            age: age,
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
            incompleteCount: cell.incompleteCount,
            lateReportedCount: cell.lateReportedCount,
            openCount: cell.openCount,
            closedCount: cell.closedCount,
            deniedCount: cell.deniedCount,
            reopenedCount: cell.reopenedCount,
          }
        : null,
    )
    for (const [age, cell] of cells.entries()) if (cell) cell.age = age
    return {
      quarter: q,
      cohortCount: meta.cohortCount,
      latestAge: meta.latestAge,
      completeThrough: meta.completeThrough,
      cells,
    }
  })
}

export interface SnapshotInput {
  label: string
  metric: TriangleMetric
  basis: DevelopmentBasis
  triangle: Triangle
  factors: FactorRow[]
  result: ScenarioResult
  scenarioResults: ScenarioResult[]
  dataVersion: number
  valuationDate: string
  now?: string
  id?: string
}

export function createSnapshot(input: SnapshotInput): Snapshot {
  const rows = freezeRows(input.triangle)
  const partialRows = input.triangle.quarters.filter((q) => input.triangle.meta[q].diagonalPartial)
  const unreportedTotal = input.triangle.quarters.reduce(
    (s, q) => s + input.triangle.meta[q].unreportedCount,
    0,
  )
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  return {
    id: input.id ?? `snap-${input.dataVersion}-${Math.random().toString(36).slice(2, 8)}`,
    label: input.label,
    createdAt: input.now ?? new Date().toISOString(),
    valuationDate: input.valuationDate,
    dataVersion: input.dataVersion,
    metric: input.metric,
    basis: input.basis,
    factors: clone(input.factors),
    result: clone(input.result),
    scenarioResults: clone(input.scenarioResults),
    rows,
    partialRows,
    unreportedTotal,
    note: '冻结时点副本：后续数据到达不会改写本快照。',
  }
}

export interface SnapshotCompareRow {
  snapshotLabel: string
  snapshotId: string
  createdAt: string
  dataVersion: number
  ultimate: number
  ibnr: number
  paidToDate: number
  caseHeld: number
  deltaUltimate: number
  deltaPercent: number
  partialRows: string[]
  incompleteCells: number
  unreportedTotal: number
}

/** 快照与其冻结基准结果自身的对比（用于展示"快照 vs 当前"）。 */
export function compareSnapshot(
  snapshot: Snapshot,
  current: { ultimate: number; ibnr: number; dataVersion: number },
): SnapshotCompareRow {
  const delta = current.ultimate - snapshot.result.ultimate
  return {
    snapshotLabel: snapshot.label,
    snapshotId: snapshot.id,
    createdAt: snapshot.createdAt,
    dataVersion: snapshot.dataVersion,
    ultimate: snapshot.result.ultimate,
    ibnr: snapshot.result.ibnr,
    paidToDate: snapshot.result.paidToDate,
    caseHeld: snapshot.result.caseHeld,
    deltaUltimate: delta,
    deltaPercent: snapshot.result.ultimate !== 0 ? delta / snapshot.result.ultimate : Number.NaN,
    partialRows: snapshot.partialRows,
    incompleteCells: snapshot.result.incompleteCells,
    unreportedTotal: snapshot.unreportedTotal,
  }
}
