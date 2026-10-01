import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ButtonModule } from 'primeng/button'
import { TagModule } from 'primeng/tag'
import { TableModule } from 'primeng/table'
import { SelectModule } from 'primeng/select'
import { CheckboxModule } from 'primeng/checkbox'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SyncService } from '../sync/sync.service'
import type { ConflictRecord, OfflineSubmission, ServerState, SubmissionStatus } from '../sync/sync.types'

const STATUS_TAG: Record<SubmissionStatus, { label: string; severity: 'success' | 'warn' | 'danger' | 'info' | 'secondary' }> = {
  '待同步': { label: '待同步 · 本地', severity: 'warn' },
  '同步中': { label: '同步中', severity: 'info' },
  '已并入': { label: '已并入', severity: 'success' },
  '冲突待处理': { label: '冲突待处理', severity: 'danger' },
  '已另存': { label: '已另存冲突', severity: 'danger' },
  '写入失败': { label: '写入失败 · 待恢复', severity: 'danger' },
}

@Component({
  selector: 'app-sync',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, TableModule, SelectModule, CheckboxModule, InputTextModule, TextareaModule],
  template: `
    <main class="page">
      <div class="page-head">
        <div>
          <p class="eyebrow">断网补录 / 回网批次合并 / 冲突另存</p>
          <h1>现场补录与签字保护</h1>
          <p>断网时缺陷与返修结果先存本地队列，回网按请求号幂等合并；已签字结论不可覆盖，晚到内容按请求号另存冲突。</p>
        </div>
        <p-button label="重置演练数据" icon="pi pi-refresh" severity="secondary" (onClick)="reset()" />
      </div>

      <!-- 网络与批次状态条 -->
      <section class="card conn">
        <div class="conn-state">
          <i [class.on]="online" [class.off]="!online"></i>
          <div>
            <b>{{ online ? '已回网' : '现场断网中' }}</b>
            <small>当前批次 {{ batchId }} · 服务版本 v{{ server.version }} · {{ server.welds.length }} 条焊缝</small>
          </div>
        </div>
        <p-tag [value]="server.locked ? (server.pendingResign ? '已派生新修订 · 待重新签字' : '审核快照已签字锁定') : '尚未签字锁定'" [severity]="server.locked ? (server.pendingResign ? 'warn' : 'success') : 'warn'" />
        <span class="spacer"></span>
        <p-button [label]="online ? '模拟断网' : '模拟回网'" [icon]="online ? 'pi pi-wifi-off' : 'pi pi-wifi'" severity="secondary" (onClick)="toggleNetwork()" />
        <p-button label="回网并合并批次" icon="pi pi-cloud-upload" [loading]="syncing" [disabled]="!online" (onClick)="doSync()" />
        <p-button [label]="server.pendingResign ? '重新签字锁定' : '质量台签字锁定'" icon="pi pi-lock" [disabled]="server.locked && !server.pendingResign" (onClick)="lock()" />
      </section>

      <div class="tip" *ngIf="!hasOpenConflict; else protectTip">
        <i class="pi pi-info-circle"></i><span>提示：先「一键演练」观察 失败按原号恢复 → 幂等合并 → 签字锁定 → 晚到另存冲突 的完整链路；冲突裁决前，所有页面只显示同一条可用结论。</span>
        <p-button label="一键演练完整链路" icon="pi pi-play" size="small" (onClick)="runScenario()" />
      </div>
      <ng-template #protectTip>
        <div class="tip alert">
          <i class="pi pi-shield"></i>
          <span>存在未裁决冲突 / 待重新签字修订：焊缝状态、检测计划与审核快照仍统一显示<strong>已签字那条可用结论</strong>，晚到内容不会盖掉它。</span>
        </div>
      </ng-template>

      <div class="grid-2">
        <!-- 本地补录 -->
        <section class="card">
          <h2 class="panel-title">断网补录（先存本地）</h2>
          <div class="form">
            <div class="row">
              <label>焊缝</label>
              <p-select [options]="weldOptions" optionLabel="id" optionValue="id" [(ngModel)]="form.weldId" styleClass="w-full" />
            </div>
            <div class="row two">
              <div><label>检验员</label><input pInputText [(ngModel)]="form.inspector" /></div>
              <div><label>检测方法</label>
                <select class="native" [(ngModel)]="form.method"><option>UT</option><option>MT</option><option>PT</option></select>
              </div>
            </div>
            <div class="row two">
              <div><label>缺陷位置（%）</label><input pInputText type="number" [(ngModel)]="form.position" /></div>
              <div><label>长度（mm）</label><input pInputText type="number" [(ngModel)]="form.length" /></div>
            </div>
            <div class="row two">
              <div><label>缺陷类型</label><input pInputText [(ngModel)]="form.type" placeholder="如：气孔" /></div>
              <div><label>等级</label>
                <select class="native" [(ngModel)]="form.level"><option>Ⅰ级</option><option>Ⅱ级</option><option>Ⅲ级</option><option>Ⅳ级</option></select>
              </div>
            </div>
            <div class="row"><label>报告编号 / 说明</label><textarea pTextarea rows="2" [(ngModel)]="form.report"></textarea></div>
            <label class="check"><p-checkbox [(ngModel)]="form.hasRepair" [binary]="true" /><span>同时补录返修结果（返修次数 +1，并登记复检计划）</span></label>
            <div class="row two" *ngIf="form.hasRepair">
              <div><label>本次返修</label>
                <select class="native" [(ngModel)]="form.repairCount"><option [ngValue]="1">第 1 次返修</option><option [ngValue]="2">第 2 次返修</option></select>
              </div>
              <div><label>复检日期</label><input pInputText type="date" [(ngModel)]="form.recheckDate" /></div>
            </div>
            <p-button label="存入本地队列" icon="pi pi-save" [disabled]="!form.report" (onClick)="enqueue()" />
          </div>
        </section>

        <!-- 本地队列 -->
        <section class="card">
          <h2 class="panel-title">本地补录队列 <small class="hint">按批次合并 · 原请求号贯穿始终</small></h2>
          <p-table [value]="outbox" [paginator]="true" [rows]="6">
            <ng-template #header><tr><th>请求号</th><th>焊缝</th><th>内容</th><th>状态</th></tr></ng-template>
            <ng-template #body let-item>
              <tr>
                <td><b>{{item.requestId}}</b><small class="block">{{item.time}}</small></td>
                <td>{{item.weldId}}<small class="block">{{item.inspector}}</small></td>
                <td>{{item.method}} · {{item.defect.type}}<small class="block" *ngIf="item.repairResult">含返修结果</small><small class="block danger" *ngIf="item.error">{{item.error}}</small></td>
                <td><p-tag [value]="tagOf(item.status).label" [severity]="tagOf(item.status).severity" /></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="4" class="empty">本地队列为空——断网时录入的缺陷与返修结果会先保存在这里（刷新不丢）。</td></tr></ng-template>
          </p-table>
        </section>
      </div>

      <!-- 冲突台账 -->
      <section class="card mt-4" *ngIf="server.conflicts.length">
        <h2 class="panel-title">冲突台账 <small class="hint">晚到内容按请求号另存，不覆盖已签字结论</small></h2>
        <div class="conflict" *ngFor="let c of server.conflicts">
          <div class="conflict-head">
            <div>
              <b>{{c.requestId}} · 焊缝 {{c.weldId}}</b>
              <small>{{c.inspector}} 于 {{c.time}} 提交（批次 {{c.batchId}}）</small>
            </div>
            <p-tag [value]="c.state === '待处理' ? '待质量台裁决' : (c.state === '维持已签字' ? '已维持签字结论' : '已采纳为新修订')" [severity]="c.state === '待处理' ? 'danger' : 'success'" />
          </div>
          <p class="reason"><i class="pi pi-exclamation-triangle"></i>{{c.reason}}</p>
          <div class="snap-grid">
            <div class="snap signed">
              <h4>已签字可用结论（对外显示）</h4>
              <ul>
                <li>状态：<b>{{c.serverSnapshot.status}}</b> · 返修 {{c.serverSnapshot.repairs}} 次</li>
                <li>缺陷：{{c.serverSnapshot.defectIds.length ? c.serverSnapshot.defectIds.join('、') : '无'}}</li>
                <li>版本：v{{c.serverSnapshot.version}} · {{c.serverSnapshot.signed ? '已签字锁定' : '服务端已更新'}}</li>
              </ul>
            </div>
            <div class="snap incoming">
              <h4>晚到补录（按请求号另存）</h4>
              <ul>
                <li>{{c.incoming.method}} · {{c.incoming.defect.type}} · {{c.incoming.defect.level}} · {{c.incoming.defect.length}}mm</li>
                <li>位置 {{c.incoming.defect.position}}% · {{c.incoming.defect.report}}</li>
                <li *ngIf="c.incoming.repairCount">返修 {{c.incoming.repairCount}} 次 · 复检 {{c.incoming.recheckPlan?.date}} {{c.incoming.recheckPlan?.method}}</li>
              </ul>
            </div>
          </div>
          <div class="conflict-actions" *ngIf="c.state === '待处理'">
            <p-button label="维持已签字结论（晚到内容留档）" icon="pi pi-check" severity="secondary" (onClick)="resolve(c.requestId,'维持已签字')" />
            <p-button label="采纳为新修订（原快照只读保留，须重新签字）" icon="pi pi-file-edit" severity="warn" (onClick)="resolve(c.requestId,'采纳为新修订')" />
          </div>
          <p class="resolved" *ngIf="c.state !== '待处理'">裁决人 {{c.resolvedBy}} · {{c.resolvedAt}}<ng-container *ngIf="c.state==='采纳为新修订'">；重新签字前各页面仍显示上一版可用结论</ng-container></p>
        </div>
      </section>

      <div class="grid-2 mt-4">
        <!-- 一致视图：焊缝 -->
        <section class="card">
          <h2 class="panel-title">焊缝可用结论 <small class="hint">冲突处理完前与审核快照保持同一条</small></h2>
          <p-table [value]="effectiveWelds" [paginator]="true" [rows]="6">
            <ng-template #header><tr><th>焊缝</th><th>状态</th><th>返修</th><th>缺陷</th><th>快照</th></tr></ng-template>
            <ng-template #body let-w>
              <tr [class.row-conflict]="openConflict(w.id)">
                <td><b>{{w.id}}</b><small class="block">{{w.component}}</small></td>
                <td><p-tag [value]="w.status" [severity]="w.status==='合格'||w.status==='已关闭'?'success':w.status==='返修中'?'danger':'warn'" /></td>
                <td>{{w.repairs}} 次</td>
                <td>{{w.defects.length}} 条</td>
                <td><span class="signed-yes" *ngIf="signedOf(w.id)"><i class="pi pi-lock"></i>v{{signedOf(w.id)!.version}}</span><span class="muted" *ngIf="!signedOf(w.id)">—</span></td>
              </tr>
            </ng-template>
          </p-table>
        </section>

        <!-- 一致视图：计划 + 幂等台账 -->
        <section class="card">
          <h2 class="panel-title">检测计划与幂等台账</h2>
          <p class="sub">检测计划（冲突/待重签期间仅显示快照内计划）</p>
          <ul class="plans">
            <li *ngFor="let p of effectivePlans"><b>{{p.id}}</b><span>{{p.date}} · {{p.method}} · {{p.weldIds.join('、')}}</span><small>{{p.inspector}} · {{p.state}}</small></li>
            <li *ngIf="!effectivePlans.length" class="empty">暂无可见计划</li>
          </ul>
          <p class="sub mt">请求号幂等台账（重放/恢复命中后不重复追加）</p>
          <ul class="ledger">
            <li *ngFor="let e of server.applied"><b>{{e.requestId}}</b><span>{{e.note}}</span><small>{{e.appliedAt}}</small></li>
            <li *ngIf="!server.applied.length" class="empty">尚无并入记录</li>
          </ul>
        </section>
      </div>

      <!-- 演练日志 -->
      <section class="card mt-4" *ngIf="logs.length">
        <h2 class="panel-title">演练链路日志</h2>
        <ol class="logs"><li *ngFor="let line of logs">{{line}}</li></ol>
      </section>
    </main>
  `,
  styles: [`
    .conn{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px}
    .conn-state{display:flex;align-items:center;gap:10px}.conn-state i{width:12px;height:12px;border-radius:50%;display:inline-block}
    .conn-state i.on{background:#16a34a;box-shadow:0 0 0 4px #16a34a22}.conn-state i.off{background:#dc2626;box-shadow:0 0 0 4px #dc262622}
    .conn-state b,.conn-state small{display:block}.conn-state small{color:#7a8798;margin-top:2px}
    .tip{display:flex;align-items:center;gap:10px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px}
    .tip.alert{background:#fef2f2;border-color:#fecaca;color:#991b1b}.tip .spacer{flex:1}.tip p-button{margin-left:auto}
    .form{display:grid;gap:10px}.row{display:grid;grid-template-columns:90px 1fr;gap:10px;align-items:center}.row.two{grid-template-columns:90px 1fr 1fr;gap:10px}.row.two>div{display:grid;grid-template-columns:1fr;gap:6px}
    .form label{font-size:13px;color:#475467}.form .native{padding:9px;border:1px solid #cbd5e1;border-radius:6px;width:100%;background:#fff}
    .check{display:flex;gap:8px;align-items:center;font-size:13px;color:#475467}.hint{font-weight:400;color:#94a3b8;font-size:12px;margin-left:8px}
    .block{display:block}.empty{color:#94a3b8;font-size:13px;padding:8px 0}
    .conflict{border:1px solid #fecaca;border-radius:8px;padding:14px;margin-bottom:12px;background:#fffafa}
    .conflict-head{display:flex;justify-content:space-between;align-items:flex-start}.conflict-head b,.conflict-head small{display:block}.conflict-head small{color:#7a8798;margin-top:3px}
    .reason{color:#991b1b;font-size:13px;margin:8px 0}.reason i{margin-right:6px}
    .snap-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.snap{border-radius:7px;padding:10px 12px}.snap h4{margin:0 0 6px;font-size:13px}.snap ul{margin:0;padding-left:18px;font-size:13px;color:#475467}.snap li{margin:3px 0}
    .snap.signed{background:#f0fdf4;border:1px solid #bbf7d0}.snap.signed h4{color:#15803d}.snap.incoming{background:#f8fafc;border:1px dashed #cbd5e1}
    .conflict-actions{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}.resolved{margin:8px 0 0;font-size:12px;color:#7a8798}
    .row-conflict{background:#fef2f2}.signed-yes{color:#15803d;font-size:12px}.muted{color:#cbd5e1}.sub{font-size:13px;font-weight:700;color:#334155;margin:0 0 8px}.sub.mt{margin-top:14px}
    .plans,.ledger{list-style:none;margin:0;padding:0;max-height:170px;overflow:auto}.plans li,.ledger li{display:grid;grid-template-columns:150px 1fr auto;gap:8px;padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:13px}.plans li span,.ledger li span{color:#475467}.plans li small,.ledger li small{color:#94a3b8}
    .logs{margin:0;padding-left:20px;font-size:13px;color:#334155}.logs li{margin:5px 0}
    .mt-4{margin-top:16px}
    @media(max-width:760px){.snap-grid{grid-template-columns:1fr}.row,.row.two{grid-template-columns:1fr}.plans li,.ledger li{grid-template-columns:1fr}}
  `],
})
export class SyncComponent {
  private readonly sync = inject(SyncService)

