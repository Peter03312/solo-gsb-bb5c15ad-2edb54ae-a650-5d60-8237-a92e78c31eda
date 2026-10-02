'use strict';
// 引擎测试：不依赖网络/数据库，直接验证 arrange() 的全部约束
const assert = require('assert');
const { validateTranscript, arrange } = require('../src/arrange');
const { toVTT } = require('../src/vtt');

let pass = 0;
function ok(name) { pass++; console.log('  ✓', name); }

const SET = { max_chars: 10, min_display_ms: 500, max_cps: 15 };
function mkWords(arr) { return arr.map(([s, e, t], i) => ({ seq: i + 1, start_ms: s, end_ms: e, text: t })); }

// 1. 基础排片：覆盖全部词、不重叠、不缩短
{
	const words = mkWords([[0, 200, 'aa'], [250, 450, 'bb'], [1000, 1200, 'cc'], [1250, 1450, 'dd']]);
	const r = arrange(words, [], [], SET);
	assert(!r.conflicts, '基础排片不应有冲突: ' + JSON.stringify(r.conflicts));
	assert.strictEqual(r.cues.reduce((n, c) => n + (c.word_end_seq - c.word_start_seq + 1), 0), 4);
	for (const c of r.cues) {
		assert(c.end_ms >= words[c.word_end_seq - 1].end_ms, '不缩短末词');
		assert(c.end_ms - c.start_ms >= 500, '最短时长');
		assert(c.text.length <= 10, '字数');
		assert(c.text.length * 1000 / (c.end_ms - c.start_ms) <= 15 + 1e-9, 'CPS');
	}
	for (let i = 1; i < r.cues.length; i++) assert(r.cues[i].start_ms >= r.cues[i - 1].end_ms, '不重叠');
	ok('基础排片：全覆盖/不重叠/不缩短/三条规则');
}

// 2. 不跨镜头切点
{
	const words = mkWords([[0, 200, 'aa'], [300, 500, 'bb'], [800, 1000, 'cc']]);
	const r = arrange(words, [600], [], SET);
	assert(!r.conflicts, JSON.stringify(r.conflicts));
	for (const c of r.cues) {
		assert(!(600 > c.start_ms && 600 < c.end_ms), '字幕跨过 600ms 切点');
	}
	ok('切点分块：字幕不跨切点');
}

// 3. 切点落在词内 → 结构冲突，且无 cues
{
	const words = mkWords([[0, 400, 'aa'], [500, 900, 'bb']]);
	const r = arrange(words, [200], [], SET);
	assert(r.conflicts, '必须报冲突');
	assert.strictEqual(r.conflicts[0].type, 'CUT_INSIDE_WORD');
	assert(!r.cues, '冲突时不输出结果');
	ok('切点落词内：拒绝并指出词段');
}

// 4. 单词超字数冲突
{
	const words = mkWords([[0, 4000, 'abcdefghijklmnop']]);
	const r = arrange(words, [], [], { max_chars: 5, min_display_ms: 100, max_cps: 100 });
	assert(r.conflicts && r.conflicts.some((c) => c.type === 'OVER_MAX_CHARS'), '应报超字数');
	assert(!r.cues);
	ok('单词超长：OVER_MAX_CHARS 冲突，不输出结果');
}

// 5. CPS/时长无法满足（密集词段被切点夹住）→ 冲突
{
	const words = mkWords([[0, 60, 'aaaaaaaa'], [61, 120, 'bbbbbbbb']]);
	const r = arrange(words, [121], [], { max_chars: 20, min_display_ms: 2000, max_cps: 30 });
	assert(r.conflicts && r.conflicts.some((c) => c.type === 'RULES_INFEASIBLE'),
		'密集长词段无法满足 min/CPS: ' + JSON.stringify(r.conflicts));
	assert.strictEqual(r.conflicts[0].word_start_seq, 1);
	assert.strictEqual(r.conflicts[0].word_end_seq, 2);
	ok('规则不可满足：指出受影响词段与冲突条件');
}

// 6. 锁定字幕保持不动，重排只改其余部分
{
	const words = mkWords([[0, 300, 'aa'], [1000, 1300, 'bb'], [2000, 2300, 'cc'], [3000, 3300, 'dd']]);
	const locks = [{ id: 99, start_ms: 1000, end_ms: 1600, text: 'bb', word_start_seq: 2, word_end_seq: 2, locked: 1 }];
	const r = arrange(words, [], locks, SET);
	assert(!r.conflicts, JSON.stringify(r.conflicts));
	assert(!r.cues.some((c) => c.word_start_seq <= 2 && c.word_end_seq >= 2), '不为锁定词另生成字幕');
	const coveredSeqs = new Set();
	r.cues.forEach((c) => { for (let s = c.word_start_seq; s <= c.word_end_seq; s++) coveredSeqs.add(s); });
	assert.deepStrictEqual([...coveredSeqs].sort(), [1, 3, 4], '未锁定词全部被覆盖');
	assert(r.cues.every((c) => !(c.end_ms > 1000 && c.start_ms < 1600)), '新字幕不与锁定字幕重叠');
	ok('锁定：锁定词不被重排，其余词全覆盖且不撞锁定段');
}

