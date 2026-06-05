# Contributing

Thanks for helping improve ZorFit_MCP.

## Development Setup

```bash
git clone https://github.com/senoj100-alt/ZorFit_MCP.git
cd ZorFit_MCP
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Use placeholder credentials unless you are testing a real integration locally.

## Before Opening A Pull Request

Run:

```bash
npm run format
npm run check
```

## Pull Request Guidelines

- Keep changes focused.
- Add or update tests when behavior changes.
- Do not include real API responses that contain personal data.
- Do not commit `.dev.vars`, `.env`, screenshots with tokens, or service exports with private health data.
- Prefer service-prefixed tool names, such as `strava_get_activities`, to avoid collisions.

## Adding A New Fitness Integration

1. Add a client in `src/lib/<service>-client.ts`.
2. Add credential status in `src/lib/service-registry.ts`.
3. Register MCP tools in `src/mcp-agent.ts`.
4. Prefix tools with the service name.
5. Add tests for validation and error handling.
6. Document the required environment variables in `.dev.vars.example` and `README.md`.
