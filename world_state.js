/**
 * world_state.js
 * @version v1.0 (Shared World State, In-Place Pools & Gravity Score Bridge - Phase 3)
 * @changes
 *   - 共有ゲーム状態（gameState / player / bossCtrl / stageRuntime / inputState / viewportState）を定義
 *   - 共有エンティティ配列（barrels / enemies / crates / pickups / fireballs / cans / jacks / rivets / particles 等）のインプレース管理および O(1) スワップ削除を実装
 *   - 落下ダメージ復帰用の安全床座標記録（recordPlayerSafePoint）および事前確保バッファを実装
 *   - 世代管理（sessionId）付き非同期タイマー一元登録・完全解放（scheduleSessionTimer / clearAllSessionTimers）を実装
 *   - GRAVITY公式スコア送信（submitGravityScore / reportFinalScoreOnce：確定瞬間1回限定・非負整数防護）を実装
 *   - リトライ・ステージ遷移・初期化用の一元パージ関数（purgeWorldState / prepareStageState / initNewRunState）を実装
 *   - Tier 3→Tier 4 の循環参照を防ぐゼロアロケーション・フローティングテキスト通知キューを実装
 *
 * Tier 1 基盤モジュール：全モジュールが共有する単一状態ストア（SSOT）・配列インプレース管理・スコア連携
 */

import {
  STORAGE_KEY_BEST_SCORE,
  PLAYER_MAX_HP,
  SafeStorage,
  getLoopDifficulty,
  getStageInitialBonus,
  safeFinite,
  clamp
} from './constants.js?v=1';

import {
  getStageDef,
  getFloorY,
  findNearestSafeSpawn
} from './stages.js?v=1';

/* ============================================================================
 * 1. 自己ベスト読み書き（SafeStorage 経由・WebView例外防護）
 * ========================================================================== */

/**
 * 保存済みの自己ベストスコアを安全に読み込む
 * @returns {number}
 */
export function loadBestScore() {
  const raw = SafeStorage.get(STORAGE_KEY_BEST_SCORE, '0');
  const parsed = parseInt(raw || '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * 自己ベストスコアを安全に保存
 * @param {number} score
 */
export function saveBestScore(score) {
  const safe = Number.isFinite(score) ? Math.max(0, Math.floor(score)) : 0;
  SafeStorage.set(STORAGE_KEY_BEST_SCORE, safe);
}

/* ============================================================================
 * 2. GRAVITY 公式スコア送信（第2章 2.2 準拠：確定瞬間1回限定・非負整数）
 * ========================================================================== */

/**
 * GRAVITY プラットフォーム親枠へ最終スコアを送信
 * @param {number} score
 */
export function submitGravityScore(score) {
  const numeric = Number(score);
  const safeScore = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'gameOver', score: safeScore }, '*');
    }
  } catch (err) {
    console.warn('[GravityScore] Failed to submit score:', err);
  }
}

/**
 * 1プレイにつき厳格に1回だけ、確定瞬間のスナップショットスコアを送信
 * @returns {boolean} 実際に送信された場合 true
 */
export function reportFinalScoreOnce() {
  if (gameState.hasReportedScore) return false;
  gameState.hasReportedScore = true;
  const snapshot = Number.isFinite(gameState.score) ? Math.max(0, Math.floor(gameState.score)) : 0;
  submitGravityScore(snapshot);
  return true;
}

/* ============================================================================
 * 3. 共有状態オブジェクト（単一参照を維持しプロパティをインプレース更新）
 * ========================================================================== */

