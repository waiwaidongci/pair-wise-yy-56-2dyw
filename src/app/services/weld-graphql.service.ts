import { inject, Injectable } from '@angular/core'
import { Apollo, gql } from 'apollo-angular'
import { map } from 'rxjs'
import type { InspectionPlan, MergeBatchResult, OfflineSubmission, Weld } from '../types'

const WELDS_QUERY = gql`query Welds { welds { id drawing component joint method welder qualification qualificationValid inspectionRatio requiredRatio status x y repairs defects { id position type length level method report } } plans { id date method weldIds inspector state } }`

const MERGE_BATCH = gql`mutation MergeBatch($batchId: String!, $locked: Boolean!, $submissions: [MergeSubmissionInput!]!) { mergeBatch(batchId: $batchId, locked: $locked, submissions: $submissions) { batchId applied conflicts { requestId weldId kind incoming existing } } }`

@Injectable({ providedIn: 'root' })
export class WeldGraphqlService {
  private readonly apollo = inject(Apollo)
  load() {
    return this.apollo.watchQuery<{ welds: Weld[]; plans: InspectionPlan[] }>({ query: WELDS_QUERY, fetchPolicy: 'cache-first' }).valueChanges.pipe(map((result) => result.data))
  }
  mergeBatch(batchId: string, locked: boolean, submissions: OfflineSubmission[]) {
    const variables = {
      batchId,
      locked,
      submissions: submissions.map((item) => ({ requestId: item.requestId, kind: item.kind, weldId: item.weldId, payload: item.payload })),
    }
    return this.apollo.mutate<{ mergeBatch: MergeBatchResult }>({ mutation: MERGE_BATCH, variables }).pipe(map((result) => result.data!.mergeBatch))
  }
}
