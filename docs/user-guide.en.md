# SimpleCode / SpCode — complete English guide

[GitHub introduction](../README.md) · [中文手册](user-guide.zh-CN.md) · [Windows downloads](https://github.com/yjunwei295-gif/Spcode/releases/latest)

This guide describes SimpleCode 1.0.4. SimpleCode is the application name; SpCode is the project/tool integration name. This is repository documentation: it does not change the application's language settings. Some controls retain Chinese labels, which are identified below.

## Contents

1. [Purpose and requirements](#s1)
2. [Installation and updates](#s2)
3. [Interface and controls](#s3)
4. [Online providers](#s4)
5. [Codex, Cursor and Claude Code](#s5)
6. [Local models and downloads](#s6)
7. [Model combinations](#s7)
8. [Projects and folders](#s8)
9. [Coding, plans and maps](#s9)
10. [Context and conversation input](#s10)
11. [AGI desktop operation](#s11)
12. [Desktop pet](#s12)
13. [Images and generation](#s13)
14. [Artifacts, audio and video](#s14)
15. [Customization and memory](#s15)
16. [History and snapshots](#s16)
17. [Data and cost](#s17)
18. [Troubleshooting](#s18)
19. [Long-running tasks](#s19)
20. [Development, Git and releases](#s20)
21. [Coverage and limits](#s21)

<a id="s1"></a>
## 1. Purpose and requirements

SimpleCode connects a conversation to a real project directory. The assistant can inspect implementations, locate symbols, explain dependencies, edit files, execute commands and verify results through SpCode tools. It can also operate Windows applications and produce generated assets or code-based visual works when the matching capability is configured.

The Windows installer includes Electron and the application runtime. End users do not need Node.js to launch it. A usable model is still required: an online API/account, a supported SDK login, or compatible local weights. The installer does not include paid subscriptions or large model weights. Local inference requires enough RAM/VRAM for the chosen model and context.

Typical tasks include understanding an unfamiliar codebase, debugging a game camera or UI, implementing a scoped change, running the relevant build, creating an interactive explanation, and handling visual application workflows. Describe the trigger, expected result, allowed scope and verification. For diagnosis alone, explicitly request read-only work.

<a id="s2"></a>
## 2. Installation and updates

1. Open the latest GitHub Release and expand Assets.
2. Download `SimpleCode-Setup-1.0.4.exe`. GitHub's Source code archives are source snapshots, not installers.
3. Fully exit older SimpleCode instances, including desktop-pet windows.
4. Run the installer and choose the destination. For an update, use the existing installation directory.
5. Launch SimpleCode from its desktop or Start menu shortcut.
6. Configure a working model, then open the intended project.

The build also produces `dist/SimpleCode-Portable-1.0.4.exe`. This release's online Windows asset is the setup installer; local outputs are not all automatically uploaded. First use of local inference, OCR or generation can require additional runtime/support downloads.

Settings and sessions normally remain in the app's user-data directory. A source edit, Git push or uploaded installer cannot replace an already running process. Fully exit, install and relaunch to load the new main process and preload code. A renderer refresh alone is insufficient.

The [release verification record](release-1.0.4-verification.md) gives the installer size and SHA256. On Windows, run `Get-FileHash -Algorithm SHA256 "path-to-downloaded-exe"` to calculate the download's digest.

<a id="s3"></a>
## 3. Interface and controls

| Area/control | What it does |
| --- | --- |
| File menu | Project open/recent, automatic save, settings, model combinations, skills, persona and rules |
| View menu | Light, dark or system theme |
| Chinese / EN | Switch supported interface translations |
| Welcome cards | Open a project, clone a Git repository or use the SSH/local-mapping entry |
| Tabs and + | Separate conversations and new conversation tabs |
| Files tree and its + | Browse a project and attach an additional folder |
| History | Reopen saved conversations |
| Artifacts / 作品 | Reopen registered HTML/SVG works from disk |
| Sidebar | Snapshots, skills, milestones, global preferences, profile, persona and rules |
| Model capsule | Inspect/select the current model combination |
| Context / 上下文 | Select conversation rounds supplied to the model |
| Outgoing prompt / 发给 AI 的内容 | Preview assembled request content and per-send overrides |
| ∞ Agent and rounds | Agent controls and per-role round budget |
| Unlimited / 全解放 | Remove the configured round ceiling until completion or Stop |
| AGI | Experimental desktop tools and screen-request monitoring |
| AI direct / AI 直通 | Automatically reflects Cursor/Codex selection in core roles; not a manual toggle |
| Pet / 宠物 | Show/hide the companion window |
| 使用手册 / 本地部署指南 | In-app help and local-deployment help |
| 长时存活 | Persistent goal and recurring task checks |
| Attachment / Queue / Send / Stop | Supply inputs, queue later messages, submit or interrupt work |
| Download drawer | Download progress and completed-entry cleanup |

Check the project and active tab before submitting. Multiple windows can work with different sessions. Desktop operations still share the actual mouse and keyboard.

<a id="s4"></a>
## 4. Online providers and model selection

1. Open File → Settings.
2. In Model providers, choose a template or a custom provider.
3. Enter its display name, protocol, Base URL and required key/account details.
4. Configure request timeout, retry count and retry interval for that service.
5. Test the connection, then Add/save.
6. In Model list, select the provider and Fetch models.
7. Select catalog entries to save them.
8. In Saved models, click Use for the current conversation model.
9. Close Settings with Done and inspect the model capsule.

Protocols include OpenAI-compatible, Anthropic, Gemini, Cursor, Codex and Claude Code routes. Compatibility with a protocol does not establish entitlement to every model or modality. Use the provider's real model identifier and endpoint.

Settings also includes a network proxy, local model folder, image-generation defaults, command sandbox and command timeout, default agent rounds, project index status and capability defaults. Provider timeout and command timeout govern different operations.

Balances can be currency, credits, percentages or unavailable. Manual wallet entries are local estimates, not provider billing records. The app preserves different units rather than treating points or percentages as cash. Some providers have no readable balance endpoint.

<a id="s5"></a>
## 5. Codex, Cursor and Claude Code

These integrations use existing accounts/authentication. Adding a provider does not purchase a plan.

- **Codex:** uses the supported SDK/CLI authentication route. Verify the selected account can access the chosen model.
- **Cursor:** where no key is supplied, the SDK can open browser login. The implementation diagnoses plan-required failures and SDK/editor account differences and can initiate re-login. An editor login alone does not establish that the SDK session has the required paid access.
- **Claude Code:** select its provider protocol and use the authentication supported by that integration.

AI direct automatically follows the selected Brain, Summary, Code or Planning routes. SpCode tools remain the project interaction surface. Actual file/command results are required to claim a change or passing test.

For account failures, inspect the exact response and selected account/model. Complete the indicated login or correct the configured key before resending. Region restrictions and model entitlement remain provider-controlled. A successful login test does not verify every subsequent model/tool request.

<a id="s6"></a>
## 6. Local models and downloads

Open Settings → Local models, choose a model directory, and use Download model or place compatible GGUF weights there. Watch the download drawer until completion, then select the local model or assign it in Model combinations. Try a small request first.

Text inference and image generation use different runtimes and model families. A text GGUF does not become an image model through a role assignment. Supporting engines/files can be downloaded on first use. The installer excludes large weights.

Choose quantization, context and task size to fit memory. The weight file size does not represent all runtime allocation. If startup fails, keep the exact model/engine error and inspect compatibility and available RAM/VRAM. Download completion does not prove inference has initialized.

<a id="s7"></a>
## 7. Model combinations and roles

The Brain is the main conversation model. Eight capability slots cover Summary, Code, Planning, Vision, Image generation, Video generation, 3D generation and Document generation. The setup flow requires Summary, Code and Planning; the same model may fill all three. Optional/default and alternate selections are available where offered by the panel.

Use File → Model combinations or Settings → capability defaults. Save working models first, then assign suitable models/weights. Vision and generation roles need matching backend capabilities.

Ordinary workflows can separate planning, implementation and review. AGI/direct execution changes task coordination; it does not imply every slot runs on every task. Inspect the roster and activity to see what actually ran.

<a id="s8"></a>
## 8. Projects, folders and SSH entry

**Open project:** choose its root. The file tree and tools use that workspace.

**Clone repository:** provide the Git URL and local destination. Private repositories require working Git credentials.

**Recent projects:** reopen a previous directory. If it moved, open its new location.

**Additional folders:** use the + beside the tree to attach another intended context root. Do not assume unrelated machine folders are automatically part of the task.

**Windows/tabs:** use separate conversations for separate work and check the active workspace before sending. Multiple windows do not isolate the physical desktop.

**SSH entry:** accepts username, host, port and a local mapped path, then returns a workspace or connection message. It is a connection/local-mapping entry, not a complete remote filesystem IDE, remote terminal or deployment service.

<a id="s9"></a>
## 9. Coding, plans, maps and verification

A useful request gives observed behavior, expected behavior, constraints and a success check. Example: “Opening this scene jumps the camera. Find the entry and callers first. Keep the timing controls unchanged. After the fix, run the camera test.”

The project map indexes modules, symbols, comments, source spans and dependencies. Tools support feature lookup, actual source reads, definition/caller inspection, exact text search and semantic search. Comments and map summaries are navigation clues; current source is the evidence. Settings offers index synchronization and deletion.

Plan maps show implementation scope/status; chain maps show explained call paths; context maps select conversation input. An absent indexed call is not proof that there is no caller.

Ordinary mode can use a reviewed plan and Start controls. AGI executes under its active authorization. Stop interrupts work; it does not undo completed edits or successful external actions.

Verify the relevant outcome:
- Syntax checks establish parser validity.
- Builds establish their compile/package path.
- Tests establish the assertions they exercise.
- Runtime/UI checks establish the actual paths observed.

A written file or launched command alone does not prove a bug is fixed. Review changed files and distinguish passed, failed, skipped and untested checks.

<a id="s10"></a>
## 10. Context, attachments, drafts and interjections

Use `@` for project context and `/` for skills. Context/attachment chips show selected inputs. Attach images, files, documents or video with the attachment button; clipboard image paste is supported. Parsing and visual understanding depend on the format and model route.

Context opens a map/filter. Select relevant rounds and Apply. Excluding a round from future context differs from deleting history. Check deletion controls before using them.

Outgoing prompt preview shows material assembled before sending. Search results, recognition and later tool returns may only exist during execution. Per-send preview edits do not write the corresponding source files.

Composer state preserves drafts, attachments and references with the conversation. Submitted-text history supports browsing earlier submissions. Queue adds a message for later dispatch. During work, an interjection can correct the active task or provide another image; describe the correction explicitly.

Stop interrupts the active task. Closing a preview or hiding the pet does not. The voice-input entry is not a completed speech-recognition workflow.

### Web, documents, spreadsheets and clipboard

Requests containing a URL, explicit search intent, current information or official documentation can trigger the web-retrieval path. Ordinary local code/attachment work does not need a web search. Results enter the task context when retrieval actually runs; inspect the cited content rather than treating a pre-send preview as fetched evidence.

File reading supports document/spreadsheet extraction as well as text source. A table screenshot can be recognized into rows, columns, merged cells and values, then written as XLSX. The WPS transfer tool can create/open an XLSX through the default application or place tab-separated text on the clipboard for pasting into the active cell. TSV cannot represent merged-cell layout; image recognition also needs checking against the original.

The file-tree clipboard panel keeps clipboard entries, with a clear-history control. Clipboard image import can save and analyze an image. Verify the actual destination and active spreadsheet cell before pasting; clipboard transfer is not a live Excel calculation interface.

<a id="s11"></a>
## 11. AGI desktop operation

Open the project, select a model and enable AGI in the intended conversation. Desktop tools can list/focus windows, read local OCR/UI Automation controls, click, scroll, drag and type. Visual recognition supplements text when layout matters.

Actions use the real Windows desktop. Manual interaction can change focus and targets. Observe, act and verify post-action state. Move the always-on-top pet if it obstructs a target.

Background screen requests use a complete visible line in another foreground application beginning with the exact Chinese trigger **请帮我**. Two matching observations are required. The same request is accepted once per session within the process; change the request text for another task. SpCode's foreground window is excluded. Monitoring pauses while work runs or the bound tab is inactive.

Idle screenshots/OCR are local. An accepted task starts the existing model/tool flow and associated cost. Task-required screen information may then go to the selected model. Disabling AGI or closing its window stops monitoring. Existing confirmations for risky desktop actions still apply.

Process-memory tools are read-only: identify processes/modules/regions, read typed values, and search specified address ranges. Raw bytes/numbers do not establish a game's business meaning. This feature does not write process memory.

<a id="s12"></a>
## 12. Desktop pet

Pet shows/hides the companion; it reflects task activity and expands into a conversation window. Its appearance menu offers skin, scale and glasses controls.

Up to three lines of dialogue appear above the character, with the current Brain provider's balance below. Idle state keeps the balance without idle chatter. The work HUD reflects tool activity; thinking and replies are separate, and command output is not pet dialogue.

Enable/disable glasses or adjust X/Y offsets in the appearance menu. Settings preview and persist. The glasses follow character animation without changing the source sprite atlas. Main-window account overview and current-Brain pet balance have different scopes. Credits and percentages keep their units.

Hiding the pet does not stop a task. Use the appropriate Stop control to interrupt work.

<a id="s13"></a>
## 13. Images and other generation

Assign a compatible model to the relevant generation role, then describe content, style, dimensions and constraints. Outputs go under the project's `generated/` directory.

**Local images:** text-to-image uses a prompt; image-to-image uses an attached/reference file's actual path. Settings → 本地生图 / 图生图 saves width, height, steps, seed, strength, CFG, sampler, negative prompt and preset. Explicit request parameters override saved defaults; blank values use the model recipe.

Dimensions are pixels in multiples of 64. Strength controls reference transformation. Seed 0 is valid; -1 requests random sampling. The editable pixel preset adds pixel-oriented settings and nearest-neighbor reference scaling. It does not assemble an animation or guarantee consistent characters/actions. A fixed seed alone does not establish continuity.

**Online images:** configure a supported image API. MXAPI provides an OpenAI-compatible template and a native Nano asynchronous template. Nano submits a prompt, polls the task identifier and downloads the completed image. Local-engine options are not silently applied to unrelated API routes.

**Video, 3D and documents:** generation slots require supported service/model combinations. Inspect the returned format and actual content; a role name is not proof of successful generation.

Use code artifacts for editable diagrams, UI demos and interactive explanations. See [local image details](local-image-generation.md).

<a id="s14"></a>
## 14. Interactive artifacts, audio and video

Artifacts begin as project HTML/Canvas/SVG source. The assistant registers title and explicit pixel dimensions with `present_artifact`. Open the chat card or Artifacts. Re-registering the same source updates the work.

The independent preview supports interaction and refresh. PNG download captures current preview state; source download saves original HTML/SVG. It does not automatically bundle every linked asset into an offline website.

Animation defines deterministic `window.renderFrame(time, frame, info)` and registers dimensions, fps and duration. Playback, pause, seeking and optional audio are available. MP4 export renders the source through FFmpeg, rather than recording temporary preview interactions. Write required changes into source before exporting.

Code audio uses HTML `renderAudio(info)` and OfflineAudioContext to produce WAV. Audio analysis exports waveform/RMS, onset and energy-rise candidates and a timeline. Candidates and estimated BPM are not confirmed downbeats; audition before selecting cues.

Code video uses explicit dimensions/fps/duration and prepared audio when sound is required. Selected cues and an editable shot plan make timing reviewable. Inspect actual preview frames and the exported audio/video. FFmpeg must be available for video export. Canceling destination selection does not start rendering; export can be stopped.

Generated files alone do not prove visual quality, musical quality or frame consistency. See [artifacts](artifact-studio.md), [audio](code-audio.md) and [video](code-video.md).

<a id="s15"></a>
## 15. Skills, rules, persona and memory

Skills are reusable task instructions, managed through File or the sidebar and selected with `/`. Rules provide continuing workflow constraints. Persona controls presentation. Bundled defaults may contain Chinese.

User profile/global preferences live in the sidebar. Conversation working memory tracks goals, questions and focal files. These records provide context; they do not promise every old conversation is included in every model request.

Prompt preview helps inspect the current assembly. Customize only the intended records. This release does not modify the user's external identity files or personal memory store.

<a id="s16"></a>
## 16. History, snapshots and milestones

History reopens saved sessions. Automatic saving and composer persistence preserve work between visits. Context filtering changes future input without necessarily deleting underlying history.

Changed-file records show writes/deletes and observed changes around tracked commands. Snapshots retain reviewable prior content; the sidebar has a configurable limit. Restoring is a distinct user UI action. Stop is not restore, and the assistant should not silently discard existing changes.

Milestones preserve significant project progress. They complement chat and Git. None alone proves a build/deployment succeeded; inspect actual files, commits and runtime evidence.

<a id="s17"></a>
## 17. Data, privacy and cost

Installed data normally lives under `%APPDATA%/SimpleCode`: settings, sessions, drafts and diagnostic records. The default installed model directory is inside user data; another directory may be selected. Project-local outputs include generated media/artifacts, snapshots, plans/maps and milestones according to feature.

Long-running state and JSONL archives live under user-data `long-alive`. Full results stay on disk while only bounded context enters memory.

Online requests can include needed source spans, attachments, history, tool results and task-related screen information. Mixed local/cloud combinations are not fully offline. Idle local OCR is distinct from later online task execution.

Costs depend on the selected service/model. Recurring checks can incur repeated model charges. Manual balances are estimates. Do not include credentials, personal user data, caches or model weights when publishing a repository.

<a id="s18"></a>
## 18. Troubleshooting

| Symptom | Check |
| --- | --- |
| No response | Provider URL/protocol/key/login, selected model, exact error |
| One model fails | Entitlement, region, modality and catalog identifier |
| Cursor plan/account error | SDK/editor account difference, required plan and indicated login |
| Local startup fails | Model compatibility, runtime support files and RAM/VRAM |
| Image-engine download fails | Named engine/support download, independently of chat authentication |
| Recurring task cannot start | Project, model, active session, goal and numeric timing fields |
| Recurring work pauses | Timeout/error, tab switch, reload/close, sleep or interrupted run |
| Source app still looks old | Fully restart main/preload; renderer refresh is insufficient |
| Installed app still looks old | Exit, install new EXE and relaunch that installation |
| MP4 export fails | FFmpeg, source assets, dimensions/fps/duration and renderer error |
| Desktop click misses | Foreground, focus, coordinates, overlays and post-action state |
| Balance absent | Current Brain provider and available provider usage interface |
| SSH is not a remote IDE | Current feature is connection/local mapping |
| English mode retains Chinese | Translation coverage is incomplete; original labels are documented |

Report the version, observed/expected result and exact error. Keep failed/skipped checks visible until resolved or explicitly documented.

<a id="s19"></a>
## 19. Long-running tasks

1. Open the target project, choose the model and keep the intended tab active.
2. Click **长时存活** below the input.
3. Enter **长期目标与允许执行的范围**: goal and allowed actions.
4. Set **检查间隔（秒）** and **单轮超时（秒）**, each 1–86400 seconds.
5. Click **保存并开启**.
6. Inspect status, next check and recent progress; **刷新状态** resamples status/memory.
7. **停止** stops scheduling and cancels the current automatic turn.

SpCode must stay open and the computer awake. The target tab must be active and other tasks idle. Busy checks delay without accumulating a backlog. Switching sessions pauses the original task. Closing/reloading its window or losing the renderer cancels scheduler/in-flight work. No Windows service continues after app exit. Desktop actions also require AGI.

The interval starts after the previous turn finishes. Repeated Start creates no extra timers. An active turn cannot be restarted as a concurrent duplicate. Timeout, execution failure, interrupted unfinished work and state-write failures pause rather than silently repeat uncertain external actions.

**任务目标导图** reuses plan-map drawing/navigation for goal, progress and scheduling, without source-plan deletion. **上下文记录导图** reuses the conversation map: page records, select rounds and Apply. Unchecking does not delete archives. Pages/selected history are limited to 20 rounds; response previews/checkpoints keep up to 6000 trailing characters. Full results remain in JSONL. New progress and manual historical selections persist.

Only the latest automatic message pair remains visible; ordinary manual history remains. Automatic work does not consume unsent drafts/attachments/references/prompt overrides or overwrite manual working memory.

Memory reporting distinguishes main-process RSS, JavaScript heap, external allocation and Electron processes. It does not cover every external application. Short stress tests do not certify leak-free multi-day operation. This is recurring execution infrastructure, not a bundled platform account, publishing strategy or social-media integration. Stop cannot undo completed external publication; inspect uncertain outcomes before resuming. See [technical notes](long-alive.md).

<a id="s20"></a>
## 20. Development, Git and release workflow

### Source setup

Install Git, npm and current Node.js LTS; Node.js 24 is recommended. Local-inference dependencies need Node.js 20 or newer. The installed app uses a separate bundled runtime.

```cmd
git clone https://github.com/yjunwei295-gif/Spcode.git
cd Spcode
npm install
npm start
```

Main process: `electron/main.js`; preload: `electron/preload.js`; services: `electron/lib/`; UI: `renderer/`; build/release/tests: `scripts/`; documentation: `docs/`.

### Build and verify

```cmd
npm run dist:win
node scripts/verify-release.cjs
node scripts/test-long-alive.cjs
node_modules\electron\dist\electron.exe scripts/test-long-alive-ui.cjs
node_modules\electron\dist\electron.exe scripts/test-ui-performance.cjs
node_modules\electron\dist\electron.exe scripts/test-onboarding.cjs
```

Outputs include setup, portable and unpacked app under `dist/`. The release checker compares application files against app.asar and starts a real packaged EXE with separate test data. This does not test every online integration.

macOS arm64/x64 ZIP assembly scripts exist. Their presence does not certify macOS runtime behavior; this Windows release publishes no new macOS artifacts. Linux is not a verified packaged target here.

### Git and GitHub

Git stores source history locally; GitHub hosts the remote repository and Release downloads. A commit records selected source/document changes. Push transfers commits. A tag identifies a revision. A Release adds notes and downloadable binaries to a tag.

Inspect status/diff, run relevant checks and stage intended files explicitly. Exclude caches, generated test user-data, personal settings and secrets. Commit, push, then publish the EXE built from that revision. Large installers belong in Release assets rather than ordinary source history.

This repository's `scripts/publish-release.cmd` launches the publisher. It derives version from package.json, reads `scripts/release-notes.md`, uses machine Git credentials without printing the token, creates/updates the version Release and uploads the setup EXE. Verify API state, size/digest and public download afterward. Process exit alone does not prove every API step succeeded.

A successful release updates the latest-download destination. A user's running executable stays unchanged until they exit and install/relaunch. Actual checks, failures and omissions belong in the [verification record](release-1.0.4-verification.md).

<a id="s21"></a>
## 21. Coverage and current limits

Covered features: project open/clone/recent/add-folder/SSH entry; providers/catalogs/SDK authentication/local models/downloads/roles; file tools/commands/indexing/maps; tabs/history/drafts/queue/interjections/context/prompt preview; desktop OCR/UI/mouse/keyboard/read-only process observation; pet/quotas; local/API generation; artifacts/audio analysis/video export; recurring tasks/archive filtering; theme/language; skills/rules/persona/profile/preferences; snapshots/milestones; builds/GitHub distribution.

External models, services, credentials, runtime support, FFmpeg and operating-system requirements still apply. This document describes implemented controls/contracts. The release record identifies which paths were actually exercised; it does not certify every feature across every provider, OS or long-duration workload.
