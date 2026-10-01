import { inject, Injectable } from '@angular/core'
import { Store } from '@ngrx/store'
import { WeldGraphqlService } from './weld-graphql.service'
import { OfflineQueueService } from './offline-queue.service'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'
import type { ConflictRecord, OfflineSubmission, SubmissionKind } from '../types'

let counter = 0
function requestId(): string {
  counter += 1
  return `req_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2,7)}`
}
function batchId(): string { return `B-${Date.now().toString(36).toUpperCase()}` }
function nowText(): string { return new Date().toLocaleString('zh-CN', { hour12:false }) }

export interface EnqueueInput {
  kind: SubmissionKind
  weldId: string
  payload: Record<string, any>
  operator: string
}

@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly store = inject(Store<{ welds: WeldState }>)
  private readonly api = inject(WeldGraphqlService)
  private readonly queue = inject(OfflineQueueService)
  private state?: WeldState

  constructor() { this.store.select('welds').subscribe((state) => this.state = state) }

  /** 断网补录：先生成请求号存本地，状态为待合并，回网后按批次合并 */
  enqueue(input: EnqueueInput): string {
    const submission: OfflineSubmission = {
      requestId: requestId(),
      batchId: '',
      kind: input.kind,
      weldId: input.weldId,
      payload: input.payload,
      operator: input.operator,
      createdAt: nowText(),
      status: '待合并',
    }
    this.queue.enqueue(submission)
    this.store.dispatch(A.enqueueSubmission({ submission }))
    return submission.requestId
  }

  /** 回网按批次合并：写入失败则整批留在本地并标记，按原请求号恢复 */
  flush(): void {
    const state = this.state
    if (!state || state.syncing || !state.online) return
    const pending = state.submissions.filter((item) => item.status === '待合并' || item.status === '写入失败')
    if (!pending.length) return

    const batch = batchId()
    const withBatch = pending.map((item) => ({ ...item, batchId: batch }))
    this.queue.saveSubmissions([...withBatch, ...state.submissions.filter((item) => item.status !== '待合并' && item.status !== '写入失败')])
    this.store.dispatch(A.flushQueue())

    this.api.mergeBatch(batch, state.locked, withBatch).subscribe({
      next: (result) => {
        this.queue.markApplied(result.applied)
        this.queue.markConflict(result.conflicts.map((item) => item.requestId))
        const conflicts: ConflictRecord[] = result.conflicts.map((item) => ({
          id: `C-${item.requestId}`,
          requestId: item.requestId,
          batchId: batch,
          weldId: item.weldId,
          kind: item.kind,
          incoming: item.incoming,
          existing: item.existing ?? {},
          operator: withBatch.find((sub) => sub.requestId === item.requestId)?.operator ?? '现场检验员',
          detectedAt: nowText(),
          state: '待处理',
        }))
        conflicts.forEach((conflict) => this.queue.upsertConflict(conflict))
        this.store.dispatch(A.flushQueueSuccess({ batchId: batch, applied: result.applied, conflicts }))
      },
      error: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.queue.markFailed(withBatch.map((item) => item.requestId), message)
        this.store.dispatch(A.flushQueueFailure({ error: message, requestIds: withBatch.map((item) => item.requestId) }))
      },
    })
  }

  /** 写入失败后按原请求号恢复：请求号不变，返修次数与检测计划不重复追加 */
  retry(requestIdValue: string): void {
    this.queue.resetToPending(requestIdValue)
    this.store.dispatch(A.retrySubmission({ requestId: requestIdValue }))
    this.flush()
  }

  /** 冲突处理：采纳（派生新修订）或驳回（维持已签字结论），处理前视图始终显示同一条可用结论 */
  resolve(conflictId: string, adopt: boolean): void {
    const conflict = this.state?.conflicts.find((item) => item.id === conflictId)
    this.queue.saveConflictState(conflictId, adopt ? '已采纳' : '已驳回', adopt ? '质量台采纳晚到内容，派生新修订' : '质量台驳回，保留已签字结论')
    if (adopt && conflict) {
      // 采纳 = 质量台明确放行，按新修订直接应用（不重走锁定批次，避免再次被判冲突）
      this.queue.markApplied([conflict.requestId])
    }
    this.store.dispatch(A.resolveConflict({ conflictId, adopt }))
  }

  /** 启动时从本地队列恢复断网补录内容 */
  hydrate(): void {
    this.store.dispatch(A.hydrateQueue({ submissions: this.queue.loadSubmissions(), conflicts: this.queue.loadConflicts() }))
  }
}
