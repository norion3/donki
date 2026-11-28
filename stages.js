/**
 * stages.js
 * @version v1.0 (High-Rise 4 Stages Data & Terrain Helpers - Phase 2)
 * @changes
 *   - オリジナル準拠の高層4ステージ定義（25m 6層＋7段目、50m 5層コンベア＋6段目、75m 2系統ロングリフト＋ジャッキ回廊＋6段目、100m 5層ピラミッド＆8本杭＋6段目）を実装
 *   - 水平・傾斜・左端フラット付きフロアの高さ計算 getFloorY() および勾配方向判定を実装
 *   - 100m 杭穴判定・中央崩落判定・統合着地可否判定 isSolidFloorAt() を実装
 *   - 50m 電動伸縮はしご伸長率計算および 75m 循環エレベーター座標計算ヘルパーを実装
 *   - 落下ダメージ時の直前安全床復帰用スポーン探索 findNearestSafeSpawn() を実装
 *
 * Tier 1 基盤モジュール：全4ステージの静的構造データと純粋数学ベースの地形・ギミック参照ヘルパー
 */

import {
  STAGE_WIDTH_HALF,
  STAGE_TOP_Y,
  clamp,
  lerp,
  safeFinite
} from './constants.js?v=1';

/* ============================================================================
 * 1. フロア高さ・勾配計算ヘルパー（純粋関数・ゼロアロケーション）
 * ========================================================================== */

/**
 * 指定フロア上の任意 X 座標における床面 Y 座標を算出
 * （flatUntilX 指定があるフロアは左端〜flatUntilX を水平、それより右を傾斜として算出）
 * @param {object} floor
 * @param {number} x
 * @returns {number}
 */
export function getFloorY(floor, x) {
  if (!floor) return 0;
  const sx = safeFinite(x, 0);

  if (typeof floor.flatUntilX === 'number') {
    if (sx <= floor.flatUntilX) return floor.yLeft;
    const slopeSpan = Math.max(0.0001, floor.xMax - floor.flatUntilX);
    const tSlope = clamp((sx - floor.flatUntilX) / slopeSpan, 0, 1);
    return lerp(floor.yLeft, floor.yRight, tSlope);
  }

  const span = Math.max(0.0001, floor.xMax - floor.xMin);
  const t = clamp((sx - floor.xMin) / span, 0, 1);
  return lerp(floor.yLeft, floor.yRight, t);
}

/**
 * フロアの下り坂方向を返す（+1: 右下がり / -1: 左下がり / 0: 水平）
 * @param {object} floor
 * @returns {number}
 */
export function getFloorSlopeDir(floor) {
  if (!floor) return 0;
  const diff = floor.yRight - floor.yLeft;
  if (Math.abs(diff) < 0.001) return 0;
  return diff < 0 ? 1 : -1;
}

/* ============================================================================
 * 2. ステージ定義ビルド用内部ヘルパー
 * ========================================================================== */

/**
 * ステージ定義内のはしご・杭・敵・木箱・コイン・オイル炉に基準 Y 座標を事前付与して凍結する
 * @param {object} raw
 * @returns {object}
 */
function finalizeStageDef(raw) {
  const floors = raw.floors.map((f) => Object.freeze({ ...f }));

  const ladders = raw.ladders.map((l) => {
    const fromFl = floors[l.fromFloor];
    const toFl = floors[l.toFloor];
    const yBottom = getFloorY(fromFl, l.x);
    const yTop = getFloorY(toFl, l.x);
    return Object.freeze({
      ...l,
      retractable: Boolean(l.retractable),
      yBottom,
      yTop
    });
  });

  const rivets = (raw.rivets || []).map((r, idx) => {
    const fl = floors[r.floorIdx];
    return Object.freeze({
      id: idx,
      floorIdx: r.floorIdx,
      x: r.x,
      y: getFloorY(fl, r.x),
      holeHalfWidth: r.holeHalfWidth || 0.425
    });
  });

  const furnaces = (raw.furnaces || []).map((fn) => {
    const fl = floors[fn.floorIdx];
    return Object.freeze({
      ...fn,
      y: getFloorY(fl, fn.x)
    });
  });

  const elevators = (raw.elevators || []).map((el) => Object.freeze({ ...el }));

  const enemies = (raw.enemies || []).map((en) => Object.freeze({ ...en }));
  const crates = (raw.crates || []).map((cr) => Object.freeze({ ...cr }));
  const coins = (raw.coins || []).map((co) => Object.freeze({ ...co }));
  const conveyorCans = (raw.conveyorCans || []).map((cs) => Object.freeze({ ...cs }));

  const playerSpawnFloor = floors[raw.playerSpawn.floorIdx] || floors[0];
  const playerSpawn = Object.freeze({
    ...raw.playerSpawn,
    y: getFloorY(playerSpawnFloor, raw.playerSpawn.x)
  });

  const bossFloor = floors[raw.boss.floorIdx] || floors[floors.length - 1];
  const boss = Object.freeze({
    ...raw.boss,
    y: getFloorY(bossFloor, raw.boss.x)
  });

  const heroineFloor = floors[raw.heroine.floorIdx] || floors[floors.length - 1];
  const heroine = Object.freeze({
    ...raw.heroine,
    y: getFloorY(heroineFloor, raw.heroine.x)
  });

  return Object.freeze({
    ...raw,
    floors: Object.freeze(floors),
    ladders: Object.freeze(ladders),
    rivets: Object.freeze(rivets),
    furnaces: Object.freeze(furnaces),
    elevators: Object.freeze(elevators),
    enemies: Object.freeze(enemies),
    crates: Object.freeze(crates),
    coins: Object.freeze(coins),
    conveyorCans: Object.freeze(conveyorCans),
    playerSpawn,
    boss,
    heroine
  });
}

