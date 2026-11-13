import { useState } from 'react'
import type { DevelopmentBasis, FactorSetting, TriangleMetric, Workbook } from '../domain/types'
import type { Analysis } from '../domain/analysis'
import { BASIS_LABELS, BASIS_ORDER } from '../domain/development'
import { HORIZON } from '../domain/constants'
import { formatAmount, formatFactor } from '../domain/dates'
import { formatCompact, formatPct, formatSignedPct } from './format'
import { scenarioSeries } from './model'

interface Props {
  workbook: Workbook
  analysis: Analysis
  metric: TriangleMetric
  onAdd: () => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onBasis: (id: string, basis: DevelopmentBasis) => void
  onSetBaseline: (id: string) => void
  onSetFactor: (scenarioId: string, from: number, setting: FactorSetting | null) => void
  onLockAll: (scenarioId: string) => void
  onUnlockAll: (id: string) => void
  onSnapshot: () => void
  onTab: (tab: 'factors' | 'snapshots') => void
}

const SLOT_VARS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)']

function slotColor(slot: number): string {
  return SLOT_VARS[Math.min(SLOT_VARS.length - 1, Math.max(0, slot - 1))]
}

export function ScenarioSection(props: Props) {
  const { workbook, analysis, metric } = props
  const baseline = analysis.baseline
  const series = scenarioSeries(analysis.results, baseline, metric)
  const maxValue = Math.max(...series.map((s) => s.value), 1)
  const [hover, setHover] = useState<{ x: number; y: number; id: string } | null>(null)
  const [detail, setDetail] = useState<string | null>(null)

  const detailScenario = workbook.scenarios.find((s) => s.id === detail) ?? workbook.scenarios[0]
  const detailResult = analysis.results[workbook.scenarios.findIndex((s) => s.id === detailScenario?.id)]

  return (
    <>
      <section className="section">
        <div className="section-head">
          <div>
            <h2>准备金情景</h2>
            <p className="desc">
              每个情景使用自己的发展因子（可以锁定某些期、或整情景切换口径），最终估计按逐理赔投影汇总。
              基准情景是其它情景比较的分母；调整因子后，所有相关数字立即重算。
            </p>
          </div>
          <div className="spacer" />
          <div className="row">
            <button className="btn" onClick={props.onSnapshot}>
              冻结当前为快照
            </button>
            <button className="btn primary" onClick={props.onAdd}>
              + 新建情景
            </button>
          </div>
        </div>

        <div className="section-body">
          <div className="scenario-grid">
            {workbook.scenarios.map((scenario, i) => {
              const result = analysis.results[i]
              const delta = result.ultimate - baseline.ultimate
              return (
                <div key={scenario.id} className={`scenario-card${scenario.isBaseline ? ' baseline' : ''}`}>
                  <div className="sc-head">
                    <span className="dot" style={{ background: slotColor(scenario.colorSlot) }} aria-hidden="true" />
                    <input
                      className="sc-name"
                      value={scenario.name}
                      aria-label="情景名称"
                      onChange={(e) => props.onRename(scenario.id, e.target.value)}
                    />
                    {scenario.isBaseline && <span className="badge neutral">基准</span>}
                  </div>
                  <div className="sc-meta">
                    <select
                      value={scenario.basis}
                      aria-label={`${scenario.name} 的因子口径`}
                      onChange={(e) => props.onBasis(scenario.id, e.target.value as DevelopmentBasis)}
                    >
                      {BASIS_ORDER.map((b) => (
                        <option key={b} value={b}>
                          {BASIS_LABELS[b]}
                        </option>
                      ))}
                    </select>
                    <span>
                      {Object.keys(scenario.settings).length > 0
                        ? `${Object.keys(scenario.settings).length} 期已锁定/人工`
                        : '全自动因子'}
                    </span>
                  </div>
                  <div className="sc-values">
                    <div>
                      <span className="k">最终估计</span>
                      <span className="v">{formatCompact(result.ultimate)}</span>
                    </div>
                    <div>
                      <span className="k">需补提准备金</span>
                      <span className="v">{formatCompact(result.ibnr)}</span>
                    </div>
                  </div>
                  <div className="sc-foot">
                    <span>
                      {scenario.isBaseline ? (
                        '比较基准'
                      ) : (
                        <span style={{ color: delta > 0 ? 'var(--critical)' : 'var(--good-ink)', fontWeight: 560 }}>
                          {delta >= 0 ? '+' : '−'}
                          {formatCompact(Math.abs(delta))}（{formatSignedPct(delta / baseline.ultimate)}）
                        </span>
                      )}
                    </span>
                    <span className="row" style={{ gap: 4 }}>
                      <button className="btn ghost" style={{ padding: '2px 6px' }} onClick={() => setDetail(scenario.id)}>
                        逐季明细
                      </button>
                      {!scenario.isBaseline && (
                        <>
                          <button className="btn ghost" style={{ padding: '2px 6px' }} onClick={() => props.onSetBaseline(scenario.id)}>
                            设为基准
                          </button>
                          <button
                            className="btn ghost danger"
                            style={{ padding: '2px 6px' }}
                            onClick={() => props.onDelete(scenario.id)}
                            aria-label={`删除 ${scenario.name}`}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>情景对比</h2>
            <p className="desc">
              最终估计（含已发展季度的实际累计与未发展季度的外推）。长度以金额编码，颜色只用于区分情景实体；
              鼠标悬停或键盘聚焦可读取精确值与相对基准的差异。
            </p>
          </div>
        </div>
        <div className="section-body">
          <div className="chart-block">
            <div className="chart-head">
              <h3>{metric === 'paid' ? '最终估计（已付口径）' : '最终估计（已付+未决口径）'}</h3>
              <div className="chart-legend">
                {workbook.scenarios.map((s) => (
                  <span key={s.id} className="key">
                    <span className="line" style={{ background: slotColor(s.colorSlot) }} aria-hidden="true" />
                    {s.name}
                  </span>
                ))}
              </div>
            </div>
            <div className="scenario-bars">
              {series.map((s) => {
                const width = Math.max(1, (s.value / maxValue) * 100)
                return (
                  <div className="scenario-bar-row" key={s.id}>
                    <span className="sc-label" title={s.label}>
                      <span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', background: slotColor(s.slot), flex: 'none' }} />
                      {s.label}
                    </span>
                    <div className="track">
                      <div
                        className="fill"
                        tabIndex={0}
                        role="img"
                        aria-label={`${s.label}：最终估计 ${formatAmount(s.value)} 元，需补提 ${formatAmount(s.secondary)} 元`}
                        style={{ width: `calc(${width}% - 2px)`, background: slotColor(s.slot) }}
                        onPointerMove={(e) => setHover({ x: e.clientX, y: e.clientY, id: s.id })}
                        onPointerLeave={() => setHover(null)}
                        onFocus={(e) => {
                          const r = e.currentTarget.getBoundingClientRect()
                          setHover({ x: r.left + r.width, y: r.top, id: s.id })
                        }}
                        onBlur={() => setHover(null)}
                      />
                      <span className="bar-value" style={{ left: `calc(${width}% + 8px)` }}>
                        {formatCompact(s.value)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="chart-caption">
              基准：{baseline.scenarioName}（{formatCompact(baseline.ultimate)} 元）。
              {analysis.baseline.partialRows.length > 0 &&
                ` 部分季度最新对角样本不完整，最终估计可能偏低。`}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="chart-head">
              <h3>差异与最终估计明细</h3>
              <button className="btn ghost" onClick={() => props.onTab('factors')}>
                调整因子 →
              </button>
            </div>
            <table className="grid-table" aria-label="情景对比表">
              <thead>
                <tr>
                  <th scope="col">情景</th>
                  <th scope="col">口径</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    最终估计
                  </th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    相对基准
                  </th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    相对基准 %
                  </th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    已付
                  </th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    未决持有
                  </th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    需补提
                  </th>
                </tr>
              </thead>
              <tbody>
                {workbook.scenarios.map((s, i) => {
                  const r = analysis.results[i]
                  const delta = r.ultimate - baseline.ultimate
                  return (
                    <tr key={s.id}>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          <span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', background: slotColor(s.colorSlot) }} />
                          {s.name}
                          {s.isBaseline && <span className="badge neutral">基准</span>}
                        </span>
                      </td>
                      <td className="hint">{BASIS_LABELS[s.basis]}</td>
                      <td className="num">{formatAmount(r.ultimate)}</td>
                      <td className="num" style={{ color: delta > 0 ? 'var(--critical)' : delta < 0 ? 'var(--good-ink)' : 'var(--muted)' }}>
                        {s.isBaseline ? '—' : `${delta >= 0 ? '+' : '−'}${formatAmount(Math.abs(delta), { compact: true })}`}
                      </td>
                      <td className="num">{s.isBaseline ? '—' : formatSignedPct(delta / baseline.ultimate)}</td>
                      <td className="num">{formatAmount(r.paidToDate)}</td>
                      <td className="num">{formatAmount(r.caseHeld)}</td>
                      <td className="num">{formatAmount(r.ibnr)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 6 }}>
              已付与未决持有是估值日的实际值，不随因子变化；改变因子只影响未发展部分的估计与需补提准备金。
              合计明细可切换「逐季明细」查看按季度拆分。
            </p>
          </div>

          {detailScenario && detailResult && (
            <div style={{ marginTop: 16 }}>
              <div className="chart-head">
                <h3>
                  逐季明细 · {detailScenario.name}（{BASIS_LABELS[detailScenario.basis]}）
                </h3>
                <span className="hint">剩余因子 = 该季度最终估计 ÷ 估值日累计值</span>
              </div>
              <div className="quarter-table-wrap">
                <table className="quarter-table" aria-label={`${detailScenario.name} 逐季明细`}>
                  <thead>
                    <tr>
                      <th scope="col">事故季度</th>
                      <th scope="col">样本</th>
                      <th scope="col">最深期</th>
                      <th scope="col">估值日累计</th>
                      <th scope="col">剩余因子</th>
                      <th scope="col">最终估计</th>
                      <th scope="col">已付</th>
                      <th scope="col">未决持有</th>
                      <th scope="col">需补提</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailResult.byQuarter.map((q) => (
                      <tr
                        key={q.quarter}
                        className={q.latestAge < HORIZON - 1 ? 'not-developed' : q.claimCount === 0 ? 'empty-quarter' : ''}
                      >
                        <td>{q.quarter}</td>
                        <td>
                          {q.claimCount} 笔
                          <span className="sub">
                            {q.settledCount} 结案 · {q.immatureCount} 在查
                            {q.unreportedCount > 0 ? ` · ${q.unreportedCount} 未报案` : ''}
                          </span>
                        </td>
                        <td>
                          M+{q.latestAge}
                          {q.latestAge < HORIZON - 1 && <span className="sub">未发展满</span>}
                        </td>
                        <td>{formatAmount(q.currentValue, { compact: true })}</td>
                        <td>{q.latestAge >= HORIZON - 1 ? '—' : formatFactor(q.remainingFactor)}</td>
                        <td style={{ fontWeight: 600 }}>{formatAmount(q.ultimate, { compact: true })}</td>
                        <td>{formatAmount(q.paid, { compact: true })}</td>
                        <td>{formatAmount(q.caseReserve, { compact: true })}</td>
                        <td>{formatAmount(q.ibnr, { compact: true })}</td>
                      </tr>
                    ))}
                    <tr>
                      <td style={{ fontWeight: 620 }}>合计</td>
                      <td>{detailResult.byQuarter.reduce((s, q) => s + q.claimCount, 0)} 笔</td>
                      <td>—</td>
                      <td>{formatAmount(detailResult.byQuarter.reduce((s, q) => s + q.currentValue, 0), { compact: true })}</td>
                      <td>—</td>
                      <td style={{ fontWeight: 620 }}>{formatAmount(detailResult.ultimate, { compact: true })}</td>
                      <td>{formatAmount(detailResult.paidToDate, { compact: true })}</td>
                      <td>{formatAmount(detailResult.caseHeld, { compact: true })}</td>
                      <td style={{ fontWeight: 620 }}>{formatAmount(detailResult.ibnr, { compact: true })}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>

      {hover && (
        <ScenarioTooltip
          x={hover.x}
          y={hover.y}
          datum={series.find((s) => s.id === hover.id)!}
          baseline={baseline.ultimate}
        />
      )}
    </>
  )
}

function ScenarioTooltip({
  x,
  y,
  datum,
  baseline,
}: {
  x: number
  y: number
  datum: ReturnType<typeof scenarioSeries>[number]
  baseline: number
}) {
  const delta = datum.value - baseline
  return (
    <div
      className="chart-tooltip"
      style={{
        left: Math.min(x + 14, window.innerWidth - 240),
        top: Math.min(y + 14, window.innerHeight - 130),
      }}
      role="status"
    >
      <div className="t-title">{datum.label}</div>
      <div className="t-row">
        <span>最终估计</span>
        <b>{formatAmount(datum.value)}</b>
      </div>
      <div className="t-row">
        <span>需补提准备金</span>
        <b>{formatAmount(datum.secondary)}</b>
      </div>
      <div className="t-row">
        <span>相对基准</span>
        <b>
          {delta >= 0 ? '+' : '−'}
          {formatAmount(Math.abs(delta), { compact: true })}（{formatPct(delta / baseline)}）
        </b>
      </div>
    </div>
  )
}

