# 项目复盘 · DeadCells_Refactor

> 用途：面试前 review 用。每条都按「现象 → 根因 → 修法 → 面试会怎么追问」组织。
> 来源：本仓库 `docs/代码评审报告.md`（2026.07 自评）+ README 开发日志。
> 勾选方式：讲得出来就打 `[x]`。

## 0. 项目一句话（开场必须有）

面向 Unity 客户端岗的 2D 动作游戏 Demo，**94 个 C# 文件 / 约 7900 行 + 24 个 Lua 文件 / 约 860 行**，
可完整出包运行（Windows），玩法闭环：主菜单 → 关卡 → 战斗 → 商店 → 背包 → 飞行 Boss → 通关/重开。

**两个重点**：

1. **底层架构**——玩家行为逻辑完全 Lua 化（xLua 热更新），三层并行 HFSM；

2. **手感调优**——打击感 / 跳跃 / Boss 节奏。

> ⚠️ 答题纪律：**先给结论，再给依据**。不要从"我这个项目比较简单"开头 —— 你自己先贬低，面试官就会顺着贬低。

---

## 1. 面试官视角：先说亮点，再等追问

下面 5 条是**主动要说的**（评审报告里的"亮点"）。每条后面跟着的追问才是重点。

- [ ] **组件拆分彻底**：`PlayerController` 是纯编排器，输入/移动/血量/战斗/特效全部下放组件，消除 God Class

  - 追问：拆分依据是什么？拆太细的代价？

  - 答：按**变化原因**拆，不按功能拆。同一处修改只碰一个文件。代价是组件间通信变多，用事件总线 + 接口收口。

- [ ] **HFSM 三层并行是真实落地**：BASE 常驻 + ACTIVE 并行 + ABNORMAL 独占；`MUTEX/ALLOW` 并存策略、跨层切换返回值约定（`string` / `{layer,name}`）是完整的调度语义，不是玩具

  - 追问：为什么三层，两层不够吗？（见 Q2）

- [ ] **热更链路完整**：C# Bridge（`PlayerLuaBridge`）→ Lua 状态机 → 状态文件；新增状态纯 Lua 侧完成，不用重新出包。有 `LuaVerifyMenu` 编辑器验证工具

  - 追问：为什么用 Lua 而不是纯 C#？代价是什么？

  - 答：**收益**是改战斗数值/行为不用出包（手游审核周期长）。**代价**是每帧跨语言调用有装箱开销、调试链路变长、类型不安全。所以只把**高频改动**的逻辑（玩家状态机）放 Lua，稳定的框架留 C#。

- [ ] **性能意识到位**：`OverlapCircleNonAlloc` 复用 buffer、对象池软上限、`WaitForSecondsRealtime` 规避 HitStop 死锁、`static readonly WaitForSeconds` 避免协程分配

  - 追问：`static readonly WaitForSeconds` 为什么能避免分配？（见 Q6）

- [ ] **事件解耦**：UI / 血量 / 死亡通过 `EventCenter` 通信，无直接类引用

---

## 2. 九个真实 bug（这是你区别于"教程项目"的地方）

> 面试时**不要**一口气全讲。挑 2-3 个说透，其余等追问。
> 这 9 个的价值在于：**它们是只有亲手写过的人才会遇到的**。

### P0-1【崩溃】HFSM 跨层切换 `{}` 崩溃

- **现象**：受击结束（贴地）时崩溃

- **根因**：`hurt.lua` 返回 `{}`，`ResolveNext` 对 table 执行 `ChangeState(next.layer=nil)` → `layers[nil]` 索引崩溃

- **修法**：把 `{}` 语义定义为「**仅清空本层，回 BASE 当前状态，不额外切换**」；只有 `next.layer` 存在才执行跨层切换

- **追问**：为什么用 `{}` 而不是 `nil` 或直接返回 BASE 状态名？

  - 答：`nil` 无法区分"没给返回值"和"显式要求清空"；直接返回状态名会把"清本层"和"切到某个状态"耦合在一起。`{}` 是一个**显式的空意图**，语义独立。

- [ ] 讲得出来

### P0-2【功能缺失】MUTEX 输出锁从未真正生效

- **现象**：冲刺实际失效（速度被瞬间覆盖）

- **根因**：dash 期间 BASE 层（ground/air）**每帧无条件**写 `SetVelocityX`，把冲刺速度覆盖；而 MUTEX 锁只包住 `active.LogicUpdate` 一瞬，没有作用

