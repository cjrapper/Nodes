内含碎片： Awake vs Start 的本质区别；Update vs FixedUpdate (受力与帧率)；LateUpdate (为什么摄像机跟随要写在这里)

● Awake（胎教）： 一辈子只执行一次。
  ○ 必写逻辑： 所有的 GetComponent。不管物体激活没激活，先把自己身上的零件摸清楚。
  ○ 绝对禁忌： 严禁在这里去跨脚本调用别人的数据！（因为脚本执行顺序随机，别人可能还没 Awake，直接报空指针 NullReferenceException）。
● OnEnable（起床）： 每次 SetActive(true) 都会执行。
  ○ 实战神技（结合对象池）： 你的怪物从对象池里拿出来时，是不会再次触发 Start 的！所以，“怪物血量恢复满血”、“重置状态机为 Idle”、“+= 订阅事件”，必须、一定、绝对要写在 OnEnable 里！写在 Start 里，你的怪物第二次出场就是个死人！
● Start（出门）： Awake 执行完后，第一帧渲染前执行。一辈子一次。
  ○ 必写逻辑： 安全地去 Find 或者获取其他脚本的数据（因为大家的 Awake 都跑完了，数据都准备好了）。
● 既然物理逻辑写在 FixedUpdate，按键输入写在 Update，那如果有冲突怎么办？
A（实战与避坑）：
● FixedUpdate（固定物理帧）： 默认 0.02 秒一次（1秒50次），雷打不动。用来给 Rigidbody 施加力（如移动、跳跃）。
● Update（浮动逻辑帧）： 跟着屏幕刷新率走（比如电竞屏 1秒144次）。用来写 Input.GetKeyDown。
💣 致命陷阱（按键吞噬 Bug）：
● 菜鸟写法： 把 if(Input.GetKeyDown(KeyCode.Space)) Jump(); 写进了 FixedUpdate 里！
● 灾难现场： 玩家明明按了跳跃，但角色没跳！为什么？因为电竞屏 Update 跑了 3 次（检测了 3 次按键），而 FixedUpdate 才跑了 1 次。你在 Update 间隙按下的瞬间，被 FixedUpdate 完美错过了！这叫“吞键”！
● 主程正解： 在 Update 里用一个 bool isJumpPressed = true; 记下按键；然后在 FixedUpdate 里判断 if(isJumpPressed) { 执行物理跳跃; isJumpPressed = false; }。这就是实战中的输入与物理分离！
LateUpdate 在实战中到底解决什么痛点？
A（实战与避坑）：
它保证在所有物体的 Update 跑完之后才执行。
● 摄像机跟随（最经典）： 必须写在这里，否则会因为执行顺序随机，导致画面疯狂抽搐（Jitter 抖动）。
● 动画状态机的强行修正： 比如你的角色在 Update 里根据速度计算了身体的朝向，在 LateUpdate 里再去给 Animator 的 IK（反向动力学，比如手摸着墙）赋值。保证计算出来的坐标是当前帧绝对最终、不可更改的坐标。
物体死亡时，这两个函数该怎么分工？如果不配对会怎样？
A（实战与避坑）：
● OnDisable（睡觉/进回收站）： 物体 SetActive(false) 时触发。
  ○ 必写逻辑（结合对象池）： -= 退订所有事件！ 停止挂在自己身上的所有协程（StopAllCoroutines），否则协程还在后台跑，试图操作一个隐藏的物体会引发逻辑混乱。
● OnDestroy（火化）： 物体彻底被 Destroy() 时触发。
  ○ C++ 底层真相： 这一步是 Unity 在通知底层的 C++ 引擎：“把这个物体相关的非托管内存（模型、贴图引用）全部 delete 掉！”
  ○ 实战坑点： 如果你在 OnDestroy 里再去写 GameManager.Instance.xxx，大概率会报错！因为在关闭游戏或者切场景时，GameManager 可能比你先被销毁了。在 OnDestroy 里绝对不要再去试图访问其他的单例或脚本！ 乖乖清理自己（比如解除大数组的引用，方便 GC）就好。
MonoBehaviour 吗？它的生命周期是怎样的？”
你回答：“它是 Unity 的组件基类。它的本质是将 C# 的生命周期交给了 Unity 底层 C++ 引擎去托管。所以我们绝对不能 new 它，而是用 AddComponent。它的生命周期从分配肉身的 Awake 开始，到激活的 OnEnable 和 Start，然后由主线程驱动 Update 轮询，最后在销毁时触发 OnDestroy 释放资源！”
