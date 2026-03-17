/**
 * Export port lease data for integration test review
 * 
 * Output: JSON array of port allocations with:
 * - workspace_id
 * - ssh_port, jupyter_port, vscode_port
 * - allocated_at
 * - released_at
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const endpoints = await prisma.workspaceEndpoint.findMany({
    orderBy: { allocatedAt: 'desc' },
    take: 100,
    include: {
      workspace: {
        select: {
          id: true,
          status: true,
          assignedUserId: true,
        },
      },
    },
  });

  const export_data = endpoints.map(e => ({
    endpoint_id: e.id,
    workspace_id: e.workspaceId,
    workspace_status: e.workspace.status,
    user_id: e.workspace.assignedUserId,
    gateway_host: e.gatewayHost,
    ssh_port: e.sshPort,
    jupyter_port: e.jupyterPort,
    vscode_port: e.vscodePort,
    allocated_at: e.allocatedAt.toISOString(),
    released_at: e.releasedAt?.toISOString() || null,
    is_leaked: e.releasedAt === null && e.workspace.status === 'TERMINATED',
  }));

  // Summary
  const leaked = export_data.filter(e => e.is_leaked);
  const active = export_data.filter(e => e.released_at === null && !e.is_leaked);

  console.log(JSON.stringify({
    summary: {
      total: export_data.length,
      active: active.length,
      released: export_data.length - active.length - leaked.length,
      leaked: leaked.length,
    },
    leases: export_data,
  }, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
