/**
 * Export workspace sessions for integration test review
 * 
 * Output: JSON array of workspace sessions with:
 * - workspace_id
 * - start_time
 * - end_time
 * - billed_seconds
 * - final_status
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const sessions = await prisma.usageSession.findMany({
    orderBy: { startTime: 'desc' },
    take: 100,
    include: {
      workspace: {
        select: {
          id: true,
          status: true,
          gpuType: true,
          region: true,
          proxmoxNode: true,
          proxmoxVmid: true,
        },
      },
    },
  });

  const export_data = sessions.map(s => ({
    session_id: s.id,
    workspace_id: s.workspaceId,
    user_id: s.userId,
    start_time: s.startTime.toISOString(),
    end_time: s.endTime?.toISOString() || null,
    total_seconds: s.totalSeconds,
    billed_cents: s.billedCents,
    session_status: s.status,
    workspace_status: s.workspace.status,
    gpu_type: s.workspace.gpuType,
    region: s.workspace.region,
    proxmox_node: s.workspace.proxmoxNode,
    proxmox_vmid: s.workspace.proxmoxVmid,
  }));

  console.log(JSON.stringify(export_data, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
