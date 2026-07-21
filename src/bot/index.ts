import { Bot, Context, HTTP, Universal } from 'koishi';
import { WsClient } from '../ws';
import { QQGuildBot } from './guild';
import { QQMessageEncoder } from '../message';
import { GroupInternal } from '../internal';
import { HttpServer } from '../http';
import { decodeUser } from '../utils';
import * as AdapterConfig from '../config';
import { fromPrivateChannelId, isPrivateChannelId, toPrivateChannelId } from '../channel';

interface GetAppAccessTokenResult
{
  access_token: string;
  expires_in: number;
}

export class QQBot<C extends Context = Context, T extends QQBot.Config = QQBot.Config> extends Bot<C, T>
{
  static MessageEncoder = QQMessageEncoder;
  static inject = {
    required: ['http', 'logger', 'database'],
    optional: ['server'],
  };

  public guildBot: QQGuildBot<C>;
  public selfOpenid?: string;

  internal: GroupInternal;
  http: HTTP;

  private _token?: string;
  private _disposeTokenRefresh?: () => void;

  constructor(ctx: C, config: T)
  {
    super(ctx, config, 'qq');
    let endpoint = config.endpoint;
    if (config.sandbox)
    {
      endpoint = endpoint.replace(/^(https?:\/\/)/, '$1sandbox.');
    }
    this.http = this.ctx.http.extend({
      endpoint,
      headers: {
        'Authorization': '',
        'X-Union-Appid': this.config.id,
      },
    });

    this.ctx.plugin(QQGuildBot, {
      parent: this,
    });
    this.internal = new GroupInternal(this, () => this.http);
    if (config.protocol === 'websocket')
    {
      this.ctx.plugin(WsClient, this as QQBot<C, QQBot.Config & WsClient.Options>);
    } else
    {
      this.ctx.plugin(HttpServer, this);
    }
  }

  async initialize()
  {
    const user = await this.guildBot.internal.getMe();
    if (user.union_openid) this.selfOpenid = user.union_openid;
    if (!this.user) this.user = decodeUser(user);
    else Object.assign(this.user, decodeUser(user));
  }

  async stop()
  {
    this._disposeTokenRefresh?.();
    if (this.guildBot)
    {
      delete this.ctx.bots[this.guildBot.sid];
    }
    await super.stop();
  }

  async _ensureAccessToken()
  {
    try
    {
      const result = await this.ctx.http<GetAppAccessTokenResult>('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        data: {
          appId: this.config.id,
          clientSecret: this.config.secret,
        },
      });
      if (!result.data.access_token)
      {
        this.logger.warn(`POST https://bots.qq.com/app/getAppAccessToken response: %o, trace id: %s`, result.data, result.headers.get('x-tps-trace-id'));
        throw new Error('failed to refresh access token');
      }
      this._token = result.data.access_token;
      this.http.config.headers.Authorization = `QQBot ${this._token}`;
      this._disposeTokenRefresh?.();
      const delay = Math.max(1000, (result.data.expires_in - 40) * 1000);
      this._disposeTokenRefresh = this.ctx.setTimeout(() =>
      {
        void this._ensureAccessToken().catch((error) =>
        {
          this.logger.warn(error);
        });
      }, delay);
    } catch (e)
    {
      if (!this.ctx.http.isError(e) || !e.response) throw e;
      this.logger.warn(`POST https://bots.qq.com/app/getAppAccessToken response: %o, trace id: %s`, e.response.data, e.response.headers.get('x-tps-trace-id'));
      throw e;
    }
  }

  async getAccessToken()
  {
    if (!this._token)
    {
      await this._ensureAccessToken();
    }
    return this._token;
  }

  async prepareRequestAuthorization()
  {
    const token = await this.getAccessToken();
    this.http.config.headers.Authorization = `QQBot ${token}`;
  }

  async getWebSocketToken()
  {
    return `QQBot ${await this.getAccessToken()}`;
  }

  async getLogin()
  {
    return this.toJSON();
  }

  async getUser(userId: string, guildId?: string): Promise<Universal.User>
  {
    const api = this.config.userInfoApi || 'https://oiapi.net/api/Openid';
    const appid = this.config.id;
    if (appid && userId)
    {
      try
      {
        const response = await this.ctx.http.get(api, {
          params: {
            appid,
            openid: userId,
          },
        });
        if (response?.code === 1 && response?.data)
        {
          return {
            id: userId,
            name: response.data.nickname || userId,
            avatar: response.data.avatar || `https://q.qlogo.cn/qqapp/${appid}/${userId}/640`,
          };
        }
      } catch (error)
      {
        this.logger.warn(error);
      }
    }
    return {
      id: userId,
      name: userId,
      avatar: `https://q.qlogo.cn/qqapp/${appid}/${userId}/640`,
    };
  }

  async createDirectChannel(id: string)
  {
    return { id: toPrivateChannelId(id), type: Universal.Channel.Type.DIRECT };
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void>
  {
    if (isPrivateChannelId(channelId))
    {
      await this.internal.deletePrivateMessage(fromPrivateChannelId(channelId), messageId);
      return;
    }
    try
    {
      await this.internal.deleteMessage(channelId, messageId);
    } catch (e)
    {
      await this.internal.deletePrivateMessage(fromPrivateChannelId(channelId), messageId);
    }
  }
}

export namespace QQBot
{
  export type BaseConfig = AdapterConfig.BaseConfig;

  export type Config = AdapterConfig.Config;

  export const Config = AdapterConfig.Config;
}