- **修法**：HFSM 帧首计算 `mutexActive` → 调 `base.current.SetOutputLocked(core, mutexActive)`；ground/air 用 `outputLocked` 门控抑制位移/跳跃/攻击输出，**但落地/贴墙检测照常运行**

- **这是最能讲的一处**，因为它体现了"物理事实不该被状态锁屏蔽"这个判断

- **追问**：为什么锁住输出还要保留检测？

  - 答：**"落地"是物理事实，不是状态输出。** 锁住输出是为了不让 BASE 层的速度覆盖冲刺；但落地检测如果也被跳过，冲刺中落地就检测不到，状态机会卡在 air。

- [ ] 讲得出来

### P0-3【功能缺失】冲刺冷却从未计时

- **现象**：可以无限连冲

- **根因**：`DashCooldownTimer` 无任何地方设置/递减

- **修法**：`dash.Enter` 设 `DashCooldownTimer = dashCooldown`；ground/air 每帧递减（**锁定期间也递减**）

- **追问**：为什么锁定期间还要递减？

  - 答：冷却走的是**真实时间**，不该被状态锁暂停。否则冲刺后立刻受击，冷却会被"冻结"住，恢复后还要重新等。

- [ ] 讲得出来

### P0-4【功能缺失】跳跃预输入从未被消费（死代码）

- **现象**：C# 侧维护了 `JumpBufferTimer`，但跳跃没变灵敏

- **根因**：所有状态只查 `JumpDown`（单帧），**缓冲功能是死代码**

- **修法**：`ground.lua` 跳跃条件改成 `JumpBufferTimer > 0`

- **这条值得讲**：它说明**"写了功能"和"功能生效"是两件事**

- **追问**：你怎么发现它是死代码的？

  - 答：review 时顺着"这个字段谁读谁写"追了一遍，发现只有写没有读。

- [ ] 讲得出来

### P0-5【功能缺失】受击未接入 HFSM ABNORMAL 层

- **现象**：`hurt.lua` 存在但从未被激活，ABNORMAL 层空转

- **根因**：`luaChangeState` 在 Bridge 里从未被调用；受击只靠 `PlayerController.Update` 的 `IsHurting` 短路

- **修法**：`EventCenter` 加 `PlayerHurt` 事件 → `PlayerHealth.TakeDamage` 广播 → `PlayerLuaBridge` 订阅并 `ChangeState(3, "hurt")`；同时修正 `PlayerController.Update`：**输入先 Tick 再短路**

- **副产品 bug**：受击期间输入被冻结，导致受击结束残留 `JumpDown`

- **追问**：那个"残留 JumpDown"是怎么产生的？

  - 答：短路在 Tick 之前，输入状态机整段时间没更新。松开跳键的事件没被消费，恢复后仍读到旧的按下状态。

- [ ] 讲得出来

### P0-6【多实例 bug】敌人 Lua 状态共享模块级变量

- **现象**：两只敌人同时攻击时计时器互相覆盖

- **根因**：Lua 状态表是 `require` 缓存的**单例**，`local timer` 被所有敌人共享

- **修法**：5 个状态模块改为导出**工厂函数**，`enemy_fsm.Init` 为每只敌人调 `factory()` 产出独立状态实例（闭包持有各自 timer）

- **追问**：为什么玩家侧不用工厂，敌人侧要？

  - 答：玩家只有一个实例，单例状态安全；敌人有多个。这是**"状态实例化 vs 单例"的取舍**，取决于实例数。

- **这是很亮的一条**：它同时体现 Lua 模块语义 + 多实例思考

- [ ] 讲得出来

### P0-7【不一致】Lua 接管时敌人受击仍走 C# 状态机

- **现象**：`useLuaFSM=true` 时敌人受击硬直无效

- **根因**：C# 的 `StateMachine.ChangeState(hurtState)` 仍在执行，但 C# 状态机已不被 Update 驱动

- **修法**：`useLuaFSM` 时改调 `EnemyLuaBridge.ChangeState("hurt")`

- **追问**：为什么会同时留两套状态机？

  - 答：迁移是渐进的——先让玩家走 Lua 验证架构，敌人保留 C# 保证可玩。这是**"可运行的中间状态"**，但也带来双路径不一致的风险，所以要有 `useLuaFSM` 这样的显式开关。

- [ ] 讲得出来

### P0-8【出包隐患】xLua 反射回退仅编辑器可用

- **现象**：编辑器里正常，**IL2CPP 打包后 Lua 调 C# 直接失败**

- **根因**：只有两个 Bridge 有 `[LuaCallCSharp]`，其余靠 xLua 编辑器的反射回退（`ObjectTranslator` 打印 "not gen, using reflection instead"）；打包时反射回退被裁剪

