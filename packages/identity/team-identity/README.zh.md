---
description: "共享 DSH 部署中的团队成员、已签发令牌，以及回答「谁在调用」的签名 cookie。"
kind: "package-reference"
---

# @deepseek-ai/dsh-team-identity

[English](README.md) | 中文

<a id="summary"></a>
## 概述

把成员登录进一个共享的 DSH 部署，并让每一个已准入的请求都带上**服务端解析出的调用者**。在配置里声明名册；成员用姓名加登录码登录，拿到一枚绑定请求 authority 的签名 cookie。本包会把自身安装为传输层的身份解析器，因此归属、审计与事件定向都可以**从传输层读调用者**，而不必相信任何载荷。吊销某个成员会立即让其令牌失效，并关掉他已有的流。**准入本身不变**：每个请求仍然先过 DSH 浏览器 cookie。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它挂到为团队服务的那个 profile 上，声明成员，然后让成员在浏览器页面里登录一次。

### 何时选它

当一个 DSH 进程要服务**不止一个人**、且操作必须能归到具体成员名下时，就选它。没有它，部署保持 DSH 的单用户行为：每个已认证的浏览器都是同一个调用者，什么都记不到某个人头上。它不替代传输层 cookie，也不做资源授权——队内成员**本就可以互相查看**。

### 最小配置