/** ゲーム全体進行状態 */
export const gameState = {
  /** 'loading' | 'title' | 'playing' | 'stage_clear' | 'rivet_collapse' | 'gameover' */
  phase: 'loading',
  /** 初回起動・タイトル待機中の進行停止ガード（第3章 3.4 準拠） */
  isWaitingStart: true,
  /** リザルト完全静止後の省電力スキップフラグ（第5章 5.2 準拠） */
  isResultSettled: false,
  resultSettleTimer: 0,
  /** WebGL コンテキストロスト中フラグ（第4章 4.1 準拠） */
  isContextLost: false,
  /** セッション世代ID（リトライ・ステージ切替ごとにインクリメントして旧タイマーを無効化） */
  sessionId: 0,

  /** スコア・ライフ・ステージ進行 */
  score: 0,
  bestScore: loadBestScore(),
  hp: PLAYER_MAX_HP,
  maxHp: PLAYER_MAX_HP,
  stageIndex: 0,
  loop: 1,

  /** ボーナス制限時間（アーケード準拠） */
  bonusTimer: 5000,
  bonusTickAccum: 0,

  /** 仮想時計（固定物理ステップの実進捗分のみ加算・BG復帰時破壊防止） */
  simTimeSec: 0,
  elapsedStageSec: 0,

  /** 各種演出・パワータイマー */
  powerTimer: 0,
  hitstopTimer: 0,
  shakeTimer: 0,

  /** GRAVITY公式スコア送信済みガード */
  hasReportedScore: false,

  /** HUD ダーティフラグ（変化フレームのみDOM更新するための合図） */
  hudDirty: true
};

/** プレイヤー状態（物理・アクション・落下安全復帰） */
export const player = {
  x: -3.45,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  facing: 1,
  grounded: true,
  currentFloorIdx: 0,
  onLadder: null,
  onElevator: null,
  isCrouching: false,

  /** 操作補助・アクションタイマー */
  coyoteTimer: 0,
  jumpBufferTimer: 0,
  punchTimer: 0,
  punchCooldown: 0,
  invulnTimer: 0,

  /** 高所落下ダメージ判定および直前安全床復帰用座標 */
  fallStartY: 0,
  wasFalling: false,
  lastSafeFloorIdx: 0,
  lastSafeX: -3.45,
  lastSafeY: 0,

  /** ゲームオーバーダウン演出用 */
  deathTargetX: -3.45,
  deathZ: 0,
  deathDelay: 0,
  deathAnimStarted: false
};

/** 巨大ボス状態（全4ステージ共通制御） */
export const bossCtrl = {
  /** 'barrel_thrower' | 'patrol_boss' | 'jack_thrower' | 'rivet_boss' */
  mode: 'barrel_thrower',
  x: -3.55,
  y: 12.6,
  z: 0,
  vy: 0,
  dir: 1,
  rotY: Math.PI * 0.42,

  /** 'idle' | 'grab' | 'lift' | 'throw' | 'patrol' | 'falling' | 'defeated' */
  phase: 'idle',
  timer: 0,
  spawnTimer: 1.1,
  nextIsIron: false,
  heldMesh: null,
  released: false,

  /** 100m 崩落演出用 */
  collapseDelay: 0,
  collapseLanded: false
};

/** 現在のステージ動的ギミック状態 */
export const stageRuntime = {
  stageIndex: 0,
  loop: 1,
  stageDef: getStageDef(0),
  /** 100m 杭8本抜きによる中央床崩落フラグ */
  isCollapsed: false,
  pulledRivetCount: 0,
  totalRivetCount: 0,

  /** 50m コンベア状態（インプレース配列） */
  conveyorStates: [],
  /** 50m エネルギー缶スポーンタイマー（インプレース配列） */
  canSpawnTimers: [],
  /** 50m 伸縮はしご実行状態（インプレース配列） */
  retractableLadders: [],
  /** 75m エレベータープラットフォーム実行状態（インプレース配列） */
  elevatorPlatforms: [],
  /** 75m ジャッキスポーンタイマー */
  jackSpawnTimer: 1.4,
  /** 火の玉ボット補充タイマー */
  fireballSpawnTimer: 4.0
};