/* ============================================================================
 * 3. 高層4ステージ完全定義（25m / 50m / 75m / 100m）
 * ========================================================================== */

/**
 * Stage 1 (index 0): 25m — IRON GIRDERS
 * オリジナル完全準拠・6層ジグザグ鉄骨＋7段目ヒロインバルコニー
 */
const STAGE_25M = finalizeStageDef({
  index: 0,
  code: '25m',
  title: '25m IRON GIRDERS',
  themeBg: 0x0f172a,
  clearCondition: 'reach_heroine',
  hasAbyss: false,
  hasBarrelStack: true,
  pillarColor: 0x334155,
  floors: [
    // 1F: 左低→右高（階段付）、左端にオイル炉＆スタート地点
    { id: 0, label: 'floor_1f', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 0.00, yRight: 0.55, color: 0xe11d48, hasSteps: true },
    // 2F: 左高→右低（タルは左→右へ転がる）
    { id: 1, label: 'floor_2f', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 3.05, yRight: 2.45, color: 0xf43f5e, hasSteps: false },
    // 3F: 左低→右高（階段付、タルは右→左へ転がる）
    { id: 2, label: 'floor_3f', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 4.95, yRight: 5.55, color: 0xe11d48, hasSteps: true },
    // 4F: 左高→右低
    { id: 3, label: 'floor_4f', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 8.05, yRight: 7.45, color: 0xf43f5e, hasSteps: false },
    // 5F: 左低→右高（階段付）
    { id: 4, label: 'floor_5f', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 9.95, yRight: 10.55, color: 0xe11d48, hasSteps: true },
    // 6F: 左フラット（ボス＆タル山）＋右緩斜
    { id: 5, label: 'floor_6f', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 12.60, yRight: 12.25, flatUntilX: -1.4, color: 0xf43f5e, hasSteps: false },
    // 7F: 最上階フラットバルコニー（ヒロイン）
    { id: 6, label: 'floor_7f_goal', xMin: -1.2, xMax: 2.6, yLeft: STAGE_TOP_Y, yRight: STAGE_TOP_Y, color: 0xfbbf24, hasSteps: false }
  ],
  ladders: [
    { x:  4.0, fromFloor: 0, toFloor: 1 }, // 1F→2F メイン右はしご
    { x: -0.6, fromFloor: 0, toFloor: 1 }, // 1F→2F 中央ショートカット
    { x: -4.0, fromFloor: 1, toFloor: 2 }, // 2F→3F メイン左はしご
    { x:  1.2, fromFloor: 1, toFloor: 2 }, // 2F→3F 中央サブはしご
    { x:  4.0, fromFloor: 2, toFloor: 3 }, // 3F→4F メイン右はしご
    { x: -1.2, fromFloor: 2, toFloor: 3 }, // 3F→4F 中央サブはしご
    { x: -4.0, fromFloor: 3, toFloor: 4 }, // 4F→5F メイン左はしご
    { x:  1.4, fromFloor: 3, toFloor: 4 }, // 4F→5F 中央サブはしご
    { x:  4.0, fromFloor: 4, toFloor: 5 }, // 5F→6F メイン右はしご
    { x: -0.4, fromFloor: 4, toFloor: 5 }, // 5F→6F 中央サブはしご
    { x:  1.9, fromFloor: 5, toFloor: 6 }, // 6F→7F ゴール右はしご
    { x: -0.6, fromFloor: 5, toFloor: 6 }  // 6F→7F ゴール左はしご
  ],
  furnaces: [
    { floorIdx: 0, x: -4.65, label: 'oil_furnace' }
  ],
  elevators: [],
  rivets: [],
  conveyorCans: [],
  jackSpawner: null,
  fireballConfig: {
    initialCount: 0,
    spawnFromFurnace: true,
    spawnPositions: [{ floorIdx: 0, x: -4.45 }]
  },
  playerSpawn: { floorIdx: 0, x: -3.45, facing: 1 },
  boss: {
    floorIdx: 5,
    x: -3.55,
    mode: 'barrel_thrower',
    patrolMin: -3.55,
    patrolMax: -3.55,
    speed: 0,
    hurtMinX: -2.65
  },
  barrelStack: [
    { x: -4.92, yOff: 0.36, z: -0.22, rotY:  0.12 },
    { x: -4.24, yOff: 0.36, z: -0.22, rotY: -0.10 },
    { x: -4.58, yOff: 0.36, z:  0.40, rotY:  0.20 },
    { x: -4.56, yOff: 0.98, z:  0.02, rotY: -0.06 }
  ],
  heroine: { floorIdx: 6, x: 0.7, goalRadius: 1.05, clearPlayerX: -0.25, clearFriendX: 0.85 },
  enemies: [
    { floorIdx: 0, x:  1.8, type: 'walker', speed: 1.45, dir: -1 },
    { floorIdx: 2, x:  0.4, type: 'walker', speed: 1.60, dir:  1 },
    { floorIdx: 3, x: -1.4, type: 'spiky',  speed: 1.40, dir: -1 },
    { floorIdx: 4, x:  1.2, type: 'spiky',  speed: 1.55, dir:  1 }
  ],
  crates: [
    { floorIdx: 0, x: -1.4, hasBattery: false },
    { floorIdx: 1, x: -2.4, hasBattery: true  },
    { floorIdx: 3, x:  2.4, hasBattery: false },
    { floorIdx: 4, x:  0.6, hasBattery: true  }
  ],
  coins: [
    { floorIdx: 0, x:  0.5 },
    { floorIdx: 1, x:  1.8 },
    { floorIdx: 2, x: -2.2 },
    { floorIdx: 3, x:  0.4 },
    { floorIdx: 4, x: -2.6 },
    { floorIdx: 5, x:  2.8 }
  ]
});

