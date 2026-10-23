# PR #50: DIL capture build and controlled activation

## Scope and current hold (2026-10-23)

The isolated branch `fix/pr50-dil-capture` in `RomarioAgro/chat-on-steroids`
recovers a DIL message from `contentReferences[type=dil].model_dil_v2.fallbackMarkdown`
when its `content` is empty or only `DilResponseRoot`. A reference is accepted
**only when `source_message_id` exactly matches the item's real `messageId`**.
The ordinary text path and unmatched/empty references retain their previous
fail-closed behavior. The fix does not manufacture reply IDs or infer an FIO.

The browser extension's MAIN-world helper must retain one lexical closure:
`extension/fiber-src/*.part.js` are ordered, reviewed source sections, not
independent browser scripts. `node scripts/build-fiber.mjs` restores the one
`extension/fiber.js` loaded by the existing manifest and injection paths.
The generated file is untracked. `postinstall`, `pretest`, `prebuild`, `predev`,
`preverify:ci`, and the direct packaging script assemble it automatically.

## Isolated source validation (does not touch installed COS)

Run each command separately, checking its outcome:

1. `npm ci` in an **isolated checkout**; never reuse or overwrite the active
   Desktop/extension installation.
2. `node scripts/build-fiber.mjs --check` — proves the emitted script exactly
   matches the source sections.
3. `npm run typecheck`.
4. `npm exec vitest run test/shell-compat.test.ts test/shell-dil-root.test.ts`.
5. `npm run build` — compile Desktop/renderer in the isolated checkout.
6. Check commit SHA, `git status`, staged sizes, and unchanged `LICENSE`.

These are **offline** validations, never evidence of a live worker response.
Packaging steps that launch smoke-test Desktop processes need a separate idle
window; do not run them while the current COS/Chrome session is active.

## Application gate and rollback

1. Confirm that no active messages or worker executions are in progress in
   COS and ChatGPT. Do **not** restart Chrome, stop a worker, or replace a
   running extension in order to satisfy the gate.
2. Identify the **actual** installed Desktop and extension files and running
   build stamp at that time, not paths remembered from an earlier session.
   Back up the installed bundle, extension `fiber.js`, stamp, and matching
   manifest; record SHA-256 values and location of every backup.
3. Stage the isolated, built and verified Desktop/extension through the
   application's supported idle-only update process. Confirm by reading the
   **running** extension build ID, not merely the file on disk. If the updater
   says that a message is being sent, **stop without forcing an update**.
4. Keep the C85 Bridge production config `enabled=false`, `max_inflight=1`,
   `deadline_seconds=600` throughout diagnostic activation and before the
   user-approved isolated synthetic trials. Do not replay historical job IDs.
5. Capture only structural diagnostics from a fresh fictional request:
   real message/source ID equality, reference types, fallback presence,
   final-message identity, owner/run/worker/conversation/session/tab binding,
   terminal state, and ACK. Do not log FIO or answer text.
6. A missing authored fallback or ambiguous ownership is `needs_review` with
   a concrete cause. Never parse `::chatgpt-content-reference` as JSON,
   invent a candidate, re-send an uncertain request, or promote a terminal
   `worker_deadline`/`needs_review` after a late reply.
7. In the event of a capture/identity regression, use the saved copies to
   restore the original installed version and stamp **when idle**, and confirm
   the restored running build ID. Never force an update during a message.

Only after independently observed **live** synthetic success/failure and a
controlled `fry -> SMB -> COS Bridge on C85 -> COS -> fry` test with read-only
1C validation should operators separately authorize deployment of the
production fallback. Preserve PR #50 in Draft and the production Bridge
disabled until those proofs exist.
