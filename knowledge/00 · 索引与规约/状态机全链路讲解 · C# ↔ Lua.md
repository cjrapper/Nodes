# 状态机全链路讲解 · C# ↔ Lua

> 这篇是**讲解**，不是考点。目标：读完能自己复述出"谁驱动谁、锁怎么生效、Facade 到底是什么"。
> 所有代码都是你仓库里的真实代码，行号可对照。
> 复习时按「机制 → 代码 → 为什么 → 能带走的原则」四层看，卡住哪层就停在哪层。

## 0. 先给一句话总览（记住这个骨架，细节都能挂上去）

```
Unity 引擎
   │ 每帧调 Update()
   ▼
PlayerLuaBridge.Update()          ← C# 侧唯一的"驱动入口"
   │ luaLogicUpdate.Call(player)  ← 把 C# 的 player 对象**作为参数**交给 Lua
   ▼
HFSM.LogicUpdate(core)            ← Lua 侧的调度器，core 就是那个 player
   │ 按固定顺序跑三层
   ▼
ground.lua / dash.lua / hurt.lua  ← 各自逻辑，通过 core 调 C# 能力
```

**一句话：C# 负责"每帧发起"，Lua 负责"决定做什么"，C# 提供"能做什么"。**

你自己那三个问题的答案就在这张图里：

- **"也是 hfsm 驱动吗？"** → 是。`HFSM.LogicUpdate` 就是驱动者，它按层调度。

- **"每次返回一个 table？"** → 状态可以返回 `nil` / 字符串 / table，三种含义不同（见第 3 节）。

- **"传递 C# 对象靠谁？"** → 靠 **`luaLogicUpdate.Call(player)`** 这一句参数传递，配合 `[LuaCallCSharp]` 让 Lua 能真的调到它。

---

## 1. 你记忆里那个"老状态机"确实存在——在敌人侧

你说"最初是普通状态机，state 基类和 Machine，用 Machine 驱动"。**这段记忆是准的**，代码还在：

`Assets/_Scripts/Enemy/EnemyState.cs`（27 行，就是你说的基类）：

```csharp
public class EnemyState //基础状态类
{
    protected Enemy enemy;
    protected EnemyStateMachine stateMachine;

    public virtual void Enter() { }
    public virtual void Exit() { }
    public virtual void PhysicsUpdate() { }
    public virtual void LogicUpdate() { }
}
```

`Assets/_Scripts/Enemy/EnemyStateMachine.cs`（34 行，就是那个 Machine）：

```csharp
public void ChangeState(EnemyState newState)
{
    CurrentState?.Exit();      // ① 旧的先退出
    CurrentState = newState;   // ② 换指针
    CurrentState.Enter();      // ③ 新的进入
    enemy?.PlayStateAnim(newState.AnimName);
}
```

**对照你的记忆**：你说"进入、切换、退出，就这些"——就是 `Enter` / `ChangeState` / `Exit`。"派生类每次先退出，再切换"——就是 `ChangeState` 里的 `① → ② → ③` 顺序。**你记得没错。**

敌人侧现在仍是这套，12 个 `XxxState.cs` 派生自 `EnemyState`。

### 玩家侧为什么改成 Lua HFSM

你自己给的三个理由里，有两个说对了，一个理解偏了：

| 你的说法 | 判定 |
|---|---|
| "改状态很繁琐，牵一发而动全身" | ✅ 对，这正是下面讲的"状态爆炸" |
| "PlayerController 太冗余，六七百行" | ✅ 对，**现在 282 行**——你确实把它拆掉了 |
| "状态爆炸 = 状态太多，避免状态切换不过来" | ⚠️ **方向偏了**，见下 |

### 「状态爆炸」到底是什么（这里是你的知识盲区，讲透）

**不是"状态太多跑不过来"。而是"状态数量随维度相乘增长"。**

老式 FSM 的规矩是：**每个状态必须显式列出它能转到哪些状态。**

现在你有三个**互相独立的维度**：

```
地面/空中/爬梯      （移动维度，3 种）
攻击/冲刺/无动作    （动作维度，3 种）
正常/受击          （受击维度，2 种）
```

如果用一个平坦 FSM 表达，你必须为**每一种组合**建一个状态，因为
"空中攻击时可以二段跳但受击要打断"和"地面攻击时不能跳"是两套不同逻辑：

```
地面_无动作   地面_攻击   地面_冲刺   地面_受击
空中_无动作   空中_攻击   空中_冲刺   空中_受击
爬梯_无动作   爬梯_攻击   爬梯_冲刺   爬梯_受击
```

