# SimpleCode 1.0.4 verification

Date: 2026-11-02. Target: Windows x64. This record separates source tests, packaged-runtime checks and external-service omissions. Existing unreleased changes are included in the release; application language settings and external identity files were not changed.

## Build and binaries

Command: `npm.cmd run dist:win`. Background build completed and produced:
- `dist/SimpleCode Setup 1.0.4.exe`: 694253462 bytes.
- `dist/SimpleCode-Portable-1.0.4.exe`: 694010694 bytes.
- `dist/win-unpacked/SimpleCode.exe` with app.asar.

Setup SHA256: `bd503a1b18488fd7b735a5802ab8b7d7d039c5884d0b96a9293de28e443faf3f`.

Build log: `dist/build-1.0.4.log`. Native dependency rebuild and NSIS/portable output completed. Builder signing-step log messages are not a claim that the installer has a trusted publisher certificate.

## Executed checks

| Command / suite | Result | Evidence |
| --- | --- | --- |
| `node scripts/test-long-alive.cjs` | 89 checks passed | `generated/long-alive-check-nY0lzY` |
| Electron `scripts/test-long-alive-ui.cjs` | 11 checks passed | `generated/long-alive-ui-Q45hWp`, `dist/test-long-alive-ui-1.0.4.log` |
| Electron `scripts/test-ui-performance.cjs` | 24 checks passed | `dist/test-ui-1.0.4.log` |
| Electron `scripts/test-onboarding.cjs` | 15 checks passed | `dist/test-onboarding-1.0.4.log` |
| Electron `scripts/test-agi-screen-requests.cjs` | 27 checks passed on retry | `generated/agi-screen-test-EVzoLH`, `dist/test-agi-1.0.4-retry.log` |
| Electron `scripts/test-provider-regressions.cjs` | failures=0, unhandled=0 after fixture update | `dist/test-provider-1.0.4-retry.log` |
| Electron `scripts/test-local-image-generation.cjs` | 18 checks passed | `generated/local-image-check-RQ41pw` |
| Electron `scripts/test-artifact-studio.cjs` | 31 checks passed | `generated/artifact-test-sXEvl3` |
| `node scripts/verify-release.cjs` | 8 checks passed, 127 app files match archive byte-for-byte | `generated/release-1.0.4-SoFtJX/results.json` |

Generated test data and dist logs stay local and are not committed.

## Actual behavior covered

Scheduler tests exercise 1000 start/stop cycles, duplicate-start timer count, delayed busy checks, serial execution, stale-send refusal, timeout cancellation, 150 rounds, disk paging, context exclusion, interruption pause, state-write failure and window ownership. Controlled execution of the real renderer sending function covers 60 rounds without consuming manual drafts or working memory.

The Electron UI test uses production preload/IPC, scheduler, map components and send function, with model/platform transport controlled. It checks scheduled dispatch, Stop, read-only goal view, archive context selection persistence, repeated map lifecycle and five post-GC heap samples. It is not a real paid-model or platform publication test.

Packaged verification starts the actual unpacked EXE using isolated user data. It checks package version/mode, main-window load, preload APIs, pet controls, the long-running button and real start/stop/status IPC. The test interval is 86400 seconds and is stopped immediately; no model is called. All 127 tracked/untracked application files in electron/renderer match app.asar, and runtime package metadata matches the source.

## Failed attempts retained

The first AGI screen run failed `unchanged image reuses OCR text` after successful native OCR recognition. A second run of the unchanged test passed all 27 checks. This establishes the retry result, not a proven cause or a guarantee against future screen/capture variation. Initial log: `dist/test-agi-1.0.4.log`.

The first provider regression failed because its isolated dependency loader did not declare `./claude-model`, already imported by production api-protocol.js. The fixture now supplies the same unused SDK stub as Cursor/Codex; production provider logic was not changed for this fix. The rerun passed with zero failures/unhandled errors. Initial log: `dist/test-provider-1.0.4.log`.

## Not established

- Continuous multi-day operation or leak freedom across every browser/model/SDK workload.
- Live Cursor account re-login, paid MXAPI image generation, or all external provider integrations.
- New real-model image quality or animation consistency.
- macOS/Linux runtime behavior or new non-Windows release artifacts.
- Real social-media publication/commenting.
- A new installed main application replacing the user's already running instance.

The native AGI screen assertion's first failure is a known test instability requiring further diagnosis if it recurs. It does not block the verified recurring-task IPC, scheduler, build or archive comparisons.

## Documentation and publication contract

English/Chinese READMEs and 21-section guides cover project tools, model management, SDK/local paths, chat/context/attachments, web/table workflows, desktop tools, pet, generation/artifacts/audio/video, customization, history/snapshots/milestones, recurring work and development/distribution. Relative documentation targets and guide anchors are checked before commit.

Publication must verify remote branch/tag alignment, GitHub uploaded asset state/size/SHA256, latest release selection and a successful public download response. Local packaging checks alone do not establish those remote facts. Fully exit and install/relaunch the updated EXE to update a running installation.
