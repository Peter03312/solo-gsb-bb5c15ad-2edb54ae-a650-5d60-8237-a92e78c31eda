'use strict';

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function ts(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(milli)}`;
}

function sanitize(text) {
  return String(text).replace(/-->/g, '->').replace(/\r/g, '');
}

// cues: [{start_ms,end_ms,text}] 任意顺序均可，函数内部按时间升序；同时校验不重叠
function toVTT(cues) {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start_ms < sorted[i - 1].end_ms) {
      throw new Error(`字幕重叠：${sorted[i - 1].end_ms}ms > ${sorted[i].start_ms}ms，拒绝导出`);
    }
  }
  const lines = ['WEBVTT', ''];
  sorted.forEach((c, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${ts(c.start_ms)} --> ${ts(c.end_ms)}`);
    lines.push(sanitize(c.text));
    lines.push('');
  });
  return { content: lines.join('\n'), count: sorted.length };
}

module.exports = { toVTT };