/** 入力共有スナップショット（Tier 4 input.js が書き込み、Tier 3 player_ctrl.js が読む） */
export const inputState = {
  moveX: 0,
  moveY: 0,
  jumpHeld: false,
  jumpPressed: false,
  punchPressed: false
};

/** 画面・セーフエリア寸法共有スナップショット（Tier 4 dom_ui.js が更新、Tier 2 camera.js 等が読む） */
export const viewportState = {
  w: 390,
  h: 844,
  dpr: 2,
  topHudH: 30,
  bottomDeckH: 136,
  safeTopPx: 52,
  safeBottomPx: 28
};

/* ============================================================================
 * 4. 共有エンティティ配列（配列インプレース更新原則：絶対に再代入しない）
 * ========================================================================== */

export const entities = Object.freeze({
  barrels: [],
  enemies: [],
  crates: [],
  pickups: [],
  fireballs: [],
  cans: [],
  jacks: [],
  rivets: [],
  particles: []
});

/** 事前確保ワークバッファ（毎フレームのオブジェクト生成をゼロ化） */
export const workBuffers = Object.freeze({
  safeSpawn: { floorIdx: 0, x: 0, y: 0 },
  punchBox: { active: false, x: 0, y: 0, rx: 0, ry: 0 }
});

/**
 * Tier 3 → Tier 4 フローティングテキスト通知用 事前確保キュー（ゼロアロケーション）
 * Tier 3 が pushFloatTextEvent() で予約し、Tier 4 の main.js / dom_ui.js が毎フレーム消費する
 */
const MAX_PENDING_FLOAT_TEXTS = 24;
export const pendingFloatTextQueue = {
  count: 0,
  items: Array.from({ length: MAX_PENDING_FLOAT_TEXTS }, () => ({
    wx: 0,
    wy: 0,
    text: '',
    tone: 'amber'
  }))
};

/**
 * フローティングテキスト表示リクエストをゼロアロケーションで予約
 * @param {number} wx ワールドX座標
 * @param {number} wy ワールドY座標
 * @param {string} text 表示テキスト
 * @param {'amber'|'sky'|'yellow'|'rose'|'emerald'|'pink'|'purple'} tone 色トーン識別子
 */
export function enqueueFloatText(wx, wy, text, tone = 'amber') {
  if (pendingFloatTextQueue.count >= MAX_PENDING_FLOAT_TEXTS) return;
  const slot = pendingFloatTextQueue.items[pendingFloatTextQueue.count];
  slot.wx = safeFinite(wx, 0);
  slot.wy = safeFinite(wy, 0);
  slot.text = String(text ?? '');
  slot.tone = tone;
  pendingFloatTextQueue.count++;
}

/**
 * フローティングテキスト予約キューを消費完了リセット
 */
export function clearFloatTextQueue() {
  for (let i = 0; i < pendingFloatTextQueue.count; i++) {
    pendingFloatTextQueue.items[i].text = '';
  }
  pendingFloatTextQueue.count = 0;
}

/* ============================================================================
 * 5. インプレース配列操作 ＆ O(1) スワップ削除ユーティリティ
 * ========================================================================== */

/**
 * 配列要素内の強参照（mesh / ladder / ref 等）を切ってからインプレースで空にする
 * @param {Array<object>} arr
 */
export function clearArrayInPlace(arr) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (item && typeof item === 'object') {
      if ('mesh' in item) item.mesh = null;
      if ('ladder' in item) item.ladder = null;
      if ('shaft' in item) item.shaft = null;
      if ('ref' in item) item.ref = null;
    }
  }
  arr.length = 0;
}

/**
 * 順序不要なエンティティ配列からの O(1) スワップ POP 削除（GCゼロ）
 * @param {Array<object>} arr
 * @param {number} index
 */
