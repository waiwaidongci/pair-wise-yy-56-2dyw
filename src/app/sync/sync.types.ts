import type { Defect, InspectionPlan, Weld, WeldStatus } from '../types'

/** 断网补录请求的生命周期状态 */
export type SubmissionStatus = '待同步' | '同步中' | '已并入' | '冲突待处理' | '已另存' | '写入失败'
/** 冲突裁决方式：保留已签字结论 / 采纳补录为新修订 */
export type ConflictResolution = '维持已签字' | '采纳为新修订'
export type ConflictState = '待处理' | ConflictResolution

/** 回网批次中一次断网补录的完整请求体（焊缝缺陷 + 返修结果） */
export interface OfflineSubmission {
  requestId: string
  batchId: string
  time: string
  inspector: string
  weldId: string
  method: string
  defect: Omit<Defect, 'id'>
  repairResult?: {
    /** 本次补录返修次数（仅当服务端尚未登记该请求时累加 1，重复提交不累加） */
    repairCount: number
    recheckPlan: { date: string; method: string }
  }
  /** 提交时所依据的服务端焊缝修订号；与当前不一致即并发冲突 */
  baseRev: number
  /** 本地待同步/同步中/失败/冲突，已并入后也保留在台账中用于追溯 */
  status: SubmissionStatus
  error?: string
}

/** 签字锁定时为每条焊缝冻结的可用结论（审核快照内容） */
export interface SignedConclusion {
  weldId: string
  status: WeldStatus
  repairs: number
  defectIds: string[]
  planIds: string[]
  signedBy: string
  signedAt: string
  version: number
}

/** 冲突快照：晚到请求按原请求号另存，不覆盖已签字结论 */
export interface ConflictRecord {
  requestId: string
  batchId: string
  time: string
  inspector: string
  weldId: string
  reason: string
  /** 冲突时服务端（已签字/已排计划）的可用结论 */
  serverSnapshot: {
    status: WeldStatus
    repairs: number
    version: number
    signed: boolean
    defectIds: string[]
  }
  /** 晚到补录内容快照 */
  incoming: {
    method: string
    defect: Omit<Defect, 'id'>
    repairCount?: number
    recheckPlan?: { date: string; method: string }
  }
  state: ConflictState
  resolvedAt?: string
  resolvedBy?: string
}

/** 幂等台账：已应用请求号 → 批次/并入时间，重放直接命中不再追加 */
export interface AppliedLedgerEntry {
  requestId: string
  batchId: string
  appliedAt: string
  note: string
}

/** 模拟服务端的权威状态：所有读取只认这一份 */
export interface ServerState {
  welds: Weld[]
  plans: InspectionPlan[]
  audit: { id: string; time: string; actor: string; action: string; target: string; detail: string }[]
  /** 每条焊缝的修订号，冲突判定用 */
  weldRevs: Record<string, number>
  /** 批次内检测计划去重键，防止重复追加 */
  planKeys: string[]
  applied: AppliedLedgerEntry[]
  conflicts: ConflictRecord[]
  signed: SignedConclusion[]
  locked: boolean
  lockedBy?: string
  lockedAt?: string
  version: number
  snapshots: { version: number; by: string; at: string; note: string }[]
  /** 采纳冲突后出现待重新签字的派生修订 */
  pendingResign: boolean
}
