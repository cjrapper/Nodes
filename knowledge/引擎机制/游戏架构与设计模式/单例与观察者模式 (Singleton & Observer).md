# 单例与观察者模式 (Singleton & Observer)

## 第一部分 · 单例

### 1. 泛型单例的写法

```csharp
public abstract class Singleton<T> : MonoBehaviour where T : MonoBehaviour
{
    public static T Instance { get; private set; }

    protected virtual void Awake()
    {
        if (Instance != null && !ReferenceEquals(Instance, this))
        {
            Destroy(gameObject);   // 销毁整个 GameObject，会连带干掉同物体上的其他组件
            return;
        }
        Instance = (T)(object)this;
        DontDestroyOnLoad(gameObject);   // 只对根 GameObject 生效
        OnInit();
    }

    protected virtual void OnInit() { }   // ← 派生类重写这个，不要重写 Awake
}
```

**签名易错**：`public class Singleton : MonoBehaviour where T : MonoBehaviour` 这类写法声明了 `where T` 却没有 `T`，**编译不过**。必须是 `Singleton<T>`。

### 2. `Awake` 该不该标 `virtual`（这个模板自己挖的坑）

把 `Awake` 写成 `protected virtual`，派生类一旦 `override Awake()` 而忘了 `base.Awake()`，`Instance` 就**永远是 null**，而且**不报错**。这是泛型单例最常见的实际故障。

→ 解法：`Awake` 不做 `virtual`，另开 `OnInit()` 给派生类；或者干脆不用 `Awake`，`Instance` 用静态属性惰性创建。

（派生类用 `new` 隐藏 `Awake` 时，Unity 的消息分发会命中基类还是派生类，{orange|这点没有把握，建议实测，不要背结论。}）

### 3. 每个封闭泛型类型各有一份静态字段（必问）

为什么 `Singleton<UIManager>.Instance` 和 `Singleton<AudioManager>.Instance` **不共用**同一个静态字段？

因为 C# 泛型是**运行时具现化**：每个**封闭泛型类型**（closed generic type）各有一份静态字段。

### 4. `Destroy` 不是「立刻」

`Destroy` 是**帧末延迟执行**的，这一帧内那个重复对象**还活着**。所以「靠 `Awake` 竞速保证唯一性」本身就脆弱；更可控的是**加载期就不产生重复实例**，或用 `[DefaultExecutionOrder]` 明确顺序。

**`Destroy(this.gameObject)` 是一个未经论证的选择**：销毁的是**整个 GameObject**，会连带干掉同物体上别的组件。要能说清选「先到优先」还是「场景配置优先」，以及为什么。

**`DontDestroyOnLoad` 只对根 GameObject 生效**：组件挂在子物体上会 warning 且**不生效** —— 这是「明明加了还是被销毁」的经典原因。

### 5. 线程安全：什么时候需要加锁

{red|「Unity 的生命周期函数都只在主线程上执行，天生线程安全」} —— 过度概括，而且踩进陷阱题。

- **对的一半**：MonoBehaviour 的**回调**（`Awake` / `Update` / `OnEnable`…）确实只在主线程跑。
- **错的一半**：`Instance` 是 `public static`，**任何线程都能读它** —— `Task.Run`、网络回调线程、第三方 SDK 回调线程、`new Thread`。这时仍然需要内存可见性保证，否则工作线程可能**永远读到 null**（JIT 把读提升到循环外）。
- **这是两件事，别混成一句**：
  - 「工作线程不能访问 Unity 对象（Transform / GameObject）」= **原生对象的线程亲和性**；
  - 「单例要不要加锁」= **C# 内存模型**。
  前者对，但**不能用来论证**后者。

**正确说法**：不用 lock 的前提是**两条同时成立** ——（1）初始化发生在主线程，（2）所有访问也只在主线程。一旦存在跨线程访问，仍需 `volatile` 或 `Lazy<T>`。
更稳的做法是**避免懒初始化**：在 `Awake` 或静态构造里就建好，直接消掉竞态窗口。

**生产级替代**：

- 纯 C# 单例（非 MonoBehaviour）：**静态嵌套类**（靠 CLR 类型初始化保证，既懒加载又线程安全且无锁）或 `Lazy<T>`。DCL 不是唯一答案。
- MonoBehaviour 单例：不能用 `new`，上面两招用不上。可行的是 `[RuntimeInitializeOnLoadMethod]` 里创建、或走 Addressables 加载。

### 6. `volatile` 说准

`instance = new AudioManager()` 在 CPU 眼里是三步：① 分配内存空间；② 初始化对象；③ 把 `instance` 指针指向这块内存。

「防止 CPU 指令重排导致的空指针异常」方向对，补两点：

1. **具体是防哪两个重排**：① 对 `instance` 的赋值 vs 对象字段的初始化（写侧）；② 读方的**读提升**（read hoisting）。
2. **关键不是「x86 没暴露这个 bug」，而是 C# / CLR 的内存模型比 x86 硬件模型更弱** —— x86 上不加 `volatile` 通常没事，是**没暴露**，不是不存在。**ARM（= Unity 的移动平台）上会暴露。**

