# Nodes — 架构与缓存命中设计

> 类语雀的本地优先知识库笔记软件，内置可自定义多模型的 AI 对话。
> 核心工程目标：**把 prompt 前缀缓存命中率做到尽可能高**。

## 1. 为什么缓存命中是核心

主流模型服务商（OpenAI / Anthropic / DeepSeek / Kimi / GLM / Qwen）都对
**输入 prompt 的最长公共前缀**提供缓存折扣：

| 服务商 | 机制 | 命中价格 | 说明 |
| --- | --- | --- | --- |
| OpenAI | 自动前缀缓存 | 约为输入价 10% | 前缀 ≥1024 token 才生效，按 128 token 块对齐 |
| Anthropic | 显式 `cache_control` 断点 | 写入 1.25x / 命中 0.1x | 最多 4 个断点，TTL 5 分钟或 1 小时 |
| DeepSeek | 自动上下文缓存 | 约为输入价 10% | 自动，按 64 token 块对齐 |

笔记软件的 AI 对话有一个天然优势：**上下文里绝大部分是稳定内容**
（人设、工作区约定、被 @ 引用的知识块、历史对话）。只要组装方式稳定，
这些 token 每轮都能以 1/10 的价格复用。反过来，一个随机的 `Date.now()`
或每次重排顺序，就会让整段前缀失效、按全价计费。

**本项目的做法：把"上下文组装"当成一等公民，用确定性算法保证前缀最大化。**

## 2. 上下文分层组装（Context Ladder）

system + messages 按**稳定性从高到低**严格分层排列。任何低稳定层的内容
绝不允许出现在高稳定层之前。

```
┌──────────────────────────────────────────┬──────────┬───────────────────────┐
│ 层                                        │ 稳定性    │ 变更时机               │
├──────────────────────────────────────────┼──────────┼───────────────────────┤
│ L0 身份内核  persona / 输出契约 / 工具约定   │ 几乎不变  │ 用户改人设时            │
│ L1 工作区约定 workspace conventions/术语表  │ 低频      │ 用户改设置时            │
│ L2 知识块   被 @ 引用的 block 正文          │ 中        │ 引用集合或块内容变化时   │
│ L3 对话历史 message history                │ 只追加    │ 每轮追加                │
│ L4 本轮输入 user turn + 临时指令            │ 每轮变    │ 每轮                    │
└──────────────────────────────────────────┴──────────┴───────────────────────┘
```

### 2.1 确定性的四条硬规则

1. **禁止易变内容进入 L0–L2**：时间戳、随机 ID、请求 ID、"当前第 N 轮"等
   一律下推到 L4 的 user turn。系统提示里出现 `new Date()` 就是缓存杀手。
2. **知识块按稳定键排序**：引用集合按 `block.cache_key`（内容哈希 + 稳定 id）
   字典序排列，与用户 @ 的先后顺序、UI 点击顺序无关。
   → 同一组块无论怎么被选中，渲染出的文本**逐字节相同**。
3. **块正文不做轮内裁剪/摘要漂移**：只有块内容真的变了，`cache_key` 才变。
   规划中的"自动摘要压缩历史"会破坏 L3 的只追加性质，因此**默认关闭**，
   仅作为可选策略并在 UI 上标注"会降低缓存命中"。
4. **对话历史只追加、不改写**：不做历史的原地编辑与重排；需要修正时新建分支。

### 2.2 块内文本规范化

块在进入 L2 前经过 `normalizeBlockText()`：统一换行符、去掉行尾空白、
去掉首尾空行。**只做幂等且不丢信息的规范化**——任何有损处理都会让同一逻辑
内容产生不同字节，从而分裂缓存前缀。

### 2.3 分层哈希与锚点

每层各自算 `sha256`：

```
layerHash[i] = sha256(layerName + "\u0000" + layerText)
prefixHash[i] = sha256(prefixHash[i-1] + layerHash[i])
```

全局 `prefixHash` 就是"这个会话当前的缓存指纹"。把上一轮的完整
prompt 存进 `invocation` 表，下一轮组装完后按层比对：

- 前 k 层哈希不变 → 这 k 层可以直接标记为「缓存命中预期」
- 第 k+1 层起变化 → 从该层开始是「缓存未命中预期」

这让我们在**发请求之前**就能预测命中率，也是仪表盘的数据来源。

### 2.4 缓存失效的根因提示

组装器会返回 `invalidationCause`：是 `block_edited`、`refs_changed`、
`persona_changed`、还是 `provider_switched`。切换模型/服务商必然导致缓存
全失效（不同模型的缓存不互通），UI 需要明确提示"切换模型将损失 N token 缓存"。

**根因判定有个易错点**：「从没有过调用记录」与「上一轮用的是别的模型」
虽然命中都为 0，但对用户的意义完全不同 —— 前者是预期内的冷启动，
后者是要提醒他别频繁切模型。这两者必须分开报，否则新会话第一轮就会
看到一句莫名其妙的"已切换模型"。（集成测试与冒烟测试都断言了这一点。）

### 2.5 最小可缓存长度（cache floor）

各服务商对可缓存前缀都有最小长度要求（OpenAI 约 1024 token，
Anthropic 约 1024），低于该长度缓存**根本不参与计费**。

这与"算了但命中 0"是两件事，必须分别建模，否则用户会误以为优化没生效。
因此 `CachePrediction` 里有一个独立的 `belowCacheFloor` 标志，
UI 会明确显示"本轮缓存不会生效"，而不是画一根 0% 的进度条。

### 2.6 块身份的稳定性（最容易被忽视、代价最大的一环）

