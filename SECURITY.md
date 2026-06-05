# Security Policy

ZorFit_MCP handles health and fitness data, so treat every deployment as sensitive.

## Never Commit Secrets

Do not commit:

- `.dev.vars`
- `.env`
- API keys
- OAuth client secrets
- refresh tokens
- access tokens
- account passwords
- Cloudflare KV namespace IDs from a private deployment
- Cloudflare D1 database IDs from a private deployment

Use `.dev.vars.example` for placeholders only.

## Where Secrets Belong

For local development, put secrets in:

```txt
.dev.vars
```

For production, put secrets in Cloudflare:

```bash
npx wrangler secret put SECRET_NAME
```

## Credential Storage

ZorFit_MCP stores authenticated GitHub users and per-service connection records in Cloudflare D1. Fitness service credentials are encrypted with AES-GCM before being written to the `service_connections` table. Cloudflare KV is used for OAuth/session state, not as the primary multi-user credential database.

The encryption key is supplied through:

```txt
COOKIE_ENCRYPTION_KEY
```

Generate it with:

```bash
openssl rand -hex 32
```

Keep this key stable for a deployment. If you change it, previously encrypted D1 credentials cannot be decrypted.

## Reporting Vulnerabilities

Please do not open a public issue for a vulnerability.

Email the maintainer or use GitHub private vulnerability reporting if enabled. Include:

- affected version or commit
- description of the issue
- steps to reproduce
- potential impact
- suggested fix, if known

## Recommended Production Practices

- Use a fresh Worker, KV namespace, and D1 database for every deployment.
- Use strong unique passwords for services that require username/password access.
- Rotate tokens if a machine is lost or a secret may have leaked.
- Review Cloudflare logs for unexpected traffic.
- Keep dependencies updated.
