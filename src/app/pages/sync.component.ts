import { Component, OnInit, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Store } from '@ngrx/store'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectModule } from 'primeng/select'
import { ToggleButtonModule } from 'primeng/togglebutton'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'
import { SyncService } from '../services/sync.service'
import { WeldGraphqlService } from '../services/weld-graphql.service'
import { setMockWriteFailure } from '../graphql/mock-weld-link'
import type { ConflictRecord, SubmissionKind, Weld } from '../types'

const KIND_LABEL: Record<SubmissionKind, string> = { defect: '缺陷录入', repair: '返修结果', status: '状态流转', plan: '检测计划' }

@Component({
  selector:'app-sync', standalone:true,
  imports:[CommonModule,FormsModule,TableModule,TagModule,ButtonModule,InputTextModule,TextareaModule,SelectModule,ToggleButtonModule],
  template:`
    <main class="page">
      <div class="page-head">
        <div><p class="eyebrow">断网补录 · 回网合并 · 冲突留痕</p><h1>补录批次与冲突处理</h1><p>现场断网时先按请求号存本地，回网后按批次合并焊缝缺陷与返修结果；已签字锁定的结论不得被晚到内容覆盖。</p></div>
        <div class="head-actions">
          <p-toggleButton [(ngModel)]="online" (ngModelChange)="toggleOnline($event)" onLabel="在线 · 回网合并" offLabel="断网 · 仅存本地" onIcon="pi pi-wifi" offIcon="pi pi-ban" />
          <p-toggleButton [(ngModel)]="simulateFail" (ngModelChange)="toggleSimulateFail($event)" onLabel="模拟写入失败：开" offLabel="模拟写入失败：关" onIcon="pi pi-exclamation-triangle" offIcon="pi pi-check" />
          <p-button label="回网合并批次" icon="pi pi-cloud-upload" [disabled]="!state.online || state.syncing || !pendingCount" (onClick)="sync.flush()" />
        </div>
      </div>

      <div class="offline-banner" *ngIf="!state.online"><i class="pi pi-info-circle"></i> 当前处于断网状态：补录内容将先写入本地队列（按请求号留存），回网后按批次合并；期间不会追加返修次数或检测计划。</div>

      <div class="grid-4">
        <article class="card metric"><span>待合并</span><strong>{{count('待合并')}}</strong><small>本地队列，回网后成批合并</small></article>
        <article class="card metric"><span>冲突待处理</span><strong class="warning">{{conflictCount}}</strong><small>晚到内容按请求号另存</small></article>
        <article class="card metric"><span>写入失败</span><strong class="danger">{{count('写入失败')}}</strong><small>按原请求号恢复，不重复追加</small></article>
        <article class="card metric"><span>已合并</span><strong class="success">{{count('已合并')}}</strong><small>本批次 {{state.lastBatchId || '—'}}</small></article>
      </div>

      <div class="grid-2">
        <section class="card">
          <h2 class="panel-title">断网补录（先存本地）</h2>
          <div class="form">
            <label>焊缝</label>
            <p-select [options]="state.welds" optionLabel="id" optionValue="id" [(ngModel)]="form.weldId" placeholder="选择焊缝" />
            <label>补录类型</label>
            <p-select [options]="kindOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.kind" />
            <ng-container [ngSwitch]="form.kind">
              <ng-container *ngSwitchCase="'defect'">
                <div class="row2"><div><label>位置（0–100%）</label><input pInputText type="number" [(ngModel)]="form.position" /></div><div><label>长度 mm</label><input pInputText type="number" [(ngModel)]="form.length" /></div></div>
                <label>缺陷类型</label><input pInputText [(ngModel)]="form.type" placeholder="如：夹渣 / 未熔合" />
                <div class="row2"><div><label>等级</label><p-select [options]="levelOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.level" /></div><div><label>检测方法</label><p-select [options]="methodOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.method" /></div></div>
                <label>报告编号</label><input pInputText [(ngModel)]="form.report" />
              </ng-container>
              <ng-container *ngSwitchCase="'repair'">
                <label>返修后结论</label><p-select [options]="statusOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.status" />
                <label>返修说明</label><textarea pTextarea [(ngModel)]="form.note" rows="3"></textarea>
              </ng-container>
              <ng-container *ngSwitchCase="'status'">
                <label>焊缝状态</label><p-select [options]="statusOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.status" />
              </ng-container>
              <ng-container *ngSwitchCase="'plan'">
                <div class="row2"><div><label>计划日期</label><input type="date" [(ngModel)]="form.planDate" /></div><div><label>检测方法</label><p-select [options]="methodOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.planMethod" /></div></div>
                <label>检测人员</label><p-select [options]="inspectorOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.inspector" />
              </ng-container>
            </ng-container>
            <label>现场检验员</label><p-select [options]="inspectorOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.operator" />
            <p-button label="存入本地（断网补录）" icon="pi pi-save" [disabled]="!form.weldId" (onClick)="enqueue()" />
          </div>
        </section>

        <section class="card">
          <h2 class="panel-title">本地补录队列</h2>
          <p-table [value]="state.submissions" [paginator]="true" [rows]="6" dataKey="requestId">
            <ng-template #header><tr><th>请求号</th><th>批次</th><th>焊缝 / 类型</th><th>状态</th><th></th></tr></ng-template>
            <ng-template #body let-item>
              <tr>
                <td class="req">{{item.requestId}}<small class="block">{{item.operator}} · {{item.createdAt}}</small></td>
                <td>{{item.batchId || '—'}}</td>
                <td>{{item.weldId}}<small class="block">{{kindLabel(item.kind)}}</small></td>
                <td><p-tag [value]="item.status" [severity]="statusSeverity(item.status)" /></td>
                <td><p-button *ngIf="item.status === '写入失败'" label="按原号重试" icon="pi pi-replay" size="small" (onClick)="sync.retry(item.requestId)" /></td>
              </tr>
            </ng-template>
          </p-table>
        </section>
      </div>

      <section class="card mt-4">
        <h2 class="panel-title">冲突处理（晚到内容按请求号另存，不盖已签字结论）</h2>
        <p-table [value]="state.conflicts" [paginator]="true" [rows]="5" dataKey="id">
          <ng-template #header><tr><th>请求号 / 批次</th><th>焊缝</th><th>晚到内容</th><th>当前可用结论（签字 / 快照）</th><th>状态</th><th>处置</th></tr></ng-template>
          <ng-template #body let-item>
            <tr>
              <td class="req">{{item.requestId}}<small class="block">{{item.detectedAt}}</small></td>
              <td>{{item.weldId}}<small class="block">{{kindLabel(item.kind)}} · {{item.operator}}</small></td>
              <td class="incoming">{{summarize(item, 'incoming')}}</td>
              <td class="existing">{{summarize(item, 'existing')}}</td>
              <td><p-tag [value]="item.state" [severity]="item.state === '已采纳' ? 'success' : item.state === '已驳回' ? 'danger' : 'warn'" /></td>
              <td class="actions">
                <p-button *ngIf="item.state === '待处理'" label="采纳为新修订" icon="pi pi-check" size="small" (onClick)="sync.resolve(item.id, true)" />
                <p-button *ngIf="item.state === '待处理'" label="驳回" icon="pi pi-times" size="small" severity="secondary" (onClick)="sync.resolve(item.id, false)" />
              </td>
            </tr>
          </ng-template>
        </p-table>
        <p class="muted-note" *ngIf="!state.conflicts.length">暂无冲突。两人同时提交同一焊缝、或回网时检测批次已被签字锁定，晚到内容会按请求号另存到这里；处理前焊缝状态、检测计划与审核快照始终显示同一条可用结论。</p>
      </section>
    </main>
  `,
  styles:[
    '.head-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.offline-banner{display:flex;gap:8px;align-items:center;background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px}',
    '.form{display:grid;gap:9px}.form label{font-size:12px;color:#667085}.form input,.form select,.form textarea{padding:9px;border:1px solid #cbd5e1;border-radius:6px;width:100%}.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.req{font-family:ui-monospace,monospace;font-size:12px}.block{display:block;color:#7a8798;margin-top:2px;font-size:11px}.incoming{color:#b45309;font-size:12px;max-width:220px}.existing{color:#15803d;font-size:12px;max-width:240px}.actions{white-space:nowrap}.actions .p-button{margin-right:6px}.mt-4{margin-top:16px}.muted-note{color:#7a8798;font-size:12px;margin-top:10px}',
  ],
})
export class SyncComponent implements OnInit {
  readonly store = inject(Store<{ welds: WeldState }>)
  readonly sync = inject(SyncService)
  private readonly api = inject(WeldGraphqlService)
  state!: WeldState
  online = true
  simulateFail = false

