import * as QQ from './types';

interface StreamState
{
  id?: string;
  index: number;
}

const streamStates = new WeakMap<object, StreamState>();

export function applyAutoStream(session: object | undefined, request: QQ.Message.Request, enabled?: boolean)
{
  if (!enabled || request.stream || !session) return;
  const state = streamStates.get(session);
  request.stream = {
    state: 1,
    id: state?.id,
    index: state?.index ?? 0,
    reset: false,
  };
}

export function updateAutoStream(session: object | undefined, request: QQ.Message.Request, messageId?: string)
{
  if (!session || !request.stream) return;
  if (request.stream.reset || request.stream.state >= 10)
  {
    streamStates.delete(session);
    return;
  }
  streamStates.set(session, {
    id: messageId || request.stream.id,
    index: (request.stream.index ?? 0) + 1,
  });
}

export function clearAutoStream(session: object | undefined)
{
  if (!session) return;
  streamStates.delete(session);
}
