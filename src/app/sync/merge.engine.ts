import type { Defect, InspectionPlan, Weld, WeldStatus } from '../types'
import type {
  AppliedLedgerEntry,
  ConflictRecord,
  ConflictResolution,
  OfflineSubmission,
  ServerState,
  SignedConclusion,
} from './sync.types'

let seq = 0
const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`

/** 合并结果：返回全新的服务端状态，失败请求保留原请求号 */
export interface MergeResult {
  server: ServerState
  applied: OfflineSubmission[]
  conflicts: OfflineSubmission[]
  failed: OfflineSubmission[]
}

/**
 * 回网按批次合并。
 * 不变量：
 *  1. 请求号幂等 —— 同一 requestId 已并入则直接命中台账，焊缝/计划/返修不重复追加；
 *  2. 已签字结论不可覆盖 —— 晚到请求（baseRev 过期或目标焊缝已签字）按请求号另存为冲突；
 *  3. 写入失败可按原请求号恢复 —— 抛错的请求不产生任何部分写入，保留在队列中状态置为“写入失败”；
 *  4. 冲突处理完前，焊缝状态 / 检测计划 / 审核快照对外只显示同一条可用结论（已签字那条）。
 */
export function mergeBatch(server: ServerState, batch: OfflineSubmission[], failing = new Set<string>()): MergeResult {
  let work: ServerState = clone(server)
  const applied: OfflineSubmission[] = []
  const conflicts: OfflineSubmission[] = []
  const failed: OfflineSubmission[] = []

  for (const submission of batch) {
    // 1) 幂等：原请求号重放（含失败恢复后的重试），命中即跳过，绝不重复追加
    if (work.applied.some((entry) => entry.requestId === submission.requestId)) {
      applied.push({ ...submission, status: '已并入' })
      continue
    }

    const weld = work.welds.find((item) => item.id === submission.weldId)
    if (!weld) {
      failed.push({ ...submission, status: '写入失败', error: `焊缝 ${submission.weldId} 不存在` })
      continue
    }

    // 2) 模拟写入失败：不触碰 work 的任何数据，请求按原号留在队列等待恢复
    if (failing.has(submission.requestId)) {
      failed.push({ ...submission, status: '写入失败', error: '网络中断：服务端写入未确认' })
      continue
    }

    const signed = work.signed.find((item) => item.weldId === submission.weldId)
    const stale = (work.weldRevs[submission.weldId] ?? 0) !== submission.baseRev
    // 两人同时提交同一焊缝：已签字锁定，或补录依据的修订号已过期 → 晚到内容另存冲突
    if (signed || stale) {
      const conflict: ConflictRecord = {
        requestId: submission.requestId,
        batchId: submission.batchId,
        time: submission.time,
        inspector: submission.inspector,
        weldId: submission.weldId,
        reason: signed
          ? '该焊缝结论已签字锁定为审核快照，晚到补录不得覆盖'
          : `修订号冲突：补录基于 r${submission.baseRev}，当前为 r${work.weldRevs[submission.weldId]}`,
        serverSnapshot: {
          status: weld.status,
          repairs: weld.repairs,
          version: work.version,
          signed: Boolean(signed),
          defectIds: weld.defects.map((d) => d.id),
        },
        incoming: {
          method: submission.method,
          defect: submission.defect,
          repairCount: submission.repairResult?.repairCount,
          recheckPlan: submission.repairResult?.recheckPlan,
        },
        state: '待处理',
      }
      work = { ...work, conflicts: [...work.conflicts.filter((c) => c.requestId !== conflict.requestId), conflict] }
      conflicts.push({ ...submission, status: '冲突待处理' })
      continue
    }

    // 3) 正常并入：缺陷按请求号派生编号追加；返修次数 +1；复检计划按键去重后追加
    const defect: Defect = { ...submission.defect, id: `D-${submission.requestId}` }
    const nextWeld: Weld = {
      ...weld,
      defects: [...weld.defects, defect],
      repairs: submission.repairResult ? weld.repairs + 1 : weld.repairs,
      status: submission.repairResult ? '待复检' : weld.status,
    }
    let plans = work.plans
    if (submission.repairResult) {
      const plan: InspectionPlan = {
        id: `IP-${submission.requestId}`,
        date: submission.repairResult.recheckPlan.date,
        method: submission.repairResult.recheckPlan.method,
        weldIds: [submission.weldId],
        inspector: submission.inspector,
        state: '待执行',
      }
      const key = planKey(plan)
      // 同批次/重放场景：检测计划不重复追加
      if (!work.planKeys.includes(key)) {
        plans = [plan, ...plans]
        work = { ...work, planKeys: [...work.planKeys, key] }
      }
    }

    const entry: AppliedLedgerEntry = {
      requestId: submission.requestId,
      batchId: submission.batchId,
      appliedAt: now(),
      note: submission.repairResult ? '缺陷 + 返修结果并入，复检计划登记 1 次' : '缺陷记录并入',
    }
    work = {
      ...work,
      welds: work.welds.map((item) => (item.id === nextWeld.id ? nextWeld : item)),
      weldRevs: { ...work.weldRevs, [submission.weldId]: (work.weldRevs[submission.weldId] ?? 0) + 1 },
      plans,
      applied: [...work.applied, entry],
      version: work.version + 1,
      audit: [
        { id: uid('AE'), time: now(), actor: submission.inspector, action: '回网批次并入', target: submission.weldId, detail: `请求 ${submission.requestId}（批次 ${submission.batchId}）${entry.note}` },
        ...work.audit,
      ],
    }
    applied.push({ ...submission, status: '已并入' })
  }

  return { server: work, applied, conflicts, failed }
}

/** 裁决冲突：维持已签字（默认，结论不变）或采纳为新修订（派生新版本，原快照仍只读保留） */
export function resolveConflict(server: ServerState, requestId: string, resolution: ConflictResolution, by: string): ServerState {
  const conflict = server.conflicts.find((item) => item.requestId === requestId)
  if (!conflict || conflict.state !== '待处理') return server
  let work = clone(server)
  const resolvedAt = now()
  work = {
    ...work,
    conflicts: work.conflicts.map((item) => (item.requestId === requestId ? { ...item, state: resolution, resolvedAt, resolvedBy: by } : item)),
  }
  if (resolution === '维持已签字') {
    work = {
      ...work,
      audit: [
        { id: uid('AE'), time: resolvedAt, actor: by, action: '冲突裁决', target: conflict.weldId, detail: `请求 ${requestId} 另存备查，维持已签字结论 r${conflict.serverSnapshot.version}` },
        ...work.audit,
      ],
    }
    return work
  }

  // 采纳为新修订：从已签字版本派生，原签字快照只读保留；返修/计划仍只按该请求号登记一次
  const weld = work.welds.find((item) => item.id === conflict.weldId)!
  const alreadyApplied = work.applied.some((entry) => entry.requestId === requestId)
  let plans = work.plans
  if (!alreadyApplied && conflict.incoming.recheckPlan) {
    const plan: InspectionPlan = {
      id: `IP-${requestId}`,
      date: conflict.incoming.recheckPlan.date,
      method: conflict.incoming.recheckPlan.method,
      weldIds: [conflict.weldId],
      inspector: conflict.inspector,
      state: '待执行',
    }
    if (!work.planKeys.includes(planKey(plan))) {
      plans = [plan, ...plans]
      work = { ...work, planKeys: [...work.planKeys, planKey(plan)] }
    }
  }
  const defect: Defect = { ...conflict.incoming.defect, id: `D-${requestId}` }
  const nextWeld: Weld = {
    ...weld,
    defects: [...weld.defects.filter((d) => d.id !== defect.id), defect],
    repairs: alreadyApplied ? weld.repairs : weld.repairs + (conflict.incoming.repairCount ? 1 : 0),
    status: '待复检',
  }
  work = {
    ...work,
    welds: work.welds.map((item) => (item.id === nextWeld.id ? nextWeld : item)),
    weldRevs: { ...work.weldRevs, [conflict.weldId]: (work.weldRevs[conflict.weldId] ?? 0) + 1 },
    plans,
    applied: alreadyApplied
      ? work.applied
      : [...work.applied, { requestId, batchId: conflict.batchId, appliedAt: resolvedAt, note: '冲突裁决采纳：派生新修订，原签字快照保留' }],
    version: work.version + 1,
    // 派生修订必须重新签字；重新锁定前对外可用结论仍以上一版签字快照为准
    pendingResign: true,
    audit: [
      { id: uid('AE'), time: resolvedAt, actor: by, action: '冲突裁决', target: conflict.weldId, detail: `请求 ${requestId} 采纳为新修订 r${(work.weldRevs[conflict.weldId] ?? 0)}，等待重新签字` },
      ...work.audit,
    ],
  }
  return work
}

/** 质量台签字锁定：为每条焊缝冻结同一条可用结论的审核快照 */
export function lockBaseline(server: ServerState, by: string): ServerState {
  if (server.locked && !server.pendingResign) return server
  const at = now()
  const signed: SignedConclusion[] = server.welds.map((weld) => {
    return {
      weldId: weld.id,
      status: weld.status,
      repairs: weld.repairs,
      defectIds: weld.defects.map((d) => d.id),
      planIds: server.plans.filter((p) => p.weldIds.includes(weld.id)).map((p) => p.id),
      signedBy: by,
      signedAt: at,
      version: server.version,
    } satisfies SignedConclusion
  })
  return {
    ...clone(server),
    signed,
    locked: true,
    lockedBy: by,
    lockedAt: at,
    pendingResign: false,
    snapshots: [{ version: server.version, by, at, note: server.pendingResign ? '冲突采纳后重新签字' : '检测批次签字锁定' }, ...server.snapshots],
    audit: [
      { id: uid('AE'), time: at, actor: by, action: '签字锁定', target: '检测批次', detail: `v${server.version} 审核快照已冻结：焊缝状态、检测计划与返修结论一致` },
      ...server.audit,
    ],
  }
}

/** 质量台排入检测计划（计划键去重，不重复追加）；已锁定批次需在重新签字后才进入可用视图 */
export function schedulePlan(server: ServerState, plan: InspectionPlan, by: string): ServerState {
  const key = planKey(plan)
  if (server.planKeys.includes(key)) return server
  const work: ServerState = {
    ...clone(server),
    plans: [plan, ...server.plans],
    planKeys: [...server.planKeys, key],
    audit: [
      { id: uid('AE'), time: now(), actor: by, action: '排检测计划', target: plan.id, detail: `${plan.date} ${plan.method}，覆盖焊缝 ${plan.weldIds.join('、')}` },
      ...server.audit,
    ],
  }
  return work
}

/** 质量台状态流转：已签字焊缝拒绝直接改写，必须走冲突裁决派生新修订 */
export function advanceStatus(server: ServerState, weldId: string, status: WeldStatus, by: string): ServerState {
  const weld = server.welds.find((item) => item.id === weldId)
  if (!weld) return server
  const signed = server.signed.find((item) => item.weldId === weldId)
  if (signed && !server.pendingResign) return server
  const work: ServerState = {
    ...clone(server),
    welds: server.welds.map((item) => (item.id === weldId ? { ...item, status } : item)),
    weldRevs: { ...server.weldRevs, [weldId]: (server.weldRevs[weldId] ?? 0) + 1 },
    version: server.version + 1,
    pendingResign: server.locked ? true : server.pendingResign,
    audit: [
      { id: uid('AE'), time: now(), actor: by, action: '状态流转', target: weldId, detail: `状态变更为 ${status}${signed ? '（已锁定，派生待签字修订）' : ''}` },
      ...server.audit,
    ],
  }
  return work
}

/** 冲突处理完前的“同一条可用结论”：已签字焊缝对外一律显示快照结论 */
export function effectiveWeld(server: ServerState, weld: Weld): Weld {
  const snap = server.signed.find((item) => item.weldId === weld.id)
  const openConflict = server.conflicts.some((c) => c.weldId === weld.id && c.state === '待处理')
  if (snap && (openConflict || server.pendingResign)) {
    return {
      ...weld,
      status: snap.status,
      repairs: snap.repairs,
      defects: weld.defects.filter((d) => snap.defectIds.includes(d.id)),
    }
  }
  return weld
}

export function effectivePlans(server: ServerState, plans: InspectionPlan[]): InspectionPlan[] {
  // 冲突未决 / 待重新签字期间，隐藏派生修订新增的计划，只呈现签字快照内的计划
  const lockedIds = new Set(server.signed.flatMap((s) => s.planIds))
  const hasOpen = server.conflicts.some((c) => c.state === '待处理') || server.pendingResign
  if (!hasOpen) return plans
  return plans.filter((plan) => lockedIds.has(plan.id))
}

export function effectiveStatusOf(server: ServerState, weldId: string): WeldStatus | undefined {
  const weld = server.welds.find((w) => w.id === weldId)
  return weld ? effectiveWeld(server, weld).status : undefined
}

function planKey(plan: InspectionPlan) {
  return `${plan.date}|${plan.method}|${[...plan.weldIds].sort().join(',')}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
