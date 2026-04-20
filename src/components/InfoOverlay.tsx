"use client";

import { useState, useEffect } from "react";
import type { AppMode } from "@/app/page";

interface IsochroneResult {
  nodeCount: number;
  areaKm2: number;
  durationMs: number;
  usedRoutes: string[];
}

interface RouteMeta {
  departure: string;
  destination: string;
  headsign: string;
  operator: string;
  headway_weekday?: number;
  headway_weekend?: number;
  is_circular?: boolean;
}

interface InfoOverlayProps {
  mode: AppMode;
  isoResult: IsochroneResult | null;
  stopRoutes: string[];
  routeMeta: Record<string, RouteMeta>;
  maxTimeMin: number;
  focusedRoute: string | null;
  onRouteClick: (route: string | null) => void;
  showFrequency: boolean;
}

function headwayLabel(hw: number): string {
  if (hw < 0) return "";
  if (hw < 10) return `${hw}分`;
  return `${Math.round(hw)}分`;
}

function headwayColor(hw: number): string {
  if (hw < 0)   return "#9ca3af";
  if (hw <= 10) return "#22c55e";
  if (hw <= 20) return "#84cc16";
  if (hw <= 40) return "#f59e0b";
  if (hw <= 60) return "#f97316";
  return "#ef4444";
}

export default function InfoOverlay({
  mode,
  isoResult,
  stopRoutes,
  routeMeta,
  maxTimeMin,
  focusedRoute,
  onRouteClick,
  showFrequency,
}: InfoOverlayProps) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const isoUsed = isoResult?.usedRoutes ?? [];
  const directSet = new Set(stopRoutes);
  const directRoutes  = mode === "isochrone" ? isoUsed.filter(r =>  directSet.has(r)) : [];
  const transferRoutes = mode === "isochrone" ? isoUsed.filter(r => !directSet.has(r)) : [];
  const hasContent = mode === "routes" ? stopRoutes.length > 0 : isoResult !== null;

  if (!hasContent) return null;

  // ── 手機版：底部路線列（等時線模式分直達/轉乘兩排） ─────────────────────
  if (isMobile) {
    const routeStrip = (routes: string[], label?: string) => (
      <div style={{ display: "flex", alignItems: "center", overflowX: "auto", overflowY: "hidden", gap: 6, padding: "0 12px", scrollbarWidth: "none" as const, flex: 1 }}>
        {label && (
          <span style={{ fontSize: 10, color: "var(--text-secondary)", flexShrink: 0, opacity: 0.7 }}>{label}</span>
        )}
        {routes.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-secondary)", flexShrink: 0, opacity: 0.5 }}>—</span>
        )}
        {routes.map(route => {
          const meta = routeMeta[route];
          const hw = meta?.headway_weekday ?? -1;
          const active = focusedRoute === route;
          return (
            <button
              key={route}
              onClick={() => onRouteClick(active ? null : route)}
              style={{
                flexShrink: 0, padding: "4px 9px", borderRadius: 7,
                fontSize: 12, fontWeight: 600,
                border: active ? "1px solid rgba(99,102,241,0.9)" : "1px solid rgba(255,255,255,0.15)",
                background: active ? "rgba(99,102,241,0.35)" : "rgba(255,255,255,0.08)",
                color: active ? "#c7d2fe" : "var(--text-primary)",
                cursor: "pointer", fontFamily: "inherit",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              {route}
              {showFrequency && hw > 0 && (
                <span style={{ fontSize: 10, color: headwayColor(hw), fontWeight: 700 }}>{headwayLabel(hw)}</span>
              )}
            </button>
          );
        })}
      </div>
    );

    if (mode === "isochrone" && isoResult) {
      return (
        <div style={{
          position: "fixed", bottom: 16, left: 80, right: 16,
          background: "rgba(20,20,35,0.88)",
          border: "1px solid rgba(255,255,255,0.12)",
          backdropFilter: "blur(12px)", borderRadius: 14,
          zIndex: 10, boxShadow: "0 2px 16px rgba(0,0,0,0.5)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* 直達一排 */}
          <div style={{ display: "flex", alignItems: "center", height: 40, borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
            <span style={{ fontSize: 10, color: "#34d399", fontWeight: 700, paddingLeft: 10, flexShrink: 0 }}>直達</span>
            {routeStrip(directRoutes)}
          </div>
          {/* 轉乘一排 */}
          <div style={{ display: "flex", alignItems: "center", height: 40 }}>
            <span style={{ fontSize: 10, color: "var(--text-secondary)", paddingLeft: 10, flexShrink: 0, opacity: 0.7 }}>轉乘</span>
            {routeStrip(transferRoutes)}
          </div>
        </div>
      );
    }

    // routes 模式：單排
    return (
      <div style={{
        position: "fixed", bottom: 16, left: 80, right: 16,
        height: 52,
        background: "rgba(20,20,35,0.88)",
        border: "1px solid rgba(255,255,255,0.12)",
        backdropFilter: "blur(12px)", borderRadius: 14,
        display: "flex", alignItems: "center",
        zIndex: 10, boxShadow: "0 2px 16px rgba(0,0,0,0.5)",
      }}>
        {routeStrip(stopRoutes)}
      </div>
    );
  }

  // ── 桌面版（原有樣式）────────────────────────────────────────────────────
  return (
    <div
      className="glass-panel fade-in"
      style={{
        position: "fixed",
        top: 20, right: 20,
        minWidth: 200, maxWidth: 300,
        padding: "16px 20px",
        zIndex: 10,
        display: "flex", flexDirection: "column", gap: 14,
        maxHeight: "80vh", overflowY: "auto",
      }}
    >
      {/* Header */}
      <div style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {mode === "routes" ? "此站路線" : `計算結果 · ${maxTimeMin} 分鐘內`}
      </div>

      {/* 等時線統計 */}
      {mode === "isochrone" && isoResult && (
        <Stat icon="🚏" label="可達站牌" value={isoResult.nodeCount.toString()} unit="站" accent="#34d399" />
      )}

      {/* 路線列表 */}
      {mode === "routes" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {stopRoutes.length > 0 ? stopRoutes.map(route => (
            <RouteButton
              key={route} route={route}
              active={focusedRoute === route}
              meta={routeMeta[route]}
              showFrequency={showFrequency}
              onClick={() => onRouteClick(focusedRoute === route ? null : route)}
            />
          )) : <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>無</span>}
        </div>
      ) : (
        <>
          {directRoutes.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 6 }}>
                直接搭乘 <span style={{ opacity: 0.6 }}>· {directRoutes.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {directRoutes.map(route => (
                  <RouteButton key={route} route={route} active={focusedRoute === route} meta={routeMeta[route]} showFrequency={showFrequency} onClick={() => onRouteClick(focusedRoute === route ? null : route)} />
                ))}
              </div>
            </div>
          )}
          {transferRoutes.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 6 }}>
                需要轉乘 <span style={{ opacity: 0.6 }}>· {transferRoutes.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {transferRoutes.map(route => (
                  <RouteButton key={route} route={route} active={focusedRoute === route} meta={routeMeta[route]} showFrequency={showFrequency} onClick={() => onRouteClick(focusedRoute === route ? null : route)} />
                ))}
              </div>
            </div>
          )}
          {directRoutes.length === 0 && transferRoutes.length === 0 && (
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>無</span>
          )}
        </>
      )}

      {mode === "isochrone" && isoResult && isoResult.durationMs > 0 && (
        <div style={{ fontSize: 9, color: "var(--text-secondary)", textAlign: "right", opacity: 0.5 }}>
          耗時: {isoResult.durationMs}ms
        </div>
      )}
    </div>
  );
}

