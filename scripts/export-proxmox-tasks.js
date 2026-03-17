/**
 * Export Proxmox task history for integration test review
 * 
 * Output: JSON array of tasks with:
 * - upid
 * - status (OK, failed, etc)
 * - start_time
 * - end_time
 * - node
 * - type (qmclone, qmstart, qmstop, etc)
 */

const axios = require('axios');
const https = require('https');

const PROXMOX_API_URL = process.env.PROXMOX_API_URL;
const PROXMOX_TOKEN = process.env.PROXMOX_API_TOKEN_ID && process.env.PROXMOX_API_TOKEN_SECRET
  ? `PVEAPIToken=${process.env.PROXMOX_API_TOKEN_ID}=${process.env.PROXMOX_API_TOKEN_SECRET}`
  : null;

const api = axios.create({
  baseURL: PROXMOX_API_URL,
  headers: { Authorization: PROXMOX_TOKEN },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

async function main() {
  if (!PROXMOX_API_URL || !PROXMOX_TOKEN) {
    console.error('PROXMOX_API_URL and PROXMOX_API_TOKEN_* required');
    process.exit(1);
  }

  // Get all nodes
  const nodesRes = await api.get('/api2/json/nodes');
  const nodes = nodesRes.data.data;

  const allTasks = [];

  for (const node of nodes) {
    // Get recent tasks for this node
    const tasksRes = await api.get(`/api2/json/nodes/${node.node}/tasks`, {
      params: {
        limit: 100,
        start: 0,
      },
    });

    const tasks = tasksRes.data.data
      .filter(t => t.id && t.id.includes('aldaro'))
      .map(t => ({
        upid: t.upid,
        node: node.node,
        type: t.type,
        status: t.status,
        exitstatus: t.exitstatus,
        start_time: new Date(t.starttime * 1000).toISOString(),
        end_time: t.endtime ? new Date(t.endtime * 1000).toISOString() : null,
        user: t.user,
        id: t.id,
      }));

    allTasks.push(...tasks);
  }

  // Summary
  const successful = allTasks.filter(t => t.exitstatus === 'OK');
  const failed = allTasks.filter(t => t.exitstatus && t.exitstatus !== 'OK');
  const running = allTasks.filter(t => !t.end_time);

  console.log(JSON.stringify({
    summary: {
      total: allTasks.length,
      successful: successful.length,
      failed: failed.length,
      running: running.length,
    },
    tasks: allTasks,
  }, null, 2));
}

main().catch(console.error);