  online = true
  syncing = false
  server!: ServerState
  outbox: OfflineSubmission[] = []
  logs: string[] = []

  form = this.emptyForm()

  constructor() {
    this.sync.online$.subscribe((v) => (this.online = v))
    this.sync.syncing$.subscribe((v) => (this.syncing = v))
    this.sync.server$.subscribe((v) => (this.server = v))
    this.sync.outbox$.subscribe((v) => (this.outbox = v))
  }

  private emptyForm() {
    return {
      weldId: 'W-107',
      inspector: '周敏',
      method: 'UT',
      position: 55,
      length: 8,
      type: '气孔',
      level: 'Ⅱ级',
      report: 'UT-OFFLINE-03；现场复扫，按 NB/T 47013.3 评定。',
      hasRepair: true,
      repairCount: 1,
      recheckDate: '2026-10-03',
    }
  }

  get weldOptions() { return this.server?.welds ?? [] }
  get batchId() { return this.sync.batchId }
  get effectiveWelds() { return this.server ? this.sync.effectiveWelds() : [] }
  get effectivePlans() { return this.server ? this.sync.effectivePlans() : [] }

  tagOf(status: SubmissionStatus) { return STATUS_TAG[status] }
  get hasOpenConflict() { return !!this.server && (this.server.conflicts.some((c) => c.state === '待处理') || this.server.pendingResign) }
  private log(line: string) { this.logs = [...this.logs, line] }
  signedOf(weldId: string) { return this.server.signed.find((s) => s.weldId === weldId) }
  openConflict(weldId: string) { return this.server.conflicts.some((c) => c.weldId === weldId && c.state === '待处理') }

