# FINAL Aldaro.AI - Complete Project Snapshot

**Created:** February 4, 2026  
**Total Size:** 1.1 GB  
**Status:** Production-Ready Codebase

---

## Project Structure

```
FINAL Aldaro.AI/
├── apps/
│   ├── agent/          # Python agent for VM monitoring and heartbeat
│   ├── api/            # Fastify backend API (TypeScript)
│   ├── cli/            # Python CLI for GPU management
│   ├── gateway/        # Edge gateway for port allocation
│   └── web/            # Next.js frontend (React/TypeScript)
├── packages/
│   ├── db/             # Prisma database schema & seed
│   └── shared/         # Shared TypeScript types/constants
├── worker/             # Background worker for warm pool & idle shutdown
├── infra/              # Docker, agent scripts, migrations
├── migrations/         # SQL migration files
└── docs/               # OpenAPI spec
```

---

## Key Applications

### Frontend (`apps/web`)
- **Framework:** Next.js 13.5.6
- **Port:** http://localhost:3000
- **Pages:**
  - `/` - Main landing page (optimized, animated)
  - `/app` - Dashboard (fixed JSX structure)
  - `/login`, `/signup` - Authentication
  - `/terms` - Terms of Service
  - `/gpu/*` - GPU detail pages
  - `/author/*` - Author portal for content management

### Backend API (`apps/api`)
- **Framework:** Fastify
- **Port:** http://localhost:4000
- **Features:**
  - JWT authentication with CSRF protection
  - Stripe billing integration
  - Proxmox fleet provider (self-owned GPU infrastructure)
  - GitHub integration for AI Adoption Program
  - Rate limiting, helmet security, CORS (localhost-friendly)

### Gateway (`apps/gateway`)
- **Port:** 5001 (internal)
- **Purpose:** Port allocation for workspace endpoints

### Worker (`worker`)
- Background jobs for:
  - Warm pool management
  - Idle workspace shutdown
  - Orphan resource cleanup

---

## Database (Prisma + SQLite)

**Schema Includes:**
- `User`, `StripeCustomer`, `Workspace`, `WorkspaceSession`
- `FleetNode`, `FleetGpu`, `VmTemplate`, `WorkspaceGpuAllocation`
- `Project`, `Run`, `Author`, `Post`, `Banner`, `Announcement`
- `AuditLog`, `SecurityEvent`

**Location:** `packages/db/prisma/dev.db`

---

## Recent Fixes Applied

1. **JSX Syntax Error (apps/web/app/app/page.tsx)**
   - Added missing closing `</div>` for left column wrapper
   - Build now compiles successfully

2. **CORS Configuration (apps/api/src/index.ts)**
   - Updated to allow any `localhost` port during development
   - API calls now work from any local frontend port

3. **"Go Atomic" Section Sizing (apps/web/app/page.tsx)**
   - Reduced padding, font sizes, and spacing
   - More compact, modern appearance

---

## URLs

- **Frontend:** http://localhost:3000
- **Dashboard:** http://localhost:3000/app
- **API:** http://localhost:4000
- **Gateway:** http://localhost:5001 (internal)

---

## Dependencies

### Frontend
- `next`, `react`, `framer-motion`, `axios`, `zustand`, `lucide-react`

### Backend
- `@fastify/cors`, `@fastify/jwt`, `@fastify/helmet`, `stripe`, `@prisma/client`

### Database
- `prisma` with SQLite (dev), PostgreSQL (production)

---

## Environment Variables

**.env files required:**
- `apps/api/.env` - Database URL, JWT secret, Stripe keys, Proxmox credentials
- `apps/web/.env.local` - `NEXT_PUBLIC_API_URL=http://localhost:4000`
- `worker/.env` - Worker configuration

---

## Running the Project

```bash
# Install dependencies (root)
npm install

# Start API server
cd apps/api && npm run dev

# Start web frontend
cd apps/web && npm run dev

# (Optional) Start worker
cd worker && npm run dev
```

---

## Architecture Highlights

### Fleet-Owned Infrastructure
- Moved from RunPod (3rd party) to **self-hosted Proxmox fleet**
- VM cloning with GPU passthrough
- Warm pool for instant provisioning (<60s)
- Per-second billing via Stripe

### AI Adoption Program
- GitHub integration for seamless onboarding
- Internal-only GPUs (no 3rd party API dependencies)
- Project + Run tracking

### Security
- JWT auth with httpOnly cookies
- CSRF protection
- Rate limiting (100 req/min)
- HMAC-authenticated agent callbacks
- Audit logging for all sensitive actions

---

## Production Readiness

- Compile errors fixed
- CORS configured for localhost
- Database seeded with fleet nodes & GPUs
- Authentication & billing implemented
- Worker jobs for resource management
- Modern, optimized UI with animations

---

**Status:** Ready for deployment or further development.
