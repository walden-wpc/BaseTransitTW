/**
 * graphLoader.ts — Graph JSON 動態載入與快取
 *
 * 設計：按縣市動態 fetch，Map 快取（同一縣市只載入一次）
 * Key 規則：tdxName.toLowerCase()，與腳本輸出的檔名完全一致
 *   e.g. "NewTaipei" → key = "newtaipei" → /data/newtaipei.json
 */

export interface GraphNode {
  lat: number;
  lon: number;
  name: string;
  routes?: string[];
}

export interface GraphEdge {
  to: string;
  w: number;
  t: "bus" | "walk";
  r?: string;
  wait?: number;
}

export interface Graph {
  meta: {
    city: string;
    node_count: number;
    edge_count: number;
    transit_edges: number;
    walk_edges: number;
    generated_at: string;
  };
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge[]>;
}

// ── 城市設定（key = tdxName.toLowerCase()，與 public/data/ 檔名一致）────────
export type CityRegion = "north" | "central" | "south" | "east" | "island";

export interface CityConfig {
  key: string;                  // = tdxName.toLowerCase()，也是檔名 prefix
  displayName: string;
  tdxName: string;              // TDX API city name / --city 腳本參數
  center: [number, number];     // [lng, lat]
  zoom: number;
  region: CityRegion;
}

export const CITY_CONFIGS: CityConfig[] = [
  // ── 北部 ──
  { key: "taipei",           displayName: "台北市",  tdxName: "Taipei",           center: [121.5654, 25.0330], zoom: 12, region: "north" },
  { key: "newtaipei",        displayName: "新北市",  tdxName: "NewTaipei",        center: [121.4653, 25.0169], zoom: 11, region: "north" },
  { key: "keelung",          displayName: "基隆市",  tdxName: "Keelung",          center: [121.7288, 25.1326], zoom: 13, region: "north" },
  { key: "taoyuan",          displayName: "桃園市",  tdxName: "Taoyuan",          center: [121.2168, 24.9736], zoom: 11, region: "north" },
  { key: "hsinchu",          displayName: "新竹市",  tdxName: "Hsinchu",          center: [120.9647, 24.8138], zoom: 13, region: "north" },
  { key: "hsinchucounty",    displayName: "新竹縣",  tdxName: "HsinchuCounty",    center: [121.0157, 24.7067], zoom: 11, region: "north" },
  { key: "yilancounty",      displayName: "宜蘭縣",  tdxName: "YilanCounty",      center: [121.7519, 24.7022], zoom: 12, region: "north" },
  // ── 中部 ──
  { key: "taichung",         displayName: "台中市",  tdxName: "Taichung",         center: [120.6736, 24.1477], zoom: 12, region: "central" },
  { key: "miaolicounty",     displayName: "苗栗縣",  tdxName: "MiaoliCounty",     center: [120.8214, 24.5602], zoom: 12, region: "central" },
  { key: "changhuacounty",   displayName: "彰化縣",  tdxName: "ChanghuaCounty",   center: [120.5136, 24.0521], zoom: 12, region: "central" },
  { key: "nantoucounty",     displayName: "南投縣",  tdxName: "NantouCounty",     center: [120.9876, 23.9609], zoom: 11, region: "central" },
  { key: "yunlincounty",     displayName: "雲林縣",  tdxName: "YunlinCounty",     center: [120.5245, 23.7564], zoom: 12, region: "central" },
  // ── 南部 ──
  { key: "tainan",           displayName: "台南市",  tdxName: "Tainan",           center: [120.2070, 22.9998], zoom: 12, region: "south" },
  { key: "kaohsiung",        displayName: "高雄市",  tdxName: "Kaohsiung",        center: [120.3133, 22.6273], zoom: 12, region: "south" },
  { key: "chiayi",           displayName: "嘉義市",  tdxName: "Chiayi",           center: [120.4473, 23.4800], zoom: 13, region: "south" },
  { key: "chiayicounty",     displayName: "嘉義縣",  tdxName: "ChiayiCounty",     center: [120.5748, 23.4518], zoom: 11, region: "south" },
  { key: "pingtungcounty",   displayName: "屏東縣",  tdxName: "PingtungCounty",   center: [120.4878, 22.6750], zoom: 12, region: "south" },
  // ── 東部 ──
  { key: "hualiencounty",    displayName: "花蓮縣",  tdxName: "HualienCounty",    center: [121.6061, 23.9871], zoom: 12, region: "east" },
  { key: "taitungcounty",    displayName: "台東縣",  tdxName: "TaitungCounty",    center: [121.1473, 22.7583], zoom: 12, region: "east" },
  // ── 外島 ──
  { key: "penghucounty",     displayName: "澎湖縣",  tdxName: "PenghuCounty",     center: [119.5793, 23.5711], zoom: 12, region: "island" },
  { key: "kinmencounty",     displayName: "金門縣",  tdxName: "KinmenCounty",     center: [118.3179, 24.4493], zoom: 12, region: "island" },
  { key: "lienchiangcounty", displayName: "連江縣",  tdxName: "LienchiangCounty", center: [119.9516, 26.1580], zoom: 13, region: "island" },
];

