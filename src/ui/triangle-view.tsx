import { formatAmount } from '../domain/dates'
import type { Analysis } from '../domain/analysis'
import type { TriangleMetric, Workbook, Snapshot } from '../domain/types'
import { HORIZON } from '../domain/constants'
import { liveRows, frozenRows, currentMetricValue, columnTotals, sampleSummary, type RowView } from './model'
import { formatCompact } from './format'

interface Props {
  workbook: Workbook
  analysis: Analysis
  metric: TriangleMetric
  selection: { quarter: string; age: number } | null
  onSelect: (sel: { quarter: string; age: number } | null) => void
  frozenSnapshot: Snapshot | null
  onClearFrozen: () => void
}

const RAMP_STEPS = 7

function colourFor(value: number, max: number): { className?: string; style?: React.CSSProperties } {
  if (value <= 0) return {}
  const ratio = max > 0 ? value / max : 0
  const step = Math.min(RAMP_STEPS, Math.max(1, Math.ceil(ratio * RAMP_STEPS)))
  return { style: { background: `var(--cell-${step})`, color: step >= 4 ? '#fff' : 'var(--ink)' } }
}

export function TriangleSection(props: Props) {
  const { workbook, analysis, metric, selection, onSelect, frozenSnapshot, onClearFrozen } = props
  const rows = frozenSnapshot ? frozenRows(frozenSnapshot) : liveRows(analysis.triangle)
  const activeMetric = frozenSnapshot ? frozenSnapshot.metric : metric
  const max = frozenSnapshot
    ? Math.max(
        0,
        ...rows.flatMap((r) => r.cells.map((c) => (c ? currentMetricValue(c, activeMetric) : 0))),
      )
    : analysis.triangle.maxValue
  const totals = columnTotals(rows, activeMetric)
  const totalOfTotals = totals.reduce((s, t) => s + t.total, 0)
  const sample = sampleSummary(workbook, analysis.triangle)

  const partialCellCount = rows.reduce(
    (s, r) => s + r.cells.filter((c) => c?.partial).length,
    0,
  )
  const gapCells = rows.reduce((s, r) => s + r.cells.filter((c) => c === null).length, 0)

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>发展三角</h2>
          <p className="desc">
            行 = 事故季度；列 = 报案后经过月数（0 表示报案当月）。单元格为该季度<strong>全部已报案理赔</strong>在该期月末的累计{activeMetric === 'paid' ? '已付净额' : '已付净额 + 未决估算'}：
            尚未满该期的赔案按各自最新可得值计入（截尾），因此同一行金额只增不减、不同行可横向比较。
            <strong>缺口</strong>表示没有赔案到达该发展期，与金额为零是两件事。点任意单元格可下钻到汇总它的理赔记录。
          </p>
        </div>
        <div className="spacer" />
        {frozenSnapshot && (
          <div className="frozen-banner">
            正在查看快照「{frozenSnapshot.label}」· 数据版本 v{frozenSnapshot.dataVersion}
            <button className="btn ghost" onClick={onClearFrozen} style={{ marginLeft: 4, padding: '2px 8px' }}>
              返回实时
            </button>
          </div>
        )}
      </div>

      <div className="section-body">
        <div className="triangle-toolbar">
          <div className="legend">
            <span className="item">
              <span className="swatch gap" aria-hidden="true" />
              缺口：无赔案到达
            </span>
            <span className="item">
              <span className="swatch zero" aria-hidden="true" />
              0：已到达，金额为零
            </span>
            <span className="item" style={{ opacity: 0.85 }}>
              <span
                className="swatch"
                aria-hidden="true"
                style={{ clipPath: 'polygon(0 0, 100% 0, 0 100%)', background: 'var(--ink-2)' }}
              />
              左上角三角：含未满该期的赔案（按最新值计入）
            </span>
            <span className="item">
              <span
                className="swatch"
                aria-hidden="true"
                style={{ background: 'var(--warning)', border: 0, borderRadius: '50%' }}
              />
              评估不完整
            </span>
            <span className="item ramp">
              <span className="hint">{formatAmount(0)}</span>
              <span className="bar" aria-hidden="true" />
              <span className="hint">{formatCompact(max)}</span>
            </span>
          </div>
          <div className="spacer" style={{ flex: 1 }} />
          <span className="hint">
            {sample.reportedInRange} 笔已报案理赔进入三角 · {gapCells} 个缺口格 · {partialCellCount} 个含截尾样本的单元格
          </span>
        </div>

        <div className="table-wrap">
          <table className="triangle" aria-label="理赔发展三角">
            <thead>
              <tr>
                <th className="rowhead" scope="col">
                  事故季度
                </th>
                {Array.from({ length: HORIZON }, (_, age) => (
                  <th key={age} scope="col" title={`报案后第 ${age} 个月`}>
                    {age}
                    <span style={{ display: 'block', color: 'var(--muted)', fontWeight: 400 }}>M+{age}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <TriangleRow
                  key={row.quarter}
                  row={row}
                  metric={activeMetric}
                  max={max}
                  selection={selection}
                  onSelect={onSelect}
                  frozen={Boolean(frozenSnapshot)}
                />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">合计（各期）</th>
                {totals.map((t) => (
                  <td key={t.age} className="totals">
                    {t.claims > 0 ? formatCompact(t.total) : '—'}
                    <span style={{ display: 'block', color: 'var(--muted)', fontWeight: 400 }}>
                      {t.claims} 笔
                    </span>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="triangle-note">
          <span>
            合计行是各列金额之和（跨季度累加，仅作量级参考）；同一赔案在不同列出现，不应跨列相加。
            {totalOfTotals > 0 ? ` 首列合计 ${formatCompact(totals[0]?.total ?? 0)}。` : ''}
          </span>
          <span>
            {frozenSnapshot ? `快照冻结于 ${frozenSnapshot.createdAt.slice(0, 10)}，不随新数据改写` : `估值日 ${workbook.valuationDate} · 数据版本 v${workbook.dataVersion}`}
          </span>
        </div>
      </div>
    </section>
  )
}

interface RowProps {
  row: RowView
  metric: TriangleMetric
  max: number
  selection: { quarter: string; age: number } | null
  onSelect: (sel: { quarter: string; age: number }) => void
  frozen: boolean
}

function TriangleRow({ row, metric, max, selection, onSelect, frozen }: RowProps) {
  return (
    <tr>
      <th scope="row" className="rowhead">
        <button
          className={`rowhead-btn${selection?.age === row.latestAge && selection?.quarter === row.quarter ? ' selected' : ''}`}
          onClick={() => onSelect({ quarter: row.quarter, age: row.latestAge })}
          aria-label={`查看 ${row.quarter} 全部 ${row.cohortCount} 笔理赔记录`}
          title={`点击查看 ${row.quarter} 的全部理赔记录（按最新一期汇总）`}
        >
          <span className="q">{row.quarter}</span>
          <span className="rowmeta">
            <span>{row.cohortCount} 笔</span>
            {row.latestAge < HORIZON - 1 && <span>已过 {row.latestAge} 期</span>}
            {row.incompleteCells > 0 && <span className="warn">{row.incompleteCells} 格评估不完整</span>}
            {row.unreportedCount > 0 && !frozen && <span>+{row.unreportedCount} 笔未报案</span>}
          </span>
        </button>
      </th>
      {Array.from({ length: HORIZON }, (_, age) => {
        const cell = row.cells[age]
        const isSelected = selection?.quarter === row.quarter && selection?.age === age
        if (!cell) {
          return (
            <td key={age} className="cellwrap">
              <div className="cell gap" title={`${row.quarter} · M+${age}：缺口，无赔案到达该发展期`}>
                <span className="gapmark">缺口</span>
              </div>
            </td>
          )
        }
        const value = currentMetricValue(cell, metric)
        const colour = colourFor(value, max)
        const zero = value === 0 && cell.claimCount > 0
        return (
          <td key={age} className="cellwrap">
            <button
              className={`cell${isSelected ? ' selected' : ''}${zero ? ' zero' : ''}`}
              style={colour.style}
              onClick={() => onSelect({ quarter: row.quarter, age })}
              aria-pressed={isSelected}
              aria-label={`${row.quarter} 第 ${age} 个月：${formatAmount(value)} 元，覆盖 ${cell.claimCount} 笔赔案（${cell.matureCount} 笔已满该期）${cell.partial ? '，其余按最新值计入' : ''}${cell.incompleteCount > 0 ? '，含不完整评估' : ''}`}
              title={
                `${row.quarter} · M+${age}\n` +
                `累计${metric === 'paid' ? '已付' : '已付+未决'}：${formatAmount(value)} 元\n` +
                `覆盖 ${cell.claimCount} / ${cell.cohortCount} 笔：${cell.matureCount} 笔已满该期` +
                (cell.censoredCount > 0 ? `，${cell.censoredCount} 笔按最新值截尾计入` : '') +
                `\n` +
                `在查 ${cell.openCount} · 已结 ${cell.closedCount} · 拒赔 ${cell.deniedCount} · 重开 ${cell.reopenedCount}\n` +
                (cell.incompleteCount > 0 ? `未决评估不完整 ${cell.incompleteCount} 笔` : '')
              }
            >
              {cell.partial && <span className="flag partial" aria-hidden="true" />}
              {cell.incompleteCount > 0 && (
                <span className="flag incomplete" title="含不完整评估" aria-hidden="true">
                  !
                </span>
              )}
              <span className="amount">
                {formatCompactValue(value)}
                {Math.abs(value) >= 10_000 && <span className="unit">万</span>}
              </span>
              <span className="sub">
                {cell.matureCount}/{cell.cohortCount}
                {cell.censoredCount > 0 && (
                  <span className="censor" title={`${cell.censoredCount} 笔尚未满该期，按最新值计入`}>
                    +{cell.censoredCount}
                  </span>
                )}
              </span>
            </button>
          </td>
        )
      })}
    </tr>
  )
}

function formatCompactValue(value: number): string {
  if (Math.abs(value) >= 10_000) {
    return (value / 10_000).toFixed(Math.abs(value) >= 1_000_000 ? 0 : 1)
  }
  return value === 0 ? '0' : Math.round(value).toString()
}

