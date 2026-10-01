import { Routes } from '@angular/router'
import { OverviewComponent } from './pages/overview.component'
import { WeldMapComponent } from './pages/weld-map.component'
import { InspectionsComponent } from './pages/inspections.component'
import { ApprovalsComponent } from './pages/approvals.component'

export const routes: Routes = [
  { path:'', pathMatch:'full', redirectTo:'overview' },
  { path:'overview', component:OverviewComponent, title:'焊缝台账总览' },
  { path:'map', component:WeldMapComponent, title:'构件焊缝定位' },
  { path:'inspections', component:InspectionsComponent, title:'检测与返修' },
  { path:'approvals', component:ApprovalsComponent, title:'审核与锁定' },
]
