import { Component, OnInit, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { Store } from '@ngrx/store'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { SelectModule } from 'primeng/select'
import { FormsModule } from '@angular/forms'
import { WeldGraphqlService } from '../services/weld-graphql.service'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'
import type { Weld } from '../types'

@Component({
  selector:'app-overview', standalone:true, imports:[CommonModule,TableModule,TagModule,ButtonModule,SelectModule,FormsModule],
  template:`
    <main class="page"><div class="page-head"><div><p class="eyebrow">焊缝、资质与检测比例</p><h1>焊缝台账总览</h1><p>按构件、图纸和检验节点管理焊缝，优先暴露焊工资质过期、检测比例不足和重复返修。</p></div><p-button label="批量导入焊缝" icon="pi pi-upload" severity="secondary" /></div>
      <div class="grid-4"><article class="card metric"><span>焊缝总数</span><strong>{{state.welds.length}}</strong><small>已建地图定位 5 条</small></article><article class="card metric"><span>待检测 / 返修</span><strong class="warning">{{pending}}</strong><small>2 项计划进行中</small></article><article class="card metric"><span>资质或比例预警</span><strong class="danger">{{warnings}}</strong><small>必须处理后才可锁定</small></article><article class="card metric"><span>版本快照</span><strong>v{{state.version}}</strong><small>{{state.locked ? '已签字锁定' : '可继续修改'}}</small></article></div>
      <div class="grid-2"><section class="card"><div class="toolbar"><p-select [options]="statusOptions" [(ngModel)]="filter" (ngModelChange)="applyFilter($event)" placeholder="筛选状态" styleClass="w-full md:w-40" /><span class="spacer"></span><p-button label="导出焊缝台账" icon="pi pi-file-excel" severity="secondary" /></div><p-table [value]="filtered" [paginator]="true" [rows]="8" selectionMode="single" (onRowSelect)="select($event.data)" dataKey="id"><ng-template #header><tr><th>焊缝 / 构件</th><th>方法与焊工</th><th>检测</th><th>返修</th><th>状态</th></tr></ng-template><ng-template #body let-weld><tr><td><b>{{weld.id}}</b><small class="block">{{weld.drawing}} · {{weld.component}}</small></td><td>{{weld.method}} · {{weld.welder}}<small class="block" [class.danger]="!weld.qualificationValid">{{weld.qualificationValid ? '资质有效' : '资质即将过期'}}</small></td><td><b [class.danger]="weld.inspectionRatio < weld.requiredRatio">{{weld.inspectionRatio}}% / {{weld.requiredRatio}}%</b><small class="block">要求检测比例</small></td><td>{{weld.repairs}} 次<small class="block" *ngIf="weld.repairs >= 2">重复返修关注</small></td><td><p-tag [value]="weld.status" [severity]="weld.status === '合格' || weld.status === '已关闭' ? 'success' : weld.status === '返修中' ? 'danger' : 'warn'" /></td></tr></ng-template></p-table></section>
      <aside class="card"><h2 class="panel-title">规则预警</h2><div class="warning-row"><i class="red"></i><div><b>W-109 焊工资质即将到期</b><p>孙鹏证书 2026-10-01 到期，检测计划未安排替代人员。</p></div></div><div class="warning-row"><i class="amber"></i><div><b>W-109 检测比例不足</b><p>当前计划 10%，图纸及规范要求 20%。</p></div></div><div class="warning-row"><i class="amber"></i><div><b>W-104 同一位置二次返修</b><p>需质量负责人确认返修工艺并提高复检比例。</p></div></div><p-button label="生成处置任务" icon="pi pi-check-square" styleClass="w-full" /></aside></div>
    </main>
  `,
  styles:[`.block{display:block;color:#7a8798;margin-top:3px}.warning-row{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid #edf0f5}.warning-row i{width:6px;border-radius:5px;background:#f59e0b}.warning-row i.red{background:#ef4444}.warning-row div{flex:1}.warning-row p{margin:4px 0 0;font-size:13px}.warning-row .p-button{width:100%}`],
})
export class OverviewComponent implements OnInit {
  private readonly store = inject(Store<{ welds: WeldState }>)
  private readonly api = inject(WeldGraphqlService)
  state!: WeldState
  filter = '全部'
  statusOptions = ['全部','待检测','合格','返修中','待复检','已关闭']
  ngOnInit() {
    this.store.select('welds').subscribe((state) => this.state = state)
    this.api.load().subscribe(({ welds, plans }) => this.store.dispatch(A.loadWeldsSuccess({ welds, plans })))
  }
  get filtered() { return this.filter === '全部' ? this.state?.welds ?? [] : (this.state?.welds ?? []).filter((item) => item.status === this.filter) }
  get pending() { return (this.state?.welds ?? []).filter((item) => ['待检测','返修中','待复检'].includes(item.status)).length }
  get warnings() { return (this.state?.welds ?? []).filter((item) => !item.qualificationValid || item.inspectionRatio < item.requiredRatio || item.repairs >= 2).length }
  applyFilter(status: string) { this.store.dispatch(A.filterStatus({ status })) }
  select(weld: Weld | Weld[] | undefined) { if (weld && !Array.isArray(weld)) this.store.dispatch(A.selectWeld({ id: weld.id })) }
}
