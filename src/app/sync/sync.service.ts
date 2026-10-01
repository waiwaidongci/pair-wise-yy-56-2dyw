import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import { Store } from '@ngrx/store'
import type { InspectionPlan, WeldStatus } from '../types'
import * as A from '../store/weld.actions'
import { WeldState } from '../store/weld.reducer'
import {
  advanceStatus,
  effectivePlans,
  effectiveWeld,
  lockBaseline,
  mergeBatch,
  resolveConflict,
  schedulePlan,
} from './merge.engine'
import { mockPlans, mockWelds } from './mock-data'
import type {
  ConflictResolution,
  OfflineSubmission,
  ServerState,
  SubmissionStatus,
} from './sync.types'

const STORAGE_KEY = 'weld-offline-outbox-v1'
const SERVER_KEY = 'weld-offline-server-v1'

let reqSeq = 0
const requestNo = () => `REQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(++reqSeq).padStart(3, '0')}`
const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false })

/**
 * 断网补录 + 回网批次合并的唯一入口。
 * 现场检验员断网时请求先进本地队列（localStorage 持久化，刷新不丢）；
 * 回网后按批次合并到模拟服务端，全部语义在 merge.engine 中保证。
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  /** 网络开关，断网时提交只存本地 */
  readonly online$ = new BehaviorSubject<boolean>(navigator.onLine ?? true)
  readonly syncing$ = new BehaviorSubject<boolean>(false)
  /** 下一次合并时强制写入失败的请求号（演练“写入失败后按原请求号恢复”） */
  readonly failNext$ = new BehaviorSubject<Set<string>>(new Set())

  private readonly serverSubject$ = new BehaviorSubject<ServerState>(this.restoreServer())
  private readonly outboxSubject$ = new BehaviorSubject<OfflineSubmission[]>(this.restoreOutbox())
  readonly server$ = this.serverSubject$.asObservable()
  readonly outbox$ = this.outboxSubject$.asObservable()

  constructor(private readonly store: Store<{ welds: WeldState }>) {
    // 服务端每次变更，都把“可用结论”视图回灌给台账 / 地图 / 检测 / 审核页
    this.serverSubject$.subscribe((server) => {
      this.store.dispatch(A.syncStateChanged({
        welds: server.welds.map((weld) => effectiveWeld(server, weld)),
        plans: effectivePlans(server, server.plans),
        locked: server.locked,
        version: server.version,
        audit: server.audit,
        pendingResign: server.pendingResign,
      }))
    })
  }

  get server(): ServerState { return this.serverSubject$.value }
  get outbox(): OfflineSubmission[] { return this.outboxSubject$.value }
  get batchId(): string { return this.currentBatchId() }

  schedulePlan(plan: InspectionPlan, by = '质量台') {
    this.serverSubject$.next(schedulePlan(this.server, plan, by))
    this.persistServer(this.serverSubject$.value)
  }

  advanceStatus(weldId: string, status: WeldStatus, by = '当前审核人') {
    this.serverSubject$.next(advanceStatus(this.server, weldId, status, by))
    this.persistServer(this.serverSubject$.value)
  }

  isSigned(weldId: string): boolean {
    return this.server.signed.some((s) => s.weldId === weldId) && !this.server.pendingResign
  }

  /** 断网补录：生成请求号、冻结所依据修订号，先存本地 */
  enqueue(input: Omit<OfflineSubmission, 'requestId' | 'batchId' | 'time' | 'baseRev' | 'status'> & { requestId?: string }): OfflineSubmission {
    const existing = input.requestId ? this.outbox.find((item) => item.requestId === input.requestId) : undefined
    const submission: OfflineSubmission = existing
      ? existing
      : {
          ...input,
          requestId: input.requestId ?? requestNo(),
          batchId: this.currentBatchId(),
          time: stamp(),
          baseRev: this.server.weldRevs[input.weldId] ?? 0,
          status: '待同步',
        }
    if (!existing) this.patchOutbox([...this.outbox, submission])
    return submission
  }

  /** 回网：按批次把本地待同步/写入失败的请求合并到服务端 */
  async syncNow(batchId = this.currentBatchId()): Promise<{ merged: number; conflicts: number; failed: number }> {
    if (!this.online$.value || this.syncing$.value) return { merged: 0, conflicts: 0, failed: 0 }
    const pending = this.outbox.filter((item) => ['待同步', '写入失败'].includes(item.status) && item.batchId === batchId)
    if (!pending.length) return { merged: 0, conflicts: 0, failed: 0 }

    this.syncing$.next(true)
    this.patchOutbox(this.outbox.map((item) => pending.some((p) => p.requestId === item.requestId) ? { ...item, status: '同步中' as SubmissionStatus } : item))
    await this.delay(650)

    const result = mergeBatch(this.server, pending, this.failNext$.value)
    this.failNext$.next(new Set())
    this.serverSubject$.next(result.server)
    this.persistServer(result.server)

    const lookup = new Map<string, OfflineSubmission>()
    for (const s of [...result.applied, ...result.conflicts, ...result.failed]) lookup.set(s.requestId, s)
    this.patchOutbox(this.outbox.map((item) => {
      const fresh = lookup.get(item.requestId)
      if (!fresh) return item
      // 冲突已另存：队列里也标记为“已另存”，原始补录内容随冲突台账保留
      const status: SubmissionStatus = fresh.status === '冲突待处理' ? '已另存' : fresh.status
      return { ...item, status, error: fresh.error }
    }))

    this.syncing$.next(false)
    return {
      merged: result.applied.length,
      conflicts: result.conflicts.length,
      failed: result.failed.length,
    }
  }

  resolve(requestId: string, resolution: ConflictResolution, by = '质量负责人') {
    this.serverSubject$.next(resolveConflict(this.server, requestId, resolution, by))
    this.persistServer(this.serverSubject$.value)
  }

  lock(by = '质量负责人') {
    this.serverSubject$.next(lockBaseline(this.server, by))
    this.persistServer(this.serverSubject$.value)
  }

  setOnline(online: boolean) { this.online$.next(online) }
  failNext(requestIds: string[]) { this.failNext$.next(new Set(requestIds)) }

  /** 冲突处理完前的一致视图：焊缝状态 / 计划 / 快照同一条可用结论 */
  effectiveWelds(): ServerState['welds'] {
    return this.server.welds.map((weld) => effectiveWeld(this.server, weld))
  }
  effectivePlans() { return effectivePlans(this.server, this.server.plans) }

  resetDemo() {
    reqSeq = 0
    const fresh = seedServer()
    this.serverSubject$.next(fresh)
    this.patchOutbox([])
  }

  private currentBatchId() { return `B-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}` }
  private delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)) }

  private patchOutbox(outbox: OfflineSubmission[]) {
    this.outboxSubject$.next(outbox)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(outbox))
  }
  private persistServer(server: ServerState) { localStorage.setItem(SERVER_KEY, JSON.stringify(server)) }
  private restoreOutbox(): OfflineSubmission[] {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as OfflineSubmission[] } catch { return [] }
  }
  private restoreServer(): ServerState {
    try {
      const saved = localStorage.getItem(SERVER_KEY)
      if (saved) return JSON.parse(saved) as ServerState
    } catch { /* fall through */ }
    return seedServer()
  }
}

function seedServer(): ServerState {
  const weldRevs: Record<string, number> = {}
  for (const weld of mockWelds) weldRevs[weld.id] = 0
  return {
    welds: structuredClone(mockWelds),
    plans: structuredClone(mockPlans),
    audit: [
      { id: 'AE-3', time: '14:20', actor: '系统', action: '资质预警', target: 'W-109', detail: '焊工证书 2026-10-01 到期，不得列入后续检测计划' },
      { id: 'AE-2', time: '15:12', actor: '陈锋', action: '录入缺陷', target: 'W-107', detail: '翼缘板端部夹渣，长度 12mm，Ⅱ级' },
      { id: 'AE-1', time: '16:38', actor: '赵岚', action: '提交复检', target: 'W-104', detail: '返修后 UT 复检合格，等待审核签字' },
    ],
    weldRevs,
    planKeys: mockPlans.map((p) => `${p.date}|${p.method}|${[...p.weldIds].sort().join(',')}`),
    applied: [],
    conflicts: [],
    signed: [],
    locked: false,
    version: 12,
    snapshots: [],
    pendingResign: false,
  }
}