function RouteButton({ route, active, meta, showFrequency, onClick }: {
  route: string; active: boolean; meta: RouteMeta | undefined;
  showFrequency: boolean; onClick: () => void;
}) {
  const subtitle = meta?.departure && meta?.destination
    ? `${meta.departure} ↔ ${meta.destination}` : "";
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left", padding: "5px 8px", borderRadius: 5,
        border: active ? "1px solid rgba(99,102,241,0.8)" : "1px solid transparent",
        background: active ? "rgba(99,102,241,0.25)" : "rgba(99,102,241,0.1)",
        color: active ? "#c7d2fe" : "var(--text-primary)",
        cursor: "pointer", transition: "all 0.15s",
      }}
      title={active ? "點擊取消，恢復等時線裁切" : "點擊顯示完整路線走向"}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: active ? 700 : 500 }}>{route}</span>
        {showFrequency && meta && (meta.headway_weekday ?? -1) > 0 && (
          <span style={{ fontSize: 10, fontWeight: 600, color: headwayColor(meta.headway_weekday ?? -1), flexShrink: 0 }}>
            每{headwayLabel(meta.headway_weekday ?? -1)}
          </span>
        )}
      </div>
      {subtitle && (
        <div style={{ fontSize: 10, color: active ? "rgba(199,210,254,0.7)" : "var(--text-secondary)", marginTop: 1 }}>
          {subtitle}
        </div>
      )}
    </button>
  );
}

function Stat({ icon, label, value, unit, accent }: {
  icon: string; label: string; value: string; unit: string; accent: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 16, width: 20, textAlign: "center" }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>{label}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: accent, fontFamily: "var(--font-en)", lineHeight: 1.2 }}>
          {value}
          <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-secondary)", marginLeft: 3 }}>{unit}</span>
        </div>
      </div>
    </div>
  );
}