// 7. 锁定字幕间隙极短导致放不下 → 冲突
{
	const words = mkWords([[0, 300, 'LOCK0'], [1000, 1060, 'free'], [1100, 1300, 'LOCK1']]);
	const locks = [
		{ start_ms: 0, end_ms: 300, text: 'LOCK0', word_start_seq: 1, word_end_seq: 1 },
		{ start_ms: 1100, end_ms: 1300, text: 'LOCK1', word_start_seq: 3, word_end_seq: 3 },
	];
	const r = arrange(words, [], locks, { max_chars: 10, min_display_ms: 800, max_cps: 15 });
	assert(r.conflicts, '间隙不够 min_display 应冲突: ' + JSON.stringify(r));
	assert(r.conflicts.some((c) => c.word_start_seq === 2 && c.word_end_seq === 2), '应指出被夹住的词段');
	ok('锁定造成的规则不可行同样报冲突，不输出残缺结果');
}

// 8. 导入校验：倒序/重叠/负时间/空文本/切点重复
{
	const bad1 = validateTranscript([{ start_ms: 500, end_ms: 200, text: 'x' }], []);
	assert(bad1.errors.length, 'end<start 拒绝');
	const bad2 = validateTranscript([{ start_ms: 0, end_ms: 300, text: 'a' }, { start_ms: 100, end_ms: 400, text: 'b' }], []);
	assert(bad2.errors.some((e) => /倒序|重叠/.test(e)), '重叠拒绝');
	const bad3 = validateTranscript([{ start_ms: 0, end_ms: 300, text: 'a' }], [200, 200]);
	assert(bad3.errors.length, '重复切点拒绝');
	const good = validateTranscript([{ start_ms: 0, end_ms: 300, text: 'a' }], [300]);
	assert.strictEqual(good.errors.length, 0, '端点相接的切点合法');
	ok('导入校验：无效时间/倒序/重叠/重复切点均拒绝');
}

// 9. VTT：升序、格式正确、重叠拒绝
{
	const v = toVTT([{ start_ms: 1000, end_ms: 2000, text: 'b' }, { start_ms: 0, end_ms: 1000, text: 'a' }]);
	assert(v.content.startsWith('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\na'));
	assert.throws(() => toVTT([{ start_ms: 0, end_ms: 100, text: 'x' }, { start_ms: 50, end_ms: 150, text: 'y' }]),
		/重叠/);
	ok('VTT：时间升序导出，重叠输入被拒绝');
}

// 10. 起始=首词起点（不错位），延伸只发生在尾部空隙
{
	const words = mkWords([[0, 200, 'aa'], [200, 400, 'bb'], [1000, 1200, 'cc']]);
	const r = arrange(words, [], [], SET);
	assert(!r.conflicts, JSON.stringify(r.conflicts));
	for (const c of r.cues) assert.strictEqual(c.start_ms, words[c.word_start_seq - 1].start_ms, '起始=首词起点');
	ok('字幕起始严格等于首词起点');
}

// 11. 锁定字幕缩短词时段 → BAD_LOCK 冲突
{
	const words = mkWords([[0, 400, 'aa'], [1000, 1300, 'bb']]);
	const locks = [{ id: 5, start_ms: 0, end_ms: 200, text: 'aa', word_start_seq: 1, word_end_seq: 1 }];
	const r = arrange(words, [], locks, SET);
	assert(r.conflicts && r.conflicts[0].type === 'BAD_LOCK', '缩短词的锁定应拒绝');
	ok('锁定缩短词时段：BAD_LOCK');
}

// 12. 锁定字幕跨切点 → BAD_LOCK
{
	const words = mkWords([[0, 300, 'aa'], [400, 700, 'bb'], [1000, 1300, 'cc']]);
	const locks = [{ id: 6, start_ms: 0, end_ms: 700, text: 'aa bb', word_start_seq: 1, word_end_seq: 2 }];
	const r = arrange(words, [500], locks, SET);
	assert(r.conflicts && r.conflicts.some((c) => c.type === 'BAD_LOCK'), '跨切点锁定应拒绝');
	ok('锁定跨镜头切点：BAD_LOCK');
}

// 13. 未锁定词与锁定字幕时间重叠 → BAD_LOCK
{
	const words = mkWords([[0, 300, 'aa'], [100, 400, 'bb']]);
	const locks = [{ id: 7, start_ms: 0, end_ms: 300, text: 'aa', word_start_seq: 1, word_end_seq: 1 }];
	const r = arrange(words, [], locks, SET);
	assert(r.conflicts && r.conflicts.some((c) => c.type === 'BAD_LOCK' && c.word_start_seq === 2),
		'应指出与锁定重叠的未锁定词');
	ok('未锁定词与锁定时间重叠：BAD_LOCK 指出受影响词');
}

// 14. 锁定字幕违反规则但物理可行 → 正常排片 + warning
{
	const words = mkWords([[0, 300, 'aa'], [1000, 1300, 'bb']]);
	const locks = [{ id: 8, start_ms: 0, end_ms: 300, text: 'aa', word_start_seq: 1, word_end_seq: 1 }];
	const r = arrange(words, [], locks, { max_chars: 5, min_display_ms: 500, max_cps: 15 });
	assert(r.cues, '物理可行时必须输出结果');
	assert(r.warnings && r.warnings[0].type === 'LOCK_VIOLATES_RULES', '锁定不满足规则应警告');
	assert(r.warnings[0].details.includes('300ms < 最短 500ms'), '警告应说明冲突条件');
	ok('锁定违反规则：排片继续并返回 LOCK_VIOLATES_RULES 警告');
}

console.log(`\n全部 ${pass} 项测试通过`);