export function swapRemoveAt(arr, index) {
  const lastIdx = arr.length - 1;
  if (index < 0 || index > lastIdx) return;
  const removed = arr[index];
  if (removed && typeof removed === 'object') {
    if ('mesh' in removed) removed.mesh = null;
    if ('ladder' in removed) removed.ladder = null;
    if ('ref' in removed) removed.ref = null;
  }
  if (index !== lastIdx) {
    arr[index] = arr[lastIdx];
  }
  arr.pop();
}

/* ============================================================================
 * 6. 非同期タイマー完全解放 ＆ 世代管理（第3章 3.3 準拠）
 * ========================================================================== */

const activeTimers = new Set();

/**
 * 現在のセッション世代に紐づいた setTimeout を登録
 * リトライやステージ切替で sessionId が進んだ場合、コールバックは自動無効化される
 * @param {() => void} callback
 * @param {number} delayMs
 * @returns {number}
 */
export function scheduleSessionTimer(callback, delayMs) {
  const capturedSession = gameState.sessionId;
  const safeDelay = Math.max(0, safeFinite(delayMs, 0));
  const id = window.setTimeout(() => {
    activeTimers.delete(id);
    if (gameState.sessionId !== capturedSession) return;
    if (typeof callback === 'function') {
      callback();
    }
  }, safeDelay);
  activeTimers.add(id);
  return id;
}

/**
 * 登録済みの全セッションタイマーを即時解除
 */
export function clearAllSessionTimers() {
  activeTimers.forEach((id) => {
    window.clearTimeout(id);
  });
  activeTimers.clear();
}

/* ============================================================================
 * 7. 入力フィールドリセット ＆ スコア加算 ＆ 安全床記録ヘルパー
 * ========================================================================== */

/**
 * 共有入力フィールドを完全初期化（input.js の resetInputState からも呼び出す）
 */
export function resetInputFields() {
  inputState.moveX = 0;
  inputState.moveY = 0;
  inputState.jumpHeld = false;
  inputState.jumpPressed = false;
  inputState.punchPressed = false;
}

/**
 * スコア加算（NaN防護・A案ハイパー電池中スコア2倍対応・自己ベスト即時保存）
 * @param {number} basePoints 基本獲得点
 * @param {number|undefined} wx フローティングテキスト用ワールドX
 * @param {number|undefined} wy フローティングテキスト用ワールドY
 * @param {string|undefined} label カスタム表示ラベル
 * @param {'amber'|'sky'|'yellow'|'rose'|'emerald'|'pink'|'purple'} tone 色トーン
 * @param {boolean} allowPowerDouble ハイパー電池中の2倍対象か
 * @returns {number} 実際に加算されたスコア
 */
export function addScore(basePoints, wx, wy, label, tone = 'amber', allowPowerDouble = true) {
  const safeBase = Number.isFinite(basePoints) ? Math.max(0, Math.floor(basePoints)) : 0;
  if (safeBase <= 0) return 0;

  const isPowerDouble = allowPowerDouble && gameState.powerTimer > 0;
  const pts = isPowerDouble ? safeBase * 2 : safeBase;

  gameState.score += pts;
  if (gameState.score > gameState.bestScore) {
    gameState.bestScore = gameState.score;
    saveBestScore(gameState.bestScore);
  }
  gameState.hudDirty = true;

  if (Number.isFinite(wx) && Number.isFinite(wy)) {
    const finalText = label
      ? (isPowerDouble ? `${label} x2` : label)
      : `+${pts}`;
    enqueueFloatText(wx, wy, finalText, isPowerDouble ? 'yellow' : tone);
  }
  return pts;
}

/**
 * プレイヤーが安全な固体床に接地している座標を記録（落下ダメージ復帰用）
 * @param {number} floorIdx
 * @param {number} x
 * @param {number} y
 */
