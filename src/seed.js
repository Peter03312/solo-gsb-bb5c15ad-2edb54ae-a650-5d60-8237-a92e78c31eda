'use strict';
// 初始化：建库建表；words/cuts 为空时写入示例数据（SEED_SAMPLE=0 可关闭）
const { db, getProject, initProjectIfNeeded, now } = require('./db');

const SAMPLE_WORDS = [
  [0, 300, '我们'], [320, 600, '今天'], [650, 950, '讨论'],
  [1000, 1300, '字幕'], [1350, 1650, '校时'],
  [2000, 2300, '首先'], [2350, 2700, '导入'], [2750, 3100, '逐词'], [3150, 3500, '转写'],
  [4000, 4400, '然后'], [4450, 4800, '设置'], [4850, 5200, '规则'], [5250, 5600, '参数'],
  [6000, 6350, '系统'], [6400, 6750, '自动'], [6800, 7150, '分段'],
  [7200, 7550, '检查'], [7600, 7950, '冲突'],
  [8300, 8650, '确认'], [8700, 9100, '导出'],
];
const SAMPLE_CUTS = [1750, 3700, 5800, 8100];

function seedIfEmpty() {
  initProjectIfNeeded();
  const count = db.prepare('SELECT COUNT(*) AS n FROM words').get().n;
  if (count === 0 && process.env.SEED_SAMPLE !== '0') {
    const insW = db.prepare('INSERT INTO words (seq, start_ms, end_ms, text) VALUES (?,?,?,?)');
    const insC = db.prepare('INSERT INTO cuts (at_ms) VALUES (?)');
    const tx = db.transaction(() => {
      SAMPLE_WORDS.forEach(([s, e, t], i) => insW.run(i + 1, s, e, t));
      SAMPLE_CUTS.forEach((c) => insC.run(c));
    });
    tx();
    console.log(`[seed] 已写入示例数据：${SAMPLE_WORDS.length} 个词，${SAMPLE_CUTS.length} 个切点`);
  }
}

if (require.main === module) {
  seedIfEmpty();
  const p = getProject();
  console.log('[init] 数据库就绪', JSON.stringify(p));
}

module.exports = { seedIfEmpty };
