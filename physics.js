/**
 * physics.js
 * @version v1.0 (60Hz Fixed Timestep Accumulator, Virtual Clock & Physics Guards - Phase 8)
 * @changes
 *   - 60Hz 基準の固定タイムステップ＆サブステップ・アキュムレータ stepFixedPhysics() を実装（30Hz / 60Hz / 120Hz ProMotion 環境での完全同一挙動＆スパイラル・オブ・デス防止）
 *   - 固定物理の実進捗分のみ加算されるゲーム内仮想時計 simTimeSec 更新機構を実装（iPhone バックグラウンド復帰時のタイマー破壊を完全防止）
 *   - 60Hz 基準減衰係数のサブステップ等価変換・指数減衰・指数補間・最短角度補間ユーティリティを実装
 *   - 判定タイマーの高速減衰（1フレーム即0リセット防止）・同座標 NaN 防護（距離<0.001フォールバック）・速度/座標クランプ・ゼロアロケーション 2D AABB 衝突判定を実装
 *
 * Tier 2 機構モジュール：固定刻み物理ループ駆動・仮想時計保護・数値防護＆衝突数学ユーティリティ
 */

import {
  FIXED_FPS,
  FIXED_FRAME_MS,
  MAX_FRAME_DELTA_MS,
  PHYSICS_SUBSTEPS,
  STAGE_WIDTH_HALF,
  clamp,
  safeFinite
} from './constants.js?v=1';

import { gameState } from './world_state.js?v=1';

/* ============================================================================
 * 1. 固定タイムステップ・アキュムレータ内部状態（第4章 4.2 準拠）
 * ========================================================================== */

/** 未消化の経過時間アキュムレータ（ms） */
let physicsAccumulatorMs = 0;

/** 同座標 NaN 防護用の事前確保出力バッファ（ゼロアロケーション） */
const _defaultDirOut = { nx: 1, ny: 0, dist: 1 };

/**
 * 物理アキュムレータを 0 リセット
 * リトライ・ステージ切替・ポーズ復帰・WebGL ロスト復帰時に呼び出してスパイクを防止する
 */
export function resetPhysicsAccumulator() {
  physicsAccumulatorMs = 0;
}

/**
 * 現在のアキュムレータ残量（ms）を取得
 * @returns {number}
 */
export function getPhysicsAccumulatorMs() {
  return physicsAccumulatorMs;
}

/* ============================================================================
 * 2. 60Hz 基準 固定タイムステップ＆サブステップ駆動 ＋ 仮想時計進行（第4章 4.2〜4.3）
 * ========================================================================== */

/**
 * 60Hz 基準の固定タイムステップ・アキュムレータで物理サブステップを実行する
 * - 30Hz / 60Hz / 120Hz ProMotion いずれの端末でも 100% 同一の物理軌道・移動量を保証
 * - iPhone バックグラウンド復帰時の巨大な deltaMs を MAX_FRAME_DELTA_MS (33.33ms) へクランプ
 * - 実実行した物理サブステップ分のみ gameState.simTimeSec（仮想時計）を進めることで壁時計破壊を根絶
 *
 * @param {number} deltaMs 前フレームからの経過時間（ミリ秒）
 * @param {(subDtSec: number, stepIndex: number, subDeltaMs: number) => void} onSubStep サブステップ更新コールバック
 * @param {number} [substeps=PHYSICS_SUBSTEPS] 1固定フレーム(1/60s)あたりのサブステップ分割数
 * @param {boolean} [advanceSimClock=true] gameState.simTimeSec を実物理進捗分だけ進めるか
 * @returns {number} このフレームで実際に実行された物理総時間（秒）
 */
