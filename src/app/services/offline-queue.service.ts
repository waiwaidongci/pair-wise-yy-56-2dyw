import { Injectable } from '@angular/core'
import type { ConflictRecord, OfflineSubmission } from '../types'

// 断网补录：本地队列持久化，回网前不丢失、不重复
@Injectable({ providedIn: 'root' })
export class OfflineQueueService {
  private readonly submissionsKey = 'weld.offline.submissions.v1'
  private readonly conflictsKey = 'weld.offline.conflicts.v1'

  private read<T>(key: string): T[] {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]') as T[] } catch { return [] }
  }
  private write<T>(key: string, value: T[]) { localStorage.setItem(key, JSON.stringify(value)) }

  loadSubmissions(): OfflineSubmission[] { return this.read<OfflineSubmission>(this.submissionsKey) }
  loadConflicts(): ConflictRecord[] { return this.read<ConflictRecord>(this.conflictsKey) }

  saveSubmissions(items: OfflineSubmission[]) { this.write(this.submissionsKey, items) }
  saveConflicts(items: ConflictRecord[]) { this.write(this.conflictsKey, items) }

  enqueue(submission: OfflineSubmission) {
    const all = this.loadSubmissions()
    if (!all.some((item) => item.requestId === submission.requestId)) {
      all.push(submission)
      this.saveSubmissions(all)
    }
  }

  private patch(requestId: string, changes: Partial<OfflineSubmission>) {
    const all = this.loadSubmissions()
    const index = all.findIndex((item) => item.requestId === requestId)
    if (index >= 0) {
      all[index] = { ...all[index], ...changes }
      this.saveSubmissions(all)
    }
  }

  markApplied(requestIds: string[]) {
    requestIds.forEach((requestId) => this.patch(requestId, { status: '已合并', error: undefined }))
  }
  markConflict(requestIds: string[]) {
    requestIds.forEach((requestId) => this.patch(requestId, { status: '冲突待处理' }))
  }
  markFailed(requestIds: string[], error: string) {
    requestIds.forEach((requestId) => this.patch(requestId, { status: '写入失败', error }))
  }
  resetToPending(requestId: string) {
    this.patch(requestId, { status: '待合并', error: undefined })
  }

  upsertConflict(record: ConflictRecord) {
    const all = this.loadConflicts()
    const index = all.findIndex((item) => item.requestId === record.requestId)
    if (index >= 0) all[index] = record
    else all.unshift(record)
    this.saveConflicts(all)
  }
  saveConflictState(conflictId: string, state: ConflictRecord['state'], resolution: string) {
    const all = this.loadConflicts()
    const index = all.findIndex((item) => item.id === conflictId)
    if (index >= 0) {
      all[index] = { ...all[index], state, resolution }
      this.saveConflicts(all)
    }
  }
}
