import type { Claim, ClaimStatus } from './types'
import { ledgerThrough, reserveAmountAt, statusAt } from './ledger'

/** 估值日单个理赔的终值输入（用于逐理赔投影）。 */
export interface ClaimUltimateInput {
  status: ClaimStatus
  paid: number
  caseReserve: number
}

export function claimUltimateInput(claim: Claim, valuationDate: string): ClaimUltimateInput {
  const status = statusAt(claim, valuationDate)
  const paid = ledgerThrough(claim, valuationDate).paid
  const caseReserve = reserveAmountAt(claim, valuationDate)
  return { status, paid, caseReserve }
}

/** 理赔在估值日的展示摘要。 */
export interface ClaimSummary {
  claim: Claim
  status: ClaimStatus
  paid: number
  grossPaid: number
  reversedAmount: number
  caseReserve: number
  reported: boolean
  lateReported: boolean
  reopened: boolean
  deniedEver: boolean
  age: number
  paymentCount: number
  reversalCount: number
  adjustmentCount: number
}

export function summariseClaim(claim: Claim, valuationDate: string): ClaimSummary {
  const ledger = ledgerThrough(claim, valuationDate)
  const status = statusAt(claim, valuationDate)
  return {
    claim,
    status,
    paid: ledger.paid,
    grossPaid: ledger.grossPaid,
    reversedAmount: ledger.reversedAmount,
    caseReserve: reserveAmountAt(claim, valuationDate),
    reported: claim.reportDate <= valuationDate,
    lateReported: claim.reportLagDays > 45,
    reopened: claim.statusHistory.some((e) => e.at <= valuationDate && e.status === 'reopened'),
    deniedEver: claim.statusHistory.some((e) => e.at <= valuationDate && e.status === 'denied'),
    age: 0,
    paymentCount: ledger.payments.length,
    reversalCount: ledger.reversals.length,
    adjustmentCount: claim.lineAdjustments.filter((a) => a.at <= valuationDate).length,
  }
}