  kindOptions = [
    { label:'缺陷录入', value:'defect' },
    { label:'返修结果', value:'repair' },
    { label:'状态流转', value:'status' },
    { label:'检测计划', value:'plan' },
  ]
  levelOptions = ['Ⅰ级','Ⅱ级','Ⅲ级','Ⅳ级'].map((value) => ({ label:value, value }))
  methodOptions = ['UT','MT','PT'].map((value) => ({ label:value, value }))
  statusOptions = ['待检测','合格','返修中','待复检','已关闭'].map((value) => ({ label:value, value }))
  inspectorOptions = ['陈锋','赵岚','孙鹏'].map((value) => ({ label:value, value }))

  form = {
    weldId:'W-107', kind:'defect' as SubmissionKind, position:42, length:12, type:'夹渣', level:'Ⅱ级', method:'UT', report:'UT-2026-0930-02',
    status:'返修中', note:'现场补录返修结果', planDate:'2026-10-02', planMethod:'UT', inspector:'陈锋', operator:'陈锋',
  }

  ngOnInit() {
    this.store.select('welds').subscribe((state) => { this.state = state; this.online = state.online })
    this.sync.hydrate()
    this.api.load().subscribe(({ welds, plans }) => this.store.dispatch(A.loadWeldsSuccess({ welds, plans })))
  }

