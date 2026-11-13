import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DevelopmentBasis, FactorSetting, Scenario, TriangleMetric, Workbook } from '../domain/types'
import { APP_TITLE, HORIZON, MIN_SAMPLE_ROWS } from '../domain/constants'
import { analyse, captureSnapshot, type Analysis } from '../domain/analysis'
import { arriveNewClaims, generateWorkbook } from '../data/generator'
import { BASIS_LABELS, BASIS_ORDER, cumulativeFactor, resolveFactors, scenarioDelta } from '../domain/development'
import { claimsInCell, METRIC_LABELS, quarterBounds } from '../domain/triangle'
import { STATUS_LABELS } from '../domain/ledger'
import { formatAmount, formatFactor, formatPercent, formatSignedPercent, formatSignedAmount } from './format'
import { TriangleSection } from './triangle-view'
import { CellInspector } from './cell-inspector'
import { FactorSection } from './factor-view'
import { ScenarioSection } from './scenario-view'
import { SnapshotSection } from './snapshot-view'
import { Notices } from './notices'

const STORAGE_KEY = 'claims-dev-workbench-v3'

type Tab = 'triangle' | 'factors' | 'scenarios' | 'snapshots'

export interface Selection {
  quarter: string
  age: number
}

export interface AppState {
  workbook: Workbook
  metric: TriangleMetric
  basis: DevelopmentBasis
  tab: Tab
  selection: Selection | null
  frozenSnapshotId: string | null
  theme: 'light' | 'dark'
  showGapHighlight: boolean
}

function loadState(): AppState {
  const fresh = generateWorkbook()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppState>
      if (parsed.workbook?.claims?.length) {
        // 快照与其数值原样恢复；不重算历史
        return {
          workbook: { ...fresh, ...parsed.workbook },
          metric: parsed.metric ?? 'paid',
          basis: parsed.basis ?? 'volume-weighted',
          tab: 'triangle',
          selection: null,
          frozenSnapshotId: null,
          theme: (parsed.theme as 'light' | 'dark') ?? 'light',
          showGapHighlight: true,
        }
      }
    }
  } catch {
    /* 忽略损坏的本地状态 */
  }
  return {
    workbook: fresh,
    metric: 'paid',
    basis: 'volume-weighted',
    tab: 'triangle',
    selection: { quarter: '2024-Q1', age: 3 },
    frozenSnapshotId: null,
    theme: 'light',
    showGapHighlight: true,
  }
}

