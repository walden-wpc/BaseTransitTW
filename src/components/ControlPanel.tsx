"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { AppMode } from "@/app/page";
import { CITY_CONFIGS, REGION_LABELS, REGION_ORDER, COMMUTE_ZONES } from "@/lib/graphLoader";
import type { Graph } from "@/lib/graphLoader";

interface ControlPanelProps {
  selectedStop: { uid: string; name: string } | null;
  graph: Graph | null;
  onStopSelect: (uid: string, name: string) => void;
  mode: AppMode;
  onModeChange: (m: AppMode) => void;
  maxTimeMin: number;
  onMaxTimeChange: (v: number) => void;
  maxTransfers: number;
  onMaxTransfersChange: (v: number) => void;
  fullTaiwan: boolean;
  onFullTaiwanChange: (v: boolean) => void;
  showPolygon: boolean;
  onShowPolygonToggle: (v: boolean) => void;
  isCalculating: boolean;
  onClear: () => void;
  showFrequency: boolean;
  onFrequencyToggle: (v: boolean) => void;
  selectedCities: string[];
  onCitiesChange: (cities: string[], newlyAdded: string | null) => void;
  cityErrors: Record<string, string>;
  activeCity: string;
}

const TIME_MARKS = [5, 15, 30, 45, 60, 90, 120, 180];

const citiesByRegion = REGION_ORDER.map(region => ({
  region,
  label: REGION_LABELS[region],
  cities: CITY_CONFIGS.filter(c => c.region === region),
}));

function Warn({ text }: { text: string }) {
  return (
    <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 6, fontWeight: 500 }}>
      ⚠ {text}
    </span>
  );
}

