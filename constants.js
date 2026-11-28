/**
 * constants.js
 * @version v1.0 (Initial Gravity Single-Play Build - Phase 1)
 * @changes
 *   - 公開URL (https://norion3.github.io/donki/) および統一キャッシュバージョン定数を定義
 *   - 高層4ステージ構成（幅10.4 / 高さ14.85 / カメラ黄金比 / 落下ダメージ閾値2.30）の物理・ゲーム定数を定義
 *   - A案ハイパー電池仕様・1〜5周目の難易度スケーリングテーブル・スコア定数を定義
 *   - マスター設計書v5.0.0準拠の PlatformDetector / SafeStorage / escapeHTML / formatScore / 数値防護ユーティリティを実装
 *
 * Tier 1 基盤モジュール：アプリケーション全体で共有する不変定数・環境判定・安全ユーティリティ
 */

/* ============================================================================
 * 1. 配信・キャッシュ統一・デバッグ遮断定数
 * ========================================================================== */

/** ESModule の ?v= クエリ統一バージョン（全モジュールで必ず同一値を使用） */
export const MODULE_VERSION = '1';

/** GitHub Pages 公開ベースURL（完全絶対URL・末尾スラッシュ必須） */
export const ASSET_BASE_URL = 'https://norion3.github.io/donki/';

/** 3Dロボットモデル GLTF URL（バージョン固定CDN） */
export const ROBOT_GLTF_URL =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/RobotExpressive/RobotExpressive.glb';

/** デバッグ機能の3層遮断フラグ（本番リリース時は必ず false） */
export const ENABLE_DEBUG_TOOLS = false;

/** 自己ベスト保存用ストレージキー */
export const STORAGE_KEY_BEST_SCORE = 'robot_tower_dk_gravity_best_v1';

/* ============================================================================
 * 2. タワー寸法・カメラ・描画設定（iPhone縦画面 黄金比最適化）
 * ========================================================================== */

/** ステージ水平半幅（X: -5.2 〜 +5.2、全幅 10.4 ユニット） */
export const STAGE_WIDTH_HALF = 5.2;

/** 最上階バルコニー基準高さ */
export const STAGE_TOP_Y = 14.85;

/** カメラフレーミング目標横幅（左右支柱含む） */
export const CAMERA_DESIRED_WIDTH = 11.6;

/** カメラフレーミング目標縦幅（土台〜最上階ヒロイン頭上） */
export const CAMERA_DESIRED_HEIGHT = 16.8;

/** タワー中央基準Y座標 */
export const CAMERA_TOWER_CENTER_Y = 7.45;

/** 透視カメラ垂直視野角（度） */
export const CAMERA_FOV = 44;

/** Retina DPR 上限（3D WebGL 最大 2x 制限） */
export const MAX_DPR = 2;

/* ============================================================================
 * 3. ゲームループ・60Hz 固定タイムステップ定数
 * ========================================================================== */

export const FIXED_FPS = 60;
export const FIXED_FRAME_MS = 1000 / FIXED_FPS;
export const FIXED_DT = 1 / FIXED_FPS;

/** 復帰時・スパイク時のフレームデルタ上限（33.33ms = 2フレーム分） */
export const MAX_FRAME_DELTA_MS = FIXED_FRAME_MS * 2;

/** 1固定フレームあたりの物理サブステップ数 */
export const PHYSICS_SUBSTEPS = 2;

/* ============================================================================
 * 4. プレイヤー物理・アクション・落下ダメージ定数（A案準拠）
 * ========================================================================== */

export const PLAYER_MAX_HP = 3;
export const PLAYER_MAX_SPEED = 4.7;
export const PLAYER_POWER_SPEED = 5.6;
export const PLAYER_LADDER_SPEED = 3.9;

/** ジャンプ初速（最高点 = 8.9^2 / (2 * 21.5) ≈ 1.84 < 落下閾値 2.30 < 最小層間 2.45） */
export const PLAYER_JUMP_VY = 8.9;
export const PLAYER_LADDER_JUMP_VY = 7.8;
export const PLAYER_STOMP_VY = 9.2;

export const PLAYER_GRAVITY_NORMAL = 21.5;
export const PLAYER_GRAVITY_SHORT_HOP = 34.0;
export const PLAYER_MAX_FALL_VY = -14.0;

/** 1ダメージ＋直前安全床復帰となる高所落下距離閾値 */
export const PLAYER_FALL_DAMAGE_THRESHOLD = 2.30;

/** 75m等の奈落落下判定Y座標 */
export const ABYSS_Y = -1.0;

/** コヨーテタイム・先行ジャンプ・パンチ・無敵・パワー時間（秒） */
export const PLAYER_COYOTE_TIME = 0.12;
export const PLAYER_JUMP_BUFFER_TIME = 0.13;
export const PLAYER_PUNCH_DURATION = 0.24;
export const PLAYER_PUNCH_COOLDOWN = 0.34;
export const PLAYER_INVULN_DURATION = 1.6;
export const POWER_UP_DURATION = 10.0;

