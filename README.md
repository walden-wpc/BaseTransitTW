```    
  / __ )____ _________ /_  __/________ _____  ____(_) //_  __/ |     / /
   / __  / __ `/ ___/ _ \ / / / ___/ __ `/ __ \/ ___/ / __// /  | | /| / / 
   / /_/ / /_/ (__  )  __// / / /  / /_/ / / / (__  ) / /_ / /   | |/ |/ /  
   /_____/\__,_/____/\___//_/ /_/   \__,_/_/ /_/____/_/\__//_/    |__/|__/   
```

# BaseTransitTW / 臺灣等時路網（公車）

* Website: [➜ 開始使用 start](https://walden-wpc.github.io/BaseTransitTW/)
* License: CC BY-NC 4.0 (Attribution-NonCommercial)
* Data Source: TDX (Ministry of Transport)

BaseTransitTW 是一個純前端執行的臺灣公車路網視覺化與「等時線（Isochrone）」探索工具。給定一個起點、時間限制與轉乘次數，系統能計算出您在指定條件內可以抵達的地理範圍。

## 核心特色 (Features)

* 迅速的等時線計算：採用加權最短路徑樹（Dijkstra）演算法。
* 保障隱私與零後端架構：本產品沒有任何後端伺服器。所有的路網資料皆為靜態預載，而路徑規劃運算完全在您的瀏覽器內離線執行。
* 基於 MapLibre GL JS 與 WebGL 驅動的地圖引擎。

## 技術透明度 (Under the Hood)

1. 資料管線：以定期腳本抓取交通部 TDX 開放平台資料，預處理為極度輕量化的拓樸 Graph JSON。
2. 運算隔離：演算法層被完全封裝在獨立的背景執行緒（Web Worker）中。
3. 無伺服器部署：前端採用 Next.js 靜態輸出並託管於 GitHub Pages CDN。

## 已知限制 (Known Limitations)

* 非即時動態資料：基於預處理的班表，不會反映當日的即時路況或誤點。
* 數據精確度落差：無納入特別規則（例如：國道客運短距離站點禁止上下車）以及平日假日班距差異。
* 硬體效能瓶頸：開啟「全台路網模式」時，記憶體占用可能稍高（超過 200MB）。

## 專案狀態與免責聲明 (Status & Disclaimer)

本專案為個人實驗性質的技術展示。產品按現狀提供。

## 授權條款 (License)

版權所有 (c) 2026
本專案採用 CC BY-NC 4.0 授權。您可以自由檢視原始碼，但嚴禁任何形式的商業營利行為。

### 開發幕後

**BaseTransitTW 的誕生，起點其實很單純：想找離公司或學校的直達公車，並在沿線站點找租房。**

這套系統的核心骨幹也是圍繞在低成本部署、多裝置可用，總之對所有人都很友善。

主要架構都是來自我在一步步完善產品過程中摸索出來的。例如怎麼用 Dijkstra 演算法算路徑、以及為了不讓網頁卡死而把運算丟給 Web Worker

不過，在打扣這件事上，我完全擁抱了 AI 工具。這個專案絕大部分程式碼是透過 Vibecoding 一點一滴建立起來的，當然，我刻意在整體保持了架構清晰、維修容易、標注明確等特性，這樣萬一token爆了還可以方便地手動維修，不至於束手無策。

這應該是2026年把好點子變成穩定的產品的最佳解吧？


------[English version]------


# BaseTransitTW

BaseTransitTW is a pure front-end Taiwan bus network visualization and "Isochrone" exploration tool. Given a starting point, a time limit, and the maximum number of transfers, the system calculates the geographic area you can reach within these specified conditions.

## Features

* Rapid Isochrone Calculation: Powered by a weighted shortest-path tree (Dijkstra's algorithm).
* Privacy-First & Zero-Backend Architecture: This product has absolutely no backend server. All transit network data is statically preloaded, and pathfinding calculations are executed 100% offline within your browser.
* Map Engine: Driven by MapLibre GL JS and WebGL.

## Under the Hood

1. Data Pipeline: Uses scheduled scripts to fetch data from the MOTC TDX open platform, pre-processing it into an extremely lightweight topological Graph JSON.
2. Computation Isolation: The algorithm layer is completely encapsulated within an independent background thread (Web Worker).
3. Serverless Deployment: The frontend uses Next.js static export and is hosted on GitHub Pages CDN.

## Known Limitations

* Non-Real-Time Data: Based on pre-processed schedules; does not reflect real-time traffic conditions or delays.
* Data Precision Gaps: Does not account for special ticketing rules (e.g., no short-distance boarding/alighting for intercity buses) or frequency differences between weekdays and weekends.
* Hardware Bottlenecks: Memory usage can be slightly high (over 200MB) when "Full Taiwan Network Mode" is enabled.

## Status & Disclaimer

This project is a personal, experimental technical showcase. The product is provided "as-is".

## License

Copyright (c) 2026
This project is licensed under CC BY-NC 4.0. You are free to view and study the source code, but any form of commercial or for-profit use is strictly prohibited.

### Behind the Scenes

The birth of BaseTransitTW started from a very simple need: I wanted to find direct buses to my office or school so I could look for an apartment to rent along those routes.

The core backbone of this system was built around being low-cost to deploy, multi-device friendly, and overall just accessible to everyone.

The main architecture came from my own trial and error while polishing the product step by step—like figuring out how to use Dijkstra's algorithm for pathfinding, or offloading the heavy calculations to a Web Worker so the page wouldn't freeze.

However, when it came to actually "writing the code", I fully embraced AI tools. The vast majority of the code in this project was built bit by bit through Vibecoding. Of course, I deliberately kept the overall architecture clear, easy to maintain, and well-commented. This way, if I ever run out of tokens, Anyone can easily jump in and fix things manually without being totally helpless.

This is probably the best way in 2026 to turn a good idea into a stable product, right?