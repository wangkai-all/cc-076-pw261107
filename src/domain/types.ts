/**
 * 领域模型：理赔台账、发展三角、发展因子、情景与快照。
 *
 * 术语约定（全项目一致）：
 * - 事故季度 accidentQuarter：YYYY-Qn，例如 "2023-Q4"
 * - 报案后经过月数 age：0 起，0 表示报案当月
 * - 已付 paid：正向支付合计 - 有效冲销合计（见 ledger.ts）
 * - 未决估算 caseReserve：该发展期时点对未付部分的评估
 * - 缺口 gap：没有理赔到达该发展期的单元格，数据上为 null（与金额为零不同）
 * - 部分单元格 partial：到达该期的理赔数 < 该季度截至估值日已报案理赔数
 * - 不完整评估 incomplete：该期未决估算尚未完成（如第三方定损未回函）
 * - 迟报 / 拒赔 / 拒赔后重开：分别作为独立状态保留，不互相覆盖
 * - 跨险种调整：非现金归属变更，不重复计入已付
 */

export type LineOfBusiness = 'auto' | 'property' | 'liability' | 'marine'

export type ClaimStatus = 'open' | 'closed' | 'denied' | 'reopened'

/** 迟报是里程碑标记，不覆盖理赔终态。 */
export type StatusMarker = 'late_reported'

export type LedgerKind = 'payment' | 'reversal'

/**
 * 一笔现金流水。
 * - payment：amount 为正
 * - reversal：amount 为正（冲销金额），计算净额时取负；reverses 指向被冲销的支付 id。
 * 冲销绝不作为新的正向支付累计。
 */
export interface LedgerEntry {
  id: string
  kind: LedgerKind
  reverses?: string
  amount: number
  valueDate: string
  /** 该笔流水发生时的险种归属 */
  line: LineOfBusiness
  note?: string
}

/** 跨险种调整：非现金归属变更，不生成支付、不改变已付总额。 */
export interface LineAdjustment {
  id: string
  at: string
  fromLine: LineOfBusiness
  toLine: LineOfBusiness
  /** 调整时点已付金额（仅作说明，不重复入账） */
  paidAtAdjustment: number
  reason: string
}

/** 某个月末的未决估算。按月保留，后一期不覆盖前一期。 */
export interface ReservePoint {
  valueDate: string
  amount: number
  line: LineOfBusiness
  incomplete?: boolean
  incompleteReason?: string
}

/** 一次状态变更，按时间顺序保存，绝不覆盖历史。 */
export interface StatusEvent {
  id: string
  at: string
  status: ClaimStatus | StatusMarker
  reason?: string
}

export interface Claim {
  id: string
  /** 虚构脱敏赔案号 */
  claimNumber: string
  accidentQuarter: string
  accidentDate: string
  reportDate: string
  /** 报案延迟天数，> 45 天视为迟报 */
  reportLagDays: number
  originalLineOfBusiness: LineOfBusiness
  statusHistory: StatusEvent[]
  lineAdjustments: LineAdjustment[]
  ledger: LedgerEntry[]
  reserveHistory: ReservePoint[]
}

export interface CellAggregate {
  /** 纳入该单元格的理赔数（冲销与调整不增加样本） */
  claimCount: number
  /** 已到达该发展期的理赔数（样本数） */
  matureCount: number
  /** 该事故季度截至估值日已报案的理赔总数 */
  cohortCount: number
  /** 存在尚未到达该期的理赔（其值按最新可得值计入，单元格为部分样本） */
  partial: boolean
  /** 未满该期、按最新值计入的理赔数 */
  censoredCount: number
  paid: number
  grossPaid: number
  reversedAmount: number
  caseReserve: number
  incurred: number
  /** 以下状态计数均以该发展期期末为观察时点 */
  openCount: number
  closedCount: number
  deniedCount: number
  reopenedCount: number
  lateReportedCount: number
  /** 该期未决评估不完整的理赔数 */
  incompleteCount: number
  paymentCount: number
  reversalCount: number
  /** 跨险种调整笔数（非现金） */
  adjustmentCount: number
  adjustedAmount: number
  /** 纳入该单元格的赔案 id（用于明细下钻） */
  claimIds: string[]
}

export interface TriangleRowMeta {
  quarter: string
  /** 截至估值日已报案的理赔数 */
  cohortCount: number
  /** 事故季度在范围内、但截至估值日仍未报案的理赔数（不进入三角） */
  unreportedCount: number
  /** 该季度理赔实际已过月数（未封顶） */
  actualLatestAge: number
  /** 三角行最深期（封顶 horizon-1） */
  latestAge: number
  /** 最新对角单元格覆盖的理赔数 */
  latestClaimCount: number
  /** 连续完整期：<= 该值的单元格样本完整且无缺失评估 */
  completeThrough: number
  /** 最新对角单元格只覆盖部分理赔 */
  diagonalPartial: boolean
  /** 含不完整未决评估的单元格数 */
  incompleteCells: number
  /** 该季度最新对角单元格的观察月末 */
  latestEnded: string
}

