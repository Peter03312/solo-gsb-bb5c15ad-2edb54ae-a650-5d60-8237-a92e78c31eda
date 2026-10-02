'use strict';
// 字幕排片引擎（纯函数，不读写数据库）
//
// 保证：
//  - 排出的字幕按原词序覆盖全部“未锁定”转写词；
//  - 字幕之间不重叠；
//  - 不跨越镜头切点（切点落在词内部属于无法满足的结构冲突）；
//  - 不缩短词本身的时段（字幕起始=首词起点，结束>=末词终点）；
//  - 每条满足 最大字数 / 最短显示时长 / 每秒最多字数；
//  - 任一规则无法满足时返回 conflicts，不返回部分/貌似完整的结果。

function ceilMs(msFloat) {
  return Math.ceil(msFloat - 1e-9);
}

// ---------- 导入校验 ----------
function validateTranscript(wordsRaw, cutsRaw) {
  const errors = [];
  if (!Array.isArray(wordsRaw) || wordsRaw.length === 0) {
    return { errors: ['words 必须是非空数组'] };
  }
  const words = [];
  wordsRaw.forEach((w, i) => {
    const s = Number(w && w.start_ms);
    const e = Number(w && w.end_ms);
    const t = w && w.text;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e <= s) {
      errors.push(`第 ${i + 1} 个词时间无效（需要 0 <= start_ms < end_ms 的整数毫秒）`);
      return;
    }
    if (typeof t !== 'string' || t.trim() === '') {
      errors.push(`第 ${i + 1} 个词 text 为空`);
      return;
    }
    if (words.length && s < words[words.length - 1].end_ms) {
      errors.push(
        `第 ${i + 1} 个词起点(${s})早于前一词终点(${words[words.length - 1].end_ms})：倒序或重叠词段`
      );
      return;
    }
    words.push({ start_ms: s, end_ms: e, text: t.trim(), seq: i + 1 });
  });

  const cuts = [];
  if (cutsRaw != null) {
    if (!Array.isArray(cutsRaw)) errors.push('cuts 必须是数组');
    else {
      cutsRaw.forEach((c, i) => {
        const v = Number(c);
        if (!Number.isInteger(v) || v < 0) {
          errors.push(`第 ${i + 1} 个切点无效（需 >=0 的整数毫秒）`);
          return;
        }
        if (cuts.length && v <= cuts[cuts.length - 1]) {
          errors.push(`第 ${i + 1} 个切点(${v})不大于前一个切点：切点必须严格递增且唯一`);
          return;
        }
        cuts.push(v);
      });
    }
  }
  return { errors: [...new Set(errors)], words, cuts };
}

// ---------- 工具 ----------
function joinText(words, a, b) {
  return words.slice(a, b + 1).map((w) => w.text).join(' ');
}

function segLength(words, a, b) {
  let n = 0;
  for (let k = a; k <= b; k++) n += words[k].text.length + (k === a ? 0 : 1);
  return n;
}

// 切点 c 是否严格落在词 w 内部
function cutInsideWord(w, c) {
  return c > w.start_ms && c < w.end_ms;
}

// 词 a..b 作为一条字幕时，结束时间最多能延伸到哪（不能越过下一词/锁定字幕/切点）
function rightCap(words, a, b, blockEnd, cutAfterBlock, lockStartByNextSeq) {
  if (b < blockEnd) {
    // 同块内下一词紧跟其后，最多延伸到下一词起点（绝不重叠）
    return words[b + 1].start_ms;
  }
  if (cutAfterBlock != null) return cutAfterBlock; // 块尾是切点：不得跨切点
  const next = words[b + 1];
  if (next) {
    const lockStart = lockStartByNextSeq.get(next.seq);
    return lockStart != null ? Math.min(next.start_ms, lockStart) : next.start_ms;
  }
  return Infinity; // 最后一个词，后方无约束
}

