const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/engine.js');
const D = (s) => Date.UTC(...s.split('-').map((x, i) => i === 1 ? +x - 1 : +x));

const mk = (rows) => rows.map(([c, d, r], i) => ({ orderId: 'o' + i, customerId: c, t: D(d), revenue: r }));

test('parseCSV handles quotes, escaped quotes, CRLF and BOM', () => {
  const p = E.parseCSV('\uFEFFid,name,amt\r\n1,"Smith, Jo",10\r\n2,"say ""hi""",5\r\n\r\n');
  assert.deepEqual(p.headers, ['id', 'name', 'amt']);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].name, 'Smith, Jo');
  assert.equal(p.rows[1].name, 'say "hi"');
});

test('toCSV round-trips through parseCSV', () => {
  const rows = [{ a: 'x,y', b: 'q"z' }, { a: '1', b: '' }];
  const back = E.parseCSV(E.toCSV(['a', 'b'], rows)).rows;
  assert.deepEqual(back, rows);
});

test('detectColumns maps common export headers (Shopify-style and UCI Online Retail)', () => {
  assert.deepEqual(E.detectColumns(['Order ID', 'Customer ID', 'Created At', 'Total']), { customerId: 'Customer ID', orderId: 'Order ID', date: 'Created At', revenue: 'Total' });
  const m = E.detectColumns(['InvoiceNo', 'StockCode', 'InvoiceDate', 'CustomerID', 'Revenue']);
  assert.equal(m.orderId, 'InvoiceNo'); assert.equal(m.customerId, 'CustomerID'); assert.equal(m.date, 'InvoiceDate');
});

test('parseDate reads ISO and DD/MM/YYYY and rejects junk', () => {
  assert.equal(E.parseDate('2026-03-05'), Date.UTC(2026, 2, 5));
  assert.equal(E.parseDate('2026-03-05T10:00:00Z'), Date.UTC(2026, 2, 5));
  assert.equal(E.parseDate('05/03/2026'), Date.UTC(2026, 2, 5));
  assert.equal(E.parseDate('13/13/2026'), null);
  assert.equal(E.parseDate('soon'), null);
});

test('normalizeOrders aggregates line items, drops refunds, reports bad rows', () => {
  const rows = [
    { o: 'A', c: 'c1', d: '2026-01-01', v: '10' }, { o: 'A', c: 'c1', d: '2026-01-01', v: '$5.50' },
    { o: 'B', c: 'c2', d: '2026-01-02', v: '-20' }, { o: 'C', c: '', d: '2026-01-02', v: '3' }, { o: 'D', c: 'c3', d: 'bad', v: '3' }
  ];
  const { orders, errors } = E.normalizeOrders(rows, { orderId: 'o', customerId: 'c', date: 'd', revenue: 'v' });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].revenue, 15.5);
  assert.equal(errors.length, 3);
  assert.match(errors.join(' '), /refund/);
});

test('normalizeOrders reports missing required columns', () => {
  const r = E.normalizeOrders([{ a: 1 }], { customerId: null, date: 'a', revenue: null });
  assert.equal(r.orders.length, 0);
  assert.match(r.errors[0], /customerId.*revenue/);
});

test('quintileScores gives ties the same score and respects direction', () => {
  const s = E.quintileScores([1, 1, 1, 1, 10]);
  assert.equal(new Set(s.slice(0, 4)).size, 1);
  assert.equal(s[4], 5);
  const r = E.quintileScores([1, 2, 3, 4, 5], false);
  assert.deepEqual(r, [5, 4, 3, 2, 1]);
});

test('frequencyScore uses fixed DTC bins', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(f => E.frequencyScore(f)), [1, 2, 3, 4, 4, 5, 5]);
});

test('segmentFor covers the whole R×F grid with sensible corners', () => {
  for (let r = 1; r <= 5; r++) for (let f = 1; f <= 5; f++) assert.ok(E.SEGMENTS[E.segmentFor(r, f)], `R${r}F${f}`);
  assert.equal(E.segmentFor(5, 5), 'champions');
  assert.equal(E.segmentFor(1, 5), 'cantlose');
  assert.equal(E.segmentFor(5, 1), 'new');
  assert.equal(E.segmentFor(1, 1), 'lost');
  assert.equal(E.segmentFor(2, 3), 'atrisk');
});

test('computeRFM computes recency, frequency, monetary and ignores orders on/after asOf', () => {
  const orders = mk([['a', '2026-01-01', 10], ['a', '2026-03-01', 20], ['b', '2025-06-01', 50], ['a', '2026-05-01', 99]]);
  const cs = E.computeRFM(orders, { asOf: D('2026-04-01') });
  const a = cs.find(c => c.id === 'a'), b = cs.find(c => c.id === 'b');
  assert.equal(a.frequency, 2); assert.equal(a.monetary, 30); assert.equal(a.recencyDays, 31);
  assert.ok(a.R > b.R);
  assert.equal(b.F, 1);
  assert.equal(a.rfm.length, 3);
});

