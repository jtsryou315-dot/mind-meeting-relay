/**
 * マインドミーティング連携用の中継サーバー
 *
 * 必要な環境変数（Railwayの Variables で設定）:
 *   DISCORD_BOT_TOKEN        : DiscordのBotトークン
 *   RELAY_SECRET            : GAS <-> このサーバー間の合言葉
 *   GAS_WEBHOOK_URL         : Apps ScriptのWebアプリURL（/exec で終わるもの）
 *   CONSULT_CHANNEL_ID      : 相談が投稿されるチャンネル（アカウント添削グループ）のID
 *   INSTA_COURSE_CHANNEL_ID : 個別スレッドが入っているチャンネル（インスタ講座）のID
 *   MEETING_ROOM_CHANNEL_ID : ヒカルさんの募集投稿があるチャンネル（ミーティング部屋）のID
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
const MEETING_ROOM_CHANNEL_ID = process.env.MEETING_ROOM_CHANNEL_ID;

if (!process.env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN が未設定です');
if (!RELAY_SECRET) throw new Error('RELAY_SECRET が未設定です');
if (!GAS_WEBHOOK_URL) throw new Error('GAS_WEBHOOK_URL が未設定です');
if (!CONSULT_CHANNEL_ID) throw new Error('CONSULT_CHANNEL_ID が未設定です');
if (!INSTA_COURSE_CHANNEL_ID) throw new Error('INSTA_COURSE_CHANNEL_ID が未設定です');
if (!MEETING_ROOM_CHANNEL_ID) throw new Error('MEETING_ROOM_CHANNEL_ID が未設定です');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
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

// ミーティング部屋のリアクションを検知してGASへ転送
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    // ミーティング部屋以外のリアクションは無視（軽いフィルタ。ヒカル判定・募集判定はGAS側）
    if (!message.channel || message.channel.id !== MEETING_ROOM_CHANNEL_ID) return;

    // リアクションした人のギルド表示名を解決
    let reactorName = user.username;
    try {
      const member = await message.guild.members.fetch(user.id);
      reactorName = member.displayName;
    } catch (e) {
      console.log('メンバー表示名の取得に失敗（usernameを使用）:', String(e));
    }

    await forwardToGas_('reaction_signup', {
      messageId: message.id,
      messageAuthorId: message.author ? message.author.id : null,
      messageContent: message.content || '',
      channelId: message.channel.id,
      reactorId: user.id,
      reactorName: reactorName,
      emoji: reaction.emoji ? reaction.emoji.name : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('messageReactionAdd処理エラー:', err);
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

// ===== スレッド名の照合ユーティリティ =====
// 個別スレッドは「本名さん」で作られている。講座生の表示名は「ニックネーム（本名）」形式のことが多い。
// そのため 本名（括弧内）を最優先に、空白・末尾の「さん」を無視して照合する。

// 空白（半角/全角）と末尾の「さん」を除去して比較用に正規化
function normalizeName_(s) {
  return String(s).replace(/[\s　]/g, '').replace(/さん$/, '');
}

// 表示名から検索キーを優先順に生成： 本名（括弧内） → ニックネーム（括弧前） → 全体
function extractSearchKeys_(displayName) {
  const keys = [];
  const name = String(displayName || '');
  const m = name.match(/[（(]([^）)]+)[）)]/);
  if (m && m[1].trim()) keys.push(m[1].trim());           // 本名（括弧内）
  const before = name.split(/[（(]/)[0].trim();
  if (before) keys.push(before);                          // ニックネーム（括弧前）
  const whole = name.trim();
  if (whole) keys.push(whole);                            // 全体
  return keys;
}

// アクティブ＋アーカイブ済みの全スレッドを収集（アーカイブはページ送りで全走査）
async function collectAllThreads_(channel) {
  const all = [];
  const seen = new Set();
  const active = await channel.threads.fetchActive();
  active.threads.forEach((t) => { if (!seen.has(t.id)) { seen.add(t.id); all.push(t); } });

  let before;
  for (let i = 0; i < 20; i++) { // 安全上限20ページ（最大2000スレッド）
    const arch = await channel.threads.fetchArchived({ limit: 100, before });
    if (!arch.threads.size) break;
    let added = 0;
    let lastId;
    arch.threads.forEach((t) => {
      lastId = t.id;
      if (!seen.has(t.id)) { seen.add(t.id); all.push(t); added++; }
    });
    if (!arch.hasMore || added === 0) break;
    before = lastId;
  }
  return all;
}

async function findStudentThread_(studentName) {
  const channel = await client.channels.fetch(INSTA_COURSE_CHANNEL_ID);
  const threads = await collectAllThreads_(channel);
  const keys = extractSearchKeys_(studentName);

  let found = null;
  for (const key of keys) {
    const nk = normalizeName_(key);
    if (nk.length < 2) continue; // 短すぎるキーは誤一致するのでスキップ
    found = threads.find((t) => normalizeName_(t.name).includes(nk));
    if (found) {
      console.log('スレッド一致:', studentName, '→', found.name, '(キー:', key, ')');
      break;
    }
  }

  if (found) {
    try {
      await found.join();
      console.log('スレッド参加: 成功', found.name);
    } catch (e) {
      console.log('スレッド参加: 失敗 -', String(e));
    }
  } else {
    console.log('スレッドが見つかりませんでした:', studentName, '(候補キー:', keys.join(' / '), ')');
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
