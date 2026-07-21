interface ReferenceEntry
{
  messageId: string;
  referenceId: string;
  createdAt: number;
}

const REFERENCE_CACHE_LIMIT = 2048;
const REFERENCE_CACHE_TTL = 2 * 60 * 1000;
const referenceEntries: ReferenceEntry[] = [];
const referenceMap = new Map<string, string>();

function isReferenceId(messageId: string)
{
  return messageId.startsWith('REFIDX_');
}

function trimReferenceCache()
{
  const now = Date.now();
  while (referenceEntries.length && now - referenceEntries[0].createdAt > REFERENCE_CACHE_TTL)
  {
    const removed = referenceEntries.shift();
    if (!removed) break;
    if (referenceMap.get(removed.messageId) === removed.referenceId)
    {
      referenceMap.delete(removed.messageId);
    }
  }
  while (referenceEntries.length > REFERENCE_CACHE_LIMIT)
  {
    const removed = referenceEntries.shift();
    if (!removed) break;
    if (referenceMap.get(removed.messageId) === removed.referenceId)
    {
      referenceMap.delete(removed.messageId);
    }
  }
}

export function registerMessageReference(messageId: string | undefined, referenceId: string | undefined)
{
  trimReferenceCache();
  if (!messageId || !referenceId) return;
  if (isReferenceId(messageId))
  {
    referenceMap.set(messageId, messageId);
    return;
  }
  referenceMap.set(messageId, referenceId);
  referenceEntries.push({
    messageId,
    referenceId,
    createdAt: Date.now(),
  });
  trimReferenceCache();
}

export function resolveMessageReference(messageId: string | undefined)
{
  trimReferenceCache();
  if (!messageId) return messageId;
  if (isReferenceId(messageId)) return messageId;
  return referenceMap.get(messageId) || messageId;
}

export function resolveMessageIdByReference(referenceId: string | undefined)
{
  trimReferenceCache();
  if (!referenceId) return;
  if (!isReferenceId(referenceId)) return referenceId;
  for (let i = referenceEntries.length - 1; i >= 0; i--)
  {
    const entry = referenceEntries[i];
    if (entry.referenceId === referenceId) return entry.messageId;
  }
}

export function extractReferenceFromExt(value: string | undefined)
{
  if (!value) return;
  if (isReferenceId(value)) return value;
  const capture = /^msg_idx=(REFIDX_.+)$/.exec(value);
  return capture?.[1];
}

export function extractQuotedReferenceFromExt(value: string | undefined)
{
  if (!value) return;
  const capture = /^ref_msg_idx=(REFIDX_.+)$/.exec(value);
  return capture?.[1];
}
