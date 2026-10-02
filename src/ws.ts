import { Adapter, Context, Schema } from 'koishi';
import { QQBot } from './bot';
import { Opcode, Payload } from './types';
import { adaptSession, decodeUser } from './utils';
import { logDebug } from './logger';

export class WsClient<C extends Context = Context> extends Adapter.WsClient<C, QQBot<C, QQBot.Config & WsClient.Options>>
{
  _sessionId = '';
  _s: number = null;
  _disposeHeartbeat?: () => void;
  _acked = true;

  async prepare()
  {
    await this.bot.prepareRequestAuthorization();
    try
    {
      const url = this.bot.config.gatewayUrl
        ? this.bot.config.gatewayUrl
        : await (async () =>
        {
          const gatewayUrl = new URL((await this.bot.internal.getGateway()).url);
          const endpoint = this.bot.http.config.baseURL
            || this.bot.config.endpoint
            || 'https://api.bot.qq.com/';
          // 兼容 api.sgroup.qq.com 与 api.bot.qq.com，并允许省略协议前缀
          const endpointUrl = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
          gatewayUrl.host = endpointUrl.host;
          return gatewayUrl.toString();
        })();
      logDebug(this.bot, 'url: %s', url);
      return this.bot.http.ws(url);
    } catch (error)
    {
      if (this.bot.http.isError(error) && error.response)
      {
        this.bot.logger.warn(`GET /gateway response: %o`, error.response.data);
      }
      throw error;
    }
  }

  heartbeat()
  {
    if (!this._acked)
    {
      this.bot.logger.warn('zombied connection, closing socket to reconnect');
      this._disposeHeartbeat?.();
      this._disposeHeartbeat = null;
      if (typeof (this.socket as any)?.terminate === 'function')
      {
        (this.socket as any).terminate();
      } else
      {
        this.socket?.close(4000, 'zombied connection');
      }
      return;
    }
    this.socket.send(JSON.stringify({
      op: Opcode.HEARTBEAT,
      s: this._s,
    }));
    this._acked = false;
  }

  async accept()
  {
    this._acked = true;
    this.socket.addEventListener('message', async ({ data }) =>
    {
      const parsed: Payload = JSON.parse(data.toString());
      if (parsed.op !== Opcode.HEARTBEAT_ACK)
      {
        logDebug(this.bot, 'websocket receives %o', parsed);
      }
      if (parsed.op === Opcode.HELLO)
      {
        this._acked = true;
        const token = await this.bot.getWebSocketToken();
        if (this._sessionId)
        {
          this.socket.send(JSON.stringify({
            op: Opcode.RESUME,
            d: {
              token,
              session_id: this._sessionId,
              seq: this._s,
            },
          }));
        } else
        {
          this.socket.send(JSON.stringify({
            op: Opcode.IDENTIFY,
            d: {
              token,
              intents: this.bot.config.intents,
              shard: [0, 1],
            },
          }));
        }
        this._disposeHeartbeat?.();
        this._disposeHeartbeat = this.bot.ctx.setInterval(() => this.heartbeat(), parsed.d.heartbeat_interval);
      } else if (parsed.op === Opcode.HEARTBEAT_ACK)
      {
        this._acked = true;
      } else if (parsed.op === Opcode.INVALID_SESSION)
      {
        this._sessionId = '';
        this._s = null;
        this.bot.logger.warn('offline: invalid session, closing socket to reconnect with identify');
        this._disposeHeartbeat?.();
        this._disposeHeartbeat = null;
        this.socket?.close(4000, 'invalid session');
      } else if (parsed.op === Opcode.RECONNECT)
      {
        this.bot.logger.warn('offline: server request reconnect, closing socket to reconnect');
        this._disposeHeartbeat?.();
        this._disposeHeartbeat = null;
        this.socket?.close(4000, 'server request reconnect');
      } else if (parsed.op === Opcode.DISPATCH)
      {
        this.bot.dispatch(this.bot.session({
          type: 'internal',
          _type: 'qq/' + parsed.t.toLowerCase().replace(/_/g, '-'),
          _data: parsed.d,
        }));
        this._s = parsed.s;
        if (parsed.t === 'READY')
        {
          this._sessionId = parsed.d.session_id;
          this.bot.user = decodeUser(parsed.d.user);
          this.bot.guildBot.user = this.bot.user;
          try
          {
            await this.bot.initialize();
          } catch (e)
          {
            this.bot.logger.warn(e);
          }
          return this.bot.online();
        }
        if (parsed.t === 'RESUMED')
        {
          return this.bot.online();
        }
        const session = await adaptSession(this.bot, parsed);
        if (session) this.bot.dispatch(session);
      }
    });

    this.socket.addEventListener('close', (e) =>
    {
      logDebug(this.bot, 'websocket closed, code %o, reason: %s', e.code, e.reason);
      if (e.code > 4000 && ![4008, 4009].includes(e.code))
      {
        this._sessionId = '';
        this._s = null;
      }
      this._disposeHeartbeat?.();
      this._disposeHeartbeat = null;
    });
  }

  async stop()
  {
    this._disposeHeartbeat?.();
    this._disposeHeartbeat = null;
    await super.stop();
  }
}

export namespace WsClient
{
  export interface Options extends Adapter.WsClientConfig
  {
  }

  export const Options: Schema<Options> = Adapter.WsClientConfig;
}
