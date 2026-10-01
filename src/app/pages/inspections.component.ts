import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Store } from '@ngrx/store'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { DialogModule } from 'primeng/dialog'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectButtonModule } from 'primeng/selectbutton'
import { WeldState } from '../store/weld.reducer'
import { SyncService } from '../sync/sync.service'

@Component({
  selector:'app-inspections', standalone:true, imports:[CommonModule,FormsModule,TableModule,TagModule,ButtonModule,DialogModule,InputTextModule,TextareaModule,SelectButtonModule],
  template:`
    <main class="page"><div class="page-head"><div><p class="eyebrow">NDT / 返修闭环</p><h1>检测计划与返修</h1><p>现场结果先入断网补录队列，回网按批次幂等合并；已签字结论不可直接改写。</p></div><p-button label="录入检测结果（离线可存）" icon="pi pi-plus" (onClick)="dialog = true" /></div>
      <div class="grid-2"><section class="card"><h2 class="panel-title">批量检测计划</h2><p-table [value]="state.plans" [paginator]="true" [rows]="6"><ng-template #header><tr><th>计划编号</th><th>日期</th><th>方法</th><th>焊缝</th><th>检测人</th><th>状态</th></tr></ng-template><ng-template #body let-plan><tr><td>{{plan.id}}</td><td>{{plan.date}}</td><td>{{plan.method}}</td><td>{{plan.weldIds.length}} 条</td><td>{{plan.inspector}}</td><td><p-tag [value]="plan.state" [severity]="plan.state === '已完成' ? 'success' : plan.state === '执行中' ? 'info' : 'warn'" /></td></tr></ng-template></p-table><p class="guard" *ngIf="state.locked && !state.pendingResign"><i class="pi pi-lock"></i>检测批次已签字锁定，计划与返修结论以审核快照为准；晚到补录请走「断网补录」页的冲突裁决。</p></section>
      <aside class="card"><h2 class="panel-title">返修状态流转</h2><div class="step" *ngFor="let weld of repairWelds"><div><b>{{weld.id}} · {{weld.component}}</b><small>{{weld.defects.length}} 个缺陷 · 已返修 {{weld.repairs}} 次</small></div><p-tag [value]="weld.status" severity="warn" /><p-selectbutton [options]="['返修中','待复检','合格']" [ngModel]="weld.status" [disabled]="sync.isSigned(weld.id)" (ngModelChange)="advance(weld.id,$event)" /></div><p class="muted" *ngIf="!repairWelds.length">暂无返修中的焊缝。</p></aside></div>
      <section class="card mt-4"><h2 class="panel-title">检测结果与缺陷明细</h2><p-table [value]="defects" [paginator]="true" [rows]="8"><ng-template #header><tr><th>缺陷编号</th><th>焊缝</th><th>位置 / 长度</th><th>类型 / 等级</th><th>检测方法</th><th>报告</th><th>处置</th></tr></ng-template><ng-template #body let-item><tr><td>{{item.defect.id}}</td><td>{{item.weld.id}}</td><td>{{item.defect.position}}% · {{item.defect.length}}mm</td><td>{{item.defect.type}} · {{item.defect.level}}</td><td>{{item.defect.method}}</td><td>{{item.defect.report}}</td><td><p-button label="确认合格" size="small" [disabled]="sync.isSigned(item.weld.id)" (onClick)="advance(item.weld.id,'合格')" /></td></tr></ng-template></p-table></section>
      <p-dialog header="录入检测结果（先存本地）" [(visible)]="dialog" [modal]="true" [style]="{width:'620px'}"><div class="form"><label>焊缝编号</label><input pInputText [(ngModel)]="form.weldId" /><label>检测方法</label><select [(ngModel)]="form.method"><option>UT</option><option>MT</option><option>PT</option></select><label>缺陷位置（0–100%）</label><input pInputText type="number" [(ngModel)]="form.position" /><label>缺陷类型与等级</label><input pInputText [(ngModel)]="form.type" placeholder="如：未熔合 / Ⅲ级" /><label>报告编号与说明</label><textarea pTextarea [(ngModel)]="form.report" rows="4"></textarea><p class="offline-hint"><i class="pi pi-save"></i>无论是否联网，请求都会先按请求号存入本地队列；回网后到「断网补录」页按批次合并，写入失败可按原请求号恢复。</p></div><ng-template #footer><p-button label="取消" severity="secondary" (onClick)="dialog=false" /><p-button label="存入本地队列" [disabled]="!form.weldId || !form.report" (onClick)="submit()" /></ng-template></p-dialog>
    </main>
  `,
  styles:[`.step{display:grid;grid-template-columns:1fr auto;gap:9px;padding:12px 0;border-bottom:1px solid #edf0f5}.step>div,.step small{display:block}.step small{color:#7a8798;margin-top:4px}.step p-selectbutton{grid-column:1/-1}.form{display:grid;gap:9px}.form input,.form select,.form textarea{padding:9px;border:1px solid #cbd5e1;border-radius:6px;width:100%}.offline-hint{font-size:12px;color:#7a8798;background:#f8fafc;border-radius:6px;padding:8px 10px;margin:4px 0 0}.guard{font-size:13px;color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:9px 11px;margin-top:12px}.muted{color:#94a3b8;font-size:13px}.mt-4{margin-top:16px}`],
})
export class InspectionsComponent {
  private readonly store = inject(Store<{ welds: WeldState }>)
  readonly sync = inject(SyncService)
  state!: WeldState
  dialog = false
  form = { weldId:'W-109', method:'UT', position:42, type:'未熔合 / Ⅲ级', report:'UT-2026-0929-08；按 NB/T 47013.3 评定。' }
  constructor() { this.store.select('welds').subscribe((state) => this.state = state) }
  get repairWelds() { return (this.state?.welds ?? []).filter((item) => ['返修中','待复检'].includes(item.status)) }
  get defects() { return (this.state?.welds ?? []).flatMap((weld) => weld.defects.map((defect) => ({ weld, defect }))) }
  advance(id: string, status: string) {
    if (this.sync.isSigned(id)) return
    this.sync.advanceStatus(id, status as never, '检测台')
  }
  submit() {
    const [type, level] = this.form.type.split('/').map((s) => s.trim())
    this.sync.enqueue({
      inspector: '现场检验员',
      weldId: this.form.weldId,
      method: this.form.method,
      defect: { position: Number(this.form.position) || 0, type: type || this.form.type, length: 0, level: (level || 'Ⅱ级') as never, method: this.form.method, report: this.form.report },
    })
    this.dialog = false
  }
}
