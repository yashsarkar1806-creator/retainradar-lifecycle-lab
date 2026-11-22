(function () {
  'use strict';
  const E = window.RR;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const state = { parsed: null, asOf: null, product: 'your favourites', results: null, subjects: [] };
  const cur = () => $('#currency').value;
  const money = v => cur() + Math.round(v).toLocaleString('en');
  const money2 = v => cur() + (Math.round(v * 100) / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v, d = 1) => v == null ? '–' : (v * 100).toFixed(d) + '%';
  const num = (id, dflt) => { const v = parseFloat($(id).value); return isFinite(v) ? v : dflt; };

  function setStatus(t) { $('#status').textContent = t; }

  function loadCSVText(text, opts = {}) {
    $('#csv').value = text.length > 200000 ? '' : text;
    state.rawText = text;
    state.asOf = opts.asOf ?? null;
    state.product = opts.product || 'your favourites';
    state.parsed = E.parseCSV(text);
    const map = E.detectColumns(state.parsed.headers);
    for (const key of ['customerId', 'orderId', 'date', 'revenue']) {
      const sel = $('#m-' + key);
      sel.innerHTML = (key === 'orderId' ? '<option value="">(none)</option>' : '<option value="">(choose)</option>') + state.parsed.headers.map(h => `<option${map[key] === h ? ' selected' : ''}>${esc(h)}</option>`).join('');
    }
    setStatus(`${state.parsed.rows.length.toLocaleString('en')} rows, ${state.parsed.headers.length} columns detected.`);
  }

  function analyse() {
    const text = $('#csv').value.trim() || state.rawText || '';
    if (!state.parsed || (text && text !== (state.rawText || '').trim())) loadCSVText(text, { asOf: null });
    const map = { customerId: $('#m-customerId').value || null, orderId: $('#m-orderId').value || null, date: $('#m-date').value || null, revenue: $('#m-revenue').value || null };
    const { orders, errors } = E.normalizeOrders(state.parsed.rows, map);
    const errBox = $('#errors');
    const shown = errors.slice(0, 6).concat(errors.length > 6 ? [`…and ${errors.length - 6} more`] : []);
    errBox.innerHTML = shown.map(e => `<li>${esc(e)}</li>`).join(''); errBox.hidden = !errors.length;
    if (orders.length < 20) { setStatus('Need at least 20 valid orders to analyse.'); $('#results').hidden = true; return; }

    const margin = num('#margin', 60) / 100;
    const asOf = state.asOf ?? (Math.max(...orders.map(o => o.t)) + E.DAY);
    const customers = E.computeRFM(orders, { asOf });
    const summary = E.summarize(orders, asOf);
    const stats = E.segmentStats(customers);
    const values = E.segmentValue(customers, { margin });
    const cohorts = E.cohortRetention(orders, { asOf, maxMonths: 12 });
    const gap = E.interPurchaseDays(customers);
    const lifespan = parseFloat($('#lifespan').value);
    const clvRes = E.clv(customers, { margin, churnWindowDays: num('#churnWindow', 180), lifespanYears: isFinite(lifespan) && lifespan > 0 ? lifespan : undefined });
    const plans = E.planCampaigns(stats, { margin, maxDiscount: num('#maxDiscount', 20) / 100, minMarginAfterDiscount: num('#minMargin', 35) / 100, holdoutShare: num('#holdout', 10) / 100, costPerSend: num('#costPerSend', 0.01), medianGapDays: gap.median || 45 });
    const readout = E.readout({ summary, stats, cohorts, clvRes, plans, currency: cur() });
    state.results = { customers, summary, stats, values, cohorts, gap, clvRes, plans, readout };
    render();
    setStatus(`Analysed ${summary.orders.toLocaleString('en')} orders as of ${summary.asOf}.`);
    $('#results').hidden = false;
    window.__rrReady = true;
  }

  function render() {
    const R = state.results, s = R.summary;
    $('#kpis').innerHTML = [
      [s.customers.toLocaleString('en'), 'Customers'], [s.orders.toLocaleString('en'), 'Orders'], [money(s.revenue), 'Revenue'], [money2(s.aov), 'Average order value'],
      [pct(s.repeatRate), 'Repeat customer rate'], [s.ordersPerCustomer, 'Orders per customer'], [money(R.clvRes.clv), 'Simple CLV (gross profit)'], [money(R.clvRes.maxCac), 'CAC ceiling at 3:1']
    ].map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
    $('#readout').innerHTML = R.readout.map(l => `<li>${esc(l)}</li>`).join('');

    // segments
    const segs = Object.values(R.stats);
    const max = Math.max(...segs.map(x => Math.max(x.share, x.revenueShare)));
    $('#segBars').innerHTML = segs.map(x => `<div class="row"><span><i class="dot" style="background:${x.color}"></i>${esc(x.name)}</span><div class="bars"><div class="a" style="width:${(x.share / max * 100).toFixed(1)}%" title="${pct(x.share)} of customers"></div><div class="b" style="width:${(x.revenueShare / max * 100).toFixed(1)}%" title="${pct(x.revenueShare)} of revenue"></div></div></div>`).join('');
    const grid = {}; R.customers.forEach(c => { const k = c.R + '-' + c.F; grid[k] = grid[k] || { n: 0, seg: c.segment }; grid[k].n++; });
    let g = '<tr><th>R \\ F</th>' + [1, 2, 3, 4, 5].map(f => `<th>F${f}</th>`).join('') + '</tr>';
    for (let r = 5; r >= 1; r--) {
      g += `<tr><th>R${r}</th>` + [1, 2, 3, 4, 5].map(f => { const seg = E.segmentFor(r, f); const n = grid[r + '-' + f]?.n || 0; return `<td style="background:${E.SEGMENTS[seg].color};opacity:${n ? 1 : .35}" title="${esc(E.SEGMENTS[seg].name)}">${n}</td>`; }).join('') + '</tr>';
    }
    $('#rfGrid').innerHTML = g;
    $('#segTable tbody').innerHTML = segs.map(x => `<tr><td><i class="dot" style="background:${x.color}"></i><strong>${esc(x.name)}</strong><br><span class="hint">${esc(x.desc)}</span></td><td>${x.customers.toLocaleString('en')} <span class="hint">(${pct(x.share)})</span></td><td>${pct(x.revenueShare)}</td><td>${money2(x.aov)}</td><td>${x.avgOrders}</td><td>${x.avgRecency}</td><td>${x.highValue}</td><td>${money(R.values[x.key].next12GrossProfit)}</td><td>${x.customers ? `<button class="link" data-seg="${x.key}">View</button>` : ''}</td></tr>`).join('');

    // cohorts
    const C = R.cohorts; const vals = C.rows.flatMap(r => r.cells.slice(1)).filter(v => v != null); const cmax = Math.max(0.01, ...vals);
    const cell = (v, k) => v == null ? '<td></td>' : k === 0 ? `<td style="background:#0f766e;color:#fff">${pct(v, 0)}</td>` : `<td style="background:rgba(15,118,110,${(0.08 + 0.85 * v / cmax).toFixed(2)});color:${v / cmax > 0.55 ? '#fff' : '#18201f'}">${pct(v, 1)}</td>`;
    let h = '<tr><th>Cohort</th><th>Customers</th>' + C.avg.map((_, k) => `<th>M+${k}</th>`).join('') + '</tr>';
    C.rows.forEach(r => { h += `<tr><td class="lbl">${r.cohort}${r.partial ? ' <span class="hint">(partial)</span>' : ''}</td><td>${r.size}</td>${r.cells.map(cell).join('')}</tr>`; });
    h += `<tr class="avg"><td class="lbl">Weighted avg</td><td>${C.rows.reduce((a, r) => a + r.size, 0)}</td>${C.avg.map(cell).join('')}</tr>`;
    $('#cohortTable').innerHTML = h;

    // CLV
    const L = R.clvRes;
    $('#clvKpis').innerHTML = [[money2(L.aov), 'AOV'], [L.ordersPerYear, 'Orders per customer per year'], [L.annualChurn == null ? '–' : pct(L.annualChurn), `Annual churn (from ${L.churnWindowDays}-day window, n=${L.matureCustomers})`], [L.lifespanYears + ' yrs', 'Expected lifespan'], [money2(L.clv), 'Simple CLV (gross profit)'], [money2(L.maxCac), 'Max CAC for 3:1 LTV:CAC']].map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
    $('#gap').textContent = R.gap.median == null ? 'n/a' : R.gap.median + ' days'; $('#gap75').textContent = R.gap.p75 == null ? 'n/a' : R.gap.p75 + ' days';

    // plans
    $('#planTable tbody').innerHTML = R.plans.map(p => `<tr><td>${p.priority}</td><td><i class="dot" style="background:${E.SEGMENTS[p.key].color}"></i>${esc(p.segment)}<br><span class="hint">${p.customers.toLocaleString('en')} customers</span></td><td><strong>${esc(p.program)}</strong><br><span class="hint">${esc(p.goal)}. KPI: ${esc(p.kpi)}</span></td><td>${esc(p.timing)}</td><td>${esc(p.offer)}</td><td>${esc(p.channel)}</td><td><strong>${money(p.netIncrementalProfit)}</strong><br><span class="hint">${p.incrementalOrders} incr. orders at +${(p.assumedLift * 100).toFixed(1)} pts on ${(p.baseRate * 100).toFixed(0)}% base</span></td><td><span class="pill ${p.testable ? 's-good' : 's-mid'}">${p.testable ? 'Readable' : 'Pool months'}</span><br><span class="hint">${esc(p.testNote)}</span></td></tr>`).join('');

    // subject lab segment list
    const sel = $('#subjSeg'); const prev = sel.value;
    sel.innerHTML = segs.filter(x => x.customers).map(x => `<option value="${x.key}">${esc(x.name)} (${x.customers})</option>`).join('');
    sel.value = prev && R.stats[prev]?.customers ? prev : (R.stats.atrisk.customers ? 'atrisk' : sel.options[0]?.value);
  }

  function showSegment(key) {
    const R = state.results, s = R.stats[key];
    const top = R.customers.filter(c => c.segment === key).sort((a, b) => b.monetary - a.monetary).slice(0, 8);
    const plan = R.plans.find(p => p.key === key);
    $('#segDetail').innerHTML = `<h3><i class="dot" style="background:${s.color}"></i>${esc(s.name)}: ${s.customers} customers</h3><p>${esc(s.desc)} Recommended: <strong>${esc(plan.program)}</strong> (${esc(plan.timing)}, ${esc(plan.offer.toLowerCase())}).</p>
      <div class="table-wrap"><table><thead><tr><th>Customer</th><th>RFM</th><th>Orders</th><th>Spend</th><th>Days since order</th></tr></thead><tbody>${top.map(c => `<tr><td>${esc(c.id)}</td><td>${c.rfm}</td><td>${c.frequency}</td><td>${money2(c.monetary)}</td><td>${c.recencyDays}</td></tr>`).join('')}</tbody></table></div>
      <div class="actions"><button id="dlSeg" data-seg="${key}">Download ${esc(s.name)} list (CSV)</button></div>`;
    $('#segDetail').hidden = false;
  }

  // ---- subject-line lab ----
  function scoreLines() {
    const seg = $('#subjSeg').value;
    const lines = $('#subjects').value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 20);
    const prevAI = new Map(state.subjects.map(x => [x.line, x.ai]));
    state.subjects = lines.map(l => { const r = E.scoreSubject(l, seg); r.ai = prevAI.get(l) && prevAI.get(l).seg === seg ? prevAI.get(l) : null; return r; }).sort((a, b) => b.score - a.score);
    renderSubjects();
  }
  function renderSubjects() {
    const cls = s => s >= 70 ? 's-good' : s >= 50 ? 's-mid' : 's-bad';
    $('#subjTable tbody').innerHTML = state.subjects.map(r => `<tr><td>${esc(r.line)}${r.source === 'ai' ? ' <span class="tag">AI pick</span>' : r.source === 'template' ? ' <span class="tag">template</span>' : ''}<br><span class="hint">${r.length} chars</span></td><td><span class="pill ${cls(r.score)}">${r.score}</span></td><td>${esc(r.angleLabel || '')}<br><span class="hint">fit: ${r.fit}</span></td><td>${r.ai ? `${esc(E.ANGLES[r.ai.angle].label)} <span class="hint">(${Math.round(r.ai.conf * 100)}%)</span><br><span class="hint">${r.ai.angle === r.angle ? 'agrees with rules' : '⚠ differs from rules: mixed message?'}</span>` : '<span class="hint">–</span>'}</td><td>${r.flags.map(f => `<small class="flag">⚠ ${esc(f)}</small>`).join('')}${r.tips.map(t => `<small class="tip">→ ${esc(t)}</small>`).join('')}</td></tr>`).join('');
    $('#subjTable').hidden = !state.subjects.length;
  }
  function draftTemplates() {
    const seg = $('#subjSeg').value; const plan = state.results.plans.find(p => p.key === seg);
    const drafts = E.draftSubjects(seg, { brand: $('#brand').value || 'our store', product: state.product, discount: plan ? plan.discount : 0.1 });
    $('#subjects').value = ($('#subjects').value.trim() + '\n' + drafts.map(d => d.line).join('\n')).trim();
    scoreLines(); state.subjects.forEach(r => { if (drafts.some(d => d.line === r.line)) r.source = 'template'; }); renderSubjects();
  }

  // ---- AI layer (transformers.js, loaded on demand) ----
  const AI_HYP = {
    welcome: 'welcoming a new customer', exclusivity: 'an exclusive VIP reward', winback: 'missing a customer who stopped buying',
    urgency: 'an urgent deadline', discount: 'a discount or sale', product: 'a product or how to use it', 'social proof': 'reviews and what other customers love'
  };
  let T = null, zs = null;
  const aiStatus = t => { $('#aiStatus').textContent = t; };
  const progress = p => { if (p.status === 'progress' && p.file) aiStatus(`Downloading ${p.file.split('/').pop()} ${Math.round(p.progress || 0)}%`); };
  async function lib() { if (!T) { aiStatus('Loading transformers.js…'); T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1'); } return T; }

  async function runAI() {
    if (!state.subjects.length) scoreLines();
    if (!state.subjects.length) { aiStatus('Add some subject lines first.'); return; }
    const btn = $('#runAI'); btn.disabled = true;
    try {
      await lib();
      if (!zs) zs = await T.pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', { progress_callback: progress });
      const labels = Object.values(AI_HYP); const keyOf = l => Object.keys(AI_HYP).find(k => AI_HYP[k] === l);
      const seg = $('#subjSeg').value; const fit = E.SEGMENT_FIT[seg];
      for (const r of state.subjects) {
        aiStatus(`Classifying "${r.line.slice(0, 40)}"…`);
        const out = await zs(r.line.replace(/\{\{?\s*first_?name\s*\}?\}/gi, 'Sam'), labels, { hypothesis_template: 'This email is about {}.' });
        const angle = keyOf(out.labels[0]);
        r.ai = { angle, conf: out.scores[0], seg };
        // blend: small nudge if the AI also sees a segment-fit angle
        if (fit.includes(angle) && r.ai.conf > 0.3 && !r.aiAdj) { r.score = Math.min(100, r.score + 3); r.aiAdj = true; r.tips.push('AI confirms the angle fits this segment (+3).'); }
      }
      state.subjects.sort((a, b) => b.score - a.score); renderSubjects();
      aiStatus('AI angle check done (on-device, Xenova/mobilebert-uncased-mnli). "Differs from rules" usually means the line mixes two messages.');
    } catch (err) {
      console.error(err);
      aiStatus('The AI model could not load (offline, blocked CDN or no WebAssembly). The rule-based scores above still apply. ' + (err && err.message ? '(' + err.message + ')' : ''));
    } finally { btn.disabled = false; }
  }

  // AI idea picker: zero-shot rank the template idea bank by fit to the segment, blended with the rule score
  async function aiDraft() {
    const btn = $('#aiDraft'); btn.disabled = true;
    const seg = $('#subjSeg').value; const plan = state.results.plans.find(p => p.key === seg);
    try {
      await lib();
      if (!zs) zs = await T.pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', { progress_callback: progress });
      const bank = E.subjectBank({ brand: $('#brand').value || 'our store', product: state.product, discount: plan ? plan.discount : 0.1 });
      const lines = [...new Set(Object.values(bank).flat())];
      const existing = new Set(state.subjects.map(r => r.line));
      const labels = Object.values(AI_HYP); const keyOf = l => Object.keys(AI_HYP).find(k => AI_HYP[k] === l);
      const ranked = [];
      for (let i = 0; i < lines.length; i++) {
        if (existing.has(lines[i])) continue;
        aiStatus(`Ranking idea ${i + 1}/${lines.length}…`);
        const out = await zs(lines[i].replace(/\{\{?\s*first_?name\s*\}?\}/gi, 'Sam'), labels, { hypothesis_template: 'This email is about {}.' });
        const probs = {}; out.labels.forEach((l, j) => { probs[keyOf(l)] = out.scores[j]; });
        const rule = E.scoreSubject(lines[i], seg);
        const fit = E.aiFitScore(probs, seg);
        ranked.push({ line: lines[i], blended: E.blendScore(rule.score, fit), fit, angle: keyOf(out.labels[0]), conf: out.scores[0] });
      }
      ranked.sort((a, b) => b.blended - a.blended);
      const pick = ranked.slice(0, 4);
      $('#subjects').value = ($('#subjects').value.trim() + '\n' + pick.map(x => x.line).join('\n')).trim();
      scoreLines();
      state.subjects.forEach(r => { const x = pick.find(p => p.line === r.line); if (x) { r.source = 'ai'; r.ai = { angle: x.angle, conf: x.conf, seg }; r.tips.unshift(`AI segment fit ${Math.round(x.fit * 100)}% → blended score ${x.blended} (75% rules + 25% AI).`); } });
      renderSubjects();
      aiStatus(`AI ranked ${ranked.length} ideas from the template bank for ${E.SEGMENTS[seg].name} and added the top ${pick.length}. Edit them to fit your brand voice.`);
    } catch (err) {
      console.error(err);
      draftTemplates();
      aiStatus('The AI model could not load, so rule-based template suggestions were added instead. ' + (err && err.message ? '(' + err.message + ')' : ''));
    } finally { btn.disabled = false; }
  }

  function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  const planMd = () => E.planMarkdown(state.results.plans, { brand: $('#brand').value, currency: cur(), readout: state.results.readout });

  const DEMO_SUBJECTS = ['{first_name}, it\'s been a while. Your favourite blend is back', 'WE MISS YOU!!! 50% OFF EVERYTHING', 'Still brewing? 15% off your next loose-leaf order', 'Our autumn newsletter', 'Last chance: your welcome-back code ends tonight ☕'];
  function loadDemo() {
    const d = E.syntheticOrders();
    $('#brand').value = d.brand; $('#currency').value = 'A$';
    loadCSVText(E.toCSV(['order_id', 'customer_id', 'order_date', 'revenue'], d.orders), { asOf: d.asOf, product: d.product });
    analyse();
    $('#subjects').value = DEMO_SUBJECTS.join('\n'); $('#subjSeg').value = 'atrisk'; scoreLines();
  }

  $('#loadDemo').addEventListener('click', loadDemo);
  $('#dlDemo').addEventListener('click', () => download('kettle-and-kin-synthetic-orders.csv', E.syntheticCSV(), 'text/csv'));
  $('#file').addEventListener('change', e => { const f = e.target.files[0]; if (!f) return; f.text().then(t => { loadCSVText(t, { asOf: null }); analyse(); }); });
  $('#analyse').addEventListener('click', analyse);
  ['#margin', '#churnWindow', '#maxDiscount', '#minMargin', '#holdout', '#costPerSend', '#lifespan', '#currency'].forEach(id => $(id).addEventListener('change', () => { if (state.results) analyse(); }));
  $('#segTable').addEventListener('click', e => { const b = e.target.closest('button[data-seg]'); if (b) showSegment(b.dataset.seg); });
  $('#segDetail').addEventListener('click', e => { const b = e.target.closest('#dlSeg'); if (b) download(`segment-${b.dataset.seg}.csv`, E.customersCSV(state.results.customers.filter(c => c.segment === b.dataset.seg)), 'text/csv'); });
  $('#dlCustomers').addEventListener('click', () => download('retainradar-customers.csv', E.customersCSV(state.results.customers), 'text/csv'));
  $('#dlPlan').addEventListener('click', () => download('lifecycle-plan.md', planMd(), 'text/markdown'));
  $('#copyPlan').addEventListener('click', e => navigator.clipboard.writeText(planMd()).then(() => { e.target.textContent = 'Copied ✓'; setTimeout(() => e.target.textContent = 'Copy plan', 1400); }));
  $('#scoreSubj').addEventListener('click', scoreLines);
  $('#subjSeg').addEventListener('change', () => { if ($('#subjects').value.trim()) scoreLines(); });
  $('#draftSubj').addEventListener('click', draftTemplates);
  $('#runAI').addEventListener('click', runAI);
  $('#aiDraft').addEventListener('click', aiDraft);

  if (/[?&]demo=1\b/.test(location.search)) loadDemo();
})();
