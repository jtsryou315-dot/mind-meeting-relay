/**
 * マインドミーティング連携用の中継サーバー
 *
 * 必要な環境変数（Railwayの Variables で設定）:
 *   DISCORD_BOT_TOKEN : DiscordのBotトークン
 *   RELAY_SECRET       : GAS <-> このサーバー間の合言葉（自分で好きな文字列を決めてOK）
 *   GAS_WEBHOOK_URL    : Apps ScriptのWebアプリURL（/exec で終わるもの）
 *   CONSULT_CATEGORY_NAME : 相談チャンネル群が入っているカテゴリ名（例: インスタ講座）
 *   PORT               : Railwayが自動で設定するので通常は指定不要
 */

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

const RELAY_SECRET = process.env.RELAY_SECRET;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL;
const CONSULT_CATEGORY_NAME = process.env.CONSULT_CATEGORY_NAME || 'インスタ講座';

if (!process.env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN が未設定です');
if (!RELAY_SECRET) throw new Error('RELAY_SECRET が未設定です');
if (!GAS_WEBHOOK_URL) throw new Error('GAS_WEBHOOK_URL が未設定です');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('ready', () => {
  console.log(`Discordにログインしました: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    if (message.channel.parent && message.channel.parent.name === CONSULT_CATEGORY_NAME) {
      await forwardToGas_('new_message', {
        channelId: message.channel.id,
        channelName: message.channel.name,
        messageId: message.id,
        content: message.content,
        timestamp: message.createdAt.toISOString(),
      });
      return;
    }

    if (message.channel.isThread()) {
      await forwardToGas_('thread_reply', {
        threadId: message.channel.id,
        messageId: message.id,
        content: message.content,
        authorId: message.author.id,
        timestamp: message.createdAt.toISOString(),
      });
    }
  } catch (err) {
    console.error('messageCreate処理エラー:', err);
  }
});

async function forwardToGas_(type, data) {
  const res = await fetch(GAS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: RELAY_SECRET, type, data }),
  });
  if (!res.ok) {
    console.error('GAS Webhook呼び出し失敗:', res.status, await res.text());
  }
}

/** ===== GASから呼び出されるHTTP API ===== */

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ready: client.isReady() }));

app.use((req, res, next) => {
  if (req.headers['x-relay-secret'] !== RELAY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.post('/create-thread', async (req, res) => {
  try {
    const { channelId, messageId, threadName, firstMessage } = req.body;
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    const thread = await message.startThread({
      name: threadName || 'マインドミーティング日程調整',
      autoArchiveDuration: 1440,
    });
    if (firstMessage) await thread.send(firstMessage);
    res.json({ threadId: thread.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.post('/send-message', async (req, res) => {
  try {
    const { channelId, content } = req.body;
    const channel = await client.channels.fetch(channelId);
    const sent = await channel.send(content);
    res.json({ messageId: sent.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.post('/add-thread-member', async (req, res) => {
  try {
    const { threadId, userId } = req.body;
    const thread = await client.channels.fetch(threadId);
    await thread.members.add(userId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`HTTPサーバー起動: port ${port}`));

client.login(process.env.DISCORD_BOT_TOKEN);