/**
 * Stage 2 (index 1): 50m — CONVEYOR FACTORY
 * 5層高層工場（反転ベルトコンベア×2・中央オイル炉・電動伸縮はしご）＋6段目バルコニー
 */
const STAGE_50M = finalizeStageDef({
  index: 1,
  code: '50m',
  title: '50m CONVEYOR FACTORY',
  themeBg: 0x0c1929,
  clearCondition: 'reach_heroine',
  hasAbyss: false,
  hasBarrelStack: false,
  pillarColor: 0x1e3a5f,
  floors: [
    // 1F: フラットスタートデッキ
    { id: 0, label: 'floor_1f', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 0.00, yRight: 0.00, color: 0x0284c7, hasSteps: false },
    // 2F: 反転ベルトコンベア①
    {
      id: 1, label: 'floor_2f_conveyor', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 2.90, yRight: 2.90, color: 0x0ea5e9, hasSteps: false,
      conveyor: Object.freeze({ baseSpeed: 1.55, initialDir: 1, reverseInterval: 7.5, warnSec: 1.2 })
    },
    // 3F: 中央オイル炉フロア（⚡電池配置）
    { id: 2, label: 'floor_3f_furnace', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 5.80, yRight: 5.80, color: 0x38bdf8, hasSteps: false },
    // 4F: 高速反転ベルトコンベア②
    {
      id: 3, label: 'floor_4f_conveyor', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 8.80, yRight: 8.80, color: 0x0ea5e9, hasSteps: false,
      conveyor: Object.freeze({ baseSpeed: 1.85, initialDir: -1, reverseInterval: 6.5, warnSec: 1.2 })
    },
    // 5F: ボス巡回フロア
    { id: 4, label: 'floor_5f_boss', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 11.90, yRight: 11.90, color: 0x0284c7, hasSteps: false },
    // 6F: 最上階ゴールバルコニー
    { id: 5, label: 'floor_6f_goal', xMin: -1.6, xMax: 2.2, yLeft: STAGE_TOP_Y, yRight: STAGE_TOP_Y, color: 0xfbbf24, hasSteps: false }
  ],
  ladders: [
    { x: -3.8, fromFloor: 0, toFloor: 1 },
    { x:  0.0, fromFloor: 0, toFloor: 1 },
    { x:  3.8, fromFloor: 0, toFloor: 1 },
    { x: -2.4, fromFloor: 1, toFloor: 2 },
    { x:  2.4, fromFloor: 1, toFloor: 2 },
    { x: -3.8, fromFloor: 2, toFloor: 3 },
    { x:  3.8, fromFloor: 2, toFloor: 3 },
    // 4F→5F 左右の電動伸縮スライドはしご（交互に伸縮）
    { x: -4.2, fromFloor: 3, toFloor: 4, retractable: true, period: 6.4, phaseOffset: 0.0, extendRatio: 0.56 },
    { x:  4.2, fromFloor: 3, toFloor: 4, retractable: true, period: 6.4, phaseOffset: 3.2, extendRatio: 0.56 },
    // 5F→6F ゴールはしご
    { x: -1.0, fromFloor: 4, toFloor: 5 },
    { x:  1.6, fromFloor: 4, toFloor: 5 }
  ],
  furnaces: [
    { floorIdx: 2, x: 0.0, label: 'oil_furnace_center' }
  ],
  elevators: [],
  rivets: [],
  conveyorCans: [
    { floorIdx: 1, interval: 4.1, speed: 1.95 },
    { floorIdx: 3, interval: 3.5, speed: 2.25 }
  ],
  jackSpawner: null,
  fireballConfig: {
    initialCount: 1,
    spawnFromFurnace: true,
    spawnPositions: [{ floorIdx: 2, x: 0.0 }]
  },
  playerSpawn: { floorIdx: 0, x: -4.2, facing: 1 },
  boss: {
    floorIdx: 4,
    x: 0.0,
    mode: 'patrol_boss',
    patrolMin: -2.75,
    patrolMax: 2.75,
    speed: 1.55
  },
  barrelStack: [],
  heroine: { floorIdx: 5, x: 0.3, goalRadius: 1.05, clearPlayerX: -0.65, clearFriendX: 0.45 },
  enemies: [
    { floorIdx: 0, x:  2.2, type: 'walker', speed: 1.55, dir: -1 },
    { floorIdx: 2, x: -2.8, type: 'spiky',  speed: 1.35, dir:  1 },
    { floorIdx: 2, x:  2.8, type: 'walker', speed: 1.55, dir: -1 }
  ],
  crates: [
    { floorIdx: 0, x:  0.0, hasBattery: false },
    { floorIdx: 2, x: -1.6, hasBattery: true  },
    { floorIdx: 2, x:  1.6, hasBattery: false },
    { floorIdx: 3, x:  0.0, hasBattery: true  }
  ],
  coins: [
    { floorIdx: 0, x: -1.8 },
    { floorIdx: 1, x:  0.0 },
    { floorIdx: 2, x:  4.0 },
    { floorIdx: 3, x: -2.0 },
    { floorIdx: 4, x: -3.2 },
    { floorIdx: 4, x:  3.2 }
  ]
});