/** A案：ハイパー電池中もジャンプ・はしご昇降を許可 */
export const POWER_UP_ALLOW_JUMP_AND_LADDER = true;

/* ============================================================================
 * 5. 余韻（Afterglow）・ステージ遷移・タイマー演出定数
 * ========================================================================== */

/** ゲームオーバー確定後、ダウン演出を見せてリザルトを出すまでの余韻時間（ms） */
export const AFTERGLOW_GAMEOVER_MS = 2200;

/** 通常ステージクリア後のダンス演出時間（ms） */
export const AFTERGLOW_CLEAR_MS = 1900;

/** 100m 杭8本抜き後のボス大墜落〜周回クリア演出時間（ms） */
export const AFTERGLOW_RIVET_COLLAPSE_MS = 2500;

/* ============================================================================
 * 6. スコア ＆ ボーナス制限時間定数
 * ========================================================================== */

export const SCORE_VALUES = Object.freeze({
  JUMP_WOOD_BARREL: 100,
  JUMP_IRON_BARREL: 150,
  JUMP_CAN: 100,
  JUMP_JACK: 150,
  JUMP_FIREBALL: 100,
  SMASH_WOOD_BARREL: 200,
  SMASH_IRON_BARREL: 500,
  SMASH_CAN: 200,
  SMASH_JACK: 400,
  SMASH_FIREBALL: 300,
  KO_WALKER: 250,
  KO_SPIKY: 350,
  STOMP_WALKER: 300,
  POWER_RAM_BARREL: 300,
  POWER_RAM_ENEMY: 350,
  CRATE_BREAK: 100,
  COIN: 200,
  BATTERY: 300,
  RIVET_PULL: 250,
  STAGE_CLEAR_BASE: 500,
  LOOP_CLEAR_BONUS: 1500
});

/** ボーナス制限時間（100ポイント単位で1.8秒ごとに減少、0でタイムアウトダメージ/ミス） */
export const BONUS_TIMER_STEP = 100;
export const BONUS_TIMER_INTERVAL_SEC = 1.8;

/* ============================================================================
 * 7. ステージメタ情報 ＆ 周回難易度スケーリング（1〜5周目）
 * ========================================================================== */

export const STAGE_META = Object.freeze([
  Object.freeze({
    index: 0,
    code: '25m',
    name: '25m IRON GIRDERS',
    shortDesc: '6層の鉄骨と転がるタルを突破せよ！',
    baseBonus: 5000
  }),
  Object.freeze({
    index: 1,
    code: '50m',
    name: '50m CONVEYOR FACTORY',
    shortDesc: '反転コンベアと伸縮はしごを攻略せよ！',
    baseBonus: 6000
  }),
  Object.freeze({
    index: 2,
    code: '75m',
    name: '75m ELEVATOR SHAFT',
    shortDesc: '2系統リフトを乗り継ぎジャッキを回避せよ！',
    baseBonus: 6000
  }),
  Object.freeze({
    index: 3,
    code: '100m',
    name: '100m RIVET TOWER',
    shortDesc: '8本の光る杭をすべて抜きボスを落とせ！',
    baseBonus: 7000
  })
]);

/**
 * 周回別難易度テーブル（5周目で最高難易度に到達し以降は維持）
 */
export const LOOP_DIFFICULTY = Object.freeze([
  Object.freeze({
    loop: 1,
    barrelIntervalBase: 2.85,
    barrelIntervalMin: 1.95,
    barrelSpeedMul: 1.00,
    ironRatio: 0.22,
    fireballMax: 2,
    fireballSpeedMul: 1.00,
    conveyorSpeedMul: 1.00,
    jackInterval: 2.35,
    jackSpeedMul: 1.00,
    bonusCap: 5000
  }),
  Object.freeze({
    loop: 2,
    barrelIntervalBase: 2.45,
    barrelIntervalMin: 1.65,
    barrelSpeedMul: 1.12,
    ironRatio: 0.30,
    fireballMax: 3,
    fireballSpeedMul: 1.12,
    conveyorSpeedMul: 1.15,
    jackInterval: 2.00,
    jackSpeedMul: 1.12,
    bonusCap: 6000
  }),
  Object.freeze({
    loop: 3,
    barrelIntervalBase: 2.15,
    barrelIntervalMin: 1.45,
    barrelSpeedMul: 1.24,
    ironRatio: 0.36,
    fireballMax: 4,
    fireballSpeedMul: 1.24,
    conveyorSpeedMul: 1.28,
    jackInterval: 1.72,
    jackSpeedMul: 1.24,
    bonusCap: 7000
  }),
  Object.freeze({
    loop: 4,
    barrelIntervalBase: 1.90,
    barrelIntervalMin: 1.28,
    barrelSpeedMul: 1.35,
    ironRatio: 0.42,
    fireballMax: 4,
    fireballSpeedMul: 1.34,
    conveyorSpeedMul: 1.38,
    jackInterval: 1.50,
    jackSpeedMul: 1.35,
    bonusCap: 8000
  }),
  Object.freeze({
    loop: 5,
    barrelIntervalBase: 1.68,
    barrelIntervalMin: 1.12,
    barrelSpeedMul: 1.46,
    ironRatio: 0.48,
    fireballMax: 5,
    fireballSpeedMul: 1.45,
    conveyorSpeedMul: 1.48,
    jackInterval: 1.30,
    jackSpeedMul: 1.46,
    bonusCap: 8000
  })
]);

