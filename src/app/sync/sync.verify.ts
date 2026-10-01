import { strict as assert } from 'node:assert'
import { effectivePlans, effectiveWeld, lockBaseline, mergeBatch, resolveConflict, schedulePlan } from './merge.engine'
import type { OfflineSubmission, ServerState } from './sync.types'
import { mockPlans, mockWelds } from './mock-data'

let passed = 0
const check = (name: string, fn: () => void) => { fn(); passed++; console.log('  ✓', name) }

function seed(): ServerState {
  const weldRevs: Record<string, number> = {}
  for (const w of mockWelds) weldRevs[w.id] = 0
  return {
    welds: structuredClone(mockWelds), plans: structuredClone(mockPlans), audit: [],
    weldRevs, planKeys: mockPlans.map((p) => `${p.date}|${p.method}|${[...p.weldIds].sort().join(',')}`),
    applied: [], conflicts: [], signed: [], locked: false, version: 12, snapshots: [], pendingResign: false,
  }
}

const req = (over: Partial<OfflineSubmission> & Pick<OfflineSubmission, 'requestId' | 'weldId'>): OfflineSubmission => ({
  batchId: 'B-20261001', time: '10:00', inspector: '周敏', method: 'UT', baseRev: 0, status: '待同步',
  defect: { position: 50, type: '气孔', length: 8, level: 'Ⅱ级', method: 'UT', report: 'R-1' },
  repairResult: { repairCount: 1, recheckPlan: { date: '2026-10-03', method: 'UT' } },
  ...over,
})

console.log('1) 正常合并：缺陷追加、返修 +1、复检计划登记一次、版本推进')
check('weld updated exactly once', () => {
  const r = mergeBatch(seed(), [req({ requestId: 'REQ-A', weldId: 'W-107', baseRev: 0 })])
  const w = r.server.welds.find((x) => x.id === 'W-107')!
  assert.equal(w.repairs, 2)
  assert.equal(w.defects.length, 2)
  assert.equal(w.status, '待复检')
  assert.equal(r.server.plans.filter((p) => p.weldIds.includes('W-107')).length, 1)
  assert.equal(r.server.applied.length, 1)
  assert.equal(r.applied[0].status, '已并入')
})

console.log('2) 写入失败：原请求号保留、服务端零部分写入')
check('failed request leaves server untouched and stays in queue', () => {
  const s0 = seed()
  const r = mergeBatch(s0, [
    req({ requestId: 'REQ-F1', weldId: 'W-107' }),
    req({ requestId: 'REQ-OK', weldId: 'W-109', repairResult: undefined }),
  ], new Set(['REQ-F1']))
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].requestId, 'REQ-F1')
  assert.equal(r.failed[0].status, '写入失败')
  const w107 = r.server.welds.find((x) => x.id === 'W-107')!
  assert.equal(w107.repairs, 1, 'W-107 不应累加返修')
  assert.equal(w107.defects.length, 1, 'W-107 不应追加缺陷')
  assert.equal(r.server.plans.some((p) => p.id === 'IP-REQ-F1'), false, '失败请求不应登记计划')
  assert.equal(r.server.applied.length, 1)
  assert.equal(r.applied[0].requestId, 'REQ-OK')
})

console.log('3) 失败后按原请求号恢复 + 重放幂等：返修与计划绝不重复追加')
check('retry with same request id is idempotent; replay adds nothing', () => {
  let s = seed()
  let r = mergeBatch(s, [req({ requestId: 'REQ-A', weldId: 'W-107' })], new Set(['REQ-A']))
  assert.equal(r.failed.length, 1)
  s = r.server
  // 恢复：同请求号再次提交
  r = mergeBatch(s, [req({ requestId: 'REQ-A', weldId: 'W-107' })])
  s = r.server
  const w = s.welds.find((x) => x.id === 'W-107')!
  assert.equal(w.repairs, 2, '返修只 +1')
  assert.equal(w.defects.length, 2, '缺陷只 1 条新增')
  assert.equal(s.plans.filter((p) => p.weldIds.includes('W-107')).length, 1, '复检计划只 1 个')
  // 再重放（网络重发/双击）仍幂等
  r = mergeBatch(s, [req({ requestId: 'REQ-A', weldId: 'W-107' }), req({ requestId: 'REQ-A', weldId: 'W-107' })])
  const w2 = r.server.welds.find((x) => x.id === 'W-107')!
  assert.equal(w2.repairs, 2)
  assert.equal(w2.defects.length, 2)
  assert.equal(r.server.applied.length, 1)
  assert.equal(r.applied.filter((x) => x.requestId === 'REQ-A').length, 2, '重放均标记已并入但不写数据')
})