export const CITY_CONFIG_MAP: Record<string, CityConfig> = Object.fromEntries(
  CITY_CONFIGS.map(c => [c.key, c])
);

export const REGION_LABELS: Record<CityRegion, string> = {
  north:   "北部",
  central: "中部",
  south:   "南部",
  east:    "東部",
  island:  "外島",
};

export const REGION_ORDER: CityRegion[] = ["north", "central", "south", "east", "island"];
export const ALL_CITY_KEYS = CITY_CONFIGS.map(c => c.key);

// ── 通勤圈預設組合 ─────────────────────────────────────────────────────────────
export interface CommuteZone {
  id: string;
  label: string;
  cities: string[];
  center: [number, number];
  zoom: number;
}

export const COMMUTE_ZONES: CommuteZone[] = [
  { id: "北北基桃", label: "北北基桃", cities: ["taipei", "newtaipei", "keelung", "taoyuan"],                          center: [121.40, 25.02], zoom: 10 },
  { id: "北北宜",   label: "北北宜",   cities: ["taipei", "newtaipei", "yilancounty"],                                  center: [121.72, 24.95], zoom: 10 },
  { id: "桃竹竹苗", label: "桃竹竹苗", cities: ["taoyuan", "hsinchu", "hsinchucounty", "miaolicounty"],                 center: [121.00, 24.65], zoom: 10 },
  { id: "中彰投苗", label: "中彰投苗", cities: ["taichung", "changhuacounty", "nantoucounty", "miaolicounty"],          center: [120.75, 24.10], zoom: 10 },
  { id: "雲嘉嘉南", label: "雲嘉嘉南", cities: ["yunlincounty", "chiayi", "chiayicounty", "tainan"],                    center: [120.35, 23.35], zoom: 10 },
  { id: "南高屏",   label: "南高屏",   cities: ["tainan", "kaohsiung", "pingtungcounty"],                               center: [120.47, 22.68], zoom: 10 },
  { id: "花東",     label: "花東",     cities: ["hualiencounty", "taitungcounty"],                                       center: [121.35, 23.50], zoom: 10 },
];

// ── 快取 ──────────────────────────────────────────────────────────────────────
const graphCache = new Map<string, Graph>();
const loadingPromises = new Map<string, Promise<Graph>>();

export async function loadGraph(city: string = "taoyuan"): Promise<Graph> {
  const key = city.toLowerCase();

  if (!CITY_CONFIG_MAP[key]) throw new Error(`找不到城市 "${city}" 的設定`);

  if (graphCache.has(key)) return graphCache.get(key)!;
  if (loadingPromises.has(key)) return loadingPromises.get(key)!;

  // key 與 tdxName.toLowerCase() 相同，直接作為檔名
  const filePath = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/${key}.json`;

  const promise = fetch(filePath)
    .then((res) => {
      if (!res.ok) {
        const hint = res.status === 404 ? "｜請先執行資料管線腳本：python scripts/fetch_tdx.py --city <City>" : "";
        throw new Error(`載入 ${filePath} 失敗 (HTTP ${res.status})${hint}`);
      }
      return res.json() as Promise<Graph>;
    })
    .then((graph) => {
      graphCache.set(key, graph);
      loadingPromises.delete(key);
      return graph;
    })
    .catch((err) => {
      loadingPromises.delete(key);
      throw err;
    });

  loadingPromises.set(key, promise);
  return promise;
}

export function getCachedGraph(city: string = "taoyuan"): Graph | null {
  return graphCache.get(city.toLowerCase()) ?? null;
}
