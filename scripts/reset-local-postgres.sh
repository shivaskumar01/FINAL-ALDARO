#!/usr/bin/env bash
# Reset local Postgres staging database to clean state.
# Drops and recreates the database, applies schema, seeds data.
#
# Usage:
#   ./scripts/reset-local-postgres.sh
#   POSTGRES_USER=myuser POSTGRES_DB=my_staging ./scripts/reset-local-postgres.sh
#
# Prerequisites:
#   - PostgreSQL running locally
#   - packages/db/prisma/schema.staging.prisma exists
#   - npm install completed (tsx, prisma available)

set -euo pipefail

POSTGRES_USER="${POSTGRES_USER:-aldaro}"
POSTGRES_DB="${POSTGRES_DB:-aldaro_staging}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-aldaro_staging_local}"

DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
SCHEMA_FILE="packages/db/prisma/schema.staging.prisma"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

echo "=== Local Postgres Reset ==="
echo "Database: ${POSTGRES_DB}"
echo "User: ${POSTGRES_USER}"
echo "Host: ${POSTGRES_HOST}:${POSTGRES_PORT}"
echo ""

# Check schema file exists
if [ ! -f "$SCHEMA_FILE" ]; then
  echo "ERROR: $SCHEMA_FILE not found."
  echo "Create it: cp packages/db/prisma/schema.prisma packages/db/prisma/schema.staging.prisma"
  echo "Then change provider = \"sqlite\" to provider = \"postgresql\""
  exit 1
fi

# Check Postgres is running
if ! pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -q 2>/dev/null; then
  echo "ERROR: PostgreSQL is not running on ${POSTGRES_HOST}:${POSTGRES_PORT}"
  echo "Start it: brew services start postgresql@15"
  exit 1
fi

echo "Step 1: Drop and recreate database..."
dropdb -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
createdb -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" "$POSTGRES_DB"
echo "  Database recreated."

echo "Step 2: Apply Prisma schema..."
DATABASE_URL="$DATABASE_URL" npx prisma db push --schema "$SCHEMA_FILE" --accept-data-loss --skip-generate 2>&1 | tail -5
echo "  Schema applied."

echo "Step 3: Generate Prisma client..."
DATABASE_URL="$DATABASE_URL" npx prisma generate --schema "$SCHEMA_FILE" 2>&1 | tail -3
echo "  Client generated."

echo "Step 4: Seed data..."
DATABASE_URL="$DATABASE_URL" npx tsx packages/db/prisma/seed.ts 2>&1 | tail -10
echo "  Seed completed."

echo "Step 5: Verify..."
TABLES=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")
USERS=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT COUNT(*) FROM users;")
GPUS=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT COUNT(*) FROM fleet_gpus;")

echo "  Tables:${TABLES}"
echo "  Users:${USERS}"
echo "  GPUs:${GPUS}"

# Check for clean state
DIRTY=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "
  SELECT COUNT(*) FROM workspaces WHERE status NOT IN ('TERMINATED', 'FAILED');
")
if [ "$(echo "$DIRTY" | tr -d ' ')" != "0" ]; then
  echo "  WARNING: ${DIRTY} workspaces in non-terminal state"
else
  echo "  Clean state verified (no active workspaces)."
fi

echo ""
echo "=== Reset complete ==="
echo "DATABASE_URL=$DATABASE_URL"
echo ""
echo "To start worker against this database:"
echo "  cd worker && DATABASE_URL=\"$DATABASE_URL\" npm run dev"