块的 `cacheKey = sha256(textHash + id)`，而"保存文档"会重新解析整篇
Markdown —— 所以服务端必须把解析出的每个块**认领回它原来的 id**。
认领错了的后果不是数据错误，而是**缓存被整体击穿**：

> 用户在第 3 段后面插入一段。从第 4 段起，位置与 id 整体错位。
> 若按位置直接采信，后面每一块的"内容"看起来都变了 → 全部写成新 revision
> → `cacheKey` 全部翻新 → 引用这篇文档的所有会话的 L2 缓存一起作废。

实现走三趟，**顺序不可变**：

1. **按内容哈希**把没变动的块钉回原 id。这一趟必须最先跑 —— 只有它能
   扛住插入/删除造成的整体错位。
2. 用**位置提示**消化剩下的槽位，也就是内容被改过的块。这一趟是"编辑一段"
   时该块身份得以延续的关键：用户改了某段，期望的是那段被更新，
   而不是删掉旧的另建一个新的（后者同样会让 `cacheKey` 翻新）。
3. 都没匹配上的才是真正的新块，生成全新 id。
   ⚠️ 新块的 id **绝不能**复用调用方给的位置提示 —— 那属于别的块，
   会直接撞 `block(id, revision)` 主键。

三趟的顺序曾经写反过一次，两个方向各踩一个坑，对应的回归测试在
`tests/integration/pipeline.test.ts` 里（"编辑一个块…"与"在文档中间插入一段…"）。

### 2.7 L2 引用清单只依赖块的集合，不依赖块的内容

清单里刻意**不放每个块的 token 数**，也不标记"哪个块因超预算未展开"。

原因是实测出来的教训：早先版本在清单里写了 token 数，结果编辑任一块的正文
都会让 token 数变化、清单跟着变，失效层就从「L2 正文」上浮到「L2 清单」，
把整层缓存的收益一起吃掉了。现在清单只含 8 位块标识、标题路径与块类型，
编辑正文只影响正文层。

代价是清单不再显示"哪些块被裁掉了"。这个信息改由 `omittedBlockIds`
与界面提示承载 —— 它是给人看的，不必进 prompt。

### 2.8 模块层（L2_doc_*）：为「查漏补缺」这类任务准备的两层

块级引用（`@` 单块）适合"就这几段回答我"，但**判断"这个方向缺什么"必须看全局**
—— 只挂几个块是推不出缺失项的。所以新增两层，专门承载"整体挂载的文档/模块"：

| 层 | 内容 | 说明 |
| --- | --- | --- |
| `L2_doc_index` | 已挂载文档的清单 | 只列标题与类型，**不含正文规模** |
| `L2_doc_content` | 文档正文 | 每篇一块，保留文档内部的标题结构 |

四个刻意的决定：

1. **模块要摊平成整棵子树。** 模块本身不写正文、只挂子文档，所以挂载一个模块
   时会把它的全部后代知识点收集进来。只取直接子级会漏掉深层内容 ——
   而那正是最容易缺失的地方。
2. **文档层排在块层之后。** 块级引用更常用也更稳定，放前面能让最常见的
   前缀尽量长；整篇挂载量大且变动更频繁，放后面意味着它变化时不会连累
   前面已经命中的部分。
3. **清单里不写 token 数。** 这是 2.7 那条教训的直接应用：一旦清单含正文规模，
   编辑正文就会让清单跟着失效，把失效层从正文上浮到清单。
4. **预算不够时跳过整篇文档，而不是切一半。** 半个知识点比没有更容易误导
   模型 —— 它会把残缺内容当成完整内容来评判。

排序规则与块级一致：文档之间按 `cacheKey`（内容哈希 + docId）排，与挂载顺序
无关；文档**内部**按 `seq` 排（那是阅读顺序，不能乱）。
回归测试：`tests/doc-layers.test.ts`，其中断言了"同一组文档以不同顺序挂载，
产出的 prompt 逐字节相同"。

### 2.9 图片为什么不落库、也不用 base64

图片有三种存法，每一种对缓存的影响完全不同：

| 方案 | 正文里存什么 | 问题 |
| --- | --- | --- |
| base64 内联 | 几百 KB 的 base64 串 | 正文极长，每轮都把这些 token 送进 prompt；图片一改整块失效 |
| 上传到某个目录 + 随机文件名 | `asset:a1b2c3.png` | **同一张图两次粘贴得到两个 id** → 用户眼里没变，缓存眼里"块被编辑了" |
| **内容寻址**（采用） | `asset:<sha256>.png` | 同一张图永远同一个 id，正文字节恒定 |

关键在于**正文里存的是内容指纹，不是句柄**。块的 `cacheKey` 是正文的哈希，
正文不变则前缀不变，于是"贴图"这个动作对缓存是零成本的 —— 而如果按上传时间
或随机数命名，每贴一次图都会把该块之后的所有缓存打掉。

另外三个决定：

1. **不落库。** 素材的 mime 能从文件头（魔数）推出来，尺寸能从字节读出来，
   落一张表只会多一份可能不一致的副本。真正无法从字节推出的信息（谁引用了它）
   本来就该从正文反查。
2. **扩展名只从魔数推断，绝不采信 `Content-Type` 或文件名。** 一个伪装成
   `cat.png` 的 HTML 文件如果被同源 serve 出去，浏览器按 HTML 解析它，就是
   存储型 XSS。魔数是唯一无法伪造的证据；取回时再叠 `nosniff` 与
   `default-src 'none'` 两道锁。SVG 一律拒收 —— 它内部可以带 `<script>`。
3. **不自动删除孤儿素材。** 删掉正文里的引用后文件会留下。这是刻意的：
   删除不可逆，而**破坏用户数据是唯一不可接受的失败**。代价只是磁盘上多几个
   文件，`extractAssetIds()` 提供了统计孤儿的能力。