export default function App() {
  const [state, setState] = useState<AppState>(loadState)
  const { workbook, metric, basis, tab, selection, frozenSnapshotId, theme } = state

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          workbook,
          metric,
          basis,
          theme,
        }),
      )
    } catch {
      /* 存储空间不足时静默降级 */
    }
  }, [workbook, metric, basis, theme])

  const analysis = useMemo(() => analyse(workbook, metric), [workbook, metric])
  const frozenSnapshot = useMemo(
    () => workbook.snapshots.find((s) => s.id === frozenSnapshotId) ?? null,
    [workbook.snapshots, frozenSnapshotId],
  )

  const patchWorkbook = useCallback((updater: (wb: Workbook) => Workbook) => {
    setState((prev) => ({ ...prev, workbook: updater(prev.workbook) }))
  }, [])

  const updateScenario = useCallback(
    (id: string, updater: (scenario: Scenario) => Scenario) => {
      patchWorkbook((wb) => ({
        ...wb,
        scenarios: wb.scenarios.map((s) => (s.id === id ? updater(s) : s)),
      }))
    },
    [patchWorkbook],
  )

  const addScenario = useCallback(() => {
    patchWorkbook((wb) => {
      const used = new Set(wb.scenarios.map((s) => s.colorSlot))
      let slot = 1
      while (used.has(slot) && slot < 8) slot += 1
      const scenario: Scenario = {
        id: `sc-${Date.now().toString(36)}`,
        name: `情景 ${wb.scenarios.length + 1}`,
        basis,
        isBaseline: false,
        settings: {},
        colorSlot: slot,
        createdAt: new Date().toISOString(),
        note: '新建情景：默认全自动因子。',
      }
      return { ...wb, scenarios: [...wb.scenarios, scenario] }
    })
  }, [basis, patchWorkbook])

  const deleteScenario = useCallback(
    (id: string) => {
      patchWorkbook((wb) => {
        const target = wb.scenarios.find((s) => s.id === id)
        if (!target || target.isBaseline) return wb
        return { ...wb, scenarios: wb.scenarios.filter((s) => s.id !== id) }
      })
    },
    [patchWorkbook],
  )

  const setBaseline = useCallback(
    (id: string) => {
      patchWorkbook((wb) => ({
        ...wb,
        scenarios: wb.scenarios.map((s) => ({ ...s, isBaseline: s.id === id })),
      }))
    },
    [patchWorkbook],
  )

  const setFactor = useCallback(
    (scenarioId: string, from: number, setting: FactorSetting | null) => {
      updateScenario(scenarioId, (scenario) => {
        const settings = { ...scenario.settings }
        if (setting) settings[String(from)] = setting
        else delete settings[String(from)]
        return { ...scenario, settings }
      })
    },
    [updateScenario],
  )

  const lockAllFactors = useCallback(
    (scenarioId: string) => {
      const auto = analysis.factorsByBasis[workbook.scenarios.find((s) => s.id === scenarioId)?.basis ?? basis]
      updateScenario(scenarioId, (scenario) => {
        const settings: Record<string, FactorSetting> = {}
        for (const row of auto) {
          settings[String(row.from)] = {
            mode: 'locked',
            value: row.autoFactor,
            lockedAtVersion: workbook.dataVersion,
            lockedAtDate: workbook.valuationDate,
            lockedFromAuto: row.autoFactor,
          }
        }
        return { ...scenario, settings }
      })
    },
    [analysis, basis, updateScenario, workbook.dataVersion, workbook.scenarios, workbook.valuationDate],
  )

  const addSnapshot = useCallback(
    (label?: string) => {
      const snap = captureSnapshot(workbook, analysis, label)
      patchWorkbook((wb) => ({
        ...wb,
        snapshots: [snap, ...wb.snapshots],
        events: [
          ...wb.events,
          {
            version: wb.dataVersion,
            at: wb.valuationDate,
            kind: 'snapshot',
            message: `创建快照「${snap.label}」（数据版本 v${wb.dataVersion}）`,
          },
        ],
      }))
    },
    [analysis, patchWorkbook, workbook],
  )

  const deleteSnapshot = useCallback(
    (id: string) => {
      patchWorkbook((wb) => ({ ...wb, snapshots: wb.snapshots.filter((s) => s.id !== id) }))
      setState((prev) => ({ ...prev, frozenSnapshotId: prev.frozenSnapshotId === id ? null : prev.frozenSnapshotId }))
    },
    [patchWorkbook],
  )

  const arriveData = useCallback(() => {
    patchWorkbook((wb) => arriveNewClaims(wb, 4))
  }, [patchWorkbook])

  const resetAll = useCallback(() => {
    setState((prev) => ({ ...loadState(), theme: prev.theme }))
  }, [])

  const sample = useMemo(() => {
    const reported = workbook.claims.filter((c) => c.reportDate <= workbook.valuationDate)
    return {
      reported: reported.length,
      unreported: workbook.claims.length - reported.length,
    }
  }, [workbook.claims, workbook.valuationDate])

  const activeSelection = frozenSnapshot
    ? selection
    : selection

  const selectedCell = useMemo(() => {
    if (!activeSelection) return null
    if (frozenSnapshot) return null
    return claimsInCell(workbook.claims, workbook.valuationDate, activeSelection.quarter, activeSelection.age, metric)
  }, [activeSelection, frozenSnapshot, metric, workbook.claims, workbook.valuationDate])

  const baselineScenario =
    workbook.scenarios.find((s) => s.isBaseline) ?? workbook.scenarios[0]
  const baselineResult = analysis.baseline

  const totals = {
    ultimate: baselineResult.ultimate,
    ibnr: baselineResult.ibnr,
    paid: baselineResult.paidToDate,
    caseHeld: baselineResult.caseHeld,
    incomplete: baselineResult.incompleteCells,
    partialRows: baselineResult.partialRows.length,
    unreported: baselineResult.unreportedCount,
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <h1>{APP_TITLE}</h1>
            <span className="sub">发展三角 · 准备金情景</span>
          </div>
          <div className="topbar-meta">
            <div className="meta-item">
              <span className="k">估值日</span>
              <span className="v">{workbook.valuationDate}</span>
            </div>
            <div className="meta-item">
              <span className="k">数据版本</span>
              <span className="v">v{workbook.dataVersion}</span>
            </div>
            <div className="meta-item">
              <span className="k">已报案样本</span>
              <span className="v">
                {sample.reported}
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}> 笔</span>
              </span>
            </div>
            <div className="meta-item">
              <span className="k">口径</span>
              <span className="v">{METRIC_LABELS[metric]}</span>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="seg" role="group" aria-label="估值口径">
              {(['paid', 'incurred'] as TriangleMetric[]).map((m) => (
                <button
                  key={m}
                  aria-pressed={metric === m}
                  onClick={() => setState((p) => ({ ...p, metric: m }))}
                >
                  {m === 'paid' ? '已付' : '已付+未决'}
                </button>
              ))}
            </div>
            <button
              className="icon-btn"
              title={theme === 'light' ? '切换到深色' : '切换到浅色'}
              aria-label={theme === 'light' ? '切换到深色' : '切换到浅色'}
              onClick={() => setState((p) => ({ ...p, theme: p.theme === 'light' ? 'dark' : 'light' }))}
            >
              {theme === 'light' ? '◐' : '◑'}
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        <Overview
          ultimate={totals.ultimate}
          ibnr={totals.ibnr}
          paid={totals.paid}
          caseHeld={totals.caseHeld}
          incomplete={totals.incomplete}
          partialRows={totals.partialRows}
          unreported={totals.unreported}
          baselineName={baselineScenario?.name ?? '基准'}
          baselineBasis={baselineScenario?.basis ?? basis}
          analysis={analysis}
          metric={metric}
        />

        <Notices
          workbook={workbook}
          analysis={analysis}
          frozenSnapshot={frozenSnapshot}
          onArrive={arriveData}
          onSnapshot={() => addSnapshot()}
        />

        <nav className="seg" role="tablist" aria-label="视图" style={{ alignSelf: 'flex-start' }}>
          {(
            [
              ['triangle', '发展三角'],
              ['factors', '发展因子'],
              ['scenarios', '准备金情景'],
              ['snapshots', '历史快照'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              aria-pressed={tab === id}
              onClick={() => setState((p) => ({ ...p, tab: id }))}
            >
              {label}
              {id === 'snapshots' && workbook.snapshots.length > 0 ? ` · ${workbook.snapshots.length}` : ''}
            </button>
          ))}
        </nav>

        {tab === 'triangle' && (
          <>
            <TriangleSection
              workbook={workbook}
              analysis={analysis}
              metric={metric}
              selection={activeSelection}
              onSelect={(sel) => setState((p) => ({ ...p, selection: sel }))}
              frozenSnapshot={frozenSnapshot}
              onClearFrozen={() => setState((p) => ({ ...p, frozenSnapshotId: null }))}
            />
            {frozenSnapshot ? (
              <section className="section">
                <div className="section-head">
                  <div>
                    <h2>单元格明细（快照冻结）</h2>
                    <p className="desc">
                      快照只冻结汇总值，不解冻明细。切回实时视图可查看由哪些赔案汇总而来。
                    </p>
                  </div>
                </div>
              </section>
            ) : (
              <CellInspector
                workbook={workbook}
                metric={metric}
                selection={activeSelection}
                claims={selectedCell ?? []}
              />
            )}
          </>
        )}

        {tab === 'factors' && (
          <FactorSection
            workbook={workbook}
            analysis={analysis}
            metric={metric}
            baselineScenario={baselineScenario}
            onSetFactor={(from, setting) => setFactor(baselineScenario.id, from, setting)}
            onLockAll={() => lockAllFactors(baselineScenario.id)}
            onUnlockAll={() =>
              updateScenario(baselineScenario.id, (s) => ({ ...s, settings: {} }))
            }
            basis={basis}
            onBasisChange={(next) => {
              setState((p) => ({ ...p, basis: next }))
              updateScenario(baselineScenario.id, (s) => ({ ...s, basis: next }))
            }}
          />
        )}

        {tab === 'scenarios' && (
          <ScenarioSection
            workbook={workbook}
            analysis={analysis}
            metric={metric}
            onAdd={addScenario}
            onDelete={deleteScenario}
            onRename={(id, name) => updateScenario(id, (s) => ({ ...s, name }))}
            onBasis={(id, next) => updateScenario(id, (s) => ({ ...s, basis: next }))}
            onSetBaseline={setBaseline}
            onSetFactor={setFactor}
            onLockAll={lockAllFactors}
            onUnlockAll={(id) => updateScenario(id, (s) => ({ ...s, settings: {} }))}
            onSnapshot={() => addSnapshot()}
            onTab={(t) => setState((p) => ({ ...p, tab: t }))}
          />
        )}

        {tab === 'snapshots' && (
          <SnapshotSection
            workbook={workbook}
            analysis={analysis}
            onSnapshot={(label) => addSnapshot(label)}
            onDelete={deleteSnapshot}
            onFreeze={(id) =>
              setState((p) => ({ ...p, frozenSnapshotId: p.frozenSnapshotId === id ? null : id, tab: 'triangle' }))
            }
            frozenSnapshotId={frozenSnapshotId}
            onReset={resetAll}
          />
        )}

        <footer className="footnote">
          <strong>虚构脱敏数据。</strong> 本页所有赔案号（<code>SYN-…</code>）、金额与日期均为程序生成的演示数据，不含任何真实保单、个人或车辆信息；口径说明：「已付」为正现金流净额（正向支付 −
          有效冲销），「未决估算」为该期评估值。「缺口」表示没有赔案到达该发展期，与金额为零不同。样本不足、部分单元格与不完整评估均在页面标注。
        </footer>
      </main>
    </div>
  )
}

