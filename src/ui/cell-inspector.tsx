import { formatAmount } from '../domain/dates'
import type { ClaimCellValue } from '../domain/triangle'
import type { Claim, ClaimStatus, TriangleMetric, Workbook } from '../domain/types'
import { LINE_LABELS, STATUS_LABELS, claimStatusTimeline, lineAt } from '../domain/ledger'
import { formatCompact } from './format'

interface Props {
  workbook: Workbook
  metric: TriangleMetric
  selection: { quarter: string; age: number } | null
  claims: ClaimCellValue[]
}

const STATUS_CLASS: Record<ClaimStatus, string> = {
  open: 'status-open',
  closed: 'status-closed',
  denied: 'status-denied',
  reopened: 'status-reopened',
}

export function CellInspector({ workbook, metric, selection, claims }: Props) {
  if (!selection) {
    return (
      <section className="section">
        <div className="section-head">
          <div>
            <h2>单元格明细</h2>
            <p className="desc">在三角中选中任意单元格，这里会列出汇总成该单元格的每一笔理赔记录。</p>
          </div>
        </div>
        <div className="section-body">
          <div className="detail-empty">尚未选择单元格。点任意有金额或标「0」的方格。</div>
        </div>
      </section>
    )
  }

  return <InspectorBody workbook={workbook} metric={metric} selection={selection} claims={claims} />
}