/**
 * 周回数に応じた難易度設定を取得（1始まり、5周目以降は5周目設定を維持）
 * @param {number} loopNum
 * @returns {Readonly<typeof LOOP_DIFFICULTY[0]>}
 */
export function getLoopDifficulty(loopNum) {
  const safeLoop = Number.isFinite(loopNum) ? Math.max(1, Math.floor(loopNum)) : 1;
  const idx = Math.min(safeLoop - 1, LOOP_DIFFICULTY.length - 1);
  return LOOP_DIFFICULTY[idx];
}

/**
 * ステージ番号と周回数から初期ボーナスタイマー値を算出
 * @param {number} stageIndex
 * @param {number} loopNum
 * @returns {number}
 */
export function getStageInitialBonus(stageIndex, loopNum) {
  const meta = STAGE_META[stageIndex] || STAGE_META[0];
  const diff = getLoopDifficulty(loopNum);
  const scaled = meta.baseBonus + Math.min(3, Math.max(0, loopNum - 1)) * 1000;
  return Math.min(scaled, Math.max(meta.baseBonus, diff.bonusCap));
}

/* ============================================================================
 * 8. 環境判定（isInAppWebView vs hasAgentSDK の厳格分離：第2章 2.1準拠）
 * ========================================================================== */

export const PlatformDetector = (() => {
  const hasWindow = typeof window !== 'undefined';
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
  const hasAgentSDK = hasWindow && typeof window.AgentSDK !== 'undefined';
  const isGravityUA = /gravity/i.test(ua);
  const isIOS = /(iPhone|iPad|iPod)/i.test(ua);
  const isIOSWebView = isIOS && !/Safari\//i.test(ua);
  const isInAppWebView = hasAgentSDK || isGravityUA || isIOSWebView;
  return Object.freeze({ hasAgentSDK, isInAppWebView, isIOS });
})();

/* ============================================================================
 * 9. SafeStorage（iOS WebView localStorage 例外防護：第3章 3.3準拠）
 * ========================================================================== */

export const SafeStorage = {
  _mem: new Map(),

  /**
   * 値を安全に取得
   * @param {string} key
   * @param {string|null} fallback
   * @returns {string|null}
   */
  get(key, fallback = null) {
    try {
      const v = window.localStorage.getItem(key);
      return v !== null ? v : fallback;
    } catch (_err) {
      return this._mem.has(key) ? this._mem.get(key) : fallback;
    }
  },

  /**
   * 値を安全に保存
   * @param {string} key
   * @param {string|number} val
   */
  set(key, val) {
    const strVal = String(val);
    this._mem.set(key, strVal);
    try {
      window.localStorage.setItem(key, strVal);
    } catch (_err) {
      // プライベートモードや容量制限時はメモリフォールバックのみで継続
    }
  }
};

/* ============================================================================
 * 10. 安全文字列・数値・丸めユーティリティ（第3章・第5章・第7章準拠）
 * ========================================================================== */

/**
 * XSS完全防止用 HTML エスケープ
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * サロゲートペア・絵文字を壊さない安全な文字列切り詰め
 * @param {unknown} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateEmojiSafe(str, maxLen) {
  const chars = Array.from(String(str ?? ''));
  if (chars.length <= maxLen) return chars.join('');
  return chars.slice(0, Math.max(0, maxLen)).join('');
}

/**
 * スコア表示フォーマット（100,000以上は桁溢れ防止の短縮表記に対応）
 * @param {number} score
 * @param {boolean} padZero
 * @returns {string}
 */
export function formatScore(score, padZero = false) {
  const safe = Number.isFinite(score) ? Math.max(0, Math.floor(score)) : 0;
  if (safe >= 1000000) {
    return `${Math.floor(safe / 10000) / 100}M`;
  }
  if (safe >= 100000) {
    return `${Math.floor(safe / 100) / 10}k`;
  }
  if (padZero) {
    return String(safe).padStart(5, '0');
  }
  return safe.toLocaleString('en-US');
}

/**
 * NaN / Infinity を完全に遮断する有限数ガード
 * @param {number} value
 * @param {number} fallback
 * @returns {number}
 */
export function safeFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 数値クランプ（NaN防護付き）
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(val, min, max) {
  if (!Number.isFinite(val)) return min;
  return val < min ? min : (val > max ? max : val);
}

/**
 * 線形補間
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

/** 純粋算術丸め（toFixed 文字列生成によるGC防止） */
export function round1(v) {
  return Math.round(v * 10) / 10;
}

export function round2(v) {
  return Math.round(v * 100) / 100;
}