export function stepFixedPhysics(
  deltaMs,
  onSubStep,
  substeps = PHYSICS_SUBSTEPS,
  advanceSimClock = true
) {
  const safeSubsteps = Math.max(1, Math.min(8, Math.floor(safeFinite(substeps, PHYSICS_SUBSTEPS))));
  const fixedSubDeltaMs = FIXED_FRAME_MS / safeSubsteps;
  const fixedSubDtSec = fixedSubDeltaMs * 0.001;

  // 復帰時スパイク・NaN・負の経過時間を完全クランプ
  const rawMs = safeFinite(deltaMs, FIXED_FRAME_MS);
  const clampedMs = clamp(rawMs, 0, MAX_FRAME_DELTA_MS);
  physicsAccumulatorMs = Math.min(physicsAccumulatorMs + clampedMs, MAX_FRAME_DELTA_MS);

  // スパイラル・オブ・デス防止の最大サブステップ回数キャップ
  const maxSteps = safeSubsteps * 2;
  let executed = 0;

  while (executed < maxSteps && physicsAccumulatorMs >= fixedSubDeltaMs) {
    if (advanceSimClock) {
      gameState.simTimeSec += fixedSubDtSec;
    }
    if (typeof onSubStep === 'function') {
      onSubStep(fixedSubDtSec, executed, fixedSubDeltaMs);
    }
    physicsAccumulatorMs -= fixedSubDeltaMs;
    executed++;
  }

  return executed * fixedSubDtSec;
}

/* ============================================================================
 * 3. フレームレート非依存の減衰・補間・角度ユーティリティ（第4章 4.2 準拠）
 * ========================================================================== */

/**
 * 60Hz 1フレーム基準の減衰係数 d_frame をサブステップ数 S へ等価変換する（d_step = d_frame^(1/S)）
 * @param {number} frameDecay60Hz 60Hz 1フレームあたりの減衰係数 (0〜1)
 * @param {number} [substeps=PHYSICS_SUBSTEPS] サブステップ数
 * @returns {number}
 */
export function substepDecayFactor(frameDecay60Hz, substeps = PHYSICS_SUBSTEPS) {
  const d = clamp(safeFinite(frameDecay60Hz, 1), 0.0001, 1);
  const s = Math.max(1, safeFinite(substeps, PHYSICS_SUBSTEPS));
  return Math.pow(d, 1 / s);
}

/**
 * 任意 dt（秒）に対して 60Hz 基準減衰係数を等価適用する指数減衰（v ← v * d^(60 * dt)）
 * @param {number} value 対象値（速度等）
 * @param {number} frameDecay60Hz 60Hz 1フレーム基準の減衰係数 (0〜1)
 * @param {number} dtSec 経過時間（秒）
 * @returns {number}
 */
export function expDamp(value, frameDecay60Hz, dtSec) {
  const v = safeFinite(value, 0);
  const d = clamp(safeFinite(frameDecay60Hz, 1), 0.0001, 1);
  const dt = clamp(safeFinite(dtSec, 0), 0, 0.1);
  if (dt <= 0) return v;
  return v * Math.pow(d, FIXED_FPS * dt);
}

/**
 * フレームレート非依存の指数補間係数（1 - exp(-rate * dt)）を算出
 * @param {number} ratePerSec 追従速度係数（1/秒）
 * @param {number} dtSec 経過時間（秒）
 * @returns {number}
 */
export function expLerpFactor(ratePerSec, dtSec) {
  const rate = Math.max(0.001, safeFinite(ratePerSec, 1));
  const dt = clamp(safeFinite(dtSec, 0), 0, 0.1);
  if (dt <= 0) return 0;
  return 1 - Math.exp(-rate * dt);
}

/**
 * 指数補間（現在値 → 目標値）
 * @param {number} current
 * @param {number} target
 * @param {number} ratePerSec
 * @param {number} dtSec
 * @returns {number}
 */
export function expLerp(current, target, ratePerSec, dtSec) {
  const c = safeFinite(current, 0);
  const t = safeFinite(target, c);
  return c + (t - c) * expLerpFactor(ratePerSec, dtSec);
}

/**
 * 角度差分を [-PI, +PI] へ正規化（最短回転方向を保証）
 * @param {number} deltaRad
 * @returns {number}
 */
