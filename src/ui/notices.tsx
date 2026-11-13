import type { Workbook } from '../domain/types'
import type { Analysis } from '../domain/analysis'

interface Props {
  workbook: Workbook
  analysis: Analysis
  frozenSnapshot: { label: string; dataVersion: number } | null
  onArrive: () => void
  onSnapshot: () => void
}

/**
 * 数据与样本提示：
 * - 数据版本（新理赔到达）
 * - 最新对角样本不完整
 * - 未决评估不完整
 * - 估值日后仍未报案的样本
 */
export function Notices({ workbook, analysis, frozenSnapshot, onArrive, onSnapshot }: Props) {
  const triangle = analysis.triangle
  const partial = triangle.quarters.filter((q) => triangle.meta[q].diagonalPartial)
  const incompleteCells = triangle.quarters.reduce((s, q) => s + triangle.meta[q].incompleteCells, 0)
  const unreported = triangle.quarters.reduce((s, q) => s + triangle.meta[q].unreportedCount, 0)
  const insufficient = analysis.baselineFactors.filter((f) => f.insufficient)
  const lastEvent = workbook.events[workbook.events.length - 1]

  return (
    <div className="notices">
      {frozenSnapshot && (
        <div className="notice info">
          <span className="n-icon" aria-hidden="true">
            i
          </span>
          <div>
            <strong>历史快照已冻结。</strong> 你正在查看「{frozenSnapshot.label}」（数据版本 v{frozenSnapshot.dataVersion}）。
            快照中的三角、因子与情景结果均为创建时副本，新理赔到达不会静默改写；差异请到「历史快照」对比。
          </div>
        </div>
      )}

      {partial.length > 0 && (
        <div className="notice">
          <span className="n-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>最新对角含截尾样本（{partial.length} 个季度）。</strong> 这些季度的最新发展期里，
            部分赔案尚未满该期，单元格已按它们各自的最新值计入（左上角三角标记），
            也就是对角位置的数据本身还不完整；因子计算会剔除这些单元格：
            <ul>
              {partial.slice(-4).map((q) => {
                const m = triangle.meta[q]
                return (
                  <li key={q}>
                    {q}：M+{m.latestAge} 已满期 {m.latestClaimCount}/{m.cohortCount} 笔
                    {m.unreportedCount > 0 ? `，另有 ${m.unreportedCount} 笔估值日后才报案` : ''}
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}

      {incompleteCells > 0 && (
        <div className="notice">
          <span className="n-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>{incompleteCells} 个单元格的未决估算不完整。</strong> 多为第三方定损未回函、估损复核中或残值待定；
            这些单元格不进入因子样本，准备金结果可能偏低。单元格左上角有 <strong>「!」</strong> 标记。
          </div>
        </div>
      )}

      {insufficient.length > 0 && (
        <div className="notice">
          <span className="n-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>{insufficient.length} 个发展期样本不足。</strong> 完整历史行少于 2 行，
            因子不稳定：{insufficient.map((f) => `M+${f.from}→${f.to}（${f.sampleSize} 行）`).join('、')}。
          </div>
        </div>
      )}

      {unreported > 0 && (
        <div className="notice info">
          <span className="n-icon" aria-hidden="true">
            i
          </span>
          <div>
            <strong>{unreported} 笔理赔在估值日后才报案，未进入三角。</strong> 它们属于 2025-Q4 事故季度，会推高该季度的最终估计，
            也意味着该季度的样本尚不完整。
          </div>
        </div>
      )}

      <div className="notice info" style={{ borderLeftColor: 'var(--axis)' }}>
        <span className="n-icon" aria-hidden="true" style={{ background: 'var(--surface-3)', color: 'var(--ink-2)' }}>
          ↻
        </span>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
          <span>
            当前数据版本 <strong>v{workbook.dataVersion}</strong>。
            {lastEvent ? ` 最近事件：${lastEvent.message}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onArrive}>
            模拟新理赔到达
          </button>
          <button className="btn" onClick={onSnapshot}>
            冻结为快照
          </button>
        </div>
      </div>
    </div>
  )
}

