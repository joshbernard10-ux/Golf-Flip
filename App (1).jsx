import { useState, useEffect } from "react";

const CATEGORIES = { putters: "Putter", wedges: "Wedge", irons: "Irons", drivers: "Driver", bags: "Bag" };

const MARGIN_PRESETS = [
  { label: "Aggressive", desc: "Max profit, harder to find", buyPct: [0.52, 0.58] },
  { label: "Realistic",  desc: "Best balance — recommended", buyPct: [0.62, 0.68] },
  { label: "Quick Flip", desc: "Thin margin, moves fast",    buyPct: [0.72, 0.78] },
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

function calcBuySell(pp, buyPct) {
  const sellLow  = Math.round(percentile(pp, 25));
  const sellHigh = Math.round(percentile(pp, 75));
  const buyLow   = Math.round(sellLow  * buyPct[0]);
  const buyHigh  = Math.round(sellHigh * buyPct[1]);
  const netLow   = Math.round(sellLow  * 0.87 - buyHigh);
  const netHigh  = Math.round(sellHigh * 0.87 - buyLow);
  return { sellLow, sellHigh, buyLow, buyHigh, netLow, netHigh };
}

function processListings(listings, name, category, buyPct) {
  const all = listings
    .filter(l => l.soldPrice && !isNaN(parseFloat(l.soldPrice)))
    .map(l => ({
      price: parseFloat(l.soldPrice),
      condition: (l.condition || "").toLowerCase(),
      title: l.title || "",
    }));
  if (all.length < 3) return null;

  const prices = all.map(l => l.price).sort((a, b) => a - b);
  const q1 = percentile(prices, 25), q3 = percentile(prices, 75);
  const iqr = q3 - q1;
  const clean    = all.filter(l => l.price >= q1 - 1.5 * iqr && l.price <= q3 + 1.5 * iqr);
  const outliers = all.filter(l => !clean.includes(l));
  const preOwned = clean.filter(l => l.condition.includes("pre") || l.condition.includes("used") || l.condition.includes("good"));
  const brandNew = clean.filter(l => l.condition.includes("new"));
  const primary  = preOwned.length >= 3 ? preOwned : clean;
  const pp       = primary.map(l => l.price).sort((a, b) => a - b);
  const avgPrice = Math.round(avg(pp));
  const speed    = primary.length >= 8 ? 5 : primary.length >= 5 ? 4 : 3;
  const prices2  = calcBuySell(pp, buyPct);

  return { name, category, ...prices2, avgPrice, speed, primary, outliers, brandNew, sampleSize: primary.length, pp };
}

export default function GolfFlipLive() {
  const [clubName,     setClubName]     = useState("");
  const [category,     setCategory]     = useState("putters");
  const [status,       setStatus]       = useState("");
  const [error,        setError]        = useState("");
  const [result,       setResult]       = useState(null);
  const [db,           setDb]           = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [showListings, setShowListings] = useState(false);
  const [presetIdx,    setPresetIdx]    = useState(1);           // default = Realistic
  const [customPct,    setCustomPct]    = useState(65);          // custom slider %
  const [useCustom,    setUseCustom]    = useState(false);

  // Derived buy %
  const activeBuyPct = useCustom
    ? [customPct / 100 - 0.03, customPct / 100 + 0.03]
    : MARGIN_PRESETS[presetIdx].buyPct;

  // Recalc result live when margin changes
  const displayed = result
    ? { ...result, ...calcBuySell(result.pp, activeBuyPct) }
    : null;

  useEffect(() => {
    try { const s = localStorage.getItem("golfFlipDB"); if (s) setDb(JSON.parse(s)); } catch(e) {}
  }, []);

  const saveToStorage = (newDb) => {
    setDb(newDb);
    try { localStorage.setItem("golfFlipDB", JSON.stringify(newDb)); } catch(e) {}
  };

  const fetchPricing = async () => {
    if (!clubName.trim()) return;
    setLoading(true); setError(""); setResult(null); setShowListings(false);
    const catWord = category === "putters" ? "putter" : category === "wedges" ? "wedge" : category === "irons" ? "irons" : category === "drivers" ? "driver" : "bag";
    try {
      setStatus("Searching eBay sold listings...");
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          system: `You are a data fetching assistant. Use web_search to find recent eBay completed/sold listing prices for golf equipment. Return ONLY a valid JSON array — no markdown, no explanation, no backticks:
[{"soldPrice": 299, "condition": "Pre-Owned", "title": "Club name", "soldDate": "Jun 2026"}, ...]
Include 8-15 items. Only actual sold/completed sales. Prioritize Pre-Owned condition. Return ONLY the raw JSON array.`,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: `Find 10-15 recent eBay completed sold listing prices for: "${clubName}" golf ${catWord}. Return only the JSON array.` }]
        })
      });
      if (!claudeRes.ok) throw new Error(`API error ${claudeRes.status}`);
      const data = await claudeRes.json();
      const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
      const match = text.match(/\[[\s\S]*?\]/);
      if (!match) throw new Error("No listing data returned. Try a different club name.");
      const listings = JSON.parse(match[0]);
      if (!listings.length) throw new Error("No sold listings found.");
      const processed = processListings(listings, clubName.trim(), category, activeBuyPct);
      if (!processed) throw new Error("Not enough valid listings. Try a more popular model.");
      setResult(processed);
      setStatus("");
    } catch (err) {
      setError(err.message); setStatus("");
    } finally {
      setLoading(false);
    }
  };

  const saveResult = () => {
    if (!displayed) return;
    const entry = {
      model: displayed.name, category: displayed.category,
      buy: [displayed.buyLow, displayed.buyHigh],
      sell: [displayed.sellLow, displayed.sellHigh],
      speed: displayed.speed, sampleSize: displayed.sampleSize,
      marginPreset: useCustom ? `Custom ${customPct}%` : MARGIN_PRESETS[presetIdx].label,
      lastUpdated: new Date().toLocaleDateString(),
    };
    saveToStorage([...db.filter(c => c.model !== displayed.name), entry]);
  };

  const removeClub = (model) => saveToStorage(db.filter(c => c.model !== model));
  const speedInfo  = (s) => s >= 5 ? { label: "🔥 Fast", color: "#4ade80" } : s >= 4 ? { label: "⚡ Good", color: "#84cc16" } : { label: "🕐 Moderate", color: "#f59e0b" };

  const S = {
    wrap:      { minHeight: "100vh", background: "#0a0f0a", color: "#e8e0d0", fontFamily: "Georgia, serif", padding: "24px 16px" },
    inner:     { maxWidth: 780, margin: "0 auto" },
    card:      { background: "#0c180c", border: "1px solid #1a2e1a", borderRadius: 8, padding: 20, marginBottom: 16 },
    cardTitle: { fontSize: 10, letterSpacing: 2, color: "#4a8a4a", textTransform: "uppercase", marginBottom: 14 },
    input:     { flex: 1, minWidth: 180, background: "#0a130a", border: "1px solid #2a4a2a", borderRadius: 6, color: "#c8d8c8", fontFamily: "Georgia, serif", fontSize: 14, padding: "11px 14px", outline: "none" },
    select:    { background: "#0a130a", border: "1px solid #2a4a2a", borderRadius: 6, color: "#c8d8c8", fontFamily: "Georgia, serif", fontSize: 13, padding: "11px 12px", outline: "none", cursor: "pointer" },
    btn:       { background: "#1a4a1a", border: "1px solid #4a8a4a", borderRadius: 6, color: "#7ec87e", fontFamily: "Georgia, serif", fontSize: 13, padding: "11px 22px", cursor: "pointer", letterSpacing: 1 },
    btnSm:     { background: "transparent", border: "1px solid #2a4a2a", borderRadius: 6, color: "#4a7a4a", fontFamily: "Georgia, serif", fontSize: 11, padding: "5px 12px", cursor: "pointer" },
    btnDanger: { background: "transparent", border: "1px solid #4a2a2a", borderRadius: 6, color: "#f87171", fontFamily: "Georgia, serif", fontSize: 11, padding: "5px 12px", cursor: "pointer" },
    stat:      { background: "#0a130a", border: "1px solid #1a2e1a", borderRadius: 6, padding: 12, textAlign: "center", flex: 1, minWidth: 110 },
    divider:   { border: "none", borderTop: "1px solid #1a2e1a", margin: "14px 0" },
    row:       { display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #0f1f0f", fontSize: 11, gap: 8 },
  };

  return (
    <div style={S.wrap}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes spin  { to{transform:rotate(360deg)} }
        input[type=range] { -webkit-appearance:none; width:100%; height:4px; border-radius:2px; background: linear-gradient(to right, #4a8a4a ${customPct}%, #1a2e1a ${customPct}%); outline:none; cursor:pointer; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:16px; height:16px; border-radius:50%; background:#7ec87e; border:2px solid #0a130a; cursor:pointer; }
      `}</style>
      <div style={S.inner}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 22, color: "#7ec87e", letterSpacing: 3, marginBottom: 4 }}>
            ⛳ FLIP
            <span style={{ fontSize: 10, background: "#0a2a0a", border: "1px solid #2a5a2a", color: "#4ade80", padding: "2px 10px", borderRadius: 10, letterSpacing: 2, verticalAlign: "middle", marginLeft: 10 }}>
              <span style={{ display:"inline-block", width:6, height:6, background:"#4ade80", borderRadius:"50%", marginRight:4, animation:"pulse 2s infinite" }}></span>LIVE
            </span>
          </div>
          <div style={{ fontSize: 11, color: "#3a6a3a", letterSpacing: 2, textTransform: "uppercase" }}>Real-time eBay sold pricing</div>
        </div>

        {/* Search */}
        <div style={S.card}>
          <div style={S.cardTitle}>Look Up Any Club</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input style={S.input} value={clubName} onChange={e => setClubName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !loading && fetchPricing()}
              placeholder="e.g. Scotty Cameron Newport 2" />
            <select style={S.select} value={category} onChange={e => setCategory(e.target.value)}>
              {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button style={{ ...S.btn, opacity: loading ? 0.5 : 1 }} onClick={fetchPricing} disabled={loading}>
              {loading ? "Searching..." : "Search eBay"}
            </button>
          </div>
        </div>

        {/* Margin Control */}
        <div style={S.card}>
          <div style={S.cardTitle}>Margin Strategy</div>

          {/* Preset pills */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {MARGIN_PRESETS.map((p, i) => (
              <div key={i} onClick={() => { setPresetIdx(i); setUseCustom(false); }}
                style={{ flex: 1, minWidth: 120, padding: "10px 12px", borderRadius: 7, border: "1px solid", cursor: "pointer",
                  borderColor: !useCustom && presetIdx === i ? "#4a8a4a" : "#1a2e1a",
                  background: !useCustom && presetIdx === i ? "#0f2a0f" : "transparent" }}>
                <div style={{ fontSize: 12, color: !useCustom && presetIdx === i ? "#7ec87e" : "#5a7a5a", fontWeight: 600, marginBottom: 2 }}>{p.label}</div>
                <div style={{ fontSize: 10, color: "#3a5a3a" }}>{p.desc}</div>
                <div style={{ fontSize: 11, color: "#4a6a4a", marginTop: 4 }}>Buy at {Math.round(p.buyPct[0]*100)}–{Math.round(p.buyPct[1]*100)}% of sell</div>
              </div>
            ))}
          </div>

          {/* Custom slider */}
          <div onClick={() => setUseCustom(true)}
            style={{ padding: "12px 14px", borderRadius: 7, border: "1px solid", cursor: "pointer",
              borderColor: useCustom ? "#4a8a4a" : "#1a2e1a", background: useCustom ? "#0f2a0f" : "transparent" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: useCustom ? "#7ec87e" : "#5a7a5a", fontWeight: 600 }}>Custom</div>
              <div style={{ fontSize: 13, color: "#7ec87e", fontWeight: 700 }}>Buy at {customPct}% of sell</div>
            </div>
            <input type="range" min={45} max={82} value={customPct}
              onChange={e => { setCustomPct(Number(e.target.value)); setUseCustom(true); }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#2a4a2a", marginTop: 4 }}>
              <span>45% — Max margin</span><span>62% — Realistic</span><span>82% — Quick flip</span>
            </div>
          </div>

          {/* Live preview if result exists */}
          {displayed && (
            <div style={{ marginTop: 14, padding: "10px 14px", background: "#08100a", border: "1px solid #1a2e1a", borderRadius: 6, display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div style={{ fontSize: 10, color: "#3a5a3a", letterSpacing: 1, textTransform: "uppercase", width: "100%", marginBottom: 4 }}>Live preview — {displayed.name}</div>
              <div><div style={{ fontSize: 9, color: "#3a5a3a", marginBottom: 2 }}>BUY TARGET</div><div style={{ color: "#f87171", fontWeight: 700 }}>${displayed.buyLow}–${displayed.buyHigh}</div></div>
              <div><div style={{ fontSize: 9, color: "#3a5a3a", marginBottom: 2 }}>SELL RANGE</div><div style={{ color: "#4ade80", fontWeight: 700 }}>${displayed.sellLow}–${displayed.sellHigh}</div></div>
              <div><div style={{ fontSize: 9, color: "#3a5a3a", marginBottom: 2 }}>NET PROFIT</div><div style={{ color: "#4ade80", fontWeight: 700 }}>${displayed.netLow}–${displayed.netHigh}</div></div>
            </div>
          )}
        </div>

        {/* Status */}
        {status && (
          <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", background:"#0a130a", border:"1px solid #1a3a1a", borderRadius:6, fontSize:12, color:"#4a8a4a", marginBottom:16 }}>
            <div style={{ width:14, height:14, border:"2px solid #1a3a1a", borderTopColor:"#7ec87e", borderRadius:"50%", animation:"spin 0.8s linear infinite", flexShrink:0 }} />
            {status}
          </div>
        )}
        {error && <div style={{ padding:"12px 16px", background:"#1a0a0a", border:"1px solid #4a1a1a", borderRadius:6, color:"#f87171", fontSize:12, marginBottom:16 }}>⚠ {error}</div>}

        {/* Result card */}
        {displayed && (
          <div style={{ background:"#0f2a0f", border:"1px solid #2a5a2a", borderRadius:8, padding:18, marginBottom:16 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14, flexWrap:"wrap", gap:8 }}>
              <div>
                <div style={{ fontSize:16, color:"#c8d8c0", fontWeight:600 }}>{displayed.name}</div>
                <div style={{ fontSize:10, color:"#3a6a3a", letterSpacing:1, marginTop:3 }}>{displayed.sampleSize} sold listings · eBay · {new Date().toLocaleDateString()}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:9, color:"#3a6a3a", letterSpacing:1.5, textTransform:"uppercase" }}>Est. Net Profit</div>
                <div style={{ fontSize:24, fontWeight:700, color:"#4ade80" }}>${displayed.netLow}–${displayed.netHigh}</div>
              </div>
            </div>

            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 }}>
              {[
                { label:"Buy Target", value:`$${displayed.buyLow}–$${displayed.buyHigh}`, color:"#f87171" },
                { label:"Sell Range", value:`$${displayed.sellLow}–$${displayed.sellHigh}`, color:"#4ade80" },
                { label:"Avg Sale",   value:`$${displayed.avgPrice}`, color:"#c8d8c8" },
                { label:"Sell Speed", value:speedInfo(displayed.speed).label, color:speedInfo(displayed.speed).color },
              ].map(s => (
                <div key={s.label} style={S.stat}>
                  <div style={{ fontSize:9, color:"#3a5a3a", letterSpacing:1.5, textTransform:"uppercase", marginBottom:4 }}>{s.label}</div>
                  <div style={{ fontSize:17, fontWeight:700, color:s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            <hr style={S.divider} />
            <div style={{ fontSize:10, color:"#3a6a3a", letterSpacing:1, textTransform:"uppercase", cursor:"pointer", marginBottom:8 }}
              onClick={() => setShowListings(!showListings)}>
              {showListings ? "▾" : "▸"} {displayed.primary.length + displayed.outliers.length} Listings ({displayed.outliers.length} outliers removed)
            </div>
            {showListings && (
              <div>
                {[...displayed.outliers.map(l => ({...l, isOutlier:true})), ...displayed.primary]
                  .sort((a, b) => b.price - a.price)
                  .map((l, i) => (
                    <div key={i} style={S.row}>
                      <div style={{ flex:1, color:l.isOutlier?"#3a2a2a":"#6a8a6a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textDecoration:l.isOutlier?"line-through":"none" }}>
                        {l.title.substring(0,60)}{l.title.length>60?"...":""}
                      </div>
                      <div style={{ color:l.isOutlier?"#3a2a2a":"#4ade80", fontWeight:600, flexShrink:0 }}>${l.price}</div>
                      <span style={{ fontSize:9, padding:"1px 6px", borderRadius:8, flexShrink:0, background:l.isOutlier?"#1a0808":"#0a1f2a", color:l.isOutlier?"#f87171":"#7ec8c8", border:`1px solid ${l.isOutlier?"#3a1a1a":"#1a3a4a"}` }}>
                        {l.isOutlier?"outlier":"used"}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            <hr style={S.divider} />
            <div style={{ display:"flex", justifyContent:"flex-end" }}>
              <button style={S.btnSm} onClick={saveResult}>Save to Database</button>
            </div>
          </div>
        )}

        {/* Database */}
        <div style={S.card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div style={S.cardTitle}>Saved Database</div>
            <div style={{ fontSize:10, color:"#3a5a3a" }}>{db.length} clubs</div>
          </div>
          {db.length === 0
            ? <div style={{ textAlign:"center", padding:30, color:"#2a4a2a", fontSize:12, letterSpacing:1 }}>Search a club above to start building your database.</div>
            : db.map((c, i) => (
              <div key={i} style={{ ...S.row, padding:"10px 0" }}>
                <div style={{ flex:1 }}>
                  <div style={{ color:"#8a9a8a", fontSize:13 }}>{c.model}</div>
                  <div style={{ color:"#3a5a3a", fontSize:10 }}>{CATEGORIES[c.category]} · {c.marginPreset} · {c.lastUpdated}</div>
                </div>
                <div style={{ color:"#f87171", fontSize:12, width:90, textAlign:"right" }}>${c.buy[0]}–${c.buy[1]}</div>
                <div style={{ color:"#4ade80", fontSize:12, width:100, textAlign:"right" }}>${c.sell[0]}–${c.sell[1]}</div>
                <button style={S.btnDanger} onClick={() => removeClub(c.model)}>✕</button>
              </div>
            ))
          }
        </div>

      </div>
    </div>
  );
}
