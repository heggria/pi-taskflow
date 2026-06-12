# 设计：`ctx_spawn` 子图支持（round 1）

> **状态**：三路对抗审查 + 仲裁通过 → **BUILD SCOPED-DOWN**。裁决：`docs/internal/adversarial-review-org-supervision-verdict.md`。
> **本轮只做缺口 A（ctx_spawn 子图）**。缺口 B（supervise 闭环）推迟到 round 2，先用 `loop`+`flow{def}`+`ctx_spawn(subflow)` 组合验证价值。
> **前置**：Shared Context Tree 第一阶段已落地（`ctx_read/ctx_write/ctx_report/ctx_spawn` + `runSpawnedChildren` 监督循环 + tree.json）。
> **范围（本轮）**：把 `ctx_spawn` 从「派一组平铺独立任务」升级为「动态生成带依赖的子图」，并给父级一个「看汇报 → 再决策下一轮」的**闭环监督**形态。
>
> 一句话目标：让 taskflow 的运行时支持**真实组织的协作模式**——上级看下属汇报后，动态生成下一层的协作子图并继续监督，而不是一次性下达 N 张孤立任务单。

---

## 0. 现状精确画像（对照代码，非推测）

| 能力 | 现状 | 代码依据 |
|------|------|---------|
| 父级运行中动态派生 | ✅ 有 | `ctx_spawn`→`queueSpawn`→`drainPendingSpawns`→`runSpawnedChildren`（`runtime.ts:705`） |
| 子级执行+向上汇报 | ✅ 有 | 子 output + `ctx_report` 折叠回父 phase output（`runtime.ts:429`） |
| 递归（子又派孙） | ✅ 有 | `runSpawnedChildren` 内 `drainPendingSpawns(childNodeId)` 自递归，`MAX_DYNAMIC_NESTING=5` 兜底 |
| **派生物是子图（带 dependsOn）** | ❌ **无** | `SpawnAssignment = {task, agent?}`（`context-store.ts:92`）——平铺、互不依赖、无 gate/reduce |
| **父级闭环监督（看汇报→再派下一轮）** | ⚠️ **半** | `runSpawnedChildren` 在父 phase **跑完后**才 drain（`runtime.ts:704-707`）；父级是 fire-and-forget，迭代只能下放给子级递归 |

**两个缺口**：
- **缺口 A（子图）**：`ctx_spawn` 只能下达平铺任务组，不能下达「A→B、B+C→D」这种带依赖的协作 DAG。
- **缺口 B（闭环）**：父级一次性 spawn 完即终止，无法在看到子级汇报后由**同一个父级**决定第二批。

---

## 1. 为什么不是「让父进程边跑边接收子级回调并改图」

最直觉的方案是：父 subagent 进程不退出，子级 `ctx_report` 后通过某种 IPC 实时回调父级，父级在自己的 context window 里看汇报、再调 `ctx_spawn`。

**否决，三条硬理由：**

1. **违反「不向 host 泄漏中间结果」+「context-isolated」核心不变量**。父级若要"看到所有子级汇报再决策"，子级的完整 transcript 就要回流进父级的 context window——这正是 taskflow 立身之本（只回 finalOutput）要消灭的东西。子级一多，父级 context 爆炸。
2. **pi subagent 是 `--no-session` 一次性进程**。让它"挂起等子级、被唤醒、继续推理"需要会话续接 + 双向 RPC，是一整套新的进程生命周期，风险等级等同重写 runner。
3. **重新引入了已被前一轮设计否决的「动态调度器 graft 进父 DAG」的所有 P0**（crash 注入丢失、就绪判定二义性、并发改 phases 数组）。

**结论**：闭环监督不靠"父进程常驻"，而靠 **runtime 编排的「监督回合」**——父级是**无状态的决策函数**，每回合：跑一次父级 agent（喂上一回合的子级汇报摘要）→ 它输出"下一批子图 或 done"→ runtime 执行子图 → 把子级 `ctx_report` 摘要喂给下一回合父级。这把"闭环"实现为**数据驱动的循环**，而非常驻进程。**这恰好就是已存在的 `loop` + `flow{def}` 组合**——本设计的一大半是"让它们与 Context Tree 正确接合"，而非新造机制。

---

## 2. 缺口 A 的解法：`ctx_spawn` 接受子图

