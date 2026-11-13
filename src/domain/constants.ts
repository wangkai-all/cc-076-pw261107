/** 全局口径常量（虚构演示数据，非真实业务数据）。 */

/** 估值日：所有"当前"视图以该日为截点。 */
export const VALUATION_DATE = '2026-03-31'

/** 事故季度范围（12 个季度，形成 12 行三角）。 */
export const QUARTERS = [
  '2023-Q1',
  '2023-Q2',
  '2023-Q3',
  '2023-Q4',
  '2024-Q1',
  '2024-Q2',
  '2024-Q3',
  '2024-Q4',
  '2025-Q1',
  '2025-Q2',
  '2025-Q3',
  '2025-Q4',
] as const

/** 最大发展期（报案后经过月数）：0..11，共 12 列、11 个发展因子。 */
export const HORIZON = 12

/** 三角最后一期（age 11）。 */
export const MAX_AGE = HORIZON - 1

/** 自动因子至少需要的历史完整行数；低于该值提示样本不足。 */
export const MIN_SAMPLE_ROWS = 2

/** 迟报判定：报案延迟超过该天数。 */
export const LATE_REPORT_DAYS = 45

export const APP_TITLE = '理赔发展分析'

export const DATA_SEED = 20260331
