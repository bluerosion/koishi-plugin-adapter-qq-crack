import * as crypto from 'node:crypto';
import { QQBot } from './bot';
import * as QQ from './types';
import { logDebug } from './logger';

const MD5_10M_SIZE = 10002432;
const PART_UPLOAD_TIMEOUT = 300_000;
const PART_UPLOAD_MAX_RETRIES = 2;
const PART_FINISH_MAX_RETRIES = 2;
const PART_FINISH_RETRYABLE_CODES = new Set([40093001]);
const PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const PART_FINISH_RETRYABLE_INTERVAL_MS = 1000;
const MAX_CONCURRENT_PARTS = 10;
const DEFAULT_CONCURRENT_PARTS = 1;

function computeBufferHashes(buffer: Buffer): QQ.Message.File.UploadPrepareHashes
{
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  const md5_10m = buffer.length > MD5_10M_SIZE
    ? crypto.createHash('md5').update(buffer.subarray(0, MD5_10M_SIZE)).digest('hex')
    : md5;
  return { md5, sha1, md5_10m };
}

function formatFileSize(bytes: number): string
{
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getErrorCode(error: { response?: { data?: unknown; }; }): number | undefined
{
  const data = error.response?.data;
  if (!data || typeof data !== 'object') return;
  if ('err_code' in data && typeof data.err_code === 'number') return data.err_code;
  if ('code' in data && typeof data.code === 'number') return data.code;
}

async function putToPresignedUrl(
  bot: QQBot,
  presignedUrl: string,
  data: Buffer,
  partIndex: number,
  totalParts: number,
): Promise<void>
{
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt++)
  {
    try
    {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PART_UPLOAD_TIMEOUT);
      try
      {
        logDebug(bot.config, `[chunked-upload] PUT Part ${partIndex}/${totalParts}: size=${formatFileSize(data.length)}`);
        const startTime = Date.now();
        const response = await fetch(presignedUrl, {
          method: 'PUT',
          body: new Uint8Array(data),
          headers: { 'Content-Length': String(data.length) },
          signal: controller.signal,
        });
        const elapsed = Date.now() - startTime;
        if (!response.ok)
        {
          const body = await response.text().catch(() => '');
          throw new Error(`COS PUT failed: ${response.status} ${response.statusText} - ${body}`);
        }
        logDebug(bot.config, `[chunked-upload] PUT Part ${partIndex}/${totalParts}: OK (${elapsed}ms)`);
        return;
      } finally
      {
        clearTimeout(timeoutId);
      }
    } catch (err)
    {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === 'AbortError')
      {
        lastError = new Error(`Part ${partIndex}/${totalParts} upload timeout after ${PART_UPLOAD_TIMEOUT}ms`);
      }
      if (attempt < PART_UPLOAD_MAX_RETRIES)
      {
        const delay = 1000 * Math.pow(2, attempt);
        logDebug(bot.config, `[chunked-upload] Part ${partIndex}/${totalParts}: attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}

async function partFinishWithRetry(
  bot: QQBot,
  isDirect: boolean,
  targetId: string,
  data: QQ.Message.File.UploadPartFinishRequest,
  retryTimeoutMs?: number,
): Promise<void>
{
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= PART_FINISH_MAX_RETRIES; attempt++)
  {
    try
    {
      await bot.getAccessToken();
      if (isDirect)
      {
        await bot.internal.uploadPartFinishPrivate(targetId, data);
      } else
      {
        await bot.internal.uploadPartFinishGuild(targetId, data);
      }
      return;
    } catch (err)
    {
      lastError = err instanceof Error ? err : new Error(String(err));
      const bizCode = getErrorCode(err as any);
      if (bizCode !== undefined && PART_FINISH_RETRYABLE_CODES.has(bizCode))
      {
        const timeoutMs = retryTimeoutMs ?? PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS;
        logDebug(bot.config, `[chunked-upload] PartFinish hit retryable bizCode=${bizCode}, entering persistent retry (timeout=${timeoutMs / 1000}s)...`);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline)
        {
          try
          {
            await bot.getAccessToken();
            if (isDirect)
            {
              await bot.internal.uploadPartFinishPrivate(targetId, data);
            } else
            {
              await bot.internal.uploadPartFinishGuild(targetId, data);
            }
            return;
          } catch (retryErr)
          {
            const retryBizCode = getErrorCode(retryErr as any);
            if (retryBizCode === undefined || !PART_FINISH_RETRYABLE_CODES.has(retryBizCode))
            {
              throw retryErr;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const actualDelay = Math.min(PART_FINISH_RETRYABLE_INTERVAL_MS, remaining);
            await new Promise(resolve => setTimeout(resolve, actualDelay));
          }
        }
        throw new Error(`upload_part_finish persistent retry timed out after ${timeoutMs / 1000}s`);
      }
      if (attempt < PART_FINISH_MAX_RETRIES)
      {
        const delay = 1000 * Math.pow(2, attempt);
        logDebug(bot.config, `[chunked-upload] PartFinish attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message.slice(0, 200)}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  maxConcurrent: number,
): Promise<void>
{
  for (let i = 0; i < tasks.length; i += maxConcurrent)
  {
    const batch = tasks.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(task => task()));
  }
}

