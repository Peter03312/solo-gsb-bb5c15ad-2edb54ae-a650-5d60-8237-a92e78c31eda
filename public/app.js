'use strict';

let S = null; // 当前完整状态
let settingsBase = null; // 编辑规则时的基线版本

const $ = (id) => document.getElementById(id);
const fmtMs = (ms) => {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000),
    s = Math.floor((ms % 60000) / 1000), x = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
};

function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, 3500);
}

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

function handleStale(data, fallback) {
  if (data && data.stale && data.current) {
    S = data.current;
    render();
    toast(data.error || '提交基于过期版本，页面已刷新为当前内容', true);
    return true;
  }
  if (fallback) toast(fallback, true);
  return false;
}

// ---------- 渲染 ----------
function render() {
  if (!S) return;
  $('tv').textContent = S.transcript_version;
  $('sv').textContent = S.settings.version;
  $('cv').textContent = S.content_version;

  if (document.activeElement.tagName !== 'INPUT') {
    $('max-chars').value = S.settings.max_chars;
    $('min-display').value = S.settings.min_display_ms;
    $('max-cps').value = S.settings.max_cps;
    settingsBase = S.settings.version;
  }

  // 词
  const lockedSeqs = new Set();
  S.cues.filter((c) => c.locked).forEach((c) => {
    for (let s = c.word_start_seq; s <= c.word_end_seq; s++) lockedSeqs.add(s);
  });
  $('words-view').innerHTML = S.words.map((w) =>
    `<span class="word ${lockedSeqs.has(w.seq) ? 'locked' : ''}" title="#${w.seq} ${w.start_ms}-${w.end_ms}ms">
      ${escapeHtml(w.text)} <small>${w.start_ms}</small></span>`).join('');
  $('words-count').textContent = `共 ${S.words.length} 词`;
  $('cuts-view').innerHTML = S.cuts.length
    ? S.cuts.map((c) => `<span>✂ ${c}ms</span>`).join('')
    : '<span class="hint">无</span>';

  // 字幕
  $('cues-view').innerHTML = S.cues.length ? S.cues.map(renderCue).join('')
    : '<p class="hint">尚无字幕，点击「自动排片」生成。</p>';
  S.cues.forEach((c) => bindCue(c));

  // 导出列表
  const tb = document.querySelector('#exports-table tbody');
  tb.innerHTML = S.exports.length ? S.exports.map((e) =>
    `<tr><td>${e.id}</td><td>${escapeHtml(e.file_name)}</td><td>${e.cue_count}</td>
     <td>${new Date(e.created_at).toLocaleString()}</td><td><code>${e.content_version}</code></td>
     <td><a href="/api/exports/${e.id}/download" target="_blank">下载 .vtt</a></td></tr>`).join('')
    : '<tr><td colspan="6" class="hint">暂无已确认导出</td></tr>';
}

function renderCue(c) {
  const cps = ((c.text.length * 1000) / (c.end_ms - c.start_ms)).toFixed(1);
  const overCps = Number(cps) > S.settings.max_cps;
  return `<div class="cue ${c.locked ? 'locked' : ''}" data-id="${c.id}">
    <div class="cue-head">
      <span class="cue-time">#${c.id} 词 ${c.word_start_seq}–${c.word_end_seq} ·
        ${fmtMs(c.start_ms)} → <input class="cue-end" type="number" value="${c.end_ms}" data-field="end">
        <span class="${overCps ? 'cps-bad' : ''}" title="字/秒">${cps} CPS</span>
        ${c.locked ? '🔒' : ''} <span class="ver">v${c.version}</span></span>
      <span class="cue-actions">
        <button data-act="lock">${c.locked ? '解锁' : '锁定'}</button>
        <button data-act="save">保存修订</button>
      </span>
    </div>
    <input class="cue-text" type="text" value="${escapeAttr(c.text)}" data-field="text">
    <div class="cue-err" style="color:#dc2626;font-size:12px"></div>
  </div>`;
}