export function recordPlayerSafePoint(floorIdx, x, y) {
  if (!Number.isFinite(floorIdx) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  player.lastSafeFloorIdx = Math.floor(floorIdx);
  player.lastSafeX = x;
  player.lastSafeY = y;
}

/**
 * 落下ダメージ発生時に、直前の安全床から最も近い安全な復帰座標を workBuffers.safeSpawn へ算出
 * @returns {{floorIdx:number, x:number, y:number}}
 */
export function resolvePlayerRecoveryPoint() {
  const def = stageRuntime.stageDef || getStageDef(gameState.stageIndex);
  return findNearestSafeSpawn(
    def,
    player.lastSafeFloorIdx,
    player.lastSafeX,
    entities.rivets,
    workBuffers.safeSpawn
  );
}

/* ============================================================================
 * 8. 一元パージ ＆ ステージ／ラン初期化関数（第3章 3.3 準拠）
 * ========================================================================== */

/**
 * 全エンティティ配列・動的ギミック配列・タイマー・キューを一元パージ（参照乖離ゼロ）
 * ※3Dシーンからのメッシュ除去は呼び出し元（world.js の clearStageEntities）と連携して行う
 */
export function purgeWorldState() {
  gameState.sessionId += 1;
  clearAllSessionTimers();
  resetInputFields();
  clearFloatTextQueue();

  clearArrayInPlace(entities.barrels);
  clearArrayInPlace(entities.enemies);
  clearArrayInPlace(entities.crates);
  clearArrayInPlace(entities.pickups);
  clearArrayInPlace(entities.fireballs);
  clearArrayInPlace(entities.cans);
  clearArrayInPlace(entities.jacks);
  clearArrayInPlace(entities.rivets);
  clearArrayInPlace(entities.particles);

  clearArrayInPlace(stageRuntime.conveyorStates);
  clearArrayInPlace(stageRuntime.canSpawnTimers);
  clearArrayInPlace(stageRuntime.retractableLadders);
  clearArrayInPlace(stageRuntime.elevatorPlatforms);

  bossCtrl.heldMesh = null;
  player.onLadder = null;
  player.onElevator = null;
  workBuffers.punchBox.active = false;
}

/**
 * 指定ステージ・周回の動的状態（プレイヤー初期位置・ボス・ギミック・ボーナス時間）を初期化
 * @param {number} stageIndex 0..3
 * @param {number} loopNum 1..N
 * @param {'title'|'playing'} targetPhase
 */
export function prepareStageState(stageIndex, loopNum, targetPhase = 'playing') {
  purgeWorldState();

  const safeStageIdx = ((Math.floor(safeFinite(stageIndex, 0)) % 4) + 4) % 4;
  const safeLoop = Math.max(1, Math.floor(safeFinite(loopNum, 1)));
  const def = getStageDef(safeStageIdx);
  const diff = getLoopDifficulty(safeLoop);

  gameState.stageIndex = safeStageIdx;
  gameState.loop = safeLoop;
  gameState.phase = targetPhase;
  gameState.isWaitingStart = (targetPhase !== 'playing');
  gameState.isResultSettled = false;
  gameState.resultSettleTimer = 0;

  gameState.bonusTimer = getStageInitialBonus(safeStageIdx, safeLoop);
  gameState.bonusTickAccum = 0;
  gameState.elapsedStageSec = 0;
  gameState.powerTimer = 0;
  gameState.hitstopTimer = 0;
  gameState.shakeTimer = 0;
  gameState.hudDirty = true;

  // ステージランタイム更新
  stageRuntime.stageIndex = safeStageIdx;
  stageRuntime.loop = safeLoop;
  stageRuntime.stageDef = def;
  stageRuntime.isCollapsed = false;
  stageRuntime.pulledRivetCount = 0;
  stageRuntime.totalRivetCount = def.rivets.length;
  stageRuntime.jackSpawnTimer = Math.max(0.8, diff.jackInterval * 0.65);
  stageRuntime.fireballSpawnTimer = 3.5;

  // 50m 反転コンベア初期状態構築（インプレース push）
  for (let i = 0; i < def.floors.length; i++) {
    const fl = def.floors[i];
    if (fl.conveyor) {
      stageRuntime.conveyorStates.push({
        floorIdx: fl.id,
        dir: fl.conveyor.initialDir,
        baseSpeed: fl.conveyor.baseSpeed,
        speed: fl.conveyor.baseSpeed * diff.conveyorSpeedMul,
        timer: fl.conveyor.reverseInterval,
        reverseInterval: fl.conveyor.reverseInterval,
        warnSec: fl.conveyor.warnSec,
        isWarning: false
      });
    }
  }

  // 50m エネルギー缶スポーンタイマー構築
  for (let i = 0; i < def.conveyorCans.length; i++) {
    const cfg = def.conveyorCans[i];
    stageRuntime.canSpawnTimers.push({
      floorIdx: cfg.floorIdx,
      timer: 1.2 + i * 1.1,
      interval: Math.max(1.8, cfg.interval / diff.conveyorSpeedMul),
      speed: cfg.speed * diff.conveyorSpeedMul
    });
  }

  // プレイヤー初期化
  const sp = def.playerSpawn;
  const spawnFl = def.floors[sp.floorIdx] || def.floors[0];
  const spawnY = getFloorY(spawnFl, sp.x);

  player.x = sp.x;
  player.y = spawnY;
  player.z = 0;
  player.vx = 0;
  player.vy = 0;
  player.facing = sp.facing || 1;
  player.grounded = true;
  player.currentFloorIdx = sp.floorIdx;
  player.onLadder = null;
  player.onElevator = null;
  player.isCrouching = false;
  player.coyoteTimer = 0;
  player.jumpBufferTimer = 0;
  player.punchTimer = 0;
  player.punchCooldown = 0;
  player.invulnTimer = 0;
  player.fallStartY = spawnY;
  player.wasFalling = false;
  player.lastSafeFloorIdx = sp.floorIdx;
  player.lastSafeX = sp.x;
  player.lastSafeY = spawnY;
  player.deathTargetX = sp.x;
  player.deathZ = 0;
  player.deathDelay = 0;
  player.deathAnimStarted = false;

  // ボス初期化
  const bDef = def.boss;
  bossCtrl.mode = bDef.mode;
  bossCtrl.x = bDef.x;
  bossCtrl.y = bDef.y;
  bossCtrl.z = 0;
  bossCtrl.vy = 0;
  bossCtrl.dir = 1;
  bossCtrl.rotY = bDef.mode === 'barrel_thrower' || bDef.mode === 'jack_thrower'
    ? Math.PI * 0.42
    : 0;
  bossCtrl.phase = bDef.mode === 'patrol_boss' || bDef.mode === 'rivet_boss' ? 'patrol' : 'idle';
  bossCtrl.timer = 0;
  bossCtrl.spawnTimer = 0.95;
  bossCtrl.nextIsIron = false;
  bossCtrl.heldMesh = null;
  bossCtrl.released = false;
  bossCtrl.collapseDelay = 0;
  bossCtrl.collapseLanded = false;
}

/**
 * 新規ゲームラン（1周目 25m・スコア0・HP満タン）を完全初期化
 * @param {boolean} startPlaying true で即時プレイ開始、false でタイトル待機状態
 */
export function initNewRunState(startPlaying = true) {
  gameState.score = 0;
  gameState.hp = PLAYER_MAX_HP;
  gameState.maxHp = PLAYER_MAX_HP;
  gameState.hasReportedScore = false;
  gameState.simTimeSec = 0;
  prepareStageState(0, 1, startPlaying ? 'playing' : 'title');
}

/**
 * 1周クリア時（100m 突破後）の HP 回復ヘルパー（上限 maxHp）
 */
export function healPlayerOnLoopClear() {
  gameState.hp = clamp(gameState.hp + 1, 1, gameState.maxHp);
  gameState.hudDirty = true;
}