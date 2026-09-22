# DSH 团队版安装与使用说明

> 本团队版基于 **DSH 0.1.6-alpha.1**。请下载本仓库的 **`team-dsh-0.1.6-alpha.1` 分支**，其中已包含完整 DSH 源码和团队改造，无需再应用补丁。
>
> 本文以 **Windows 服务器 + 局域网浏览器访问**为例。`main` 分支只提供补丁；上游 npm 包和官方安装包不包含本仓库的团队改造。

让一台自己的电脑成为小团队的 AI 协作服务器：成员共用模型服务、项目文件和会话，可以查看彼此进度、移交会话控制权，并下载项目产物。只有服务器需要安装，其他成员用浏览器访问即可。

## 1. 管理员先准备什么

- 一台在使用期间保持开机、网络可达的 Windows 电脑。
- Git、Node.js 24 LTS、pnpm 11.7.0。源码也支持 Node.js 22.19 及以上的 22.x 版本。
- PowerShell 7（`pwsh`），供 Windows 下的 Agent 执行命令使用。
- 可用的模型 API 密钥；调用费用由所配置的模型服务计费。
- 服务器的局域网 IPv4 地址，以及一个空闲端口。

在 PowerShell 中检查工具：

```powershell
git --version
node --version
pnpm --version
pwsh --version
```

没有 pnpm 时，可在安装 Node.js 后执行：

```powershell
npm install --global pnpm@11.7.0
```

下文使用 `C:\DSH-Team` 和端口 `3081` 作为示例。请选一个新的部署目录；已有 DSH 实例时，使用不同的源码目录、`DSH_HOME`、工作区和端口，不要覆盖它的配置或停止它的进程。

## 2. 下载团队版并构建

在 PowerShell 中逐条执行；某一步报错时先处理错误，再执行下一步：

```powershell
$teamRoot = 'C:\DSH-Team'
New-Item -ItemType Directory -Force -Path $teamRoot | Out-Null
Set-Location $teamRoot

git clone --branch team-dsh-0.1.6-alpha.1 --single-branch https://github.com/mirabilitum/dsh-localteam.git source
Set-Location (Join-Path $teamRoot 'source')

pnpm install --frozen-lockfile
pnpm run build
```

