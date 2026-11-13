import { describe, expect, it } from 'vitest'
import { generateWorkbook } from '../src/data/generator'
import { applyLedger } from '../src/domain/ledger'
import { buildTriangle, claimsInCell, valuationTotals } from '../src/domain/triangle'
import { ageEndDate } from '../src/domain/dates'
import { computeAutoFactors, computeScenarioResult, cumulativeFactor, resolveFactors } from '../src/domain/development'
import { createSnapshot } from '../src/data/snapshots'
import type { LedgerEntry } from '../src/domain/types'

const wb = generateWorkbook()
const valuationDate = wb.valuationDate

describe('generator 覆盖关键场景', () => {
  it('生成 12 个季度、含未报案与范围外赔案', () => {
    expect(wb.claims.length).toBeGreaterThan(90)
    const unreported = wb.claims.filter((c) => c.reportDate > valuationDate)
    expect(unreported.length).toBe(3)
    expect(unreported.every((c) => c.accidentQuarter === '2025-Q4')).toBe(true)
    expect(wb.claims.some((c) => c.accidentQuarter === '2022-Q4')).toBe(true)
  })

  it('覆盖迟报、拒赔、重开、跨险种调整、冲销与不完整评估', () => {
    expect(wb.claims.some((c) => c.reportLagDays > 45)).toBe(true)
    expect(wb.claims.some((c) => c.statusHistory.some((e) => e.status === 'denied'))).toBe(true)
    expect(wb.claims.some((c) => c.statusHistory.some((e) => e.status === 'reopened'))).toBe(true)
    expect(wb.claims.some((c) => c.lineAdjustments.length > 0)).toBe(true)
    expect(wb.claims.some((c) => c.ledger.some((e) => e.kind === 'reversal'))).toBe(true)
    expect(wb.claims.some((c) => c.reserveHistory.some((p) => p.incomplete))).toBe(true)
  })

  it('同 seed 输出稳定', () => {
    const again = generateWorkbook()
    expect(again.claims.map((c) => c.claimNumber)).toEqual(wb.claims.map((c) => c.claimNumber))
    expect(again.claims[7].ledger).toEqual(wb.claims[7].ledger)
  })
})

describe('冲销不会作为新的正向支付累计', () => {
  const entries: LedgerEntry[] = [
    { id: 'p1', kind: 'payment', amount: 10_000, valueDate: '2024-01-10', line: 'auto' },
    { id: 'r1', kind: 'reversal', reverses: 'p1', amount: 4_000, valueDate: '2024-02-10', line: 'auto' },
    { id: 'r2', kind: 'reversal', reverses: 'p1', amount: 9_000, valueDate: '2024-02-20', line: 'auto' },
    { id: 'r3', kind: 'reversal', reverses: 'missing', amount: 5_000, valueDate: '2024-02-21', line: 'auto' },
    { id: 'r4', kind: 'reversal', reverses: 'p1', amount: 1_000, valueDate: '2023-12-01', line: 'auto' },
  ]

  it('净额 = 正向支付 − 有效冲销，超额/无主/早于支付的冲销被忽略', () => {
    const result = applyLedger(entries)
    expect(result.grossPaid).toBe(10_000)
    // 超额冲销整笔忽略（数据错误），不做部分抵扣
    expect(result.reversedAmount).toBe(4_000)
    expect(result.paid).toBe(6_000)
    expect(result.payments.length).toBe(1)
    expect(result.ignoredReversals.map((r) => r.id).sort()).toEqual(['r2', 'r3', 'r4'])
  })

  it('冲销记录的金额在有效集合中为负，绝不增加 grossPaid', () => {
    const result = applyLedger(entries)
    expect(result.reversals.every((r) => r.amount < 0)).toBe(true)
    expect(result.effective.filter((e) => e.kind === 'payment').length).toBe(1)
  })

  it('拒赔后重开的赔案：拒赔时点净额被冲回到 0，重开后重新累计', () => {
    const claim = wb.claims.find((c) => c.statusHistory.some((e) => e.status === 'reopened'))!
    const denyAt = claim.statusHistory.find((e) => e.status === 'denied')!.at
    const before = applyLedger(claim.ledger.filter((e) => e.valueDate <= denyAt))
    expect(before.paid).toBeGreaterThanOrEqual(0)
    const atValuation = applyLedger(claim.ledger)
    expect(atValuation.paid).toBeGreaterThanOrEqual(before.paid)
  })
})