interface OverviewProps {
  ultimate: number
  ibnr: number
  paid: number
  caseHeld: number
  incomplete: number
  partialRows: number
  unreported: number
  baselineName: string
  baselineBasis: DevelopmentBasis
  analysis: Analysis
  metric: TriangleMetric
}

function Overview(props: OverviewProps) {
  const { ultimate, ibnr, paid, caseHeld, incomplete, partialRows, unreported, analysis, metric } = props
  const baseline = analysis.baseline
  const developedQuarters = baseline.byQuarter.filter((q) => q.latestAge >= HORIZON - 1).length
  return (
    <section className="stat-row" aria-label="概览">
      <div className="stat">
        <span className="label">
          最终估计（{props.baselineName}）
          <span className="badge neutral">{BASIS_LABELS[props.baselineBasis]}</span>
        </span>
        <span className="value">
          {formatAmount(ultimate, { compact: true })}
          <small>元</small>
        </span>
        <span className="foot">
          <span>{metric === 'paid' ? '已付口径，未含未决' : '已付 + 未决口径'}</span>
        </span>
      </div>
      <div className="stat">
        <span className="label">需补提准备金（IBNR）</span>
        <span className="value">
          {formatAmount(ibnr, { compact: true })}
          <small>元</small>
        </span>
        <span className="foot">
          <span>
            已付 {formatAmount(paid, { compact: true })} · 未决持有 {formatAmount(caseHeld, { compact: true })}
          </span>
        </span>
      </div>
      <div className="stat">
        <span className="label">已发展季度</span>
        <span className="value">
          {developedQuarters}
          <small>/ 12</small>
        </span>
        <span className="foot">
          <span>{partialRows} 个季度最新对角样本不完整</span>
        </span>
      </div>
      <div className="stat">
        <span className="label">数据完整性</span>
        <span className="value">
          {incomplete}
          <small> 个单元格评估不完整</small>
        </span>
        <span className="foot">
          <span>{unreported} 笔估值日后报案未纳入</span>
        </span>
      </div>
    </section>
  )
}

export { formatFactor, formatPercent, formatSignedPercent, formatSignedAmount, cumulativeFactor, resolveFactors, scenarioDelta, MIN_SAMPLE_ROWS, quarterBounds, STATUS_LABELS, BASIS_ORDER }
