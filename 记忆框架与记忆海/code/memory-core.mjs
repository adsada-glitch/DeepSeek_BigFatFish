// memory-core.mjs — 独立记忆库（零依赖，只用 node 内置）
// 用法见文末的 createMemory() 注释。状态存在 memory-state.json，日记存在 diary/ 下。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULTS = {
  injectLimit: 80,
  sinkThreshold: 1.0,
  sinkPerDay: 3,
  archiveThreshold: 120,
  archiveBatch: 20,
  decayMode: "linear",       // linear = 每天固定掉分；ebbinghaus = 指数衰减
  decayNormal: 0.1,
  decayLowConfidence: 0.16,
  stabilityBase: 3,           // 艾宾浩斯模式下：基础记忆强度（天）
  stabilityGrowth: 1.6,       // 每复习一次，强度乘这个数
  reinforce: 0.5,
  maxWeight: 6.0,
  confidenceDiscountLow: 0.45,
  confidenceDiscountMid: 0.7,
  similarThreshold: 0.62,
  backupKeepDays: 7,
  snapshotKeep: 10,
  startDate: "",  // 认识的第一天（YYYY-MM-DD），留空则不显示天数
  recapKeep: 2,
  diarySearchLimit: 5,
};

function log(msg) {
  try {
    if (process.env.MEMORY_CORE_DEBUG !== "0") console.error(`[memory-core] ${msg}`);
  } catch {}
}

function dayKey(ms = Date.now(), tz = "Asia/Shanghai") {
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: tz });
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

// ── 打分 ────────────────────────────────────────────────────────────────
export function factBaseWeight(f, cfg = DEFAULTS) {
  const tags = Array.isArray(f?.tags) ? f.tags.join("/") : "";
  let w;
  if (/约定|承诺|情绪|身份|边界/.test(tags)) w = 3.0;
  else if (/用户偏好|偏好|作息/.test(tags)) w = 2.5;
  else if (/梗|表情|群友/.test(tags)) w = 1.6;
  else if (/钱|余额|操作|教训|功能/.test(tags)) w = 1.3;
  else w = 1.8;
  const conf = factConfidence(f);
  if (conf < 0.5) w *= cfg.confidenceDiscountLow;
  else if (conf < 0.75) w *= cfg.confidenceDiscountMid;
  return w;
}

export function factConfidence(f) {
  const c = Number(f?.confidence);
  if (Number.isFinite(c)) return Math.max(0, Math.min(1, c));
  const src = String(f?.source ?? "");
  if (src === "owner") return 1.0;
  if (src === "inferred") return 0.6;
  if (src === "other") return 0.45;
  if (/用户(说|定|让|要|同意|答应|告诉)/.test(String(f?.text ?? ""))) return 0.95;
  return 0.8;
}

export function factWeightOf(f, now = Date.now(), cfg = DEFAULTS) {
  if (Number(f?.confidence) === 0) return -99; // 作废
  if (Number(f?.validUntil) && Number(f.validUntil) < now) return -99; // 过期
  const base = Number.isFinite(Number(f?.w)) ? Number(f.w) : factBaseWeight(f, cfg);
  const touched = Number(f?.touch) || Number(f?.at) || now;
  const days = Math.max(0, (now - touched) / 86400000);
  if (cfg.decayMode === "ebbinghaus") {
    // 艾宾浩斯：记忆强度随复习次数增长，遗忘是指数的
    // R = exp(-t / S)，S = stabilityBase * growth^hits
    const hits = Math.max(0, Number(f?.hits) || 0);
    const stability = cfg.stabilityBase * Math.pow(cfg.stabilityGrowth, hits);
    const conf = factConfidence(f) < 0.75 ? 0.7 : 1;
    return base * Math.exp(-days / Math.max(0.5, stability)) * conf;
  }
  const rawDecay = factConfidence(f) < 0.75 ? cfg.decayLowConfidence : cfg.decayNormal;
  const hits = Math.max(0, Number(f?.hits) || 0);
  const decay = Math.max(0.02, rawDecay / (1 + hits * 0.3)); // 越常想起，掉得越慢
  return base - decay * days;
}

