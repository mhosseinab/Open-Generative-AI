# Hosted media overlay for embedded packages

The agent, workflow builder and design canvas are pinned Git submodules.
A dirty submodule working tree is not published by a commit in this repository.
`apply-hosted-patches.cjs` therefore carries the small reviewed source edits
needed for the hosted media-storage contract:

- All six embedded upload consumers use the binary proxy's durable JSON `url`.
  Missing persistent URLs fail through their existing upload error handlers.
- Workflow field upload promises propagate failures rather than dropping them.
- Agent messages recognize stable relative/absolute Studio links and their
  `type=image|video|audio` display hint. Legacy video links continue to render.
- Design canvas file drops use the existing upload-and-register path rather
  than leaving unpersisted data URLs on the canvas.
- Design/workflow media classification supports stable links without extensions.

Run this script before package builds in both local development and Docker:

    node scripts/apply-hosted-patches.cjs

It checks complete before/after SHA-256 hashes for each pinned source file,
validates every file before writing anything, and is idempotent. Unknown source
changes fail with an actionable message. When updating a submodule, review the
actual upstream diff and update the explicit replacements and expected hashes;
do not bypass the guard or commit dirty submodule changes as if they would ship.
The gitlink revisions remain pinned to their existing upstream commits.

Verification:

    node tests/hostedPatches.test.cjs

This reconstructs a clean pinned checkout in a temporary fixture, checks the
fresh and repeated patch applications, proves unexpected upstream changes do not
leave partial writes, and exercises the resulting agent message parser.