- **修法**：给 `PlayerController / PlayerMovement / PlayerInput / PlayerCombat / PlayerHealth / PlayerEffect / Enemy` 补 `[LuaCallCSharp]`，出包前跑 `XLua/Generate Code`

- **追问**：xLua 为什么要生成代码？反射不行吗？

  - 答：IL2CPP 下 AOT 裁剪会移除未被静态引用的类型，反射拿不到；且反射调用有装箱与查表开销。生成代码是**静态绑定**，既能过裁剪又快。

- ⚠️ **这条直接关系到"可出包运行"这句话** —— 出包前必须确认跑过 CodeGen

- [ ] 讲得出来

### P0-9【存档 bug】武器读取失败清空武器栏

- **现象**：读档后空手

- **根因**：武器资源在 `Assets/Data/Weapons`（**非 Resources**），`Resources.Load("Weapons/...")` 必然失败；而原逻辑**先 `Clear()` 再加载**

- **修法**：先完整加载到临时列表，**成功才整体替换**；失败仅告警不破坏现状

- **追问**：为什么先 Clear 是错的？

  - 答：它把"加载失败"变成了"数据被清空"。**破坏性操作必须在确认新数据可用之后再做** —— 这条原则比这个 bug 本身重要。

- **这条和 Addressables 是同一条线**：事后看，正确解法是换 Addressables 加载（见下文弱点表 P2-5）

- [ ] 讲得出来

---

## 3. 弱点与应答话术（面试官会追问的）

> 评审报告原文提醒：「**必须准备好话术**」。**主动说比被问出来强** —— 主动说是"我知道 trade-off"，被问出来是"他没考虑到"。

| # | 弱点 | 怎么答 |
|---|---|---|
| 1 | `PlayerController` 直接暴露给 Lua（无 Facade） | 承认：**应该加 Facade 收口**。现状是 Lua 直接持有 core 引用，好处是少一层转发、坏处是 Lua 侧能碰到不该碰的成员。改进方向是把 Lua 可见面收敛成一组显式方法。 |
| 2 | 跨语言调用每帧装箱 / GC | `LuaFunction.Call` 返回 `object[]`。**方案**：缓存强类型 delegate（`GetAction<PlayerController>`）、或把移动参数打包成结构体一次传入。**说清方案**比说"以后优化"强。 |
| 3 | xLua 反射回退（未生成代码） | 见 P0-8。**已加 `[LuaCallCSharp]`**，出包前跑 CodeGen。 |
| 4 | 用旧 Input Manager（`Input.GetAxisRaw`），没用新 Input System | 说明是 URP 2D 模板默认。**迁移方案**：建 InputAction 资产，`PlayerInput.Tick` 接口不变，上层无感。 |
| 5 | Addressables 包未安装，`AddressablesLoader` 走 `#else` 分支 | ⚠️ **简历表述必须同步**。要么装包跑通，要么别说"掌握"。**最好装通** —— 你有 AB 包手敲的真实经历，两个阶段都能讲。 |
| P2-1 | `EventCenter` 用字符串事件名 | 运行时拼写错误无编译期检查。演进为 `static class GameEvents` 常量或类型安全事件表。**主动说"I know the trade-off，demo 规模下字符串更灵活"**。 |
| P2-2 | Lua→C# 每帧 `Call(player)` 装箱 | 同弱点 2 |
| P2-3 | 状态对象为模块级单例（玩家侧） | 单玩家下安全；双人/镜像会互相污染。见 P0-6 的取舍。 |
| P2-4 | 旧 Input Manager | 同弱点 4 |
| P2-5 | Addressables 未安装 | 同弱点 5 |
| P2-6 | `Projectile.DestroyProjectile` 命中特效 `Instantiate` 未走池 | 低频对象，可接受。答：**"高频才需要池"** —— 池化本身有成本（见对象池笔记第 3 节）。 |
| P2-7 | 敌人 `CanSeePlayer` 无视线遮挡检测 | 现在只有距离+高度。加 `Physics2D.Raycast` 做遮挡判定即可，**这是个好讲的小改进**。 |
| P2-8 | `BTConfig` 无环检测 | 编辑器里拖出环会栈溢出。加编译期 DFS 环检测。**面试加分小功能**。 |
| P2-9 | `SaveManager` 全场景 `FindObjectsByType` | 规模小可接受。答：**"按接口收集 `ISaveable` 是解耦设计"**。 |
| P2-10 | `HFSM.ChangeState` 同帧多次切换不合并 | 延迟切换 + 帧末合并是 V2 方向。 |
| P2-11 | `PlayerHealth` 受击无敌帧仅 0.2s 硬直 | 受击状态本身就是无敌帧；要更细可加 `invincibleDuration` 配置。 |
| P2-12 | `wall_slide` 无输出锁实现 | 冲刺撞墙会进墙滑并打断冲刺（手感可接受）。要严格互斥就给 `wall_slide` 也实现 `SetOutputLocked`。 |

