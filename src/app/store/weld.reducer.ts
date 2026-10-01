import { createReducer, on } from '@ngrx/store'
import type { AuditEvent, ConflictRecord, ConflictState, Defect, InspectionPlan, OfflineSubmission, SubmissionStatus, Weld } from '../types'
import * as A from './weld.actions'

export interface WeldState {
  welds: Weld[]
  plans: InspectionPlan[]
  selectedId: string
  statusFilter: string
  locked: boolean
  version: number
  audit: AuditEvent[]
  submissions: OfflineSubmission[]
  conflicts: ConflictRecord[]
  online: boolean
  syncing: boolean
  lastBatchId: string
  appliedRequestIds: string[]
}

const audit: AuditEvent[] = [
  { id: 'AE-1', time: '16:38', actor: '赵岚', action: '提交复检', target: 'W-104', detail: '返修后 UT 复检合格，等待审核签字' },
  { id: 'AE-2', time: '15:12', actor: '陈锋', action: '录入缺陷', target: 'W-107', detail: '翼缘板端部夹渣，长度 12mm，Ⅱ级' },
  { id: 'AE-3', time: '14:20', actor: '系统', action: '资质预警', target: 'W-109', detail: '焊工证书 2026-10-01 到期，不得列入后续检测计划' },
]

export const initialState: WeldState = { welds: [], plans: [], selectedId: '', statusFilter: '全部', locked: false, version: 12, audit, submissions: [], conflicts: [], online: true, syncing: false, lastBatchId: '', appliedRequestIds: [] }

function nowTime(): string { return new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false }) }
function auditId(): string { return `AE-${Date.now()}-${Math.random().toString(36).slice(2,7)}` }

function mergeById<T>(current: T[], incoming: T[], key: keyof T): T[] {
  const seen = new Set(current.map((item) => item[key]))
  const merged = [...current]
  for (const item of incoming) {
    if (!seen.has(item[key])) { seen.add(item[key]); merged.push(item) }
  }
  return merged
}

// 纯函数：把一条已确认的提交应用到焊缝 / 计划。幂等——缺陷已存在、计划已存在则跳过。
function applyPayload(welds: Weld[], plans: InspectionPlan[], sub: OfflineSubmission): { welds: Weld[]; plans: InspectionPlan[] } {
  if (sub.kind === 'plan') {
    const plan = sub.payload.plan as InspectionPlan
    if (plans.some((item) => item.id === plan.id)) return { welds, plans }
    return { welds, plans: [plan, ...plans] }
  }
  return { welds: welds.map((weld) => {
    if (weld.id !== sub.weldId) return weld
    if (sub.kind === 'defect') {
      const defect = sub.payload.defect as Defect
      return weld.defects.some((item) => item.id === defect.id) ? weld : { ...weld, defects: [...weld.defects, defect] }
    }
    if (sub.kind === 'repair') {
      return { ...weld, repairs: weld.repairs + 1, ...(sub.payload.status ? { status: sub.payload.status } : {}) }
    }
    if (sub.kind === 'status') {
      return { ...weld, status: sub.payload.status as Weld['status'] }
    }
    return weld
  }), plans }
}