素材 id 是唯一从用户输入流向文件路径的字符串，因此它的形状被正则锁死
（`^[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$`）。渲染器里有一份**刻意的重复实现**
（`lib/render/markdown.ts` 不能 import `node:crypto`，它要能在浏览器里跑），
两份判据必须同步修改 —— 各有一份回归测试盯着。

> 这里踩过一个坑：最初两处的扩展名判据都写成 `[a-z0-9]{1,8}`，于是
> `…php` 这种 id 能通过形状检查。虽然盘上不存在、取不到文件，但"形状合法"
> 本身就是错的 —— 任何将来把它当扩展名用的代码都会立刻变成漏洞。
> 白名单要窄得**有道理**，不只是"看起来像"。

### 2.10 L0 的措辞是功能的一部分，不是装饰

人设（`workspace.persona`）是**工作区级**的 —— 所有对话共用一份，
新建对话不接受自己的人设字段。所以"改一次，全部对话生效"。

但 L0 并不是用户填的那段文字本身，而是 `renderPersona()` 拼出来的，
拼接逻辑出过两个真实缺陷：

#### 缺陷一：模板句稀释用户的人设

原先无论用户填什么，开头都固定拼一句
「你是「XX」这个知识库的写作与分析助手」。
用户填「游戏开发面试陪练」时这两句直接打架 —— 而且模板句更靠前、
更像系统指令，模型倾向于服从它，用户精心写的定位被稀释掉了。

现在：人设为空才用兜底角色说明；非空时**一句角色话都不加**。
连"你服务于 XX 知识库"这种看起来无害的上下文也去掉了 ——
它既可能和用户写的人设重复（用户自己写了"知识库助手"就是两遍），
也可能冲突（用户写的是"面试陪练"）。

#### 缺陷二：输出契约否决了本工具最主要的用法

原契约：

> 只依据提供的知识块内容作答；知识块里没有的信息，明确说明"知识块中未涵盖"，不要编造。

这句话对"根据笔记回答问题"是对的，但它和「查漏补缺」**直接冲突** ——
用户点「AI 分析」，要的正是"这个模块还缺什么"，而**"缺什么"必然在知识块之外**。
按原契约，模型只能回答"知识块中未涵盖"，于是这个功能从设计上被自己的
提示词否决了。用户看到的是"分析完了但什么都没说"。

正确的划界不是"禁止知识块之外的信息"，而是**区分事实与判断**：

| | 规则 |
| --- | --- |
| 事实 | 不许编造。不确定就说不确定，并指出该去哪里验证 |
| 判断（缺口、错误、过时、易错点） | 本来就是模型的职责，该给就说 |
| 来源 | 必须分清哪些是笔记原文、哪些是模型的判断 |

这样「查漏补缺」才有合法空间，而"不要编造"这条底线反而更清晰 ——
因为它现在只针对事实，不再和"指出缺口"混为一谈。

#### 副作用：一批测试偷偷依赖了 L0 的长度

L0 的 token 数**取决于模板拼了多少字**。删掉模板句之后，L0 从约 300 token
缩到约 165，于是一批测试的前缀掉到了缓存门槛（1024）以下 ——
那些断言"命中 > 0"的用例集体变红，看起来像实现坏了。

它们测的是失效层定位、块身份、模块层顺序，**和缓存门槛毫无关系**，
却因为一个无关变量的变化而失败。修法是让 fixture 显式声明门槛
（`cacheFloorTokens: 128`），把这个变量彻底移出它们的依赖范围。

顺带发现一个真 bug：低于门槛时实现只把 `predictedWriteTokens` 归零，
`predictedCachedTokens` 仍按前缀长度算 —— 界面上会同时显示
「命中 128 token」和「写入 0 token」，一个物理上不可能的状态。
根因是门槛判定发生在计算之后、只作用于其中一个字段。已修，
并在 `assemble.test.ts` 里加了一条专门守这个不变量的用例。

回归测试：`tests/persona.test.ts` 全量（11 项，含两条缺陷的守卫）。

## 3. 提供商适配
统一 `Provider` 接口，产出统一的 `ProviderStreamEvent`
（`text` / `reasoning` / `usage` / `notice` / `done`）：

- **OpenAI 兼容**（DeepSeek / Kimi / Qwen / GLM / OpenAI / Ollama / vLLM…）
  - 自动前缀缓存，按 64~128 token 块对齐
  - 命中量字段各家不同，适配器按优先级依次尝试：
    `prompt_tokens_details.cached_tokens` → `prompt_cache_hit_tokens`
    → 用 `prompt_cache_miss_tokens` 反推
  - 带 `stream_options: { include_usage: true }`，否则最后一个 chunk 不带
    usage、拿不到命中数。个别兼容实现不认这个字段会直接 400，
    适配器在该错误上会附加"如何关掉它"的提示。
  - 推理模型的 `reasoning_content` / `reasoning` 走独立的 reasoning 通道，
    不混进正文

