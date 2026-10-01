# 钢结构焊缝台账、无损检测和返修闭环平台

源提示词编号：13。覆盖构件与图纸焊缝台账、二维定位、焊工资质和检测比例预警、批量检测计划、缺陷记录、返修/复检状态、Apollo GraphQL 数据层、版本快照、签字锁定和完整追溯。

## 技术栈

Angular、PrimeNG、NgRx、Angular Router、RxJS、Apollo Angular、GraphQL、TypeScript。

## 运行

```bash
npm install
npm run dev
```

开发地址：http://localhost:62056

```bash
npm run build
```

## 断网补录与回网批次合并（「断网补录」页）

现场检验员断网时，焊缝缺陷与返修结果先生成请求号存入本地队列（localStorage 持久化，刷新不丢）；回网后按批次合并到模拟质量台服务端。核心语义集中在 `src/app/sync/merge.engine.ts`：

- **请求号幂等**：同一请求号重放（双击、网络重发、失败恢复重试）只命中台账，缺陷、返修次数、检测计划均不重复追加。
- **写入失败按原号恢复**：写入失败不产生任何部分写入，请求以原请求号留在队列，再次合并即恢复。
- **晚到冲突另存**：已签字锁定的审核快照不可覆盖；两人同时提交同一焊缝时，修订号过期的晚到内容按请求号写入冲突台账，不盖掉已签字结论。
- **冲突裁决**：可「维持已签字」（晚到内容仅留档）或「采纳为新修订」（原快照只读保留，派生修订须重新签字）。
- **同一条可用结论**：冲突处理完 / 重新签字前，焊缝状态、检测计划、审核快照在所有页面统一显示已签字那条结论。
- 页面顶部「一键演练完整链路」可顺序演示：失败恢复 → 幂等合并 → 质量台排计划并签字 → 晚到补录另存冲突。

引擎不变量验证：

```bash
node_modules/.bin/esbuild src/app/sync/sync.verify.ts --bundle --platform=node --format=esm --target=node20 --outfile=/tmp/sync.verify.mjs
node /tmp/sync.verify.mjs
```