**3 × 3 × 2 = 18 个状态。** 而你加一个"眩晕"维度就变成 27 个，加一个"游泳"就更多。
更糟的是**每个状态都要写自己的转场条件**——18 个状态之间的转场是 18 × 17 条潜在连线，
每加一个状态就要改一批已有状态的代码。这就是"牵一发而动全身"。

> **一句话判据**：如果你发现"状态名字里开始出现 `空中_攻击_受击` 这种拼接"，
> 就是状态爆炸了。

**HFSM 的解法：把独立的维度分成层，每层自己跑自己的 FSM，层之间用规则协调。**

```
BASE 层：ground / air / ladder        ← 只管"在哪"，3 个状态
ACTIVE 层：attack / dash              ← 只管"在做什么动作"，2 个状态
ABNORMAL 层：hurt                     ← 只管"有没有被打断"，1 个状态
```

**3 + 2 + 1 = 6 个状态**，而不是 18 个。加维度只加一层，**已有层一行不用改**。
这就是 `PlayerHFSM.lua` 里"爬梯是纯 Lua 新增状态，C# 零改动"能成立的原因。

**分层能成立的前提**：维度之间真的独立。如果"空中能不能攻击"和"地面能不能攻击"
规则完全不同，那 ACTIVE 层就需要知道 BASE 层是谁——那正交性就破了，
得引入"层间查询"来补，复杂度会回来。

---

## 2. HFSM 的四个文件、各自职责（理清你说的"结构理不清"）

```
Framework/Fsm/State.lua      27 行   状态工厂 + 两个枚举（不认识玩家）
Framework/Fsm/HFSM.lua      121 行   调度器（只做调度，也不认识玩家）
Logic/Player/PlayerHFSM.lua  15 行   注册表：把 6 个状态注册进去
Logic/Player/State/**/*.lua  ~11 个  具体状态（认识玩家，通过 core 调 C#）
```

**关键设计：前两个文件"不认识玩家"。** `HFSM.lua` 全文没有一处出现 `player` 字样，
它只操作 `layers` 和调 `state.LogicUpdate(core)`。这就是为什么它能被复用
（敌人侧也准备了 `enemy_fsm.lua`）。

### State.lua：状态是"一个 table"，不是"一个类"

```lua
function M.NewState(layer, name)
    return {
        layer = layer,
        name  = name,
        parallelMode = M.ParallelMode.ALLOW,   -- 默认并行，dash 改成 MUTEX
        Enter = function(core) end,
        Exit  = function(core) end,
        LogicUpdate  = function(core) return nil end,
        PhysicsUpdate = function(core) end,
        SetOutputLocked = function(core, locked) end,
    }
end
```

对照老 C# 基类，**一一对应**：

| C# `EnemyState` | Lua `NewState` | 说明 |
|---|---|---|
| `virtual void Enter()` | `Enter = function(core)` | C# 是虚方法覆写；Lua 是**字段赋值** |
| `virtual void Exit()` | `Exit = function(core)` | 同上 |
| `virtual void LogicUpdate()` | `LogicUpdate = function(core)` | 同上 |
| `virtual void PhysicsUpdate()` | `PhysicsUpdate = function(core)` | 同上 |
| `virtual string AnimName` | —（移到 C# 侧 PlayIdle/PlayMove） | Lua 不碰动画名 |
| — | `layer` / `name` / `parallelMode` | **Lua 版多出来的**，HFSM 调度需要 |

**为什么要工厂函数而不是直接写 table？** 因为 Lua 的 `require` 会缓存模块
（一个文件只执行一次），如果你在文件顶层直接 `return { ... }`，
那所有使用者拿到的是**同一个 table**。工厂函数保证每次调用产出新实例。

> 这一点直接连到你的 P0-6 bug：敌人状态用了 `require` 缓存的单例，
> 于是 `local timer` 被所有敌人共享。玩家只有一个实例所以没暴露，
> 但同样的坑在敌人侧炸了。

### HFSM.lua：`LogicUpdate` 的四步顺序（**顺序本身就是设计**）