也可以在 [团队版分支页面](https://github.com/mirabilitum/dsh-localteam/tree/team-dsh-0.1.6-alpha.1) 选择 **Code → Download ZIP**，将解压后包含 `package.json` 的目录作为 `source`，再进入该目录执行依赖安装与构建。ZIP 下载方式不能直接使用后文的 `git pull` 更新。

安装和日常启动不需要执行 `pnpm run test:e2e`。它是开发测试命令，与 GitHub Actions 中的自动测试独立，不是团队服务的启动步骤。

## 3. 建立配置与项目目录

```powershell
$teamRoot = 'C:\DSH-Team'
$teamHome = Join-Path $teamRoot 'home'
$teamProjects = Join-Path $teamRoot 'workspace\projects'
New-Item -ItemType Directory -Force -Path (Join-Path $teamHome 'profiles\web'), $teamProjects | Out-Null
```

部署目录如下：

```text
C:\DSH-Team\
  source\                     团队版源码、依赖和构建结果
  home\                       模型凭据、配置和会话数据
    profiles\web\
      cordis.patch.yml        团队配置，下一节创建
  workspace\
    projects\                 各个项目的父目录
  start-team.ps1              启动脚本，第 5 节创建
```

路径可自行更换。更换后，目录创建命令、配置模板和启动脚本都要使用相同的实际路径。

## 4. 配置团队功能与成员

新建 `C:\DSH-Team\home\profiles\web\cordis.patch.yml`，以 UTF-8 保存下面的完整内容。该模板用于新的独立实例；已有配置需要合并，不能直接覆盖。

请先将两个 `signInCode` 占位符换成不同的随机登录码，并按实际情况修改姓名和路径。可以执行 `[guid]::NewGuid().ToString('N')` 为每名成员生成一个随机码。

```yaml
- insert:
    - id: team-identity
      name: '@deepseek-ai/dsh-team-identity'
      config:
        members:
          - userId: member-001
            name: Alice
            signInCode: 'REPLACE_WITH_ALICE_RANDOM_CODE'
          - userId: member-002
            name: Bob
            signInCode: 'REPLACE_WITH_BOB_RANDOM_CODE'
        tokenTtlDays: 30
        takeoverIdleMinutes: 15
        workspaceRoot: 'C:\DSH-Team\workspace'
        projectsRoot: 'C:\DSH-Team\workspace\projects'
        serializeProjectWrites: true
        sessionTempDirectory: true
        projectScaffold: true

- id: terminal-controller
  disabled: true

- id: ui-sidebar-terminal
  disabled: true

- id: directory-picker
  disabled: true

- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
      config:
        root: 'C:\DSH-Team\workspace\projects'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'

- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
        name: '只读'
        description: '查看和分析，不允许写入。'
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: '工作区写入'
        description: '在工作区内生成和修改文件，额外权限需要审批。'
```

这份配置启用成员登录、会话控制、项目目录骨架、会话临时目录和项目写入协调，并关闭网页终端。目录选择器从 `workspace\projects` 开始浏览。

### 创建、修改与移除成员

当前通过上述 `members` 列表维护账号，没有网页自助注册或成员管理后台。

| 字段 | 怎么填写 |
|---|---|
| `userId` | 每人唯一且固定；改名时保留原值 |
| `name` | 成员登录时输入的名字，每人使用不同名字 |
| `signInCode` | 该成员个人的随机登录码，单独发给本人 |

管理员也在列表中给自己建一个成员账号。这里的“管理员”指负责服务器部署和配置的人，当前没有独立的管理员角色或按角色隔离设置的功能；已登录成员也能操作部分全局设置，团队应约定由部署负责人维护模型和公共配置。

增加成员时复制一条成员记录，修改三个字段；移除成员时删除整条记录。保存有效配置后，运行中的 Web 实例支持热更新；被移除成员的旧登录和连接会失效。列表为空时无人能够登录。同一账号再次登录会替换此前的登录，成员应各用各的账号。

## 5. 启动服务器

用 `ipconfig` 查看服务器的局域网 IPv4 地址。下面的 `192.168.1.20` 是示例，必须换成服务器实际使用的局域网地址。

新建 `C:\DSH-Team\start-team.ps1`，填入：

```powershell
$ErrorActionPreference = 'Stop'
$teamRoot = 'C:\DSH-Team'
$teamAddress = '192.168.1.20'
$teamPort = 3081

$env:DSH_HOME = Join-Path $teamRoot 'home'
Set-Location (Join-Path $teamRoot 'workspace')

node (Join-Path $teamRoot 'source\apps\cli\lib\bin.js') web --host $teamAddress --port $teamPort --trusted-host "${teamAddress}:${teamPort}" --no-open
```

在 PowerShell 中运行：

```powershell
& 'C:\DSH-Team\start-team.ps1'
```

如果电脑的执行策略不允许运行 `.ps1`，也可以把脚本内容逐行粘贴到 PowerShell 中执行。

脚本调用的是团队版构建后的 DSH CLI，并每次指定独立 `DSH_HOME`。不要改成 `npx @deepseek-ai/dsh web`，那会运行上游 npm 版。此版本启动参数会拒绝 `--host 0.0.0.0`，请绑定具体局域网 IP。

服务启动后保持该终端运行。关闭窗口或按 `Ctrl+C` 会停止这个实例；再次运行脚本即可启动。电脑休眠或关机期间，成员无法访问。

### 局域网连接与访问链接

如果 Windows 防火墙阻止其他设备访问，需要允许 Node.js 在相应的专用网络上通信，或添加允许局域网访问 TCP `3081` 的入站规则。服务器和成员设备应在可互通的网络中；访客 Wi-Fi 的设备隔离可能阻止访问。

启动终端会打印类似下面的地址：

```text
http://192.168.1.20:3081/?token=启动时生成的令牌
```

将终端打印的**完整链接**发给成员，而不是只发 IP 和端口。成员第一次打开时需要链接中的令牌，然后再用自己的姓名和登录码登录。成员电脑上的 `localhost` 指向成员自己，不能代替服务器地址。

每次服务启动会生成新的访问令牌。遇到认证失败或旧链接失效时，请使用本次启动打印的链接；服务器 IP 或端口变化后，也要重新分发地址。访问链接与个人登录码都属于访问凭据，不要写进公开文档或提交到 GitHub。

## 6. 配置模型

部署负责人先打开完整访问链接，用自己的成员账号登录，然后进入 **设置 → 模型**，填写提供方、API 密钥及模型配置并保存。

使用其他模型服务或兼容接口时，按实际服务填写 API 地址、协议和模型 ID，可参考随源码提供的 [模型配置说明](https://github.com/mirabilitum/dsh-localteam/blob/team-dsh-0.1.6-alpha.1/docs/user/guide/providers.zh.md)。

模型凭据保存在此实例的 `home` 中，成员共用服务器配置的模型服务，不需要各自安装 DSH 或填写 API 密钥。能打开页面和登录不代表模型已配置；要向 Agent 发出任务，还需要可用模型及相应额度。

## 7. 成员怎样开始使用

1. 打开管理员发来的完整链接。
2. 输入自己的姓名和个人登录码。
3. 在目录选择器中进入 `projects`，创建一个项目文件夹，例如 `weekly-report`。
4. 选择这个项目目录并新建对话，按任务选择“只读”或“工作区写入”。
5. 准备项目资料，说明任务，并让 Agent 将最终结果放入 `work`。

通过网页目录选择器在 `projects` 下直接新建项目，会生成下面的结构及项目规则文件 `AGENTS.md`：

| 目录 | 放什么 |
|---|---|
| `input/` | 原始资料，按项目规则保留原件 |
| `build/` | 清洗数据、索引等值得复用的中间结果 |
| `work/` | 可交付的报告、图表、脚本等最终结果 |
| `logs/` | 处理说明和过程记录 |
| `sessions/<会话>/temp/` | 每个会话自己的临时文件，使用时创建 |

新建项目请使用网页目录选择器；直接在资源管理器中创建文件夹，或选择已有目录，不会自动触发上述项目骨架生成。不要把 `projects` 父目录当作所有任务共同使用的单个项目。

资料需要位于服务器的项目目录中，例如请部署负责人将收到的文件放入该项目的 `input`。成员自己电脑上的路径不会自动同步到服务器。

可以这样开始任务：

> 读取 input 中的资料，整理数据放入 build，最终报告保存到 work，临时文件放入本会话的 temp，并把处理过程写入 logs。

目录和规则帮助团队统一归类，系统不会自动识别并搬运所有文件。团队应按约定存放资料和产物。

## 8. 查看进度与接续工作

项目文件和会话由团队共享。成员可以打开其他人的会话查看进度，不需要先接管控制权。发送提示词等受控操作由当前控制人执行。

| 需要做什么 | 怎么操作 |
|---|---|
| 继续同一个任务和对话上下文 | 当前控制人在会话头部的控制权入口选择接收成员，移交后由对方继续 |
| 在同一项目中做另一件事 | 选择相同项目目录，新开对话，告诉 Agent 阅读哪些已有资料和结果 |
| 控制人暂时离开 | 达到配置的闲置条件后，其他成员可手动接管；默认 15 分钟，等待审批等状态可能阻止接管 |

控制权不会仅因时间到了而自动转给别人。新对话可以读取同项目文件，但不会自动继承其他对话的全部上下文；重要结论、当前进展和后续任务应写入项目文件。

例如：Alice 整理资料时，Bob 可以直接查看进度和输出。Alice 完成后，既可以把当前会话交给 Bob，也可以告知成果路径，让 Bob 在同一项目中新开对话继续分析。不必重新打包整个项目或反复转述背景。

模板启用了项目写入协调。同一项目已有受控写入任务时，另一个会话可能收到忙碌提示，需要等待后重试；不同项目可以分别推进，实际并发能力取决于服务器和模型服务。

## 9. 把服务器上的成果下载到自己电脑

1. 打开对应项目的会话。
2. 点击会话标题旁的下载入口，查看 `work` 下的产物。
3. 下载单个文件，或勾选多个文件后下载 ZIP。

下载无需接管会话控制权。下载入口只提供 `work` 中的交付结果，不会把 `input`、`build`、`logs` 和临时文件一起打包。列表为空时，先确认 Agent 已将文件保存到该项目的 `work`；超过下载限制的文件需要拆分。

## 10. 日常维护与更新

- **重启**：停止本实例后重新运行 `start-team.ps1`；不要重复启动同一个 home 和端口。
- **备份**：停止本实例后备份 `home` 与 `workspace`，并保存启动脚本。`home` 含凭据，应作为私有备份保存。
- **换机器**：在新机器重新安装依赖并构建，迁移数据后修改配置中的绝对路径与启动地址；不要直接复制 `node_modules` 代替安装。
- **更新**：等待本仓库团队版更新，不要把上游最新源码直接覆盖到当前目录。上游其他版本不属于本次适配范围。

通过 Git 下载、源码没有自行修改时，先备份并停止要更新的这个实例，再执行：

```powershell
Set-Location 'C:\DSH-Team\source'
git branch --show-current
# 上一条应显示 team-dsh-0.1.6-alpha.1
git pull --ff-only origin team-dsh-0.1.6-alpha.1
pnpm install --frozen-lockfile
pnpm run build
```

每一步成功后再继续；遇到本地修改、冲突或构建失败先处理，不要强制覆盖。完成后重新运行启动脚本。

## 11. 常见问题

| 现象 | 处理方式 |
|---|---|
| 按上游说明安装后没有团队功能 | 确认下载了团队版分支，运行该目录内的 CLI，并加载本说明中的团队配置 |
| 没有登录页或没有项目目录入口 | 检查启动脚本的 `DSH_HOME`、配置文件位置和 YAML 缩进；避免文件实际名为 `cordis.patch.yml.txt` |
| 启动时报找不到构建文件或前端 | 在 `source` 中完成 `pnpm install --frozen-lockfile` 和 `pnpm run build` |
| Agent 提示找不到 `pwsh` | 安装 PowerShell 7，并在能执行 `pwsh --version` 的新终端中重新启动服务 |
| 服务器能打开，其他电脑打不开 | 检查具体 IP、端口、防火墙和网络隔离，并使用启动时打印的完整链接 |
| 页面显示认证失败 | 使用本次启动打印的带令牌链接，不要只输入裸地址或沿用失效链接 |
| 姓名或登录码错误 | 核对 `members` 列表与输入，确认已替换示例占位符 |
| 登录后原来的设备掉线 | 同一账号再次登录会替换旧登录，给每个人配置独立账号 |
| 出现端口被占用 | 改成空闲端口，并同步修改访问链接和防火墙规则 |
| 下载列表为空 | 检查当前项目的 `work`，文件留在其他目录时不会列出 |

## 12. 当前使用范围

适合相互信任的小团队、课题组和项目组在局域网共用。项目当前共享可见，没有按成员划分私有项目；权限预设和控制权也不代表所有写入口都已受控。

后续计划把项目中形成的方法、流程和脚本沉淀为可复用的团队经验。目前可以先在项目文件中保存方法和结论，尚无自动沉淀或跨项目自动复用功能。