export interface Triangle {
  horizon: number
  metric: TriangleMetric
  /** rows[quarter][age]；null 表示缺口 */
  rows: Record<string, (CellAggregate | null)[]>
  meta: Record<string, TriangleRowMeta>
  quarters: string[]
  /** 当前口径下最大单元格金额，用于色阶 */
  maxValue: number
}

export type TriangleMetric = 'paid' | 'incurred'

export type DevelopmentBasis =
  | 'volume-weighted'
  | 'simple-average'
  | 'last-3-weighted'
  | 'latest-row'

export type FactorMode = 'auto' | 'locked' | 'manual'

export interface FactorRow {
  from: number
  to: number
  /** 情景实际采用的因子 */
  factor: number
  /** 按当前口径、当前基准、当前数据版本计算的因子 */
  autoFactor: number
  /** 参与计算的历史完整行数 */
  sampleSize: number
  /** 参与计算的事故季度（按时间排序） */
  sampleQuarters: string[]
  basis: DevelopmentBasis
  mode: FactorMode
  /** 样本行数低于 MIN_SAMPLE_ROWS */
  insufficient: boolean
  detail: string
  lockedAtVersion?: number
  lockedAtDate?: string
}

export interface FactorSetting {
  mode: FactorMode
  /** locked / manual 时使用 */
  value: number
  /** 锁定时冻结的数据版本与日期 */
  lockedAtVersion?: number
  lockedAtDate?: string
  /** 锁定时冻结的自动因子，用于展示漂移 */
  lockedFromAuto?: number
}

export interface Scenario {
  id: string
  name: string
  basis: DevelopmentBasis
  isBaseline: boolean
  /** `${from}` -> 设置；缺省表示 auto */
  settings: Record<string, FactorSetting>
  /** 固定色位：颜色跟随情景实体，排序变化不会重新上色 */
  colorSlot: number
  createdAt: string
  note?: string
}

export interface ScenarioQuarterResult {
  quarter: string
  /** 该季度已报案理赔数 */
  claimCount: number
  /** 截至估值日仍未报案的理赔数（不进入投影） */
  unreportedCount: number
  settledCount: number
  immatureCount: number
  /** 该季度理赔的最大已过月数（封顶 horizon-1） */
  latestAge: number
  /** 估值日实际累计值（按口径） */
  currentValue: number
  /** ultimate / currentValue */
  remainingFactor: number
  ultimate: number
  paid: number
  caseReserve: number
  /** 需补提准备金 */
  ibnr: number
}

export interface ScenarioResult {
  scenarioId: string
  scenarioName: string
  isBaseline: boolean
  colorSlot: number
  metric: TriangleMetric
  basis: DevelopmentBasis
  /** 解析后的因子（含自动值与采用值） */
  factors: FactorRow[]
  ultimate: number
  /** 最终估计 - 已付 -（按口径的）未决持有 */
  ibnr: number
  paidToDate: number
  caseHeld: number
  /** 需补提准备金（= ibnr，显式保留便于展示） */
  requiredReserve: number
  /** 最新对角只覆盖部分理赔的季度 */
  partialRows: string[]
  /** 含不完整未决评估的单元格数 */
  incompleteCells: number
  /** 未报案理赔数 */
  unreportedCount: number
  byQuarter: ScenarioQuarterResult[]
  dataVersion: number
}

export interface FrozenCell {
  age: number
  /** 纳入该单元格的赔案号（理赔记录本身不可变，明细可复现） */
  claimIds: string[]
  claimCount: number
  matureCount: number
  censoredCount: number
  cohortCount: number
  partial: boolean
  paid: number
  grossPaid: number
  reversedAmount: number
  caseReserve: number
  incompleteCount: number
  lateReportedCount: number
  openCount: number
  closedCount: number
  deniedCount: number
  reopenedCount: number
}

export interface FrozenQuarterRow {
  quarter: string
  cohortCount: number
  latestAge: number
  completeThrough: number
  cells: (FrozenCell | null)[]
}

export interface Snapshot {
  id: string
  label: string
  createdAt: string
  valuationDate: string
  /** 冻结时的数据版本；新理赔到达不会改写它 */
  dataVersion: number
  metric: TriangleMetric
  basis: DevelopmentBasis
  /** 冻结的基准因子（含解析后的采用值） */
  factors: FactorRow[]
  /** 冻结的基准结果 */
  result: ScenarioResult
  /** 冻结的各情景结果 */
  scenarioResults: ScenarioResult[]
  rows: FrozenQuarterRow[]
  partialRows: string[]
  unreportedTotal: number
  note?: string
}

export interface ArrivalEvent {
  version: number
  at: string
  kind: 'init' | 'arrival' | 'snapshot'
  message: string
}

export interface Workbook {
  schemaVersion: number
  valuationDate: string
  dataVersion: number
  seed: number
  /** 含尚未报案（报案日在估值日之后）的理赔；视图只取已报案部分 */
  claims: Claim[]
  scenarios: Scenario[]
  snapshots: Snapshot[]
  events: ArrivalEvent[]
  metric: TriangleMetric
  /** 基准情景使用的发展因子口径 */
  basis: DevelopmentBasis
  createdAt: string
}