### 2.1 DSL/工具契约扩展（向后兼容）

`ctx_spawn` 的 `assignments[]` 每项从 `{task, agent?}` 扩展为**二选一**：

```jsonc
// 形态 1（现状，保留）：平铺任务
{ "task": "审计 auth.ts", "agent": "analyst" }

// 形态 2（新增）：一个带依赖的子图
{
  "subflow": {
    "phases": [
      { "id": "scan",   "type": "agent", "agent": "scout",  "task": "列出所有端点" },
      { "id": "audit",  "type": "map",   "over": "{steps.scan.json}", "agent": "analyst",
        "task": "审计 {item}", "dependsOn": ["scan"] },
      { "id": "report", "type": "reduce","from": ["audit"], "agent": "doc-writer",
        "task": "汇总", "dependsOn": ["audit"], "final": true }
    ]
  },
  "agent": "scout"   // 可选：子图未指定 agent 的 phase 的默认 agent
}
```

**契约**：
- `task` XOR `subflow`：每个 assignment 必居其一。
- `subflow` 的内容**就是一个内联 Taskflow**（`{name?, phases:[...]}` 或裸 `phases[]`），**直接复用现有 `normalizeInlineDef` + `validateTaskflow` + `verifyTaskflow`**（`runtime.ts:175/925`）——零新解析代码。
- 子图作为**嵌套子流程**执行（复用 `executeTaskflow` + `_stack` 递归栈 + `MAX_DYNAMIC_NESTING`），它的 `finalOutput` 作为这个 spawned 子节点的 report。
- 子图内的 phase 若开 `shareContext`，其 nodeId 以 `childNodeId/<phaseId>` 命名，挂在 spawned 子节点下——黑板可见性沿用祖先链规则，天然继承。

### 2.2 为什么这条路安全

- **不碰父 DAG 拓扑**：子图被封装在一个 spawned 子节点里（和 `flow{def}` 把动态 DAG 封装在单个 flow phase 里同构），父图的静态拓扑、就绪判定、resume 全不变。
- **验证前置**：子图执行前跑完整 `validateTaskflow`（环/重复 id/断引用）+ `verifyTaskflow`（死端/gate 穷尽/预算）。失败 → fail-open（该 spawned 节点失败，父 phase 的其他子级与上游 output 不丢）。
- **终止性**：spawned 子图算一层 `def:` 嵌套，计入 `MAX_DYNAMIC_NESTING`，与 loop 硬帽乘积有界。
- **命名空间隔离**：子图在自己的 steps 命名空间解析 `{steps.x.output}`，与父级零冲突（同 `flow{def}` 已验证的结构收益）。

---

## 3. 缺口 B（推迟到 round 2）

> 仲裁裁决：缺口 B 推迟。Round 1 先用现有 `loop` + `flow{def}` + `ctx_spawn(subflow)` 组合验证闭环监督的价值：loop body 跑 planner → planner 输出 spawn assignments（含 subflow）→ 执行 → loop 喂 `{previous.output}` 给下一轮。写一个 example 验证该模式是否足够。若 dogfooding 暴露 `loop` 组合的摩擦点，再以那份摩擦为证据设计 `supervise` 一等 phase。
>
> 以下原始 `supervise` 设计保留作 round-2 输入，**本轮不实现**。

### （round 2 草案）`supervise` 监督回合（父级闭环）

### 3.1 形态：一个新的 phase 类型 `supervise`（或等价的 loop 约定）

```jsonc
{
  "id": "lead",
  "type": "supervise",
  "agent": "planner",
  "maxRounds": 4,
  "shareContext": true,
  "task":
    "你是团队负责人。本回合可见的下属汇报：\n{reports}\n\n" +
    "若工作已完成，输出 {\"done\":true}。" +
    "否则输出 {\"spawn\":[ <assignments，可含 subflow> ]} 派下一批。",
  "final": true
}
```

**runtime 执行语义（每回合）**：
1. 跑一次 `lead` agent，注入占位符 `{reports}` = 上一回合所有 spawned 子节点的 `ctx_report` **摘要**（不是全文 transcript——只读 reports/ 目录的 summary，受 `MAX_REPORT_BYTES` 约束，**不泄漏子级 context**）。
2. 解析其 JSON 输出：
   - `{"done":true}`（或达 `maxRounds`）→ 终止，`lead` 的最后输出作为 phase output。
   - `{"spawn":[...]}` → 复用 §2 的 spawned 执行（含子图），等这一批全部跑完，收集它们的 report 摘要 → 进入下一回合。