- **Anthropic 原生**
  - 显式 `cache_control: { type: "ephemeral" }`，最多 4 个断点
  - **断点不是固定打 4 个**，而是按"已被证明稳定"来发（见 `decideBreakpoints`）：
    只有哈希与上一轮相同的**最深一层**才打断点，它天然覆盖之前所有层。
    全都在变时一个都不打 —— 写入要付 1.25x，给每轮都变的层打断点是净亏损。
  - 组装器把连续的多条 system 消息**保留为独立块**（不拼接），
    这样每层都能各自挂断点；Anthropic 的 `system` 参数本来就是块数组，
    正好对得上。
  - 同角色的相邻消息会被合并（Anthropic 要求 user/assistant 交替），
    合并时断点标记会保留
  - ⚠️ **usage 分两次到达**：`message_start` 带输入侧、`message_delta`
    带输出侧；适配器两次都发 usage 事件，每次给出当前完整快照，
    消费者以**最后一个**为准。
  - ⚠️ Anthropic 的 `input_tokens` **不含**缓存读取与写入部分，
    而其它服务商的 `prompt_tokens` 是含的。适配器把三者相加统一成
    "输入总量"口径，否则各家模型的命中率没法横向比较。

- 两个适配器都把 usage 归一化成 `NormalizedUsage`，仪表盘不关心底层差异。

### 3.1 停止原因（`finish_reason`）必须传上来

`ProviderStreamEvent` 里有一个 `finish` 事件，承载服务商给出的**输出为什么停了**
（OpenAI 兼容是 `choices[0].finish_reason`，Anthropic 是 `message_delta.stop_reason`）。

看起来可有可无，但它是区分"被上限截断"和"服务商返回了空响应"的**唯一**依据。
丢掉它之后的真实后果：

> 用户点「AI 分析」，看着思维链一直输出，然后戛然而止、正文一个字都没有。
> 界面只说"模型没有返回任何内容。**可能**是输出被 max_tokens 截断，或服务商
> 返回了空响应" —— 既不确定，也不可行动。

根因是**推理模型的思维链与正文共用 `max_tokens`**。有了 `finish_reason`，
四种"没有正文"的形态可以被精确区分并给出各自的下一步：

| 形态 | `finish_reason` | 有思维链 | 提示 |
| --- | --- | --- | --- |
| 思考烧完预算 | `length` | 有 | 当前上限 + 建议值 + 已产生的思考仍可查看 |
| 纯截断 | `length` | 无 | 直接指向「最大输出」 |
| 只想不写 | `stop` | 有 | 换问法（**不要**误导用户去调上限，那没用） |
| 真空响应 | 其它 | 无 | 报出停止原因 |

**上限为"不限制"（`max_tokens = NULL`）时，第一、二种的提示必须换一套说法。**
不然会劝用户"把最大输出调大"，而他已经在"不限制"上了 —— 他会去改一个空字段，
改完什么都不变，然后认定这个故障无解。此时的建议只能是"少想一点"
（关掉 `thinking`、降低 `reasoning_effort`）。

### 3.1.1 为什么"最大输出"的终点是"留空"而不是"填个大数"

这一段值得单独记，因为**同一个错误犯了两次**，而且第二次是在"已经修好"之后：

| 默认值 | 结果 |
| --- | --- |
| 4096 | 「AI 分析」时思维链烧完预算，正文空白 |
| 8192 | **同样的故障再来一次** —— 8192 只比 4096 大，不改变"会被烧完"这件事 |

病根不是数字大小，而是**填了一个具体数字**。DeepSeek 对 `deepseek-flash` 的
口径是"不填时非思考 8K、思考 64K"，所以填 8192 等于把原生默认砍到 1/8。

改法：`max_tokens` 允许为 `NULL`，**留空即请求里不带该字段**，由服务商按
自己的上限约束。三个配套点：

1. **只有 OpenAI 兼容系能做到"真的不限制"。** Anthropic 的 Messages API 把
   `max_tokens` 定成必填，省略会 400 —— 所以那边兜 64000 并**发一条 notice**
   说明这不是真的无上限。不提示的话，用户会看到"设了不限制还被截断"而无从下手。
2. **`extra` 里手写的 `max_tokens` 必须被清掉**，不能只是"不去设置它" ——
   `...config.extra` 可能已经把它写进请求体了。判据要 `delete`，不是 `if`。
   这一条是被回归测试抓出来的：`typeof x === "number"` 的写法看起来对，
   实际漏掉了"用户早在额外参数里写过"的情形。
3. **旧库这一列是 `NOT NULL`**，写 `NULL` 会抛 `NOT NULL constraint failed`，
   而且是**每次启动都抛** —— 等于用户的库打不开了。所以迁移要先重建表去掉约束。
   重建有两个坑（都真踩到了，见 `index.ts` 的 `makeColumnNullable`）：
   不能 `RENAME` 原表（SQLite 会把 `conversation` 的外键顺手改写成指向临时表，
   表一删就悬空，而数据看起来完全正常），以及必须先删索引
   （`CREATE INDEX IF NOT EXISTS` 遇到同名索引会静默跳过，重建完索引全丢）。

⚠️ **Anthropic 侧有个具体的写法陷阱**：`message_delta` 同时携带 usage 与
`stop_reason`。早先的代码是"有 usage 就处理完 `continue`"，于是 `stop_reason`
永远读不到，`max_tokens` 截断在界面上表现为"模型什么都没返回"。
`providers.test.ts` 里有一条测试刻意把 usage 与 stop_reason 放在**同一个**
事件里来守住这一点。

### 3.2 空回复必须记成失败轮次

`chat.ts` 里 `status` 的计算位置很关键：它必须在**空回复归因之后**。

早先的写法是先 `const status = failure ? "error" : "ok"` 再判空回复，于是
空回复被记成 `ok`。后果有三个，每一个都是真故障：

1. 它会被 `getLastInvocation` 当成**下一轮的缓存基准** —— 而这一轮根本没有
   内容写进服务商缓存，预测随之失真（这正是"失败轮次不能当基准"那条规则
   想防的事，却被一个语句顺序绕过去了）；
2. 空的助手消息不落库，用户回头查不到"当时没出结果"；
3. 统计里凭空多一次成功调用。

