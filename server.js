'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, getProject, initProjectIfNeeded, now } = require('./src/db');
const { seedIfEmpty } = require('./src/seed');
const { validateTranscript, arrange } = require('./src/arrange');
const { toVTT } = require('./src/vtt');

initProjectIfNeeded();
seedIfEmpty();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 序列化 ----------
function stateData() {
  const project = getProject();
  const words = db.prepare('SELECT seq, start_ms, end_ms, text FROM words ORDER BY seq').all();
  const cuts = db.prepare('SELECT at_ms FROM cuts ORDER BY at_ms').all().map((r) => r.at_ms);
  const cues = db.prepare('SELECT * FROM cues ORDER BY start_ms, id').all();
  const exports2 = db.prepare('SELECT id, content_version, cue_count, file_name, created_at FROM exports ORDER BY id DESC').all();
  return {
    settings: {
      max_chars: project.max_chars,
      min_display_ms: project.min_display_ms,
      max_cps: project.max_cps,
      version: project.settings_version,
    },
    transcript_version: project.transcript_version,
    content_version: contentVersion(cues),
    words,
    cuts,
    cues,
    exports: exports2,
  };
}

function contentVersion(cues) {
  const h = crypto.createHash('sha256');
  for (const c of cues) {
    h.update(`${c.id}|${c.start_ms}|${c.end_ms}|${c.text}|${c.word_start_seq}|${c.word_end_seq}|${c.locked}|${c.version};`);
  }
  return h.digest('hex').slice(0, 16);
}

function fail(res, code, error, extra) {
  return res.status(code).json({ error, ...(extra || {}) });
}

// ---------- 状态 ----------
app.get('/api/state', (req, res) => {
  res.json(stateData());
});

// ---------- 导入转写 + 切点 ----------
app.post('/api/import', (req, res) => {
  const { words: rawWords, cuts: rawCuts } = req.body || {};
  const { errors, words, cuts } = validateTranscript(rawWords, rawCuts);
  if (errors.length) return fail(res, 400, '转写数据校验失败', { validation_errors: errors });

  const locks = db.prepare('SELECT * FROM cues WHERE locked = 1 ORDER BY id').all();
  const blocked = locks.filter((l) => l.word_end_seq > words.length);
  if (blocked.length) {
    return fail(res, 409, '存在词范围超出新转写长度的锁定字幕，请先解锁后再导入', {
      blocking_locks: blocked,
      current: stateData(),
    });
  }

  const p = getProject();
  db.transaction(() => {
    db.prepare('DELETE FROM words').run();
    db.prepare('DELETE FROM cuts').run();
    db.prepare('DELETE FROM cues WHERE locked = 0').run();
    const insW = db.prepare('INSERT INTO words (seq, start_ms, end_ms, text) VALUES (?,?,?,?)');
    words.forEach((w) => insW.run(w.seq, w.start_ms, w.end_ms, w.text));
    const insC = db.prepare('INSERT INTO cuts (at_ms) VALUES (?)');
    cuts.forEach((c) => insC.run(c));
    db.prepare("UPDATE project SET transcript_version = transcript_version + 1, updated_at = ? WHERE id = 1").run(now());
  })();
  res.json({ ok: true, imported_words: words.length, imported_cuts: cuts.length, state: stateData() });
});

// ---------- 清空重置 ----------
app.post('/api/reset', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM words').run();
    db.prepare('DELETE FROM cuts').run();
    db.prepare('DELETE FROM cues').run();
    db.prepare(`UPDATE project SET max_chars=18, min_display_ms=800, max_cps=12,
      settings_version=settings_version+1, transcript_version=transcript_version+1, updated_at=? WHERE id=1`).run(now());
  })();
  res.json({ ok: true, state: stateData() });
});

