import { createAction, props } from '@ngrx/store'
import type { AuditEvent, InspectionPlan, Weld, WeldStatus } from '../types'

export const loadWelds = createAction('[Weld] Load')
export const loadWeldsSuccess = createAction('[Weld API] Load Success', props<{ welds: Weld[]; plans: InspectionPlan[] }>())
/** 模拟服务端（合并 / 冲突裁决 / 签字锁定）变更后，统一回灌只读视图 */
export const syncStateChanged = createAction(
  '[Sync] State Changed',
  props<{ welds: Weld[]; plans: InspectionPlan[]; locked: boolean; version: number; audit: AuditEvent[]; pendingResign: boolean }>(),
)
export const selectWeld = createAction('[Weld] Select', props<{ id: string }>())
export const filterStatus = createAction('[Weld] Filter Status', props<{ status: string }>())
export const advanceWeld = createAction('[Weld] Advance', props<{ id: string; status: WeldStatus }>())
export const createPlan = createAction('[Inspection] Create Plan', props<{ plan: InspectionPlan }>())
export const lockBaseline = createAction('[Approval] Lock Baseline')