```lua
function LogicUpdate(core)
    -- ① ABNORMAL 独占：有受击/死亡，BASE+ACTIVE 全冻结
    local abnormal = layers[State.StateLayer.ABNORMAL]
    if abnormal.current then
        ResolveNext(State.StateLayer.ABNORMAL, abnormal.current.LogicUpdate(core), core)
        return   -- 无论是否切换，本帧结束
    end

    -- ② ACTIVE 互斥预检：在 BASE 跑之前把锁的状态算出来
    local active = layers[State.StateLayer.ACTIVE]
    local mutexActive = active.current ~= nil
        and active.current.parallelMode == State.ParallelMode.MUTEX

    -- ③ BASE 先跑（检测落地/贴墙/跳跃输入；可跨层切 ACTIVE）
    local base = layers[State.StateLayer.BASE]
    if base.current.SetOutputLocked then
        base.current.SetOutputLocked(core, mutexActive)
    end
    local switched = ResolveNext(State.StateLayer.BASE, base.current.LogicUpdate(core), core)

    -- ④ ACTIVE 并行：BASE 刚切进 ACTIVE 的帧跳过，避免同帧误跑
    if active.current and not switched then
        local next = active.current.LogicUpdate(core)
        ResolveNext(State.StateLayer.ACTIVE, next, core)
    end
end
```

四个顺序点，每个都有理由：

**① 为什么 ABNORMAL 放最前还直接 `return`？**
受击是**最高优先级**。它一旦激活，BASE 和 ACTIVE 这一帧**完全不跑**——
不是"跑了但被忽略"，是根本不执行。这样"受击期间角色不能移动"是结构保证的，
不需要在每个状态里写 `if not isHurting`。

**② 为什么锁要在 ③ 之前算？**
见第 4 节，这是 P0-2 的核心。

**③ 为什么 BASE 先跑？**
BASE 会产生"跨层切换请求"（跳跃/攻击/冲刺都要切 ACTIVE）。
BASE 跑完才知道这一帧有没有切进 ACTIVE。

**④ 为什么 `not switched` 才跑 ACTIVE？**
如果 BASE 这一帧刚从 ground 切进 `attack`，那 `attack.Enter` 已经执行了。
此时如果立刻再调 `attack.LogicUpdate`，等于**同一个状态在同一帧里进入并运行了两次逻辑**——
`attack.lua` 里"起手帧"的判断会被跳过或被重复消费。
所以刚切进去的那一帧跳过，下一帧才开始跑。

---

## 3. 状态返回值：`nil` / 字符串 / table 三种含义

这是你问的"每次返回一个 table"的准确答案——**不是每次都返回 table，是三种返回值**。

`HFSM.lua` 的 `ResolveNext` 统一分发：

```lua
local function ResolveNext(ownerLayer, next, core)
    if next == nil then return false end              -- ① 停留
    if type(next) == "table" then                     -- ③ 跨层切换
        if ownerLayer ~= State.StateLayer.BASE then
            ChangeState(ownerLayer, nil, core)        --    先清空本层（Exit + current=nil）
        end
        if next.layer then
            ChangeState(next.layer, next.name, core)  --    再切目标层
        end
    else
        ChangeState(ownerLayer, next, core)           -- ② 同层切换
    end
    return true
end
```

| 返回值 | 含义 | 例子 |
|---|---|---|
| `nil` | 停留，什么都不做 | `ground.lua` 末尾 `return nil` |
| `"air"` | **同层**切换（BASE → BASE） | `ground.lua: return "air"` |
| `{layer=2, name="dash"}` | **跨层**切换（BASE → ACTIVE） | `ground.lua: return { layer = State.StateLayer.ACTIVE, name = "dash" }` |

### `{}`（空 table，layer 为 nil）为什么必须单独定义语义

这就是 P0-1 那个崩溃。看 `ResolveNext` 的 table 分支：

```lua
if ownerLayer ~= State.StateLayer.BASE then
    ChangeState(ownerLayer, nil, core)   -- ← 这一步就是"清空本层"
end
if next.layer then                        -- ← layer 是 nil，所以跳过
    ...
end
```

**`{}` 的语义是：只清空本层，回 BASE 当前状态，不做额外切换。** 这正是
"瞬态层结束"该有的行为（受击结束 → ABNORMAL 层清空 → 回到 BASE 的 ground/air）。

**修复前的 bug**：`ChangeState(next.layer, ...)` 在 `next.layer` 为 nil 时
会去索引 `layers[nil]` → Lua 报错崩溃。修法是加 `if next.layer then` 判断。

**为什么会漏这个判断？** 因为写的时候脑子里想的是"跨层切换要带 layer"，
没想到"清空本层"这个用法下 layer 天然就是 nil 的。**这是典型的
"设计了一个约定，但没定义约定的边界情形"。**

> **能带走的原则**：给接口定义"多种返回形态"时，**每一种形态的边界值都要显式定义**。
> `nil` / 空表 / 缺字段，分别是什么语义？不写清就一定会在某条路径上炸。

---

## 4. P0-2 深讲：MUTEX 锁到底锁什么（你说"一知半解"的那个）

### 先看错误直觉

冲刺时，**BASE 层还在每帧运行**。而 `ground.lua` 每帧都执行：

