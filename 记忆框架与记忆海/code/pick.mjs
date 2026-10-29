// 唤醒注入的「按对话检索」层：从 memory-sea 的 memory-retrieve 借来的打分器。
//
// 为什么要有它：之前是把权重最高的 80 条一股脑注入（跟这轮聊什么无关）。
// 库到几百条后，"最近闲聊"会把老底账挤掉。这里改成按当前对话挑 6~10 条。
//
// 三个约定（改之前先想清楚）：
//  1) 库很小（<= fallbackBelow 条）时根本不检索，直接按权重——小库全量更准；
//  2) 检索结果太少（< minPick）时用权重兜底，避免"这一轮她什么都没带"；
//  3) 这里全是纯函数，桥接只负责传数据和渲染文本，方便单测。

import { selectRelevant } from './sea/memory-retrieve.js';

export const DEFAULT_OPTIONS = Object.freeze({
  maxInject: 8,        // 最多注入几条
  budgetChars: 600,    // 记忆段总字数预算（约 600 字 ≈ 400 token）
  minPick: 3,          // 少于这个条数就回退到权重方案
  fallbackBelow: 12,   // 库小于这个数就直接按权重全给
  queryChars: 240,     // 取最近消息拼 query 时最多用多少字
  coreTopics: ['profile', 'owner-profile']
});

/** memory-core 的事实 → memory-sea 的条目（字段名不同，语义要对齐）。 */
export function factsToEntries(facts) {
  const list = Array.isArray(facts) ? facts : [];
  return list
    .filter((f) => f && String(f.text || '').trim())
    .map((f) => ({
      id: String(f.id || f.text),
      text: String(f.text).trim(),
      // entryState 只认 confirmed === true；memory-core 用 confidence === 0 表示作废
      confirmed: Number(f.confidence) !== 0,
      active: Number(f.confidence) !== 0,
      kind: kindOf(f.tags),
      topic: String(f.topic || ''),
      createdAt: Number(f.at) || 0,
      lastMentionAt: Number(f.touch) || Number(f.at) || 0,
      hits: Number(f.hits) || 0
    }));
}

function kindOf(tags) {
  const t = (Array.isArray(tags) ? tags.join('/') : '').toLowerCase();
  if (/约定|承诺/.test(t)) return 'promise';
  if (/偏好|作息/.test(t)) return 'preference';
  return 'fact';
}

/** 从最近的消息里拼出检索用的 query（只取最近几条，太长反而稀释关键词）。 */
export function buildQuery(recentMessages, { maxChars = DEFAULT_OPTIONS.queryChars } = {}) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const parts = [];
  for (const m of list.slice(-6)) {
    const text = String(m?.text || m?.plain || '').replace(/\[[^\]]*\]/g, ' ').trim();
    if (text) parts.push(text);
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/**
 * 挑这一轮要注入的记忆。
 * @returns {{ picked: object[], mode: 'query'|'fallback', reason: string }}
 */
export function pickForPrompt(facts, { queryText = '', now = Date.now(), cfg = {} } = {}) {
  const options = { ...DEFAULT_OPTIONS, ...cfg };
  const list = Array.isArray(facts) ? facts : [];
  const active = list.filter((f) => Number(f.confidence) !== 0);

  // 开关：config.memory.retrieval = "weight" 时退回旧行为（按权重全给），方便 A/B 或回滚
  if (options.mode === 'weight') {
    return { picked: [], mode: 'fallback', reason: '已配置为按权重注入' };
  }

  if (active.length <= options.fallbackBelow) {
    return { picked: [], mode: 'fallback', reason: `库只有 ${active.length} 条（≤${options.fallbackBelow}），按权重全给` };
  }

  const entries = factsToEntries(list);
  const result = selectRelevant(entries, {
    queryText,
    now,
    cfg: {},
    maxInject: options.maxInject,
    budgetChars: options.budgetChars,
    coreTopics: options.coreTopics,
    fillMin: 4,
    fillMax: 6
  });

  const picked = (result.selected || [])
    .map((s) => entries.find((e) => String(e.id) === String(s.id)))
    .filter(Boolean);
  if (picked.length < options.minPick) {
    return { picked: [], mode: 'fallback', reason: `只检索到 ${picked.length} 条，回退按权重` };
  }
  return { picked, mode: 'query', reason: `检索 ${picked.length} 条 / 候选 ${result.eligible} 条` };
}

/** 渲染成提示词段（格式跟 memory-core 的 buildMemoryBlock 保持一致，方便对比）。 */
export function renderPickedBlock(picked, { now = Date.now(), title = '【长期记忆】（按当前话题挑的，不是全部）' } = {}) {
  const list = Array.isArray(picked) ? picked : [];
  if (!list.length) return '';
  const lines = [title];
  for (const e of list) {
    const days = e.createdAt ? Math.floor((now - Number(e.createdAt)) / 86400000) : 0;
    const tag = e.kind === 'promise' ? '（约定）' : e.kind === 'preference' ? '（偏好）' : '';
    lines.push(`- ${String(e.text).slice(0, 120)}${tag}${days > 0 ? `（${days}天前）` : ''}`);
  }
  return lines.join('\n') + '\n';
}