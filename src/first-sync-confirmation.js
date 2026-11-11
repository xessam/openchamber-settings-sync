export function canConfirmFirstSync(preview, choices, acknowledged) {
  if (acknowledged !== true || preview?.canConfirm !== true || !Array.isArray(preview.items)
    || choices === null || typeof choices !== 'object') return false;
  return preview.items.every((item) => item.action !== 'conflict'
    || (Object.hasOwn(choices, item.key) && ['local', 'remote'].includes(choices[item.key])));
}