```lua
c:SetVelocityX(c.PlayerMovement.moveSpeed * c.InputX)
```

**它会把冲刺的速度直接覆盖掉。** 表现是：按了冲刺，角色却以走路速度前进。

所以直觉反应是：**"冲刺期间干脆别让 BASE 层跑。"**

**这个直觉是错的。** 因为 BASE 还干着另一件事：

```lua
-- ground.lua 末尾
-- 离开地面（锁定期间也检测：互斥中落地/离地切换是物理事实）
if not c:CheckGrounded() then
    return "air"
end
```

停掉 BASE 就等于停掉这条。后果：**冲刺冲出平台边缘时，状态机不知道角色已经离地**，
它会一直停在 `ground`。角色在空中却以为自己站在地上——跳跃、重力、落地全部错乱。

> **类比**：你要阻止有人在房间里按电梯按钮，于是把整栋楼的报警系统也关了。
> 但"楼塌了"这件事不归你管，**也不该被你锁住**。

### 正确的做法：只锁动作，不锁事实

看 `ground.lua` 的结构，分界线一目了然：

```lua
state.LogicUpdate = function(c)
    -- 第 1 段：冲刺冷却计时。【锁外面】
    if c.PlayerMovement.DashCooldownTimer > 0 then
        c.PlayerMovement.DashCooldownTimer =
            c.PlayerMovement.DashCooldownTimer - CS.UnityEngine.Time.deltaTime
    end

    if not state.outputLocked then
        -- 第 2 段：爬梯 / 移动 / 跳跃 / 攻击 / 冲刺。【锁里面】
        ...
        c:SetVelocityX(c.PlayerMovement.moveSpeed * c.InputX)
        if c.JumpBufferTimer > 0 then
            c:SetVelocityY(c.PlayerMovement.jumpForce)
            return "air"
        end
        ...
    end

    -- 第 3 段：离地检测。【锁外面】
    if not c:CheckGrounded() then
        return "air"
    end
end
```

**锁只包住第 2 段。** 第 1 段（冷却递减）和第 3 段（离地检测）在锁外面，照常跑。

### 锁是谁设的、什么时候设的

看 `HFSM.LogicUpdate` 的 ②③ 两步：

```lua
-- ② 先算锁的状态
local mutexActive = active.current ~= nil
    and active.current.parallelMode == State.ParallelMode.MUTEX

-- ③ 再跑 BASE —— 所以 BASE 在自己的 LogicUpdate 里能看到正确的锁
if base.current.SetOutputLocked then
    base.current.SetOutputLocked(core, mutexActive)
end
local switched = ResolveNext(..., base.current.LogicUpdate(core), core)
```

`SetOutputLocked` **本身什么都不抑制**，它只做一件事：

```lua
state.SetOutputLocked = function(c, locked)
    state.outputLocked = locked    -- 只是塞一个标志位
end
```

真正抑制动作的是 ground 里那个 `if not state.outputLocked then`。

**所以"帧首计算"是必须的**：如果先跑 BASE 再算锁，冲刺的第一帧 BASE 还是按
旧锁状态跑的——冲刺速度第一帧就被走路速度覆盖，锁等于没用。

### `parallelMode` 在哪里被设成 MUTEX

```lua
-- dash.lua
state.parallelMode = State.ParallelMode.MUTEX   -- 冲刺与 BASE 互斥
```

`attack.lua` 保持默认的 `ALLOW` —— 因为**攻击时应该能移动**（很多动作游戏都允许），
冲刺才需要锁位移。

> **能带走的原则**：互斥锁的粒度是"**输出/动作**"，不是"整个模块"。
> 一个模块同时干着"做决定"和"观察世界"两类事时，**锁前一类，永远别锁后一类**。
> 判断方法：问自己"**这件事如果被锁住不执行，系统会对现实产生错误的认知吗？**"
> 会 → 不能锁。
>
> 这个原则可以搬：网络同步里锁玩家输入但**不能锁延迟测量**；
> 加载系统里锁资源请求但**不能锁进度回传**。

---

## 5. 「Facade」到底是什么（你最后那个问题）

你先回忆的原文：

> 刚创建 lua 状态机时很多时候需要调用 c# 的对象，但是为了确保安全性，避免乱调用，
> 后续我是记录了那些常调用的字段，将他们封装成 face 接口……我现在忘了这个传递
> c# 侧对象的是靠谁了，是不是跟 luabridge 也有关系？

**答案：两个都有关，但它们是两件事。** 我按"谁传物件 → 凭什么能调 → 白名单在哪"讲。

### 第一件事：C# 对象是怎么进到 Lua 里的

`PlayerLuaBridge.cs` 三个关键点：

