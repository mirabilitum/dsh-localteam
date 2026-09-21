# DSH Team Collaboration Patch for Local Networks

[简体中文](README.zh-CN.md) | English

> This patch is based on **DSH 0.1.6-alpha.1** and retains the upstream appearance.
>
> **Compatible source revision:** `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` ([upstream commit](https://github.com/deepseek-ai/deepseek-harness/commit/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720)). Use this exact source revision when applying the patch. The current upstream tip and other DSH versions are not covered by this release.

Turn your own computer into an AI collaboration server for a small team.

Download the current patch: [`dsh-team-0.1.6-alpha.1.patch`](patches/dsh-team-0.1.6-alpha.1.patch).

Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), this patch adds member sign-in, shared conversations, conversation control, project directory management, and deliverable downloads for small teams, research groups, and project groups. An administrator deploys it on one computer. Other members connect through a browser on the local network, sharing project files and model services on the server.

It suits teams that want to keep source materials, conversations, and project results together, reducing repeated file transfers and explanations of the same background. The server can be an office computer or a dedicated machine. It must stay powered on, keep the service running, and remain reachable from members' devices while in use.

## What you can do

- **Follow progress together**: Members can open shared conversations to see discussions, execution progress, and existing outputs without waiting for the person doing the work to prepare an update.
- **Continue each other's work**: Transfer control to continue an existing conversation, or start a new conversation in the same project to split up tasks while reusing existing files.
- **Organize project materials in one place**: Keep source materials, intermediate data, deliverables, and temporary files separate so finished work does not get mixed with drafts.
- **Take server outputs with you**: Download individual files in the browser, or select multiple deliverables and download them as an archive to your own computer.
- **Share one service**: The administrator configures model credentials and membership centrally. Members do not need their own DSH installations.

## How the team collaborates

### Share files and progress within a project

A project is a shared working directory. A conversation is a discussion focused on a particular task. A project can contain several conversations for work such as organizing materials, analyzing data, and writing reports.

For example, Alice starts by organizing materials. Bob can view Alice's conversation and outputs directly to see how far the work has progressed. When Alice finishes, she tells Bob where the results are and what to do next. Bob can continue without receiving another archive of the entire project.

There are two ways to continue:

| Situation | What to do |
|---|---|
| You need the current conversation's context | The current controller transfers control to the next member from the conversation header, and that member continues the conversation |
| You need to start another task or organize a fresh conversation | **Start a new conversation in the same project directory**, describe the task, and ask the agent to read the existing materials and results |

A new conversation can access files in the same project, but it does not automatically inherit the full context of other conversations. Saving important conclusions, procedures, and next steps in project files makes it easier for the next person to continue.

### Everyone can view; the controller operates

Members do not need to take control to view a conversation. The current controller performs controlled actions such as submitting prompts, preventing several people from issuing instructions to the same conversation at once.

- For a normal handover, choose the receiving member from the control menu in the conversation header.
- If the controller is away, other members can explicitly take over after **15 minutes** of inactivity by default. The administrator can configure this interval.
- When project write serialization is enabled, if one conversation is already performing a controlled write task in a project, another receives a busy message and must retry later. Starting a new conversation does not bypass this restriction.
- Different projects can progress independently. Actual parallel capacity depends on server resources and the model service.

## How permissions work

Permissions cover member sign-in, conversation control, and agent file operations.

| Area | How it works |
|---|---|
| Member sign-in | The administrator maintains the member roster. Members sign in with a name and invitation code; signing in again with the same account invalidates the previous login |
| Conversation control | Members view together, while the current controller performs controlled actions. Control can be transferred or taken over under the inactivity rule |
| Working directories | The administrator sets the team workspace and the directory that holds projects. The directory picker stays within the configured scope |
| Agent operations | Operations follow the permission preset. Actions requiring broader permissions go through the approval flow |

A team deployment can retain just two common permission presets:

- **read-only**: For viewing and analysis; this preset does not allow writes.
- **workspace-write**: Allows writes within the workspace, suitable for generating reports, processing data, and modifying project files.

Operations requiring broader permissions go through approval; members do not receive unrestricted filesystem access by default. The administrator can also disable the web terminal.

This is a shared working environment for a team whose members trust each other. Projects are currently shared and visible rather than private to individual members. Outbound network access and environment variables are not isolated, some write entry points are not yet covered by collaboration controls, and individual file operations cannot yet be attributed to a specific member.

## How project outputs are organized

Creating a project through the directory picker inside the configured projects directory automatically creates a standard directory structure and an `AGENTS.md` project rules file. Members and agents can then organize materials consistently.

| Directory | Purpose | Examples |
|---|---|---|
| `input/` | Original materials supplied from outside the project; preserve originals under the project rules and process separate copies | Source spreadsheets, reference documents, received datasets |
| `build/` | Reusable intermediate outputs that are costly to regenerate | Cleaned data, databases, indexes |
| `work/` | Results ready to deliver for others to read or use | Reports, charts, final scripts |
| `logs/` | Process records | Processing notes, execution logs |
| `sessions/<session>/temp/` | Temporary files belonging to each conversation | Working drafts, temporary scripts, download caches |

You can tell the agent directly: **“Read the materials in input, put intermediate data in build, and save final deliverables in work.”**

The directory structure and rules distinguish file categories, and the download interface exposes only deliverables in `work/`. Members and agents must organize files according to those rules; the system does not currently identify and move every file automatically. Keep temporary drafts out of `work/`, where other members will treat them as deliverables.

## How to download results from the server

Files are generated on the server. Members can save them to their own computers through the browser without signing into the server's desktop.

1. Open a conversation in the relevant project.
2. Click the download icon beside the conversation title to view the deliverables in `work/`.
3. For one file, click its individual download action.
4. For multiple files, select them and click the action to download the selected files as a ZIP archive.

Downloading does not require taking control of the conversation. If the list is empty, check that the results have been written to `work/`. The archive does not include `input/`, `build/`, `logs/`, or temporary directories. Files exceeding the server's download limits need to be split into smaller parts.

## Getting started

**Administrators**: Prepare a computer reachable from the team's devices, install the specified DSH source version and apply the patch, then configure the team workspace, members, model credentials, and listening address. Start the service and distribute access links and member invitation codes.

The source version for this release is the exact commit [`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/tree/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720). It is not a patch for the moving upstream `master` branch. When a newer DSH version is released, the patch must be rechecked and may need a new release.

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git source
Set-Location source
git checkout 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720
```

**Team members**: Open the token-bearing link supplied by the administrator, sign in with your own name and invitation code, select or create a project, and start a conversation. Members only need a modern browser; they do not need to download the source code.

Installation requires the specified source revision; matching version numbers alone do not make arbitrary source copies interchangeable. The exact revision and installation commands belong in the installation guide.

The access address is created by the administrator's running instance. After startup, the administrator gives team members the server's LAN address together with the token-bearing link printed by DSH; there is no single public deployment URL shared by every installation.

### Directories the administrator needs to prepare

Choose your own deployment location; the patch does not depend on its author's computer paths. The Windows example below uses `C:\DSH-Team`. You can choose another location with enough space and use its corresponding paths in the configuration.

| Directory | Purpose |
|---|---|
| `source/` | The specified DSH source version, dependencies, and build outputs |
| `home/` | Team instance configuration, credentials, and conversation data: `DSH_HOME` |
| `workspace/` | The team workspace: `workspaceRoot` |
| `workspace/projects/` | The directory containing individual projects: `projectsRoot`, also used as the directory picker's root |

First create the configuration and working directories in PowerShell:

```powershell
$teamRoot = 'C:\DSH-Team' # Example location; choose your own if needed
$teamHome = Join-Path $teamRoot 'home'
$teamWorkspace = Join-Path $teamRoot 'workspace'
$teamProjects = Join-Path $teamWorkspace 'projects'
New-Item -ItemType Directory -Force -Path (Join-Path $teamHome 'profiles\web'), $teamProjects | Out-Null
$env:DSH_HOME = $teamHome
```

Place the source code in `source/` and the team configuration in `home/profiles/web/cordis.patch.yml`. In the team plugin configuration, set `workspaceRoot` to the workspace's actual absolute path and `projectsRoot` to the projects directory's actual absolute path. Point the directory picker's `root` at that same projects directory. Windows paths in YAML can use single quotes.

Set `DSH_HOME` on every startup or include it in your local startup script. Keep this directory separate from the source code and members' workspace. Use the server's own LAN IP as the listening address; members connect to the server's address, not `localhost` on their own computers.

### How the administrator creates members

Membership is currently managed through configuration. There is no web self-registration or member administration dashboard. Edit `home/profiles/web/cordis.patch.yml` in the team instance and add members to the existing `team-identity` plugin's `config.members` list.

The following is an example of that list, **not a complete deployment configuration**. Preserve the plugin's other settings and do not insert a duplicate plugin:

```yaml
members:
  - userId: member-001
    name: Alice
    signInCode: 'REPLACE_WITH_A_UNIQUE_RANDOM_CODE'
  - userId: member-002
    name: Bob
    signInCode: 'REPLACE_WITH_ANOTHER_UNIQUE_RANDOM_CODE'
```

- `userId` is a stable, unique member identifier. Keep it unchanged when renaming a member.
- `name` is the name entered at sign-in. Use a different name for each person.
- `signInCode` is that member's personal invitation code. Replace the placeholders with distinct random values and send each code privately to its member. Do not commit the real roster to the repository.

The Web instance supports live configuration updates, so a valid roster takes effect when saved; start the instance for the initial configuration. To remove a member, delete their entry from the list. Their previous login and connections will be invalidated. An empty roster admits nobody.

> These instructions cover directories and membership. The complete team deployment template, startup script, and installation guide are being prepared; the roster snippet alone is not enough to start the team edition.

## Future plans: reusable project methods

We plan to preserve methods developed during projects as reusable team knowledge, including procedures, prompts, processing scripts, project conventions, and retrospective findings.

The aim is to help the next member, a new conversation, or a new project find and reuse existing methods, gradually reducing repeated trial and error while keeping both project results and the methods used to produce them.

This is planned work. For now, teams can manually document methods and conclusions in project files. Automatic knowledge capture, archiving, and reuse across projects are not yet available.

## Upstream project

This project extends [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through a patch. The upstream project and its components are governed by their respective license files and third-party notices. Preserve those files when distributing them.
