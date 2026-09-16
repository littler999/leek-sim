(function () {
  const LK = window.LK;

  function fmt(n, d) { return Number(n).toFixed(d === undefined ? 2 : d); }

  LK.calcMA = function (bars, period) {
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].c;
      if (i >= period) sum -= bars[i - period].c;
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  };

  // ---------- 多周期聚合（从真实日线聚合出 周 / 月 / 年 K）----------
  function mondayOf(ds) {
    const t = Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10));
    const dow = new Date(t).getUTCDay();
    const back = (dow + 6) % 7;
    return new Date(t - back * 86400000).toISOString().slice(0, 10);
  }

  LK.periodKey = function (ds, kind) {
    if (kind === '1w') return mondayOf(ds);
    if (kind === '1M') return ds.slice(0, 7);
    if (kind === '1y') return ds.slice(0, 4);
    return ds;
  };

  LK.periodLabel = function (ds, kind) {
    if (kind === '1w') return mondayOf(ds).slice(5);
    if (kind === '1M') return ds.slice(0, 7);
    if (kind === '1y') return ds.slice(0, 4);
    return ds.slice(5);
  };

  // 聚合 days[0..upto-1]（只聚合已收盘的日子，当天单独处理以免泄露未来）
  LK.aggDaily = function (days, upto, kind) {
    const out = [];
    let curKey = null, cur = null;
    for (let i = 0; i < upto && i < days.length; i++) {
      const d = days[i];
      const k = LK.periodKey(d.d, kind);
      if (k !== curKey) {
        cur = { key: k, o: d.o, hDone: d.h, lDone: d.l, cDone: d.c, v: d.v, di0: i, di1: i, label: LK.periodLabel(d.d, kind) };
        out.push(cur);
        curKey = k;
      } else {
        cur.hDone = Math.max(cur.hDone, d.h);
        cur.lDone = Math.min(cur.lDone, d.l);
        cur.cDone = d.c;
        cur.v += d.v;
        cur.di1 = i;
      }
    }
    return out;
  };

  // 把当天（实时）并入最后一个桶，或新开一个桶
  LK.mergeToday = function (buckets, today, kind, dayH, dayL, price, dayVol, di) {
    const k = LK.periodKey(today.d, kind);
    const bars = [], labels = [], ranges = [];
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      bars.push({ o: b.o, h: b.hDone, l: b.lDone, c: b.cDone, v: b.v });
      labels.push(b.label);
      ranges.push([b.di0, b.di1]);
    }
    if (bars.length && buckets[buckets.length - 1].key === k) {
      const last = bars[bars.length - 1];
      last.h = Math.max(last.h, dayH);
      last.l = Math.min(last.l, dayL);
      last.c = price;
      last.v += dayVol;
      ranges[ranges.length - 1][1] = di;
    } else {
      bars.push({ o: today.o, h: dayH, l: dayL, c: price, v: dayVol });
      labels.push(LK.periodLabel(today.d, kind));
      ranges.push([di, di]);
    }
    return { bars: bars, labels: labels, ranges: ranges };
  };

  // 分钟聚合：1 分 → 5/15/60 分
  LK.aggMinutes = function (minBars, upto, step) {
    const out = [];
    let cur = null;
    const n = Math.min(minBars.length, upto + 1);
    for (let i = 0; i < n; i++) {
      const b = minBars[i];
      if (i % step === 0) {
        cur = { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
        out.push(cur);
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
      }
    }
    return out;
  };

  LK.minuteLabel = function (i, step) {
    const tot = 9 * 60 + 30 + i * step;
    return String(Math.floor(tot / 60)).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0');
  };

  LK.drawChart = function (cv, o) {
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const bars = o.bars || [];
    if (!bars.length) return;

    const padL = 8, padR = 66, padT = 10, padB = 20;
    const volH = o.showVol === false ? 0 : Math.round(H * 0.17);
    const plotH = H - padT - padB - (volH ? volH + 10 : 0);
    const plotW = W - padL - padR;
    if (plotW <= 10 || plotH <= 10) return;
    cv.__geom = { padL: padL, plotW: plotW };

    const i0 = Math.max(0, o.i0 || 0);
    const i1 = Math.min(bars.length, o.i1 === undefined ? bars.length : o.i1);
    const n = Math.max(1, i1 - i0);

    let hi = -Infinity, lo = Infinity, vmax = 0;
    for (let i = i0; i < i1; i++) {
      const b = bars[i];
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
      if (b.v > vmax) vmax = b.v;
    }
    if (o.markers) for (let k = 0; k < o.markers.length; k++) {
      const m = o.markers[k];
      if (m.i >= i0 && m.i < i1) { if (m.p > hi) hi = m.p; if (m.p < lo) lo = m.p; }
    }
    const pd = (hi - lo) * 0.06 || 1;
    hi += pd; lo -= pd;

    const X = function (i) { return padL + (i - i0 + 0.5) * (plotW / n); };
    const Y = function (p) { return padT + (hi - p) / (hi - lo) * plotH; };

    g.font = '11px ui-monospace, Menlo, monospace';
    g.strokeStyle = '#1e222d';
    g.lineWidth = 1;
    g.fillStyle = '#787b86';
    for (let s = 0; s <= 4; s++) {
      const p = lo + (hi - lo) * s / 4;
      const y = Math.round(Y(p)) + 0.5;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
      g.fillText(fmt(p, 2), padL + plotW + 6, y + 4);
    }
    const stepT = Math.max(1, Math.round(n / 6));
    for (let i = i0; i < i1; i += stepT) {
      const lbl = o.labels ? o.labels[i] : '';
      if (lbl) g.fillText(lbl, Math.max(padL, X(i) - 16), H - 6);
    }

    const cw = Math.max(1, Math.floor(plotW / n * 0.66));
    for (let i = i0; i < i1; i++) {
      const b = bars[i], x = X(i);
      const col = b.c >= b.o ? o.up : o.down;
      g.strokeStyle = col; g.fillStyle = col;
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, Y(b.h)); g.lineTo(Math.round(x) + 0.5, Y(b.l)); g.stroke();
      const yo = Y(b.o), yc = Y(b.c);
      g.fillRect(x - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
    }

    if (o.ma) {
      const cols = ['#f0b90b', '#2962ff', '#e040fb'];
      for (let k = 0; k < o.ma.length; k++) {
        g.strokeStyle = cols[k % 3]; g.lineWidth = 1.2; g.beginPath();
        let started = false;
        for (let i = i0; i < i1; i++) {
          const v = o.ma[k][i];
          if (v == null || !isFinite(v)) continue;
          const x = X(i), y = Y(v);
          if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
        }
        g.stroke();
      }
    }

    if (volH) {
      const vy0 = padT + plotH + 10;
      for (let i = i0; i < i1; i++) {
        const b = bars[i], x = X(i);
        const hgt = vmax ? (b.v / vmax) * volH : 0;
        g.fillStyle = (b.c >= b.o ? o.up : o.down) + '55';
        g.fillRect(x - cw / 2, vy0 + volH - hgt, cw, hgt);
      }
    }

    const last = bars[i1 - 1];
    if (last) {
      const y = Math.round(Y(last.c)) + 0.5;
      g.strokeStyle = '#5a6272'; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
      g.setLineDash([]);
      g.fillStyle = last.c >= last.o ? o.up : o.down;
      g.fillRect(padL + plotW + 2, y - 8, padR - 6, 16);
      g.fillStyle = '#fff'; g.font = '11px ui-monospace, Menlo, monospace';
      g.fillText(fmt(last.c, 2), padL + plotW + 6, y + 4);
    }

    if (o.cost != null && isFinite(o.cost) && o.cost > lo && o.cost < hi) {
      const y = Math.round(Y(o.cost)) + 0.5;
      g.strokeStyle = '#f0b90b';
      g.setLineDash([5, 4]);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#f0b90b';
      g.fillRect(padL + plotW + 2, y - 8, padR - 6, 16);
      g.fillStyle = '#1b1a12';
      g.font = '11px ui-monospace, Menlo, monospace';
      g.fillText(fmt(o.cost, 2), padL + plotW + 6, y + 4);
      g.fillStyle = '#f0b90b';
      g.font = '11px -apple-system, sans-serif';
      g.fillText('成本', padL + 4, y - 4);
    }

    if (o.markers) {
      for (let k = 0; k < o.markers.length; k++) {
        const m = o.markers[k];
        if (m.i < i0 || m.i >= i1) continue;
        const x = X(m.i), y = Y(m.p);
        g.fillStyle = m.type === 'buy' ? o.up : o.down;
        g.beginPath();
        if (m.type === 'buy') { g.moveTo(x, y + 6); g.lineTo(x - 5, y + 15); g.lineTo(x + 5, y + 15); }
        else { g.moveTo(x, y - 6); g.lineTo(x - 5, y - 15); g.lineTo(x + 5, y - 15); }
        g.closePath(); g.fill();
      }
    }

    if (o.cross && o.cross.x != null) {
      const cx = o.cross.x, cy = o.cross.y;
      g.strokeStyle = '#758696'; g.setLineDash([2, 2]); g.lineWidth = 1;
      if (cx >= padL && cx <= padL + plotW) {
        g.beginPath(); g.moveTo(Math.round(cx) + 0.5, padT); g.lineTo(Math.round(cx) + 0.5, padT + plotH); g.stroke();
      }
      if (cy >= padT && cy <= padT + plotH) {
        g.beginPath(); g.moveTo(padL, Math.round(cy) + 0.5); g.lineTo(padL + plotW, Math.round(cy) + 0.5); g.stroke();
      }
      g.setLineDash([]);
      const p = hi - (cy - padT) / plotH * (hi - lo);
      g.fillStyle = '#363a45'; g.fillRect(padL + plotW + 2, cy - 8, padR - 6, 16);
      g.fillStyle = '#d1d4dc'; g.font = '11px ui-monospace, Menlo, monospace';
      g.fillText(fmt(p, 2), padL + plotW + 6, cy + 4);

      const bi = Math.max(i0, Math.min(i1 - 1, i0 + Math.floor((cx - padL) / plotW * n)));
      const b = bars[bi];
      const txt = (o.labels && o.labels[bi] ? o.labels[bi] + '  ' : '') +
        '开' + fmt(b.o) + ' 高' + fmt(b.h) + ' 低' + fmt(b.l) + ' 收' + fmt(b.c);
      g.font = '11px ui-monospace, Menlo, monospace';
      const tw = g.measureText(txt).width + 14;
      g.fillStyle = 'rgba(28,32,42,0.95)';
      g.fillRect(padL + 4, padT + 4, tw, 20);
      g.fillStyle = '#d1d4dc';
      g.fillText(txt, padL + 11, padT + 18);
    }
  };
})();
