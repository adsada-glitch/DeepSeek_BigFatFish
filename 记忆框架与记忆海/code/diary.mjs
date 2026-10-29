// 四层记忆的「日记」层：每天一页 markdown，按关键词检索。
//
// 为什么不用向量库（分享稿附三第 1 条）：记忆少于 100 条时全量注入更准；
// 日记页总量也远没到需要 ANN 检索的规模，关键字 substring 就够了，还省一个服务。
//
// 两个刻意的设计：
//   - **一天一页**，文件名就是日期。这样"翻日记"天然带时间轴，人读得懂，AI 也好定位。
//   - **检索只回命中行**，不回整页。整页回给模型很容易一次吃掉几千 token。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SEARCH_LIMIT = 20;
// 检索窗口：日记本身留 400 天，这里默认扫一年。
// 之前是 60 天——两个月前的日记"存着但搜不到"，等于悄悄失忆。
export const MAX_SEARCH_DAYS = 365;
export const MAX_LINE_CHARS = 200;

export function todayStr(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function diaryPath(dir, dateStr) {
  return path.join(dir, `${dateStr}.md`);
}

/** 追加一段。首次写入时自动建页头。 */
export function appendDiary(dir, dateStr, text, { now = Date.now() } = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'text 不能为空' };
  fs.mkdirSync(dir, { recursive: true });
  const file = diaryPath(dir, dateStr);
  const d = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const chunk = `${fs.existsSync(file) ? '' : `# ${dateStr} 日记\n\n`}### ${hhmm}\n${body}\n\n`;
  fs.appendFileSync(file, chunk, 'utf8');
  return { ok: true, file, date: dateStr };
}

export function readDiary(dir, dateStr) {
  try {
    return fs.readFileSync(diaryPath(dir, dateStr), 'utf8');
  } catch {
    return '';
  }
}

/** 最近的日记日期，新的在前。 */
export function listDiaryDates(dir, { maxDays = MAX_SEARCH_DAYS } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  } catch {
    return [];
  }
  return names
    .map((n) => n.slice(0, 10))
    .sort()
    .reverse()
    .slice(0, maxDays);
}

/**
 * 可检索的笔记前缀：除了按天的日记页，手工维护的人物卡/设定/承诺也能被 AI 翻到。
 * 这就是「Obsidian 里写的笔记真正变成 AI 记忆」的那一步 —— 没有它，你写的
 * `人物-某人.md` 只是给你自己看的。
 */
export const NOTE_PREFIXES = ['人物-', '设定-', '承诺'];

function isSearchable(name) {
  if (!name.endsWith('.md') || name.startsWith('.')) return false;
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) return true;
  return NOTE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 检索范围：日记页（新的在前）+ 白名单笔记（按文件名）。 */