这类 bug 类型检查和肉眼都抓不到 —— 它不改变任何函数签名，只是两行代码的
先后顺序。只有"跑一轮真实对话然后检查落库结果"的集成测试能发现，
所以 `empty-reply.test.ts` 里专门有一条断言
「失败轮次不能被当成缓存基准」。该测试已按 R6 验证过：
把顺序退回去它就变红。

### 3.3 默认人设住在无依赖模块里

默认人设（L0）与约定（L1）放在 `lib/db/defaults.ts`，而不是内联在播种函数里。

原因是设置界面需要一个「恢复默认」按钮 —— 它必须引用**同一份**文本，
否则"默认"会有两个版本，用户点了恢复反而得到一段谁都没见过的内容。
而 UI **不能**从 `lib/db/index.ts` 导入：那个模块会拉起 `better-sqlite3` 与
`node:crypto`，拖进客户端组件会让打包直接失败。所以默认文本必须住在一个
零依赖的模块里，服务端（播种）与客户端（恢复默认）共用。

⚠️ 播种**只对空库生效**。已有的库不会因为升级而自动换人设（那等于覆盖用户
编辑过的内容）。需要更新时走设置里的「恢复默认」，或者直接改库 ——
代价是 L0 变化会让所有会话的整段缓存重建一次，这是刻意的取舍：
人设是"这个助手是谁"，写得不合适就该改，不该为了命中率把系统提示冻结在
一个不称职的版本上。

### 3.4 错误信息必须可操作

`describeHttpError()` 除了提取服务商原文，还会针对可识别的高频错因追加
一句"该怎么改"。这类错误的原文是给 API 调用方看的，用户不一定能对上号：

```
HTTP 400: The supported API model names are deepseek-flash, deepseek-v4-pro,
          but you passed DeepSeek-V4.1-Flash.
```

用户多半是把自己的**配置显示名**填进了「模型 ID」字段。直接在错误里点破，
能省掉一轮"照文档配了为什么还报错"的排查。已覆盖：模型名写错、Key 失效、
baseUrl 少写 `/v1`、触发限流、`stream_options` 不兼容、上下文超限。
回归测试在 `tests/integration/errors.test.ts`。

## 4. 数据模型（SQLite）

```sql
workspace(id, name, persona, conventions, appearance, created_at, updated_at)
  -- 单机唯一工作区；appearance 是外观设置的 JSON，不参与任何层哈希

doc(id, workspace_id, parent_id, title, icon, sort, created_at, updated_at)

-- 追加式修订：每次内容变更写一个新 revision，查询取 MAX(revision)。
-- 不硬删；被移除的块写一条 seq = -1 的修订，让历史 @ 引用仍可追溯。
block(id, doc_id, seq, kind, text, text_hash, revision, updated_at)
  PRIMARY KEY (id, revision)
  -- kind: heading | paragraph | code | quote | list | todo | table
  -- cache_key 是派生值（sha256(text_hash + id) 前 16 位），不落库

model_config(id, name, provider, base_url, api_key, model, temperature,
             max_tokens,          -- NULL = 不限制（请求里不带 max_tokens）
             context_window, supports_prompt_cache,
             input_price, cached_input_price, output_price,
             extra_json, is_default, created_at, updated_at)

conversation(id, workspace_id, title, model_config_id,
             source_budget_tokens, created_at, updated_at)
message(id, conversation_id, role, content, ref_block_ids, seq, created_at)
conversation_ref(conversation_id, block_id, pinned, created_at)  -- @ 引用集合
invocation(id, conversation_id, message_id, model_config_id, provider, model,
           layer_hashes_json, prefix_hash, stable_prefix_tokens,
           predicted_cached_tokens, predicted_write_tokens,
           prompt_tokens, cached_tokens, cache_write_tokens,
           completion_tokens, actual_usd, baseline_usd, saved_usd,
           latency_ms, status, error, request_fingerprint, created_at)
```

几个刻意的选择：

- **块用追加式修订而非原地更新**：历史 invocation 引用的块版本永远可追溯，
  也便于定位"是哪次编辑导致了缓存失效"。软删除保留引用可追溯性。
- **id 是无时间语义的随机 hex**：id 抖动会连带 `cacheKey` 抖动。
- **`cache_key` 不落库**：它是纯函数派生的，存下来只会制造不一致的机会。
- **`invocation` 存失败轮次**（`status = 'error'`）：仪表盘要能显示
  "这次失败的调用花了多少钱"。但统计口径会排除它们 ——
  `getCacheStats` 的 SQL 过滤 `status='ok'`，而逐轮明细不过滤，
  所以明细表会出现红色标记的失败行。这是有意为之：排查问题正需要看到它们。
- **`source_budget_tokens` 存在会话上**：知识块正文的 token 预算，
  超出时按稳定顺序截断（不按相关性，理由见 README「已知限制」）。

`block.cache_key` = 前 16 位 `sha256(text_hash + "\u0000" + id)`。
放入 id 是刻意的：**同一段文字出现在两个不同块里，也仍然渲染成两个独立段**，
避免"块 A 被改、块 B 因内容相同而跟着抖动"。

## 5. 前端的两条硬性约定

这两条都是踩过坑之后立的规矩，破坏任意一条都会让界面出现"看起来像网络问题"
的诡异症状。

### 5.1 传给子组件的回调必须引用恒定

父组件**不要**用内联箭头函数把回调传进子组件：

```tsx
// ❌ 每次父组件渲染都产生新引用
<EditorPanel onDocLoaded={(doc) => setDocs((prev) => ...)} />

// ✅
const handleDocLoaded = useCallback((doc) => setDocs(...), []);
<EditorPanel onDocLoaded={handleDocLoaded} />
```

