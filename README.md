# koishi-plugin-adapter-qq-crack

[![npm](https://img.shields.io/npm/v/koishi-plugin-adapter-qq-crack?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-adapter-qq-crack)

适用于 Koishi 的 QQ 适配器插件，重点面向 QQ 原生消息能力和私聊场景，提供更直接的组件转发与消息兼容支持。

## 主要特性

- 仅使用 AccessToken 鉴权，不再保留旧的固定 Token 模式
- 支持 `qq:json`、`qq:markdown`、`qq:rawmarkdown`、`qq:rawmarkdown-without-keyboard`
- 支持 `qq:ark`、`qq:ark24`、`qq:ark23`、`qq:ark37`
- 支持 `qq:button` 直接走 QQ 原生按钮
- 兼容 `h('markdown', ...)` 直接发送 QQ 原生 Markdown
- 兼容 `h('button', ...)` 直接发送 QQ 原生按钮
- 支持 `private:${userId}` 私聊频道 ID 方案
- 支持将 WebSocket 消息中的用户名写回 Koishi 数据库，并回填到 `session.username`
- 心跳僵死时会立即重连，尽量缩短断开时间
- 支持文件上传，富媒体文件类型选择 `type=4`
- 支持私聊引用消息

## 使用示例

### 原生按钮

```ts
command
  .subcommand('.按钮2')
  .action(async ({ session }) => {
    if (!session) return

    await session.send(h('qq:button', {
      render_data: {
        label: '再来一次',
        style: 2,
      },
      action: {
        type: 2,
        permission: {
          type: 2,
        },
        data: '消息 按钮2',
        enter: true,
      },
    }))
  })

command
  .subcommand('.按钮')
  .action(async ({ session }) => {
    if (!session) return

    await session.send([
      h('markdown', '# 你好'),
      h('button', {
        text: '消息 按钮',
      }),
    ])
  })
```

### Ark 消息

```ts
command
  .subcommand('.ark24')
  .action(async ({ session }) => {
    if (!session) return

    const msg = h('qq:ark24', {
      desc: '描述文本',
      prompt: '提示文本',
      title: '标题',
      metaDesc: '详情描述',
      img: 'https://forum.koishi.xyz/uploads/default/original/1X/72b32c99d52e391ce7dfc08d7fff86bd50ae1d03.png',
      link: 'mqqapi://openhalfscreenweb/?height=1920&url=https://forum.koishi.xyz/latest',
      subTitle: '来源',
    })

    await session.send(msg)
  })
```

### Markdown 消息

```ts
command
  .subcommand('.md [text:text]')
  .action(async ({ session }, text) => {
    if (!session) return

    if (!text) {
      /*
[蓝字按钮](mqqapi://aio/inlinecmd?command=消息 md&enter=false&reply=false)
[点我私聊](https://ti.qq.com/new_open_qq/index.html?appid=64&url=mqqapi%3A%2F%2Fqqrobotaio%2Fopen%3Fuin%3D2854197108)
      */
      await session.send(h('markdown', {
        content: `
https://ti.qq.com/new_open_qq/index.html?appid=64&url=mqqapi%3A%2F%2Fqqrobotaio%2Fopen%3Fuin%3D2854197108
`,
        stream: true,
      }))
    } else {
      await session.send(h('markdown', text))
    }
  })
```