```csharp
// ① Awake 里拿到自己身上的 PlayerController 组件
private void Awake()
{
    player = GetComponent<PlayerController>();
}

// ② InitLua 里加载 Lua 模块，取出函数引用
private void InitLua()
{
    var ret = LuaManager.DoString("return require 'Logic.Player.PlayerHFSM'");
    var hfsm = ret[0] as LuaTable;
    luaLogicUpdate = hfsm.Get<LuaFunction>("LogicUpdate");
    ...
}

// ③ Update 里每帧调用，把 player **作为参数**传进去
private void Update()
{
    luaLogicUpdate?.Call(player);      // ★ 就是这一句
}
```

对应的 Lua 侧，`HFSM.lua` 的形参就叫 `core`：

```lua
function LogicUpdate(core)          -- core 就是那个 player
    ...
    base.current.LogicUpdate(core)  -- 传给具体状态
end
```

**所以"传递 C# 对象靠谁"的答案是：靠 `luaLogicUpdate.Call(player)` 这一句参数传递，
发起方是 `PlayerLuaBridge`。**

Lua 侧收到它之后，写 `c:SetVelocityX(...)`、`c.PlayerMovement.DashCooldownTimer`，
xLua 会把 `c` 当成一个 **userdata 包装的 C# 对象**，按名字去调它的成员。

### 第二件事：凭什么 Lua 能调到它 —— 这就是你说的"Facade"

`PlayerController.cs` 里有一段注释写得非常明确：

```csharp
// ==================== 对外接口（给 FSM 状态和外部调用）====================
public bool CheckGrounded() => ...;
public void SetVelocityX(float x) => PlayerMovement?.SetVelocityX(x);
public void SetVelocityY(float y) => PlayerMovement?.SetVelocityY(y);
public void CheckFlip() => PlayerMovement?.CheckFlip(InputX);
public void StartPlatformDrop() => PlayerMovement?.StartPlatformDrop();
public void ConsumeJumpBuffer() => PlayerInput?.ConsumeJumpBuffer();
public bool CanAttack() => PlayerCombat != null && PlayerCombat.CanAttack();
public void Attack() => PlayerCombat?.Attack();
```

**这一段就是你记忆里的"Facade"。** 它不是单独一个类，而是 `PlayerController` 上
一组**专门为 Lua 准备的公开方法/属性**。效果是：

- Lua 只写 `c:SetVelocityX(v)`，**不需要知道** `PlayerMovement` 是哪个组件、`Rb` 怎么拿；

- `PlayerMovement` 改名/重构，只要改 `PlayerController` 这一行转发，**Lua 一行不用动**；

- 你"记录了那些常调用的字段"——指的就是这批转发方法。

数据类的成员也一并收口：

```csharp
public PlayerInput PlayerInput { get; private set; }
public PlayerMovement PlayerMovement { get; private set; }
public PlayerHealth PlayerHealth { get; private set; }
public PlayerCombat PlayerCombat { get; private set; }
public PlayerClimb PlayerClimb { get; private set; }
public Rigidbody2D RigidBody => PlayerMovement != null ? PlayerMovement.Rb : ...;
public float InputX => PlayerInput != null ? PlayerInput.InputX : 0;
```

**注意 `{ get; private set; }`**：Lua 能读、不能写。这就是"避免乱调用"的实现方式。

### 第三件事：`[LuaCallCSharp]` —— 让上面这些真的能被调到

```csharp
[LuaCallCSharp]
[DefaultExecutionOrder(-100)]
public class PlayerController : MonoBehaviour, ISaveable
```

以及 `PlayerLuaBridge` 自己也标了 `[LuaCallCSharp]`。

**这个标记做什么**：xLua 默认靠**反射**去调 C#，编辑器里能用，但打 IL2CPP 包时
反射回退会被裁剪 → **Lua 调 C# 直接失败**。标了 `[LuaCallCSharp]` 之后，
执行 `XLua/Generate Code` 会为这些类型生成**静态绑定代码**，既能过裁剪又更快。

**修 P0-8 时你做的就是补这个标记**（给 `PlayerController / PlayerMovement /
PlayerInput / PlayerCombat / PlayerHealth / PlayerEffect / Enemy` 都补上）。

> **⚠️ 所以"能跑"和"能出包"是两件事**：
> 编辑器里靠反射一切正常 → 你会以为没问题；
> 出包后 IL2CPP 裁剪掉回退 → Lua 调 C# 崩。
> 这就是为什么**出包前必须跑一次 `XLua/Generate Code`**。

---

## 6. 三个概念的关系图（把上面全部串起来）