原因是一个很容易成立的闭环：

```
子组件 effect 跑 → 调用该回调 → 父组件 setState → 父组件重渲染
→ 产生新的函数引用 → 子组件 effect 依赖变化 → effect 再跑 → …
```

真实事故：`EditorPanel` 的 `load` 把 `onDocLoaded` 放进了依赖数组，
而 WorkspaceShell 传的是内联箭头函数。症状是**在笔记里新建文档就疯狂闪烁、
终端被 `/api/blocks` 请求刷屏**，看起来完全像后端出了问题。

双保险措施：

- 子组件侧用 `useStableCallback`（`src/lib/ui/hooks.ts`）把回调钉成稳定引用；
- 父组件侧的回调统一 `useCallback`，并且 `setState` 前做"内容真的变了吗"的短路
  （`setDocs` 返回新数组即使内容没变也会触发重渲染，这是循环的燃料）。

**回归测试**：`tests/ui/render-loop.test.tsx` 用 `react-test-renderer` 真的把组件
渲染起来，数请求次数。它刻意用内联箭头函数当 props —— 把 `useStableCallback`
去掉就会立刻变红（已验证）。

### 5.1.1 看门狗的判据：渲染**间隔**，不是次数

组件上挂了 `useRenderWatchdog`（`src/lib/ui/hooks.ts`），开发期判定为渲染循环时
会在控制台点名报错。

**第一版只看次数**（"1 秒内 ≥30 次"），结果是**每次 AI 流式回答都报警** ——
SSE 每来一个 token 就 `setStreamText`，30 次/418ms（约每 14ms 一次）
是完全健康的节奏。假失败比假通过更危险：一个总在误报的告警会让人学会忽略它。

现在要求**两个条件同时成立**：次数 ≥ 阈值 **且** 相邻渲染间隔的**中位数** < 4ms。

| | 中位间隔 | 为什么 |
| --- | --- | --- |
| 同步死循环 | **0ms**（实测 41 次/毫秒） | JS 线程被占满，没有机会回到事件循环 |
| AI 流式输出 | **20ms**（实测 0.05 次/毫秒） | 受网络分片与浏览器节流限制 |

四个刻意的选择：

1. **判据是"是否饿死事件循环"**，这是真假循环在物理上无法伪造的区别。
2. **用中位数而不是最小值**：流式输出里偶尔两个 token 一起到达会产生极快的一帧，
   最小值判据会被它带跑而误报。
3. **阈值留 5 倍以上余量**（真实值 0 vs 20，阈值 4）。宁可漏报也不误报。
4. **时钟可注入**（第 4 个参数，仅供测试）。"时间"是这条判据的核心变量，
   用真实时间写测试只能 sleep，既慢又随机器负载波动；注入可控时钟后
   "40 次同一毫秒"与"35 次间隔 20ms"都是精确构造的。

**这里还踩过一个"假通过"**：优化时把计数改成取自被裁到 24 个的样本数组，
而阈值是 30 —— 于是**报警条件永远不可能成立**，看门狗被静默废掉。
表现和"正确判断为不循环"一模一样，只能靠
`tests/ui/watchdog.test.tsx` 里那条"构造出真循环必须报"的用例发现。
教训：**诊断工具的"静默"和"正确判断"必须能区分开。**

**探针**：`window.__nodesRenderProbe()` 返回每个组件的渲染次数与中位间隔。
表格里的 `中位间隔ms` 一列是判断依据 —— 光看渲染次数分不出真假。

**读组件栈要注意**：React 19 给的组件栈是 **owner**（谁创建了这个元素），
不是"哪个组件抛的"。报错里出现 `at WorkspaceShell (...:705)`（那正是渲染
`<ChatPanel>` 的行）时，真正报警的是 ChatPanel —— 以消息里的 label 为准。

### 5.2 测试环境需要能跑 `.tsx`

Node 的 strip-only 类型擦除**不支持 JSX**（`.tsx` 会报 ERR_UNKNOWN_FILE_EXTENSION），
而"渲染循环"这类缺陷只有真的渲染组件才能发现 —— 类型检查和纯函数测试都抓不到。

因此 `tests/ts-resolve.mjs` 除了补全无扩展名导入，还会用项目里已装的 TypeScript
编译器把 `.tsx` 转译成 JS，并展开 `@/*` 路径别名。这样 `npm test` 就能直接跑
组件测试，代价是首次转译多花几十毫秒。

## 6. 数据库迁移必须由 getDb() 每次保证

这条同样来自一次真实的、很难从症状反推的缺陷。

`src/lib/db/index.ts` 用 `globalThis` 缓存 SQLite 连接（热重载必需，
否则每次都会新开句柄、很快耗尽文件句柄）。由此产生一个很隐蔽的后果：

> dev server 启动时 `createDb()` 跑的是**当时那份** `migrate`。
> 之后改了 schema 并加入新的列迁移，热重载只替换了模块与函数 ——
> `globalThis.__nodesDb` 里那个连接**原封不动**，新迁移一次都没跑过。
> 代码看起来完全正确，行为却不对，报错是 `no such column: xxx`。

更一般地说，"迁移只在建连接时跑一次"这个前提本身就不可靠：任何让连接
存活得比代码更久的情况都会让新迁移永不生效。所以改成 `getDb()` **每次**
都保证迁移已应用（进程内 `__nodesMigrated` 标志确保只做一次实际工作）。

同时把**数据目录**与 **schema 路径**解耦：

