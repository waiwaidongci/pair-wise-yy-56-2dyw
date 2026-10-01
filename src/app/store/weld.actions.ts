import { createAction, props } from '@ngrx/store'
import type { ConflictRecord, InspectionPlan, OfflineSubmission, Weld, WeldStatus } from '../types'

export const loadWelds = createAction('[Weld] Load')
export const loadWeldsSuccess = createAction('[Weld API] Load Success', props<{ welds: Weld[]; plans: InspectionPlan[] }>())
export const selectWeld = createAction('[Weld] Select', props<{ id: string }>())
export const filterStatus = createAction('[Weld] Filter Status', props<{ status: string }>())
export const advanceWeld = createAction('[Weld] Advance', props<{ id: string; status: WeldStatus }>())
export const createPlan = createAction('[Inspection] Create Plan', props<{ plan: InspectionPlan }>())
export const lockBaseline = createAction('[Approval] Lock Baseline')

// 断网补录 / 回网合并 / 冲突与重试
export const hydrateQueue = createAction('[Sync] Hydrate Queue', props<{ submissions: OfflineSubmission[]; conflicts: ConflictRecord[] }>())
export const setOnline = createAction('[Sync] Set Online', props<{ online: boolean }>())
export const enqueueSubmission = createAction('[Sync] Enqueue Submission', props<{ submission: OfflineSubmission }>())
export const flushQueue = createAction('[Sync] Flush Queue')
export const flushQueueSuccess = createAction('[Sync] Flush Success', props<{ batchId: string; applied: string[]; conflicts: ConflictRecord[] }>())
export const flushQueueFailure = createAction('[Sync] Flush Failure', props<{ error: string; requestIds: string[] }>())
export const retrySubmission = createAction('[Sync] Retry Submission', props<{ requestId: string }>())
export const resolveConflict = createAction('[Sync] Resolve Conflict', props<{ conflictId: string; adopt: boolean }>())
