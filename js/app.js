(function () {
  const LK = window.LK;
  window.addEventListener('error', function (e) {
    document.title = 'ERR: ' + e.message + ' @line' + e.lineno;
  });
  const $ = function (id) { return document.getElementById(id); };
  const MIN_PER_DAY = 390;
  const SALT = 'leeksim-v1';

  const S = {
    symbol: 'SPY', days: [], di: 0, startIdx: 0, minute: 0, frac: 0,
    mult: 10, bars: [], price: 0, dayH: 0, dayL: 0, dayVol: 0,
    tf: '1d', eng: null, running: false, ended: false,
    vp: { i0: 0, n: 120 }, follow: true, agg: null, aggDi: -1,
    cache: {}, last: 0, cross: { x: null, y: null }
  };

  function fmtP(n) {
    const v = Number(n);
    if (!isFinite(v)) return '--';
    const a = Math.abs(v);
    const d = a < 1 ? 4 : (a < 5 ? 3 : 2);
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
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
        '（共 ' + days.length + ' 个交易日）· 非交易日会自动对齐到下一个交易日';
      $('startDate').min = days[0].d;
      $('startDate').max = days[days.length - 1].d;
      S.ready = true;
    } catch (e) {
      S.ready = false;
      $('rangeHint').textContent = '⚠ ' + code + ' 暂无本地数据（已收录 ' + S.universe.length +
        ' 只）。把代码发我，我补抓后就能玩。';
    }
  }

  async function loadUniverse() {
    try {
      const r = await fetch('data/symbols.json');
      if (!r.ok) throw new Error('no index');
      S.universe = await r.json();
    } catch (e) {
      S.universe = [];
    }
  }

  function renderDrop(q) {
    const drop = $('symDrop');
    q = (q || '').trim().toUpperCase();
    if (!q) { drop.classList.add('hidden'); return; }
    const hits = [];
    for (let i = 0; i < S.universe.length && hits.length < 8; i++) {
      if (S.universe[i][0].indexOf(q) === 0) hits.push(S.universe[i]);
    }
    for (let i = 0; i < S.universe.length && hits.length < 8; i++) {
      const it = S.universe[i];
      if (it[0].indexOf(q) !== 0 && it[1].toUpperCase().indexOf(q) >= 0 && hits.indexOf(it) < 0) hits.push(it);
    }
    if (!hits.length) {
      drop.innerHTML = '<div class="drop-empty">没找到「' + q + '」—— 已收录 ' + S.universe.length + ' 只</div>';
      drop.classList.remove('hidden');
      return;
    }
    let h = '';
    for (let i = 0; i < hits.length; i++) {
      h += '<div class="drop-item" data-sym="' + hits[i][0] + '"><b>' + hits[i][0] +
        '</b><span>' + hits[i][1] + '</span></div>';
    }
    drop.innerHTML = h;
    drop.classList.remove('hidden');
    const items = drop.querySelectorAll('.drop-item');
    for (let i = 0; i < items.length; i++) {
      items[i].onclick = function () { pick(items[i].dataset.sym); };
    }
  }

  function pick(code) {
    $('symSearch').value = code;
    $('symDrop').classList.add('hidden');
    selectSymbol(code);
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

  // ---------- 视图数据（多周期）----------
  const MIN_TF = { '1m': 1, '5m': 5, '15m': 15, '60m': 60 };
  const DEFAULT_N = { '1m': 120, '5m': 96, '15m': 80, '60m': 60, '1d': 250, '1w': 260, '1M': 120, '1y': 30 };

  function rebuildAgg() {
    if (MIN_TF[S.tf]) { S.agg = null; return; }
    S.agg = LK.aggDaily(S.days, S.di, S.tf);
    S.aggDi = S.di;
  }

  function buildView() {
    const step = MIN_TF[S.tf];
    if (step) {
      const upto = Math.min(S.minute, S.bars.length - 1);
      const bars = LK.aggMinutes(S.bars, upto, step);
      const last = bars[bars.length - 1];
      if (last) {
        last.c = S.price;
        last.h = Math.max(last.h, S.price);
        last.l = Math.min(last.l, S.price);
      }
      const labels = bars.map(function (_, i) { return i % 6 === 0 ? LK.minuteLabel(i, step) : ''; });
      return { bars: bars, labels: labels, ranges: null };
    }
    if (!S.agg || S.aggDi !== S.di) rebuildAgg();
    return LK.mergeToday(S.agg || [], S.days[S.di], S.tf, S.dayH, S.dayL, S.price, S.dayVol, S.di);
  }

  function buildMarkers(ranges) {
    if (!ranges || !S.eng || !S.eng.trades.length) return null;
    const out = [];
    for (let k = 0; k < S.eng.trades.length; k++) {
      const tr = S.eng.trades[k];
      for (let i = 0; i < ranges.length; i++) {
        if (tr.di >= ranges[i][0] && tr.di <= ranges[i][1]) {
          out.push({ i: i, p: tr.price, type: (tr.side === 'buy' || tr.side === 'cover') ? 'buy' : 'sell' });
          break;
        }
      }
    }
    return out;
  }

  function render() {
    const v = buildView();
    const total = v.bars.length;
    if (S.follow) S.vp.i0 = Math.max(0, total - S.vp.n);
    S.vp.i0 = Math.max(0, Math.min(S.vp.i0, Math.max(0, total - 3)));
    const i1 = Math.min(total, S.vp.i0 + S.vp.n);
    const c = colors();
    const ma = [LK.calcMA(v.bars, 5), LK.calcMA(v.bars, 10), LK.calcMA(v.bars, 20)];
    LK.drawChart($('chart'), {
      bars: v.bars, labels: v.labels, ma: ma, i0: S.vp.i0, i1: i1,
      up: c.up, down: c.down, cross: S.cross,
      cost: (S.eng && S.eng.qty) ? S.eng.avgCost : null,
      markers: buildMarkers(v.ranges)
    });
    const b = v.bars[Math.max(S.vp.i0, i1 - 1)];
    $('ohlcBox').textContent = '开 ' + fmtP(b.o) + '   高 ' + fmtP(b.h) + '   低 ' + fmtP(b.l) +
      '   收 ' + fmtP(b.c) + '   量 ' + (b.v || 0).toLocaleString('en-US') +
      '   [' + (S.vp.i0 + 1) + '/' + total + ']';
    const m = function (arr) { const x = arr[arr.length - 1]; return x == null ? '--' : fmtP(x); };
    $('maInfo').textContent = 'MA5 ' + m(ma[0]) + ' · MA10 ' + m(ma[1]) + ' · MA20 ' + m(ma[2]);
    $('synthTag').textContent = MIN_TF[S.tf]
      ? '分钟线为算法生成（历史分钟数据需付费源）'
      : '日线真实 · 判定可信';
    $('followTag').textContent = S.follow ? '跟随最新' : '已锁定视口（双击复位）';
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

  function setTf(tf) {
    S.tf = tf;
    const btns = document.querySelectorAll('#tfSeg button');
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].dataset.tf === tf);
    }
    S.vp.n = DEFAULT_N[tf] || 120;
    S.follow = true;
    rebuildAgg();
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
      b.onclick = function () { pick(s.code); };
      row.appendChild(b);
    });

    const inp = $('symSearch');
    inp.addEventListener('input', function () { renderDrop(inp.value); });
    inp.addEventListener('focus', function () { renderDrop(inp.value); });
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const first = document.querySelector('#symDrop .drop-item');
        if (first) pick(first.dataset.sym);
        else if (inp.value.trim()) pick(inp.value.trim().toUpperCase());
      }
    });
    document.addEventListener('click', function (ev) {
      if (ev.target !== inp) $('symDrop').classList.add('hidden');
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
      b.onclick = function () { setTf(b.dataset.tf); };
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
    const pts = new Map();
    let drag = null, pinch = null;

    function geom() {
      return cv.__geom || { padL: 8, plotW: Math.max(10, cv.clientWidth - 74) };
    }
    function fracAt(clientX) {
      const g = geom(), rect = cv.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left - g.padL) / g.plotW));
    }
    function applyZoom(newN, frac) {
      newN = Math.max(20, Math.min(3000, Math.round(newN)));
      const anchor = S.vp.i0 + frac * S.vp.n;
      S.vp.n = newN;
      S.vp.i0 = Math.round(anchor - frac * newN);
    }

    cv.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      applyZoom(S.vp.n * (ev.deltaY > 0 ? 1.18 : 1 / 1.18), fracAt(ev.clientX));
      S.follow = false;
    }, { passive: false });

    cv.addEventListener('pointerdown', function (ev) {
      cv.setPointerCapture(ev.pointerId);
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pts.size === 1) {
        drag = { x: ev.clientX, i0: S.vp.i0 };
      } else if (pts.size === 2) {
        const a = Array.from(pts.values());
        pinch = { dist: Math.max(1, Math.abs(a[0].x - a[1].x)), n: S.vp.n, i0: S.vp.i0, frac: fracAt((a[0].x + a[1].x) / 2) };
        drag = null;
      }
    });

    cv.addEventListener('pointermove', function (ev) {
      if (pts.has(ev.pointerId)) pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch && pts.size === 2) {
        const a = Array.from(pts.values());
        const d = Math.max(1, Math.abs(a[0].x - a[1].x));
        const target = Math.max(20, Math.min(3000, Math.round(pinch.n * (pinch.dist / d))));
        S.vp.n = target;
        S.vp.i0 = Math.round(pinch.i0 + pinch.frac * (pinch.n - target));
        S.follow = false;
        return;
      }
      if (drag && pts.size === 1) {
        const g = geom();
        S.vp.i0 = Math.round(drag.i0 - (ev.clientX - drag.x) * (S.vp.n / g.plotW));
        S.follow = false;
        return;
      }
      if (ev.pointerType === 'mouse') {
        const r = cv.getBoundingClientRect();
        S.cross.x = ev.clientX - r.left;
        S.cross.y = ev.clientY - r.top;
      }
    });

    function endPointer(ev) {
      pts.delete(ev.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) drag = null;
    }
    cv.addEventListener('pointerup', endPointer);
    cv.addEventListener('pointercancel', endPointer);
    cv.addEventListener('mouseleave', function () { S.cross.x = null; S.cross.y = null; });
    cv.addEventListener('dblclick', function () {
      S.vp.n = DEFAULT_N[S.tf] || 120;
      S.follow = true;
    });

    window.addEventListener('keydown', function (ev) {
      if (ev.code === 'Space') { ev.preventDefault(); S.running = !S.running; }
      if (ev.key === 'b') doOrder('buy');
      if (ev.key === 's') doOrder('sell');
    });
  }

  // ---------- 启动 ----------
  async function start() {
    let days;
    try {
      days = await loadSymbol(S.symbol);
    } catch (e) {
      $('rangeHint').textContent = '⚠ ' + S.symbol + ' 还没有本地数据，先换一个已收录的标的';
      return;
    }
    S.days = days;
    let want = $('startDate').value || days[0].d;
    let idx = days.findIndex(function (d) { return d.d >= want; });
    if (idx < 0) idx = 0;
    if (idx >= days.length) idx = days.length - 1;
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
    await loadUniverse();
    const q = new URLSearchParams(location.search);
    const sym = (q.get('sym') || 'SPY').toUpperCase();
    $('startDate').value = q.get('date') || '2022-01-03';
    if (q.get('cap')) $('capital').value = q.get('cap');
    if (q.get('lev')) $('leverage').value = q.get('lev');
    $('symSearch').value = sym;
    if (q.get('q')) { $('symSearch').value = q.get('q'); renderDrop(q.get('q')); }
    await selectSymbol(sym);
    if (S.universe.length) {
      const base = $('rangeHint').textContent;
      if (base.indexOf('⚠') < 0) $('rangeHint').textContent = base + ' · 已收录 ' + S.universe.length + ' 只可搜索';
    }
    if (q.get('tf')) setTf(q.get('tf'));
    $('btnStart').onclick = start;
    if (q.get('auto')) { await loadSymbol(sym); start(); if (q.get('tf')) setTf(q.get('tf')); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