| 用途 | 来源 | 是否可覆盖 |
| --- | --- | --- |
| `schema.sql` | `process.cwd()` | 否（跟随代码所在的项目根） |
| 数据库目录 | `process.cwd()/.data` | 是，用 `NODES_DATA_DIR` |

原先两者都从 cwd 推导，导致"想换数据目录就必须改 cwd，一改 cwd 就找不到
schema.sql"，报出的错误（`ENOENT: ... schema.sql`）与真实意图毫无关系。

### 6.1 "跑过一次就记住"同样不行（第三课）

第一版修法是加一个 `__nodesMigrated` 布尔标志。但它**同样挂在 `globalThis` 上**，
热重载后依然是 `true` —— 于是新加的列/表照样等不到迁移。真实症状：
`no such table: conversation_doc_ref`、`table doc has no column named kind`，
而迁移代码明明写得没错、类型检查也全绿。

最终判据是**内容有没有变**：把 schema.sql 的长度 + 内容指纹记在**模块作用域**
（模块重载即失效，正是我们要的语义）里，没变就什么都不做，一变就重新执行
建表与列迁移。这样"改了 schema 就一定会生效"是无条件的，不依赖任何
跨热重载存活的状态。

教训可以概括成一句：**任何"只做一次"的初始化，只要它的记忆活得比代码久，
就一定会和代码不同步。**

**回归测试**：`tests/integration/migration.test.ts` 造一个**旧结构的库**
（有数据、缺 `appearance` 列），用真实的 `getDb()` 打开它，断言列被补上、
原有数据未丢、重复调用幂等。测试用带 query 的 `import(...?legacy=1)`
拿到一份独立模块实例（ESM 视不同 URL 为不同模块），并显式清掉
`globalThis` 上的连接缓存 —— 后者恰好演示了本节的结论。

## 7. 目录结构

```
src/
  app/
    api/          REST + SSE 路由
    globals.css   设计 token（深色主题）+ 外观 CSS 变量
    layout.tsx  page.tsx
  components/
    workspace-shell.tsx   全局状态、布局与可调分栏
    split.tsx             可拖拽分隔条 + 带记忆的尺寸
    sidebar.tsx           文档树（含就地重命名）+ 会话列表
    outline-panel.tsx     文档大纲导航
    editor-panel.tsx      Markdown 编辑 + 按块预览 + 大纲
    chat-panel.tsx        对话流 + @ 选择器 + 模型选择器
    cache-meter.tsx       分层缓存可视化
    cache-dashboard.tsx   实时明细 + 历史成本统计
    models-panel.tsx      模型配置
    appearance-panel.tsx  外观设置（字号/字体/颜色）
    settings-modal.tsx    人设 / 约定 / 外观
  lib/
    cache/
      layers.ts     分层定义、稳定排序、块正文渲染
      assemble.ts   上下文组装器 + 命中预测 + 断点决策（核心）
      pricing.ts    价格表、成本与节省、盈亏平衡
      source.ts     数据库块 → SourceBlock（cacheKey 语义的唯一出口）
    providers/
      types.ts      Provider 接口 + NormalizedUsage + 可操作错误信息
      sse.ts        SSE 逐行解析（跨 chunk 断行）
      openai.ts     OpenAI 兼容适配（流式）
      anthropic.ts  Anthropic 原生（cache_control 断点）
      index.ts      注册表 + 配置解析
    blocks/
      parse-blocks.ts  Markdown ↔ 知识块（**前后端共用**，无 Node 依赖）
      markdown.ts      在纯解析之上补哈希与 cacheKey（需 node:crypto）
    assets/store.ts     图片素材：内容寻址、魔数判定、id 白名单
    render/markdown.ts  零依赖 Markdown → HTML（客户端，含 XSS 防护）
    db/
      schema.sql    表结构
      index.ts      连接、迁移、播种（迁移由 getDb 每次保证）
      defaults.ts   默认人设（L0）与约定（L1）—— 无依赖，服务端与客户端共用
      repo.ts       仓储 + 追加式修订的块身份认领
      types.ts      领域类型 + 外观设置与容错解析
    ai/chat.ts      一轮对话的编排：组装 → 发送 → 落库 → 统计
    ui/             前端 API 客户端 / 视图类型 / hooks / 格式化
    api/http.ts     路由共用工具
    tokens.ts       轻量 token 估算 + 缓存块对齐
tests/
  assemble.test.ts      组装器不变式（顺序无关、失效定位、断点决策…）
  markdown.test.ts      渲染器（XSS、代码块短路、表格、列表、图片…）
  persona.test.ts       L0 身份内核的措辞契约（不稀释人设、不否决查漏补缺）
  outline.test.ts       大纲层级树解析与面板渲染
  ui/
    render-loop.test.tsx  组件渲染回归（渲染循环、回调引用稳定性）
    watchdog.test.tsx     看门狗判据（注入时钟：真循环 vs 流式输出）
  integration/          集成测试（临时目录里跑真实 SQLite）
    pipeline.test.ts    Markdown → 块 → 组装 → 预测 → 成本 全链路
    providers.test.ts   本地 mock 服务端验证 SSE 解析与请求体构造
    errors.test.ts      HTTP 错误信息与可操作提示
    migration.test.ts   旧库的列迁移与幂等性
    coverage.test.ts    模块覆盖度（含子树展开）
    assets.test.ts      素材：魔数、路径穿越、内容寻址、渲染
    empty-reply.test.ts 空回复归因：思维链烧完预算 / 纯截断 / 只想不写 / 真空响应
scripts/
  integration-run.mjs   在临时目录里跑集成测试
  smoke.mjs             HTTP 端到端冒烟
  check-encoding.mjs    检测源码里被写坏的中文
  fix-encoding.mjs      判断某个乱码文件能否无损还原
  retheme-ink.mjs       一次性 codemod：硬编码文字色 → CSS 变量
```