```
┌─────────────────────────── C# 侧 ───────────────────────────┐
│                                                             │
│  PlayerController  (281 行，编排器)                          │
│    ├─ PlayerInput / PlayerMovement / PlayerHealth / ...      │
│    └─ ★ Facade 段：public 转发方法 + {get; private set;} 属性 │
│         ↑ Lua 只能碰这一层                                    │
│                                                             │
│  PlayerLuaBridge  (203 行)                                   │
│    ├─ Awake: player = GetComponent<PlayerController>()       │
│    ├─ InitLua: require Lua 模块 → 取 LuaFunction             │
│    └─ Update: luaLogicUpdate.Call(player)   ← 驱动入口 ★     │
│                                                             │
│  LuaManager: LuaEnv 的唯一持有者                              │
│  [LuaCallCSharp] + XLua/Generate Code → 出包可用的静态绑定 ★ │
└─────────────────────────────────────────────────────────────┘
                            │ 每帧传 player
                            ▼
┌─────────────────────────── Lua 侧 ──────────────────────────┐
│                                                             │
│  PlayerHFSM.lua (15 行)  注册 6 个状态 → return HFSM         │
│                                                             │
│  HFSM.lua (121 行)  调度器，不认识玩家                        │
│    LogicUpdate(core) 四步：                                   │
│      ① ABNORMAL 独占 → return                                │
│      ② 算 mutexActive                                        │
│      ③ SetOutputLocked + BASE 先跑                           │
│      ④ ACTIVE 并行（not switched）                           │
│    ResolveNext: nil / "name" / {layer=,name=} 三种返回        │
│                                                             │
│  State.lua (27 行)  工厂 + 枚举（StateLayer / ParallelMode）  │
│                                                             │
│  State/Base/ground.lua (97 行)  etc.                         │
│    第1段（锁外）冷却 → 第2段（锁内）动作 → 第3段（锁外）检测 ★ │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. 面试怎么讲这一块（一句话版本 + 追问预案）

**主叙述**：

> 玩家的行为逻辑从 C# 状态机重构成了 Lua 三层并行 HFSM。
> 动机是老式平坦 FSM 的状态爆炸——移动、动作、受击三个正交维度相乘，
> 18 个状态且转场条件互相耦合。分层之后是 3+2+1 个状态，加维度只加一层。
> C# 侧只留一个 `PlayerLuaBridge` 做驱动，每帧把玩家对象作为参数传给 Lua；
> Lua 通过 `PlayerController` 上的一组转发方法操作玩家，Lua 侧不碰具体组件。

**三个必被追问 + 答法**：

| 追问 | 答法骨架 |
|---|---|
| 为什么锁位移不锁整个 BASE 层？ | 因为 BASE 还负责落地检测，那是**物理事实不是动作**。锁了它，冲刺冲出平台边缘时状态机会以为还在地上。（P0-2） |
| Lua 调 C# 的安全性和性能怎么保证？ | 安全靠 `PlayerController` 上的 Facade 转发 + `{get; private set;}` 只读；性能靠 `[LuaCallCSharp]` 生成静态绑定，避免反射与 IL2CPP 裁剪。**出包前必须跑 CodeGen**，否则编辑器正常、出包崩。（P0-8） |
| 这个 HFSM 你自己设计的？ | 参考了公司的状态机思路，三层划分与 MUTEX 语义是按本项目需要定的。然后立刻给细节（上面任一条）。**诚实 + 细节 = 可信。** |

**一条自我保护的话**：

> Lua 侧每个状态文件只有 60~100 行，因为 C# 侧已经把"能做什么"收口成了方法。
> 如果 Lua 直接操作 `Rigidbody2D`，状态文件会膨胀成什么样你可以想象。

---

## 8. PlayerLuaBridge 到底是什么（跨语言边界的必然产物）

> 这一节补的是"我没写过它，所以对它困惑"这个缺口。
> 结论先说：**它不是架构需要，是"用 Lua"的代价。它的全部职责只有一件事 —— 每帧调 Lua。**

### 8.1 世界上有两个不互通的世界

```text
┌──────────────── C# 世界 ────────────────┐
│  Unity 引擎每帧调 Update()               │
│  PlayerController / PlayerMovement / …   │
│  ← 这里的一切都是 C#，引擎认识            │
└──────────────────────────────────────────┘
              ★ 边界：Lua 世界在这里开始 ★
