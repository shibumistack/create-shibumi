# Deployment acceptance

These checks use a disposable full-stack project generated from `bun pm pack`, with auth and uploads installed through its copied-in extension installer. They do not use the CLI directly from the source checkout.

## Prerequisites

Use Bun >=1.4.4, Git, an authenticated GitHub CLI, Docker with cross-platform builds for the VPS architecture, and an SSH target with known host keys. Browser checks use `agent-browser@0.41.2` through bunx and require its browser installation:

```sh
bunx --bun agent-browser@0.41.2 install
```

The live target needs an installed Shibumi server. DNS, the private GitHub repository, and initial server/Caddy registration are explicit setup steps. The runner does not change DNS, request sudo, or delete apps.

## Prepare a target

Create a JSON file outside this checkout. Use a new directory whose parent already exists. The domain must start with an `e2e` or `e2e-<name>` label; the repository name must contain the `e2e` component required by the target validator.

```json
{
  "directory": "/tmp/shibumi-e2e-run",
  "domain": "e2e.example.com",
  "server": "my-vps",
  "repository": "example/shibumi-e2e",
  "disposable": true
}
```

```sh
SHIBUMI_E2E=1 bun scripts/e2e.ts prepare /tmp/shibumi-e2e-target.json
SHIBUMI_E2E=1 bun scripts/e2e.ts local /tmp/shibumi-e2e-target.json
```

`prepare` creates the fixture, installs auth/uploads, runs its tests/check/build, commits its source, and sets its Git origin. It refuses an existing directory. `local` runs the built server in production mode with a temporary database and a separate browser session. It clicks the shipped Alpine counter and exercises registration, logout, failed/successful login, session cookies, multipart upload, byte-for-byte download, and cross-origin rejection. It then restarts the server and verifies that the session, counter, upload metadata and file bytes survive.

Auth and uploads currently ship APIs, not browser forms. Their checks run real same-origin browser fetches; they do not claim to test an auth/upload UI. The counter check clicks the generated UI.

## Register and deploy

From the generated `app/` directory, create the dedicated private repository and push its first commit:

```sh
gh repo create example/shibumi-e2e --private
git push -u origin main
```

Point the test domain at the VPS. Register it in a terminal where sudo can prompt:

```sh
ssh -t my-vps 'shis add e2e.example.com --repository github:example/shibumi-e2e --ref refs/heads/main --service app --deployment-mode prebuilt --yes'
```

Then, from this checkout:

```sh
SHIBUMI_E2E=1 bun scripts/e2e.ts live /tmp/shibumi-e2e-target.json
```