// ── 主对象 ──────────────────────────────────────────────────────────────
export function createMemory(opts = {}) {
  const dir = path.resolve(opts.dir ?? "./memory");
  const cfg = { ...DEFAULTS, ...(opts.config ?? {}) };
  const tz = opts.timeZone ?? "Asia/Shanghai";
  const stateFile = path.join(dir, "memory-state.json");
  const archiveFile = path.join(dir, "facts-archive.json");
  const diaryDir = path.join(dir, "diary");
  const taskFile = path.join(dir, "task-state.json");
  fs.mkdirSync(diaryDir, { recursive: true });

  const readJson = (f, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return fallback;
    }
  };
  const writeJson = (f, v) => atomicWrite(f, JSON.stringify(v, null, 2));
  const readTaskState = () => readJson(taskFile, {});
  const writeTaskState = (v) => writeJson(taskFile, v);
  const readArchive = () => {
    const a = readJson(archiveFile, []);
    return Array.isArray(a) ? a : [];
  };

  // 内存态：key -> { facts: [], moodLog: [] }
  const store = readJson(stateFile, {});
  const keyState = (key) => {
    if (!store[key] || typeof store[key] !== "object") store[key] = { facts: [], moodLog: [] };
    if (!Array.isArray(store[key].facts)) store[key].facts = [];
    if (!Array.isArray(store[key].moodLog)) store[key].moodLog = [];
    return store[key];
  };
  const save = () => writeJson(stateFile, store);

  // ── 事实 ──
  function ensureWeights(facts) {
    const now = Date.now();
    for (const f of facts) {
      if (!f || typeof f !== "object") continue;
      if (!Number.isFinite(Number(f.w))) f.w = factBaseWeight(f, cfg);
      if (!Number(f.touch)) f.touch = Number(f.at) || now;
      if (!Number.isFinite(Number(f.confidence))) f.confidence = factConfidence(f);
    }
  }

  function saveFact(key, input) {
    const st = keyState(key);
    ensureWeights(st.facts);
    const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) return { ok: false, error: "text 不能为空" };
    if (text.length > 120) return { ok: false, error: "一条记忆最多 120 字，请拆成多条" };
    const tags = Array.isArray(input.tags) ? input.tags.map(String).slice(0, 5) : [];
    const looksOwner = /(^|用)户(说|定|让|要|同意|答应|告诉)/.test(text) || input.source === "owner";
    const source = input.source ?? (looksOwner ? "owner" : "inferred");
    const confidence = Number.isFinite(Number(input.confidence))
      ? Number(input.confidence)
      : source === "owner"
        ? 1.0
        : 0.65;

    // 相似判定：不完全一样但说的是同一件事 → 强化旧条目，不新增
    const grams = (s) => {
      const clean = String(s).replace(/[\s，。；、！？：""''（）()【】\[\]]/g, "");
      const g = new Set();
      for (let i = 0; i < clean.length - 1; i++) g.add(clean.slice(i, i + 2));
      return g;
    };
    const simOf = (a, b) => {
      const A = grams(a), B = grams(b);
      if (!A.size || !B.size) return 0;
      let hit = 0;
      for (const x of A) if (B.has(x)) hit++;
      return hit / Math.max(A.size, B.size);
    };
    let near = null;
    let nearScore = 0;
    for (const f0 of st.facts) {
      const s0 = simOf(text, String(f0.text ?? ""));
      if (s0 > nearScore) { nearScore = s0; near = f0; }
    }
    // 数字不同就别合并（「琐事 10」和「琐事 11」、「抽玉溪」和「抽中华」这类不是同一件事）
    const numsOf = (s) => (String(s).match(/\d+/g) || []).join(",");
    const numsDiffer = near && numsOf(text) !== numsOf(String(near.text ?? ""));
    if (near && !numsDiffer && nearScore >= (cfg.similarThreshold ?? 0.62)) {
      near.touch = Date.now();
      near.hits = (Number(near.hits) || 0) + 1;
      near.w = Math.min(cfg.maxWeight, (Number(near.w) || factBaseWeight(near, cfg)) + cfg.reinforce);
      save();
      return { ok: true, id: near.id, reinforced: true, score: Number(nearScore.toFixed(2)), total: st.facts.length };
    }
    const dup = st.facts.find((f) => String(f.text ?? "").toLowerCase() === text.toLowerCase());
    if (dup) {
      dup.touch = Date.now();
      dup.hits = (Number(dup.hits) || 0) + 1; // 艾宾浩斯用：复习次数
      dup.w = Math.min(cfg.maxWeight, (Number(dup.w) || factBaseWeight(dup, cfg)) + cfg.reinforce);
      save();
      return { ok: true, id: dup.id, reinforced: true, total: st.facts.length };
    }

    const fact = {
      id: `m${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`,
      text,
      tags,
      at: Date.now(),
      touch: Date.now(),
      hits: 0,
      w: factBaseWeight({ tags, confidence }, cfg),
      confidence,
      source,
      scope: input.scope ?? "private",
      role: input.role ?? "default",
      validUntil: Number(input.validUntil) || 0,
    };
    st.facts.push(fact);
    save();
    return { ok: true, id: fact.id, total: st.facts.length };
  }

  function invalidateFact(key, { id, text }) {
    const st = keyState(key);
    const q = String(text ?? "").trim();
    // 优先精确匹配；否则取「最短且包含」的那条，避免误伤更长的相似条目
    let hit = id ? st.facts.find((f) => String(f.id) === String(id)) : null;
    if (!hit && q) hit = st.facts.find((f) => String(f.text ?? "") === q);
    if (!hit && q) {
      const cands = st.facts.filter((f) => String(f.text ?? "").includes(q));
      cands.sort((a, b) => String(a.text).length - String(b.text).length);
      hit = cands[0] || null;
    }
    if (!hit) return { ok: false, error: "没找到这条记忆" };
    hit.confidence = 0;
    hit.w = 0;
    hit.invalidatedAt = Date.now();
    save();
    return { ok: true, invalidated: hit.text };
  }

  function listActive(key, limit = cfg.injectLimit) {
    const st = keyState(key);
    ensureWeights(st.facts);
    return [...st.facts]
      .map((f) => ({ f, w: factWeightOf(f, Date.now(), cfg) }))
      .filter((x) => x.w > 0)
      .sort((a, b) => b.w - a.w)
      .slice(0, limit)
      .map((x) => x.f);
  }

  function decayAndArchive(key, maxSink = cfg.sinkPerDay) {
    const st = keyState(key);
    ensureWeights(st.facts);
    const now = Date.now();
    const scored = st.facts.map((f) => ({ f, w: factWeightOf(f, now, cfg) })).sort((a, b) => b.w - a.w);
    const weak = scored.filter((x) => x.w < cfg.sinkThreshold).slice(-maxSink);
    if (!weak.length) return { archived: 0, left: st.facts.length };
    const set = new Set(weak.map((x) => x.f));
    const archive = readArchive();
    for (const { f, w } of weak) {
      archive.push({
        text: f.text,
        tags: f.tags ?? [],
        scope: f.scope ?? "",
        at: f.at ?? now,
        w,
        reason: "decay",
        archivedAt: now,
      });
    }
    st.facts = st.facts.filter((f) => !set.has(f));
    writeJson(archiveFile, archive.slice(-500));
    save();
    return { archived: weak.length, left: st.facts.length };
  }

  function archiveBulk(key, keepMax = cfg.archiveThreshold, batch = cfg.archiveBatch) {
    const st = keyState(key);
    const overflow = st.facts.length - keepMax;
    if (overflow <= 0) return { archived: 0, left: st.facts.length };
    ensureWeights(st.facts);
    const now = Date.now();
    const count = Math.min(st.facts.length - 1, Math.max(batch, overflow));
    const ranked = st.facts.map((f) => ({ f, w: factWeightOf(f, now, cfg) })).sort((a, b) => a.w - b.w);
    const victims = ranked.slice(0, count).map((x) => x.f);
    const set = new Set(victims);
    const archive = readArchive();
    for (const f of victims) {
      archive.push({
        text: f.text,
        tags: f.tags ?? [],
        scope: f.scope ?? "",
        at: f.at ?? now,
        w: factWeightOf(f, now, cfg),
        reason: "capacity",
        archivedAt: now,
      });
    }
    st.facts = st.facts.filter((f) => !set.has(f));
    writeJson(archiveFile, archive.slice(-500));
    save();
    return { archived: victims.length, left: st.facts.length };
  }

  // ── 情绪 ──
  function recordMood(key, text) {
    if (cfg.emotion === false) return { recorded: false };
    const t = String(text ?? "");
    if (!t) return { recorded: false };
    const moods = [];
    if (/不开心|不高兴|不太开心|不太高兴|心情不好|不太舒服|难受|不爽/.test(t)) moods.push("烦");
    const hit = (re) => {
      const m = t.match(re);
      if (!m) return false;
      const idx = typeof m.index === "number" ? m.index : 0;
      const before = t.slice(Math.max(0, idx - 4), idx);
      if (/不|没|别|并非|哪有/.test(before)) return false;
      const after = t.slice(idx + m[0].length, idx + m[0].length + 3);
      if (/不起来|不下去|不到哪去/.test(after)) return false;
      return true;
    };
    if (hit(/累|疲惫|撑不住|好困|加班|熬夜|失眠/)) moods.push("累");
    if (hit(/烦|压力|焦虑|难受|崩|emo|不爽/)) moods.push("烦");
    if (hit(/开心|高兴|爽|舒服|好耶|哈哈|幸福/)) moods.push("开心");
    if (hit(/生气|气死|火大|讨厌|恶心/)) moods.push("生气");
    if (hit(/想你了|想你|陪我|晚安|抱抱/)) moods.push("亲近");
    const uniq = [...new Set(moods)];
    if (!uniq.length) return { recorded: false };
    const st = keyState(key);
    st.moodLog.push({ at: Date.now(), date: dayKey(Date.now(), tz), mood: uniq.join("/"), note: t.slice(0, 40) });
    if (st.moodLog.length > 20) st.moodLog = st.moodLog.slice(-20);
    save();
    return { recorded: true, mood: uniq.join("/") };
  }

  function buildMoodBlock(key, days = 3) {
    if (cfg.emotion === false) return "";
    const st = keyState(key);
    const now = Date.now();
    const recent = st.moodLog.filter((m) => now - Number(m.at || 0) < days * 86400000);
    if (!recent.length) return "";
    const lines = ["【他最近的状态】（你自己留意到的，别每次都说出来）"];
    for (const m of recent.slice(-4)) {
      const ago = Math.max(0, Math.round((now - Number(m.at || now)) / 3600000));
      lines.push(`- ${ago} 小时前：${m.mood}（${String(m.note || "").slice(0, 20)}）`);
    }
    lines.push("如果上次他很累/很烦，今天可以顺口关心一句，别硬问、别追问。");
    lines.push("");
    return lines.join("\n");
  }

  // ── 注入块 ──
  function buildMemoryBlock(key) {
    const st = keyState(key);
    const facts = listActive(key);
    const head = [];
    if (cfg.startDate) {
      const start = Date.parse(cfg.startDate + "T00:00:00+08:00");
      if (Number.isFinite(start)) {
        const day = Math.floor((Date.now() - start) / 86400000) + 1;
        head.push(`【关系】今天是认识的第 ${day} 天（${cfg.startDate} 开始）`);
      }
    }
    if (!facts.length) return head.length ? head.join("\n") + "\n" : "";
    const lines = [...head, "【长期记忆】（你以前记下的，别每次重问）"];
    for (const f of facts) {
      const days = f.at ? Math.floor((Date.now() - Number(f.at)) / 86400000) : 0;
      const tagText = Array.isArray(f.tags) && f.tags.length ? `（${f.tags.join("/")}）` : "";
      lines.push(`- ${f.text}${tagText}${days > 0 ? `（${days}天前）` : ""}`);
    }
    return lines.join("\n") + "\n";
  }

  // ── 日记 ──
  function safeKey(key) {
    return String(key).replace(/[^a-zA-Z0-9]/g, "_");
  }

  function writeDiary(key, messages = []) {
    const st = keyState(key);
    const dk = dayKey(Date.now(), tz);
    const start = new Date(`${dk}T00:00:00+08:00`).getTime();
    const msgs = (Array.isArray(messages) ? messages : []).filter((m) => Number(m?.time || 0) >= start);
    const facts = st.facts.filter((f) => Number(f.at || 0) >= start);
    const lines = [`# ${dk} · ${key}`, ""];
    if (msgs.length) {
      lines.push("## 这天说过的话");
      for (const m of msgs.slice(-60)) {
        const who = m.isSelf ? "我" : m.sender || "对方";
        const t = new Date(Number(m.time || Date.now())).toLocaleTimeString("zh-CN", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
        });
        lines.push(`- [${t}] ${who}：${String(m.text || "").slice(0, 120)}`);
      }
      lines.push("");
    }
    if (facts.length) {
      lines.push("## 这天记下的事");
      for (const f of facts) lines.push(`- ${String(f.text).slice(0, 160)}`);
      lines.push("");
    }
    if (msgs.length || facts.length) {
      atomicWrite(path.join(diaryDir, `${safeKey(key)}-${dk}.md`), lines.join("\n"));
      return { ok: true, file: `${safeKey(key)}-${dk}.md` };
    }
    return { ok: false, reason: "今天没有内容" };
  }

  function searchDiary(key, q, limit = cfg.diarySearchLimit) {
    const files = fs.readdirSync(diaryDir).filter((x) => x.endsWith(".md"));
    const prefix = key ? safeKey(key) + "-" : "";
    const terms = String(q ?? "")
      .split(/[\s,，、]+/)
      .filter(Boolean);
    const hits = [];
    for (const f of files.sort().reverse()) {
      if (prefix && !f.startsWith(prefix)) continue;
      const body = fs.readFileSync(path.join(diaryDir, f), "utf8");
      const date = f.replace(/^.*-(\d{4}-\d{2}-\d{2})\.md$/, "$1");
      if (!terms.length) {
        hits.push({ date, text: body.slice(0, 400) });
      } else {
        const all = body.split("\n");
        const picked = [];
        for (let i = 0; i < all.length && picked.length < 8; i++) {
          if (terms.some((t) => all[i].includes(t))) {
            if (i > 0 && !picked.includes(all[i - 1])) picked.push(all[i - 1]);
            picked.push(all[i]);
          }
        }
        if (picked.length) hits.push({ date, text: picked.slice(0, 8).join("\n").slice(0, 800) });
      }
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ── 快照：压缩前存一份，留 N 份 ──
  function snapshot(tag = "manual") {
    const dirS = path.join(dir, "snapshots");
    fs.mkdirSync(dirS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, path.join(dirS, `${stamp}-${tag}.json`));
    } catch {}
    const keep = Math.max(1, Number(cfg.snapshotKeep) || 10);
    const files = fs.readdirSync(dirS).filter((x) => x.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.unlinkSync(path.join(dirS, f)); } catch {}
    }
    return { tag, kept: Math.min(files.length, keep) };
  }

  // ── 备份：每天一份，留 N 天 ──
  function backupNow() {
    const dirB = path.join(dir, "backups");
    fs.mkdirSync(dirB, { recursive: true });
    const dk = dayKey(Date.now(), tz);
    const dest = path.join(dirB, `memory-state-${dk}.json`);
    if (fs.existsSync(stateFile)) {
      fs.copyFileSync(stateFile, dest);
      try { fs.copyFileSync(archiveFile, path.join(dirB, `facts-archive-${dk}.json`)); } catch {}
    }
    // 清理过期备份
    const keep = Math.max(1, Number(cfg.backupKeepDays) || 7);
    const files = fs.readdirSync(dirB).filter((x) => x.endsWith(".json")).sort();
    const days = [...new Set(files.map((x) => x.replace(/^.*-(\d{4}-\d{2}-\d{2})\.json$/, "$1")))].sort();
    const drop = days.slice(0, Math.max(0, days.length - keep));
    let removed = 0;
    for (const f of files) {
      if (drop.some((d) => f.includes(d))) { try { fs.unlinkSync(path.join(dirB, f)); removed++; } catch {} }
    }
    return { file: path.basename(dest), days: days.length, removed };
  }

  // ── 每日任务（幂等，标记落盘）──
  function runDaily(key, now = new Date()) {
    const mins = now.getHours() * 60 + now.getMinutes();
    const dk = dayKey(now.getTime(), tz);
    const ts = readTaskState();
    const done = ts[dk] ?? {};
    const changed = [];
    const at = (hhmm) => {
      const [h, m] = String(hhmm).split(":").map(Number);
      return h * 60 + (m || 0);
    };

    if (!done.backup) {
      const bk = backupNow();
      done.backup = true;
      changed.push(`backup(${bk.file},keep=${cfg.backupKeepDays ?? 7})`);
    }
    if (!done.compress && mins >= at(cfg.compressAt ?? "04:20")) {
      snapshot("before-compress");
      const dec = decayAndArchive(key);
      const bulk = archiveBulk(key);
      done.compress = true;
      changed.push(`compress(decay=${dec.archived},bulk=${bulk.archived})`);
    }
    ts[dk] = done;
    writeTaskState(ts);
    if (changed.length) log(`${key} ${dk}: ${changed.join(" ")}`);
    return { day: dk, done, changed };
  }

  return {
    dir,
    keyState,
    saveFact,
    invalidateFact,
    listActive,
    decayAndArchive,
    archiveBulk,
    recordMood,
    buildMoodBlock,
    buildMemoryBlock,
    writeDiary,
    searchDiary,
    backupNow,
    snapshot,
    runDaily,
    stats(key) {
      const st = keyState(key);
      return { facts: st.facts.length, mood: st.moodLog.length, active: listActive(key).length };
    },
  };
}