## 8. 验收标准（当前状态）

| # | 标准 | 状态 |
| --- | --- | --- |
| 1 | `npm run typecheck` 通过 | ✅ |
| 2 | 同一组块以不同 @ 顺序传入 → 渲染字节与 prefixHash 完全相同 | ✅ 单测 |
| 3 | 编辑被引用的块 → 失效层精确落在 L2 正文，清单与 L0/L1 保持命中 | ✅ 单测 |
| 4 | 连续两轮对话 → 第二轮预测命中显著大于 0，且成本低于不缓存 | ✅ 集成测试 |
| 5 | 仪表盘展示每轮 cached / write / miss、成本与节省 | ✅ 冒烟测试验证接口契约 |
| 6 | 旧结构的库能被自动迁移且不丢数据 | ✅ 集成测试 |
| 7 | `npm run build` 通过 | ⚠️ 受限沙箱下 Next 需 spawn worker，被拒；详见 README「已知限制」 |

测试规模：**135 项单元 + 40 项集成 + 86 项 HTTP 冒烟**，全部通过。

### 回归测试索引（改动前请先看这些）

| 改动区域 | 会被哪条测试守住 |
| --- | --- |
| 组装顺序、层定义 | `assemble.test.ts` 的「层顺序永远是 L0 → L4」 |
| 块排序规则 | 「同一组块以不同传入顺序组装…」 |
| 失效定位精度 | 「编辑被引用的块，失效层精确落在 L2 正文…」 |
| 断点决策 | 「所有层都变化时不打断点（打断点即白付 25% 写入费）」 |
| 缓存门槛语义 | 「前缀短于可缓存门槛时，明确标记缓存未生效而非仅仅命中 0」 |
| 模块层（L2_doc_*） | `doc-layers.test.ts` 全量：摊平、排序确定性、整篇裁剪、层顺序 |
| 块身份认领 | `pipeline.test.ts` 的「编辑一个块…」与「在文档中间插入一段…」 |
| 图表语法与布局 | `diagram.test.ts` 全量：解析容错、分层、确定性、XSS |
| Markdown 与颜色标记 | `markdown.test.ts` 全量（含行内逃逸与协议白名单） |
| SSE 解析 | `providers.test.ts` 的「逐块到达的 SSE 被正确还原为文本增量」（按 7 字节切包） |
| usage 口径 | `providers.test.ts` 的「解析 cache_read / cache_creation 并补全输入总量」 |
| 错误可读性 | `errors.test.ts` 全量 |
| 数据库迁移 | `migration.test.ts` 的「旧结构的库经 getDb() 后自动补上 appearance 列…」 |
| 回调引用稳定性 | `render-loop.test.tsx` 与 `editor-outline.test.tsx`（去掉去重即变红） |
| 看门狗判据 | `watchdog.test.tsx` 全量（真循环必报 / 流式必静默，用注入时钟构造） |
| 大纲层级树 | `outline.test.ts` 的 `parseHeadings` 各条 |
| 分栏尺寸 | `split.test.tsx` 全量（边界夹取、记忆、隐私模式） |
| 图片素材 | `assets.test.ts` 全量（魔数、路径穿越、内容寻址、渲染）与 `markdown.test.ts` 的图片一节 |
| 空回复归因 | `empty-reply.test.ts` 全量（四种形态分开归因 + 失败轮次不当缓存基准） |
| L0 措辞契约 | `persona.test.ts` 全量（不稀释人设、不否决查漏补缺、事实与判断的划界） |
| 缓存门槛一致性 | `assemble.test.ts` 的「低于门槛时命中与写入必须一起归零」 |
| 最大输出（留空 = 不限制） | `migration.test.ts` 的「旧库的 max_tokens 旧默认值被改成不限制（NULL），用户手改过的值保持不动」（含外键悬空、索引丢失、幂等三项）、`providers.test.ts` 的「不限制时请求体里没有 max_tokens 这个键」、`tests/ui/models-max-tokens.test.tsx` 全量 |
| 最大输出表单语义 | `tests/ui/models-max-tokens.test.tsx`（留空**必须显式提交 `null`** 而不是省略字段；`null` 渲染成空输入框；非法值被拦下） |
| 前端契约 | `scripts/smoke.mjs` 全量（含 9.5 节的素材上传/取回/拒绝伪装） |

## 9. 编辑源码时的注意事项

**不要用 PowerShell 改含中文的源文件。** 这台机器上是 PowerShell 5.1，
它的 `Get-Content -Raw` 默认按系统 ANSI 代码页（中文 Windows 是 GBK）解码，
`Set-Content -Encoding utf8` 再按 UTF-8 写回 —— 等于让每个中文字符走了
"GBK 解码 → UTF-8 编码"一轮，结果全变成 `锛/銆/鈥` 这类乱码。更糟的是
加 `-NoNewline` 会把换行吞掉，让多个注释行与**代码行**连成一行，
可能静默地把代码注释掉（类型检查不一定报错）。

这类损坏已经真实发生过两次（`chat-panel.tsx` 与 `DESIGN.md`），其中
`DESIGN.md` 因为写入了替换字符而无法还原，只能整体重写。

防护措施：

- 改文件用编辑器工具（`write` / `edit`），不要用 shell 做字符串替换；
- `node scripts/check-encoding.mjs src` 扫描乱码并给出**行号**；
- `node scripts/fix-encoding.mjs <file> check` 判断某个乱码文件能否无损还原
  （若"码点超出单字节的字符数"很大，说明已经不可恢复，别再试图自动还原）。
