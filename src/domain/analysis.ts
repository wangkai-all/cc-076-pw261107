import type {
  DevelopmentBasis,
  FactorRow,
  Scenario,
  ScenarioResult,
  Triangle,
  TriangleMetric,
  Workbook,
} from './types'
import { buildTriangle } from './triangle'
import { computeAutoFactors, computeScenarioResult, pickBaseline } from './development'
import { createSnapshot } from '../data/snapshots'

/**
 * 分析编排：由工作簿派生三角、各口径的自动因子与各情景结果。
 * 纯函数，不修改输入，便于在 UI 中按数据版本缓存。
 */
export interface Analysis {
  triangle: Triangle
  /** 当前口径下，各因子基准的自动因子 */
  factorsByBasis: Record<DevelopmentBasis, FactorRow[]>
  /** 基准情景结果 */
  baseline: ScenarioResult
  /** 全部情景结果（按 scenarios 顺序） */
  results: ScenarioResult[]
  /** 当前口径下的基准因子（基准情景所用口径） */
  baselineFactors: FactorRow[]
  /** 各口径在「全自动因子」下的结果，用于口径对比 */
  basisResults: Record<DevelopmentBasis, ScenarioResult>
}

const BASIS_ONLY_NAME = '全自动'

export function analyse(workbook: Workbook, metric: TriangleMetric): Analysis {
  const triangle = buildTriangle(workbook.claims, {
    valuationDate: workbook.valuationDate,
    metric,
  })
  const bases: DevelopmentBasis[] = ['volume-weighted', 'simple-average', 'last-3-weighted', 'latest-row']
  const factorsByBasis = Object.fromEntries(
    bases.map((basis) => [basis, computeAutoFactors(triangle, basis)]),
  ) as Record<DevelopmentBasis, FactorRow[]>

  const results = workbook.scenarios.map((scenario) =>
    computeScenarioResult({
      scenario,
      autoFactors: factorsByBasis[scenario.basis],
      claims: workbook.claims,
      valuationDate: workbook.valuationDate,
      metric,
      triangle,
      dataVersion: workbook.dataVersion,
    }),
  )

  const baselineScenario = pickBaseline(workbook.scenarios)
  const baseline =
    results[workbook.scenarios.findIndex((s) => s.id === baselineScenario.id)] ?? results[0]

  const basisResults = Object.fromEntries(
    bases.map((basis) => {
      const scenario: Scenario = {
        id: `basis-${basis}`,
        name: BASIS_ONLY_NAME,
        basis,
        isBaseline: false,
        settings: {},
        colorSlot: 1,
        createdAt: workbook.createdAt,
      }
      return [
        basis,
        computeScenarioResult({
          scenario,
          autoFactors: factorsByBasis[basis],
          claims: workbook.claims,
          valuationDate: workbook.valuationDate,
          metric,
          triangle,
          dataVersion: workbook.dataVersion,
        }),
      ]
    }),
  ) as Record<DevelopmentBasis, ScenarioResult>

  return {
    triangle,
    factorsByBasis,
    baseline,
    results,
    baselineFactors: factorsByBasis[baselineScenario.basis] ?? factorsByBasis['volume-weighted'],
    basisResults,
  }
}

export interface ScenarioRow {
  scenario: Scenario
  result: ScenarioResult
  /** 相对基准的差异 */
  deltaUltimate: number
  deltaPercent: number
  deltaIbnr: number
  isBaseline: boolean
}

export function scenarioRows(analysis: Analysis, workbook: Workbook): ScenarioRow[] {
  return workbook.scenarios.map((scenario, i) => {
    const result = analysis.results[i]
    const deltaUltimate = result.ultimate - analysis.baseline.ultimate
    return {
      scenario,
      result,
      deltaUltimate,
      deltaPercent:
        analysis.baseline.ultimate !== 0 ? deltaUltimate / analysis.baseline.ultimate : Number.NaN,
      deltaIbnr: result.ibnr - analysis.baseline.ibnr,
      isBaseline: scenario.isBaseline,
    }
  })
}

export interface SnapshotCapture {
  label: string
  now?: string
}

/** 用当前分析结果创建快照（冻结副本，之后不再重算）。 */
export function captureSnapshot(workbook: Workbook, analysis: Analysis, label?: string) {
  const baselineScenario = pickBaseline(workbook.scenarios)
  // 快照的基准因子使用基准情景解析后的采用值（含锁定/手动）
  const baselineResult = analysis.baseline
  return createSnapshot({
    label: label ?? `数据版本 v${workbook.dataVersion} 快照`,
    metric: analysis.triangle.metric,
    basis: baselineScenario.basis,
    triangle: analysis.triangle,
    factors: baselineResult.factors,
    result: baselineResult,
    scenarioResults: analysis.results,
    dataVersion: workbook.dataVersion,
    valuationDate: workbook.valuationDate,
  })
}