export function listSearchable(dir, { maxDays = MAX_SEARCH_DAYS } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const dates = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .sort()
    .reverse()
    .slice(0, maxDays)
    .map((n) => ({ name: n, label: n.slice(0, 10) }));
  const notes = names
    .filter((n) => isSearchable(n) && !/^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .sort()
    .map((n) => ({ name: n, label: n.slice(0, -3) }));
  return [...dates, ...notes];
}

/**
 * 关键词检索：逐行匹配（不区分大小写；中文按子串）。
 * 返回 { file, date, line }[]，日记页在前、笔记在后，最多 limit 条。
 * `date` 对笔记来说是「文件名（去扩展名）」，保持与旧调用方兼容。
 */
export function searchDiary(dir, query, { limit = DEFAULT_SEARCH_LIMIT, maxDays = MAX_SEARCH_DAYS } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const needle = q.toLowerCase();
  const out = [];
  for (const { name, label } of listSearchable(dir, { maxDays })) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.toLowerCase().includes(needle)) {
        out.push({ file: name, date: label, line: line.slice(0, MAX_LINE_CHARS) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

// 关键词抽取的停用词：不求全，只求别把「什么/今天/就是」这种高频虚词顶上去。
const KEYWORD_STOP = new Set([
  '今天', '什么', '这个', '那个', '一个', '就是', '没有', '可以', '我们', '你们', '他们', '她们',
  '然后', '但是', '所以', '还是', '真的', '有点', '不是', '知道', '觉得', '现在', '时候', '自己',
  '东西', '哈哈', '表情', '图片', '不要', '怎么', '为什么', '这样', '那样', '一下', '已经', '因为',
  '如果', '而且', '还有', '感觉', '应该', '帮我', '是不是', '好像', '直接', '其实', '这里', '那里',
  '一直', '出来', '起来', '过来', '进去', '可能', '比较', '非常', '特别', '刚才', '晚上', '早上',
  '中午', '下午', '之后', '之前', '以后', '以前', '这种', '那种', '一样', '好吧', '行吧', '是吧',
  '啥', '嗯嗯', '哦哦', '啊啊', '我去', '我靠', '确实', '估计', '大概', '反正', '随便',
  // 下面这些是实测里最容易被顶上去的高频碎片（跑过真实一天的日记才加进来的）
  '后面', '前面', '上面', '下面', '里面', '外面', '中间', '旁边', '一起', '一定', '肯定',
  '马上', '一会', '一会儿', '大家', '别人', '问题', '意思', '事情', '时间', '时候',
  '这是', '那是', '我的', '你的', '他的', '她的', '这么', '那么', '多少', '几个'
]);

// 只要一个词里含有这些高频功能字，基本就不是"今天聊了什么"的主题词。
// 这一条比单纯堆停用词有效得多："不是/我这/就这/这不" 全部在这里被挡掉。
const FUNCTION_CHARS = /[的了着过吗呢吧啊呀嘛哦嗯么咋谁啥我你他她它们这那哪就都也很是不在有没和跟与或说想要会能可把被给让对从到还再又才只更最太真]/;

/**
 * 从当天的消息里抽关键词，写进日记页首。
 *
 * 为什么值得做：`qq_diary_search` 是**按行**匹配的，正文流水一行只有一个话题。
 * 页首这一行把当天所有人名和高频词集中在一起，一次查询就能同时命中多个词，
 * 召回率比只靠正文高得多。
 *
 * 抽词不装分词库（中文分词要带依赖），用的是：
 *   2~4 字滑窗 → 按"出现在多少条消息里"(df) 而不是出现次数排序 → 功能字过滤 → 停用词
 *   → 被更长的词覆盖就丢弃。
 * 用 df 而不是 tf 是关键：同一句话里重复三遍的碎片（"我我我"）不该被当成主题。
 */
export function extractKeywords(events, { max = 8 } = {}) {
  const df = new Map();   // 出现在多少条消息里
  const names = new Set();

  for (const event of events || []) {
    const who = String(event?.who || '').trim();
    if (who && who !== '你' && who !== '私聊' && who !== '某人' && who !== '群里') names.add(who);
    const text = String(event?.text || '').replace(/\[(图片|表情|语音|视频|文件|转发消息|动画表情)[^\]]*\]/g, ' ');
    const seen = new Set();
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_+#.-]{1,}/g)) {
      const word = match[0].toLowerCase();
      if (!KEYWORD_STOP.has(word)) seen.add(word);
    }
    for (const segment of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= segment.length; i++) {
          const term = segment.slice(i, i + n);
          if (KEYWORD_STOP.has(term) || FUNCTION_CHARS.test(term)) continue;
          seen.add(term);
        }
      }
    }
    for (const term of seen) df.set(term, (df.get(term) || 0) + 1);
  }

  const candidates = [...df.entries()]
    .filter(([term, count]) => {
      if (term.length === 2) return count >= 3;  // 两字词门槛高：碎片最多
      return count >= 2;
    })
    .map(([term, count]) => ({ term, count, score: count * Math.min(term.length, 4) }))
    .sort((a, b) => b.score - a.score || b.term.length - a.term.length);

  const picked = [...names].filter((n) => n.length >= 2).slice(0, 3);
  for (const { term } of candidates) {
    if (picked.some((p) => p.includes(term))) continue; // 已被更长的词覆盖
    picked.push(term);
    if (picked.length >= max) break;
  }
  return picked;
}

export function formatDiaryHits(hits) {
  if (!Array.isArray(hits) || !hits.length) return '';
  return hits.map((h) => `${h.date}｜${h.line}`).join('\n');
}

/** 当日日记还没写时草拟一页（供 daily.mjs 的 04:05 流程用）。 */
export function buildDiaryPage(dateStr, sections) {
  const parts = [`# ${dateStr} 日记`, ''];
  for (const [title, body] of sections) {
    if (!String(body || '').trim()) continue;
    parts.push(`## ${title}`, String(body).trim(), '');
  }
  return parts.join('\n');
}