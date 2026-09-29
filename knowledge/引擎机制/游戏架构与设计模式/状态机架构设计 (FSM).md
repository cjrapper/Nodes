# 状态机（FSM）

## 1. 两张表要分开：范式层 vs 实现层

**范式层（选型问题，决定架构）**

| 范式 | 驱动方式 | 适合 | 什么时候会崩 |
|---|---|---|---|
| FSM | 状态驱动 | 状态数少、转移稀疏 | 出现正交维度 → 状态**爆炸** |
| HSM（分层状态机） | 状态驱动 + 层次 | 有公共行为的状态族 | 层次设计不当，调试链路变长 |
| BT（行为树） | 节点驱动 | 优先级频繁调整、策划要能改、AI | 强时序 / 强状态语义的场景不如 FSM 直观 |
| Utility AI / GOAP | 打分 / 规划 | 开放式 AI（模拟类） | 成本高，小项目用不上 |

**实现层（同一范式的不同写法）**

| 写法 | 优点 | 缺点 | 适用 |
|---|---|---|---|
| enum + switch | 最快写出、零分配、易调试 | 加状态要改 switch，违反开闭 | 状态 ≤ 5 的原型 |
| interface + 多态类 | 开闭、职责单一、可复用 | 每状态一个类、样板代码多 | 状态 5~15，商业项目主流 |
| 转移表（表驱动） | 改转移不改代码、可导出给策划 | 跳转链路难调、类型弱 | 迁移规则多变的玩法 |
| 数据驱动 | 策划可改 | 需要工具链 | 大项目 |

**「状态少」到底是多少**：状态数 ≤ 10 且**每状态出边 ≤ 3** 时可维护。

## 2. 白板实现一个状态机（面试第一问）

写代码前先说清这几个决策：

1. **谁持有 `_current`**：状态机持有。状态自己不持有，否则状态之间要互相知道。
2. **谁 tick**：状态机的 `Tick()` 统一调 `_current.OnUpdate()`。状态是**纯 C# 类**，不要继承 MonoBehaviour（Unity 会接管它的 `Update`，顺序和生命周期失控）。
3. **切换顺序**：`_current.OnExit()` → 换引用 → `next.OnEnter()`。
4. **切换过程中又触发切换怎么办**：
   - **立即抢占**：新状态覆盖旧的，实现简单，同帧内可能反复切换；
   - **请求排队**：本次切换走完再处理，防抖动。
   - 经验：**输入驱动的切换用抢占，动画事件 / 回调驱动的切换用排队**。
5. **重入**：留 `force` 重入路径（二段跳必须走这条）。
6. **状态对象预创建**，切换只换引用。

```csharp
public interface IState
{
    void OnEnter();
    void OnUpdate();
    void OnExit();
}

public sealed class StateMachine
{
    private readonly System.Collections.Generic.Dictionary<int, IState> _states = new();
    private IState _current;
    private bool _isSwitching;   // 防同帧递归切换
    private IState _pending;     // 排队策略

    public void Add(int id, IState s) => _states[id] = s;

    public void Switch(int id, bool force = false)
    {
        var next = _states[id];
        if (!force && ReferenceEquals(_current, next)) return;   // ← force 是二段跳的生命线

        if (_isSwitching) { _pending = next; return; }           // ← 排队

        _isSwitching = true;
        _current?.OnExit();
        _current = next;
        _current.OnEnter();
        _isSwitching = false;

        if (_pending != null)
        {
            var p = _pending;
            _pending = null;
            // 按你选的策略：丢弃 / 立即处理 / 留到下一帧
        }
    }

    public void Tick() => _current?.OnUpdate();   // 状态机统一驱动
}
```

`_pending` 的具体衔接方式按你选的策略写，重点是**能讲清为什么这么选**。

## 3. 状态能不能持有数据

| | 能不能放状态里 | 例子 |
|---|---|---|
| **只读配置**（构造期注入，之后永不写） | 可以 | `_jumpVelocity`、动画时长 |
| **可变运行时数据** | 不可以，放 context / blackboard | 当前位置、剩余跳数、是否接地 |

一句话记：**「只读配置」放状态，「可变数据」放 context。**
「无状态」= **无可变数据**，不等于零字段。

为什么：状态实例要能复用（预创建、切换只换引用）⇒ 它不能带着上一次的数据；数据只能外置到 context。所以「数据放上下文」不是为了整洁，是**复用的前提**。

## 4. 案例：二段跳的三个真实坑

**坑 1：计数重置的时机。**
「只要检测到 Grounded 就把 `currentJumpCount` 重置为 0」→ 走下坡、被击退、踩空平台边缘**也会重置**，白送一次跳。
正解：区分「**主动起跳离地**」和「**被动离地**」——

- **coyote time（土狼时间）**：离地后仍保留一小段（量级约 0.1s，按手感调）的可起跳窗口；
- **jump buffer（起跳输入缓冲）**：落地前一点按的跳被缓存，落地瞬间生效。

必考追问：「玩家走出平台边缘的 0.1 秒内能不能跳？」

**坑 2：一段跳和二段跳共用一套初速度。**
`new JumpState()` 意味着初速度写死在状态里，策划几乎一定要求二段跳力度更小 / 方向不同。
正解：跳跃初速度、竖直位移曲线做成**只读配置**（构造期注入），或从 context 读。

**坑 3：重入。**
在 `SwitchState` 里写 `if (_current == next) return;` 当优化 → 在 JumpState 里再按跳切不回 JumpState，二段跳**静默失效**（不报错，只表现为「策划说二段跳没反应」）。必须留 `force`。

## 5. FSM 最核心的缺点：状态爆炸

正交维度**相乘**：`是否眩晕 × 是否持械 × 是否在空中` → 状态数相乘。这才是「状态机什么时候会崩」的标准答案，也是 HSM / BT 的选型边界。

## 6. 易错点清单（这些说错会被抓）

- **热路径 `new` 状态对象**：每按一次跳 `new JumpState()`，与本库《对象池》「复用实例」直接矛盾，同时被问两题会互相打脸。
- **`SwitchState` 无脑 `if (_current == next) return;`** → 二段跳静默失效。
- **把「状态必须无状态」理解成「零字段」** → 只读配置（`_jumpVelocity`）可以放状态，可变数据才放 context。
- **「落地就重置跳跃次数」** → 走出平台边缘也重置。
