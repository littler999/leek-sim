(function () {
  const LK = window.LK;
  const SLIP = 0.0003;
  const MAINT = 0.30;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function Engine(cfg) {
    this.symbol = cfg.symbol;
    this.capital0 = cfg.capital;
    this.cash = cfg.capital;
    this.leverage = cfg.leverage || 1;
    this.qty = 0;
    this.avgCost = 0;
    this.realized = 0;
    this.trades = [];
    this.liquidated = false;
    this.peak = cfg.capital;
    this.maxDD = 0;
    this.bhQty = 0;
    this.bhCash = 0;
    this.entryPrice = 0;
  }

  Engine.prototype.initBenchmark = function (price) {
    this.entryPrice = price;
    this.bhQty = Math.floor(this.capital0 / price);
    this.bhCash = this.capital0 - this.bhQty * price;
  };
  Engine.prototype.bhValue = function (price) { return this.bhQty * price + this.bhCash; };
  Engine.prototype.mv = function (price) { return this.qty * price; };
  Engine.prototype.equity = function (price) { return this.cash + this.qty * price; };
  Engine.prototype.buyingPower = function (price) { return this.equity(price) * this.leverage; };
  Engine.prototype.maxBuy = function (price) {
    return Math.floor(this.buyingPower(price) / (price * (1 + SLIP)));
  };
  Engine.prototype.maxShort = function (price) {
    const cur = Math.max(0, -this.qty);
    return Math.max(0, Math.floor(this.buyingPower(price) / price) - cur);
  };
  Engine.prototype.marginRatio = function (price) {
    const mv = Math.abs(this.qty * price);
    if (mv < 1e-9) return Infinity;
    return this.equity(price) / mv;
  };
  Engine.prototype.liqPrice = function () {
    if (this.qty === 0) return null;
    const q = this.qty;
    const P = q > 0 ? this.cash / (-0.7 * q) : this.cash / (-1.3 * q);
    return P > 0 ? P : null;
  };
  Engine.prototype.checkLiquidation = function (price) {
    if (this.qty === 0) return false;
    if (this.marginRatio(price) <= MAINT) {
      this.liquidated = true;
      return true;
    }
    return false;
  };

  function log(eng, side, qty, price, dayIdx, clock) {
    eng.trades.push({ side: side, qty: qty, price: price, di: dayIdx, t: clock });
  }

  Engine.prototype.buy = function (price, qty, di, clock) {
    qty = Math.min(qty, this.maxBuy(price));
    if (qty <= 0) return 0;
    const cost = qty * price * (1 + SLIP);
    if (this.qty < 0) {
      const cover = Math.min(qty, -this.qty);
      this.realized += (this.avgCost - price) * cover;
      this.cash -= cover * price * (1 + SLIP);
      this.qty += cover;
      log(this, 'cover', cover, price, di, clock);
      qty -= cover;
      if (this.qty === 0) this.avgCost = 0;
      if (qty <= 0) return cover;
    }
    const c2 = qty * price * (1 + SLIP);
    const newQty = this.qty + qty;
    this.avgCost = (this.avgCost * this.qty + c2) / newQty;
    this.cash -= c2;
    this.qty = newQty;
    log(this, 'buy', qty, price, di, clock);
    return qty;
  };

  Engine.prototype.sell = function (price, qty, di, clock) {
    if (this.qty <= 0) return 0;
    qty = Math.min(qty, this.qty);
    if (qty <= 0) return 0;
    this.realized += (price - this.avgCost) * qty;
    this.cash += qty * price * (1 - SLIP);
    this.qty -= qty;
    if (this.qty === 0) this.avgCost = 0;
    log(this, 'sell', qty, price, di, clock);
    return qty;
  };

  Engine.prototype.short = function (price, qty, di, clock) {
    qty = Math.min(qty, this.maxShort(price));
    if (qty <= 0) return 0;
    if (this.qty > 0) {
      const closeQ = Math.min(qty, this.qty);
      this.realized += (price - this.avgCost) * closeQ;
      this.cash += closeQ * price * (1 - SLIP);
      this.qty -= closeQ;
      log(this, 'sell', closeQ, price, di, clock);
      qty -= closeQ;
      if (this.qty === 0) this.avgCost = 0;
      if (qty <= 0) return closeQ;
    }
    const proceeds = qty * price * (1 - SLIP);
    const newQty = this.qty - qty;
    const prevAbs = Math.max(0, -this.qty);
    this.avgCost = (this.avgCost * prevAbs + qty * price) / Math.max(1e-9, prevAbs + qty);
    this.cash += proceeds;
    this.qty = newQty;
    log(this, 'short', qty, price, di, clock);
    return qty;
  };

  Engine.prototype.flat = function (price, di, clock) {
    if (this.qty > 0) return this.sell(price, this.qty, di, clock);
    if (this.qty < 0) return this.buy(price, -this.qty, di, clock);
    return 0;
  };

  Engine.prototype.trackEquity = function (price) {
    const eq = this.equity(price);
    if (eq > this.peak) this.peak = eq;
    const dd = this.peak > 0 ? (this.peak - eq) / this.peak : 0;
    if (dd > this.maxDD) this.maxDD = dd;
  };

  // ---- 行为指标（结算时计算，用已揭示的完整序列）----
  LK.calcBehavior = function (trades, days) {
    let sells = 0, fly = 0, buys = 0, chase = 0;
    for (let i = 0; i < trades.length; i++) {
      const tr = trades[i];
      if (tr.side === 'sell') {
        sells++;
        let mx = 0;
        for (let k = tr.di + 1; k < Math.min(days.length, tr.di + 61); k++) mx = Math.max(mx, days[k].h);
        if (mx >= tr.price * 1.1) fly++;
      } else if (tr.side === 'buy') {
        buys++;
        let mn = Infinity;
        for (let k = tr.di + 1; k < Math.min(days.length, tr.di + 61); k++) mn = Math.min(mn, days[k].l);
        if (mn <= tr.price * 0.9) chase++;
      }
    }
    return {
      sells: sells, fly: fly, buys: buys, chase: chase,
      flyRate: sells ? fly / sells : 0,
      chaseRate: buys ? chase / buys : 0
    };
  };

  LK.leekScore = function (st) {
    if (st.liquidated) return 100;
    const a = st.alpha;
    const T = st.tradeCount / Math.max(1, st.days / 20);
    let score = 45 * clamp(Math.max(0, -a) / 30, 0, 1)
      + 20 * clamp(T, 0, 1)
      + 20 * st.flyRate
      + 15 * st.chaseRate;
    if (a >= 20) score = Math.min(score, 25);
    return Math.round(clamp(score, 0, 100));
  };

  LK.verdict = function (score, st) {
    st = st || {};
    if (score <= 20) {
      if (st.alpha > 5) return { emoji: '🥷', title: '你才是镰刀', text: '跑赢躺平，还管住了手。建议开班授课 —— 或者承认这局运气好，再来一局验证。' };
      return { emoji: '😴', title: '躺平大师', text: '这局你几乎没怎么动，结果和躺平不动一模一样（α ' + (st.alpha >= 0 ? '+' : '') + (st.alpha || 0).toFixed(2) + '%）。熊市里不乱动就不算输 —— 但也确实没赢。' };
    }
    if (score <= 40) return { emoji: '🙂', title: '老手', text: '能管住手，已经赢过大部分人。你付出的注意力基本换回了收益。' };
    if (score <= 60) return { emoji: '🌱', title: '正常人类', text: '你的操作基本被情绪和摩擦成本抵消掉了 —— 忙活一通，和躺平差不多。' };
    if (score <= 80) return { emoji: '🥬', title: '小韭菜', text: '你跑输了躺平不动的人。频繁操作、卖飞、追高，至少占了一样。' };
    return { emoji: '🧄', title: '韭菜盒子', text: '韭菜中的韭菜。你在最低点附近割肉，在最高点附近追进去，还付了一堆摩擦成本。' };
  };

  LK.Engine = Engine;
  LK.SLIP = SLIP;
})();