---

## 4. 高频追问（提前想好，别现场编）

- [ ] **Q1：为什么玩家的行为逻辑放 Lua，不用 C#？**
  收益 / 代价都要说（见亮点 3）。核心：**只把高频改动、且不涉及性能热点的逻辑放 Lua**。

- [ ] **Q2：为什么三层 HFSM？两层不够吗？**
  BASE 需要"永远有一个当前状态"（走/跳/爬）；ACTIVE 是**瞬态且与 BASE 并行**（攻击时还能移动，冲刺时锁移动）；ABNORMAL 是**独占且要冻结其他层**（受击）。
  **两层无法同时表达"并行"和"独占"** —— 硬塞会导致状态爆炸。

- [ ] **Q3：同帧多次状态切换怎么处理？**
  现状不合并。V2 方向：延迟到帧末合并。

- [ ] **Q4：MUTEX 和 ALLOW 的区别？**
  MUTEX = 本层激活时**抑制**另一层的输出；ALLOW = 显式放行。
  关键设计：**只锁"输出"，不锁"检测"**（见 P0-2）。

- [ ] **Q5：`Feedback.Hit(pos, hitStop, shake, sfx, vfx)` 为什么要做成统一入口？**
  命中反馈原本散落在近战/激光/弹幕/陷阱/被击**七八个地方**，各写一遍必然漏 —— 原来就是"近战有顿帧但没震动没音效"。收敛成一个入口后，加一种反馈只改一处。

- [ ] **Q6：`static readonly WaitForSeconds` 为什么能避免分配？**
  `yield return new WaitForSeconds(1f)` 每次执行都 new 一个对象 → GC。缓存成 `static readonly` 字段后全程复用同一个实例。

- [ ] **Q7：HitStop 为什么用 `WaitForSecondsRealtime` 而不是 `WaitForSeconds`？**
  HitStop 的实现通常是 `Time.timeScale = 0`。而 `WaitForSeconds` **受 timeScale 影响** → timeScale 为 0 时它永远不结束 → **协程卡死，逻辑死锁**。`Realtime` 版本走真实时间，不受影响。

- [ ] **Q8：为什么自研 `CameraShake` 而不用 Cinemachine？**
  原先用 `CinemachineImpulseSource`，但**场景里没有 Cinemachine** —— `GenerateImpulse()` 调了完全没效果**也不报错**。自研版零依赖：Perlin 噪声 + 平方衰减。
  **这条特别值得讲**：它说明你会怀疑"静默失败"而不是以为"代码没生效就算了"。

- [ ] **Q9：对象池为什么用队列？池上限怎么定？**
  队列/栈入出都是摊销 O(1)（见对象池笔记）。上限是**软的**：超过上限的对象直接销毁而不是无限囤积 —— 池会持有引用、阻止 GC，囤太多反而变成内存泄漏。

- [ ] **Q10：如果同屏敌人 ×10，哪里会先崩？**
  **必须能答**。候选答案：`CanSeePlayer` 的距离检测（每敌人每帧）、状态机 tick（Lua 跨语言调用 × 敌人数的装箱开销）、以及 `OverlapCircleNonAlloc` 的 buffer 是否够大。**先说哪个最先到瓶颈，再给对策**（分帧错峰检测 / 把 AI 逻辑移回 C# / 加空间划分）。

---

## 5. 收尾：这个项目的"一句话总结"

> 它是一个**能跑完整闭环**的 2D 动作 Demo，我重点做了两件事：
> **把玩家行为逻辑搬进 Lua 做成三层并行 HFSM**（讲清收益与代价），
> 以及**调打击手感**（顿帧/震屏/跳跃缓冲，并且知道每一处为什么这么做）。
> 过程中修掉了九个真实缺陷，其中"冲刺输出锁从未生效"和"多敌人共享模块级 timer"这两个，
> 让我真正理解了状态机的互斥语义和 Lua 模块的单例陷阱。

---

## 相关

- 项目地址：https://github.com/cjrapper/DeadCells_Refactor

- 源码内文档：`docs/代码评审报告.md`、`docs/开发任务/功能复盘_设计取舍.md`

- ⚠️ README 里 B 站演示视频那一行还是占位符，**上传后记得替换**