function bindCue(c) {
  const el = document.querySelector(`.cue[data-id="${c.id}"]`);
  if (!el) return;
  el.querySelector('[data-act="lock"]').onclick = async () => {
    const { ok, data } = await api('POST', `/api/cues/${c.id}/lock`, { lock: !c.locked });
    if (ok) { S = data.state; render(); toast(c.locked ? '已解锁' : '已锁定，后续排片不会改动该条'); }
    else handleStale(data, data.error || '锁定失败');
  };
  el.querySelector('[data-act="save"]').onclick = async () => {
    const text = el.querySelector('[data-field="text"]').value;
    const end_ms = Number(el.querySelector('[data-field="end"]').value);
    const errBox = el.querySelector('.cue-err');
    errBox.textContent = '';
    const { ok, data } = await api('PATCH', `/api/cues/${c.id}`, {
      text, end_ms, expected_version: c.version,
    });
    if (ok) { S = data.state; render(); toast('字幕已保存（版本号 +1）'); }
    else if (data.stale) { handleStale(data); }
    else {
      errBox.textContent = (data.validation_errors || [data.error]).join('；');
    }
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function escapeAttr(s) { return escapeHtml(s); }

function showConflicts(conflicts) {
  const box = $('conflict-box');
  box.classList.remove('hidden');
  $('conflict-list').innerHTML = conflicts.map((c) =>
    `<div class="conflict-item">
      <span class="tag">${c.type}</span>
      ${c.word_start_seq != null ? `<span class="rng">[词 ${c.word_start_seq}${c.word_end_seq !== c.word_start_seq ? '–' + c.word_end_seq : ''}]</span> ` : ''}
      ${escapeHtml(c.details || JSON.stringify(c))}
    </div>`).join('');
  box.scrollIntoView({ behavior: 'smooth' });
}
function clearConflicts() { $('conflict-box').classList.add('hidden'); }

function showWarnings(warnings) {
  const box = $('warning-box');
  if (!warnings || !warnings.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('warning-list').innerHTML = warnings.map((c) =>
    `<div class="conflict-item">
      <span class="tag">${c.type}</span>
      ${c.word_start_seq != null ? `<span class="rng">[词 ${c.word_start_seq}–${c.word_end_seq}]</span> ` : ''}
      ${escapeHtml(c.details || '')}
    </div>`).join('');
}
function clearWarnings() { $('warning-box').classList.add('hidden'); }

// ---------- 动作 ----------
$('btn-import').onclick = async () => {
  let parsed;
  try { parsed = JSON.parse($('import-text').value); }
  catch { return toast('JSON 解析失败', true); }
  const { ok, status, data } = await api('POST', '/api/import', parsed);
  if (ok) {
    S = data.state;
    render();
    clearConflicts();
    clearWarnings();
    toast(`已导入 ${data.imported_words} 词、${data.imported_cuts} 切点`);
  } else if (status === 409) {
    handleStale(data);
  } else {
    toast((data.validation_errors || [data.error]).join('\n'), true);
  }
};

$('btn-reset').onclick = async () => {
  if (!confirm('确定清空全部转写、切点、字幕与规则修改？（已导出的 VTT 快照保留）')) return;
  const { ok, data } = await api('POST', '/api/reset');
  if (ok) { S = data.state; render(); clearConflicts(); clearWarnings(); toast('已清空'); }
};

$('btn-save-settings').onclick = async () => {
  const body = {
    max_chars: Number($('max-chars').value),
    min_display_ms: Number($('min-display').value),
    max_cps: Number($('max-cps').value),
    expected_version: settingsBase,
  };
  const { ok, data } = await api('PUT', '/api/settings', body);
  if (ok) { S = data.state; render(); $('settings-status').textContent = '已保存'; toast('规则已更新'); }
  else handleStale(data, (data.validation_errors || [data.error]).join('；'));
};

$('btn-arrange').onclick = async () => {
  $('arrange-status').textContent = '排片中…';
  const { ok, data } = await api('POST', '/api/arrange');
  if (ok) {
    S = data.state;
    render();
    clearConflicts();
    clearWarnings();
    if (data.warnings && data.warnings.length) {
      showWarnings(data.warnings);
      $('arrange-status').textContent = `生成 ${data.created} 条、保留 ${data.locked} 条锁定；${data.warnings.length} 条锁定字幕不满足当前规则`;
    } else {
      clearWarnings();
      $('arrange-status').textContent = `生成 ${data.created} 条字幕，保留 ${data.locked} 条锁定`;
    }
    toast('排片完成');
  } else if (data.conflicts) {
    S = data.state;
    render();
    showConflicts(data.conflicts);
    showWarnings(data.warnings);
    $('arrange-status').textContent = `存在 ${data.conflicts.length} 项冲突，未修改任何字幕`;
  } else {
    handleStale(data, data.error || '排片失败');
  }
};

$('btn-export').onclick = async () => {
  const { ok, data } = await api('POST', '/api/exports', { expected_version: S.content_version });
  if (ok) {
    S = data.state;
    render();
    $('export-status').textContent = `已确认导出 ${data.file_name}`;
    toast(`已导出快照（${data.cue_count} 条），后续修改不影响该文件`);
  } else {
    handleStale(data, data.error || '导出失败');
  }
};

// ---------- 启动 ----------
(async function init() {
  const { ok, data } = await api('GET', '/api/state');
  if (ok) { S = data; render(); }
  else toast('无法加载状态', true);
})();