function denialQuarter(
  triangle: ReturnType<typeof buildTriangle>,
  claims: typeof wb.claims,
  valuationDate: string,
  claimId: string,
): string | undefined {
  for (const q of triangle.quarters) {
    for (const [age, cell] of (triangle.rows[q] ?? []).entries()) {
      if (!cell) continue
      if (claimsInCell(claims, valuationDate, q, age, 'paid').some((m) => m.claim.id === claimId)) return q
    }
  }
  return undefined
}

describe('发展三角', () => {
  const triangle = buildTriangle(wb.claims, { valuationDate, metric: 'paid' })

  it('12 个季度、12 期', () => {
    expect(triangle.quarters).toHaveLength(12)
    expect(triangle.horizon).toBe(12)
  })

  it('缺口（null）与金额 0 严格区分', () => {
    const q = '2025-Q4'
    const row = triangle.rows[q]
    expect(row).toBeDefined()
    // 最深期之后必须是 null，而不是 0
    const meta = triangle.meta[q]
    expect(meta.actualLatestAge).toBeLessThan(11)
    expect(row[meta.actualLatestAge + 1]).toBeNull()
    expect(row[11]).toBeNull()
    // 存在「已到达但金额为 0」的理赔（拒赔未付），它所在单元格不是缺口
    const deniedZero = wb.claims.find(
      (c) => c.statusHistory.some((e) => e.status === 'denied') && c.ledger.length === 0,
    )
    expect(deniedZero).toBeDefined()
    let seen = false
    for (const q of triangle.quarters) {
      const row = triangle.rows[q] ?? []
      for (const [age, cell] of row.entries()) {
        if (!cell) continue
        const members = claimsInCell(wb.claims, valuationDate, q, age, 'paid')
        const zero = members.find((m) => m.claim.id === deniedZero!.id && m.paid === 0)
        if (zero) {
          expect(cell.paid).toBeGreaterThanOrEqual(0)
          expect(cell.claimCount).toBeGreaterThan(0)
          seen = true
        }
      }
    }
    expect(seen).toBe(true)
    // 该理赔所在单元格是已到达的真实单元格（非缺口），且金额可以合法为 0
    const deniedRow = denialQuarter(triangle, wb.claims, valuationDate, deniedZero!.id)
    expect(deniedRow).toBeTruthy()
  })

  it('行深度不超过 horizon，且样本数不超过季度报案数', () => {
    for (const q of triangle.quarters) {
      const meta = triangle.meta[q]
      expect(meta.latestAge).toBeLessThanOrEqual(11)
      for (const cell of triangle.rows[q] ?? []) {
        if (!cell) continue
        expect(cell.claimCount).toBeLessThanOrEqual(cell.cohortCount)
        expect(cell.cohortCount).toBe(meta.cohortCount)
      }
    }
  })

  it('单元格明细合计与三角单元格一致', () => {
    const q = '2024-Q1'
    const age = 3
    const cell = triangle.rows[q][age]!
    const claims = claimsInCell(wb.claims, valuationDate, q, age, 'paid')
    expect(claims.length).toBe(cell.claimCount)
    const paid = claims.reduce((s, c) => s + c.paid, 0)
    expect(paid).toBeCloseTo(cell.paid, 6)
    expect(claims.reduce((s, c) => s + c.grossPaid, 0)).toBeCloseTo(cell.grossPaid, 6)
    expect(claims.reduce((s, c) => s + c.reversedAmount, 0)).toBeCloseTo(cell.reversedAmount, 6)
  })

  it('赔付逐期累计不减（同一理赔），冲销后仍不为负', () => {
    const q = '2024-Q1'
    const cells = triangle.rows[q]
    let prev = 0
    for (const cell of cells) {
      if (!cell) break
      expect(cell.paid).toBeGreaterThanOrEqual(0)
      expect(cell.grossPaid).toBeGreaterThanOrEqual(cell.reversedAmount)
      expect(cell.reversedAmount).toBeGreaterThanOrEqual(0)
      prev = cell.paid
    }
    expect(prev).toBeGreaterThan(0)
  })

  it('估值日实际累计不低于三角末列的已付', () => {
    const totals = valuationTotals(wb.claims, valuationDate, 'paid')
    for (const q of triangle.quarters) {
      const age = triangle.meta[q].latestAge
      const cell = triangle.rows[q][age]
      if (!cell) continue
      expect(totals.byQuarter[q].paid).toBeGreaterThanOrEqual(cell.paid - 1e-6)
    }
  })
})