  toggleNetwork() { this.sync.setOnline(!this.online) }
  reset() { this.sync.resetDemo(); this.logs = [] }
  lock() { this.sync.lock(); }
  resolve(requestId: string, resolution: ConflictRecord['state']) {
    if (resolution !== '待处理') this.sync.resolve(requestId, resolution)
  }

  enqueue() {
    const f = this.form
    const saved = this.sync.enqueue({
      inspector: f.inspector,
      weldId: f.weldId,
      method: f.method,
      defect: { position: Number(f.position), type: f.type, length: Number(f.length), level: f.level as never, method: f.method, report: f.report },
      repairResult: f.hasRepair ? { repairCount: f.repairCount, recheckPlan: { date: f.recheckDate, method: f.method } } : undefined,
    })
    this.log(`${this.online ? '已' : '断网已'}存本地队列：${saved.requestId}（焊缝 ${saved.weldId}，基于 r${saved.baseRev}），等待回网按批次合并`)
  }

  async doSync() {
    const res = await this.sync.syncNow()
    if (res.merged || res.conflicts || res.failed) {
      this.log(`批次合并完成：并入 ${res.merged}，另存冲突 ${res.conflicts}，写入失败 ${res.failed}（失败保留原请求号，可再次合并恢复）`)
    }
  }