function InspectorBody({ workbook, metric, selection, claims }: Props & { selection: { quarter: string; age: number } }) {
  const cohort = workbook.claims.filter(
    (c) => c.accidentQuarter === selection.quarter && c.reportDate <= workbook.valuationDate,
  )
  const sum = {
    paid: claims.reduce((s, c) => s + c.paid, 0),
    grossPaid: claims.reduce((s, c) => s + c.grossPaid, 0),
    reversed: claims.reduce((s, c) => s + c.reversedAmount, 0),
    reserve: claims.reduce((s, c) => s + c.caseReserve, 0),
    incurred: claims.reduce((s, c) => s + c.incurred, 0),
    adjustments: claims.reduce((s, c) => s + c.adjustmentCount, 0),
    adjustedAmount: claims.reduce((s, c) => s + c.adjustedAmount, 0),
  }
  const missing = cohort.length - claims.length
  const incomplete = claims.filter((c) => c.incomplete).length
  const censored = claims.filter((c) => c.censored).length
  const mature = claims.length - censored
  const statusCounts = (['open', 'closed', 'denied', 'reopened'] as ClaimStatus[]).map((status) => ({
    status,
    count: claims.filter((c) => c.status === status).length,
  }))

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>
            单元格明细 · {selection.quarter} · 报案后第 {selection.age} 个月
          </h2>
          <p className="desc">
            下列 {claims.length} 笔理赔正是汇总为三角中该单元格的记录：{mature} 笔已满该期，
            未满该期的 {censored} 笔按其最新可得值计入并标注「截尾」。
            {missing > 0 && (
              <>
                {' '}
                该季度另有 {missing} 笔已报案赔案尚未到达此期。
              </>
            )}
            {claims.length > 0 && censored === 0 && (
              <>
                {' '}
                本格覆盖该季度<strong>全部已报案理赔</strong>。
              </>
            )}
            {incomplete > 0 && <> 其中 {incomplete} 笔的未决评估不完整。</>}
          </p>
        </div>
      </div>
      <div className="section-body">
        <div className="inspector">
          <div>
            <div className="cell-summary">
              <div className="mini">
                <span className="k">累计已付（净额）</span>
                <span className="v">
                  {formatAmount(sum.paid)}
                  <small> 元</small>
                </span>
                <span className="hint">
                  支付 {formatCompact(sum.grossPaid)} · 冲销 −{formatCompact(sum.reversed)}
                </span>
              </div>
              <div className="mini">
                <span className="k">未决估算</span>
                <span className="v">
                  {formatAmount(sum.reserve)}
                  <small> 元</small>
                </span>
                <span className="hint">{incomplete > 0 ? `${incomplete} 笔不完整` : '评估完整'}</span>
              </div>
              <div className="mini">
                <span className="k">{metric === 'paid' ? '本格口径值（已付）' : '本格口径值（已付+未决）'}</span>
                <span className="v">
                  {formatAmount(metric === 'paid' ? sum.paid : sum.incurred)}
                  <small> 元</small>
                </span>
                <span className="hint">与三角单元格一致</span>
              </div>
              <div className="mini">
                <span className="k">样本 / 赔案状态</span>
                <span className="v">
                  {claims.length}
                  <small> / {cohort.length} 笔</small>
                </span>
                <span className="hint">
                  {statusCounts
                    .filter((s) => s.count > 0)
                    .map((s) => `${STATUS_LABELS[s.status]} ${s.count}`)
                    .join(' · ')}
                </span>
              </div>
            </div>

            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="claims" aria-label="单元格理赔记录">
                <thead>
                  <tr>
                    <th scope="col">赔案号</th>
                    <th scope="col">状态</th>
                    <th scope="col">标记</th>
                    <th scope="col" style={{ textAlign: 'right' }}>
                      已付净额
                    </th>
                    <th scope="col" style={{ textAlign: 'right' }}>
                      未决估算
                    </th>
                    <th scope="col" style={{ textAlign: 'right' }}>
                      {metric === 'paid' ? '口径值' : '已付+未决'}
                    </th>
                    <th scope="col">险种</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty-state">
                        本单元格没有赔案（若是缺口则不应选中）。
                      </td>
                    </tr>
                  )}
                  {claims.map((item) => (
                    <tr key={item.claim.id}>
                      <td>
                        <span className="claim-no">{item.claim.claimNumber}</span>
                        <span className="claim-sub">
                          事故 {item.claim.accidentDate} · 报案 {item.claim.reportDate}
                          {item.claim.reportLagDays > 45 ? `（迟报 ${item.claim.reportLagDays} 天）` : ''}
                        </span>
                        {item.censored && (
                          <span className="claim-sub">观察至 {item.asOf}（M+{item.latestAge}），未满 M+{selection.age}</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_CLASS[item.status]}`}>{STATUS_LABELS[item.status]}</span>
                      </td>
                      <td>
                        <div className="badges">
                          {item.censored && (
                            <span className="badge neutral" title={`尚未满 M+${selection.age}，按其最新期 M+${item.asOf.slice(0, 7)} 的值计入`}>
                              截尾
                            </span>
                          )}
                          {item.lateReported && <span className="badge flag-late">迟报</span>}
                          {item.deniedEver && item.status !== 'denied' && <span className="badge neutral">曾拒赔</span>}
                          {item.reopened && <span className="badge status-reopened">重开</span>}
                          {item.adjustmentCount > 0 && (
                            <span className="badge flag-adjust" title="跨险种调整不计入已付">
                              调整 {item.adjustmentCount}
                            </span>
                          )}
                          {item.reversalCount > 0 && (
                            <span className="badge neutral" title="冲销已从已付中扣减，未新增正向支付">
                              冲销 {item.reversalCount}
                            </span>
                          )}
                          {item.ignoredReversalCount > 0 && (
                            <span className="badge neutral" title="找不到原支付或超额，未计入净额">
                              无效冲销 {item.ignoredReversalCount}
                            </span>
                          )}
                          {item.incomplete && (
                            <span className="badge flag-incomplete" title={item.incompleteReason}>
                              评估不完整
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="num">{formatAmount(item.paid)}</td>
                      <td className="num">{formatAmount(item.caseReserve)}</td>
                      <td className="num">
                        {formatAmount(metric === 'paid' ? item.paid : item.incurred)}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{LINE_LABELS[lineAt(item.claim, item.asOf)]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="side">
            <div className="side-card">
              <h3>汇总校验</h3>
              <div className="kv">
                <span className="k">正向支付合计</span>
                <span className="v">{formatAmount(sum.grossPaid)}</span>
              </div>
              <div className="kv">
                <span className="k">有效冲销合计</span>
                <span className="v neg">−{formatAmount(sum.reversed)}</span>
              </div>
              <div className="kv">
                <span className="k">已付净额</span>
                <span className="v">{formatAmount(sum.paid)}</span>
              </div>
              <div className="kv">
                <span className="k">未决估算</span>
                <span className="v">{formatAmount(sum.reserve)}</span>
              </div>
              <div className="kv">
                <span className="k">跨险种调整（非现金）</span>
                <span className="v">
                  {sum.adjustments} 笔 · {formatAmount(sum.adjustedAmount)}
                </span>
              </div>
              <div className="kv">
                <span className="k">样本覆盖</span>
                <span className="v">
                  {mature}/{cohort.length} 笔已满期
                </span>
                <span className="hint" style={{ fontSize: 10.5 }}>
                  另 {censored} 笔未满期，按最新值计入
                </span>
              </div>
            </div>
            {claims.length > 0 && <ClaimDetail claim={claims[0].claim} asOf={claims[0].asOf} />}
          </aside>
        </div>
      </div>
    </section>
  )
}

function ClaimDetail({ claim, asOf }: { claim: Claim; asOf: string }) {
  const timeline = claimStatusTimeline(claim, asOf)
  const ledger = claim.ledger.filter((e) => e.valueDate <= asOf)
  const adjustments = claim.lineAdjustments.filter((a) => a.at <= asOf)
  return (
    <div className="claim-detail">
      <div className="head">
        <div>
          <div className="claim-no">{claim.claimNumber}</div>
          <div className="claim-sub">示例赔案（列表首行）· 观察时点 {asOf}</div>
        </div>
      </div>
      <div className="hint" style={{ marginBottom: 2 }}>
        状态时间线
      </div>
      <ul className="timeline">
        {timeline.map((t) => (
          <li key={`${t.at}-${t.status}`}>
            <time>{t.at}</time>
            <span>{t.label}</span>
          </li>
        ))}
        {timeline.length === 0 && (
          <li>
            <time>—</time>
            <span>尚无状态记录</span>
          </li>
        )}
      </ul>
      <div className="hint" style={{ marginTop: 10, marginBottom: 2 }}>
        现金流水（{ledger.length} 笔）
      </div>
      <div className="ledger-lines">
        {ledger.map((e) => (
          <div key={e.id} className={`ledger-line${e.kind === 'reversal' ? ' reversal' : ''}`}>
            <span>{e.valueDate.slice(2)}</span>
            <span>{e.kind === 'payment' ? '支付' : '冲销'}{e.note ? ` · ${e.note}` : ''}</span>
            <span className="amt">{e.kind === 'payment' ? '' : '−'}{formatAmount(e.amount)}</span>
          </div>
        ))}
      </div>
      {adjustments.length > 0 && (
        <>
          <div className="hint" style={{ marginTop: 10, marginBottom: 2 }}>
            跨险种调整（非现金）
          </div>
          <div className="ledger-lines">
            {adjustments.map((a) => (
              <div key={a.id} className="ledger-line">
                <span>{a.at.slice(2)}</span>
                <span>
                  {LINE_LABELS[a.fromLine]} → {LINE_LABELS[a.toLine]}
                </span>
                <span className="amt">不计已付</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