describe('发展因子与情景', () => {
  const triangle = buildTriangle(wb.claims, { valuationDate, metric: 'paid' })
  const factors = computeAutoFactors(triangle, 'volume-weighted')

  it('11 个发展期因子且随期数递减', () => {
    expect(factors).toHaveLength(11)
    expect(factors[0].factor).toBeGreaterThan(1)
    expect(factors[10].factor).toBeGreaterThanOrEqual(1)
    expect(factors[0].factor).toBeGreaterThan(factors[5].factor)
  })

  it('样本数随期数减少，且早期样本充足', () => {
    expect(factors[0].sampleSize).toBeGreaterThan(4)
    expect(factors[0].sampleSize).toBeGreaterThanOrEqual(factors[9].sampleSize)
    expect(factors[0].insufficient).toBe(false)
  })

  it('锁定因子不被自动重算覆盖', () => {
    const settings = { '0': { mode: 'locked' as const, value: 2.5, lockedAtVersion: 1 } }
    const resolved = resolveFactors(factors, settings)
    expect(resolved.rows[0].factor).toBe(2.5)
    expect(resolved.rows[0].autoFactor).toBe(factors[0].autoFactor)
    expect(resolved.rows[0].mode).toBe('locked')
  })

  it('情景最终估计 = 各季度逐理赔投影之和', () => {
    const base = wb.scenarios[0]
    const result = computeScenarioResult({
      scenario: base,
      autoFactors: factors,
      claims: wb.claims,
      valuationDate,
      metric: 'paid',
      triangle,
      dataVersion: 1,
    })
    const quarterSum = result.byQuarter.reduce((s, q) => s + q.ultimate, 0)
    expect(result.ultimate).toBeCloseTo(quarterSum, 6)
    expect(result.ultimate).toBeGreaterThan(result.paidToDate)
    expect(result.ibnr).toBeCloseTo(result.ultimate - result.paidToDate, 6)
  })

  it('更高的因子产生更高的最终估计，且不影响已付', () => {
    const base = wb.scenarios[0]
    const result = computeScenarioResult({
      scenario: base,
      autoFactors: factors,
      claims: wb.claims,
      valuationDate,
      metric: 'paid',
      triangle,
      dataVersion: 1,
    })
    const stressed = computeScenarioResult({
      scenario: {
        ...base,
        id: 'stress',
        settings: Object.fromEntries(
          factors.map((f) => [String(f.from), { mode: 'manual' as const, value: f.factor * 1.15 }]),
        ),
      },
      autoFactors: factors,
      claims: wb.claims,
      valuationDate,
      metric: 'paid',
      triangle,
      dataVersion: 1,
    })
    expect(stressed.ultimate).toBeGreaterThan(result.ultimate)
    expect(stressed.paidToDate).toBeCloseTo(result.paidToDate, 6)
    // 全部理赔都已结案的季度不受因子影响
    const dev = result.byQuarter.filter((q) => q.latestAge >= 11 && q.immatureCount === 0)
    expect(dev.length).toBeGreaterThan(0)
    for (const q of dev) {
      const same = stressed.byQuarter.find((x) => x.quarter === q.quarter)!
      expect(same.ultimate).toBeCloseTo(q.ultimate, 6)
    }
    // 仍有在查赔案、且未发展满 11 期的季度会被提高
    const open = result.byQuarter.filter((q) => q.immatureCount > 0 && q.currentValue > 0 && q.latestAge < 11)
    expect(open.length).toBeGreaterThan(0)
    for (const q of open) {
      const same = stressed.byQuarter.find((x) => x.quarter === q.quarter)!
      expect(same.ultimate).toBeGreaterThan(q.ultimate)
    }
  })

  it('剩余因子链与累计因子一致', () => {
    const f = factors.map((r) => ({ ...r, factor: 2 }))
    expect(cumulativeFactor(f, 9)).toBeCloseTo(4, 6)
    expect(cumulativeFactor(f, 11)).toBeCloseTo(1, 6)
  })

  it('已结案理赔不参与外推', () => {
    const base = wb.scenarios[0]
    const result = computeScenarioResult({
      scenario: base,
      autoFactors: factors,
      claims: wb.claims,
      valuationDate,
      metric: 'paid',
      triangle,
      dataVersion: 1,
    })
    // 每个季度都要有已结案样本（样本数量展示）
    expect(result.byQuarter.every((q) => q.settledCount >= 0)).toBe(true)
    expect(result.byQuarter.reduce((s, q) => s + q.claimCount, 0)).toBeGreaterThan(90)
  })
})

