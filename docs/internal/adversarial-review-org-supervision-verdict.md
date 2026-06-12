# 对抗审查裁决：组织式动态监督 → `ctx_spawn` 子图（round 1）

> 三路对抗审查（risk-reviewer / critic / reviewer）+ plan-arbiter 仲裁的裁决。
> 被审文档：`docs/internal/design-org-supervision.md`
> 审查 runId：`adversarial-review-org-s-mq997wuw-71ce96`

## VERDICT：**BUILD SCOPED-DOWN**

只实现 **缺口 A**（`ctx_spawn` 接受带依赖的 subflow）。**推迟缺口 B**（`supervise` 闭环监督 phase、`{reports}` 占位符、回合循环、新 PHASE_TYPES）。

三位审查者独立同意：缺口 A 架构正确（复用 `normalizeInlineDef`+`validateTaskflow`+`verifyTaskflow`）；缺口 B 是"为方案找问题"——零个现存 taskflow 用过 `ctx_spawn`，`loop`+`flow{def}` 已能表达回合循环。先用组合验证价值，确有摩擦再固化 `supervise`。

## 编码前必须解决的 5 个问题

1. **双递归轴绕过深度上限（HIGH）**：`runSpawnedChildren` 与 `flow{def}` 各自独立 cap 5，互不计数 → 子图内用 flow{def} 可达 25 层。修：spawn 子图前给 `deps._stack` 加 `def:spawn-<childNodeId>` 帧，复用 `runtime.ts:883` 的 `stack.filter(s=>s.startsWith("def:"))` 计数器统一两轴。
2. **子级 usage 被丢弃（HIGH）**：`runSpawnedChildren` 丢了 `r.usage`，`overBudget` 看不到子图开销。修：累加子级 usage 进父 phase 的 `ps.usage`。
3. **`queueSpawn` XOR 校验顺序（MED）**：现有 `task` 必填校验在最前无条件跑，纯 subflow 会被拒。修：重构为 `if subflow / else if task / else throw`。`MAX_SUBFLOW_BYTES = 262144`（256KB）。
4. **崩溃 resume 丢失已完成子级（HIGH）**：子级不进 `state.phases`。修：给 spawned 子图传父级 `persist`，内层 phase 独立 checkpoint，re-drain 时靠 inputHash 跳过。简单 task spawn 不单独 checkpoint（记为已知限制，round 1 可接受）。
5. **`agent` 字段语义二义（MED）**：平铺任务上=执行者，子图上=内层默认 agent。修：子图 assignment 用 `defaultAgent`。

## Round-1 范围

**做**：`SpawnAssignment` 加 `subflow?`+`defaultAgent?`；`queueSpawn` XOR 校验 + `MAX_SUBFLOW_BYTES`；抽 `runInlineSubflow()` 共用；`runSpawnedChildren` 走子图路径 + `_stack` 传播 + usage 累加 + persist 传递；schema TypeBox；SKILL 文档；1 个 example；测试。

**推迟（round 2）**：`supervise` phase、`{reports}`、回合循环、`PHASE_TYPES` 改动。
