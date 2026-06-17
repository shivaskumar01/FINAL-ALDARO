# Aldaro

Aldaro is a GPU rental platform I built on my own Proxmox hardware. You spin up a GPU
workspace, run your own code on it, and pay for the seconds you use. There is no
third-party GPU reseller in the loop. The machines are mine.

## What it does

- Spin up and tear down GPU workspaces on demand, backed by real Proxmox VMs.
- Run your own containers, including custom Docker images.
- Reach a workspace over a public port gateway, so a service you start inside the VM is
  reachable from outside without wiring up networking yourself.
- Keep data between sessions with persistent volumes.
- Pay per use through Stripe, metered by GPU-seconds.
- A spot-pricing market sets the rate from current demand.
- A developer API with scoped keys, so you drive all of this from your own code.

## API keys and secrets

Nothing real is committed. Each service ships a `.env.example` to copy to `.env` and
fill in.

- `apps/api/.env`: `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (generate with
  `openssl rand -base64 48`), `ALDARO_AGENT_SHARED_SECRET`, the Stripe set
  `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PUBLISHABLE_KEY`, the Proxmox
  pair `PROXMOX_API_TOKEN_ID` / `PROXMOX_API_TOKEN_SECRET`, `GATEWAY_SERVICE_SECRET`,
  and `DATABASE_URL`.
- `apps/gateway/.env`: `GATEWAY_SERVICE_SECRET`, which must match the API value
  (generate with `openssl rand -hex 32`).
- `worker/.env`: `DATABASE_URL`, `ALDARO_AGENT_SHARED_SECRET`, and the same Proxmox
  token pair as the API.

`SECRETS_TO_ROTATE.md` lists the weak dev defaults from earlier development. They are
placeholders, not live keys, and you would rotate them before any real deployment.

## Layout

```
apps/api        the API (Fastify + Prisma)
apps/gateway    the public port gateway (lease-based routing)
apps/web        the web frontend (Next.js)
worker          background jobs: provisioning, cleanup, metering, email
packages/db     Prisma schema and migrations
packages/shared shared types and helpers
infra           Docker and deployment config
docs            runbooks and design notes
```

## Status

The platform runs end to end across its build phases: workspaces, billing, the gateway,
the developer API, persistent volumes, custom images, and the spot market. I ran it
through several rounds of security and correctness audits, written up under `docs/`. It
is a personal project and is not running in production.
