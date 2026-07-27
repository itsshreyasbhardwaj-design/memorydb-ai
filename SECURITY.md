# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through
[GitHub Security Advisories](https://github.com/itsshreyasbhardwaj-design/memorydb-ai/security/advisories/new).

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce, ideally a minimal proof of concept
- Affected version and configuration
- Any suggested remediation

**What to expect:** acknowledgement within 48 hours, an assessment with severity and a fix timeline
within 7 days, and credit in the advisory unless you prefer otherwise.

## Security model

### Trust boundaries

- **Namespaces are the hard tenant boundary.** Every query is scoped to exactly one namespace, and
  the Postgres schema enforces this with row-level security — so a bug in the application layer
  cannot leak data across tenants.
- **API keys are never stored in plaintext.** Only the SHA-256 digest is persisted; comparison is
  constant-time so neither the key nor its length leaks through response timing.
- **Memory content is treated as untrusted data.** It is never evaluated, interpolated into SQL, or
  rendered as HTML.

### Controls

| Area | Control |
|------|---------|
| Input validation | Zod schemas on every route; the same schemas validate SDK input |
| SQL injection | Every user value bound as a `$n` placeholder; asserted by tests that feed malicious input through the adapter |
| Rate limiting | Sliding window, separate read and write budgets, applied before authentication |
| Transport | HSTS with preload; strict CSP with no `unsafe-eval` in production |
| Clickjacking | `X-Frame-Options: DENY` and `frame-ancestors 'none'` |
| Secrets in logs | Sensitive keys redacted at serialisation time, not at call sites |
| Error disclosure | Internal messages and stack traces never returned to clients |
| Configuration | Environment validated at boot; refuses to start with `AUTH_DISABLED` in production |
| Body limits | Enforced from `Content-Length` and again after reading |
| Dependencies | CodeQL weekly; the core package has no runtime dependencies beyond Zod |

### Deployment recommendations

1. **Always set `MEMORYDB_API_KEY` in production.** Without it, API-key authentication is disabled
   entirely rather than falling back to a guessable default.
2. **Use the Postgres adapter in production.** The in-memory adapter loses all data on restart.
3. **Give each tenant its own namespace.** Do not multiplex tenants inside one namespace.
4. **Put a WAF or gateway in front** if you expose the API publicly. The built-in rate limiter is
   per-instance and does not coordinate across replicas.
5. **Rotate API keys periodically** and revoke unused ones.
6. **Never send secrets in query strings** — the API only accepts keys via headers, for exactly this
   reason.

### Known limitations

- **Rate limiting is per-instance.** Behind multiple replicas each enforces its own share. Use a
  shared store or an edge rate limiter for strict global limits.
- **Memory content is not encrypted at rest by the application.** Use your database's encryption at
  rest (Supabase and RDS enable this by default).
- **The local embedding provider is not cryptographically private.** Vectors are derived
  deterministically from content, so an attacker with vectors and a candidate corpus could confirm
  whether specific text was stored. Treat vectors with the same sensitivity as the content itself.
