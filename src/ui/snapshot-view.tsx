import { useState } from 'react'
import type { Snapshot, Workbook } from '../domain/types'
import type { Analysis } from '../domain/analysis'
import { formatAmount } from '../domain/dates'
import { formatCompact, formatPct } from './format'

interface Props {
  workbook: Workbook
  analysis: Analysis
  onSnapshot: (label?: string) => void
  onDelete: (id: string) => void
  onFreeze: (id: string) => void
  frozenSnapshotId: string | null
  onReset: () => void
}

/**
 * 历史快照：
 * - 每次创建都冻结三角、因子与情景结果
 * - 新理赔到达后，快照数值保持不变
 * - 与当前实时结果对比，显示差异（而不是改写快照）
 */
export function SnapshotSection({ workbook, analysis, onSnapshot, onDelete, onFreeze, frozenSnapshotId, onReset }: Props) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const snapshots = workbook.snapshots

  return (
    <>
      <section className="section">
        <div className="section-head">
          <div>
            <h2>历史快照</h2>
            <p className="desc">
              快照会把当时的三角、因子与全部情景结果复制一份并冻结。之后即使新理赔到达、数据版本推进，
              快照里的数字也不会被静默改写；要看变化，用「与当前对比」。
            </p>
          </div>
          <div className="spacer" />
          <div className="row">
            <input
              type="text"
              value={label}
              placeholder={`例如：${workbook.valuationDate} 月结`}
              aria-label="快照标签"
              onChange={(e) => setLabel(e.target.value)}
              style={{ width: 200 }}
            />
            <button
              className="btn primary"
              onClick={() => {
                setBusy(true)
                onSnapshot(label.trim() || undefined)
                setLabel('')
                setBusy(false)
              }}
              disabled={busy}
            >
              创建快照
            </button>
          </div>
        </div>
        <div className="section-body">
          {snapshots.length === 0 ? (
            <div className="detail-empty">
              还没有快照。建议在每次月结或重大假设调整前创建一个，之后就能对照「当时 vs 现在」。
            </div>
          ) : (
            <div className="snapshot-list">
              {snapshots.map((snap) => (
                <SnapshotRow
                  key={snap.id}
                  snapshot={snap}
                  currentUltimate={analysis.baseline.ultimate}
                  currentVersion={workbook.dataVersion}
                  onDelete={() => onDelete(snap.id)}
                  onFreeze={() => onFreeze(snap.id)}
                  frozen={frozenSnapshotId === snap.id}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>数据版本与事件</h2>
            <p className="desc">每次新理赔到达或创建快照都会留下记录；历史快照不会被后续版本影响。</p>
          </div>
          <div className="spacer" />
          <button className="btn danger" onClick={onReset}>
            重置演示数据
          </button>
        </div>
        <div className="section-body">
          <ul className="timeline" style={{ gap: 8 }}>
            {workbook.events
              .slice()
              .reverse()
              .map((e) => (
                <li key={`${e.version}-${e.kind}-${e.at}-${e.message}`}>
                  <time>v{e.version}</time>
                  <span>
                    {e.message}
                    <span className="hint"> · {e.at}</span>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      </section>
    </>
  )
}

interface RowProps {
  snapshot: Snapshot
  currentUltimate: number
  currentVersion: number
  onDelete: () => void
  onFreeze: () => void
  frozen: boolean
}

function SnapshotRow({ snapshot, currentUltimate, currentVersion, onDelete, onFreeze, frozen }: RowProps) {
  const delta = currentUltimate - snapshot.result.ultimate
  const percent = snapshot.result.ultimate !== 0 ? delta / snapshot.result.ultimate : Number.NaN
  return (
    <div className="snapshot-row" style={frozen ? { borderColor: 'var(--accent)' } : undefined}>
      <div>
        <div className="snap-label">{snapshot.label}</div>
        <div className="snap-sub">
          <span>冻结于 {snapshot.createdAt.slice(0, 16).replace('T', ' ')}</span>
          <span>· 数据版本 v{snapshot.dataVersion}</span>
          <span>· {snapshot.metric === 'paid' ? '已付' : '已付+未决'}口径</span>
        </div>
      </div>
      <div className="metric">
        <span className="k">快照最终估计</span>
        <span className="v">{formatCompact(snapshot.result.ultimate)}</span>
      </div>
      <div className="metric">
        <span className="k">快照需补提</span>
        <span className="v">{formatCompact(snapshot.result.ibnr)}</span>
      </div>
      <div className="metric">
        <span className="k">与当前（v{currentVersion}）对比</span>
        <span className="v" style={{ color: delta > 0 ? 'var(--critical)' : delta < 0 ? 'var(--good-ink)' : 'var(--muted)' }}>
          {delta === 0 ? '无变化' : `${delta > 0 ? '+' : '−'}${formatAmount(Math.abs(delta), { compact: true })}（${formatPct(percent)}）`}
        </span>
        <span className="hint">{snapshot.partialRows.length} 个季度样本不完整</span>
      </div>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn ghost" style={{ padding: '3px 8px' }} onClick={onFreeze}>
          {frozen ? '取消冻结视图' : '查看冻结三角'}
        </button>
        <button className="btn ghost danger" style={{ padding: '3px 8px' }} onClick={onDelete}>
          删除
        </button>
      </div>
    </div>
  )
}