┌──────────────── Lua 世界 ────────────────┐
│  HFSM.lua / ground.lua / dash.lua        │
│  ← Unity 引擎完全不认识这里               │
└──────────────────────────────────────────┘
```

**关键点：MonoBehaviour.Update() 是 C# 的机制，Lua 里没有这个东西。**
Lua 是被 C# 主动调用的脚本环境 —— **它自己不会"每帧醒来"**。

所以必须有一个组件：① 挂在 GameObject 上（Unity 才会每帧调它）② 在自己的
Update() 里去调 Lua。**那个人就是 PlayerLuaBridge。**

### 8.2 它做的四件事

| 时机 | 做什么 | 代码 |
|---|---|---|
| Awake | 拿到 PlayerController 引用 | `player = GetComponent<PlayerController>();` |
| Start | 加载 Lua 模块，**缓存函数引用** | `luaLogicUpdate = hfsm.Get<LuaFunction>("LogicUpdate");` |
| Update | 每帧调一次 | `luaLogicUpdate?.Call(player);` |
| OnDestroy | `Dispose()` 掉函数引用 | 防止 Lua 环境已销毁还去用（会抛 "this lua env had disposed!"） |

**为什么缓存 LuaFunction 而不是每帧 DoString？**
每帧按名字去 Lua 里查一次函数 = 每帧做一次字符串查表。缓存后每帧只是一次委托调用。

### 8.3 反证：不用 Lua 就不需要 Bridge

敌人侧那套是老版本，纯 C#：`EnemyStateMachine.ChangeState()` 直接调，**没有中间层**。

所以 Bridge 换来的是"改状态不用重新编译出包"，代价就是这一层 + 跨语言调用开销。

> **面试可以这么讲**：
> "Bridge 是跨语言边界的必然产物。Unity 的 Update 是 C# 机制，Lua 自己不会每帧醒来，
> 所以需要一个 C# 组件持有 Lua 函数引用并驱动它。我让它只做驱动、不做业务 ——
> 业务全在 Lua 状态里，C# 只提供能力。"

### 8.4 顺带：DefaultExecutionOrder(-100) 是干什么的

```csharp
[LuaCallCSharp]
[DefaultExecutionOrder(-100)]
public class PlayerController : MonoBehaviour, ISaveable
```

Unity **不保证**多个 MonoBehaviour 的 Update() 谁先执行。如果
PlayerLuaBridge.Update 先跑了，Lua 读到的输入是**上一帧的** —— 跳跃延迟一帧甚至丢帧。
-100 让 PlayerController 先执行（刷新输入），Bridge 后执行（消费输入）。

---

## 9. HFSM 逐帧 trace：把"四步"落到具体一帧上

> 我在正文里说"四步"，但**代码里并没有这四个标签** —— 那是讲解用的名字。
> 这一节把一帧完整走一遍，四步就具体了。

### 9.1 数据结构：就一个三层的表

```lua
local layers = {
    [State.StateLayer.BASE]     = { current = nil, states = {} },  -- 1
    [State.StateLayer.ACTIVE]   = { current = nil, states = {} },  -- 2
    [State.StateLayer.ABNORMAL] = { current = nil, states = {} },  -- 3
}
```

**每层只有两个字段**：states（注册了哪些状态）+ current（当前是哪个，nil = 没在跑）。

**"并行"就是这个数据结构的直接结果**：三个 current 可以**同时不为 nil**。
不需要任何特殊机制 —— 它们本来就是三个独立槽位。

Register 里有一个关键细节：

```lua
function Register(state)
    local L = layers[state.layer]
    L.states[state.name] = state
    if L.current == nil and state.layer == State.StateLayer.BASE then
        L.current = state        -- ★ 只有 BASE 层自动设初始状态
    end
end
```

**只有 BASE 层会自动设初始状态。** ACTIVE / ABNORMAL 初始是 nil —— 它们是
"触发才激活"的瞬态层。这解释了为什么开局只有 ground 在跑。

### 9.2 走一帧：站在地上，按下冲刺

**帧开始前：**

```text
layers[1] BASE     current = ground    （地上）
layers[2] ACTIVE   current = nil       （没在做动作）
layers[3] ABNORMAL current = nil       （没被打）
```

**① ABNORMAL 独占检查** → current 是 nil → 跳过（没被打）

**② 互斥预检** → active.current 是 nil → mutexActive = false（没有动作在跑，不用锁）

**③ BASE 先跑**

```lua
base.current.SetOutputLocked(core, false)      -- 告诉 ground：不用锁
local switched = ResolveNext(BASE, base.current.LogicUpdate(core), core)
```

ground.LogicUpdate 里第 2 段（锁内）**会执行**，走到冲刺判断：

```lua
if c.PlayerInput.DashDown and c.PlayerMovement.DashCooldownTimer <= 0 then
    return { layer = State.StateLayer.ACTIVE, name = "dash" }   -- ★ 跨层请求