3. 每回合 spawned 子节点挂在 `lead` 节点下，tree.json 形成 `lead → round-k → children` 的层级。

**这就是「看汇报 → 再决策 → 再下达」的闭环**，且：
- 父级始终是**无状态决策函数**，每回合重新喂摘要——零常驻进程、零子级 transcript 回流。
- 本质是 `loop` body = "跑 planner + 执行它生成的 spawn"。**可以不新增 phase 类型**，用 `loop` + 约定实现；但新增 `supervise` 让"组织监督"成为一等公民、SKILL 可教、可静态 verify（见 §5 取舍）。

### 3.2 与现有 `loop` 的关系（关键取舍）

| 维度 | 复用 `loop`+`flow{def}`（零新 phase） | 新增 `supervise` phase |
|------|------|------|
| 改动量 | 最小（仅文档 + 把 `{reports}` 注入接好） | 中（新 phase 类型：schema/validate/execute/verify/test/SKILL 六处，按 AGENTS.md checklist） |
| 可教性 | 作者要手写 loop+def+reports 接线，易错 | 一等公民，意图清晰 |
| 静态可验证 | loop 的通用验证 | 可加"supervise 必须有 maxRounds + done 条件"专项验证 |
| 风险 | 低（全是已验证机制的组合） | 中（新执行分支，回归面更大） |

> **倾向**：缺口 A（子图）必做、低风险、复用现成机制；缺口 B（闭环）**先用 `loop`+`flow{def}` 验证价值**（写一个 e2e + example），**确有价值再固化为 `supervise` phase**。避免过早新增 phase 类型。

---

## 4. 不变量保护（逐条）

| 不变量 | 保护方式 |
|--------|---------|
| **不向 host 泄漏中间结果** | 闭环只把子级 `ctx_report` 的 **summary** 喂回父级回合，子级 transcript 永不回流；host 仍只收 finalOutput |
| **context-isolated** | 父级是无状态决策函数，每回合独立 subagent 进程，不常驻、不续接会话 |
| **DAG 无环 / 运行前可验证** | spawned 子图执行前过 `validateTaskflow`+`verifyTaskflow`；失败 fail-open，父图不受影响 |
| **不破坏 resume** | spawned 子图是独立 RunState 子单元（同 `flow{def}`）；`supervise` 每回合的 spawn 批次以确定性 nodeId 注册（`lead/round-k/cN`），resume 幂等 upsert |
| **不丢工作 (fail-open)** | 子图解析/验证失败 → 该 spawned 节点 `defError` 失败，同批其他子级与父级回合输出保留 |
| **终止性** | spawned 子图计入 `MAX_DYNAMIC_NESTING`；`supervise` 有 `maxRounds`（硬帽，如 10）；每回合 spawn 批受 `MAX_SPAWN_ASSIGNMENTS`/`MAX_DYNAMIC_MAP_ITEMS`；乘积有界 |
| **id 唯一** | spawned 子图独立命名空间；子节点 nodeId 由 `parent--cN` / `lead/round-k/cN` 生成并 charset-sanitize（沿用现有 `replace(/[^A-Za-z0-9._-]+/g,"_")`） |
| **并发安全** | spawned 子级各写自己的 findings 文件（现有 per-node 分片）；drain 仍在父级退出后执行（现有 INVARIANT 不变） |
| **向后兼容** | `task` 路径零改动；`subflow` 是新增可选分支；不开 `supervise`/不写 `subflow` 的流程行为完全不变 |

---

## 5. 改动文件清单

