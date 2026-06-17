import crypto from 'crypto';

/**
 * Derive a per-workspace agent secret from the global ALDARO_AGENT_SHARED_SECRET.
 *
 * SECURITY (A3): The global shared secret must NEVER be shipped into customer-controlled
 * workspace VMs. Customers get root on their own workspaces, so a single shared secret in
 * the VM lets any tenant forge control-plane callbacks (heartbeat / verify-result) for ANY
 * workspace_id, enabling cross-tenant DoS and health spoofing.
 *
 * Instead, provisioning injects ONLY the per-workspace derived secret, and the control
 * plane recomputes it from (globalSecret, workspaceId) to verify agent callbacks. Because
 * HKDF is one-way, a customer who extracts their own VM's secret cannot recover the global
 * secret or forge callbacks for any other workspaceId.
 */
export function deriveWorkspaceAgentSecret(globalSecret: string, workspaceId: string): string {
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(globalSecret, 'utf8'),
    Buffer.from('aldaro-agent-ws-secret-v1'), // salt (non-secret, versioned)
    Buffer.from(workspaceId, 'utf8'),         // info, binds the secret to one workspace
    32,
  );
  return Buffer.from(derived).toString('hex');
}