test('interPurchaseDays returns the median gap across repeat buyers', () => {
  const cs = E.computeRFM(mk([['a', '2026-01-01', 1], ['a', '2026-01-11', 1], ['a', '2026-02-10', 1], ['b', '2026-01-01', 1], ['b', '2026-01-21', 1]]), { asOf: D('2026-03-01') });
  const g = E.interPurchaseDays(cs);
  assert.equal(g.n, 3); assert.equal(g.median, 20);
});

test('segmentStats shares sum to 1', () => {
  const d = E.syntheticOrders(); const { orders } = E.normalizeOrders(d.orders, E.detectColumns(Object.keys(d.orders[0])));
  const st = E.segmentStats(E.computeRFM(orders, { asOf: d.asOf }));
  const s = Object.values(st);
  assert.ok(Math.abs(s.reduce((a, x) => a + x.share, 0) - 1) < 0.002);
  assert.ok(Math.abs(s.reduce((a, x) => a + x.revenueShare, 0) - 1) < 0.002);
});

test('cohortRetention computes monthly retention and blanks future months', () => {
  const orders = mk([
    ['a', '2026-01-05', 10], ['a', '2026-02-05', 10], ['b', '2026-01-09', 10], ['b', '2026-03-01', 10],
    ['c', '2026-02-02', 10], ['c', '2026-03-03', 10], ['d', '2026-03-10', 10]
  ]);
  const co = E.cohortRetention(orders, { asOf: D('2026-03-20'), maxMonths: 3 });
  assert.deepEqual(co.rows.map(r => r.cohort), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(co.rows[0].cells, [1, 0.5, 0.5, null]);
  assert.deepEqual(co.rows[1].cells, [1, 1, null, null]);
  assert.equal(co.rows[2].partial, true);
  assert.equal(co.avg[1], round((0.5 * 2 + 1 * 1) / 3));
  function round(x) { return Math.round(x * 1e4) / 1e4; }
});

test('clv follows AOV × frequency × margin × lifespan and honours overrides', () => {
  const cs = E.computeRFM(mk([['a', '2025-01-01', 100], ['a', '2025-07-01', 100], ['a', '2026-01-01', 100], ['b', '2025-01-01', 100]]), { asOf: D('2026-01-02') });
  const r = E.clv(cs, { margin: 0.5, lifespanYears: 2 });
  assert.equal(r.aov, 100);
  assert.ok(Math.abs(r.clv - 100 * r.ordersPerYear * 0.5 * 2) < 1);
  assert.equal(r.periodChurn, 0.5); // b lapsed, a active
  assert.equal(r.maxCac, Math.round(r.clv / 3 * 100) / 100);
  const est = E.clv(cs, { margin: 0.5 });
  assert.ok(est.lifespanYears >= 0.5 && est.lifespanYears <= 5);
});

test('normInv and sampleSizePerGroup match textbook values', () => {
  assert.ok(Math.abs(E.normInv(0.975) - 1.95996) < 1e-4);
  assert.ok(Math.abs(E.normInv(0.8) - 0.84162) < 1e-4);
  const n = E.sampleSizePerGroup(0.1, 0.12);
  assert.ok(n > 3800 && n < 3900, String(n)); // ≈3841
  assert.equal(E.sampleSizePerGroup(0.1, 0.1), Infinity);
});

test('mde shrinks as the holdout grows', () => {
  assert.ok(E.mde(0.1, 1000, 9000) < E.mde(0.1, 100, 900));
  assert.equal(E.mde(0.1, 0, 100), Infinity);
});

test('planCampaigns enforces the margin guardrail and ranks by net profit', () => {
  const stats = E.segmentStats(E.computeRFM(E.normalizeOrders(E.syntheticOrders().orders, { orderId: 'order_id', customerId: 'customer_id', date: 'order_date', revenue: 'revenue' }).orders, { asOf: E.syntheticOrders().asOf }));
  const plans = E.planCampaigns(stats, { margin: 0.4, minMarginAfterDiscount: 0.32, maxDiscount: 0.2 });
  plans.forEach(p => assert.ok(p.discount <= 0.08 + 1e-9, p.segment));
  for (let i = 1; i < plans.length; i++) assert.ok(plans[i - 1].netIncrementalProfit >= plans[i].netIncrementalProfit);
  assert.deepEqual(plans.map(p => p.priority), plans.map((_, i) => i + 1));
  const champ = plans.find(p => p.key === 'champions');
  assert.equal(champ.discount, 0);
  assert.match(champ.program, /VIP/);
});

test('planCampaigns marks a segment testable only when the holdout is big enough', () => {
  const big = { atrisk: { name: 'At Risk', customers: 200000, aov: 50 } };
  const small = { atrisk: { name: 'At Risk', customers: 300, aov: 50 } };
  assert.equal(E.planCampaigns(big, { holdoutShare: 0.1 })[0].testable, true);
  const s = E.planCampaigns(small, { holdoutShare: 0.1 })[0];
  assert.equal(s.testable, false);
  assert.match(s.testNote, /pool/);
});

test('detectAngles ignores merge tags and finds the main angle', () => {
  assert.equal(E.detectAngles('{first_name}, early access for VIP members').top, 'exclusivity');
  assert.equal(E.detectAngles('We miss you, come back').top, 'winback');
  assert.equal(E.detectAngles('20% off this weekend').top, 'discount');
  assert.equal(E.detectAngles('Quarterly update').matched, false);
});

test('scoreSubject rewards good lines and penalises spammy, discount-led lines to VIPs', () => {
  const good = E.scoreSubject('{first_name}, early access to our new winter blend', 'champions');
  const bad = E.scoreSubject('50% OFF EVERYTHING!!! Act now', 'champions');
  assert.ok(good.score >= 70, String(good.score));
  assert.ok(bad.score < 40, String(bad.score));
  assert.ok(bad.flags.some(f => /margin leak/.test(f)));
  assert.ok(bad.flags.some(f => /ALL-CAPS/.test(f)));
  assert.equal(E.scoreSubject('', 'new').score, 0);
});

test('scoreSubject is segment-aware: win-back angle fits At Risk better than Champions', () => {
  const l = 'It’s been a while, {first_name}. Come back for your favourite';
  assert.ok(E.scoreSubject(l, 'atrisk').score > E.scoreSubject(l, 'champions').score);
});

test('scoreSubject flags long lines that get truncated on mobile', () => {
  const r = E.scoreSubject('This is an extremely long subject line that will definitely be truncated by the inbox on a phone', 'new');
  assert.ok(r.flags.some(f => /cut off/.test(f)));
});

test('draftSubjects returns 5 segment-fit template lines that use the brand', () => {
  const d = E.draftSubjects('new', { brand: 'Kettle & Kin', product: 'tea' });
  assert.equal(d.length, 5);
  assert.ok(d.some(x => x.line.includes('Kettle & Kin')));
  d.forEach(x => assert.ok(E.SEGMENT_FIT.new.includes(x.angle)));
});

test('synthetic demo is deterministic, fictional and realistic', () => {
  const a = E.syntheticCSV(), b = E.syntheticCSV();
  assert.equal(a, b);
  const d = E.syntheticOrders();
  assert.equal(d.brand, 'Kettle & Kin');
  const { orders } = E.normalizeOrders(d.orders, E.detectColumns(Object.keys(d.orders[0])));
  const s = E.summarize(orders, d.asOf);
  assert.ok(s.customers > 1500 && s.orders > s.customers);
  assert.ok(s.repeatRate > 0.2 && s.repeatRate < 0.5);
  assert.ok(s.aov > 35 && s.aov < 65);
  assert.ok(orders.every(o => o.t < d.asOf));
});

test('end-to-end: readout, plan markdown and customer CSV export', () => {
  const d = E.syntheticOrders();
  const { orders } = E.normalizeOrders(d.orders, E.detectColumns(Object.keys(d.orders[0])));
  const cs = E.computeRFM(orders, { asOf: d.asOf });
  const stats = E.segmentStats(cs);
  const plans = E.planCampaigns(stats, {});
  const ro = E.readout({ summary: E.summarize(orders, d.asOf), stats, cohorts: E.cohortRetention(orders, { asOf: d.asOf }), clvRes: E.clv(cs), plans });
  assert.ok(ro.length >= 5);
  assert.match(ro.join(' '), /CLV/);
  const md = E.planMarkdown(plans, { brand: d.brand, readout: ro });
  assert.match(md, /\| 1 \|/);
  assert.equal(md.split('\n').filter(l => /^\| \d+ \|/.test(l)).length, plans.length);
  const csv = E.parseCSV(E.customersCSV(cs));
  assert.equal(csv.rows.length, cs.length);
  assert.ok(csv.headers.includes('segment'));
});

test('aiFitScore and blendScore weight the segment-fit angles and stay in range', () => {
  const winbackHeavy = { winback: 0.8, discount: 0.1, product: 0.1 };
  assert.ok(E.aiFitScore(winbackHeavy, 'atrisk') > E.aiFitScore(winbackHeavy, 'champions'));
  assert.ok(E.aiFitScore({ winback: 1, discount: 1, urgency: 1 }, 'atrisk') <= 1);
  assert.equal(E.blendScore(80, 1), 85);
  assert.equal(E.blendScore(80, 0), 60);
  assert.equal(E.blendScore(100, 5), 100);
  const bank = E.subjectBank({ brand: 'Kettle & Kin' });
  assert.equal(Object.values(bank).flat().length, 21);
});

test('US-style MM/DD dates (e.g. UCI Online Retail exports) are detected and parsed', () => {
  assert.equal(E.guessDateOrder(['12/1/2010 8:26', '12/13/2010 9:00']), 'mdy');
  assert.equal(E.guessDateOrder(['25/03/2026', '01/04/2026']), 'dmy');
  assert.equal(E.parseDate('12/13/2010 9:00', 'mdy'), Date.UTC(2010, 11, 13));
  const { orders } = E.normalizeOrders([{ c: 'x', d: '12/13/2010 9:00', v: '5' }, { c: 'x', d: '1/2/2011 9:00', v: '5' }], { customerId: 'c', date: 'd', revenue: 'v' });
  assert.equal(E.ymd(orders[1].t), '2011-01-02');
});
