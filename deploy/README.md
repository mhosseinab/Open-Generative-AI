# GenerativeAIStudio deployment

A web-only fork of Anil-matcha/Open-Generative-AI. Models run on MuAPI;
the app does not install model weights or a local inference engine.

## Build and registry

The container workflow runs the staff-authentication, browser-client, and private
video-storage tests, then builds natively for ARM64 and publishes to:

    ghcr.io/mhosseinab/open-generative-ai:sha-<full-git-commit>

The package is linked to this repository via GITHUB_TOKEN and OCI source metadata.
GitHub initially makes new container packages private. Change package visibility
in GitHub package settings if anonymous pulls are desired. Use an image digest
for deployment; do not automatically deploy a moving tag.

The workflow runs only when manually dispatched. Pushes and pull requests do not
start tests or image publication. A manual run tests, builds and publishes the
selected revision. No workflow logs into a server,
receives application credentials, or deploys to production.

## Runtime

Use deploy/compose.yaml as a local-build example. To use a registry image instead,
remove the build block and set image to a verified GHCR digest. Runtime secrets
remain on the host, never in the repository, image, or GitHub build environment.
See STAFF-AUTH.md for the staff identity/provider-key configuration.

The app listens on loopback port 3000 behind Cloudflare Tunnel and Access.
The container uses an unprivileged account, a read-only filesystem, and tmpfs for
cache and temporary files. Keep existing runtime secret files across upgrades.
The upstream docker-compose.yml is not the hardened hosted configuration.

## Video storage

Configure an explicit private S3-compatible bucket with VIDEO_STORAGE_ENDPOINT,
VIDEO_STORAGE_REGION, VIDEO_STORAGE_BUCKET, VIDEO_STORAGE_ACCESS_KEY_ID,
VIDEO_STORAGE_SECRET_ACCESS_KEY, and VIDEO_STORAGE_SIGNING_SECRET.
Completed prediction-result polls stream videos into the bucket. Stable HMAC
capability URLs refresh short-lived signed S3 playback URLs. Images and audio
remain with the provider. Preserve the signing secret across upgrades.

Archiving happens when the browser polls a completed job. Abandoned jobs are
archived only if polled again. Objects are retained until explicitly deleted.
Staff share the provider account and generated resources; no per-staff billing
or resource isolation is implemented.

## Image optimization

The final image contains only Node from the pinned Alpine build, its runtime
libraries and certificates, and the Next.js standalone output/static assets.
It has no shell, npm, Yarn, development headers, or model engine. Diagnostics
can use `docker logs` or `docker exec CONTAINER node ...`.

On the same-code local AMD64 comparison, the runtime decreased from 367,858,726
bytes to approximately 322 MB (about 12.5%). ARM64 registry sizes may differ.
CI smoke-tests the actual ARM64 image with synthetic test credentials before
publishing, including the rewritten API routes and Sharp image processing.