```yaml
- id: team-identity
  name: '@deepseek-ai/dsh-team-identity'
  config:
    members:
      - userId: u-alice
        name: 爱丽丝
        signInCode: <personal code>
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `members` | `[]` | 准入的成员；空名册等于谁都不能登录 |
| `members[].userId` | 必填 | 记录在每一步操作上的稳定 id |
| `members[].name` | 必填 | 成员登录时使用的显示名 |
| `members[].signInCode` | 未设共享码时必填 | 只应由本人知道的登录码 |
| `members[].alternateSignInCode` | 未设 | 供没有专属码的成员使用的共享登录码 |
| `tokenTtlDays` | `30` | 一枚已签发令牌的有效期 |
| `tokenLimit` | `200` | 保留的活跃令牌上限，超出时最旧的先失效 |
| `homePath` | `$DSH_HOME` | 存放注册表文档的目录 |

本插件**未声明** `dsh.bundle.patch`，因此它以 `cordis.yml` 行的形式挂载，**不能**用 `dsh plugin add` 安装。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包拥有传输层**刻意不拥有**的三样东西：成员名册、已签发令牌表，以及承载某个令牌 id 的签名 cookie。

**两段 cookie，各司其职。** DSH 浏览器 cookie 回答"这个请求是否来自一个合法打开的页面"，归传输层；本包的 cookie 回答"**是哪个成员在调用**"。两者都是 `HttpOnly` 且绑定 authority，因此浏览器 RPC 通道、原始上传与 WebSocket 握手都会自动携带。

**一个成员同时只有一个有效会话。** 再次登录会结束该成员先前的会话，因此第二次登录是**替换**第一次，而不是叠加。两种情况落在同一条规则里：同一个人用第二台设备、以及别人拿到了他的登录码——处理方式都是**只保留最新那次登录**。被替换的会话，其已建立的流会被一并关闭（留在旧会话上的浏览器**不再收到任何内容**），它正在驱动的对话也会被释放，而不是继续挂在一个已不存在的会话名下。

**登录是精确路由，不是共享端点。** `/api/team.identity` 与 `/api/team.identity.page` 通过
`ctx.connection.fetch.register` 注册，而共享分发器**先解析精确路由、后走 interceptor 链**。这正是它们
"天生免于已登录检查"的原因——靠结构，而不是某个可能被判错的分支。传输层栅栏仍然先跑，所以这些路由是
**增加**准入，绝不替代它。

**未登录的浏览器拿到的是登录页，而不是应用外壳。** 插件对 index 文档做一次 tap，在 `<head>` 注入一小段
脚本，因此它先于外壳自身的脚本运行，可以**替换整个文档**，而不是覆盖一个已经挂载的应用。登录页是
服务端渲染的普通 HTML 加一段内联脚本：**不需要客户端 bundle、不需要构建、不需要浏览器侧插件**。这道门
是给未登录成员的便利，**不是安全边界**——每个 `/api` 路由都会在服务端重新校验同一枚 cookie。

**同步解析。** 注册表在插件激活时读一次，`resolve` 因此能只凭请求头在每个请求的热路径上作答。写入是
best-effort：home 不可写时本次运行照常服务。

**吊销能触达已建立的连接。** `revoke` 删除该成员的令牌并发出 `identity/revoked`；Remote 网关监听它并关掉该成员已建立的 WebSocket 连接——这是**按流检查永远回访不到**的地方。

**每个对话只有一个写入者。** 读取保持开放（互相看得到彼此的工作正是团队部署的意义），而**发消息、取消回合、改队列、切模型、重命名、分叉**属于**最先认领该对话的那个人**。判定在 **Remote 传输层**执行，因为那是唯一在方法运行前同时知道"谁在调用"和"调用哪个端点"的一层：策略看到的是服务端解析出的成员、端点与已解码参数。控制权**只能通过显式交接**改变，因此先前控制人的迟到操作会被**拒绝**，而不是悄悄获胜。

**交互请求只送到能回答的那个人。** 被转发的工具审批或 Agent 提问，需要**恰好一个操作者**来回答；广播给所有观看者就等于允许旁观者替别人应答。回答这个问题的正是同一份控制人绑定——**Agent 的身份就是它所属会话的 id**——传输层会为每个交互请求查询归属。未被认领的 Agent 解析为"无归属"，于是投递行为与原来完全一致，而**不是把请求丢掉**。吊销成员时也会释放他正在驱动的那些对话，因此绑定**绝不会比支撑它的令牌活得更久**。

**控制权移动时，该对话在等的请求会被重新投递。** 在某人驱动期间到达的请求，**不能**在他被替换之后由他来结清——他被替换，可能正是因为他已经不在。每一次转交都会告诉传输层：撤回该对话未完成的请求、通知**先前的持有人停止等待**、再重新投递给现在拥有它的人。**无人拥有的请求会留在原地**——把它撤回到"无处可去"会让 Agent 永远卡住。

**每一任控制权都有自己的租约编号。** 只把调用者与"当前控制人"比是不够的：一个成员交出控制权、看着别人接手、随后又拿回控制权，那么他在**第一任**期间产生的回答，照样能通过"你是不是控制人"这一比较。租约编号正是让那个回答**过期**的东西，所以**每一次获得控制权都会签发新的租约编号**。一次回答要同时引用**租约编号**、**投递编号**，以及在调用者声明了的情况下还要引用**页面实例**——三者缺一不可，因为它们各自堵一个不同的洞：租约挡住过期任期，投递编号挡住重放，页面实例挡住同一成员的另一个标签页。

租约**也会自行到期**，这覆盖了最常见的情形：控制人下班了。一次被接受的写入会**续期**，所以活跃控制人不会在工作中途丢掉对话；而过期的租约会**让下一个人认领**，而不是把所有人锁在外面。到期除了被惰性发现之外，还有**定时清扫**——因为关掉页面的控制人**再也不会写入**；没有清扫，他的对话会一直被占着，而它正在等的请求也会一直挂在"已经不在的人"名下。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、名册校验、解析器、路由与 index 门 |
| [`src/service.ts`](src/service.ts) | `TeamIdentity`：主体解析、登录、cookie 头、吊销 |
| [`src/registry.ts`](src/registry.ts) | 持久名册、令牌表、签名密钥、过期与上限策略 |
| [`src/cookie.ts`](src/cookie.ts) | 绑定 authority 的签名 cookie 编解码 |
| [`src/call-policy.ts`](src/call-policy.ts) | 谁可以写哪个对话，由 Remote 传输层询问 |
| [`src/session-control.ts`](src/session-control.ts) | 控制人绑定与显式交接 |
| [`src/http-route.ts`](src/http-route.ts) | 状态、登录与登录文档响应 |
| [`src/paths.ts`](src/paths.ts) | 路由与登录页共用的 Fetch 路径，独立成文件以避免循环导入 |
| [`src/sign-in-page.ts`](src/sign-in-page.ts) | 登录页标记、其内联脚本，以及 index 注入门 |
| [`tests/identity.spec.ts`](tests/identity.spec.ts) | 登录、cookie 绑定、吊销与注册表持久化 |
| [`tests/mount.spec.ts`](tests/mount.spec.ts) | 插件在真实 Connection 宿主上的贡献 |
| [`tests/sign-in.spec.ts`](tests/sign-in.spec.ts) | 登录页、文档与门的插入位置 |
| [`tests/session-control.spec.ts`](tests/session-control.spec.ts) | 控制人绑定与调用策略 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-client-connection](../../client/connection/README.zh.md)——拥有传输层栅栏与本包所安装的身份解析器接缝。
- [identity 组映射](../README.zh.md)——兄弟包与组范围。
- [dsh-home-paths](../../util/home-paths/README.zh.md)——拥有注册表文档的 `$DSH_HOME` 解析。
- [dsh-api-gateway](../../api/gateway/README.zh.md)——关闭被吊销成员已建立的 Remote 流。
- [dsh-web-app](../../bundle/web-app/README.zh.md)——成员登录时所用的浏览器 UI 所在 profile。

-----

<a id="model-experience"></a>
## Model Experience

None, as team identity answers transport questions about who is calling and registers nothing model-facing: no tool, no prompt section, and no member name, code, or token ever reaches the model.

#### KV Cache effect

None; identity is resolved per request at the transport and is injected into no conversation, so the token stream and the model-visible prefix are unchanged.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

登录今天就能用，但有三条边界是**刻意的**，不是没做完。

- **登录靠配置。** 轮换成员的登录码需要管理员改配置；没有自助注册。
- **暂时分不清同一人的多个标签页。** cookie 里还没有客户端实例 id，因此对话控制权那一步无法区分同一成员的两个标签页。
- **登录不等于授权。** 要区分"人点的确认"与"Agent 发起的动作"，需要报告侧契约要求的**人机确认凭据**；只有团队 cookie 表达不了这件事。
- **登录码是常数时间比较，但靠线下分发。** 把码送到本人手上仍是管理员的责任。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文——点击展开</summary>

注册表文档只保存每 home 的签名密钥与令牌表，所以丢失它只会让人退出登录，不会让人无法再次登录。损坏的文件被当作空注册表读取，**不会覆盖**原有内容；下一次变更才写出合法文档。

`lookup` 遇到过期令牌就顺手清掉，所以即使长期没人再登录，令牌表也不会无限增长；`issue` 则按 `tokenLimit` 保留**最晚过期**的令牌。

成员条目缺少 `userId` 或姓名为空时插件**直接失败**，而不是放进一个没人能称呼的成员。

</details>