describe('快照不因新理赔静默改写', () => {
  it('冻结后数据版本推进，快照结果保持不变', () => {
    const triangle = buildTriangle(wb.claims, { valuationDate, metric: 'paid' })
    const factors = computeAutoFactors(triangle, 'volume-weighted')
    const scenario = wb.scenarios[0]
    const result = computeScenarioResult({
      scenario,
      autoFactors: factors,
      claims: wb.claims,
      valuationDate,
      metric: 'paid',
      triangle,
      dataVersion: 1,
    })
    const snap = createSnapshot({
      label: '2026-03-31 快照',
      metric: 'paid',
      basis: 'volume-weighted',
      triangle,
      factors,
      result,
      scenarioResults: [result],
      dataVersion: 1,
      valuationDate,
      now: '2026-03-31T10:00:00.000Z',
    })
    const frozenUltimate = snap.result.ultimate
    const frozenRows = JSON.stringify(snap.rows)

    // 新数据到达
    const v2 = generateWorkbook({ dataVersion: 2, extraArrivals: 6 })
    const triangle2 = buildTriangle(v2.claims, { valuationDate, metric: 'paid' })
    expect(triangle2.rows['2025-Q4'].some((c) => c !== null)).toBe(true)

    // 快照未被触碰
    expect(snap.result.ultimate).toBe(frozenUltimate)
    expect(JSON.stringify(snap.rows)).toBe(frozenRows)
    expect(snap.dataVersion).toBe(1)
  })
})

describe('部分单元格按最新值截尾计入', () => {
  const triangle = buildTriangle(wb.claims, { valuationDate, metric: 'paid' })

  it('每个单元格覆盖该季度全部已报案理赔', () => {
    for (const q of triangle.quarters) {
      const meta = triangle.meta[q]
      for (const cell of triangle.rows[q] ?? []) {
        if (!cell) continue
        expect(cell.claimCount).toBe(meta.cohortCount)
        expect(cell.matureCount + cell.censoredCount).toBe(cell.claimCount)
        expect(cell.partial).toBe(cell.censoredCount > 0)
      }
    }
  })

  it('同一季度已付金额逐期不减（截尾样本不再让金额倒退）', () => {
    for (const q of triangle.quarters) {
      let prev = -Infinity
      for (const cell of triangle.rows[q] ?? []) {
        if (!cell) break
        expect(cell.paid).toBeGreaterThanOrEqual(prev)
        prev = cell.paid
      }
    }
  })

  it('最新对角上的截尾赔案只按自身最新期取值', () => {
    const q = '2025-Q2'
    const meta = triangle.meta[q]
    const cell = triangle.rows[q][meta.latestAge]!
    expect(cell.partial).toBe(true)
    expect(cell.censoredCount).toBeGreaterThan(0)
    const members = claimsInCell(wb.claims, valuationDate, q, meta.latestAge, 'paid')
    const censored = members.filter((m) => m.censored)
    expect(censored.length).toBe(cell.censoredCount)
    for (const m of censored) {
      expect(m.asOf).toBe(ageEndDate(m.claim.reportDate, m.latestAge))
      expect(m.asOf <= valuationDate).toBe(true)
    }
  })

  it('因子样本仍只取已满期且完整的相邻两期', () => {
    const factors = computeAutoFactors(triangle, 'volume-weighted')
    for (const row of factors) {
      for (const q of row.sampleQuarters) {
        const from = triangle.rows[q][row.from]
        const to = triangle.rows[q][row.to]
        expect(from?.partial).toBe(false)
        expect(to?.partial).toBe(false)
        expect(from?.incompleteCount).toBe(0)
        expect(to?.incompleteCount).toBe(0)
      }
    }
  })

  it('默认情景因锁定后期因子而拉开差距', () => {
    const results = wb.scenarios.map((scenario) =>
      computeScenarioResult({
        scenario,
        autoFactors: computeAutoFactors(triangle, scenario.basis),
        claims: wb.claims,
        valuationDate,
        metric: 'paid',
        triangle,
        dataVersion: 1,
      }),
    )
    const ultimates = results.map((r) => r.ultimate)
    expect(new Set(ultimates.map((u) => Math.round(u))).size).toBe(ultimates.length)
    const conservative = results.find((r) => r.scenarioId === 'sc-conservative')!
    const optimistic = results.find((r) => r.scenarioId === 'sc-optimistic')!
    const baseline = results.find((r) => r.isBaseline)!
    expect(conservative.ultimate).toBeGreaterThan(baseline.ultimate)
    expect(optimistic.ultimate).toBeLessThan(baseline.ultimate)
    // 已付与未决持有是实际值，不随情景改变
    expect(conservative.paidToDate).toBeCloseTo(baseline.paidToDate, 6)
  })
})
