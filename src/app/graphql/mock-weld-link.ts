import { ApolloLink, Observable } from '@apollo/client/core'
import type { InspectionPlan, MergeBatchResult, Weld } from '../types'

// 现场数据：与 app.config 中初始展示一致，作为服务端权威状态
const mockData: { welds: Weld[]; plans: InspectionPlan[] } = {
  welds: [
    { id:'W-101', drawing:'SG-04-钢柱', component:'KZ-12 / 柱翼缘', joint:'全熔透坡口焊', method:'GMAW', welder:'王凯', qualification:'GB/T 9448 · 2027-06', qualificationValid:true, inspectionRatio:100, requiredRatio:100, status:'合格', x:18, y:24, repairs:0, defects:[] },
    { id:'W-104', drawing:'SG-07-屋面梁', component:'GL-21 / 下翼缘', joint:'对接焊缝', method:'SAW', welder:'刘强', qualification:'GB/T 9448 · 2028-03', qualificationValid:true, inspectionRatio:100, requiredRatio:100, status:'待复检', x:48, y:38, repairs:2, defects:[{id:'D-31',position:42,type:'夹渣',length:12,level:'Ⅱ级',method:'UT',report:'UT-2026-0918'}] },
    { id:'W-107', drawing:'SG-07-屋面梁', component:'GL-21 / 腹板', joint:'角焊缝', method:'FCAW', welder:'赵明', qualification:'GB/T 9448 · 2027-01', qualificationValid:true, inspectionRatio:20, requiredRatio:20, status:'返修中', x:61, y:42, repairs:1, defects:[{id:'D-32',position:68,type:'未熔合',length:18,level:'Ⅲ级',method:'MT',report:'MT-2026-0921'}] },
    { id:'W-109', drawing:'SG-12-平台梁', component:'PL-08 / 节点板', joint:'角焊缝', method:'SMAW', welder:'孙鹏', qualification:'GB/T 9448 · 2026-10-01', qualificationValid:false, inspectionRatio:10, requiredRatio:20, status:'待检测', x:78, y:60, repairs:0, defects:[] },
    { id:'W-112', drawing:'SG-12-平台梁', component:'PL-08 / 腹板', joint:'组合焊缝', method:'GMAW', welder:'王凯', qualification:'GB/T 9448 · 2027-06', qualificationValid:true, inspectionRatio:50, requiredRatio:50, status:'已关闭', x:36, y:68, repairs:0, defects:[] },
  ],
  plans: [
    { id:'IP-2026-0930-A', date:'2026-09-30', method:'UT + MT', weldIds:['W-105','W-106','W-108'], inspector:'陈锋', state:'待执行' },
    { id:'IP-2026-0929-B', date:'2026-09-29', method:'UT', weldIds:['W-104'], inspector:'赵岚', state:'执行中' },
  ],
}

interface MockServerState {
  welds: Weld[]
  plans: InspectionPlan[]
  appliedRequestIds: Set<string>   // 服务端幂等键：已确认的请求号不重复追加
  locked: boolean
  failNext: boolean                // 模拟回网写入失败（一次性）
}

const state: MockServerState = {
  welds: clone(mockData.welds),
  plans: clone(mockData.plans),
  appliedRequestIds: new Set(),
  locked: false,
  failNext: false,
}

export function setMockWriteFailure(fail: boolean) { state.failNext = fail }

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

interface MergeSubmissionVar {
  requestId: string
  kind: 'defect' | 'repair' | 'status' | 'plan'
  weldId: string
  payload: Record<string, any>
}

function processBatch(batchId: string, locked: boolean, submissions: MergeSubmissionVar[]): MergeBatchResult {
  state.locked = locked
  const applied: string[] = []
  const conflicts: MergeBatchResult['conflicts'] = []
  const touched = new Set<string>()   // 本批次已被结论性提交占用的焊缝

  for (const sub of submissions) {
    // 幂等：同一请求号只生效一次，重试不重复追加返修次数 / 检测计划
    if (state.appliedRequestIds.has(sub.requestId)) { applied.push(sub.requestId); continue }

    if (sub.kind === 'plan') {
      const plan = sub.payload.plan as InspectionPlan
      if (!state.plans.some((item) => item.id === plan.id)) state.plans = [plan, ...state.plans]
      state.appliedRequestIds.add(sub.requestId)
      applied.push(sub.requestId)
      continue
    }

    const weld = state.welds.find((item) => item.id === sub.weldId)
    if (!weld) {
      conflicts.push({ requestId: sub.requestId, weldId: sub.weldId, kind: sub.kind, incoming: sub.payload, existing: null })
      continue
    }

    const isConclusion = sub.kind === 'repair' || sub.kind === 'status'
    // 已签字锁定，或本批次已有更早的结论性提交：晚到内容按请求号另存冲突
    const isConflict = state.locked || (isConclusion && touched.has(sub.weldId))
    if (isConflict) {
      conflicts.push({ requestId: sub.requestId, weldId: sub.weldId, kind: sub.kind, incoming: sub.payload, existing: clone(weld) })
      continue
    }

    if (sub.kind === 'defect') {
      const defect = sub.payload.defect
      if (!weld.defects.some((item) => item.id === defect.id)) weld.defects.push(defect)
    } else if (sub.kind === 'repair') {
      weld.repairs += 1
      if (sub.payload.status) weld.status = sub.payload.status
    } else if (sub.kind === 'status') {
      weld.status = sub.payload.status
    }
    if (isConclusion) touched.add(sub.weldId)
    state.appliedRequestIds.add(sub.requestId)
    applied.push(sub.requestId)
  }

  return { batchId, applied, conflicts }
}

export const mockWeldLink = new ApolloLink((operation) => new Observable((observer) => {
  setTimeout(() => {
    try {
      if (operation.operationName === 'Welds') {
        observer.next({ data: { welds: clone(state.welds), plans: clone(state.plans) } })
      } else if (operation.operationName === 'MergeBatch') {
        if (state.failNext) {
          state.failNext = false
          observer.error(new Error('回网写入失败：批次未确认，请按原请求号重试'))
          return
        }
        const { batchId, locked, submissions } = operation.variables as {
          batchId: string
          locked: boolean
          submissions: MergeSubmissionVar[]
        }
        observer.next({ data: { mergeBatch: processBatch(batchId, locked, submissions) } })
      } else {
        observer.next({ data: {} })
      }
      observer.complete()
    } catch (error) {
      observer.error(error)
    }
  }, 200)
}))