export async function chunkedUpload(
  bot: QQBot,
  targetId: string,
  isDirect: boolean,
  fileBuffer: Buffer,
  fileName: string,
  fileType: QQ.Message.File.Type,
): Promise<QQ.Message.File.Response>
{
  const fileSize = fileBuffer.length;
  const prefix = '[chunked-upload]';

  logDebug(bot.config, `${prefix} Starting: file=${fileName}, size=${formatFileSize(fileSize)}, type=${fileType}`);

  const hashes = computeBufferHashes(fileBuffer);
  logDebug(bot.config, `${prefix} Hashes: md5=${hashes.md5}, sha1=${hashes.sha1}, md5_10m=${hashes.md5_10m}`);

  await bot.getAccessToken();
  let prepareResp: QQ.Message.File.UploadPrepareResponse;
  if (isDirect)
  {
    prepareResp = await bot.internal.uploadPreparePrivate(targetId, {
      file_type: fileType, file_name: fileName, file_size: fileSize,
      md5: hashes.md5, sha1: hashes.sha1, md5_10m: hashes.md5_10m,
    });
  } else
  {
    prepareResp = await bot.internal.uploadPrepareGuild(targetId, {
      file_type: fileType, file_name: fileName, file_size: fileSize,
      md5: hashes.md5, sha1: hashes.sha1, md5_10m: hashes.md5_10m,
    });
  }

  const { upload_id, parts } = prepareResp;
  const block_size = Number(prepareResp.block_size);
  const maxConcurrent = Math.min(
    prepareResp.concurrency ? Number(prepareResp.concurrency) : DEFAULT_CONCURRENT_PARTS,
    MAX_CONCURRENT_PARTS,
  );
  const retryTimeoutMs = prepareResp.retry_timeout
    ? Math.min(Number(prepareResp.retry_timeout) * 1000, 10 * 60 * 1000)
    : undefined;

  logDebug(bot.config, `${prefix} Prepared: upload_id=${upload_id}, block_size=${formatFileSize(block_size)}, parts=${parts.length}, concurrency=${maxConcurrent}`);

  let completedParts = 0;

  const uploadPart = async (part: QQ.Message.File.UploadPart): Promise<void> =>
  {
    const partIndex = part.index;
    const offset = (partIndex - 1) * block_size;
    const length = Math.min(block_size, fileSize - offset);
    const partBuffer = fileBuffer.subarray(offset, offset + length);
    const md5Hex = crypto.createHash('md5').update(partBuffer).digest('hex');

    logDebug(bot.config, `${prefix} Part ${partIndex}/${parts.length}: uploading ${formatFileSize(length)}`);

    await putToPresignedUrl(bot, part.presigned_url, partBuffer, partIndex, parts.length);

    await partFinishWithRetry(bot, isDirect, targetId, {
      upload_id, part_index: partIndex, block_size: length, md5: md5Hex,
    }, retryTimeoutMs);

    completedParts++;
    logDebug(bot.config, `${prefix} Part ${partIndex}/${parts.length}: completed (${completedParts}/${parts.length})`);
  };

  await runWithConcurrency(parts.map(part => () => uploadPart(part)), maxConcurrent);

  logDebug(bot.config, `${prefix} All ${parts.length} parts uploaded, completing...`);

  await bot.getAccessToken();
  let result: QQ.Message.File.Response;
  if (isDirect)
  {
    result = await bot.internal.completeUploadPrivate(targetId, { upload_id });
  } else
  {
    result = await bot.internal.completeUploadGuild(targetId, { upload_id });
  }

  logDebug(bot.config, `${prefix} Completed: file_uuid=${result.file_uuid}, ttl=${result.ttl}s`);
  return result;
}
