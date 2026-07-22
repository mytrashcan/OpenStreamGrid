# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory flow for this repository. Include the affected version or
commit, deployment topology, reproduction steps, impact, and any suggested
mitigation. Do not include real API keys, TURN credentials, certificates, user
data, or third-party media.

Maintainers will acknowledge a complete report as soon as practical, validate
the impact, coordinate a fix and disclosure timeline, and publish remediation
for supported releases. Public disclosure should wait until a fix is available.

## Supported versions

Security fixes target the latest release and the current `main` branch. Older
prototype releases are not maintained unless a release notice says otherwise.

## Deployment hardening

- Set a strong, randomly generated `TRACKER_API_KEY` and rotate it if exposed.
- Set a separate `PEER_SESSION_SECRET` of at least 32 random bytes. Never reuse
  the administrator API key as the session-signing secret.
- Terminate TLS at a trusted reverse proxy in front of the tracker and origin.
  Protect private keys with filesystem permissions and never bake them into
  container images.
- Use `wss://` and `https://` for traffic outside a trusted development network.
- Operate an authenticated TURN service for production; public STUN provides
  discovery, not confidentiality or relay authorization.
- Restrict tracker, origin, peer upload, dashboard, and metrics ports with
  firewalls or Kubernetes `NetworkPolicy` resources.
- Keep request, peer, upload, and connection limits enabled. Size them against
  measured capacity rather than disabling them during overload.
- Persist SQLite on protected storage, back it up consistently, and restrict
  access to the database, WAL, and shared-memory files.
- Treat peer addresses, metadata, and traffic statistics as untrusted input.
- Monitor authentication failures, rate-limit responses, integrity failures,
  fallback spikes, peer churn, and unexpected origin traffic.
- Keep Node.js, FFmpeg, container base images, and npm dependencies patched.

## Security boundaries

SHA-256 sidecars detect corrupted segment bytes; they do not authenticate the
content publisher unless the sidecar itself is delivered through a trusted,
authenticated channel. The administrator API key is deployment-wide. Peer
sessions are short-lived and identity-scoped, but they do not replace viewer
account authorization in the integrating service. The development Docker
Compose topology is not a hardened internet-facing deployment.