/**
 * Stage 3 (index 2): 75m — ELEVATOR SHAFT
 * 高層2系統ロングリフト塔（左上昇・右下降）＋5Fバウンドジャッキ回廊＋6Fバルコニー
 */
const STAGE_75M = finalizeStageDef({
  index: 2,
  code: '75m',
  title: '75m ELEVATOR SHAFT',
  themeBg: 0x0b1f1e,
  clearCondition: 'reach_heroine',
  hasAbyss: true,
  hasBarrelStack: false,
  pillarColor: 0x1e3a38,
  floors: [
    // id 0: 左島1F（スタート）
    { id: 0,  label: 'left_island_1',   xMin: -STAGE_WIDTH_HALF, xMax: -2.85, yLeft: 0.00,  yRight: 0.00,  color: 0x10b981, hasSteps: false },
    // id 1: 左島2F
    { id: 1,  label: 'left_island_2',   xMin: -STAGE_WIDTH_HALF, xMax: -2.85, yLeft: 4.20,  yRight: 4.20,  color: 0x059669, hasSteps: false },
    // id 2: 中島1
    { id: 2,  label: 'mid_island_1',    xMin: -0.75, xMax: 0.75, yLeft: 2.20, yRight: 2.20, color: 0x10b981, hasSteps: false },
    // id 3: 中島2
    { id: 3,  label: 'mid_island_2',    xMin: -0.75, xMax: 0.75, yLeft: 5.50, yRight: 5.50, color: 0x059669, hasSteps: false },
    // id 4: 中島3
    { id: 4,  label: 'mid_island_3',    xMin: -0.75, xMax: 0.75, yLeft: 8.80, yRight: 8.80, color: 0x10b981, hasSteps: false },
    // id 5: 右島1
    { id: 5,  label: 'right_island_1',  xMin: 2.85, xMax: STAGE_WIDTH_HALF, yLeft: 0.40, yRight: 0.40, color: 0x10b981, hasSteps: false },
    // id 6: 右島2
    { id: 6,  label: 'right_island_2',  xMin: 2.85, xMax: STAGE_WIDTH_HALF, yLeft: 3.60, yRight: 3.60, color: 0x059669, hasSteps: false },
    // id 7: 右島3
    { id: 7,  label: 'right_island_3',  xMin: 2.85, xMax: STAGE_WIDTH_HALF, yLeft: 6.60, yRight: 6.60, color: 0x10b981, hasSteps: false },
    // id 8: 右島4
    { id: 8,  label: 'right_island_4',  xMin: 2.85, xMax: STAGE_WIDTH_HALF, yLeft: 9.50, yRight: 9.50, color: 0x059669, hasSteps: false },
    // id 9: 5F バウンドジャッキ回廊（左ボス→右へ跳ね飛ぶ）
    { id: 9,  label: 'floor_5f_jacks',  xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 12.15, yRight: 12.55, color: 0x14b8a6, hasSteps: true },
    // id 10: 6F ゴールバルコニー
    { id: 10, label: 'floor_6f_goal',   xMin: 0.4, xMax: 4.4, yLeft: STAGE_TOP_Y, yRight: STAGE_TOP_Y, color: 0xfbbf24, hasSteps: false }
  ],
  ladders: [
    // 左島連絡はしご
    { x: -4.2, fromFloor: 0, toFloor: 1 },
    // 中央島はしご塔
    { x:  0.0, fromFloor: 2, toFloor: 3 },
    { x:  0.0, fromFloor: 3, toFloor: 4 },
    // 右島連続はしご塔（右島1→2→3→4→5F）
    { x:  4.4, fromFloor: 5, toFloor: 6 },
    { x:  3.4, fromFloor: 6, toFloor: 7 },
    { x:  4.4, fromFloor: 7, toFloor: 8 },
    { x:  4.4, fromFloor: 8, toFloor: 9 },
    // 5F→6F ゴールはしご（5Fを左へ進んでジャッキを潜り抜けて登る）
    { x:  0.9, fromFloor: 9, toFloor: 10 }
  ],
  furnaces: [],
  elevators: [
    // 左上昇リフト系統
    { id: 'elev_left',  x: -1.75, width: 1.35, yMin: -0.4, yMax: 10.3, dir:  1, speed: 1.70, platformCount: 3, color: 0x38bdf8 },
    // 右下降リフト系統
    { id: 'elev_right', x:  1.75, width: 1.35, yMin: -0.4, yMax: 10.3, dir: -1, speed: 1.70, platformCount: 3, color: 0xf472b6 }
  ],
  rivets: [],
  conveyorCans: [],
  jackSpawner: Object.freeze({
    floorIdx: 9,
    startX: -2.9,
    speed: 3.15,
    bounceVy: 6.4,
    dropEdgeX: 4.85
  }),
  fireballConfig: {
    initialCount: 2,
    spawnFromFurnace: false,
    spawnPositions: [
      { floorIdx: 6, x: 3.8 },
      { floorIdx: 3, x: 0.0 }
    ]
  },
  playerSpawn: { floorIdx: 0, x: -4.15, facing: 1 },
  boss: {
    floorIdx: 9,
    x: -3.75,
    mode: 'jack_thrower',
    patrolMin: -3.75,
    patrolMax: -3.75,
    speed: 0,
    hurtMinX: -2.85
  },
  barrelStack: [],
  heroine: { floorIdx: 10, x: 3.2, goalRadius: 1.05, clearPlayerX: 2.15, clearFriendX: 3.25 },
  enemies: [
    { floorIdx: 1, x: -3.6, type: 'walker', speed: 1.20, dir: -1 },
    { floorIdx: 7, x:  4.0, type: 'spiky',  speed: 1.15, dir: -1 }
  ],
  crates: [
    { floorIdx: 3, x: 0.0, hasBattery: true  },
    { floorIdx: 6, x: 4.2, hasBattery: false },
    { floorIdx: 9, x: 2.5, hasBattery: true  }
  ],
  coins: [
    { floorIdx: 1, x: -4.6 },
    { floorIdx: 2, x:  0.0 },
    { floorIdx: 4, x:  0.0 },
    { floorIdx: 5, x:  3.8 },
    { floorIdx: 8, x:  3.4 },
    { floorIdx: 9, x: -0.4 }
  ]
});