The live run verifies every effective origin fetch and push URL (including Git rewrites), the registration, Compose service (`app`, not the server CLI's `web` default), and ownership marker before deployment. It repeats the URL check before Ship setup, deployments, rollback and direct pushes. Every E2E SSH call, including the ones Ship makes, goes through one run-private adapter: it pins the real `ssh`, prepends a shim to child `PATH`, and rewrites the callers' own `-S`/control options onto a single control master for the configured target only. Other hosts (GitHub) keep their argv unchanged, child `-O exit` requests are no-ops, and only the run owner closes the master, once restoration is verified. It uses the generated Ship client to configure and deploy version A, checks the browser flows over HTTPS, repeats setup, deploys B, and checks persistent sessions, SQLite data and uploaded bytes. A deliberately unhealthy production version must fail at the server's health stage and restore B. Finally, explicit rollback must restore A and preserve data. Expected commits are checked against server status; an unrelated CLI failure cannot satisfy the unhealthy-deployment test.

The runner commits and pushes healthy source after the failure probe, so the test repository's default branch does not remain deliberately unhealthy. A passing run ends with A running, while the fixture's Git history retains the failure probe and its repair. Rerunning resets the version marker and uses a new test account. Older test accounts/uploads remain in this disposable app.

## Every template, twice

Once the full-stack fixture has completed a live run, use the same target file:

```sh
SHIBUMI_E2E=1 bun run test:e2e:matrix /tmp/shibumi-e2e-target.json
```

The matrix packs the current checkout with Bun and scaffolds each template twice from the installed tarball. It replaces only the ownership-checked disposable checkout, preserves its linear Git history, and reuses the same server registration. A lock prevents two matrix runs from replacing that fixture together. The matrix creates the SSH adapter at startup and passes it to the nested live runner and to Ship; that runner inherits the same transport, never creates a second one, and never closes the master. Each run gets its own private `matrix-*` directory with logs, screenshots and `results.json` (`lockRetained` records the final decision).

Blog and static fixtures add ownership/version files and a plain `/healthz` file so they can reuse the registration's `/healthz` check. Their generated Compose health check still probes `/`. Removing the test health file creates the deliberate unhealthy release. The blog fixture also sets its real site URL and adds a published post and an excluded draft. The static fixture adds a nested guide page. These are test content, not replacement servers.

Ship pauses agent runs after generating container files for review. The matrix checks that only the expected Dockerfile, Compose file and ignore file were generated, verifies their static output/service, commits and pushes them, then resumes setup. It does not treat a zero exit code from that review pause as a successful deployment.

Every journey deploys A, checks real browser navigation and HTTP behavior, repeats setup, deploys changed content B, verifies server-side health failure recovery, and rolls back to A. Blog checks also cover canonical/OG tags, RSS/sitemap XML, Markdown alternates, `llms.txt`, robots and draft exclusion. Full-stack journeys use the auth/upload checks described above.

The browser checks perform a normal reload after navigation so fresh cached HTML does not hide the current release. They do not wipe cookies or use cache-busting URLs. After rollback, a conditional request using version B's ETag must return version A's changed HTML with HTTP 200, not an incorrect 304.

The matrix checks all effective origin fetch and push URLs before any Ship setup, deployment, rollback or direct push. On the first SIGINT/SIGTERM it stops and awaits local subprocess groups (including descendants), then restores the original full-stack source and deploys it in `finally`; it verifies the persistent counter survived replacement. If failure happens before the first scaffold commit, restoration skips the empty commit but still redeploys. If a subprocess cannot stop within 30 seconds, the runner force-kills its group. `matrix.lock` is released only when no replacement started, or when the original fixture was restored and verified: forced termination, and a failed or unverified restoration after replacement began, both retain the lock and the SSH transport for manual recovery. The owner's final `ssh -O exit` is time-bounded so a wedged connection cannot hang cleanup. Inspect the fixture and archive before recovering manually. Failed restoration fails the suite. Force-killing the runner cannot guarantee restoration; the original source archive remains in the artifact directory, and a stale `matrix.lock` must be reviewed before another run. It never resets Git history, force-pushes, removes server volumes, or registers another domain. Run it only against a fixture you are willing to replace completely; ignored local build/install files are removed during replacement.

## Results and limits

Each mode writes `<mode>-results.json` in the external target directory. Browser runs save screenshots; live failures also save status/history snapshots. The directory is created with mode 0700, and JSON reports use mode 0600. Passwords and session tokens are not written to the reports.

Normal `bun test` never runs these network/deployment checks. Focused tests exercise the target and effective Git URL guards, the lock-release rule, Bun's detached child/grandchild process group behavior, an early replacement failure with an unchanged restore commit, and the SSH adapter against a fake `ssh` executable: caller `-S`/control-option normalization, binary stdin, unrelated-host passthrough, child close suppression, nested non-ownership and the owner's single close. They do not exercise cancellation against a live VPS. The live suite changes only the explicitly configured test app; it must not target an existing production app.

Initial interactive setup still needs a human pass. The automated live run reuses registration and supplies `--yes`, so it does not cover every prompt. Health-failure checks prove eventual restoration of the previous healthy release, not uninterrupted HTTP availability. Server output can report restore times beyond Caddy's finite retry budget; this suite does not continuously sample requests during replacement.

The matrix covers all current templates, but a second VPS architecture remains separate coverage. Full-stack installs auth and uploads; this is not an E2E test of the email or admin extensions.

Resources remain available after a run, including failures. When finished, use `shis remove <test-app-id> --yes`, remove only the test DNS record, and delete the private test repository if no longer needed. Server removal intentionally preserves the checkout, volumes and images; inspect those separately rather than pruning host-wide resources.
