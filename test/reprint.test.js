'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateImposition,
  validateImposition,
  parseReprintPages,
  planReprint,
  buildReprintProofHtml,
} = require('../src/imposition');

/** 取出第 n 个打样页（1 起）的 section 子串，顺序为正面、反面交替 */
function pageSection(html, n) {
  const parts = html.split('<section class="sheet-page">');
  assert.ok(parts[n], `只有 ${parts.length - 1} 个打样页，取不到第 ${n} 个`);
  return parts[n];
}

/** 打样页某一半版（left/right）内部 HTML：左半位于两个 half 之间，右半到折线为止 */
function halfContent(section, pos) {
  const start = section.indexOf(`class="half ${pos}"`);
  assert.notEqual(start, -1, `缺少 ${pos} 半版`);
  const rest = section.slice(start);
  const end = pos === 'left'
    ? rest.indexOf('class="half right"')
    : rest.indexOf('class="fold"');
  return rest.slice(0, end);
}

/* ---------- 页码表达式解析 ---------- */

test('补印页码：逗号与连续区间解析，结果升序去重', () => {
  assert.deepEqual(parseReprintPages('2,5-7', 10), { pages: [2, 5, 6, 7] });
  assert.deepEqual(parseReprintPages('8', 10), { pages: [8] });
  // 乱序、重复、区间与单页重叠均去重排序
  assert.deepEqual(parseReprintPages('7,2,5-6,2,6-7', 10), { pages: [2, 5, 6, 7] });
  // 中文逗号、空白与 ~ 区间
  assert.deepEqual(parseReprintPages(' 3 ， 4~5 ', 10), { pages: [3, 4, 5] });
  // 区间两端允许空格
  assert.deepEqual(parseReprintPages('5 - 7', 10), { pages: [5, 6, 7] });
});

test('补印页码：非法输入说明原因', () => {
  assert.match(parseReprintPages('', 10).error, /请输入/);
  assert.match(parseReprintPages('   ', 10).error, /请输入/);
  assert.match(parseReprintPages(null, 10).error, /请输入/);
  assert.match(parseReprintPages('abc', 10).error, /无法识别/);
  assert.match(parseReprintPages('2.5', 10).error, /无法识别/);
  assert.match(parseReprintPages('-3', 10).error, /无法识别/);
  assert.match(parseReprintPages('2,,3', 10).error, /空项/);
  assert.match(parseReprintPages('7-5', 10).error, /起点大于终点/);
  assert.match(parseReprintPages('0', 10).error, /超出成品页范围 1~10/);
  assert.match(parseReprintPages('11', 10).error, /超出成品页范围 1~10/);
  assert.match(parseReprintPages('8-12', 10).error, /超出成品页范围 1~10/);
});

/* ---------- 补印清单 ---------- */

test('补印清单：结构非法返回 null', () => {
  assert.equal(planReprint(null, '1'), null);
  assert.equal(planReprint({ pages: 3, totalPages: 8, sheets: [] }, '1'), null);
  assert.equal(planReprint(generateImposition(8), '1').error, undefined);
});

test('补印清单：单帖按版位反查纸张，同张纸命中多页只列一次', () => {
  const imp = generateImposition(8);
  // 第 1 张：正面[8,1] 反面[2,7]；第 2 张：正面[6,3] 反面[4,5]
  const one = planReprint(imp, '1,8');
  assert.equal(one.sheetCount, 1);
  assert.deepEqual(one.sheets[0], {
    sig: null,
    index: 1,
    hitPages: [1, 8],
    front: { left: 8, right: 1 },
    back: { left: 2, right: 7 },
  });

  // 同一张纸命中 4 页仍只列一次，命中页合并升序
  const merged = planReprint(imp, '8,1,2,7');
  assert.equal(merged.sheetCount, 1);
  assert.deepEqual(merged.sheets[0].hitPages, [1, 2, 7, 8]);

  // 跨纸张：2、7 在第 1 张，5、6 在第 2 张，按纸张序排列
  const two = planReprint(imp, '2,5-7');
  assert.deepEqual(two.hitPages, [2, 5, 6, 7]);
  assert.equal(two.sheetCount, 2);
  assert.deepEqual(two.sheets.map((s) => [s.index, s.hitPages]), [
    [1, [2, 7]],
    [2, [5, 6]],
  ]);
});

test('补印清单：分帖跨帖按帖号及帖内纸张序排列，空白版位原样展示', () => {
  const imp = generateImposition(10, 2);
  // 第 1 帖第 1 张：正面[8,1] 反面[2,7]；第 2 帖第 1 张：正面[空白,9] 反面[10,空白]
  const plan = planReprint(imp, '9,1'); // 输入乱序，清单仍按帖号排序
  assert.deepEqual(plan.hitPages, [1, 9]);
  assert.equal(plan.sheetCount, 2);
  assert.deepEqual(plan.sheets.map((s) => [s.sig, s.index]), [[1, 1], [2, 1]]);
  assert.deepEqual(plan.sheets[0].hitPages, [1]);
  assert.deepEqual(plan.sheets[1], {
    sig: 2,
    index: 1,
    hitPages: [9],
    front: { left: null, right: 9 },
    back: { left: 10, right: null },
  });
});