| 文件 | 改动 | 备注 |
|------|------|------|
| `context-store.ts` | `SpawnAssignment` 加可选 `subflow?: unknown`；`queueSpawn` 校验 `task` XOR `subflow`，对 `subflow` 做大小上限（复用 `MAX_TASK_BYTES` 量级或新增 `MAX_SUBFLOW_BYTES`） | 缺口 A 入口 |
| `runtime.ts` | `runSpawnedChildren`：assignment 若有 `subflow` → `normalizeInlineDef`→`validateTaskflow`→`verifyTaskflow`→嵌套 `executeTaskflow`（复用 §865 的 `flow{def}` 代码路径，抽成 `runInlineSubflow()` 共用）；否则走现有 `run(task)` | 缺口 A 执行；**抽公共函数避免与 flow{def} 重复** |
| `runtime.ts` | （缺口 B，若做 `supervise`）新增 phase 分支：回合循环 + `{reports}` 注入 + done 判定 | 仅 B 选 supervise 路线时 |
| `schema.ts` | `SpawnAssignment` 的 TypeBox；（若 supervise）`PHASE_TYPES` 加 `"supervise"` + 校验 `maxRounds` | 按需 |
| `interpolate.ts` | 新增 `{reports}` 占位符解析（读 reports/ 目录 summary 聚合）——仅 B 路线 | 按需 |
| `verify.ts` | （若 supervise）静态校验：supervise 必须可终止（有 maxRounds） | 按需 |
| `skills/taskflow/SKILL.md` | 必加：`ctx_spawn` 子图用法 + 组织监督模式（loop 或 supervise）+ LLM 输出契约 | AGENTS.md checklist 强制 |
| `examples/` | `org-supervise.json`：lead 看汇报→动态派子图→迭代 | 验收物 |
| `package.json` | 新测试文件自动纳入（已 glob 化，无需手动加） | — |

---

## 6. 测试清单

| 文件 | 覆盖 |
|------|------|
| `test/spawn-subflow.test.ts`（mock runner）| `ctx_spawn` 带 `subflow` → 嵌套 DAG 执行 → report 折叠回父；带依赖的 phase 顺序正确 |
| `test/spawn-subflow-validate.test.ts` | 子图含环/重复 id/断引用 → defError fail-open、同批其他子级保留 |
| `test/spawn-xor.test.ts` | assignment 同时含 `task` 和 `subflow` → 拒绝；都无 → 拒绝 |
| `test/spawn-nesting.test.ts` | 子图内再 spawn 子图，超 `MAX_DYNAMIC_NESTING` → 拒绝、不挂死 |
| `test/supervise-rounds.test.ts`（若做 B）| 多回合：父级看 round-1 汇报后派 round-2；`{"done":true}` 判停；`maxRounds` 兜底 |
| `test/context-tree.test.ts`（既有）| 回归：现有平铺 spawn 行为不变 |
| `test/e2e-org-supervise.mts`（真实 pi）| lead 真实看汇报→动态生成子图→迭代监督，ground-truth 校验 tree.json 的 round 层级 |

---

## 7. 验收

- `npm run typecheck` clean；`npm test` 全绿；现有 spawn/Context Tree 测试**零回归**。
- e2e：`org-supervise` 真实跑通——tree.json 出现 `lead → round-1 → {子图节点} → round-2 → ...` 的多回合层级，且每回合子图带依赖正确执行。
- 文档：SKILL.md 能让作者照着写出一个"组织监督"流程。

---

## 8. 明确不在本轮范围（后续 horizon）

- **父进程常驻 + 实时双向回调**（§1 否决的路径）——除非出现"父级必须在子级运行中途介入"的真实需求。
- **跨 run 的组织记忆**（上一个 run 的监督决策影响下一个）。
- **子级主动向父级请求资源/澄清**（双向对话，非单向汇报）。
- **运行中 pause / 人工介入某个回合**（可与现有 `approval` phase 组合，不在本轮）。

---

## 9. 与已落地的 `flow{def}` 的关系（给读过那份设计的人）

| | `flow{def}`（已落地） | 本设计 |
|---|---|---|
| 谁生成图 | 上游 phase 一次性生成，下游 flow 执行 | 子级 `ctx_spawn` 生成子图 / 父级每回合生成 |
| 迭代 | 靠 `loop`+`flow{def}` | 缺口 B 的 `supervise`/loop 闭环 |
| 数据流 | `{steps.X.json}` 插值 | Context Tree 的 `ctx_report` 摘要 |
| 复用 | — | **直接复用** `normalizeInlineDef`/`validateTaskflow`/`verifyTaskflow`/嵌套 `executeTaskflow` |

> 本设计 ≈ 把 `flow{def}` 的「运行时生成并验证 DAG」能力，接到 Context Tree 的「子级派生 + 向上汇报」通道上，形成**组织式的递归协作**。绝大部分是组合既有机制，新代码集中在「assignment 接受 subflow」+（可选）「supervise 回合循环」两处。