export function normalizeAngleDelta(deltaRad) {
  let d = safeFinite(deltaRad, 0);
  const twoPi = Math.PI * 2;
  d = ((d + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  return d;
}

/**
 * 最短経路での角度指数補間（ロボットの向き反転等で使用）
 * @param {number} currentRad
 * @param {number} targetRad
 * @param {number} ratePerSec
 * @param {number} dtSec
 * @returns {number}
 */
export function expLerpAngle(currentRad, targetRad, ratePerSec, dtSec) {
  const c = safeFinite(currentRad, 0);
  const t = safeFinite(targetRad, c);
  const diff = normalizeAngleDelta(t - c);
  return c + diff * expLerpFactor(ratePerSec, dtSec);
}

/* ============================================================================
 * 4. 判定タイマー高速減衰・NaN防護・空間クランプ・衝突判定（第4章 4.6 準拠）
 * ========================================================================== */

/**
 * 判定タイマーの高速減衰ヘルパー（1フレーム即0リセット禁止・微振動ブレ防止）
 * @param {number} timerSec 現在のタイマー値（秒）
 * @param {number} dtSec 経過時間（秒）
 * @param {number} [decayRate=2.5] 減衰倍率
 * @returns {number}
 */
export function decayJudgeTimer(timerSec, dtSec, decayRate = 2.5) {
  const cur = Math.max(0, safeFinite(timerSec, 0));
  const dt = Math.max(0, safeFinite(dtSec, 0));
  const rate = Math.max(0.1, safeFinite(decayRate, 2.5));
  return Math.max(0, cur - dt * rate);
}

/**
 * 座標 X をタワー水平幅内へ安全クランプ（NaN / Infinity 防護付き）
 * @param {number} x
 * @param {number} [margin=0.35] 左右端からの安全マージン
 * @returns {number}
 */
export function clampStageX(x, margin = 0.35) {
  const m = clamp(safeFinite(margin, 0.35), 0, STAGE_WIDTH_HALF - 0.1);
  return clamp(safeFinite(x, 0), -STAGE_WIDTH_HALF + m, STAGE_WIDTH_HALF - m);
}

/**
 * 速度成分の NaN / Infinity 遮断 ＆ 絶対値上限クランプ
 * @param {number} v
 * @param {number} [maxAbs=22.0]
 * @returns {number}
 */
export function sanitizeVelocity(v, maxAbs = 22.0) {
  const lim = Math.max(0.1, safeFinite(maxAbs, 22.0));
  return clamp(safeFinite(v, 0), -lim, lim);
}

/**
 * 同座標 NaN ガード付き 2D 単位方向ベクトル算出（距離 < 0.001 時はフォールバック適用）
 * @param {number} dx
 * @param {number} dy
 * @param {{nx: number, ny: number, dist: number}} [outVec] 再利用出力オブジェクト
 * @returns {{nx: number, ny: number, dist: number}}
 */
export function safeUnitDirection2D(dx, dy, outVec = _defaultDirOut) {
  const out = outVec || _defaultDirOut;
  const sdx = safeFinite(dx, 0);
  const sdy = safeFinite(dy, 0);
  const distSq = sdx * sdx + sdy * sdy;
  if (distSq < 0.000001) {
    out.nx = 1;
    out.ny = 0;
    out.dist = 1.0;
    return out;
  }
  const dist = Math.sqrt(distSq);
  out.nx = sdx / dist;
  out.ny = sdy / dist;
  out.dist = dist;
  return out;
}

/**
 * 2D 中心座標＋半幅によるゼロアロケーション AABB 衝突判定
 * @param {number} ax
 * @param {number} ay
 * @param {number} arx AのX半幅
 * @param {number} ary AのY半幅
 * @param {number} bx
 * @param {number} by
 * @param {number} brx BのX半幅
 * @param {number} bry BのY半幅
 * @returns {boolean}
 */
export function intersectsAABB2D(ax, ay, arx, ary, bx, by, brx, bry) {
  return (
    Math.abs(ax - bx) < (arx + brx) &&
    Math.abs(ay - by) < (ary + bry)
  );
}

/**
 * 2D 点（または中心）が指定ボックス内にあるか判定（パンチヒットボックス判定用）
 * @param {number} px
 * @param {number} py
 * @param {number} bx
 * @param {number} by
 * @param {number} brx
 * @param {number} bry
 * @returns {boolean}
 */
export function intersectsPointBox2D(px, py, bx, by, brx, bry) {
  return (
    Math.abs(px - bx) < brx &&
    Math.abs(py - by) < bry
  );
}