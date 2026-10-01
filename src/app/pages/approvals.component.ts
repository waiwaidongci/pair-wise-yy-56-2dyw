import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { Store } from '@ngrx/store'
import { ButtonModule } from 'primeng/button'
import { TimelineModule } from 'primeng/timeline'
import { TagModule } from 'primeng/tag'
import { WeldState } from '../store/weld.reducer'
import { SyncService } from '../sync/sync.service'

@Component({
  selector:'app-approvals', standalone:true, imports:[CommonModule,ButtonModule,TimelineModule,TagModule],
  template:`
    <main class="page"><div class="page-head"><div><p class="eyebrow">签字、版本与追溯</p><h1>逐段确认与锁定</h1><p>审核人按焊缝确认或要求复检；锁定后生成只读版本快照，晚到补录只能另存为冲突，不能覆盖签字结论。</p></div><p-button [label]="state.pendingResign ? '重新签字锁定' : (state.locked ? '已锁定' : '签字锁定检测批次')" icon="pi pi-lock" [disabled]="state.locked && !state.pendingResign" (onClick)="lock()" /></div>
      <p class="banner" *ngIf="state.pendingResign"><i class="pi pi-exclamation-circle"></i>冲突已被采纳为新修订，原签字快照只读保留；请复核后重新签字锁定，在此之前各页面仍显示上一版可用结论。</p>
      <p class="banner mute" *ngIf="openConflicts"><i class="pi pi-shield"></i>有 {{openConflicts}} 条晚到补录已按请求号另存为冲突、等待裁决；焊缝状态、检测计划与审核快照仍保持同一条已签字结论。请到「断网补录」页处理。</p>
      <div class="grid-2"><section class="card"><h2 class="panel-title">待审核焊缝</h2><div class="review" *ngFor="let weld of reviewWelds"><div><b>{{weld.id}} · {{weld.component}}</b><small>{{weld.method}} · {{weld.welder}} · 返修 {{weld.repairs}} 次</small></div><p-tag [value]="weld.status" [severity]="weld.status === '待复检' ? 'warn' : 'danger'" /><p-button label="要求复检" severity="danger" text size="small" [disabled]="sync.isSigned(weld.id)" (onClick)="advance(weld.id,'待复检')" /><p-button label="确认合格" size="small" [disabled]="sync.isSigned(weld.id)" (onClick)="confirm(weld.id)" /></div><p class="muted" *ngIf="!reviewWelds.length">当前没有待审核焊缝。</p><p-button label="导出质量追溯包" icon="pi pi-file-export" severity="secondary" styleClass="w-full" /></section>
      <aside class="card"><h2 class="panel-title">完整审计时间线</h2><p-timeline [value]="state.audit" align="left"><ng-template #content let-event><div class="audit"><div><b>{{event.actor}} · {{event.action}}</b><span>{{event.time}}</span></div><p><strong>{{event.target}}</strong> {{event.detail}}</p></div></ng-template></p-timeline></aside></div>
      <section class="card mt-4"><h2 class="panel-title">版本快照</h2><div class="snapshot"><div><b>v{{state.version}}</b><small>当前工作版本 · {{state.welds.length}} 条焊缝 · {{state.plans.length}} 个检测计划</small></div><p-tag [value]="state.locked ? (state.pendingResign ? '派生修订待重签' : '已签字锁定') : '可编辑'" [severity]="state.locked && !state.pendingResign ? 'success' : 'warn'" /><p-button label="查看差异" text /></div><p>版本快照记录焊缝状态、缺陷、返修方案和签字人。任何后续修改必须从当前版本派生新修订，不覆盖原始检测记录；冲突未裁决前，对外只有同一条可用结论。</p></section>
    </main>
  `,
  styles:[`.review{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:12px 0;border-bottom:1px solid #edf0f5}.review b,.review small{display:block}.review small{color:#7a8798;margin-top:4px}.audit{background:#fff;border:1px solid #e1e7ef;border-radius:6px;padding:10px}.audit>div{display:flex;justify-content:space-between}.audit span{color:#7a8798;font-size:12px}.audit p{margin:5px 0 0;font-size:13px}.snapshot{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:12px;background:#f8fafc;border-radius:6px}.snapshot b,.snapshot small{display:block}.snapshot small{color:#7a8798;margin-top:4px}.banner{display:flex;gap:8px;align-items:center;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:14px}.banner.mute{background:#eff6ff;border-color:#bfdbfe;color:#1e40af}.muted{color:#7a8798;font-size:13px}.mt-4{margin-top:16px}@media(max-width:760px){.review{grid-template-columns:1fr auto}.review .p-button{width:100%}}`],
})
export class ApprovalsComponent {
  private readonly store = inject(Store<{ welds: WeldState }>)
  readonly sync = inject(SyncService)
  state!: WeldState
  constructor() { this.store.select('welds').subscribe((state) => this.state = state) }
  get reviewWelds() { return (this.state?.welds ?? []).filter((item) => ['待复检','返修中','待检测'].includes(item.status)) }
  get openConflicts() { return this.sync.server.conflicts.filter((c) => c.state === '待处理').length }
  confirm(id: string) { if (!this.sync.isSigned(id)) this.sync.advanceStatus(id, '合格', '审核人') }
  advance(id: string, status: '待复检' | '返修中') { if (!this.sync.isSigned(id)) this.sync.advanceStatus(id, status, '审核人') }
  lock() { this.sync.lock() }
}