{orange|.NET 内存模型的严格条款（ECMA-335 与 CLR 实现的差异）给不出精确引用，查 Igor Ostrovsky《The C# Memory Model in Theory and Practice》（MSDN Magazine）。}

### 7. 现代 Editor：关掉 Domain Reload 的陷阱

Enter Play Mode Options（{orange|Unity 2019.3+，具体版本请核对}）可**关闭 Domain Reload**，此时**静态字段跨 Play 不重置**，`Instance` 会指向上一轮 Play 的、已销毁的对象。老文章里不存在这个问题 —— 属于「过时信息」的一类。

### 8. 单例的缺陷，以及「那你用什么替代」

单例本质是一个披着合法外衣的**全局变量**：破坏封装性（任何脚本都能 `GameManager.Instance.xxx`，出事找不到是谁改的）、隐藏依赖（单看一个敌人的脚本，不知道它暗中依赖了 AudioManager / UIManager）。所以只有真正的全局系统管理者（音效、UI、关卡逻辑、事件中心）才配用，绝不能滥用在具体游戏实体上。

面试官必问「那你用什么替代」：

- **Service Locator**（可被替换、可 mock —— 这是它和单例的**实质区别**）；
- 构造注入 / DI 框架；
- SO Event Channel；
- 信号系统（UniRx / MessagePipe 之类）。

顺带纠正一个常见误解：**小团队用单例活得很好**（沟通成本低），这是**团队规模**问题，不是优劣问题。

### 9. 纯 C# 单例类型对照

| 类型 | 创建时机 | 线程安全 | 适用场景 |
|---|---|---|---|
| 饿汉式 | 类加载时创建 | 天生安全 | 一定会用到、初始化快 |
| 懒汉式 | 第一次调用才创建 | 需加锁 | 不一定会用到、初始化慢 |

DCL 两个 if：外层防「每次调用都抢锁」，内层防「多个线程同时通过外层、排队创建多个实例」。

## 第二部分 · 委托与事件

### 10. `event` 的编译后形态

`event` 会被编译成 **「一个私有委托字段 + `add_` / `remove_` 访问器」**；`+=` / `-=` 内部用 `Interlocked.CompareExchange` 循环实现，所以**订阅这个动作本身是线程安全的**。被追问「`event` 到底怎么实现的」，答不出这一层，「防弹玻璃」这个比喻就散。

**`event` vs 裸 delegate**：裸 delegate 外部可以 `=`（清空别人）、可以直接 `Invoke()`（越权触发）；加 `event` 后外部只能 `+=` / `-=`，只有声明它的类能触发。

### 11. `string` 做 key 的代价

- 每次查找要算 hash + **比较字符串**；
- enum key 走泛型 `Dictionary<TKey,TValue>` 的 `EqualityComparer<T>.Default` **快路径，不装箱**。

拆成三条独立结论，不要拼成一句因果：

1. enum / `static readonly` 常量 → **编译期检查**（与 GC 无关）；
2. 禁止运行时拼 string 做 key（`"OnDamage_" + id`）→ **这条才是 GC 相关**；
3. 订阅时的**闭包捕获** → 订阅侧的 GC 源。

{red|「为了防止拼写错误产生 GC，所以用 enum key」是因果捆绑} —— 拼写错误产生的是编译 / 运行期错误，不是 GC。

### 12. 事件中心：底层结构与三个生产级 bug

底层核心是一个 `Dictionary`：Key = 事件名（enum 优于 string），Value = 委托（`Action<T>`）。

**（a）泛型广播方案本身不成立。**
{red|「`public void Broadcast<T>(EventType type, T info)` 让字典精准匹配 `Action<int>` / `Action<float>`」} —— `Broadcast<T>` 里的 `T` 是**编译期**类型，字典里存的是**运行时**数据，内部**无法从 `T` 定位到字典里对应的那一个**。若把 Value 写成 `Delegate` 再 `DynamicInvoke`，更慢且参数照样装箱。

三条可行方案（任选其一）：

1. **按参数类型分字典**：`Dictionary<EventType, Action<int>>` + `Dictionary<EventType, Action<float>>`，各写一个重载；
2. **事件参数用 struct**：`event Action<DamageEvent>` —— 泛型形参是具体类型 ⇒ struct 按值传递**不装箱**，零 GC 正解；
3. `Dictionary<Type, Delegate>` + `Delegate.Combine` / `Delegate.Remove` 维护。

**（b）强引用泄漏（生产环境最高频的 bug）。**
委托持有订阅者的**强引用**：UI 面板销毁了但没 `-=` → 对象**无法被 GC**（泄漏）+ 下次广播调用已销毁对象的方法抛异常。
绕点：`UnityEngine.Object` 重载了 `==`，所以 `subscriber == null` 在对象销毁后返回 `true` —— 但**委托链里那一项仍然占位、不会自动移除**。

**（c）广播过程中的两个坑。**

- 顺序 = **订阅顺序**（调用列表追加顺序）；
- **任一 handler 抛异常，后面所有 handler 都不执行** → 事件中心要做异常隔离（**快照遍历 + try-catch**）；
- **回调里 `-=` 退订 = 修改正在遍历的调用列表** → `InvalidOperationException`（与《解耦利器：委托与事件》里「foreach 遍历集合时禁止 Add / Remove」是**同一个根因**）。

**（d）轻量替代**：不需要全局总线时，用**静态 `event` 字段**（`public static event Action<int> OnDamage;`）就够 —— 比 `Dictionary<键, 委托>` 更快、类型安全、不装箱。

**（e）Value 别声明成 `Delegate`**：若真声明成 `Delegate`，广播时 `?.Invoke()` **调不通**（`Delegate` 基类不暴露 `Invoke`，只能 `DynamicInvoke`）。

### 13. 观察者 vs 发布-订阅

| | 传统观察者 | 发布-订阅（事件中心） |
|---|---|---|
| 耦合 | UI 必须拿到 Player 引用：`player.OnDead += UpdateUI;` | 互相不认识，靠事件名匹配 |
| 优点 | 简单直接 | 任一方可独立删除 |
| 缺点 | Player 报错 / 被删，UI 跟着挂 | 滥用后「全屏都是广播」，查 Bug 难定位是谁触发的 |

耦合程度要从「**对象引用耦合**」降为「**契约耦合**（事件名 + 参数结构）」—— 改事件名或参数类型，两边仍然同时挂。
