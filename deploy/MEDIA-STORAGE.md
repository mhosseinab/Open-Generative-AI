# Durable Studio media

Hosted staff mode stores uploaded files and generated image/video/audio outputs
in the explicitly configured private S3-compatible bucket. Existing VIDEO_STORAGE_*
variables and signing secret are retained for backward compatibility.

## Stable browser links

The historical /api/stored-videos/{owner}/{asset}?token=... path now serves all
supported media types. The URL and capability do not expire. The authenticated
backend streams the object directly, with GET/HEAD, byte ranges and ETags; it
never redirects a browser to an expiring S3 URL. Optional type hints help embedded
editors identify media without relying on a filename extension. The bucket stays
private. Staff login remains required even when a capability URL is known.

MuAPI cannot access the OTP-protected origin. When sending saved media as an AI
input, the backend substitutes a one-hour signed S3 read URL only in the outbound
provider request. Returned S3 references are converted back to stable links.

## Uploads, generated outputs and history

Uploads go directly to our bucket; no MuAPI file-upload credit balance is required.
Prediction results, direct completed model outputs, workflow node media, design
assets/events and agent conversation media are archived before browser delivery.
Media copies are idempotent, size-limited and restricted to public HTTPS sources.
Existing source mappings are reused even after a provider URL expires.

S3 history manifests and source mappings preserve completed prediction results
independently of provider retention. On staff startup the browser rewrites its
existing media references and merges the durable image/video/audio catalog. Old
browser-only upload/reference URLs are imported in bounded batches; originals
already expired at the provider are reported as failures and cannot be recovered
without a surviving copy. Local history dismissals remain dismissed. Explicit
server history deletion creates a tombstone; shared media objects are retained
until an administrator deliberately cleans them up.

## Backfill and unattended prediction completion

Run this read-only provider migration from the runtime directory:

    docker compose exec -T app node scripts/archive-existing-media.cjs

It reads provider history/results, copies existing media and stores manifests;
it never submits a generation or changes the provider key/account balance.
Already archived results are skipped. Failed copies produce a nonzero exit.

The included studio-media-archive.service/timer run the same command every five
minutes and after boot, without overlapping normal service invocations. This
preserves prediction results when a user closes a tab before polling completion.
It does not claim independent reconstruction of abandoned agent/workflow runs
that are absent from the provider prediction history.

Inspect systemctl status studio-media-archive.timer and
journalctl -u studio-media-archive.service. There is no automatic bucket expiration.
Keep the signing secret and bucket across deployments or existing saved links break.

## Embedded components

Pinned upstream submodules are patched reproducibly by
scripts/apply-hosted-patches.cjs before package builds. The guarded overlay makes
upload clients use our canonical URL response and recognizes durable media in
agents/design/workflow. See scripts/README-hosted-patches.md. No private fork or
unpublished submodule commit is required.
