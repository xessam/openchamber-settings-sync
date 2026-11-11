const reasons = {
  'ssh-authentication': 'SSH reported public key authentication failure. Check the key available to the service and GitHub account access.',
  'ssh-host-key': 'SSH reported a host key verification problem. Verify GitHub’s host key and this service user’s known_hosts.',
  dns: 'SSH or Git could not resolve the host. Check DNS and network settings.',
  connection: 'The connection failed or was refused. Check the network, SSH port, and firewall.',
  'repository-not-found': 'The repository was not found or the account does not have access. Check the address and permissions.',
  'ssh-unavailable': 'Git could not start SSH. Check that ssh is installed and available to the service.',
  timeout: 'The Git command timed out. Check network connectivity and try again.',
  'git-unavailable': 'Git could not be started by the service.',
  unknown: 'Git failed without a recognized diagnostic. Check the repository, authentication, and network.',
};

export function sanitizeRepositoryDiagnostics(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(reasons, value.reason)
    || !['ssh', 'https'].includes(value.transport)) return undefined;
  const diagnostics = { transport: value.transport, reason: value.reason };
  if (value.transport === 'ssh' && ['configured', 'not-configured'].includes(value.sshAgent)) {
    diagnostics.sshAgent = value.sshAgent;
  }
  if (Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255) {
    diagnostics.exitCode = value.exitCode;
  }
  return diagnostics;
}

export function formatRepositoryDiagnostics(value) {
  const diagnostics = sanitizeRepositoryDiagnostics(value);
  if (!diagnostics) return [];
  const lines = [
    `Transport: ${diagnostics.transport.toUpperCase()}`,
    'Command: git ls-remote --heads [repository]',
    'Authentication prompts: disabled',
  ];
  if (diagnostics.transport === 'ssh') {
    lines.push('SSH: BatchMode=yes, ConnectTimeout=5s');
    if (diagnostics.sshAgent) {
      lines.push(`SSH agent environment: ${diagnostics.sshAgent === 'configured' ? 'configured (availability not verified)' : 'not configured'}`);
    }
  }
  if (diagnostics.exitCode !== undefined) lines.push(`Git exit code: ${diagnostics.exitCode}`);
  lines.push(`Diagnostic: ${reasons[diagnostics.reason]}`);
  return lines;
}