// ---------- 规则设置（版本号拒绝过期提交） ----------
app.put('/api/settings', (req, res) => {
  const { max_chars, min_display_ms, max_cps, expected_version } = req.body || {};
  const mc = Number(max_chars), md = Number(min_display_ms), cps = Number(max_cps);
  const errs = [];
  if (!Number.isInteger(mc) || mc < 1) errs.push('max_chars 必须是 >=1 的整数');
  if (!Number.isInteger(md) || md < 1) errs.push('min_display_ms 必须是 >=1 的整数毫秒');
  if (!(cps > 0) || !Number.isFinite(cps)) errs.push('max_cps 必须是 >0 的数');
  if (errs.length) return fail(res, 400, '规则参数无效', { validation_errors: errs });

  const p = getProject();
  if (expected_version != null && Number(expected_version) !== p.settings_version) {
    return fail(res, 409, `规则版本已过期（你基于 v${expected_version}，当前 v${p.settings_version}）`, {
      stale: true,
      current: stateData(),
    });
  }
  db.prepare('UPDATE project SET max_chars=?, min_display_ms=?, max_cps=?, settings_version=settings_version+1, updated_at=? WHERE id=1')
    .run(mc, md, cps, now());
  res.json({ ok: true, state: stateData() });
});

// ---------- 自动排片（只改未锁定字幕） ----------
app.post('/api/arrange', (req, res) => {
  const p = getProject();
  const words = db.prepare('SELECT * FROM words ORDER BY seq').all();
  if (!words.length) return fail(res, 400, '尚未导入转写，无法排片');
  const cuts = db.prepare('SELECT at_ms FROM cuts ORDER BY at_ms').all().map((r) => r.at_ms);
  const locks = db.prepare('SELECT * FROM cues WHERE locked = 1 ORDER BY start_ms').all();

  const result = arrange(words, cuts, locks, {
    max_chars: p.max_chars,
    min_display_ms: p.min_display_ms,
    max_cps: p.max_cps,
  });

  if (result.conflicts) {
    // 不改动任何数据，返回冲突条件与受影响词段
    return res.status(422).json({
      ok: false,
      conflicts: result.conflicts,
      warnings: result.warnings || [],
      state: stateData(),
    });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM cues WHERE locked = 0').run();
    const ins = db.prepare(
      'INSERT INTO cues (start_ms,end_ms,text,word_start_seq,word_end_seq,locked,version) VALUES (?,?,?,?,?,0,1)'
    );
    for (const c of result.cues) {
      ins.run(c.start_ms, c.end_ms, c.text, c.word_start_seq, c.word_end_seq);
    }
  })();
  res.json({ ok: true, created: result.cues.length, locked: locks.length, warnings: result.warnings || [], state: stateData() });
});

// ---------- 单条字幕修订（版本号拒绝过期提交） ----------
function loadWordsMap() {
  const rows = db.prepare('SELECT * FROM words ORDER BY seq').all();
  return { rows, bySeq: new Map(rows.map((w) => [w.seq, w])) };
}

function validateCueEdit(cue, body, wordsRows, bySeq, settings) {
  const errs = [];
  const text = typeof body.text === 'string' ? body.text.trim() : cue.text;
  if (!text || /-->/.test(text)) errs.push('字幕文本不能为空且不能包含 -->');

  let start = Number(body.start_ms != null ? body.start_ms : cue.start_ms);
  let end = Number(body.end_ms != null ? body.end_ms : cue.end_ms);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    errs.push('时间无效：需要 0 <= start_ms < end_ms 的整数毫秒');
    return { errs };
  }
  const ws = cue.word_start_seq, we = cue.word_end_seq;
  const first = bySeq.get(ws), last = bySeq.get(we);
  if (!first || !last) { errs.push('字幕没有关联的转写词，无法修订'); return { errs }; }

  // 不缩短词本身的时段
  if (start !== first.start_ms) errs.push(`字幕起始必须等于首词起点 ${first.start_ms}ms（不缩短/错位词时段）`);
  if (end < last.end_ms) errs.push(`字幕结束 ${end}ms 早于末词终点 ${last.end_ms}ms（不允许缩短词时段）`);

  // 与其他字幕不重叠（按时间，相邻允许端点相接）
  const others = db.prepare('SELECT * FROM cues WHERE id != ?').all(cue.id);
  for (const o of others) {
    if (start < o.end_ms && end > o.start_ms) {
      errs.push(`与字幕 #${o.id} 时间重叠（${o.start_ms}-${o.end_ms}ms）`);
      break;
    }
  }

  // 不跨镜头切点：切点不允许严格落在字幕时段内部
  const cuts = db.prepare('SELECT at_ms FROM cuts').all().map((r) => r.at_ms);
  for (const c of cuts) {
    if (c > start && c < end) {
      errs.push(`字幕时段跨越镜头切点 ${c}ms`);
      break;
    }
  }

  // 规则
  if (text.length > settings.max_chars) errs.push(`字数 ${text.length} 超过单条最大字数 ${settings.max_chars}`);
  const dur = end - start;
  if (dur < settings.min_display_ms) errs.push(`显示时长 ${dur}ms 短于最短显示 ${settings.min_display_ms}ms`);
  const cpsNeed = (text.length * 1000) / dur;
  if (cpsNeed > settings.max_cps + 1e-9) {
    errs.push(`语速 ${cpsNeed.toFixed(2)} 字/秒超过上限 ${settings.max_cps}（至少需要 ${Math.ceil((text.length * 1000) / settings.max_cps - 1e-9)}ms）`);
  }
  return { errs, text, start, end };
}

