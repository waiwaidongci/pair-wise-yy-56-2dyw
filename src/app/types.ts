export type WeldStatus = '待检测' | '合格' | '返修中' | '待复检' | '已关闭'
export type DefectLevel = 'Ⅰ级' | 'Ⅱ级' | 'Ⅲ级' | 'Ⅳ级'

export interface Defect {
  id: string
  position: number
  type: string
  length: number
  level: DefectLevel
  method: string
  report: string
}

export interface Weld {
  id: string
  drawing: string
  component: string
  joint: string
  method: string
  welder: string
  qualification: string
  qualificationValid: boolean
  inspectionRatio: number
  requiredRatio: number
  status: WeldStatus
  x: number
  y: number
  repairs: number
  defects: Defect[]
}

export interface InspectionPlan {
  id: string
  date: string
  method: string
  weldIds: string[]
  inspector: string
  state: '待执行' | '执行中' | '已完成'
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}

// 断网补录：现场检验员先存本地、回网按批次合并的提交单
export type SubmissionKind = 'defect' | 'repair' | 'status' | 'plan'
export type SubmissionStatus = '待合并' | '已合并' | '冲突待处理' | '写入失败'

export interface OfflineSubmission {
  requestId: string      // 请求号：幂等键，写入失败后按原请求号恢复
  batchId: string        // 批次号：回网合并时按批次归集
  kind: SubmissionKind
  weldId: string
  payload: Record<string, any>
  operator: string
  createdAt: string
  status: SubmissionStatus
  error?: string
}

// 晚到内容按请求号另存的冲突：不盖掉已签字结论
export type ConflictState = '待处理' | '已采纳' | '已驳回'

export interface ConflictRecord {
  id: string
  requestId: string
  batchId: string
  weldId: string
  kind: SubmissionKind
  incoming: Record<string, any>   // 晚到内容
  existing: Record<string, any>   // 冲突发生时的可用 / 已签字结论快照
  operator: string
  detectedAt: string
  state: ConflictState
  resolution?: string
}

export interface MergeConflictResult {
  requestId: string
  weldId: string
  kind: SubmissionKind
  incoming: Record<string, any>
  existing: Record<string, any> | null
}

export interface MergeBatchResult {
  batchId: string
  applied: string[]
  conflicts: MergeConflictResult[]
}