// 单段可行性：字数、最短时长、CPS
function feasible(words, a, b, cap, st) {
  const len = segLength(words, a, b);
  if (len > st.max_chars) return null;
  const start = words[a].start_ms;
  const natural = words[b].end_ms - start;
  const needCps = ceilMs((len * 1000) / st.max_cps);
  const needed = Math.max(natural, st.min_display_ms, needCps);
  const avail = cap === Infinity ? Infinity : cap - start;
  if (avail < needed) {
    return {
      ok: false,
      len,
      start,
      natural,
      needed,
      avail,
      needMin: st.min_display_ms,
      needCps,
    };
  }
  return { ok: true, len, start, natural, needed, avail, needMin: st.min_display_ms, needCps };
}

// ---------- 主入口 ----------
// words: 已按 seq 升序、带 seq 字段（seq 从 1 开始，连续）
// cuts: 升序毫秒数组
// lockedCues: [{start_ms,end_ms,word_start_seq,word_end_seq}]
// settings: {max_chars,min_display_ms,max_cps}
function arrange(words, cuts, lockedCues, settings) {
  const st = {
    max_chars: Number(settings.max_chars),
    min_display_ms: Number(settings.min_display_ms),
    max_cps: Number(settings.max_cps),
  };
  const conflicts = [];

  // 1. 锁定区间校验与覆盖集合
  const locks = [...lockedCues].sort((x, y) => x.word_start_seq - y.word_start_seq);
  const covered = new Set();
  let prevEnd = 0;
  for (const lk of locks) {
    const ws = lk.word_start_seq, we = lk.word_end_seq;
    if (!ws || !we || ws < 1 || we > words.length || ws > we) {
      return { conflicts: [{ type: 'BAD_LOCK', details: `锁定字幕词范围无效: ${ws}-${we}` }] };
    }
    if (ws <= prevEnd) {
      return { conflicts: [{ type: 'BAD_LOCK', details: `锁定字幕词范围重叠: ${ws}-${we}` }] };
    }
    for (let s = ws; s <= we; s++) covered.add(s);
    prevEnd = we;
  }

  // 1b. 锁定字幕自身的时间合法性：起始=首词起点、结束>=末词终点（不缩短词时段）
  for (const lk of locks) {
    const first = words[lk.word_start_seq - 1];
    const last = words[lk.word_end_seq - 1];
    if (lk.start_ms !== first.start_ms || lk.end_ms < last.end_ms) {
      conflicts.push({
        type: 'BAD_LOCK',
        lock_id: lk.id,
        word_start_seq: lk.word_start_seq,
        word_end_seq: lk.word_end_seq,
        details: `锁定字幕「${lk.text || joinText(words, lk.word_start_seq - 1, lk.word_end_seq - 1)}」时段 [${lk.start_ms}, ${lk.end_ms}] 缩短/错位了词时段（词要求起始 ${first.start_ms}、至少到 ${last.end_ms}），请解锁修订后再排片`,
      });
    }
  }

  // 锁定字幕之间不得时间重叠；锁定字幕也不得跨镜头切点（结构性硬约束）
  for (let i = 1; i < locks.length; i++) {
    const a = locks[i - 1], b = locks[i];
    if (b.start_ms < a.end_ms && b.end_ms > a.start_ms) {
      conflicts.push({
        type: 'BAD_LOCK',
        lock_id: b.id,
        details: `锁定字幕 #${a.id}(${a.start_ms}-${a.end_ms}ms) 与 #${b.id}(${b.start_ms}-${b.end_ms}ms) 时间重叠，请解锁其一`,
      });
    }
  }
  for (const lk of locks) {
    const cut = cuts.find((c) => c > lk.start_ms && c < lk.end_ms);
    if (cut != null) {
      conflicts.push({
        type: 'BAD_LOCK',
        lock_id: lk.id,
        word_start_seq: lk.word_start_seq,
        word_end_seq: lk.word_end_seq,
        details: `锁定字幕「${lk.text}」(${lk.start_ms}-${lk.end_ms}ms) 跨越镜头切点 ${cut}ms，请解锁后重排`,
      });
    }
  }

  // 1c. 锁定字幕与未锁定词在时间轴上重叠（如导入新转写后）：未锁定词将无处安放
  for (const w of words) {
    if (covered.has(w.seq)) continue;
    const hit = locks.find((lk) => w.start_ms < lk.end_ms && w.end_ms > lk.start_ms);
    if (hit) {
      conflicts.push({
        type: 'BAD_LOCK',
        lock_id: hit.id,
        word_start_seq: w.seq,
        word_end_seq: w.seq,
        text: w.text,
        details: `未锁定词「${w.text}」(#${w.seq}, ${w.start_ms}-${w.end_ms}ms) 与锁定字幕「${hit.text}」(${hit.start_ms}-${hit.end_ms}ms) 时间重叠，任何新字幕都会与之重叠，请解锁该锁定字幕`,
      });
    }
  }
  if (conflicts.some((c) => c.type === 'BAD_LOCK')) return { conflicts };

  // 1d. 锁定字幕违反当前排片规则：不阻塞排片（锁定部分不可改），但作为警告返回
  const warnings = [];
  for (const lk of locks) {
    const len = lk.text != null ? lk.text.length : segLength(words, lk.word_start_seq - 1, lk.word_end_seq - 1);
    const dur = lk.end_ms - lk.start_ms;
    const reasons = [];
    if (len > st.max_chars) reasons.push(`字数 ${len} > 最大 ${st.max_chars}`);
    if (dur < st.min_display_ms) reasons.push(`时长 ${dur}ms < 最短 ${st.min_display_ms}ms`);
    const cps = (len * 1000) / dur;
    if (cps > st.max_cps + 1e-9) reasons.push(`CPS ${cps.toFixed(1)} > 上限 ${st.max_cps}`);
    if (reasons.length) {
      warnings.push({
        type: 'LOCK_VIOLATES_RULES',
        lock_id: lk.id,
        word_start_seq: lk.word_start_seq,
        word_end_seq: lk.word_end_seq,
        details: `锁定字幕「${lk.text}」不满足当前规则：${reasons.join('；')}。如需修正请解锁后重排或继续放宽规则`,
      });
    }
  }
  const lockStartByNextSeq = new Map();
  for (const lk of locks) lockStartByNextSeq.set(lk.word_start_seq, lk.start_ms);

  // 2. 切点落在词内部：结构冲突（任何排法都会跨切点）
  for (const w of words) {
    if (covered.has(w.seq)) continue;
    const inside = cuts.find((c) => cutInsideWord(w, c));
    if (inside != null) {
      conflicts.push({
        type: 'CUT_INSIDE_WORD',
        word_start_seq: w.seq,
        word_end_seq: w.seq,
        text: w.text,
        details: `镜头切点 ${inside}ms 落在词「${w.text}」时段 [${w.start_ms}, ${w.end_ms}] 内，任何字幕都无法不跨切点且不缩短该词`,
        cut_ms: inside,
      });
    }
  }

  // 3. 未锁定词按连续性切段，再按镜头切点分块，逐块 DP
  const runs = [];
  let i = 0;
  while (i < words.length) {
    if (covered.has(words[i].seq)) { i++; continue; }
    let j = i;
    while (j + 1 < words.length && !covered.has(words[j + 1].seq) && words[j + 1].seq === words[j].seq + 1) j++;
    runs.push([i, j]);
    i = j + 1;
  }

  const newCues = [];

  for (const [r0, r1] of runs) {
    // 切点分块：切点落在相邻词之间的空隙（含端点相接）即分块边界
    const blocks = [];
    let bStart = r0;
    for (let k = r0; k < r1; k++) {
      const cut = cuts.find((c) => c >= words[k].end_ms && c <= words[k + 1].start_ms);
      if (cut != null) {
        blocks.push({ lo: bStart, hi: k, cutAfter: cut });
        bStart = k + 1;
      }
    }
    // 最后一块之后若紧邻切点（与下一词之间，或整块转写末尾）也记录
    let tailCut = null;
    if (r1 + 1 < words.length) {
      const c = cuts.find((x) => x >= words[r1].end_ms && x <= words[r1 + 1].start_ms);
      if (c != null) tailCut = c;
    } else {
      const c = cuts.find((x) => x >= words[r1].end_ms);
      if (c != null) tailCut = c;
    }
    blocks.push({ lo: bStart, hi: r1, cutAfter: tailCut });

    for (const blk of blocks) {
      const { lo, hi, cutAfter } = blk;

      // 单词超字数：直接不可能
      for (let k = lo; k <= hi; k++) {
        if (words[k].text.length > st.max_chars) {
          conflicts.push({
            type: 'OVER_MAX_CHARS',
            word_start_seq: words[k].seq,
            word_end_seq: words[k].seq,
            text: words[k].text,
            details: `词「${words[k].text}」自身 ${words[k].text.length} 字，超过单条最大字数 ${st.max_chars}，无法切分`,
            length: words[k].text.length,
            max_chars: st.max_chars,
          });
        }
      }

      // DP：dp[b] = 覆盖 lo..b 的最少字幕数
      const dp = new Array(hi + 1).fill(null);
      const parent = new Array(hi + 1).fill(null);
      for (let b = lo; b <= hi; b++) {
        let best = Infinity, bestA = -1;
        for (let a = lo; a <= b; a++) {
          const cap = rightCap(words, a, b, hi, cutAfter != null && b === hi ? cutAfter : null, lockStartByNextSeq);
          const f = feasible(words, a, b, cap, st);
          if (f && f.ok) {
            const prev = a === lo ? 0 : (dp[a - 1] === null ? Infinity : dp[a - 1]);
            if (prev + 1 < best) { best = prev + 1; bestA = a; }
          }
        }
        if (best !== Infinity) { dp[b] = best; parent[b] = bestA; }
      }

      if (dp[hi] === null) {
        // 诊断：用“尽量塞满 max_chars”的规范装箱定位无法满足的词段
        let a = lo;
        while (a <= hi) {
          let b = a;
          while (b + 1 <= hi && segLength(words, a, b + 1) <= st.max_chars) b++;
          const cap = rightCap(words, a, b, hi, cutAfter != null && b === hi ? cutAfter : null, lockStartByNextSeq);
          const f = feasible(words, a, b, cap, st);
          if (f && !f.ok) {
            const reasons = [];
            if (f.avail < f.needMin) reasons.push(`可用时长 ${f.avail}ms < 最短显示 ${f.needMin}ms`);
            if (f.avail < f.needCps) reasons.push(`按 CPS 上限 ${st.max_cps} 字/秒需 ${f.needCps}ms，可用仅 ${f.avail}ms`);
            conflicts.push({
              type: 'RULES_INFEASIBLE',
              word_start_seq: words[a].seq,
              word_end_seq: words[b].seq,
              text: joinText(words, a, b),
              details: `词段「${joinText(words, a, b)}」(${f.len} 字, ${words[a].start_ms}-${words[b].end_ms}ms) 无法同时满足规则：${reasons.join('；')}`,
              length: f.len,
              available_ms: f.avail,
              required_min_ms: f.needMin,
              required_cps_ms: f.needCps,
            });
          }
          a = b + 1;
        }
        continue;
      }

      // 回溯构造字幕
      const segs = [];
      let b = hi;
      while (b >= lo) {
        const a = parent[b];
        segs.push([a, b]);
        b = a - 1;
      }
      segs.reverse();
      for (const [a2, b2] of segs) {
        const cap = rightCap(words, a2, b2, hi, cutAfter != null && b2 === hi ? cutAfter : null, lockStartByNextSeq);
        const f = feasible(words, a2, b2, cap, st);
        const end = cap === Infinity ? words[a2].start_ms + f.needed : Math.min(cap, words[a2].start_ms + f.needed);
        newCues.push({
          start_ms: words[a2].start_ms,
          end_ms: end,
          text: joinText(words, a2, b2),
          word_start_seq: words[a2].seq,
          word_end_seq: words[b2].seq,
          locked: 0,
        });
      }
    }
  }

  if (conflicts.length) return { conflicts, warnings };
  return { cues: newCues, warnings };
}

module.exports = { validateTranscript, arrange, segLength, joinText, ceilMs };