app.patch('/api/cues/:id', (req, res) => {
  const id = Number(req.params.id);
  const cue = db.prepare('SELECT * FROM cues WHERE id=?').get(id);
  if (!cue) return fail(res, 404, '字幕不存在');
  const p = getProject();
  if (Number(req.body && req.body.expected_version) !== cue.version) {
    return fail(res, 409, `字幕版本已过期（你基于 v${req.body && req.body.expected_version}，当前 v${cue.version}）`, {
      stale: true,
      current: stateData(),
    });
  }
  const { rows, bySeq } = loadWordsMap();
  const v = validateCueEdit(cue, req.body || {}, rows, bySeq, p);
  if (v.errs.length) return fail(res, 400, '字幕修订校验失败', { validation_errors: v.errs });

  db.prepare('UPDATE cues SET start_ms=?, end_ms=?, text=?, version=version+1 WHERE id=?')
    .run(v.start, v.end, v.text, id);
  res.json({ ok: true, state: stateData() });
});

// ---------- 锁定 / 解锁 ----------
app.post('/api/cues/:id/lock', (req, res) => {
  const id = Number(req.params.id);
  const cue = db.prepare('SELECT * FROM cues WHERE id=?').get(id);
  if (!cue) return fail(res, 404, '字幕不存在');
  const lock = req.body && req.body.lock !== undefined ? !!req.body.lock : !cue.locked;
  db.prepare('UPDATE cues SET locked=?, version=version+1 WHERE id=?').run(lock ? 1 : 0, id);
  res.json({ ok: true, locked: lock, state: stateData() });
});

// ---------- 导出 ----------
app.get('/api/exports', (req, res) => {
  const rows = db.prepare('SELECT * FROM exports ORDER BY id DESC').all();
  res.json({ exports: rows.map(({ vtt, ...meta }) => meta) });
});

app.post('/api/exports', (req, res) => {
  const cues = db.prepare('SELECT * FROM cues ORDER BY start_ms, id').all();
  if (!cues.length) return fail(res, 400, '没有可导出的字幕');
  const version = contentVersion(cues);
  if (req.body && req.body.expected_version && req.body.expected_version !== version) {
    return fail(res, 409, '字幕在你确认后已被修改，请核对当前内容再导出', {
      stale: true,
      current: stateData(),
    });
  }
  const project = getProject();
  let vtt;
  try {
    vtt = toVTT(cues);
  } catch (e) {
    return fail(res, 422, e.message);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const fileName = `subtitles_v${project.transcript_version}_${stamp}.vtt`;
  const info = db.prepare(
    'INSERT INTO exports (content_version, cue_count, vtt, file_name, created_at) VALUES (?,?,?,?,?)'
  ).run(version, vtt.count, vtt.content, fileName, now());
  // 快照已入库：后续任何修改都不会改变这个文件的内容
  res.json({
    ok: true,
    export_id: info.lastInsertRowid,
    file_name: fileName,
    content_version: version,
    cue_count: vtt.count,
    download_url: `/api/exports/${info.lastInsertRowid}/download`,
    state: stateData(),
  });
});

app.get('/api/exports/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM exports WHERE id=?').get(Number(req.params.id));
  if (!row) return fail(res, 404, '导出记录不存在');
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(row.vtt);
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: now() }));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`字幕校时工作台已启动: http://localhost:${PORT}`);
});
