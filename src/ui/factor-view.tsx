import { useMemo, useState } from 'react'
import type { DevelopmentBasis, FactorSetting, Scenario, TriangleMetric, Workbook } from '../domain/types'
import type { Analysis } from '../domain/analysis'
import { BASIS_DESCRIPTIONS, BASIS_LABELS, BASIS_ORDER, cumulativeFactor, resolveFactors } from '../domain/development'
import { MIN_SAMPLE_ROWS } from '../domain/constants'
import { formatFactor } from '../domain/dates'
import { formatCompact, formatPct } from './format'

interface Props {
  workbook: Workbook
  analysis: Analysis
  metric: TriangleMetric
  baselineScenario: Scenario
  basis: DevelopmentBasis
  onBasisChange: (basis: DevelopmentBasis) => void
  onSetFactor: (from: number, setting: FactorSetting | null) => void
  onLockAll: () => void
  onUnlockAll: () => void
}

/**
 * 发展因子面板：
 * - 自动值（当前数据版本、当前口径）
 * - 情景采用值（可锁定或人工覆盖）
 * - 样本行数与样本不足提示
 * - 各口径的最终估计对比
 */
export function FactorSection(props: Props) {
  const { workbook, analysis, metric, baselineScenario, basis, onBasisChange, onSetFactor, onLockAll, onUnlockAll } = props
  const applied = analysis.baselineFactors
  const resolved = resolveFactors(applied, baselineScenario.settings)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  const factorByBasis = useMemo(() => {
    return BASIS_ORDER.map((b) => {
      const rows = analysis.factorsByBasis[b]
      const cumulative = cumulativeFactor(rows, 0)
      const insufficient = rows.filter((x) => x.insufficient).length
      return { basis: b, rows, cumulative, insufficient, totalSample: rows[0]?.sampleSize ?? 0 }
    })
  }, [analysis])

  const baselineUltimate = analysis.baseline.ultimate
  const developedCount = analysis.baseline.byQuarter.filter((q) => q.latestAge >= 11).length

  const startEdit = (from: number, value: number) => {
    setEditing(from)
    setDraft(value.toFixed(4))
  }

  const commitEdit = (from: number) => {
    const num = Number(draft)
    if (Number.isFinite(num) && num > 0 && num < 100) {
      const existing = baselineScenario.settings[String(from)]
      onSetFactor(from, {
        mode: existing?.mode === 'locked' ? 'locked' : 'manual',
        value: num,
        lockedAtVersion: existing?.lockedAtVersion,
        lockedAtDate: existing?.lockedAtDate,
        lockedFromAuto: existing?.lockedFromAuto,
      })
    }
    setEditing(null)
  }

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>发展因子</h2>
          <p className="desc">
            每期因子 = 后一期累计值 ÷ 前一期累计值。默认按<strong>{BASIS_LABELS[basis]}</strong> 对完整历史行汇总；
            可以锁定某一期的因子（冻结在当前数据版本），或直接人工填写。锁定值不会再被自动重算覆盖，
            但右侧会显示它与最新自动值的漂移。
          </p>
        </div>
        <div className="spacer" />
        <div className="row">
          <label className="field">
            计算口径
            <select value={basis} onChange={(e) => onBasisChange(e.target.value as DevelopmentBasis)}>
              {BASIS_ORDER.map((b) => (
                <option key={b} value={b}>
                  {BASIS_LABELS[b]}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={onLockAll}>
            锁定全部因子
          </button>
          <button className="btn ghost" onClick={onUnlockAll} disabled={resolved.overriddenCount === 0}>
            全部恢复自动
          </button>
        </div>
      </div>

      <div className="section-body">
        <div className="factor-layout">
          <div>
            <table className="grid-table" aria-label="发展因子表">
              <thead>
                <tr>
                  <th scope="col">发展期</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    自动因子
                  </th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    采用因子
                  </th>
                  <th scope="col">状态</th>
                  <th scope="col">样本</th>
                  <th scope="col">说明</th>
                </tr>
              </thead>
              <tbody>
                {resolved.rows.map((row) => {
                  const setting = baselineScenario.settings[String(row.from)]
                  const locked = setting?.mode === 'locked'
                  const manual = setting?.mode === 'manual'
                  const drift = locked ? row.factor - row.autoFactor : 0
                  return (
                    <tr key={row.from} className={row.mode !== 'auto' ? 'row-locked' : row.insufficient ? 'row-insufficient' : ''}>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 560 }}>
                        M+{row.from} → M+{row.to}
                      </td>
                      <td className="num">{formatFactor(row.autoFactor)}</td>
                      <td className="num">
                        {editing === row.from ? (
                          <input
                            className="factor-input"
                            type="number"
                            step="0.0001"
                            min="0.0001"
                            value={draft}
                            autoFocus
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => commitEdit(row.from)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit(row.from)
                              if (e.key === 'Escape') setEditing(null)
                            }}
                          />
                        ) : (
                          <span className="factor-cell" style={{ justifyContent: 'flex-end' }}>
                            <button
                              className="btn ghost"
                              style={{ padding: '2px 6px', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
                              onClick={() => startEdit(row.from, row.factor)}
                              title="点击编辑；填写后按 Enter 保存"
                            >
                              {formatFactor(row.factor)}
                            </button>
                          </span>
                        )}
                      </td>
                      <td>
                        {locked && (
                          <span className="lock-tag" title={`锁定于数据版本 v${setting?.lockedAtVersion ?? '?'}（${setting?.lockedAtDate ?? '—'}）`}>
                            🔒 锁定
                          </span>
                        )}
                        {manual && <span className="badge neutral">人工</span>}
                        {row.mode === 'auto' && <span className="hint">自动</span>}
                        {locked && Math.abs(drift) > 0.005 && (
                          <span className="drift" style={{ display: 'block' }}>
                            自动值已漂移至 <strong>{formatFactor(row.autoFactor)}</strong>（
                            {drift > 0 ? '+' : '−'}
                            {Math.abs(drift).toFixed(4)}）
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={`sample-pill${row.insufficient ? ' low' : ''}`}>
                          {row.sampleSize} 行
                          {row.insufficient ? ' · 不足' : ''}
                        </span>
                      </td>
                      <td className="hint" style={{ maxWidth: 260 }}>
                        {row.detail}
                        {row.sampleQuarters.length > 0 && (
                          <span style={{ display: 'block', color: 'var(--muted)', fontSize: 10.5 }}>
                            {row.sampleQuarters.slice().sort().join('、')}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
              <span className="hint">
                {resolved.overriddenCount} 期被锁定/人工覆盖 · {resolved.insufficientAutoCount} 期自动样本不足（
                &lt; {MIN_SAMPLE_ROWS} 行）
              </span>
              <span className="hint">
                累计因子（M+0 → M+11）：{formatFactor(cumulativeFactor(resolved.rows, 0))}
              </span>
            </div>
          </div>

          <aside className="side">
            <div className="side-card">
              <h3>口径对比 · 全自动因子</h3>
              <p className="hint" style={{ margin: '0 0 8px' }}>
                同一数据、不同因子口径下的最终估计。当前基准情景使用「{BASIS_LABELS[baselineScenario.basis]}」。
              </p>
              <div className="basis-compare">
                {factorByBasis.map((entry) => {
                  const result = scenarioResultForBasis(analysis, entry.basis)
                  const delta = result - baselineUltimate
                  return (
                    <button
                      key={entry.basis}
                      className="basis-card"
                      aria-pressed={entry.basis === basis}
                      onClick={() => onBasisChange(entry.basis)}
                    >
                      <div className="top">
                        <span className="name">{BASIS_LABELS[entry.basis]}</span>
                        <span className="amt">{formatCompact(result)}</span>
                      </div>
                      <div className="desc">{BASIS_DESCRIPTIONS[entry.basis]}</div>
                      <div className="meta">
                        <span>M+0→1 因子 {formatFactor(entry.rows[0]?.factor ?? 1)}</span>
                        <span>首期样本 {entry.totalSample} 行</span>
                        {entry.insufficient > 0 && <span style={{ color: 'var(--critical)' }}>{entry.insufficient} 期样本不足</span>}
                        <span>
                          相对基准 {delta >= 0 ? '+' : '−'}
                          {formatCompact(Math.abs(delta))}（{formatPct(delta / baselineUltimate)}）
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="side-card">
              <h3>口径说明</h3>
              <div className="kv">
                <span className="k">当前口径</span>
                <span className="v">{metric === 'paid' ? '已付' : '已付 + 未决'}</span>
              </div>
              <div className="kv">
                <span className="k">发展期数</span>
                <span className="v">11 个因子 / 12 期</span>
              </div>
              <div className="kv">
                <span className="k">已发展满 11 期的季度</span>
                <span className="v">{developedCount} / 12</span>
              </div>
              <div className="kv">
                <span className="k">数据版本</span>
                <span className="v">v{workbook.dataVersion}</span>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                因子只使用相邻两期都完整、且无缺失评估的历史行；部分单元格、缺口与不完整评估一律排除。
                因此最新几期的样本行数会随数据成熟而增加。
              </p>
            </div>
          </aside>
        </div>
      </div>
    </section>
  )
}

function scenarioResultForBasis(analysis: Analysis, basis: DevelopmentBasis): number {
  const entry = analysis.basisResults[basis]
  return entry?.ultimate ?? 0
}

