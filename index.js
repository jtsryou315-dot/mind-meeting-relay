/**
 * マインドミーティング連携用の中継サーバー
 *
 * 必要な環境変数（Railwayの Variables で設定）:
 *   DISCORD_BOT_TOKEN : DiscordのBotトークン
 *   RELAY_SECRET       : GAS <-> このサーバー間の合言葉
 *   GAS_WEBHOOK_URL    : Apps ScriptのWebアプリURL（/exec で終わるもの）
 *   CONSULT_CHANNEL_ID : 相談が投稿されるチャンネル（アカウント添削グループ）のID
 *   INSTA_COURSE_CHANNEL_ID : 個別スレッドが入っているチャンネル（インスタ講座）のID
 */

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

const RELAY_SECRET = process.env.RELAY_SECRET;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL;
const CONSULT_CHANNEL_ID = process.env.CONSULT_CHANNEL_ID;
const INSTA_COURSE_CHANNEL_ID = process.env.INSTA_COURSE_CHANNEL_ID;

if (!process.env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN が未設定です');
if (!RELAY_SECRET) throw new Error('RELAY_SECRET が未設定です');
if (!GAS_WEBHOOK_URL) throw new Error('GAS_WEBHOOK_URL が未設定です');
if (!CONSULT_CHANNEL_ID) throw new Error('CONSULT_CHANNEL_ID が未設定です');
if (!INSTA_COURSE_CHANNEL_ID) throw new Error('INSTA_COURSE_CHANNEL_ID が未設定です');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let messageCount = 0;

client.once('ready', () => {
  console.log(`Discordにログインしました: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  messageCount++;
  try {
    if (message.author.bot) return;

    if (message.channel.id === CONSULT_CHANNEL_ID) {
      await forwardToGas_('new_message', {
        channelId: message.channel.id,
        messageId: message.id,
        authorName: message.member ? message.member.displayName : message.author.username,
        authorId: message.author.id,
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

function extractNickname_(name) {
  return name.split(/[（(]/)[0].trim();
}

async function findStudentThread_(studentName) {
  const channel = await client.channels.fetch(INSTA_COURSE_CHANNEL_ID);
  const nickname = extractNickname_(studentName);

  const active = await channel.threads.fetchActive();
  let found = [...active.threads.values()].find(t => t.name.includes(nickname));
  if (!found) {
    const archived = await channel.threads.fetchArchived();
    found = [...archived.threads.values()].find(t => t.name.includes(nickname));
  }

  if (found) {
    console.log('スレッド発見:', found.name, 'archived:', found.archived, 'locked:', found.locked, 'type:', found.type);
    try {
      await found.join();
      console.log('スレッド参加: 成功');
    } catch (e) {
      console.log('スレッド参加: 失敗 -', String(e));
    }
  } else {
    console.log('スレッドが見つかりませんでした:', nickname);
  }

  return found || null;
}

/** ===== GASから呼び出されるHTTP API ===== */

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ready: client.isReady(), guilds: client.guilds.cache.size, messagesSeen: messageCount }));

app.use((req, res, next) => {
  if (req.headers['x-relay-secret'] !== RELAY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.post('/find-student-thread', async (req, res) => {
  try {
    const { studentName } = req.body;
    const thread = await findStudentThread_(studentName);
    if (!thread) return res.status(404).json({ error: 'thread_not_found' });
    res.json({ threadId: thread.id, threadName: thread.name });
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