/**
 * Stage 4 (index 3): 100m — RIVET TOWER
 * オリジナル完全準拠・5層ピラミッド＆8本杭抜き＋6F最頂部（全抜きでボス大墜落）
 */
const STAGE_100M = finalizeStageDef({
  index: 3,
  code: '100m',
  title: '100m RIVET TOWER',
  themeBg: 0x1c120b,
  clearCondition: 'all_rivets',
  hasAbyss: false,
  hasBarrelStack: false,
  pillarColor: 0x57361c,
  floors: [
    // 1F: スタート層（幅 10.4）
    { id: 0, label: 'floor_1f', xMin: -STAGE_WIDTH_HALF, xMax: STAGE_WIDTH_HALF, yLeft: 0.00, yRight: 0.00, color: 0xd97706, hasSteps: false },
    // 2F: ピラミッド2層（杭 2本）
    {
      id: 1, label: 'floor_2f_rivet', xMin: -4.8, xMax: 4.8, yLeft: 2.95, yRight: 2.95, color: 0xf59e0b, hasSteps: false,
      collapsibleCenter: Object.freeze({ xMin: -1.85, xMax: 1.85 })
    },
    // 3F: ピラミッド3層（杭 2本）
    {
      id: 2, label: 'floor_3f_rivet', xMin: -4.4, xMax: 4.4, yLeft: 5.85, yRight: 5.85, color: 0xd97706, hasSteps: false,
      collapsibleCenter: Object.freeze({ xMin: -1.85, xMax: 1.85 })
    },
    // 4F: ピラミッド4層（杭 2本）
    {
      id: 3, label: 'floor_4f_rivet', xMin: -4.0, xMax: 4.0, yLeft: 8.75, yRight: 8.75, color: 0xf59e0b, hasSteps: false,
      collapsibleCenter: Object.freeze({ xMin: -1.85, xMax: 1.85 })
    },
    // 5F: ピラミッド5層（杭 2本・中央に巨大ボス）
    {
      id: 4, label: 'floor_5f_rivet', xMin: -3.6, xMax: 3.6, yLeft: 11.65, yRight: 11.65, color: 0xd97706, hasSteps: false,
      collapsibleCenter: Object.freeze({ xMin: -1.85, xMax: 1.85 })
    },
    // 6F: 最頂部バルコニー（ヒロイン）
    { id: 5, label: 'floor_6f_top', xMin: -1.8, xMax: 1.8, yLeft: 14.70, yRight: 14.70, color: 0xfbbf24, hasSteps: false }
  ],
  ladders: [
    // 1F→2F（杭穴 ±[1.875, 2.725] を完全回避）
    { x: -4.2, fromFloor: 0, toFloor: 1 },
    { x: -1.1, fromFloor: 0, toFloor: 1 },
    { x:  1.1, fromFloor: 0, toFloor: 1 },
    { x:  4.2, fromFloor: 0, toFloor: 1 },
    // 2F→3F
    { x: -3.8, fromFloor: 1, toFloor: 2 },
    { x:  0.0, fromFloor: 1, toFloor: 2 },
    { x:  3.8, fromFloor: 1, toFloor: 2 },
    // 3F→4F
    { x: -3.4, fromFloor: 2, toFloor: 3 },
    { x: -1.2, fromFloor: 2, toFloor: 3 },
    { x:  1.2, fromFloor: 2, toFloor: 3 },
    { x:  3.4, fromFloor: 2, toFloor: 3 },
    // 4F→5F（ボス中央を避けて左右から登る）
    { x: -3.1, fromFloor: 3, toFloor: 4 },
    { x:  3.1, fromFloor: 3, toFloor: 4 }
  ],
  furnaces: [],
  elevators: [],
  // 2F〜5F 左右計8本の光るボルト杭（抜いた跡は幅 0.85 の穴）
  rivets: [
    { floorIdx: 1, x: -2.3, holeHalfWidth: 0.425 },
    { floorIdx: 1, x:  2.3, holeHalfWidth: 0.425 },
    { floorIdx: 2, x: -2.3, holeHalfWidth: 0.425 },
    { floorIdx: 2, x:  2.3, holeHalfWidth: 0.425 },
    { floorIdx: 3, x: -2.3, holeHalfWidth: 0.425 },
    { floorIdx: 3, x:  2.3, holeHalfWidth: 0.425 },
    { floorIdx: 4, x: -2.3, holeHalfWidth: 0.425 },
    { floorIdx: 4, x:  2.3, holeHalfWidth: 0.425 }
  ],
  conveyorCans: [],
  jackSpawner: null,
  fireballConfig: {
    initialCount: 2,
    spawnFromFurnace: false,
    spawnPositions: [
      { floorIdx: 1, x:  0.0 },
      { floorIdx: 3, x:  0.0 },
      { floorIdx: 2, x: -3.4 },
      { floorIdx: 2, x:  3.4 }
    ]
  },
  playerSpawn: { floorIdx: 0, x: -4.0, facing: 1 },
  boss: {
    floorIdx: 4,
    x: 0.0,
    mode: 'rivet_boss',
    patrolMin: -0.75,
    patrolMax: 0.75,
    speed: 0.90
  },
  barrelStack: [],
  heroine: { floorIdx: 5, x: 0.0, goalRadius: 1.0, clearPlayerX: -0.60, clearFriendX: 0.55 },
  enemies: [
    { floorIdx: 0, x: 2.2, type: 'walker', speed: 1.50, dir: -1 },
    { floorIdx: 2, x: 0.0, type: 'spiky',  speed: 1.35, dir:  1 }
  ],
  crates: [
    { floorIdx: 1, x: 0.0, hasBattery: true },
    { floorIdx: 3, x: 0.0, hasBattery: true }
  ],
  coins: [
    { floorIdx: 0, x:  0.0 },
    { floorIdx: 1, x: -3.6 },
    { floorIdx: 1, x:  3.6 },
    { floorIdx: 2, x: -1.2 },
    { floorIdx: 2, x:  1.2 },
    { floorIdx: 3, x: -3.1 },
    { floorIdx: 3, x:  3.1 }
  ]
});