  get pendingCount() { return this.state?.submissions.filter((item) => item.status === '待合并' || item.status === '写入失败').length ?? 0 }
  get conflictCount() { return this.state?.conflicts.filter((item) => item.state === '待处理').length ?? 0 }
  count(status: string) { return this.state?.submissions.filter((item) => item.status === status).length ?? 0 }
  kindLabel(kind: SubmissionKind) { return KIND_LABEL[kind] }
  statusSeverity(status: string) { return status === '已合并' ? 'success' : status === '写入失败' ? 'danger' : status === '冲突待处理' ? 'warn' : 'info' }

  toggleOnline(value: boolean) { this.store.dispatch(A.setOnline({ online: value })) }
  toggleSimulateFail(value: boolean) { setMockWriteFailure(value) }

  enqueue() {
    const f = this.form
    let payload: Record<string, any> = {}
    if (f.kind === 'defect') {
      payload = { defect: { id: `D-${Date.now().toString().slice(-6)}`, position: Number(f.position), type: f.type, length: Number(f.length), level: f.level, method: f.method, report: f.report } }
    } else if (f.kind === 'repair') {
      payload = { status: f.status, note: f.note }
    } else if (f.kind === 'status') {
      payload = { status: f.status }
    } else if (f.kind === 'plan') {
      payload = { plan: { id: `IP-${Date.now().toString().slice(-6)}`, date: f.planDate, method: f.planMethod, weldIds: [f.weldId], inspector: f.inspector, state: '待执行' } }
    }
    this.sync.enqueue({ kind: f.kind, weldId: f.weldId, payload, operator: f.operator })
  }

  summarize(conflict: ConflictRecord, side: 'incoming' | 'existing'): string {
    const data = side === 'incoming' ? conflict.incoming : conflict.existing
    if (!data || Object.keys(data).length === 0) return side === 'existing' ? '（无）' : '—'
    if (conflict.kind === 'defect') {
      const d = data.defect ?? data
      return side === 'incoming'
        ? `缺陷：${d.type ?? ''} · ${d.level ?? ''} · ${d.length ?? ''}mm`
        : `焊缝 ${(data as Weld).id ?? conflict.weldId}：${(data as Weld).status ?? ''} · 返修 ${(data as Weld).repairs ?? 0} 次 · 缺陷 ${(data as Weld).defects?.length ?? 0} 条`
    }
    if (conflict.kind === 'plan') {
      const p = data.plan ?? data
      return side === 'incoming' ? `计划 ${p.id ?? ''} · ${p.method ?? ''}` : '检测计划已排定'
    }
    return side === 'incoming'
      ? `结论：${data.status ?? ''}${data.note ? ' · ' + data.note : ''}`
      : `焊缝 ${(data as Weld).id ?? conflict.weldId}：${(data as Weld).status ?? ''} · 返修 ${(data as Weld).repairs ?? 0} 次`
  }
}
