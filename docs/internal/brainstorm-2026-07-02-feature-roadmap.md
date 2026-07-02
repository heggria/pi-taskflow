# Feature Brainstorm — 2026-07-02（多 agent 深度头脑风暴）

> 流程：5 路视角并行发散（UX friction / competitive gaps / DSL & graph power /
> observability & ops / wild cards）→ critic 收敛去重打分（~30 → 13）→
> final-arbiter 最终裁决。Run id: `feature-brainstorm-mr35thru-98f8e2`。

## 一、下个版本就做 (Top 3)

### 1. Peek — Post-Hoc Phase Output Inspection（S）

`/tf peek <runId> <phaseId>` 事后探查任意 phase 的中间输出（强制截断，默认
4000 字符），`--json` 返回解析后的 JSON，`--item <n>` 支持 map phase 单项。
解决"第 4 个 phase 产出垃圾只能整个 flow 重跑"的调试盲区；仅通过显式命令暴
露，不破坏上下文隔离原则。

### 2. Per-Phase Timeout（S）

`timeout` 字段从 `script` phase 提升到所有 phase 类型。超时后 kill subagent、
phase 置为独立的 `timedOut` 状态（区别于 `failed`），下游 `when` 可按
`{steps.X.status}` 路由。默认 timeout 不触发 retry（不算 retryable failure）。

### 3. Output Schema Contracts（`expect`）（M）

**5 路 agent 中独立出现 4 次——全场最强需求信号。** phase 声明输出 schema
（TypeBox 子集），完成后立即校验，不匹配则 `failed` + 精确诊断（可触发
retry）。`verifyTaskflow()` 同时静态检查 `{steps.X.json.field}` 引用是否存在
于 X 的声明 schema。当前 #1 失败模式是"phase 跑完了但形状不对、下游静默解析
失败"——`expect` 把运行时灾难变成编译期契约违反。也是 Budget Proof 与
Preflight 的地基（"类型脊柱"起点）。

## 二、值得规划 (Next 6)

4. **Notifications & Webhooks（`onComplete`/`onFail`）** — webhook / file /
   command 三种 dispatch，payload 只带摘要元数据不带 transcript。detached
   运行的闭环。难点：payload 边界、失败语义（默认 fire-and-forget）。
5. **NL→Flow Synthesis** — `/tf scaffold "<一句话>"` → planner（注入
   SKILL.md）生成 flow → verify → 问题反馈修正 ≤3 轮 → 用户确认保存。
   难点："结构对但语义错"的虚假安全感，需 dry-run 预览兜底。
6. **Flow Versioning** — `flows/<name>/v1.json…` + `/tf history / diff /
   rollback`。难点：保留策略（默认 50 版）、图 diff 而非文本 diff。
7. **Budget Proof** — verify 阶段符号推导 worst-case 成本上界
   （loop = maxIterations × body，map = len × item）。**前置依赖：model
   rate registry（当前不存在）**；动态 `over` 标记 unbounded。
8. **Preflight Dry-Run** — taskflow 版 `terraform plan`：静态解析 `{args.X}`、
   动态引用标 `<will resolve from phase X>`，花第一个 token 前抓插值错误。
   难点：必须与 `interpolate.ts` 共享代码路径，避免语义漂移。
9. **Fallback Phase** — phase 级 `fallback: <phaseId>`，retries exhausted /
   timedOut 后声明式降级（如切便宜模型）。难点：fallback 环检测、依赖继承
   语义、与 retry/timeout 的交互。

## 三、大胆的赌注

- **Cross-Run Analytics + Auto-Tuning** — `/tf analytics <flow> --last 20`
  聚合 per-phase 耗时/失败率/p50-p95 成本 → 进而自动调 retry/concurrency/
  模型。没有任何编排器在从历史数据自我调优。风险：flat JSON 存储 ~1000 runs
  后触顶，需规划 SQLite 索引。
- **"Git for Taskflows"** — 结构化图 diff（phase/edge 增删改 + fingerprint
  迁移计划：哪些缓存仍有效）→ Git-backed flow store（push/pull/merge）。
  最小实验：本地 `taskflow diff <A> <B>`，验证 ≤30 phases 的图同构启发式。

## 四、明确不做

| 方向 | 理由 |
|------|------|
| Artifacts（typed file outputs） | ctx_write/ctx_read 已覆盖 |
| Flow Algebra（merge/project/compose） | flow{use} 已覆盖，过于超前 |
| Stream Edges + Backpressure | 动核心架构风险最大 |
| 可视化拖拽编辑器 | 与"JSON 是护城河"直接冲突 |
| CI Integration 打包 | headless + exit code 已够 |
| OTel Export | 破坏零依赖，小众 |
| Speculative Execution | ctx 无回滚语义，违背成本控制 |
| Tagged-Union Routing | 依赖 schema 先行，无需求信号 |
| Flows-as-a-Service | taskflow_run MCP 已可按名调用 |
| Adversarial Twinning | 是 AI 研究问题，不是编排问题 |
| Flow Templates 继承 | Helm 级复杂度，不需要 |
| Higher-Order Combinators（race 等） | 现有 phase type 已可表达 |
| Partial Evaluation | 运行时已跳过 false 分支 |
| Sensor Phase | loop + script 已可实现 |
| Run Report Export | compile/show 已覆盖 |
| Flow Property Lattice | 研究级问题，子属性逐个孵化 |

## 最终裁决

**如果只能做一件事：Output Schema Contracts（`expect`）。**
Peek 是 CT 扫描（治标）、Timeout 是监护仪（止损）、`expect` 是疫苗（治本），
且是 Budget Proof / Preflight 的前置地基。

执行节奏：

```
Release 1:  Peek + Per-Phase Timeout     ← 两个 S，一个 release
Release 2:  Output Schema Contracts      ← M，独立 release（避免 executePhase 并发修改冲突）
Release 3:  Notifications + Tier 2 按需
```
