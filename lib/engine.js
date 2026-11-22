/* RetainRadar engine — dependency-free CRM / lifecycle analytics.
 * Works in the browser (window.RR) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400000;

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = []; let row = []; let field = ''; let q = false;
    text = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field); if (row.some(v => v.trim() !== '')) rows.push(row);
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map(h => h.trim());
    return { headers, rows: rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
  }

  function toCSV(headers, rows) {
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
  }

  const COLUMN_HINTS = {
    customerId: ['customer_id', 'customerid', 'customer', 'client_id', 'email', 'user_id', 'buyer'],
    orderId: ['order_id', 'orderid', 'order', 'invoice', 'invoiceno', 'invoice_no', 'transaction_id'],
    date: ['order_date', 'date', 'created_at', 'invoicedate', 'invoice_date', 'purchased_at', 'timestamp'],
    revenue: ['revenue', 'order_value', 'total', 'amount', 'net_sales', 'sales', 'value', 'price']
  };
  function detectColumns(headers) {
    const norm = h => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const map = {};
    for (const [key, hints] of Object.entries(COLUMN_HINTS)) {
      let found = null;
      for (const hint of hints) { found = headers.find(h => norm(h) === hint); if (found) break; }
      if (!found) for (const hint of hints) { found = headers.find(h => norm(h).includes(hint) && !Object.values(map).includes(h)); if (found) break; }
      map[key] = found || null;
    }
    return map;
  }

  function parseDate(s, order = 'dmy') {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); // DD/MM/YYYY (AU/IN default) or MM/DD/YYYY
    if (m) { const d = order === 'mdy' ? +m[2] : +m[1], mo = order === 'mdy' ? +m[1] : +m[2]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return Date.UTC(+m[3], mo - 1, d); }
    return null;
  }

  // Guess slash-date order from the data: any first part > 12 means DD/MM, any second part > 12 means MM/DD
  function guessDateOrder(values) {
    let dmy = 0, mdy = 0;
    for (const v of values) { const m = String(v).match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-]\d{4}/); if (!m) continue; if (+m[1] > 12) dmy++; if (+m[2] > 12) mdy++; }
    return mdy > dmy ? 'mdy' : 'dmy';
  }

  function normalizeOrders(rows, map, opts = {}) {
    const order = opts.dateOrder || guessDateOrder(rows.slice(0, 2000).map(r => map.date ? r[map.date] : ''));
    const errors = []; const orders = []; const seen = new Map();
    if (!map.customerId || !map.date || !map.revenue) return { orders, errors: ['Missing required column(s): ' + ['customerId', 'date', 'revenue'].filter(k => !map[k]).join(', ')] };
    rows.forEach((r, i) => {
      const cid = r[map.customerId]; const t = parseDate(r[map.date], order);
      const rev = parseFloat(String(r[map.revenue]).replace(/[^0-9.\-]/g, ''));
      if (!cid) return errors.push(`Row ${i + 2}: missing customer`);
      if (t == null) return errors.push(`Row ${i + 2}: unreadable date "${r[map.date]}"`);
      if (!isFinite(rev)) return errors.push(`Row ${i + 2}: unreadable revenue`);
      const oid = map.orderId ? r[map.orderId] : `row${i}`;
      // multiple line items per order (e.g. UCI Online Retail) are aggregated to one order
      const key = cid + '|' + oid;
      if (map.orderId && seen.has(key)) { seen.get(key).revenue += rev; return; }
      const o = { orderId: oid, customerId: cid, t, revenue: rev };
      seen.set(key, o); orders.push(o);
    });
    const kept = orders.filter(o => o.revenue > 0); // drop refunds / zero orders
    if (kept.length < orders.length) errors.push(`${orders.length - kept.length} order(s) with zero/negative value excluded (refunds).`);
    kept.sort((a, b) => a.t - b.t);
    return { orders: kept, errors };
  }

  // ---------- helpers ----------
  const ymd = t => new Date(t).toISOString().slice(0, 10);
  const monthKey = t => new Date(t).toISOString().slice(0, 7);
  const monthIndex = t => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sum = a => a.reduce((x, y) => x + y, 0);
  const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

  function summarize(orders, asOf) {
    const customers = new Set(orders.map(o => o.customerId));
    const revenue = sum(orders.map(o => o.revenue));
    const per = new Map(); orders.forEach(o => per.set(o.customerId, (per.get(o.customerId) || 0) + 1));
    const repeaters = [...per.values()].filter(n => n >= 2).length;
    return {
      orders: orders.length, customers: customers.size, revenue: round(revenue),
      aov: orders.length ? round(revenue / orders.length) : 0,
      ordersPerCustomer: customers.size ? round(orders.length / customers.size) : 0,
      repeatRate: customers.size ? round(repeaters / customers.size, 4) : 0,
      firstDate: orders.length ? ymd(orders[0].t) : null,
      lastDate: orders.length ? ymd(orders[orders.length - 1].t) : null,
      asOf: ymd(asOf ?? defaultAsOf(orders))
    };
  }
  const defaultAsOf = orders => orders.length ? Math.max(...orders.map(o => o.t)) + DAY : Date.now();

  // ---------- RFM ----------
  // Percentile score 1..5 using average rank for ties (so equal values always get equal scores).
  function quintileScores(values, higherIsBetter = true) {
    const n = values.length; const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const scores = new Array(n); let i = 0;
    while (i < n) {
      let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avgRank = (i + j) / 2 + 1; // 1-based
      let s = Math.min(5, Math.max(1, Math.ceil((avgRank / n) * 5)));
      if (!higherIsBetter) s = 6 - s;
      for (let k = i; k <= j; k++) scores[idx[k][1]] = s;
      i = j + 1;
    }
    return scores;
  }
  const DEFAULT_F_BINS = [1, 2, 3, 5]; // F=1 → 1 order, 2 → 2, 3 → 3, 4 → 4-5, 5 → 6+
  function frequencyScore(f, bins = DEFAULT_F_BINS) { let s = 1; for (let i = 0; i < bins.length; i++) if (f > bins[i]) s = i + 2; return Math.min(5, s); }

  const SEGMENTS = {
    champions: { name: 'Champions', color: '#1f9d63', desc: 'Bought recently and often. Your best customers.' },
    loyal: { name: 'Loyal', color: '#2bb3a3', desc: 'Repeat buyers who are still engaged.' },
    potential: { name: 'Potential Loyalists', color: '#3d8bd6', desc: 'Recent second-time buyers. The habit is forming.' },
    new: { name: 'New Customers', color: '#5b3df5', desc: 'First order very recently.' },
    promising: { name: 'Promising', color: '#8a6cf7', desc: 'First order fairly recently, no repeat yet.' },
    attention: { name: 'Need Attention', color: '#e0b21e', desc: 'Repeat buyers going quiet.' },
    sleep: { name: 'About to Sleep', color: '#e08a1e', desc: 'One-time buyers drifting away.' },
    atrisk: { name: 'At Risk', color: '#d9603b', desc: 'Used to buy a few times; long gap since.' },
    cantlose: { name: "Can't Lose Them", color: '#d6365a', desc: 'Former high-frequency buyers who have lapsed.' },
    hibernating: { name: 'Hibernating', color: '#8d8a99', desc: 'Low frequency and a long gap.' },
    lost: { name: 'Lost', color: '#5d5a6b', desc: 'One order, long ago.' }
  };
  // R (1-5) × F (1-5) grid → segment key
  function segmentFor(R, F) {
    if (F >= 4) return R >= 4 ? 'champions' : R === 3 ? 'loyal' : 'cantlose';
    if (F === 3) return R >= 4 ? 'loyal' : R === 3 ? 'attention' : 'atrisk';
    if (F === 2) return R >= 4 ? 'potential' : R === 3 ? 'attention' : R === 2 ? 'atrisk' : 'hibernating';
    return R === 5 ? 'new' : R === 4 ? 'promising' : R === 3 ? 'sleep' : R === 2 ? 'hibernating' : 'lost';
  }

  function computeRFM(orders, opts = {}) {
    const asOf = opts.asOf ?? defaultAsOf(orders);
    const by = new Map();
    for (const o of orders) {
      if (o.t >= asOf) continue;
      let c = by.get(o.customerId);
      if (!c) by.set(o.customerId, c = { id: o.customerId, first: o.t, last: o.t, frequency: 0, monetary: 0, dates: [] });
      c.first = Math.min(c.first, o.t); c.last = Math.max(c.last, o.t); c.frequency++; c.monetary += o.revenue; c.dates.push(o.t);
    }
    const cs = [...by.values()];
    cs.forEach(c => { c.recencyDays = Math.floor((asOf - c.last) / DAY); c.tenureDays = Math.floor((asOf - c.first) / DAY); c.monetary = round(c.monetary); });
    const R = quintileScores(cs.map(c => c.recencyDays), false);
    const M = quintileScores(cs.map(c => c.monetary), true);
    cs.forEach((c, i) => {
      c.R = R[i]; c.F = frequencyScore(c.frequency, opts.fBins); c.M = M[i];
      c.rfm = `${c.R}${c.F}${c.M}`; c.segment = segmentFor(c.R, c.F); c.highValue = c.M >= 4;
    });
    return cs;
  }

  // Median days between consecutive orders across repeat customers
  function interPurchaseDays(customers) {
    const gaps = [];
    customers.forEach(c => { const d = [...c.dates].sort((a, b) => a - b); for (let i = 1; i < d.length; i++) gaps.push((d[i] - d[i - 1]) / DAY); });
    return { median: gaps.length ? round(median(gaps), 1) : null, n: gaps.length, p75: gaps.length ? round([...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.75)], 1) : null };
  }

  function segmentStats(customers, totalRevenueOverride) {
    const total = totalRevenueOverride ?? sum(customers.map(c => c.monetary));
    const out = {};
    for (const key of Object.keys(SEGMENTS)) {
      const g = customers.filter(c => c.segment === key);
      const orders = sum(g.map(c => c.frequency)), rev = sum(g.map(c => c.monetary));
      out[key] = {
        key, ...SEGMENTS[key], customers: g.length,
        share: customers.length ? round(g.length / customers.length, 4) : 0,
        revenue: round(rev), revenueShare: total ? round(rev / total, 4) : 0,
        aov: orders ? round(rev / orders) : 0, avgOrders: g.length ? round(orders / g.length) : 0,
        avgRecency: g.length ? Math.round(sum(g.map(c => c.recencyDays)) / g.length) : 0,
        highValue: g.filter(c => c.highValue).length
      };
    }
    return out;
  }

  // ---------- Cohorts ----------
  function cohortRetention(orders, opts = {}) {
    const asOf = opts.asOf ?? defaultAsOf(orders);
    const lastIdx = monthIndex(asOf - 1);
    const first = new Map(); const active = new Map(); // cid -> Set(monthIdx)
    for (const o of orders) {
      if (o.t >= asOf) continue;
      const mi = monthIndex(o.t);
      if (!first.has(o.customerId) || mi < first.get(o.customerId)) first.set(o.customerId, mi);
      if (!active.has(o.customerId)) active.set(o.customerId, new Set());
      active.get(o.customerId).add(mi);
    }
    const cohorts = new Map();
    for (const [cid, fm] of first) { if (!cohorts.has(fm)) cohorts.set(fm, []); cohorts.get(fm).push(cid); }
    const keys = [...cohorts.keys()].sort((a, b) => a - b);
    const maxK = opts.maxMonths ?? 12;
    const rows = keys.map(fm => {
      const ids = cohorts.get(fm); const size = ids.length; const cells = [];
      for (let k = 0; k <= maxK; k++) {
        if (fm + k > lastIdx) { cells.push(null); continue; }
        const n = ids.filter(id => active.get(id).has(fm + k)).length;
        cells.push(round(n / size, 4));
      }
      const y = Math.floor(fm / 12), m = fm % 12;
      return { cohort: `${y}-${String(m + 1).padStart(2, '0')}`, size, cells, partial: fm === lastIdx };
    });
    // size-weighted average curve (only cohorts that have reached month k)
    const avg = [];
    for (let k = 0; k <= maxK; k++) {
      let w = 0, s = 0; rows.forEach(r => { if (r.cells[k] != null) { w += r.size; s += r.cells[k] * r.size; } });
      avg.push(w ? round(s / w, 4) : null);
    }
    return { rows, avg, maxMonths: maxK };
  }

  // ---------- CLV ----------
  // Simple, explainable CLV: AOV × orders/year × gross margin × expected lifespan (years).
  // Churn is estimated as the share of "mature" customers (first order > churnWindow ago) with no order in the last churnWindow days.
  function clv(customers, opts = {}) {
    const margin = opts.margin ?? 0.6, windowDays = opts.churnWindowDays ?? 180;
    const orders = sum(customers.map(c => c.frequency)), rev = sum(customers.map(c => c.monetary));
    const aov = orders ? rev / orders : 0;
    const mature = customers.filter(c => c.tenureDays >= windowDays);
    const churned = mature.filter(c => c.recencyDays >= windowDays).length;
    const periodChurn = mature.length ? churned / mature.length : null;
    // annual churn from per-window churn
    const annualChurn = periodChurn == null ? null : 1 - Math.pow(1 - Math.min(periodChurn, 0.999), 365 / windowDays);
    const lifespanYears = opts.lifespanYears ?? (annualChurn ? Math.min(5, Math.max(0.5, 1 / annualChurn)) : 1);
    // orders per active year: per customer, orders / max(tenure in years, 1/4)
    const freq = customers.length ? sum(customers.map(c => c.frequency / Math.max(c.tenureDays / 365, 0.25))) / customers.length : 0;
    const value = aov * freq * margin * lifespanYears;
    return {
      aov: round(aov), ordersPerYear: round(freq), margin, periodChurn: periodChurn == null ? null : round(periodChurn, 4),
      annualChurn: annualChurn == null ? null : round(annualChurn, 4), lifespanYears: round(lifespanYears), clv: round(value),
      matureCustomers: mature.length, churnWindowDays: windowDays,
      maxCac: round(value / (opts.targetLtvCac ?? 3))
    };
  }

  // Forward 12-month gross profit by segment using segment-level "stay active" assumptions.
  const STAY_PROB = { champions: 0.85, loyal: 0.7, potential: 0.55, new: 0.4, promising: 0.3, attention: 0.4, sleep: 0.15, atrisk: 0.25, cantlose: 0.3, hibernating: 0.08, lost: 0.04 };
  function segmentValue(customers, opts = {}) {
    const margin = opts.margin ?? 0.6; const out = {};
    for (const key of Object.keys(SEGMENTS)) {
      const g = customers.filter(c => c.segment === key); if (!g.length) { out[key] = { customers: 0, next12GrossProfit: 0, perCustomer: 0 }; continue; }
      const orders = sum(g.map(c => c.frequency)), aov = sum(g.map(c => c.monetary)) / orders;
      const opy = sum(g.map(c => c.frequency / Math.max(c.tenureDays / 365, 0.25))) / g.length;
      const per = aov * Math.min(opy, 12) * STAY_PROB[key] * margin;
      out[key] = { customers: g.length, stayProb: STAY_PROB[key], perCustomer: round(per), next12GrossProfit: round(per * g.length) };
    }
    return out;
  }

  // ---------- Stats ----------
  function normInv(p) { // Acklam approximation
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) return -normInv(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  // per-group n to detect p1 → p2 (two-sided alpha, power)
  function sampleSizePerGroup(p1, p2, alpha = 0.05, power = 0.8) {
    if (p1 === p2) return Infinity;
    const za = normInv(1 - alpha / 2), zb = normInv(power), pb = (p1 + p2) / 2;
    return Math.ceil(Math.pow(za * Math.sqrt(2 * pb * (1 - pb)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)), 2) / Math.pow(p2 - p1, 2));
  }

  // minimum detectable absolute lift for given control/treatment sizes
  function mde(p, nControl, nTreat, alpha = 0.05, power = 0.8) {
    if (!nControl || !nTreat) return Infinity;
    return (normInv(1 - alpha / 2) + normInv(power)) * Math.sqrt(p * (1 - p) * (1 / nControl + 1 / nTreat));
  }

  // ---------- Lifecycle planner ----------
  const PLAYBOOK = {
    champions: { program: 'VIP & advocacy', goal: 'Keep them buying, turn them into referrers', offer: 'none', baseRate: 0.35, lift: 0.04, angle: 'exclusivity', channel: 'Email + SMS early access', kpi: 'Repeat rate, referrals', sends: 2 },
    loyal: { program: 'Loyalty & cross-sell', goal: 'Grow basket and frequency', offer: 'value-add', baseRate: 0.25, lift: 0.04, angle: 'product', channel: 'Email + onsite recs', kpi: 'AOV, orders per customer', sends: 2 },
    potential: { program: 'Habit builder (3rd order)', goal: 'Get the third order', offer: 'small', baseRate: 0.18, lift: 0.04, angle: 'product', channel: 'Email flow + replenishment reminder', kpi: '3rd-order rate', sends: 3 },
    new: { program: 'Onboarding / welcome series', goal: 'Get the second order', offer: 'small', baseRate: 0.12, lift: 0.03, angle: 'welcome', channel: 'Email welcome flow (4 touches)', kpi: '2nd-order rate within 60 days', sends: 4 },
    promising: { program: 'Second-order nudge', goal: 'Convert to repeat buyer', offer: 'small', baseRate: 0.08, lift: 0.03, angle: 'social proof', channel: 'Email + paid social retargeting', kpi: '2nd-order rate', sends: 2 },
    attention: { program: 'Re-engage', goal: 'Restart purchasing before they lapse', offer: 'value-add', baseRate: 0.1, lift: 0.03, angle: 'product', channel: 'Email + SMS', kpi: 'Reactivation rate', sends: 2 },
    sleep: { program: 'Early win-back', goal: 'Bring back before they forget you', offer: 'medium', baseRate: 0.04, lift: 0.02, angle: 'winback', channel: 'Email', kpi: 'Reactivation rate', sends: 2 },
    atrisk: { program: 'Win-back', goal: 'Reactivate lapsed repeat buyers', offer: 'medium', baseRate: 0.05, lift: 0.03, angle: 'winback', channel: 'Email + SMS + paid custom audience', kpi: 'Reactivation rate, CAC saved', sends: 3 },
    cantlose: { program: 'High-touch win-back', goal: 'Rescue formerly high-frequency buyers', offer: 'medium', baseRate: 0.07, lift: 0.04, angle: 'winback', channel: 'Personal email from founder + SMS', kpi: 'Reactivation rate, revenue recovered', sends: 3 },
    hibernating: { program: 'Low-cost reactivation', goal: 'Test cheaply, suppress non-responders', offer: 'medium', baseRate: 0.02, lift: 0.01, angle: 'urgency', channel: 'Email only (deliverability-safe)', kpi: 'Reactivation rate, list health', sends: 1 },
    lost: { program: 'Sunset / list hygiene', goal: 'Last-chance message, then suppress', offer: 'none', baseRate: 0.01, lift: 0.005, angle: 'winback', channel: 'One email, then suppress', kpi: 'Unsubscribe/bounce rate', sends: 1 }
  };
  const OFFER_DEPTH = { none: 0, 'value-add': 0, small: 0.1, medium: 0.15 };

  function planCampaigns(stats, opts = {}) {
    const margin = opts.margin ?? 0.6, maxDiscount = opts.maxDiscount ?? 0.2, minMargin = opts.minMarginAfterDiscount ?? 0.35;
    const costPerSend = opts.costPerSend ?? 0.01, holdout = opts.holdoutShare ?? 0.1, gap = opts.medianGapDays ?? 45;
    const plans = [];
    for (const [key, s] of Object.entries(stats)) {
      if (!s.customers) continue;
      const p = PLAYBOOK[key];
      let disc = OFFER_DEPTH[p.offer];
      disc = Math.min(disc, maxDiscount, Math.max(0, margin - minMargin)); // margin guardrail
      const timing = {
        champions: 'Ongoing: early access each launch', loyal: `~${Math.round(gap * 0.8)} days after last order`,
        potential: `Day ${Math.round(gap * 0.7)} after 2nd order (replenishment)`, new: 'Day 0, 3, 7, 14 after first order',
        promising: `Day ${Math.round(gap)} after first order`, attention: `When gap passes ${Math.round(gap * 1.5)} days`,
        sleep: `When gap passes ${Math.round(gap * 2)} days`, atrisk: `When gap passes ${Math.round(gap * 2.5)} days`,
        cantlose: 'Now, then 7 days later', hibernating: 'Quarterly test', lost: 'Once, then suppress after 30 days'
      }[key];
      const treated = Math.round(s.customers * (1 - holdout));
      const incOrders = treated * p.lift;
      const aov = s.aov || 0;
      const grossProfit = incOrders * aov * (margin - disc);
      // discount also given away to customers who would have bought anyway (baseline buyers)
      const subsidy = disc > 0 ? treated * p.baseRate * aov * disc : 0;
      const cost = treated * p.sends * costPerSend;
      const net = grossProfit - subsidy - cost;
      const nNeeded = sampleSizePerGroup(p.baseRate, p.baseRate + p.lift);
      const holdoutN = Math.round(s.customers * holdout);
      const mdePts = mde(p.baseRate, holdoutN, treated);
      plans.push({
        key, segment: s.name, customers: s.customers, program: p.program, goal: p.goal, angle: p.angle, channel: p.channel, kpi: p.kpi,
        timing, offer: disc > 0 ? `${Math.round(disc * 100)}% off (margin guardrail ${Math.round(minMargin * 100)}%)` : (p.offer === 'value-add' ? 'Value-add (free sample / early access), no discount' : 'No discount'),
        discount: disc, baseRate: p.baseRate, assumedLift: p.lift, incrementalOrders: round(incOrders, 1),
        netIncrementalProfit: round(net), holdoutN, neededPerGroup: nNeeded, mdePts: isFinite(mdePts) ? round(mdePts * 100, 1) : null,
        testable: holdoutN >= nNeeded,
        testNote: holdoutN >= nNeeded ? `Holdout of ${holdoutN} can detect a ${Math.round(p.lift * 1000) / 10}-pt lift` : `One send can only detect ≥${isFinite(mdePts) ? round(mdePts * 100, 1) : '∞'} pts (assumed lift ${Math.round(p.lift * 1000) / 10} pts, needs ${nNeeded.toLocaleString('en')}/group). Run as an always-on flow and pool months`
      });
    }
    plans.sort((a, b) => b.netIncrementalProfit - a.netIncrementalProfit);
    plans.forEach((p, i) => { p.priority = i + 1; });
    return plans;
  }

  // ---------- Subject-line lab (rule-based) ----------
  const ANGLES = {
    welcome: { label: 'Welcome / onboarding', words: ['welcome', 'getting started', 'start', 'first', 'hello', 'meet', 'how to', 'guide', 'thanks for', 'new here', 'brew guide'] },
    exclusivity: { label: 'Exclusivity / VIP', words: ['vip', 'exclusive', 'early access', 'members', 'insider', 'first look', 'just for you', 'invite', 'private', 'reserved', 'thank you'] },
    winback: { label: 'We miss you / win-back', words: ['miss you', 'been a while', 'come back', 'still there', 'where have you', 'we saved', 'it’s been', "it's been", 'remember', 'goodbye', 'last chance to stay'] },
    urgency: { label: 'Urgency / scarcity', words: ['ends', 'tonight', 'last chance', 'hurry', 'only', 'left', 'final', 'hours', 'today only', 'limited'] },
    discount: { label: 'Discount / deal', words: ['% off', 'off', 'sale', 'save', 'deal', 'discount', 'free shipping', 'code', 'coupon', '$', '₹'] },
    product: { label: 'Product / education', words: ['new', 'restock', 'back in stock', 'recipe', 'tips', 'how', 'pairs', 'flavour', 'flavor', 'blend', 'your next', 'refill', 'running low'] },
    'social proof': { label: 'Social proof', words: ['reviews', 'loved', 'best-selling', 'bestselling', 'favourite', 'favorite', 'customers', 'people', 'rated', 'most popular'] }
  };
  const SEGMENT_FIT = {
    champions: ['exclusivity', 'product', 'social proof'], loyal: ['product', 'exclusivity', 'social proof'],
    potential: ['product', 'social proof', 'welcome'], new: ['welcome', 'product', 'social proof'],
    promising: ['social proof', 'product', 'discount'], attention: ['product', 'winback', 'social proof'],
    sleep: ['winback', 'discount', 'product'], atrisk: ['winback', 'discount', 'urgency'],
    cantlose: ['winback', 'exclusivity', 'discount'], hibernating: ['discount', 'urgency', 'winback'], lost: ['winback', 'urgency', 'discount']
  };
  const SPAM = ['free!!!', '100% free', 'act now', 'guaranteed', 'risk-free', 'click here', 'winner', 'cash', 'urgent', '$$$', 'no catch', 'buy now'];
  const DISCOUNT_SENSITIVE = ['champions', 'loyal'];

  function detectAngles(text) {
    // strip merge tags like {first_name} so they don't count as words
    const t = ' ' + String(text).toLowerCase().replace(/\{\{?[^}]*\}?\}|\[[^\]]*\]/g, ' ') + ' ';
    const hits = {};
    for (const [k, a] of Object.entries(ANGLES)) {
      const n = a.words.filter(w => w === 'off' ? /\boff\b/.test(t) : w === 'only' ? /\bonly\b/.test(t) : w === 'new' ? /\bnew\b/.test(t) : t.includes(w)).length;
      if (n) hits[k] = n;
    }
    if (/\d+\s?%/.test(t) && !hits.discount) hits.discount = 1;
    const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    return { top: ranked[0] || 'product', all: ranked, matched: ranked.length > 0 };
  }

  function scoreSubject(line, segmentKey, opts = {}) {
    const s = String(line || '').trim(); const flags = []; const tips = []; let score = 50;
    const len = [...s].length;
    if (len === 0) return { line: s, score: 0, angle: null, flags: ['Empty'], tips: [], length: 0 };
    if (len >= 25 && len <= 50) { score += 12; } else if (len < 25) { score += 2; tips.push('Very short. Add a concrete benefit or product name.'); } else if (len <= 70) { score -= 4; flags.push(`${len} chars, may be cut off on mobile (aim ≤ 50)`); } else { score -= 14; flags.push(`${len} chars, will be cut off on most inboxes`); }
    if (/\{\{?\s*(first_?name|name)\s*\}?\}|\[first ?name\]/i.test(s)) { score += 8; } else tips.push('Try personalisation, e.g. {first_name} or their last product.');
    if (/\d/.test(s)) score += 5;
    if (/\?$/.test(s)) score += 3;
    const emojis = (s.match(/\p{Extended_Pictographic}/gu) || []).length;
    if (emojis === 1) score += 2; else if (emojis > 1) { score -= 6; flags.push(`${emojis} emojis, looks spammy`); }
    const caps = s.split(/\s+/).filter(w => w.length > 3 && /^[A-Z0-9%!]+$/.test(w) && /[A-Z]/.test(w));
    if (caps.length) { score -= 8 * Math.min(caps.length, 2); flags.push('ALL-CAPS words: ' + caps.join(', ')); }
    if (/!{2,}/.test(s)) { score -= 8; flags.push('Multiple exclamation marks'); }
    const lower = s.toLowerCase(); const spam = SPAM.filter(w => lower.includes(w));
    if (spam.length) { score -= 10 * spam.length; flags.push('Spam-trigger phrase: ' + spam.join(', ')); }
    const ang = detectAngles(s);
    const fit = SEGMENT_FIT[segmentKey] || [];
    const fitRank = fit.indexOf(ang.top);
    if (ang.matched && fitRank === 0) score += 14; else if (ang.matched && fitRank > 0) score += 8; else if (ang.matched) { score -= 6; tips.push(`Angle "${ANGLES[ang.top].label}" is a weak fit for ${SEGMENTS[segmentKey] ? SEGMENTS[segmentKey].name : 'this segment'}; try ${fit.slice(0, 2).map(a => ANGLES[a].label).join(' or ')}.`); }
    else tips.push('No clear angle detected. Lead with one clear reason to open.');
    if (DISCOUNT_SENSITIVE.includes(segmentKey) && ang.all.includes('discount')) { score -= 10; flags.push('Discount-led line to a high-intent segment trains them to wait for sales (margin leak)'); }
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { line: s, score, angle: ang.top, angleLabel: ANGLES[ang.top].label, fit: fitRank === -1 ? 'weak' : fitRank === 0 ? 'best' : 'good', flags, tips, length: len, source: 'rules' };
  }

  // Template library (all angles) used for rule-based drafts and as the idea bank the AI ranks
  function subjectBank(ctx = {}) {
    const brand = ctx.brand || 'our store', product = ctx.product || 'your favourite', disc = ctx.discount ? Math.round(ctx.discount * 100) : 10;
    const T = {
      welcome: [`Welcome to ${brand}, {first_name}: start here`, `Your ${product} guide: 3 tips to get it right`, `{first_name}, here's what our regulars order next`],
      exclusivity: [`{first_name}, early access is yours (48 hrs)`, `Members first: our new ${product} drop`, `A thank-you from ${brand}, just for you`],
      winback: [`{first_name}, it's been a while. Here's what's new`, `We saved your favourites at ${brand}`, `Still into ${product}? ${disc}% off to welcome you back`],
      product: [`Running low on ${product}, {first_name}?`, `3 new ways to enjoy ${product}`, `Back in stock: the blend you asked about`],
      'social proof': [`The ${product} 2,000+ customers reorder`, `Why reviewers call it their favourite ${product}`, `{first_name}, see what's most popular this month`],
      discount: [`${disc}% off your next ${product}, this week only`, `Free shipping on your second order, {first_name}`, `Your ${disc}% code is waiting`],
      urgency: [`Last chance: your ${disc}% code ends tonight`, `Final call before we say goodbye, {first_name}`, `48 hours left on your offer`]
    };
    return T;
  }
  // Rule-based drafts: top template lines for the segment's best-fit angles
  function draftSubjects(segmentKey, ctx = {}) {
    const T = subjectBank(ctx);
    const fit = SEGMENT_FIT[segmentKey] || ['product'];
    return fit.slice(0, 2).flatMap(a => T[a].slice(0, a === fit[0] ? 3 : 2)).map(line => ({ line, angle: fit.find(a => T[a].includes(line)) }));
  }

  // AI fit = zero-shot probability mass on the segment's best-fit angles (weights 1, 0.5, 0.25)
  function aiFitScore(probs, segmentKey) {
    const fit = SEGMENT_FIT[segmentKey] || []; const w = [1, 0.5, 0.25];
    return Math.min(1, fit.reduce((a, k, i) => a + (probs[k] || 0) * w[i], 0));
  }
  // Blend: 75% rules + 25% AI fit (0-1 scaled to 0-100)
  const blendScore = (ruleScore, aiFit) => Math.round(0.75 * ruleScore + 25 * Math.max(0, Math.min(1, aiFit)));

  // ---------- Readout & exports ----------
  function readout(ctx) {
    const { summary, stats, cohorts, clvRes, plans, currency = 'A$' } = ctx;
    const f = v => currency + Math.round(v).toLocaleString('en');
    const pct = v => (v * 100).toFixed(1) + '%';
    const lines = [];
    lines.push(`${summary.customers.toLocaleString('en')} customers placed ${summary.orders.toLocaleString('en')} orders (${f(summary.revenue)}, AOV ${f(summary.aov)}) between ${summary.firstDate} and ${summary.lastDate}. ${pct(summary.repeatRate)} have ordered more than once.`);
    const top = Object.values(stats).filter(s => s.customers).sort((a, b) => b.revenueShare - a.revenueShare)[0];
    const champs = stats.champions, loyal = stats.loyal;
    if (champs && loyal) lines.push(`Champions + Loyal are ${pct(champs.share + loyal.share)} of customers but ${pct(champs.revenueShare + loyal.revenueShare)} of revenue. ${top.name} is the largest revenue segment.`);
    const m1 = cohorts.avg[1], m3 = cohorts.avg[3];
    if (m1 != null) lines.push(`On average ${pct(m1)} of a new cohort buys again in month 1${m3 != null ? ` and ${pct(m3)} in month 3` : ''}. Second-order conversion is the main retention lever.`);
    const risk = (stats.atrisk?.customers || 0) + (stats.cantlose?.customers || 0);
    if (risk) lines.push(`${risk.toLocaleString('en')} formerly repeat customers are At Risk or Can't Lose Them, holding ${f((stats.atrisk?.revenue || 0) + (stats.cantlose?.revenue || 0))} of historic revenue.`);
    lines.push(`Simple CLV ≈ ${f(clvRes.clv)} gross profit per customer (AOV ${f(clvRes.aov)} × ${clvRes.ordersPerYear} orders/yr × ${Math.round(clvRes.margin * 100)}% margin × ${clvRes.lifespanYears} yrs), so keep blended CAC under ~${f(clvRes.maxCac)} for a 3:1 LTV:CAC.`);
    const p = plans.slice(0, 3).map(x => `${x.priority}. ${x.segment}: ${x.program} (≈${f(x.netIncrementalProfit)} net incremental profit)`);
    if (p.length) lines.push('Start with: ' + p.join('; ') + '. Keep a holdout on every program so the lift is measured, not assumed.');
    return lines;
  }

  function planMarkdown(plans, ctx = {}) {
    const c = ctx.currency || 'A$';
    const out = [`# Lifecycle plan${ctx.brand ? ' — ' + ctx.brand : ''}`, '', `_Generated by RetainRadar Lifecycle Lab. Lifts and base rates are planning assumptions to validate with holdout tests._`, '',
      '| # | Segment | Customers | Program | Timing | Offer | Channel | KPI | Net incr. profit | Test readout |', '|---|---|---|---|---|---|---|---|---|---|'];
    plans.forEach(p => out.push(`| ${p.priority} | ${p.segment} | ${p.customers} | ${p.program} | ${p.timing} | ${p.offer} | ${p.channel} | ${p.kpi} | ${c}${Math.round(p.netIncrementalProfit).toLocaleString('en')} | ${p.testNote} |`));
    if (ctx.readout) out.push('', '## Readout', '', ...ctx.readout.map(l => '- ' + l));
    return out.join('\n');
  }

  function customersCSV(customers) {
    const rows = customers.map(c => ({ customer_id: c.id, segment: SEGMENTS[c.segment].name, rfm: c.rfm, recency_days: c.recencyDays, frequency: c.frequency, monetary: c.monetary, first_order: ymd(c.first), last_order: ymd(c.last), high_value: c.highValue ? 'yes' : 'no' }));
    return toCSV(['customer_id', 'segment', 'rfm', 'recency_days', 'frequency', 'monetary', 'first_order', 'last_order', 'high_value'], rows);
  }

  // ---------- Synthetic demo ----------
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  // Fictional DTC loose-leaf tea brand "Kettle & Kin". 15 months of orders ending 31 Oct 2026.
  function syntheticOrders(opts = {}) {
    const rnd = mulberry32(opts.seed ?? 2211);
    const start = Date.UTC(2025, 7, 1), end = Date.UTC(2026, 10, 1); // Aug 2025 → Oct 2026
    const months = 15; const orders = []; let cid = 1, oid = 1;
    const base = opts.baseNew ?? 110;
    for (let m = 0; m < months; m++) {
      const mStart = Date.UTC(2025, 7 + m, 1), mEnd = Date.UTC(2025, 8 + m, 1);
      const calMonth = new Date(mStart).getUTCMonth();
      const season = calMonth === 10 ? 1.9 : calMonth === 11 ? 1.5 : calMonth === 0 ? 0.8 : 1; // BFCM + gifting
      const nNew = Math.round(base * (1 + m * 0.03) * season);
      for (let i = 0; i < nNew; i++) {
        const id = 'KK' + String(cid++).padStart(5, '0');
        const r = rnd();
        const type = r < 0.52 ? 'one' : r < 0.82 ? 'occasional' : r < 0.95 ? 'regular' : 'subscriber';
        const gap = { one: 0, occasional: 75, regular: 42, subscriber: 30 }[type];
        const pStop = { one: 1, occasional: 0.35, regular: 0.14, subscriber: 0.06 }[type];
        const aovBase = { one: 38, occasional: 46, regular: 52, subscriber: 58 }[type] * (calMonth === 10 ? 1.15 : 1);
        let t = mStart + Math.floor(rnd() * (mEnd - mStart));
        let k = 0;
        while (t < end && k < 40) {
          const rev = Math.max(12, Math.round((aovBase * (0.7 + rnd() * 0.6)) * 100) / 100);
          orders.push({ order_id: 'O' + String(oid++).padStart(6, '0'), customer_id: id, order_date: ymd(t), revenue: rev.toFixed(2) });
          k++;
          if (rnd() < pStop) break;
          t += Math.round(gap * (0.6 + rnd() * 0.9)) * DAY;
        }
      }
    }
    orders.sort((a, b) => a.order_date < b.order_date ? -1 : a.order_date > b.order_date ? 1 : 0);
    return { brand: 'Kettle & Kin', product: 'loose-leaf tea', asOf: end, currency: 'A$', orders };
  }
  function syntheticCSV(opts) { const d = syntheticOrders(opts); return toCSV(['order_id', 'customer_id', 'order_date', 'revenue'], d.orders); }

  return {
    DAY, parseCSV, toCSV, detectColumns, parseDate, guessDateOrder, normalizeOrders, summarize, quintileScores, frequencyScore, segmentFor,
    SEGMENTS, computeRFM, interPurchaseDays, segmentStats, cohortRetention, clv, segmentValue, STAY_PROB, normInv, sampleSizePerGroup, mde,
    PLAYBOOK, planCampaigns, ANGLES, SEGMENT_FIT, detectAngles, scoreSubject, subjectBank, draftSubjects, aiFitScore, blendScore, readout, planMarkdown, customersCSV,
    syntheticOrders, syntheticCSV, monthKey, ymd
  };
});