export const weldReducer = createReducer(
  initialState,
  on(A.loadWeldsSuccess, (state, { welds, plans }) => ({ ...state, welds, plans, selectedId: state.selectedId || welds[0]?.id || '' })),
  on(A.selectWeld, (state, { id }) => ({ ...state, selectedId: id })),
  on(A.filterStatus, (state, { status }) => ({ ...state, statusFilter: status })),
  on(A.advanceWeld, (state, { id, status }) => ({ ...state, version: state.version + 1, welds: state.welds.map((weld) => weld.id === id ? { ...weld, status } : weld), audit: [{ id: auditId(), time: nowTime(), actor:'当前审核人', action:'状态流转', target:id, detail:`状态变更为 ${status}` }, ...state.audit] })),
  on(A.createPlan, (state, { plan }) => ({ ...state, plans: [plan, ...state.plans], version: state.version + 1 })),
  on(A.lockBaseline, (state) => ({ ...state, locked: true, audit: [{ id: auditId(), time: nowTime(), actor: '质量负责人', action: '签字锁定', target: '检测批次', detail: '焊工资质、检测比例与返修闭环已确认，生成只读审核快照；晚到内容不再盖回已签字结论' }, ...state.audit] })),

  on(A.hydrateQueue, (state, { submissions, conflicts }) => ({
    ...state,
    submissions: mergeById(state.submissions, submissions, 'requestId'),
    conflicts: mergeById(state.conflicts, conflicts, 'id'),
  })),
  on(A.setOnline, (state, { online }) => ({ ...state, online })),
  on(A.enqueueSubmission, (state, { submission }) => ({
    ...state,
    submissions: state.submissions.some((item) => item.requestId === submission.requestId) ? state.submissions : [submission, ...state.submissions],
  })),
  on(A.flushQueue, (state) => ({ ...state, syncing: true })),
  on(A.flushQueueSuccess, (state, { batchId, applied, conflicts }) => {
    let welds = state.welds
    let plans = state.plans
    const appliedSet = new Set(state.appliedRequestIds)
    for (const requestId of applied) {
      if (appliedSet.has(requestId)) continue
      const sub = state.submissions.find((item) => item.requestId === requestId)
      if (!sub) continue
      const next = applyPayload(welds, plans, sub)
      welds = next.welds
      plans = next.plans
      appliedSet.add(requestId)
    }
    const conflictIds = new Set(conflicts.map((item) => item.requestId))
    const submissions: OfflineSubmission[] = state.submissions.map((item) => {
      if (applied.includes(item.requestId)) return { ...item, batchId, status: '已合并' as SubmissionStatus, error: undefined }
      if (conflictIds.has(item.requestId)) return { ...item, batchId, status: '冲突待处理' as SubmissionStatus }
      return item
    })
    const mergedConflicts = mergeById(state.conflicts, conflicts, 'requestId')
    const audit: AuditEvent[] = [
      ...conflicts.map((item) => ({ id: auditId(), time: nowTime(), actor: '系统', action: '批次冲突', target: item.weldId, detail: `请求号 ${item.requestId} 晚到，已按冲突另存并保留已签字结论，等待质量台处理` })),
      ...(applied.length ? [{ id: auditId(), time: nowTime(), actor: '系统', action: '批次合并', target: batchId, detail: `批次 ${batchId} 合并 ${applied.length} 条（缺陷 / 返修 / 检测计划）` }] : []),
      ...state.audit,
    ]
    return { ...state, welds, plans, submissions, conflicts: mergedConflicts, syncing: false, lastBatchId: batchId, appliedRequestIds: [...appliedSet], version: applied.length ? state.version + 1 : state.version, audit }
  }),
  on(A.flushQueueFailure, (state, { error, requestIds }) => ({
    ...state,
    syncing: false,
    submissions: state.submissions.map((item) => requestIds.includes(item.requestId) ? { ...item, status: '写入失败' as SubmissionStatus, error } : item),
    audit: [{ id: auditId(), time: nowTime(), actor: '系统', action: '写入失败', target: `批次 ${state.lastBatchId || '—'}`, detail: `${error}；返修次数与检测计划未追加，请按原请求号重试` }, ...state.audit],
  })),
  on(A.retrySubmission, (state, { requestId }) => ({
    ...state,
    submissions: state.submissions.map((item) => item.requestId === requestId ? { ...item, status: '待合并' as SubmissionStatus, error: undefined } : item),
  })),
  on(A.resolveConflict, (state, { conflictId, adopt }) => {
    const conflict = state.conflicts.find((item) => item.id === conflictId)
    let welds = state.welds
    let plans = state.plans
    if (adopt && conflict) {
      const sub = state.submissions.find((item) => item.requestId === conflict.requestId)
      if (sub) {
        const next = applyPayload(welds, plans, sub)
        welds = next.welds
        plans = next.plans
      }
    }
    const conflicts: ConflictRecord[] = state.conflicts.map((item) => item.id === conflictId ? { ...item, state: (adopt ? '已采纳' : '已驳回') as ConflictState, resolution: adopt ? '质量台采纳晚到内容，派生新修订' : '质量台驳回，维持已签字结论' } : item)
    const submissions: OfflineSubmission[] = adopt
      ? state.submissions.map((item) => item.requestId === conflict?.requestId ? { ...item, status: '已合并' as SubmissionStatus, error: undefined } : item)
      : state.submissions
    const audit: AuditEvent[] = conflict ? [{ id: auditId(), time: nowTime(), actor: '质量负责人', action: adopt ? '冲突采纳' : '冲突驳回', target: conflict.weldId, detail: `请求号 ${conflict.requestId} ${adopt ? '已采纳并派生新修订，原签字结论不被无痕覆盖' : '已驳回，维持已签字结论'}` }, ...state.audit] : state.audit
    return { ...state, welds, plans, conflicts, submissions, version: adopt ? state.version + 1 : state.version, audit }
  }),
)