end
```

回到 ResolveNext(BASE, 那个 table, core)：

```lua
if type(next) == "table" then
    if ownerLayer ~= State.StateLayer.BASE then   -- 我们是 BASE → 不清空自己
        ChangeState(ownerLayer, nil, core)
    end
    if next.layer then
        ChangeState(next.layer, next.name, core)   -- ChangeState(2, "dash")
    end
end
return true     -- ★ switched = true
```

**ownerLayer ~= BASE 这个条件是关键**：BASE 不能清空自己（角色总得在某个"位置状态"里）。
只有**瞬态层**跨层切走时才清空自己。

ChangeState(2, "dash") 内部执行 dash.Enter —— 设 IsDashing = true、
SetDashInvincible(true)、gravityScale = 0。

**④ ACTIVE 并行** → not switched 是 false → **跳过**。
dash.Enter 刚在这一帧执行过，再跑 LogicUpdate 等于"进入帧"和"运行帧"挤在同一帧。

**帧结束后：**

```text
layers[1] BASE     current = ground    （★ 没变）
layers[2] ACTIVE   current = dash      （★ 新激活）
layers[3] ABNORMAL current = nil
```

**BASE 没变** —— 冲刺是"叠加在地面移动之上的动作"，不是"换了个位置状态"。
**这就是并行的含义。**

### 9.3 下一帧（冲刺进行中）：锁生效了

**② 互斥预检**这次不一样：dash.parallelMode == MUTEX → mutexActive = true

**③ BASE 跑，但锁上了：**

```lua
base.current.SetOutputLocked(core, true)     -- ground.outputLocked = true
```

进 ground.lua：

```lua
-- 第1段（锁外）：冷却照常递减 ★
-- 第2段（锁内）：整个跳过 —— 不写 SetVelocityX，不响应跳跃/攻击 ★
-- 第3段（锁外）：离地检测照常跑 ★
if not c:CheckGrounded() then
    return "air"        -- 冲出平台边缘时，这里会切走
end
```

**这三段的"锁内/锁外"就是 P0-2 的全部内容。**

**④ ACTIVE 跑**：这次 switched 是 false，所以 dash.LogicUpdate 执行。
冲刺时间到了就返回 {}（空 table）：

```lua
if type(next) == "table" then
    if ownerLayer ~= State.StateLayer.BASE then    -- ACTIVE ≠ BASE → 清空自己
        ChangeState(ACTIVE, nil, core)             -- dash.Exit 执行（还原无敌帧/重力）
    end
    if next.layer then ... end                     -- layer 是 nil → 跳过
end
```

**冲刺结束，ACTIVE 回到 nil，下一帧锁自动解除。**

### 9.4 压成一张图

```text
                     ┌──────── ABNORMAL 层 ────────┐
                     │  current = hurt ？           │
                     │  有 → 跑它，然后 return ★独占 │
                     └──────────────────────────────┘
                                  │ 没有
                                  ▼
                     ┌──────── 算锁 ────────────────┐
                     │  ACTIVE.current 是 MUTEX 吗？ │
                     └──────────────────────────────┘
                                  │
                                  ▼
        ┌──────── BASE 层（常驻，永远有 current）────────┐
        │  SetOutputLocked(锁)                          │
        │  ┌─ 锁外：冷却计时 ──────────────┐              │
        │  ├─ 锁内：移动/跳/攻击/冲刺 ─────┤← 只有这段被锁 │
        │  └─ 锁外：落地/离地检测 ────────┘              │
        │  返回值 → 可能跨层切 ACTIVE                    │
        └───────────────────────────────────────────────┘
                                  │ 如果这一帧没切层
                                  ▼
        ┌──────── ACTIVE 层（瞬态，与 BASE 并行）───────┐
        │  attack / dash  各自 LogicUpdate              │
        │  返回 {} → 清空本层，回 nil                    │
        └───────────────────────────────────────────────┘
```

**四步 = 四个顺序决定**：

1. ABNORMAL 独占（最高优先级）

2. 算锁（必须在 BASE 之前，否则第一帧锁不生效）

3. BASE 跑（它会产生跨层请求）

4. ACTIVE 跑（但要避开刚切进去的那一帧）

---

## 相关

- 复盘正文与考点：[项目复盘 · DeadCells_Refactor]

- 源码（仓库）：`Assets/StreamingAssets/Lua/Framework/Fsm/HFSM.lua`、`State.lua`、
  `Assets/_Scripts/player/PlayerLuaBridge.cs`、`PlayerController.cs`、
  `Assets/_Scripts/Enemy/EnemyState.cs`（老状态机，可对比）
