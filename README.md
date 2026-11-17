# SimpleCode / SpCode

**A Windows desktop AI coding assistant that works on real project files, runs project commands, combines online or local models, and can operate desktop applications.**

[English](README.md) | [简体中文](README.zh-CN.md) · [Download Windows installer](https://github.com/yjunwei295-gif/Spcode/releases/latest) · [Detailed English user guide](docs/user-guide.en.md) · [中文逐步操作手册](docs/user-guide.zh-CN.md)

Current release: **1.0.5 · Windows 10/11 x64**. The installer includes the application runtime. You do not need Node.js to use the installer. AI accounts, API credits and local model weights are configured separately.

## What is this application for?

SimpleCode gives you a chat interface connected to a folder on your computer. Instead of only suggesting code for you to copy, the assistant can inspect the project, locate relevant implementations, edit files, execute build or test commands, and report what actually changed. You can inspect changes and use the application's snapshot controls yourself when a change needs to be restored.

It is useful when you want to:

- **Understand an unfamiliar codebase:** open a project and ask which modules implement a feature, how they call each other, and where a change would take effect.
- **Implement or debug something:** describe the observed problem and expected behavior, review the proposed scope, let the assistant edit the project, and ask it to run the relevant verification.
- **Use different model services in one interface:** configure a provider and select its models, use supported Codex/Cursor/Claude Code integrations, or run compatible GGUF models locally.
- **Assign different models to different jobs:** choose a main “Brain” model and separate Planning, Code, Summary, Vision or media-generation models.
- **Work with a visual application:** enable the experimental AGI mode for screen reading, mouse movement, clicks, dragging and typing in Windows applications.
- **Create something besides source code:** request an interactive HTML/SVG demonstration, diagram or animation; preview it in a separate window and export supported formats. Local image generation and image-to-image use a separately configured image model.
- **Watch a running task away from the main window:** the desktop pet shows activity and the current Brain provider's available balance/usage, and expands into a conversation window.

For example, after opening a game project, you can ask: “Find why the camera jumps when this scene starts. First explain the call chain and the cause. Do not edit files yet.” After reviewing the explanation, you can authorize the fix and ask for a build or a reproducible behavior check.

## What happens between a request and a result?

1. **You choose the project folder.** The app's file operations and project commands are associated with that workspace. Additional folders can be attached explicitly.
2. **You select the model.** Requests go to the configured provider or local runtime. Selecting a model does not grant access to every paid model service.
3. **You describe the task and constraints.** You can attach files/images, reference project files with `@`, and select skills with `/`.
4. **The assistant uses SpCode tools.** Relevant file reads, searches, edits, commands or desktop actions appear as task activity. Ordinary mode can use a reviewable plan and Start workflow; AGI is designed for direct execution.
5. **You review evidence.** A written file is only a saved change. A passing build checks compilation; a behavior test checks the behavior it actually exercises. Ask for both when appropriate.
6. **You inspect or keep the result.** Changed-file records, snapshots, chat history and milestones help you review the work. Snapshot restoration is a user action in the interface.

## Feature overview

| Area | What you can do | What you need to configure |
| --- | --- | --- |
| Project work | Read/search code, inspect dependencies, edit files, run builds and tests | Open a project; allow commands if the task requires them |
| Online models | Save providers, fetch their model catalogs, select saved models | Provider protocol, URL and credentials/account access |
| SDK integrations | Use supported Codex, Cursor and Claude Code routes | A working local login or the authentication supported by that integration |
| Local text models | Download or select compatible GGUF weights and run them through the built-in runtime | Model folder, compatible model, sufficient RAM/VRAM |
| Model combinations | Assign Brain, Planning, Code, Summary, Vision and generation roles | Saved models or compatible local weights for the roles you use |
| Project context | Reference files, generate a project map, inspect outgoing prompt content | Open project; choose relevant context |
| Attachments | Add images, documents, files and video; submit image corrections during a running turn | A model/routing setup suitable for the attachment |
| Desktop automation | Read Windows UI/screen text and use mouse/keyboard tools | Enable AGI; keep the target application available |
| Local images | Text-to-image and image-to-image; saved and per-request generation parameters | Compatible local image model and generation engine |
| Code artifacts | Interactive HTML/SVG previews; PNG/source export; animated MP4 export | A project; FFmpeg on PATH for video export |
| Desktop pet | Task activity, expandable chat, skins, scale and glasses X/Y adjustment | Use the Pet button; choose appearance settings |
| Personal workflow | Skills, rules, persona, chat history, snapshots and milestones | Configure these in the app; review the defaults |

## New in 1.0.5

- **Session restoration:** preserve open tabs, their order, the active tab and drafts across a full exit and restart, with separate layouts for each window.
- **Task continuity:** keep pending work and mid-task corrections in the original conversation; serialize Codex requests for the same session until the previous stream exits.
- **Verified hot updates:** reload compatible methods and interface resources at idle boundaries while preserving conversation state. Initialization, function-signature and closure-layout changes require a full restart; a rejected update is never reported as applied.

See the [1.0.5 verification record](docs/release-1.0.5-verification.md) and [hot-update scope](docs/hot-reload.md). Fully exit all old instances before starting the new version.

## New in 1.0.4

- **Long-running tasks:** save a goal and permitted scope, set a check interval and per-turn timeout, start/stop recurring work, inspect memory, and resume from saved progress. Goal and context views reuse the existing maps.
- **Bounded automatic context:** paged JSONL archives retain full results on disk; selected context is limited to 20 historical rounds and response previews/checkpoints to 6000 trailing characters. Manual drafts and ordinary chat are preserved.
- **Provider improvements:** Cursor account/plan diagnostics and re-login handling; MXAPI OpenAI-compatible and native Nano asynchronous image routes.
- **Complete bilingual documentation:** both introductions and 21-section guides cover setup, controls, workflows, dependencies, and known limitations.

Recurring tasks require SpCode to remain open, the computer awake, the target tab active and other work idle. They do not run as a service after exit. Timeouts/interrupted work pause; this release has not been tested continuously for days or used to publish real social-media content.

## Full feature directory

| Feature family | Included behavior |
| --- | --- |
| Code navigation | Project map, symbol definitions/callers, source spans, exact and semantic search, dependency and chain views |
| Changes and execution | File creation/editing, tracked command changes, builds/tests, plan/status maps, configurable command sandbox/timeouts |
| Conversation | Multiple tabs/windows, history, automatic saving, persistent drafts, submission history, queue and mid-task text/image corrections |
| Context control | File references, attachment parsing, selected history rounds, assembled-prompt preview and per-send overrides |
| Web and tabular work | Request-driven web retrieval, document/spreadsheet parsing, table-image recognition and XLSX/WPS transfer |
| Model management | Provider templates/custom endpoints, model catalogs, SDK integrations, local GGUF downloads, roles and account/usage display |
| Desktop assistance | Windows OCR/UI Automation, window focus, mouse/keyboard/dragging, screen-request monitoring, read-only process observation |
| Creative work | Local text/image-to-image, API media routes, HTML/Canvas/SVG artifacts, PNG/source export, code audio, audio analysis and MP4 rendering |
| Personal workspace | Themes/language, skills, rules, persona, profile/global preferences, working memory, clipboard history, milestones and snapshots |
| Companion and recurring work | Animated pet, current-Brain quota, glasses/appearance settings, long-running goals, bounded archive context and memory status |

Read the [complete English guide](docs/user-guide.en.md) for each feature's actual controls and requirements. Features backed by an external model, application or service require that dependency; a generation slot does not supply a subscription or guarantee output quality.

## Install the published Windows version

1. Open [Releases](https://github.com/yjunwei295-gif/Spcode/releases/latest).
2. Expand **Assets** if necessary.
3. Download **`SimpleCode-Setup-1.0.5.exe`** for the installer. GitHub's “Source code” archives are not installers.
4. Fully exit an older running instance before installing an update.
5. Run the installer and select the destination when asked. For an update, use the existing installation directory.
6. Start **SimpleCode** from the shortcut.
7. Click **EN** at the upper right for English. Some newer panels still contain Chinese labels; the English guide gives the original labels alongside their meanings.
8. Configure a model before sending your first project request.

The installer is approximately 670 MiB. Model weights are not included. A portable executable is also available in the release assets. The 1.0.5 installer SHA256 is:

```text
b119dfea6beb84fe33c8477badd9912ea8cbc3e32a22bd66a638bd80cfc7d1b0
```

For every individual click, field and expected result, follow [Installation and first run](docs/user-guide.en.md#s2).

## First successful project task

1. Open **File → Settings**.
2. Under **Model providers**, choose a provider template or create a custom provider. Match its protocol and Base URL to that provider's documentation; enter its API key when required.
3. Click **Test**, then **Add**.
4. Under **Model list**, select that provider and click **Fetch models**.
5. Check a model to save it, then click **Use** in **Saved models**. Click **Done** to close Settings.
6. If the setup wizard asks for module defaults, select models for **Summary**, **Code** and **Planning**, then finish the wizard. These roles can use the same saved model; you do not need three separate subscriptions.
7. Click **File → Open project** and select your project root.
8. Confirm the selected model in the model menu above the input controls.
9. Send: “Read this project and explain how it starts. Name the entry files and the main call chain. Do not modify any files.”
10. Review the response and tool activity. Once this works, try a small, clearly scoped modification.

If you use local models or a local SDK login instead of an API key, use the matching path in the [full guide](docs/user-guide.en.md#s4).

## Detailed instructions by task

| I want to… | Read this section |
| --- | --- |
| Understand the interface and terminology | [Interface tour](docs/user-guide.en.md#s3) |
| Add an API provider and select a model | [Online setup](docs/user-guide.en.md#s4) |
| Connect Codex, Cursor or Claude Code | [SDK integrations](docs/user-guide.en.md#s5) |
| Download and run a local model | [Local GGUF models](docs/user-guide.en.md#s6) |
| Configure Planning/Code/Summary/Vision | [Model roles](docs/user-guide.en.md#s7) |
| Open, clone or attach a project folder | [Workspaces](docs/user-guide.en.md#s8) |
| Make and verify a code change | [Coding workflow](docs/user-guide.en.md#s9) |
| Attach context or correct a running task | [Context, attachments and queue](docs/user-guide.en.md#s10) |
| Use the Windows mouse/keyboard assistant | [AGI desktop mode](docs/user-guide.en.md#s11) |
| Configure the pet and glasses | [Desktop pet](docs/user-guide.en.md#s12) |
| Generate an image or use a reference image | [Local image workflow](docs/user-guide.en.md#s13) |
| Create/export a diagram, web demo or animation | [Code artifacts](docs/user-guide.en.md#s14) |
| Customize skills, rules and personality | [Customization](docs/user-guide.en.md#s15) |
| Review changes, snapshots and history | [Review and recovery](docs/user-guide.en.md#s16) |
| Schedule recurring work and inspect archives | [Long-running tasks](docs/user-guide.en.md#s19) |
| Fix connection/setup problems | [Troubleshooting](docs/user-guide.en.md#s18) |
| Build and validate the source | [Development](docs/user-guide.en.md#s20) |

## Data, cost and practical limits

- Settings, chat history and logs normally live under `%APPDATA%\SimpleCode`. The installed app's default model folder is inside that directory; you can choose another folder.
- Online models receive the task content and context needed for their requests. Desktop tasks may include screen information. A local model option does not make a mixed local/cloud workflow entirely offline.
- Downloading model weights and first-use runtime components requires network access. Local inference still needs enough memory for the selected model.
- API and subscription costs, available models, account restrictions and balances depend on your provider. Manual balance entries are local estimates, not the provider's billing records.
- AGI is experimental and uses the real system mouse and keyboard. It can interfere with simultaneous manual interaction on the same desktop.
- Some labels, dialogs and default skills/persona remain Chinese even when English is selected. You can customize the persona and skills in the app.
- Image, video and 3D generation depend on supported model/backend combinations. A chat model does not automatically provide all generation capabilities.
- Voice input is not a completed speech-recognition workflow. The SSH entry is a local-folder/connection-check entry, not a full remote IDE.
- The published and verified target here is Windows x64. macOS/Linux installers are not provided by this release.

See [Data and privacy](docs/user-guide.en.md#s17) for the specific folders and sharing considerations.

## Run from source

Use a current Node.js LTS release (Node.js 24 is recommended), npm and Git. The local-inference dependency requires Node.js 20 or newer; this is separate from the bundled runtime used by the installed application.

```cmd
git clone https://github.com/yjunwei295-gif/Spcode.git
cd Spcode
npm install
npm start
```

Build Windows installer and portable executable:

```cmd
npm run dist:win
```

Validate the packaged app after building:

```cmd
node scripts/verify-release.cjs
```

Detailed source setup, tests and output locations are in [Development and validation](docs/user-guide.en.md#s20). The [1.0.4 verification record](docs/release-1.0.4-verification.md) lists tested behavior and omitted checks.

## Repository layout

| Path | Purpose |
| --- | --- |
| `electron/main.js` | Application startup, windows and IPC |
| `electron/lib/` | Agent, project tools, models, generation and desktop-pet implementation |
| `renderer/` | Main interface and client-side modules |
| `skills/`, `rules/` | Bundled workflow instructions and defaults |
| `scripts/` | Launch, build, release and verification scripts |
| `docs/` | User guides and technical documentation |
| `models/` | Source-mode model directory; large weights are not distributed with the installer |

## License

The repository includes the [Apache License 2.0](LICENSE). Third-party dependencies and model weights have their own licenses and usage conditions.