test('补印清单：拼版未通过校验时说明原因并拒绝', () => {
  const imp = generateImposition(8);
  [imp.sheets[0].front.left, imp.sheets[0].front.right] = [
    imp.sheets[0].front.right,
    imp.sheets[0].front.left,
  ];
  assert.equal(validateImposition(imp).valid, false);
  const result = planReprint(imp, '1');
  assert.match(result.error, /未通过校验/);
  assert.ok(result.errors, '应附带校验错误明细');
  assert.equal(result.sheets, undefined);
});

test('补印清单：页码表达式非法时说明原因并拒绝', () => {
  const imp = generateImposition(8);
  assert.match(planReprint(imp, '').error, /请输入/);
  assert.match(planReprint(imp, '9').error, /超出成品页范围 1~8/);
  assert.match(planReprint(imp, 'x').error, /无法识别/);
});

test('补印清单：启用爬移时清单纸张带补偿值', () => {
  const imp = generateImposition(8, null, { thickness: 0.1, cap: 2 });
  const plan = planReprint(imp, '3'); // 第 2 张纸
  assert.equal(plan.sheetCount, 1);
  assert.equal(plan.sheets[0].creep, 0.2);
});

/* ---------- 补印打样 ---------- */

test('补印打样：结构非法返回 null，拼版有错或页码非法说明原因', () => {
  assert.equal(buildReprintProofHtml(null, '1'), null);
  assert.equal(buildReprintProofHtml({ pages: 3, totalPages: 8, sheets: [] }, '1'), null);

  const bad = generateImposition(8);
  [bad.sheets[0].front.left, bad.sheets[0].front.right] = [
    bad.sheets[0].front.right,
    bad.sheets[0].front.left,
  ];
  assert.match(buildReprintProofHtml(bad, '1').error, /未通过校验/);
  assert.match(buildReprintProofHtml(generateImposition(8), '99').error, /超出成品页范围/);
});

test('补印打样：仅含清单纸张，正反面成对并沿用短边翻转镜像', () => {
  // 8 页补印第 3、4 页 → 仅第 2 张纸：正面[6,3] 反面[4,5]
  const { html, plan } = buildReprintProofHtml(generateImposition(8), '3,4');
  assert.equal(plan.sheetCount, 1);
  assert.equal((html.match(/class="sheet-page"/g) || []).length, 2); // 正反面成对
  assert.match(html, /补印打样/);
  assert.match(html, /第 2 张纸（共 2 张） · 正面/);
  assert.match(html, /第 2 张纸（共 2 张） · 反面（左右镜像）/);
  assert.doesNotMatch(html, /第 1 张纸/);
  assert.match(html, /补印命中页：3、4/);

  const front = pageSection(html, 1);
  assert.match(halfContent(front, 'left'), /page-num[^>]*>6</);
  assert.match(halfContent(front, 'right'), /page-num[^>]*>3</);
  // 背面镜像：左半 = 反面右版 5、右半 = 反面左版 4
  const back = pageSection(html, 2);
  assert.match(halfContent(back, 'left'), /page-num[^>]*>5</);
  assert.match(halfContent(back, 'right'), /page-num[^>]*>4</);
  // 沿用对位标与折线
  assert.equal((front.match(/class="reg"/g) || []).length, 4);
  assert.equal((back.match(/class="fold"/g) || []).length, 1);
});

test('补印打样：空白版位与爬移参数沿用既有排版', () => {
  // 6 页：第 1 张 正面[空白,1] 反面[2,空白]
  const blankHtml = buildReprintProofHtml(generateImposition(6), '1').html;
  const front = pageSection(blankHtml, 1);
  assert.match(halfContent(front, 'left'), /blank-label">空白</);
  assert.match(halfContent(front, 'right'), /page-num[^>]*>1</);

  // 爬移：第 2 张 c=0.20，仅页码内容朝折线平移
  const creepHtml = buildReprintProofHtml(
    generateImposition(8, null, { thickness: 0.1, cap: 2 }),
    '3'
  ).html;
  const creepFront = pageSection(creepHtml, 1);
  assert.match(halfContent(creepFront, 'left'), /page-num[^>]*translateX\(0\.20mm\)[^>]*>6</);
  assert.match(halfContent(creepFront, 'right'), /page-num[^>]*translateX\(-0\.20mm\)[^>]*>3</);
  assert.match(creepHtml, /爬移补偿 0\.20 mm/);
});

test('补印打样：分帖仅含命中帖的清单纸张，按帖号及帖内纸张序排列', () => {
  // 10 页 M=2 补印第 1、9 页 → 第 1 帖第 1 张 + 第 2 帖第 1 张
  const { html, plan } = buildReprintProofHtml(generateImposition(10, 2), '9,1');
  assert.equal(plan.sheetCount, 2);
  assert.equal((html.match(/class="sheet-page"/g) || []).length, 4); // 2 张 × 正反
  const titles = [...html.matchAll(/第 (\d) 帖 · 第 (\d) 张纸（帖内共 \d 张） · (正面|反面（左右镜像）)/g)].map(
    (m) => `${m[1]}-${m[2]}-${m[3]}`
  );
  assert.deepEqual(titles, [
    '1-1-正面', '1-1-反面（左右镜像）',
    '2-1-正面', '2-1-反面（左右镜像）',
  ]);
  assert.doesNotMatch(html, /第 1 帖 · 第 2 张纸/);
});
