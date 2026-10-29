// 把桥接程序的状态导出成「记忆海」认识的三段 JSON。
// 只读：不碰桥接的任何文件，只写 out。
//
// 用法：
//   node export-qq.mjs --root ./你的桥接目录            # 输出到 ../data/qq.json
//   node export-qq.mjs --root ./bridge --days 14 --max 600
//   node export-qq.mjs --root ./bridge --out data/qq.json
//
// 映射规则：
//   长期记忆 ← state/memory/memory-state.json（每条 fact 一个点；作废的不进海）
//   聊天记录 ← state/social-v2.json 的 recentMessages
//   日记     ← state/diary/YYYY-MM-DD.md（每篇一个点，全文放 full）
//
// 主题：THEMES 里的词命中就归到那个主题，簇名用 THEMES 的 label。
// 想加主题？在 THEMES 里加一行就行，不用改 memory-sea 的源码。

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROOT = path.resolve(argOf('root', process.cwd()));
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.resolve(argOf('out', path.join(HERE, '..', 'data', 'qq.json')));
const DAYS = Number(argOf('days', 30)) || 0;   // 0 = 不限
const MAX = Number(argOf('max', 800)) || 0;    // 0 = 不限
const MIN_CHARS = Number(argOf('minChars', 4)) || 0;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// ── 主题词典：这是肥鱼自己的世界 ──────────────────────────────────────────
// 顺序有讲究：越具体的放越前（同一句话命中多个主题时，先命中的赢）。
export const THEMES = Object.freeze([
  ['self', '她自己', ['肥鱼', '鲸鱼', '女仆', '呆毛', '小鲸鱼', '体重', '傻鱼', '可爱']],
  ['owner', '本人', ['主人', '带我', '答应']],
  ['sticker', '表情包', ['表情', '图片', '梗图', '贴纸', '斗图']],
  ['games', '打游戏', ['游戏', '上号', '方舟', '开黑', '这局', '联机', '打排', '抽卡']],
  ['food', '吃什么', ['吃', '干饭', '奶茶', '外卖', '饿', '夜宵', '火锅', '咖啡']],
  ['tech', '弄电脑', ['记忆', 'token', '桥接', '部署', '代码', '接口', '服务器', '脚本', '模型']],
  ['video', '刷视频', ['抖音', '视频', 'B站', 'b站', '刷到', '直播']],
  ['mood', '心情', ['累', '烦', '开心', '难过', '委屈', '生气', '想你', '心疼']],
  ['sleep', '作息', ['睡觉', '困', '熬夜', '晚安', '早睡', '起床', '失眠']],
  ['chat', '闲聊', ['回消息', '在吗', '消息', '回复', '说说', '群里']]
]);

export const TOPIC_LABELS = Object.freeze(Object.fromEntries(THEMES.map(([id, label]) => [id, label])));

function topicOf(text) {
  const s = String(text || '');
  for (const [id, , words] of THEMES) {
    for (const w of words) if (s.includes(w)) return id;
  }
  return 'misc';
}

/** 标签 → framework 的 kind（fact / event / promise / preference）。 */
function kindOf(tags) {
  const t = (Array.isArray(tags) ? tags.join('/') : '').toLowerCase();
  if (/约定|承诺/.test(t)) return 'promise';
  if (/偏好|作息/.test(t)) return 'preference';
  if (/梗|表情|群友/.test(t)) return 'event';
  return 'fact';
}

// ── 1. 长期记忆 ────────────────────────────────────────────────────────────
const memoryState = readJson(path.join(ROOT, 'state', 'memory', 'memory-state.json')) || {};
const longTerm = [];
for (const [key, sheet] of Object.entries(memoryState)) {
  for (const f of Array.isArray(sheet?.facts) ? sheet.facts : []) {
    if (!f || !String(f.text || '').trim()) continue;
    const alive = Number(f.confidence) !== 0;
    longTerm.push({
      id: String(f.id || `${key}-${longTerm.length}`),
      text: String(f.text).trim(),
      kind: kindOf(f.tags),
      topic: topicOf(f.text),
      confirmed: alive,
      active: alive,
      createdAt: Number(f.at) || 0,
      lastMentionAt: Number(f.touch) || Number(f.at) || 0,
      hits: Number(f.hits) || 0,
      source: key
    });
  }
}

// ── 2. 聊天记录 ────────────────────────────────────────────────────────────
const social = readJson(path.join(ROOT, 'state', 'social-v2.json')) || {};
const raw = [];
for (const [key, conv] of Object.entries(social.conversations || {})) {
  for (const m of Array.isArray(conv?.recentMessages) ? conv.recentMessages : []) {
    const text = String(m?.text || m?.plain || '').trim();
    if (!text) continue;
    // 纯 @ 或 @ 完只剩一两个字的，进海里就是一个孤零零的点，没有信息量
    const bare = text.replace(/@[^\s@]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (bare.length < Math.max(2, MIN_CHARS)) continue;
    raw.push({
      sender: String(m?.sender || (m?.isSelf ? 'her' : 'owner')),
      isOwner: !!m?.isOwner,
      isSelf: !!m?.isSelf,
      text,
      at: Number(m?.time) || 0,
      topic: topicOf(text),
      source: key
    });
  }
}

const newest = raw.reduce((mx, m) => Math.max(mx, m.at), 0);
const since = DAYS > 0 && newest > 0 ? newest - DAYS * 86400000 : 0;
let messages = raw.filter((m) => !since || m.at >= since).sort((a, b) => a.at - b.at);
if (MAX > 0 && messages.length > MAX) messages = messages.slice(-MAX);

// ── 3. 日记 ────────────────────────────────────────────────────────────────
const diaryDir = path.join(ROOT, 'state', 'diary');
const diaries = [];
try {
  for (const name of fs.readdirSync(diaryDir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const body = fs.readFileSync(path.join(diaryDir, name), 'utf8');
    const date = name.slice(0, 10);
    if (!body.trim()) continue;
    if (since && (Date.parse(`${date}T23:00:00+08:00`) || 0) < since) continue;
    // 日记是 markdown（生成标记、标题、列表），压成一行可读文本，全文放 full
    const clean = body
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^[-*]\s*/gm, '')
      .replace(/\n{2,}/g, ' ｜ ')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    diaries.push({
      date,
      text: clean.slice(0, 400),
      full: clean,
      createdAt: Date.parse(`${date}T23:00:00+08:00`) || 0
    });
  }
} catch {}

const payload = {
  generatedAt: new Date().toISOString(),
  source: ROOT,
  window: { days: DAYS, since: since || null, max: MAX, minChars: MIN_CHARS },
  topicLabels: TOPIC_LABELS,
  longTerm,
  messages,
  diaries
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');

const alive = longTerm.filter((e) => e.active).length;
console.log(`[export] ${OUT}`);
console.log(`[export] 长期记忆 ${longTerm.length}（活跃 ${alive}）· 消息 ${messages.length}/${raw.length} · 日记 ${diaries.length}`);
if (DAYS) console.log(`[export] 只取最近 ${DAYS} 天；最短 ${MIN_CHARS} 字；上限 ${MAX || '不限'}`);