console.log('4) 已签字锁定后晚到补录：按请求号另存冲突，不覆盖签字结论')
check('late submission against signed weld becomes conflict', () => {
  let s = seed()
  // 质量台先排计划并签字
  s = schedulePlan(s, { id: 'IP-Q', date: '2026-10-01', method: 'UT', weldIds: ['W-104'], inspector: '质量台', state: '待执行' }, '质量台')
  s = lockBaseline(s, '质量负责人')
  const signedStatus = s.welds.find((x) => x.id === 'W-104')!.status
  const r = mergeBatch(s, [req({ requestId: 'REQ-LATE', weldId: 'W-104' })])
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].requestId, 'REQ-LATE')
  const c = r.server.conflicts[0]
  assert.equal(c.state, '待处理')
  assert.equal(c.serverSnapshot.signed, true)
  const w = r.server.welds.find((x) => x.id === 'W-104')!
  assert.equal(w.repairs, 2, '签字结论的返修次数不变')
  assert.equal(w.defects.length, 1, '签字结论的缺陷列表不变')
  // 一致视图：冲突未决期间 effectiveWeld 显示快照
  assert.equal(effectiveWeld(r.server, w).status, signedStatus)
  const snapPlanIds = new Set(r.server.signed.flatMap((x) => x.planIds))
  for (const p of effectivePlans(r.server, r.server.plans)) assert.ok(snapPlanIds.has(p.id), '只显示快照内计划')
  assert.equal(r.server.applied.some((a) => a.requestId === 'REQ-LATE'), false)
})

console.log('5) baseRev 过期（两人同时提交同一焊缝，先到已并入）：晚到另存冲突')
check('stale base revision triggers conflict without overwrite', () => {
  let s = seed()
  const first = req({ requestId: 'REQ-1ST', weldId: 'W-107', baseRev: 0 })
  let r = mergeBatch(s, [first])
  s = r.server
  const second = req({ requestId: 'REQ-2ND', weldId: 'W-107', baseRev: 0, inspector: '陈锋' }) // baseRev 已过期（当前 r1）
  r = mergeBatch(s, [second])
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].requestId, 'REQ-2ND')
  const w = r.server.welds.find((x) => x.id === 'W-107')!
  assert.equal(w.repairs, 2, '先到者结论保留，晚到返修不累加')
  assert.equal(w.defects.length, 2, '晚到缺陷不追加')
})

console.log('6) 冲突裁决 - 维持已签字：结论不变；采纳为新修订：派生修订且原快照保留、需重签')
check('maintain keeps signed; adopt derives new revision and hides new plan until resign', () => {
  let s = lockBaseline(schedulePlan(seed(), { id: 'IP-Q', date: '2026-10-01', method: 'UT', weldIds: ['W-104'], inspector: '质量台', state: '待执行' }, '质量台'), '质量负责人')
  let r = mergeBatch(s, [req({ requestId: 'REQ-LATE', weldId: 'W-104' })])
  s = r.server
  const signedV = s.signed.find((x) => x.weldId === 'W-104')!

  const kept = resolveConflict(s, 'REQ-LATE', '维持已签字', '质量负责人')
  assert.equal(kept.conflicts[0].state, '维持已签字')
  assert.equal(kept.welds.find((x) => x.id === 'W-104')!.repairs, 2)
  assert.equal(kept.pendingResign, false)

  const adopted = resolveConflict(s, 'REQ-LATE', '采纳为新修订', '质量负责人')
  assert.equal(adopted.pendingResign, true, '采纳后必须重新签字')
  assert.equal(adopted.signed.find((x) => x.weldId === 'W-104')!.version, signedV.version, '原签字快照只读保留')
  const w104 = adopted.welds.find((x) => x.id === 'W-104')!
  // 重签前一致视图仍显示上一版结论
  assert.equal(effectiveWeld(adopted, w104).repairs, signedV.repairs)
  assert.equal(effectivePlans(adopted, adopted.plans).some((p) => p.id === 'IP-REQ-LATE'), false, '新计划重签前不可见')
  // 重新签字后切换到新结论，且只追加一次
  const resigned = lockBaseline(adopted, '质量负责人')
  const wv = resigned.welds.find((x) => x.id === 'W-104')!
  assert.equal(wv.repairs, 3)
  assert.equal(effectivePlans(resigned, resigned.plans).some((p) => p.id === 'IP-REQ-LATE'), true, '重签后新计划可见')
  // 再次合并同一请求号仍然幂等
  const again = mergeBatch(resigned, [req({ requestId: 'REQ-LATE', weldId: 'W-104' })])
  assert.equal(again.server.welds.find((x) => x.id === 'W-104')!.repairs, 3)
  assert.equal(again.conflicts.length, 0)
})

console.log(`\n全部 ${passed} 组不变量断言通过 ✅`)