  async runScenario() {
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    this.reset()
    this.logs = []
    this.log('① 重置演练数据，现场进入断网状态，补录只写本地队列（localStorage，刷新不丢）')
    this.sync.setOnline(false)
    await wait(300)

    const r1 = this.sync.enqueue({
      inspector: '周敏', weldId: 'W-107', method: 'UT',
      defect: { position: 55, type: '气孔', length: 8, level: 'Ⅱ级', method: 'UT', report: 'UT-OFFLINE-01' },
      repairResult: { repairCount: 1, recheckPlan: { date: '2026-10-03', method: 'UT' } },
    })
    this.log(`② 本地存 ${r1.requestId}：W-107 缺陷 + 返修结果（冻结 baseRev r${r1.baseRev}）`)
    const r2 = this.sync.enqueue({
      inspector: '周敏', weldId: 'W-109', method: 'MT',
      defect: { position: 30, type: '表面线性显示', length: 6, level: 'Ⅲ级', method: 'MT', report: 'MT-OFFLINE-02' },
    })
    this.log(`③ 本地存 ${r2.requestId}：W-109 缺陷记录（无返修，不累加返修次数）`)
    await wait(500)

    this.log('④ 回网合并批次：模拟 ' + r1.requestId + ' 服务端写入失败（未产生任何部分写入），' + r2.requestId + ' 正常并入')
    this.sync.setOnline(true)
    this.sync.failNext([r1.requestId])
    let res = await this.sync.syncNow()
    this.log(`⑤ 合并结果：成功 ${res.merged} / 失败 ${res.failed}；${r1.requestId} 按原请求号留在队列，状态=写入失败`)
    await wait(800)

    this.log('⑥ 按原请求号恢复重传：幂等命中保证返修次数只 +1、复检计划只登记 1 次')
    res = await this.sync.syncNow()
    const w107 = this.sync.server.welds.find((w) => w.id === 'W-107')!
    const plansFor107 = this.sync.server.plans.filter((p) => p.weldIds.includes('W-107')).length
    this.log(`⑦ W-107 校验：返修 ${w107.repairs} 次、缺陷 ${w107.defects.length} 条、关联复检计划 ${plansFor107} 个——重复合并也不会追加`)
    await wait(400)

    this.sync.schedulePlan({
      id: 'IP-2026-1001-C', date: '2026-10-01', method: 'UT + MT',
      weldIds: ['W-104', 'W-107'], inspector: '质量台', state: '待执行',
    })
    this.log('⑧ 质量台已排检测计划并签字锁定，审核快照冻结每条焊缝的可用结论')
    this.sync.lock('质量负责人')
    await wait(400)

    this.sync.setOnline(false)
    const r4 = this.sync.enqueue({
      inspector: '陈锋', weldId: 'W-104', method: 'UT',
      defect: { position: 47, type: '未熔合', length: 15, level: 'Ⅲ级', method: 'UT', report: 'UT-OFFLINE-04' },
      repairResult: { repairCount: 1, recheckPlan: { date: '2026-10-04', method: 'UT' } },
    })
    this.log(`⑨ 两人同时提交同一焊缝：${r4.requestId} 晚到，而 W-104 结论已签字`)
    this.sync.setOnline(true)
    res = await this.sync.syncNow()
    this.log(`⑩ ${r4.requestId} 被另存为冲突（不盖签字结论）；冲突处理完前，台账/地图/检测/审核页对 W-104 只显示快照那条结论`)
    this.log('⑪ 请在上方冲突台账选择「维持已签字」或「采纳为新修订」；采纳后须重新签字，各页面才会切换到新结论')
  }
}