export default function ControlPanel({
  selectedStop,
  graph,
  onStopSelect,
  mode,
  onModeChange,
  maxTimeMin,
  onMaxTimeChange,
  maxTransfers,
  onMaxTransfersChange,
  fullTaiwan,
  onFullTaiwanChange,
  showPolygon,
  onShowPolygonToggle,
  isCalculating,
  onClear,
  showFrequency,
  onFrequencyToggle,
  selectedCities,
  onCitiesChange,
  cityErrors,
  activeCity,
}: ControlPanelProps) {
  const [cityPanelOpen, setCityPanelOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 手機版三段式面板：closed | peek（半展開）| full（全展開）
  const [mobilePanelState, setMobilePanelState] = useState<"closed" | "peek" | "full">("closed");
  const [isMobile, setIsMobile] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);
  const dragStartTranslate = useRef<number>(0);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<{ uid: string; name: string }[]>([]);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    if (selectedStop && mobilePanelState === "full") setMobilePanelState("peek");
  }, [selectedStop]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = useCallback((text: string) => {
    setSearchText(text);
    if (!text.trim() || !graph) { setSearchResults([]); return; }
    const q = text.trim().toLowerCase();
    const seen = new Set<string>();
    const results: { uid: string; name: string }[] = [];
    for (const [uid, node] of Object.entries(graph.nodes)) {
      if (results.length >= 12) break;
      const nameKey = node.name.toLowerCase();
      if (nameKey.includes(q) && !seen.has(node.name)) {
        seen.add(node.name);
        results.push({ uid, name: node.name });
      }
    }
    setSearchResults(results);
  }, [graph]);

  const handleSearchSelect = useCallback((uid: string, name: string) => {
    onStopSelect(uid, name);
    setSearchText("");
    setSearchResults([]);
  }, [onStopSelect]);

  // ── 手機版底部拖拉邏輯 ────────────────────────────────────────────────────
  const PANEL_HEIGHT_VH = 80;
  const PEEK_VH = 42;

  const stateToTranslate = useCallback((state: "closed" | "peek" | "full") => {
    if (state === "full")   return 0;
    if (state === "peek")   return (PANEL_HEIGHT_VH - PEEK_VH) / 100 * window.innerHeight;
    return PANEL_HEIGHT_VH / 100 * window.innerHeight; // closed
  }, []);

  const snapToNearest = useCallback((currentY: number) => {
    const full   = stateToTranslate("full");
    const peek   = stateToTranslate("peek");
    const closed = stateToTranslate("closed");
    const distFull   = Math.abs(currentY - full);
    const distPeek   = Math.abs(currentY - peek);
    const distClosed = Math.abs(currentY - closed);
    if (distFull <= distPeek && distFull <= distClosed) setMobilePanelState("full");
    else if (distPeek <= distClosed) setMobilePanelState("peek");
    else setMobilePanelState("closed");
  }, [stateToTranslate]);

  const onHandleTouchStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    dragStartTranslate.current = stateToTranslate(mobilePanelState);
    if (sheetRef.current) sheetRef.current.style.transition = "none";
  }, [mobilePanelState, stateToTranslate]);

  const onHandleTouchMove = useCallback((e: React.TouchEvent) => {
    if (dragStartY.current === null || !sheetRef.current) return;
    const dy = e.touches[0].clientY - dragStartY.current;
    const newTranslate = Math.max(0, Math.min(dragStartTranslate.current + dy, stateToTranslate("closed")));
    sheetRef.current.style.transform = `translateY(${newTranslate}px)`;
  }, [stateToTranslate]);

  const onHandleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (dragStartY.current === null || !sheetRef.current) return;
    const dy = e.changedTouches[0].clientY - dragStartY.current;
    const currentTranslate = dragStartTranslate.current + dy;
    if (sheetRef.current) sheetRef.current.style.transition = "transform 0.3s cubic-bezier(0.32,0.72,0,1)";
    snapToNearest(Math.max(0, currentTranslate));
    dragStartY.current = null;
  }, [snapToNearest]);

  const activeZone = COMMUTE_ZONES.find(z =>
    z.cities.length === selectedCities.length &&
    z.cities.every(c => selectedCities.includes(c))
  );

  const selectedDisplayNames = selectedCities.length === 1
    ? (CITY_CONFIGS.find(c => c.key === selectedCities[0])?.displayName ?? selectedCities[0])
    : activeZone
      ? activeZone.label
      : `${selectedCities.length} 個縣市`;

  const displayLabel = selectedCities.length === 0 ? "未選擇縣市" : selectedDisplayNames;

  const content = (
    <>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: "linear-gradient(135deg, #6366f1, #a78bfa)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16, flexShrink: 0,
        }}>
          🚌
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>臺灣等時路網</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayLabel}
          </div>
        </div>
      </div>

      {/* 通勤圈 */}
      <div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6, fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          通勤圈
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {COMMUTE_ZONES.map(zone => {
            const isActive = !!activeZone && activeZone.id === zone.id;
            return (
              <button
                key={zone.id}
                onClick={() => isActive ? onCitiesChange([], null) : onCitiesChange(zone.cities, zone.cities[0])}
                style={{
                  padding: "3px 9px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                  fontFamily: "inherit",
                  border: isActive ? "1px solid rgba(99,102,241,0.9)" : "1px solid var(--border)",
                  background: isActive ? "rgba(99,102,241,0.3)" : "rgba(99,102,241,0.06)",
                  color: isActive ? "#c7d2fe" : "var(--text-secondary)",
                  transition: "all 0.12s",
                }}
              >
                {zone.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 單一縣市（可收折）*/}
      <div>
        <button
          onClick={() => setCityPanelOpen(v => !v)}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "rgba(99,102,241,0.06)", border: "1px solid var(--border)",
            borderRadius: 6, padding: "6px 10px", cursor: "pointer", color: "var(--text-secondary)",
            fontSize: 11, fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase",
          }}
        >
          <span>單一縣市</span>
          <span style={{ fontSize: 10, transform: cityPanelOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
        </button>

        {cityPanelOpen && (
          <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {citiesByRegion.map(({ region, label, cities }) => (
              <div key={region}>
                <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 4, paddingLeft: 2, opacity: 0.7 }}>{label}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {cities.map(c => {
                    const selected = selectedCities.length === 1 && selectedCities[0] === c.key;
                    const hasError = !!cityErrors[c.key];
                    return (
                      <button
                        key={c.key}
                        onClick={() => selected ? onCitiesChange([], null) : onCitiesChange([c.key], c.key)}
                        title={hasError ? cityErrors[c.key] : undefined}
                        style={{
                          padding: "3px 8px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                          fontFamily: "inherit",
                          border: selected ? "1px solid rgba(99,102,241,0.9)" : "1px solid var(--border)",
                          background: selected ? "rgba(99,102,241,0.35)" : "transparent",
                          color: selected ? "#c7d2fe" : "var(--text-secondary)",
                          opacity: hasError ? 0.45 : 1,
                          transition: "all 0.12s",
                        }}
                      >
                        {c.displayName}
                        {hasError && " ⚠"}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: "var(--border)" }} />

      {/* 模式切換 */}
      <div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8, fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          模式
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["routes", "isochrone"] as AppMode[]).map(m => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              style={{
                flex: 1, padding: "6px 0", borderRadius: 6,
                border: mode === m ? "1px solid rgba(99,102,241,0.7)" : "1px solid var(--border)",
                background: mode === m ? "rgba(99,102,241,0.25)" : "transparent",
                color: mode === m ? "#c7d2fe" : "var(--text-secondary)",
                fontSize: 12, fontWeight: mode === m ? 600 : 400,
                cursor: "pointer", transition: "all 0.15s", fontFamily: "inherit",
              }}
            >
              {m === "routes" ? "路線查詢" : "等時線"}
            </button>
          ))}
        </div>
      </div>

      {/* 站牌文字搜尋 */}
      <div ref={searchRef} style={{ position: "relative" }}>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6, fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          {mode === "routes" ? "查詢站牌" : "出發站牌"}
        </div>
        <div style={{ position: "relative" }}>
          <input
            type="text"
            placeholder="輸入站名搜尋…"
            value={searchText}
            onChange={e => handleSearch(e.target.value)}
            style={{
              width: "100%", boxSizing: "border-box",
              padding: "7px 28px 7px 10px",
              background: "rgba(255,255,255,0.06)", border: "1px solid var(--border-strong)",
              borderRadius: 7, color: "var(--text-primary)", fontSize: 13,
              fontFamily: "inherit", outline: "none",
            }}
          />
          {searchText && (
            <button onClick={() => { setSearchText(""); setSearchResults([]); }}
              style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 2 }}>
              ✕
            </button>
          )}
        </div>
        {searchResults.length > 0 && (
          <div style={{
            position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50,
            background: "rgba(20,20,35,0.97)", border: "1px solid var(--border-strong)",
            borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: "auto",
            boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
          }}>
            {searchResults.map(r => (
              <button key={r.uid} onClick={() => handleSearchSelect(r.uid, r.name)}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "8px 12px", background: "none", border: "none",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  color: "var(--text-primary)", cursor: "pointer", fontSize: 13, fontFamily: "inherit",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(99,102,241,0.2)")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 已選站牌狀態 */}
      <div>
        {selectedStop ? (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.3)",
            borderRadius: 8, padding: "8px 12px",
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#fb923c" }}>{selectedStop.name}</div>
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 2 }}>{selectedStop.uid}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {isCalculating && <div className="spinner" />}
              <button className="btn btn-ghost" style={{ padding: "4px 8px", fontSize: 12 }} onClick={onClear}>✕</button>
            </div>
          </div>
        ) : (
          <div style={{
            background: "rgba(99,102,241,0.08)", border: "1px dashed var(--border-strong)",
            borderRadius: 8, padding: "12px", textAlign: "center",
            color: "var(--text-secondary)", fontSize: 12,
          }}>
            點擊地圖上的站牌
          </div>
        )}
      </div>

      {/* 等時線時間設定 */}
      {mode === "isochrone" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase" }}>
              時間限制
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 0 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-accent)", fontFamily: "var(--font-en)", lineHeight: 1 }}>
                {maxTimeMin}
                <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 3, color: "var(--text-secondary)" }}>分鐘</span>
              </div>
              {maxTimeMin > 90 && <Warn text="計算時間較長" />}
            </div>
          </div>
          <input
            type="range" min={5} max={180} step={5} value={maxTimeMin}
            onChange={(e) => onMaxTimeChange(Number(e.target.value))}
            style={{ touchAction: "none" }}
          />
          <div style={{ position: "relative", height: 16, marginTop: 4 }}>
            {TIME_MARKS.map(t => {
              const pct = (t - 5) / (180 - 5) * 100;
              return (
                <span
                  key={t}
                  onClick={() => onMaxTimeChange(t)}
                  style={{
                    position: "absolute",
                    left: `${pct}%`,
                    transform: "translateX(-50%)",
                    fontSize: 9,
                    color: t === maxTimeMin ? "var(--text-accent)" : "var(--text-secondary)",
                    fontWeight: t === maxTimeMin ? 600 : 400,
                    fontFamily: "var(--font-en)",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* 頻率模式開關 */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", userSelect: "none" }}>發車密度顯示</span>
          <div onClick={() => onFrequencyToggle(!showFrequency)} style={{ width: 36, height: 20, borderRadius: 10, background: showFrequency ? "#6366f1" : "rgba(255,255,255,0.15)", position: "relative", transition: "background 0.2s", cursor: "pointer", border: "1px solid rgba(255,255,255,0.2)" }}>
            <div style={{ position: "absolute", top: 2, left: showFrequency ? 18 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
          </div>
        </label>

        {showFrequency && (
          <div style={{ marginTop: 10, display: "flex", gap: 14 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 2 }}>路線班距</div>
              {[{ color: "#22c55e", label: "≤10 分" }, { color: "#84cc16", label: "11–20 分" }, { color: "#f59e0b", label: "21–40 分" }, { color: "#f97316", label: "41–60 分" }, { color: "#ef4444", label: "61 分以上" }, { color: "#9ca3af", label: "無資料" }].map(({ color, label }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 16, height: 3, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>{label}</span>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 2 }}>站牌易達性</div>
              {[{ color: "#e0f2fe", label: "極低" }, { color: "#7dd3fc", label: "低" }, { color: "#38bdf8", label: "中等" }, { color: "#0284c7", label: "良好" }, { color: "#4338ca", label: "密集" }, { color: "#7c3aed", label: "樞紐" }].map(({ color, label }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 一般圖例 */}
      {!showFrequency && (
        <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          <span style={{ color: "#FFD306", fontWeight: 500 }}>● 黃色</span>：所有站牌
          <span style={{ color: "#f97316", fontWeight: 500 }}>● 橘色</span>：選取站牌
          {mode === "isochrone" && (
            <></>
          )}
        </div>
      )}

      {/* 進階選項 */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        <button
          onClick={() => setAdvancedOpen(v => !v)}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "2px 0",
            color: "var(--text-secondary)", fontSize: 11, fontFamily: "inherit",
            display: "flex", alignItems: "center", gap: 4, opacity: 0.6,
          }}
        >
          <span style={{ fontSize: 9, transform: advancedOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block" }}>▶</span>
          進階選項
        </button>

        {advancedOpen && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 10, color: "#f59e0b", lineHeight: 1.5 }}>
              調整以下選項可能需要大量算力，請謹慎評估自身硬體條件。
            </div>

            {/* 最大轉乘次數 */}
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>最大轉乘次數</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <button onClick={() => onMaxTransfersChange(Math.max(1, maxTransfers - 1))} style={{ width: 22, height: 22, borderRadius: 4, border: "1px solid var(--border)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", width: 20, textAlign: "center", fontFamily: "var(--font-en)" }}>{maxTransfers}</span>
                    <button onClick={() => onMaxTransfersChange(Math.min(6, maxTransfers + 1))} style={{ width: 22, height: 22, borderRadius: 4, border: "1px solid var(--border)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                  </div>
                  {maxTransfers > 3 && <Warn text="計算量大" />}
                </div>
              </div>
            </div>

            {/* 全台路網 */}
            <div>
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", userSelect: "none" }}>全台路網</span>
                <div onClick={() => onFullTaiwanChange(!fullTaiwan)} style={{ width: 36, height: 20, borderRadius: 10, background: fullTaiwan ? "#f59e0b" : "rgba(255,255,255,0.15)", position: "relative", transition: "background 0.2s", cursor: "pointer", border: "1px solid rgba(255,255,255,0.2)" }}>
                  <div style={{ position: "absolute", top: 2, left: fullTaiwan ? 18 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </div>
              </label>
              {fullTaiwan && <Warn text="需大量記憶體與時間" />}
            </div>

            {/* 等時線多邊形（凹包） */}
            {mode === "isochrone" && (
              <div>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
                  <div>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", userSelect: "none" }}>等時線多邊形</span>
                    <div style={{ fontSize: 10, color: "var(--text-secondary)", opacity: 0.6, marginTop: 1 }}>凹包輪廓，近似可達範圍</div>
                  </div>
                  <div onClick={() => onShowPolygonToggle(!showPolygon)} style={{ width: 36, height: 20, borderRadius: 10, background: showPolygon ? "#6366f1" : "rgba(255,255,255,0.15)", position: "relative", transition: "background 0.2s", cursor: "pointer", border: "1px solid rgba(255,255,255,0.2)", flexShrink: 0 }}>
                    <div style={{ position: "absolute", top: 2, left: showPolygon ? 18 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </div>
                </label>
              </div>
            )}

          </div>
        )}
      </div>
    </>
  );

  // ── 手機版 ────────────────────────────────────────────────────────────────
  if (isMobile) {
    const translatePx = mobilePanelState === "closed"
      ? `${PANEL_HEIGHT_VH}vh`
      : mobilePanelState === "peek"
        ? `${PANEL_HEIGHT_VH - PEEK_VH}vh`
        : "0px";

    return (
      <>
        {/* FAB 按鈕（closed 時顯示） */}
        {mobilePanelState === "closed" && (
          <button
            onClick={() => setMobilePanelState("peek")}
            style={{
              position: "fixed", bottom: 80, left: 16,
              width: 52, height: 52, borderRadius: 14,
              background: "rgba(20,20,35,0.88)",
              border: selectedStop ? "2px solid rgba(249,115,22,0.7)" : "1px solid rgba(255,255,255,0.15)",
              backdropFilter: "blur(12px)",
              color: "white", fontSize: 20, cursor: "pointer",
              zIndex: 20,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 2px 16px rgba(0,0,0,0.5)",
            }}
          >
            🚌
          </button>
        )}

        {/* 底部面板（三段式） */}
        <div
          ref={sheetRef}
          className="glass-panel"
          style={{
            position: "fixed", bottom: 0, left: 0, right: 0,
            height: `${PANEL_HEIGHT_VH}vh`,
            borderRadius: "18px 18px 0 0",
            zIndex: 20,
            display: "flex", flexDirection: "column",
            transform: `translateY(${translatePx})`,
            transition: "transform 0.3s cubic-bezier(0.32,0.72,0,1)",
            willChange: "transform",
          }}
        >
          {/* 拖曳把手 */}
          <div
            onTouchStart={onHandleTouchStart}
            onTouchMove={onHandleTouchMove}
            onTouchEnd={onHandleTouchEnd}
            onClick={() => setMobilePanelState(s =>
              s === "closed" ? "peek" : s === "peek" ? "full" : "closed"
            )}
            style={{
              padding: "12px 0 8px", cursor: "grab", flexShrink: 0,
              display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
            }}
          >
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.25)" }} />
            {/* peek 狀態下顯示快速資訊 */}
            {mobilePanelState === "peek" && selectedStop && (
              <div style={{ fontSize: 12, color: "#fb923c", fontWeight: 600 }}>
                {selectedStop.name}
              </div>
            )}
          </div>

          {/* 可捲動內容 */}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 40px", display: "flex", flexDirection: "column", gap: 16 }}>
            {content}
          </div>
        </div>
      </>
    );
  }

  // ── 桌面版 ────────────────────────────────────────────────────────────────
  return (
    <div className="glass-panel fade-in" style={{ position: "fixed", top: 20, left: 20, width: 300, padding: "20px 22px", zIndex: 10, display: "flex", flexDirection: "column", gap: 16, maxHeight: "calc(100vh - 40px)", overflowY: "auto", overflowX: "hidden" }}>
      {content}
    </div>
  );
}
