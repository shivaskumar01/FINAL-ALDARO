export enum WorkspaceStatus {
  CREATING = 'CREATING',
  WAITING_FOR_AGENT = 'WAITING_FOR_AGENT',
  VERIFYING = 'VERIFYING',
  WARM_AVAILABLE = 'WARM_AVAILABLE',
  ASSIGNING = 'ASSIGNING',
  RUNNING_ASSIGNED = 'RUNNING_ASSIGNED',
  STOPPING = 'STOPPING',
  TERMINATING = 'TERMINATING',
  TERMINATED = 'TERMINATED',
  FAILED = 'FAILED',
}

export enum VerificationStatus {
  PENDING = 'PENDING',
  PASS = 'PASS',
  FAIL = 'FAIL',
}

export interface Workspace {
  id: string;
  status: WorkspaceStatus;
  gpu_type: string;
  public_ip?: string;
  port_ssh?: number;
  port_jupyter?: number;
  port_vscode?: number;
  // ... other fields as needed
}
