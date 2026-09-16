(function () {
  const LK = window.LK;
  const $ = function (id) { return document.getElementById(id); };
  const MIN_PER_DAY = 390;
  const SALT = 'leeksim-v1';

  const S = {
    symbol: 'SPY', days: [], di: 0, startIdx: 0, minute: 0, frac: 0,
    mult: 10, bars: [], price: 0, dayH: 0, dayL: 0, dayVol: 0,
    tf: '1d', eng: null, running: false, ended: false,
    cache: {}, last: 0, cross: { x: null, y: null }
  };

  function fmtP(n) { return Number(n).toFixed(2); }
  function fmtM(n) { return (n >= 0 ? '' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function cls(n) { return n > 0 ? 'up' : (n < 0 ? 'down' : 'flatc'); }
  function colors() {
    const cs = getComputedStyle(document.documentElement);
    return { up: cs.getPropertyValue('--up').trim(), down: cs.getPropertyValue('--down').trim() };
  }
  function clockStr() {
    const d = S.days[S.di];
    const tot = 9 * 60 + 30 + S.minute;
    const hh = Math.floor(tot / 60), mm = tot % 60, ss = Math.floor(S.frac * 60);
    const p2 = function (x) { return String(x).padStart(2, '0'); };
    return (d ? d.d : '') + ' ' + p2(hh) + ':' + p2(mm) + ':' + p2(ss);
  }

  // ---------- 数据 ----------
  async function loadSymbol(code) {
    if (S.cache[code]) return S.cache[code];
    const days = await LK.loadDaily(code);
    S.cache[code] = days;
    return days;
  }

  async function selectSymbol(code) {
    S.symbol = code;
    const btns = document.querySelectorAll('#symRow button');
    for (let i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.sym === code);
    try {
      const days = await loadSymbol(code);
      $('rangeHint').textContent = '可选范围：' + days[0].d + ' ~ ' + days[days.length - 1].d +
        '（共 ' + days.length + ' 个交易日）';
      $('startDate').min = days[0].d;
      $('startDate').max = days[Math.max(0, days.length - 30)].d;
    } catch (e) {
      $('rangeHint').textContent = '数据加载失败：' + e.message;
    }
  }

  // ---------- 时钟 ----------
  function enterDay(i) {
    S.di = i;
    S.minute = 0;
    S.frac = 0;
    S.bars = LK.makeMinuteBars(S.days[i], SALT);
    S.dayH = -Infinity; S.dayL = Infinity; S.dayVol = 0;
    recomputeDay();
  }

  function recomputeDay() {
    let h = -Infinity, l = Infinity, v = 0;
    const upto = Math.min(S.minute, S.bars.length - 1);
    for (let i = 0; i <= upto; i++) {
      if (S.bars[i].h > h) h = S.bars[i].h;
      if (S.bars[i].l < l) l = S.bars[i].l;
      v += S.bars[i].v;
    }
    const b = S.bars[upto];
    S.dayH = h === -Infinity ? b.h : Math.max(h, b.h);
    S.dayL = l === Infinity ? b.l : Math.min(l, b.l);
    S.dayVol = v;
  }

  function advance(dtMin) {
    if (!S.running || S.ended) return;
    S.frac += dtMin;
    let guard = 0;
    while (S.frac >= 1 && guard++ < 100000) {
      S.frac -= 1;
      S.minute++;
      if (S.minute >= MIN_PER_DAY) {
        if (S.di + 1 >= S.days.length) { S.minute = MIN_PER_DAY - 1; S.frac = 1; S.running = false; settle(); return; }
        enterDay(S.di + 1);
        return;
      }
    }
    recomputeDay();
  }

  function skip(kind) {
    if (S.ended) return;
    let target = S.di;
    if (kind === '1d') target = S.di + 1;
    else if (kind === '1w') target = S.di + 5;
    else if (kind === '1m') target = S.di + 21;
    else if (kind === '1y') target = S.di + 252;
    if (target >= S.days.length) target = S.days.length - 1;
    // 跳跃期间按终点结算：直接把时钟推到那天的收盘
    enterDay(target);
    S.minute = MIN_PER_DAY - 1;
    S.frac = 1;
    recomputeDay();
    syncPrice();
    if (S.eng) { S.eng.trackEquity(S.price); checkLiq(); }
    if (target >= S.days.length - 1) { S.running = false; settle(); }
  }

  function syncPrice() {
    S.price = LK.priceAtMinute(S.bars, S.minute, S.frac);
  }

  function checkLiq() {
    if (!S.eng || S.ended) return;
    if (S.eng.checkLiquidation(S.price)) {
      S.eng.flat(S.price, S.di, clockStr());
      S.running = false;
      settle();
    }
  }

  // ---------- 视图数据 ----------
  function buildDaily() {
    const from = Math.max(0, S.di - 119);
    const bars = [], labels = [];
    for (let i = from; i <= S.di; i++) {
      const d = S.days[i];
      if (i === S.di) bars.push({ o: d.o, h: S.dayH, l: S.dayL, c: S.price, v: S.dayVol });
      else bars.push({ o: d.o, h: d.h, l: d.l, c: d.c, v: d.v });
      labels.push(d.d.slice(5));
    }
    return { bars: bars, labels: labels };
  }

  function buildMinute() {
    const upto = Math.min(S.minute, S.bars.length - 1);
    const bars = [], labels = [];
    for (let i = 0; i <= upto; i++) {
      bars.push(S.bars[i]);
      const tot = 9 * 60 + 30 + i;
      labels.push(i % 30 === 0 ? String(Math.floor(tot / 60)).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0') : '');
    }
    const last = bars[bars.length - 1];
    bars[bars.length - 1] = { o: last.o, h: Math.max(last.h, S.price), l: Math.min(last.l, S.price), c: S.price, v: last.v };
    return { bars: bars, labels: labels };
  }

  function render() {
    const v = S.tf === '1d' ? buildDaily() : buildMinute();
    const c = colors();
    const ma = [LK.calcMA(v.bars, 5), LK.calcMA(v.bars, 10), LK.calcMA(v.bars, 20)];
    LK.drawChart($('chart'), {
      bars: v.bars, labels: v.labels, ma: ma, i0: 0, i1: v.bars.length,
      up: c.up, down: c.down, cross: S.cross
    });
    const b = v.bars[v.bars.length - 1];
    $('ohlcBox').textContent = '开 ' + fmtP(b.o) + '   高 ' + fmtP(b.h) + '   低 ' + fmtP(b.l) +
      '   收 ' + fmtP(b.c) + '   量 ' + (b.v || 0).toLocaleString('en-US');
    const m = function (arr) { const x = arr[arr.length - 1]; return x == null ? '--' : fmtP(x); };
    $('maInfo').textContent = 'MA5 ' + m(ma[0]) + ' · MA10 ' + m(ma[1]) + ' · MA20 ' + m(ma[2]);
    $('synthTag').textContent = S.tf === '1m'
      ? '分钟线为算法生成（历史分钟数据需付费源）'
      : '日线真实 · 判定可信';
  }

  // ---------- 面板 ----------
  function renderPanels() {
    const e = S.eng, p = S.price;
    if (!e) return;
    const prev = S.di > 0 ? S.days[S.di - 1].c : S.days[S.di].o;
    const chg = (p / prev - 1) * 100;
    $('hSym').textContent = S.symbol;
    $('hPx').textContent = fmtP(p);
    $('hPx').className = 'px ' + cls(p - prev);
    $('hChg').textContent = pct(chg) + '  (' + (p - prev >= 0 ? '+' : '') + fmtP(p - prev) + ')';
    $('hChg').className = 'chg ' + cls(p - prev);
    $('hClock').textContent = clockStr();
    $('hLive').textContent = S.running ? '● 实时' : '❚❚ 已暂停';
    $('hLive').className = 'badge-live' + (S.running ? '' : ' paused');

    const eq = e.equity(p), mv = e.mv(p);
    const ret = (eq / e.capital0 - 1) * 100;
    const bhRet = (e.bhValue(p) / e.capital0 - 1) * 100;
    const alpha = ret - bhRet;
    $('aEquity').textContent = fmtM(eq);
    $('aCash').textContent = fmtM(e.cash);
    $('aMv').textContent = fmtM(mv);
    $('aPnl').textContent = fmtM(eq - e.capital0);
    $('aPnl').className = cls(eq - e.capital0);
    $('aRet').textContent = pct(ret);
    $('aRet').className = cls(ret);
    $('aBh').textContent = pct(bhRet);
    $('aBh').className = cls(bhRet);
    $('aAlpha').textContent = pct(alpha);
    $('aAlpha').className = cls(alpha);

    const mr = e.marginRatio(p);
    const lp = e.liqPrice();
    $('rowMargin').style.display = e.leverage > 1 || e.qty < 0 ? '' : 'none';
    $('rowLiq').style.display = e.leverage > 1 || e.qty < 0 ? '' : 'none';
    $('aMargin').textContent = isFinite(mr) ? (mr * 100).toFixed(1) + '%' : '--';
    $('aMargin').className = mr <= 0.4 ? 'up' : '';
    $('aLiq').textContent = lp ? fmtP(lp) : '--';

    $('pQty').textContent = e.qty + (e.qty < 0 ? '（空）' : '');
    $('pCost').textContent = e.qty ? fmtP(e.avgCost) : '--';
    $('pPx').textContent = fmtP(p);
    const upnl = e.qty ? (p - e.avgCost) * e.qty : 0;
    $('pUpnl').textContent = fmtM(upnl);
    $('pUpnl').className = cls(upnl);

    $('oHint').textContent = '可买 ' + e.maxBuy(p) + ' 股 · 可空 ' + e.maxShort(p) + ' 股 · 现价 ' + fmtP(p);
    renderTrades();
  }

  function renderTrades() {
    const list = $('tradeList');
    if (!S.eng.trades.length) { list.innerHTML = '<div class="empty">暂无成交</div>'; return; }
    let h = '';
    const t = S.eng.trades.slice().reverse().slice(0, 40);
    for (let i = 0; i < t.length; i++) {
      const tr = t[i];
      const name = tr.side === 'buy' ? '买入' : (tr.side === 'sell' ? '卖出' : (tr.side === 'short' ? '做空' : '平空'));
      const kls = (tr.side === 'buy' || tr.side === 'cover') ? 'side-buy' : 'side-sell';
      h += '<div class="tr"><span class="' + kls + '">' + name + ' ' + tr.qty + '</span>' +
        '<span>@' + fmtP(tr.price) + '</span><span class="t">' + tr.t.slice(5) + '</span></div>';
    }
    list.innerHTML = h;
  }

  // ---------- 下单 ----------
  function doOrder(kind) {
    if (!S.eng || S.ended) return;
    const qty = Math.max(1, Math.floor(Number($('oQty').value) || 0));
    const p = S.price, t = clockStr();
    if (kind === 'buy') S.eng.buy(p, qty, S.di, t);
    else if (kind === 'sell') S.eng.sell(p, qty, S.di, t);
    else if (kind === 'short') S.eng.short(p, qty, S.di, t);
    else if (kind === 'flat') S.eng.flat(p, S.di, t);
    renderPanels();
  }

  // ---------- 结算 ----------
  function settle() {
    if (S.ended) return;
    S.ended = true;
    S.running = false;
    const e = S.eng, p = S.price;
    const yourRet = (e.equity(p) / e.capital0 - 1) * 100;
    const bhRet = (e.bhValue(p) / e.capital0 - 1) * 100;
    const beh = LK.calcBehavior(e.trades, S.days);
    const st = {
      alpha: yourRet - bhRet,
      tradeCount: e.trades.length,
      days: S.di - S.startIdx + 1,
      flyRate: beh.flyRate, chaseRate: beh.chaseRate,
      liquidated: e.liquidated
    };
    const score = LK.leekScore(st);
    const v = LK.verdict(score, { alpha: st.alpha, youRet: yourRet });

    $('rEmoji').textContent = v.emoji;
    $('rTitle').textContent = v.title;
    $('rScore').textContent = score;
    $('rVerdict').textContent = e.liquidated
      ? '你爆仓了。保证金率跌破 30% 被强制平仓 —— 而躺平不动的人现在还持有全部仓位。'
      : v.text;
    $('rYou').textContent = pct(yourRet);
    $('rYou').className = cls(yourRet);
    $('rBh').textContent = pct(bhRet);
    $('rBh').className = cls(bhRet);
    $('rAlpha').textContent = pct(st.alpha);
    $('rAlpha').className = cls(st.alpha);
    $('rTrades').textContent = e.trades.length + ' 次 / ' + st.days + ' 个交易日';
    $('rMdd').textContent = (e.maxDD * 100).toFixed(2) + '%';
    $('rSB').textContent = '卖飞 ' + beh.fly + '/' + beh.sells + ' · 追高 ' + beh.chase + '/' + beh.buys;

    $('term').classList.add('hidden');
    $('result').classList.remove('hidden');
    S.resultRange = { from: S.startIdx, to: S.days.length - 1 };
  }

  function reveal() {
    const box = $('revealBox');
    box.classList.remove('hidden');
    const from = S.resultRange.from;
    const bars = [], labels = [];
    const marks = [];
    for (let i = from; i < S.days.length; i++) {
      const d = S.days[i];
      bars.push({ o: d.o, h: d.h, l: d.l, c: d.c, v: d.v });
      labels.push(d.d.slice(2));
    }
    for (let k = 0; k < S.eng.trades.length; k++) {
      const tr = S.eng.trades[k];
      const idx = tr.di - from;
      if (idx >= 0 && idx < bars.length) {
        marks.push({ i: idx, p: tr.price, type: (tr.side === 'buy' || tr.side === 'cover') ? 'buy' : 'sell' });
      }
    }
    const c = colors();
    LK.drawChart($('revealChart'), {
      bars: bars, labels: labels, markers: marks, up: c.up, down: c.down, showVol: false,
      ma: [LK.calcMA(bars, 20)]
    });
  }

  // ---------- 主循环 ----------
  function frame(now) {
    if (!S.last) S.last = now;
    const dt = Math.min(0.1, (now - S.last) / 1000);
    S.last = now;
    if (S.running && !S.ended) {
      advance(dt * S.mult / 60);
      syncPrice();
      if (S.eng) { S.eng.trackEquity(S.price); checkLiq(); }
    }
    if (!S.ended) { render(); renderPanels(); }
    requestAnimationFrame(frame);
  }

  // ---------- 绑定 ----------
  function bind() {
    const row = $('symRow');
    LK.symbols.forEach(function (s) {
      const b = document.createElement('button');
      b.textContent = s.code;
      b.dataset.sym = s.code;
      b.title = s.name;
      b.onclick = function () { selectSymbol(s.code); };
      row.appendChild(b);
    });

    document.querySelectorAll('#colorSeg button').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#colorSeg button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        document.documentElement.setAttribute('data-cs', b.dataset.cs);
      };
    });

    document.querySelectorAll('#speedBox button').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#speedBox button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        S.mult = Number(b.dataset.mult);
        S.running = S.mult > 0;
      };
    });

    document.querySelectorAll('.skip button').forEach(function (b) {
      b.onclick = function () { skip(b.dataset.sk); };
    });

    document.querySelectorAll('#tfSeg button').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#tfSeg button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        S.tf = b.dataset.tf;
      };
    });

    document.querySelectorAll('#qtyPreset button').forEach(function (b) {
      b.onclick = function () {
        const f = Number(b.dataset.f);
        const q = S.eng ? Math.floor(S.eng.maxBuy(S.price) * f) : 0;
        $('oQty').value = Math.max(1, q);
      };
    });

    $('btnBuy').onclick = function () { doOrder('buy'); };
    $('btnSell').onclick = function () { doOrder('sell'); };
    $('btnShort').onclick = function () { doOrder('short'); };
    $('btnFlat').onclick = function () { doOrder('flat'); };
    $('btnSettle').onclick = function () { settle(); };
    $('btnReveal').onclick = function () { reveal(); };
    $('btnAgain').onclick = function () { location.reload(); };

    const cv = $('chart');
    cv.addEventListener('mousemove', function (ev) {
      const r = cv.getBoundingClientRect();
      S.cross.x = ev.clientX - r.left; S.cross.y = ev.clientY - r.top;
    });
    cv.addEventListener('mouseleave', function () { S.cross.x = null; S.cross.y = null; });

    window.addEventListener('keydown', function (ev) {
      if (ev.code === 'Space') { ev.preventDefault(); S.running = !S.running; }
      if (ev.key === 'b') doOrder('buy');
      if (ev.key === 's') doOrder('sell');
    });
  }

  // ---------- 启动 ----------
  async function start() {
    const days = await loadSymbol(S.symbol);
    S.days = days;
    let want = $('startDate').value || days[0].d;
    let idx = days.findIndex(function (d) { return d.d >= want; });
    if (idx < 0) idx = 0;
    if (idx > days.length - 10) idx = Math.max(0, days.length - 10);
    S.startIdx = idx;

    const cap = Math.max(100, Number($('capital').value) || 10000);
    const lev = Number($('leverage').value) || 1;
    S.eng = new LK.Engine({ symbol: S.symbol, capital: cap, leverage: lev });

    enterDay(idx);
    syncPrice();
    S.eng.initBenchmark(S.price);
    S.running = true;

    $('setup').classList.add('hidden');
    $('term').classList.remove('hidden');
    requestAnimationFrame(frame);

    const q2 = new URLSearchParams(location.search);
    if (q2.get('test') === '1') {
      S.eng.buy(S.price, S.eng.maxBuy(S.price), S.di, clockStr());
      skip('1y');
      settle();
      if (q2.get('reveal') === '1') reveal();
    }
  }

  async function init() {
    bind();
    const q = new URLSearchParams(location.search);
    const sym = (q.get('sym') || 'SPY').toUpperCase();
    $('startDate').value = q.get('date') || '2022-01-03';
    if (q.get('cap')) $('capital').value = q.get('cap');
    if (q.get('lev')) $('leverage').value = q.get('lev');
    await selectSymbol(sym);
    $('btnStart').onclick = start;
    if (q.get('auto')) { await loadSymbol(sym); start(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
