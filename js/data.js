(function () {
  const LK = window.LK || (window.LK = {});

  LK.loadDaily = async function (symbol) {
    const resp = await fetch('data/' + String(symbol).toUpperCase() + '.csv');
    if (!resp.ok) throw new Error('该标的暂无本地数据');
    const txt = await resp.text();
    const lines = txt.trim().split('\n');
    if (lines.length < 5) throw new Error('数据不完整');
    const days = [];
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(',');
      if (p.length < 5) continue;
      days.push({ d: p[0], o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5] || 0 });
    }
    return days;
  };

  LK.hashStr = function (s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  LK.mulberry32 = function (a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  };

  // 生成某日 390 根 1 分钟 K 线，严格约束到当日的真实 开/高/低/收
  LK.makeMinuteBars = function (day, salt) {
    const N = 390;
    const rnd = LK.mulberry32(LK.hashStr(day.d + '|' + (salt || '')));
    const w = new Float64Array(N + 1);
    for (let i = 1; i <= N; i++) w[i] = w[i - 1] + (rnd() * 2 - 1);

    const wN = w[N];
    const dev = new Float64Array(N + 1);
    let maxDev = -1e9, minDev = 1e9, iMax = 0, iMin = 0;
    for (let i = 0; i <= N; i++) {
      dev[i] = w[i] - (i / N) * wN;
      if (dev[i] > maxDev) { maxDev = dev[i]; iMax = i; }
      if (dev[i] < minDev) { minDev = dev[i]; iMin = i; }
    }
    const span = Math.max(1e-9, maxDev - minDev);
    const s = (day.h - day.l) / span;
    const lin = function (i) { return day.o + (day.c - day.o) * (i / N); };

    const p = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) {
      p[i] = Math.min(day.h, Math.max(day.l, lin(i) + s * dev[i]));
    }
    p[iMax] = day.h;
    p[iMin] = day.l;
    p[0] = day.o;
    p[N] = day.c;

    const vw = new Float64Array(N);
    let vsum = 0;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      vw[i] = 0.6 + 1.8 * x * x + rnd() * 0.4;
      vsum += vw[i];
    }

    const bars = new Array(N);
    for (let i = 0; i < N; i++) {
      const o = p[i], c = p[i + 1];
      const jit = (day.h - day.l) * 0.06 * rnd();
      bars[i] = {
        o: o,
        h: Math.min(day.h, Math.max(o, c) + jit),
        l: Math.max(day.l, Math.min(o, c) - jit),
        c: c,
        v: Math.round((day.v * vw[i]) / vsum),
        sgn: rnd() < 0.5 ? -1 : 1
      };
    }
    return bars;
  };

  // 当前这一分钟内、进度 frac 时的价格（让数字每秒都在跳）
  LK.priceAtMinute = function (bars, mi, frac) {
    const i = Math.max(0, Math.min(bars.length - 1, mi | 0));
    const b = bars[i];
    const f = Math.max(0, Math.min(1, frac));
    const base = b.o + (b.c - b.o) * f;
    const wob = (b.h - b.l) * 0.32 * b.sgn * Math.sin(Math.PI * f);
    return Math.min(b.h, Math.max(b.l, base + wob));
  };

  LK.symbols = [
    { code: 'SPY', name: '标普500 ETF', cls: 'etf' },
    { code: 'QQQ', name: '纳指100 ETF', cls: 'etf' },
    { code: 'AAPL', name: '苹果', cls: 'stocks' },
    { code: 'NVDA', name: '英伟达', cls: 'stocks' },
    { code: 'TSLA', name: '特斯拉', cls: 'stocks' }
  ];
})();
