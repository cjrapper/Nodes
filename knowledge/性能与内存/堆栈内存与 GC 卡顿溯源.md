内含碎片： 值类型/引用类型画图、装箱与拆箱机制、为什么会产生 GC、如何避免 GC
	值类型（Value Type）	引用类型（Reference Type）
包含	int，float，struct，Vector3	class，string，array
特点	用完立刻撕掉销毁，速度极快，绝对不产生 GC	 像个大仓库。把本体扔进仓库，把一把“钥匙（指针引用）”留在栈上。钥匙丢了，仓库里的本体就变成了无主垃圾，等待 GC 回收。
存储地	栈内存（Stack）	堆内存（Heap）
装箱（Boxing）：Stack里的值类型转换为堆里的引用类型（int ->object）
危害：会在堆内存里凭空造出一个对象。用完后变成垃圾，必然触发 GC 分配。
经典踩坑： 在 Update 里写 text.text = "分数: " + 100;。数字 100 被隐性装箱了，产生大量垃圾。
拆箱：就是反过来，把堆里的拆回栈里。不产生垃圾，但极其消耗 CPU 算力进行类型检查
GC卡顿：
● 元凶机制 (Stop-The-World)： 当堆内存（大仓库）快满时，GC 会出来扫地。扫地时为了安全，会强行暂停游戏的主线程。清理如果耗时 30 毫秒，游戏画面就会直接卡死 30 毫秒（掉帧）。
● 破解连招：
● 极力避免在 Update 里频繁 new 对象。
● 避免字符串的 + 拼接，改用 StringBuilder 或 .ToString()。
● 使用对象池（Object Pool）： 把高频生成的特效/子弹用 Queue 存起来循环利用（SetActive），彻底饿死 GC
如果你要用射线检测击中多个敌人（穿透狙击枪），该用哪个 API？性能上有什么坑？
A（菜鸟的 GC 灾难）：
菜鸟会用 Physics.RaycastAll。
致命坑点： 这个 API 每次调用，都会在底层 new 一个全新的数组（Array）来装被击中的敌人，然后返回给你。如果你的机枪一秒钟射 10 发，一秒钟就在堆内存里制造 10 个数组垃圾！瞬间触发 GC！
A（主程的零 GC 绝杀）：
必须使用 Physics.RaycastNonAlloc！（NonAlloc 的意思就是“不分配内存”）。
具体做法： 在脚本外面提前准备好一个定长的空数组 RaycastHit[] hits = new RaycastHit[10];。
调用时，把这个空数组当做参数传给 RaycastNonAlloc。Unity 引擎会把检测到的敌人直接塞进你准备好的这个数组里，绝对不会 new 任何新东西。零分配！零 GC！

为什么所有的优化规范里，都严禁在 Update 里使用 GameObject.Find() 或 GetComponent()？
A（底层跨界代价）：
C# 是托管代码，Unity 引擎底层是 C++（非托管）。
当你调用 GameObject.Find("Player") 时，相当于 C# 拿着一个大喇叭，跨过语言的边界，跑到 C++ 的底层内存里，把全场景成千上万个物体全部遍历一遍，挨个做字符串对比！ 这不仅是 O(N) 的耗时，更是极其昂贵的跨界调用（P/Invoke）代价。
A（标准解法：空间换时间）：
永远在 Awake 里找一次，然后用一个变量存起来（缓存）！ 之后在 Update 里直接用这个变量。或者干脆做成 public 变量，在面板上拖拽赋值，连找都不用找！

Transform 的“株连九族”连坐机制
Q：如果在游戏里，一个父物体下面挂着 100 个子物体。我用代码移动了一下父物体，底层会发生什么？
A（物理矩阵的连坐计算）：
很多新手以为移动父物体只是改了个 Vector3 的坐标。
底层真相： Transform 在底层维护了一个极其复杂的 3D 转换矩阵。只要父物体的坐标、旋转、缩放发生任何一丝改变，底层引擎就会强制把下面那 100 个子物体的世界坐标全部重新计算一遍！（这叫 Dirty Flag 脏标记机制）。
A（实战优化思维）：
● 尽量让层级（Hierarchy）扁平化，不要嵌套太深。
● 如果同时要修改位置和旋转，绝对不要写两行（transform.position = x; transform.rotation = y;），这会触发两次计算！必须用一句代码：transform.SetPositionAndRotation(x, y);，底层只算一次！
