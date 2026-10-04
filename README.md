# D1975 / 西成客专

D1975 次列车手机地图：西安北 ↔ 成都东，沿西成客运专线。

这是独立应用，不是 [xibaoview](https://github.com/huming0618/xibaoview) 的改版，也不修改 xibaoview。线路来自 OpenStreetMap 的 **西成客专线** 正线折线，不是站与站之间的直线。

## 功能

- **地图**：全线与八站，搜索车站，一键适配全线
- **站序**：按正线公里标排站。竖屏站名在刻度右侧，横屏（`innerWidth > innerHeight`）站名在刻度下方
- **海拔**：沿铁路线折线每 1 km 采样。「海拔」细线、「起伏」更平滑；车站点落在平滑曲线上；相邻坡度上限 30‰
- **河流**：线路实际跨越的河流，中文名，同一套公里标
- **停留**：仅在距站 400 m 内开始停留；距该站超过 800 m 才结束并写入本机。停留中显示「正在停」，站间不算停留。丢失 GPS 不会结束停留
- **定位**：点按立即开始，12 秒客户端超时，再点取消。定位成功后跟随：标记与地图随 GPS 移动。按钮：定位 / 定位中 / 跟随中 / 跟随我。拖动地图停止跟随。时速：定位开启时记第一个点，之后每 3 分钟：`时速 N km/h`，尚未测得则 `时速尚未测得`

## 车站（西安北 = 0 km，沿 OSM 正线折线计公里）

2026 年 9 月时刻表（hao86、车主手册）停 **洋县西**，不再停佛坪。hao86 仍列西安西，因此保留。佛坪只是过路，不画作停站。

| 站序 | 站名 | 公里标 | OSM |
|------|------|--------|-----|
| 1 | 西安北 | 0.0 | [4185074601](https://www.openstreetmap.org/node/4185074601) |
| 2 | 西安西（曾用名阿房宫） | 20.2 | [5762027860](https://www.openstreetmap.org/node/5762027860) |
| 3 | 洋县西 | 191.2 | [3826011104](https://www.openstreetmap.org/node/3826011104) |
| 4 | 汉中 | 240.5 | [9295305367](https://www.openstreetmap.org/node/9295305367) |
| 5 | 广元 | 378.4 | [1532826989](https://www.openstreetmap.org/node/1532826989) |
| 6 | 绵阳 | 543.6 | [1742504939](https://www.openstreetmap.org/node/1742504939) |
| 7 | 德阳 | 590.4 | [2099675139](https://www.openstreetmap.org/node/2099675139) |
| 8 | 成都东 | 656.3 | [7212021583](https://www.openstreetmap.org/node/7212021583) |

全线约 656 km（OSM 西成客专线折线，裁到两端车站；公开里程约 658 km）。洋县西→汉中约 49 km，与约 18 分钟运行相符。

## 运行

```bash
npm install
npm run dev
```

开发服务器默认 `http://127.0.0.1:4742`。

```bash
npm run build
npm run preview
```

## Android APK

Capacitor 6。App ID：`com.huming.d1975view`，应用名：D1975。

```bash
npm install
npm run build:android
cd android && ./gradlew assembleDebug
```

`build:android` 会执行 `VITE_BASE=./ vite build && npx cap sync android`，并运行 `scripts/patch-fused-location.py`，避免 Android Fused Location 把 JS timeout 当成 `setMaxUpdateDelayMillis`、以及 `maximumAge: 0` 丢掉最近一次定位。

重新生成线路 / 海拔 / 河流：

```bash
npm run build:data
```

重新下载沿线窄带离线底图（OSM.fr，z6–z10）：

```bash
npm run build:tiles
```

## 底图

运行时顺序：**打包瓦片 → Cache API → CARTO Dark → OSM**（CARTO 失败时再试 OSM.fr / OSM.org）。不使用 Esri。走廊瓦片打进 `public/tiles`，只覆盖西成客专附近，不下整国。

## 数据

- 线路：OpenStreetMap `name=西成客专线` 高速正线，西安北→成都东
- 车站：上表八站。过路站（佛坪、城固北、江油等）不进站表
- 海拔：Open-Meteo Elevation API（SRTM 90 m），沿正线每 1 km 采样
- 河流：OSM `waterway=river` 与正线相交的中文名
- 地图数据 © OpenStreetMap 贡献者，[ODbL](https://opendatacommons.org/licenses/odbl/)。
