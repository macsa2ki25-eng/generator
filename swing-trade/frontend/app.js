/* スイングトレード分析 フロントエンド */
"use strict";

const LWC = window.LightweightCharts;

const state = {
  rows: [],
  filtered: [],
  code: null,
  tf: "D",
  refreshTimer: null,
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  maSeries: {},
  profilePrimitive: null,
  loading: false,
};

const COLORS = {
  up: "#ef5350",
  down: "#42a5f5",
  ma: { 0: "#ff5252", 1: "#26c281", 2: "#448aff" },
};

const $ = (id) => document.getElementById(id);

/* ---------------- formatting ---------------- */

function fmtPrice(v) {
  if (v == null || isNaN(v)) return "—";
  const dec = v < 100 ? 1 : 0;
  return v.toLocaleString("ja-JP", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtSigned(v, digits = 1) {
  if (v == null || isNaN(v)) return "—";
  const s = v > 0 ? "+" : "";
  return s + v.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtVolume(v) {
  if (v == null || isNaN(v)) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "億株";
  if (v >= 1e4) return Math.round(v / 1e4).toLocaleString("ja-JP") + "万株";
  return Math.round(v).toLocaleString("ja-JP") + "株";
}
function fmtTurnover(v) {
  if (v == null || isNaN(v)) return "—";
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "兆円";
  if (v >= 1e8) return Math.round(v / 1e8).toLocaleString("ja-JP") + "億円";
  return Math.round(v / 1e4).toLocaleString("ja-JP") + "万円";
}
function pctClass(v) {
  if (v == null || isNaN(v) || Math.abs(v) < 1e-9) return "flat";
  return v > 0 ? "pos" : "neg";
}

/* ---------------- toast ---------------- */

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = isError ? "error" : "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

/* ---------------- volume profile primitive ---------------- */

class VolumeProfilePrimitive {
  constructor() { this._param = null; this._data = null; }
  attached(param) { this._param = param; }
  detached() { this._param = null; }
  setData(d) {
    this._data = d;
    if (this._param) this._param.requestUpdate();
  }
  updateAllViews() {}
  paneViews() {
    const self = this;
    return [{
      zOrder: () => "bottom",
      renderer: () => ({
        draw(target) {
          const p = self._param, d = self._data;
          if (!p || !d || !d.bins || !d.bins.length) return;
          target.useMediaCoordinateSpace((scope) => {
            const ctx = scope.context;
            const W = scope.mediaSize.width;
            const maxV = Math.max(...d.bins);
            if (!maxV) return;
            const maxW = Math.min(W * 0.22, 170);
            const n = d.bins.length;
            for (let i = 0; i < n; i++) {
              const price0 = d.min + ((d.max - d.min) * i) / n;
              const price1 = d.min + ((d.max - d.min) * (i + 1)) / n;
              const y0 = p.series.priceToCoordinate(price1);
              const y1 = p.series.priceToCoordinate(price0);
              if (y0 == null || y1 == null) continue;
              const w = (maxW * d.bins[i]) / maxV;
              if (w < 0.5) continue;
              ctx.fillStyle = i === d.poc ? "rgba(232,179,57,0.38)" : "rgba(148,163,184,0.15)";
              const top = Math.min(y0, y1);
              const h = Math.max(Math.abs(y1 - y0) - 1, 1);
              ctx.fillRect(W - w, top + 0.5, w, h);
            }
          });
        },
      }),
    }];
  }
}

/* ---------------- chart ---------------- */

function initChart() {
  const el = $("chart");
  state.chart = LWC.createChart(el, {
    layout: {
      background: { color: "transparent" },
      textColor: "#8b98a9",
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "rgba(38,48,63,0.45)" },
      horzLines: { color: "rgba(38,48,63,0.45)" },
    },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#26303f" },
    timeScale: { borderColor: "#26303f", rightOffset: 4 },
    localization: {
      locale: "ja-JP",
      priceFormatter: (p) => fmtPrice(p),
    },
    autoSize: false,
  });

  state.candleSeries = state.chart.addSeries(LWC.CandlestickSeries, {
    upColor: COLORS.up,
    downColor: COLORS.down,
    borderUpColor: COLORS.up,
    borderDownColor: COLORS.down,
    wickUpColor: "rgba(239,83,80,0.8)",
    wickDownColor: "rgba(66,165,245,0.8)",
    priceFormat: { type: "price", precision: 1, minMove: 0.1 },
  });

  state.volumeSeries = state.chart.addSeries(LWC.HistogramSeries, {
    priceScaleId: "vol",
    priceFormat: { type: "volume" },
    lastValueVisible: false,
    priceLineVisible: false,
  });
  state.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  for (let i = 0; i < 3; i++) {
    state.maSeries[i] = state.chart.addSeries(LWC.LineSeries, {
      color: COLORS.ma[i],
      lineWidth: i === 2 ? 2 : 1.5,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
  }

  state.profilePrimitive = new VolumeProfilePrimitive();
  state.candleSeries.attachPrimitive(state.profilePrimitive);

  state.chart.subscribeCrosshairMove(onCrosshair);

  // チャートは非表示(幅0)の状態で生成されるため、実サイズになった時に
  // 表示範囲を適用し直す(幅0時に設定した範囲はリセットされてしまう)
  const wrap = $("chart-wrap");
  let lastWidth = 0;
  const resize = () => {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    state.chart.applyOptions({ width: w, height: h });
    if (lastWidth < 50 && w >= 50 && state.desiredRange) {
      state.chart.timeScale().setVisibleLogicalRange(state.desiredRange);
    }
    lastWidth = w;
  };
  new ResizeObserver(resize).observe(wrap);
  resize();
}

let lastPayload = null;

function onCrosshair(param) {
  const legend = $("chart-legend");
  if (!lastPayload) { legend.textContent = ""; return; }
  let bar = null;
  if (param && param.time != null && param.seriesData) {
    const sd = param.seriesData.get(state.candleSeries);
    if (sd) {
      const vd = param.seriesData.get(state.volumeSeries);
      bar = { ...sd, volume: vd ? vd.value : null, time: param.time };
    }
  }
  if (!bar) {
    const cs = lastPayload.candles;
    if (!cs.length) { legend.textContent = ""; return; }
    const last = cs[cs.length - 1];
    bar = { ...last, time: last.time };
  }
  const t = typeof bar.time === "number"
    ? new Date(bar.time * 1000).toISOString().slice(0, 16).replace("T", " ")
    : bar.time;
  legend.innerHTML =
    `${t}　始 <b>${fmtPrice(bar.open)}</b>　高 <b>${fmtPrice(bar.high)}</b>` +
    `　安 <b>${fmtPrice(bar.low)}</b>　終 <b>${fmtPrice(bar.close)}</b>` +
    (bar.volume != null ? `　出来高 <b>${fmtVolume(bar.volume)}</b>` : "");
}

function setChartData(payload) {
  lastPayload = payload;
  const intraday = payload.tf === "m5" || payload.tf === "m15";

  state.chart.applyOptions({
    timeScale: {
      borderColor: "#26303f",
      rightOffset: 4,
      timeVisible: intraday,
      secondsVisible: false,
    },
  });

  const candles = payload.candles.map((c) => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
  }));
  state.candleSeries.setData(candles);

  state.volumeSeries.setData(
    payload.candles.map((c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(239,83,80,0.42)" : "rgba(66,165,245,0.42)",
    }))
  );

  payload.ma_periods.forEach((p, i) => {
    state.maSeries[i].setData(payload.ma[String(p)] || []);
  });

  state.profilePrimitive.setData(payload.profile);

  const visible = { D: 130, W: 156, M: 240, m5: 132, m15: 110 }[payload.tf] || 130;
  const n = candles.length;
  if (n > visible) {
    state.desiredRange = { from: n - visible, to: n + 4 };
    state.chart.timeScale().setVisibleLogicalRange(state.desiredRange);
    requestAnimationFrame(() => {
      if (state.desiredRange) state.chart.timeScale().setVisibleLogicalRange(state.desiredRange);
    });
  } else {
    state.desiredRange = null;
    state.chart.timeScale().fitContent();
  }
  onCrosshair(null);
}

/* ---------------- stock view ---------------- */

function renderMaLegend(payload) {
  const el = $("ma-legend");
  el.innerHTML = "";
  payload.ma_periods.forEach((p, i) => {
    const arr = payload.ma[String(p)] || [];
    const lastVal = arr.length ? arr[arr.length - 1].value : null;
    const item = document.createElement("span");
    item.className = "ma-item";
    item.innerHTML =
      `<span class="ma-dot" style="background:${COLORS.ma[i]}"></span>` +
      `${p}${payload.ma_unit} <span class="ma-val">${lastVal != null ? fmtPrice(lastVal) : "—"}</span>`;
    el.appendChild(item);
  });
}

function renderHeader(payload) {
  const m = payload.meta;
  const s = payload.stats || {};
  $("sh-name").textContent = m.name;
  $("sh-code").textContent = m.code;
  $("sh-sector").textContent = m.sector || "—";
  $("sh-po").classList.toggle("hidden", !s.po);
  $("sh-nh").classList.toggle("hidden", !s.near_high);

  $("sh-price").textContent = fmtPrice(s.close);
  $("sh-price").className = pctClass(s.change);
  const chg = $("sh-change");
  chg.textContent = `${fmtSigned(s.change, s.close < 100 ? 1 : 0)} (${fmtSigned(s.change_pct, 2)}%)`;
  chg.className = pctClass(s.change);
  $("sh-date").textContent = s.date ? `${s.date} 終値` : "";

  const stats = [
    ["出来高", fmtVolume(s.volume)],
    ["売買代金", fmtTurnover(s.turnover)],
    ["出来高(20日比)", s.vol_ratio != null ? s.vol_ratio.toFixed(2) + "倍" : "—"],
    ["52週高値", fmtPrice(s.high52)],
    ["52週安値", fmtPrice(s.low52)],
    ["20日線乖離", s.dist20 != null ? fmtSigned(s.dist20, 2) + "%" : "—"],
  ];
  $("sh-stats").innerHTML = stats
    .map(([k, v]) => `<div class="stat-item"><span class="stat-label">${k}</span><span class="stat-value">${v}</span></div>`)
    .join("");
}

async function loadStock(code, tf) {
  if (state.loading) return;
  state.loading = true;
  $("chart-loading").classList.remove("hidden");
  try {
    const res = await fetch(`/api/stock/${code}?tf=${tf}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `取得エラー (${res.status})`);
    }
    const payload = await res.json();
    state.code = code;
    state.tf = tf;
    localStorage.setItem("swt.lastCode", code);

    $("empty-state").classList.add("hidden");
    $("stock-view").classList.remove("hidden");
    renderHeader(payload);
    renderMaLegend(payload);
    setChartData(payload);
    highlightSelected();
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.loading = false;
    $("chart-loading").classList.add("hidden");
  }
}

/* ---------------- stock list ---------------- */

function applyFilterSort() {
  const q = $("search").value.trim().toLowerCase();
  const filter = $("filter").value;
  const sortKey = $("sort").value;

  let rows = state.rows.slice();
  if (q) {
    rows = rows.filter((r) => r.code.includes(q) || r.name.toLowerCase().includes(q));
  }
  if (filter !== "all") {
    rows = rows.filter((r) => {
      if (!r.data) return false;
      if (filter === "po") return r.po;
      if (filter === "above60") return r.above60;
      if (filter === "near_high") return r.near_high;
      if (filter === "vol_surge") return r.vol_ratio != null && r.vol_ratio > 2;
      return true;
    });
  }
  rows.sort((a, b) => {
    if (sortKey === "code") return a.code.localeCompare(b.code);
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
  state.filtered = rows;
}

function renderList() {
  applyFilterSort();
  const el = $("stock-list");
  el.innerHTML = "";
  for (const r of state.filtered) {
    const row = document.createElement("div");
    row.className = "stock-row" + (r.data ? "" : " nodata") + (r.code === state.code ? " selected" : "");
    row.dataset.code = r.code;
    row.innerHTML =
      `<div class="sr-left"><div class="sr-code">${r.code} <span class="muted">${r.sector || ""}</span></div>` +
      `<div class="sr-name">${r.name}</div></div>` +
      `<div class="sr-right">` +
      (r.data
        ? `<div class="sr-price">${fmtPrice(r.close)}</div><div class="sr-pct ${pctClass(r.change_pct)}">${fmtSigned(r.change_pct, 2)}%</div>`
        : `<div class="sr-pct muted">未取得</div>`) +
      `</div>`;
    row.addEventListener("click", () => loadStock(r.code, state.tf));
    el.appendChild(row);
  }
  const count = document.createElement("div");
  count.className = "list-count";
  count.textContent = `${state.filtered.length} / ${state.rows.length} 銘柄`;
  el.appendChild(count);
}

function highlightSelected() {
  document.querySelectorAll(".stock-row").forEach((el) => {
    el.classList.toggle("selected", el.dataset.code === state.code);
  });
}

async function loadUniverse() {
  const res = await fetch("/api/universe");
  const data = await res.json();
  state.rows = data.rows;
  renderList();
}

/* ---------------- refresh ---------------- */

async function pollRefresh() {
  const res = await fetch("/api/refresh/status");
  const st = await res.json();
  const btn = $("refresh-btn");
  const prog = $("refresh-progress");
  if (st.running) {
    btn.disabled = true;
    prog.textContent = `更新中… ${st.done}/${st.total}`;
    state.refreshTimer = setTimeout(pollRefresh, 1200);
  } else {
    btn.disabled = false;
    prog.textContent = "";
    if (st.error) {
      toast("データ更新でエラー: " + st.error, true);
    } else if (st.finished_at) {
      toast("データ更新が完了しました");
    }
    await loadUniverse();
    if (state.code) loadStock(state.code, state.tf);
    else autoSelect();
  }
}

async function startRefresh() {
  await fetch("/api/refresh", { method: "POST" });
  pollRefresh();
}

/* ---------------- boot ---------------- */

function autoSelect() {
  const saved = localStorage.getItem("swt.lastCode");
  const target =
    (saved && state.rows.find((r) => r.code === saved && r.data)) ||
    state.filtered.find((r) => r.data) ||
    null;
  if (target) loadStock(target.code, state.tf);
}

function bindEvents() {
  $("search").addEventListener("input", renderList);
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = $("search").value.trim();
      if (/^\d{4}$/.test(v)) loadStock(v, state.tf);
    }
  });
  $("filter").addEventListener("change", renderList);
  $("sort").addEventListener("change", renderList);
  $("refresh-btn").addEventListener("click", startRefresh);

  $("tf-tabs").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("tf-tabs").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (state.code) loadStock(state.code, btn.dataset.tf);
      else state.tf = btn.dataset.tf;
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = state.filtered.filter((r) => r.data);
    if (!list.length) return;
    const idx = list.findIndex((r) => r.code === state.code);
    const next = e.key === "ArrowDown" ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0);
    if (next !== idx) {
      loadStock(list[next].code, state.tf);
      const el = document.querySelector(`.stock-row[data-code="${list[next].code}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  });
}

async function boot() {
  initChart();
  bindEvents();

  const meta = await (await fetch("/api/meta")).json();
  if (meta.is_demo) $("demo-banner").classList.remove("hidden");

  await loadUniverse();

  const anyData = state.rows.some((r) => r.data);
  if (!anyData) {
    toast("初回データ取得を開始します(1〜2分かかります)");
    startRefresh();
  } else {
    autoSelect();
  }
  if (meta.refresh && meta.refresh.running) pollRefresh();
}

boot();
