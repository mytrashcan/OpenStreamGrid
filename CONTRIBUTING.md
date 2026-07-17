# Contributing to OpenStreamGrid

Thank you for improving OpenStreamGrid. Changes should preserve its role as
transport middleware: application-specific playback, accounts, billing, and
content management belong outside this repository.

## Development setup

Use Node.js 22+, npm, Docker Compose v2, and FFmpeg.

```bash
npm ci
npm ci --prefix sdk
npm run build
npm run typecheck
npm test
npx eslint .
```

Use `bash test/docker-test.sh` for delivery/fallback changes and
`bash scripts/benchmark.sh` for performance-sensitive changes. Docker tests use
isolated Compose projects but bind the documented local ports.

## Change guidelines

1. Open a focused branch from `main` and keep unrelated refactors separate.
2. Add or update tests before changing observable behavior.
3. Keep shared wire contracts in `common/`; do not duplicate API types.
4. Preserve origin fallback. A P2P failure must not stall playback.
5. Treat segment data as immutable and verify it before caching or serving it.
6. Bound memory, concurrency, network use, retries, and retained metrics.
7. Keep browser SDK code free of Node.js built-ins.
8. Update `README.md`, `API_REFERENCE.md`, and configuration tables when public
   behavior changes.

All code and documentation are written in English. Use clear names, small
modules, explicit error handling, strict TypeScript, and standard-library APIs
where practical. Never log API keys, TURN credentials, segment contents, or
private certificate material.

## Tests and benchmarks

Unit tests use Node's built-in test runner. A bug fix should include a regression
test that fails without the fix. Changes to caching, selection, transport,
persistence, or rate limiting should include boundary and cleanup coverage.

Performance pull requests should record the command, scenario, environment,
before/after results, and variance across multiple runs. Do not compare results
from different peer counts, media renditions, churn rates, or Docker resource
limits as if they were equivalent.

## Commits and pull requests

Use concise conventional commit subjects, for example
`feat(peer): add cache TTL eviction` or `fix(tracker): bound SSE clients`.

A pull request should explain the problem, design trade-offs, validation run,
configuration/API changes, and operational risks. Confirm that build, typecheck,
tests, and lint pass. Include benchmark output when the change affects a hot
path. Do not commit secrets, generated dependency directories, local databases,
or private media.

By contributing, you agree that your contribution is licensed under the
repository's GPL-3.0 license.