/** 全4ステージ定義配列（0:25m, 1:50m, 2:75m, 3:100m） */
export const STAGES = Object.freeze([
  STAGE_25M,
  STAGE_50M,
  STAGE_75M,
  STAGE_100M
]);

/**
 * ステージインデックスからステージ定義を安全に取得
 * @param {number} stageIndex
 * @returns {object}
 */
export function getStageDef(stageIndex) {
  const safe = Number.isFinite(stageIndex) ? Math.floor(stageIndex) : 0;
  const wrapped = ((safe % STAGES.length) + STAGES.length) % STAGES.length;
  return STAGES[wrapped];
}

/* ============================================================================
 * 4. 杭穴・中央崩落・着地判定・動的ギミック数学ヘルパー
 * ========================================================================== */

/**
 * 指定フロア・X座標が「抜かれた杭の穴」の上にあるか判定
 * @param {number} floorIdx
 * @param {number} x
 * @param {Array<{floorIdx:number, x:number, holeHalfWidth:number, pulled:boolean}>|null} rivetsState
 * @returns {boolean}
 */
export function isPointOverPulledRivetHole(floorIdx, x, rivetsState) {
  if (!rivetsState || rivetsState.length === 0) return false;
  const sx = safeFinite(x, 0);
  for (let i = 0; i < rivetsState.length; i++) {
    const r = rivetsState[i];
    if (r.pulled && r.floorIdx === floorIdx) {
      if (Math.abs(sx - r.x) < r.holeHalfWidth) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 指定フロア・X座標が 100m 全杭抜き後の中央崩落エリアに含まれるか判定
 * @param {object} floor
 * @param {number} x
 * @param {boolean} isStageCollapsed
 * @returns {boolean}
 */
export function isPointOnCollapsedCenter(floor, x, isStageCollapsed) {
  if (!isStageCollapsed || !floor || !floor.collapsibleCenter) return false;
  const sx = safeFinite(x, 0);
  return sx > floor.collapsibleCenter.xMin && sx < floor.collapsibleCenter.xMax;
}

/**
 * 指定フロア上の X 座標に固体の足場が存在するか統合判定
 * @param {object} floor
 * @param {number} x
 * @param {Array|null} rivetsState
 * @param {boolean} isStageCollapsed
 * @param {number} edgeMargin
 * @returns {boolean}
 */
export function isSolidFloorAt(floor, x, rivetsState = null, isStageCollapsed = false, edgeMargin = 0.14) {
  if (!floor) return false;
  const sx = safeFinite(x, 0);
  if (sx < floor.xMin - edgeMargin || sx > floor.xMax + edgeMargin) return false;
  if (isPointOverPulledRivetHole(floor.id, sx, rivetsState)) return false;
  if (isPointOnCollapsedCenter(floor, sx, isStageCollapsed)) return false;
  return true;
}

/**
 * 50m 電動伸縮はしごの現在伸長率（0.0=縮み / 1.0=完全接続）を算出
 * 固定はしごは常に 1.0 を返す
 * @param {object} ladder
 * @param {number} simTimeSec
 * @returns {number}
 */
export function getLadderExtensionRatio(ladder, simTimeSec) {
  if (!ladder || !ladder.retractable) return 1.0;
  const period = Math.max(1.0, ladder.period || 6.4);
  const offset = ladder.phaseOffset || 0;
  const t = safeFinite(simTimeSec, 0) + offset;
  const u = (((t % period) + period) % period) / period;

  const ramp = 0.12;
  const holdEnd = clamp(ladder.extendRatio || 0.56, 0.25, 0.75);
  const retractEnd = Math.min(0.95, holdEnd + ramp);

  if (u < ramp) return u / ramp;
  if (u < holdEnd) return 1.0;
  if (u < retractEnd) return 1.0 - (u - holdEnd) / ramp;
  return 0.0;
}

/**
 * はしごの上端が上階に接続されて登り切れる状態か判定
 * @param {object} ladder
 * @param {number} simTimeSec
 * @returns {boolean}
 */
export function isLadderConnectedToTop(ladder, simTimeSec) {
  if (!ladder) return false;
  if (!ladder.retractable) return true;
  return getLadderExtensionRatio(ladder, simTimeSec) >= 0.90;
}

/**
 * はしごの現在の上端 Y 座標を算出（伸縮はしごは下部 35% を残して上下スライド）
 * @param {object} ladder
 * @param {number} simTimeSec
 * @returns {number}
 */
export function getLadderCurrentTopY(ladder, simTimeSec) {
  if (!ladder) return 0;
  if (!ladder.retractable) return ladder.yTop;
  const ratio = getLadderExtensionRatio(ladder, simTimeSec);
  const visualFrac = lerp(0.35, 1.0, ratio);
  return lerp(ladder.yBottom, ladder.yTop, visualFrac);
}

/**
 * 75m 循環エレベーターの指定プラットフォームの現在 Y 座標を算出
 * @param {object} shaft
 * @param {number} platformIndex
 * @param {number} simTimeSec
 * @param {number} speedMul
 * @returns {number}
 */
export function getElevatorPlatformY(shaft, platformIndex, simTimeSec, speedMul = 1.0) {
  if (!shaft) return 0;
  const span = Math.max(0.1, shaft.yMax - shaft.yMin);
  const t = safeFinite(simTimeSec, 0);
  const mul = safeFinite(speedMul, 1.0);
  const rawPhase = ((t * shaft.speed * mul) / span) * shaft.dir + (platformIndex / shaft.platformCount);
  const frac = ((rawPhase % 1) + 1) % 1;
  return shaft.yMin + frac * span;
}

/**
 * 落下ダメージ発生時（1ダメージ＋直前安全床復帰）に、
 * 杭穴・オイル炉・ボス接触を避けた安全な復帰座標を算出
 * @param {object} stageDef
 * @param {number} preferredFloorIdx
 * @param {number} preferredX
 * @param {Array|null} rivetsState
 * @param {{floorIdx:number, x:number, y:number}} outTarget 再利用出力先（GC防止）
 * @returns {{floorIdx:number, x:number, y:number}}
 */
export function findNearestSafeSpawn(stageDef, preferredFloorIdx, preferredX, rivetsState = null, outTarget = null) {
  const out = outTarget || { floorIdx: 0, x: 0, y: 0 };
  if (!stageDef || !stageDef.floors || stageDef.floors.length === 0) {
    out.floorIdx = 0;
    out.x = 0;
    out.y = 0;
    return out;
  }

  const floorIdx = clamp(
    Number.isFinite(preferredFloorIdx) ? Math.floor(preferredFloorIdx) : stageDef.playerSpawn.floorIdx,
    0,
    stageDef.floors.length - 1
  );
  const fl = stageDef.floors[floorIdx];

  const margin = Math.min(0.55, (fl.xMax - fl.xMin) * 0.25);
  let minX = fl.xMin + margin;
  let maxX = fl.xMax - margin;
  if (minX > maxX) {
    const mid = (fl.xMin + fl.xMax) * 0.5;
    minX = mid;
    maxX = mid;
  }

  // 25m/75m のボス待機エリアは除外
  if (stageDef.boss && stageDef.boss.floorIdx === floorIdx && typeof stageDef.boss.hurtMinX === 'number') {
    minX = Math.max(minX, stageDef.boss.hurtMinX + 0.35);
  }

  const targetX = clamp(safeFinite(preferredX, stageDef.playerSpawn.x), minX, maxX);

  const isHazardNear = (candX) => {
    if (isPointOverPulledRivetHole(floorIdx, candX, rivetsState)) return true;
    // 杭穴のすぐ際も少し余裕を取る
    if (rivetsState) {
      for (let i = 0; i < rivetsState.length; i++) {
        const r = rivetsState[i];
        if (r.pulled && r.floorIdx === floorIdx && Math.abs(candX - r.x) < r.holeHalfWidth + 0.32) {
          return true;
        }
      }
    }
    // オイル炉との重複回避
    if (stageDef.furnaces) {
      for (let i = 0; i < stageDef.furnaces.length; i++) {
        const fn = stageDef.furnaces[i];
        if (fn.floorIdx === floorIdx && Math.abs(candX - fn.x) < 0.85) {
          return true;
        }
      }
    }
    return false;
  };

  if (!isHazardNear(targetX)) {
    out.floorIdx = floorIdx;
    out.x = targetX;
    out.y = getFloorY(fl, targetX);
    return out;
  }

  // 近傍を 0.25 刻みで左右探索
  for (let step = 1; step <= 24; step++) {
    const delta = step * 0.25;
    const rightX = targetX + delta;
    if (rightX <= maxX && !isHazardNear(rightX)) {
      out.floorIdx = floorIdx;
      out.x = rightX;
      out.y = getFloorY(fl, rightX);
      return out;
    }
    const leftX = targetX - delta;
    if (leftX >= minX && !isHazardNear(leftX)) {
      out.floorIdx = floorIdx;
      out.x = leftX;
      out.y = getFloorY(fl, leftX);
      return out;
    }
  }

  // どうしても見つからない場合はステージ初期スポーンへ安全フォールバック
  out.floorIdx = stageDef.playerSpawn.floorIdx;
  out.x = stageDef.playerSpawn.x;
  out.y = stageDef.playerSpawn.y;
  return out;
}