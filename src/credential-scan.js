const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|secret|credential|authorization|private[-_ ]?key|client[-_ ]?secret)\b["']?\s*[:=]\s*["']?\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /[?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|key|password|passwd|secret|credential|authorization|auth|private[-_]?key|client[-_]?secret)=([^&#\s]+)/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

export function containsCredentialMarker(text) {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}
