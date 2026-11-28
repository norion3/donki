/**
 * camera.js
 * @version v1.0 (High-Rise Golden-Ratio Camera & Zero-Alloc Projection - Phase 7)
 * @changes
 *   - 高層タワー寸法（幅11.6 / 高さ16.8 / 中心Y=7.45）と実プレイ領域から最適カメラ距離・注視点Yを自動算出する getCameraFraming() を実装
 *   - 30Hz / 60Hz / 120Hz ProMotion 環境で完全に同一の追従速度を保つ指数補間（1 - exp(-k * dt)）ベースのカメラワークを実装
 *   - 通常追従・画面シェイク・ステージクリアズーム・100m 全杭抜きボス大墜落フォーカスズーム・ゲームオーバーズームを実装
 *   - ステージ切替・リトライ時のカメラ即時スナップ resetCameraToStage() を実装
 *   - 事前確保 Vector3 と出力バッファ再利用によるゼロアロケーション 3D→2D 画面座標投影 projectWorldToScreen() を実装
 *
 * Tier 2 機構モジュール：縦横自動フィットカメラワーク・演出ズーム制御・3D→2D投影ユーティリティ
 */

import {
  CAMERA_DESIRED_WIDTH,
  CAMERA_DESIRED_HEIGHT,
  CAMERA_TOWER_CENTER_Y,
  CAMERA_FOV,
  clamp,
  safeFinite
} from './constants.js?v=1';

import {
  gameState,
  player,
  bossCtrl,
  stageRuntime,
  viewportState
} from './world_state.js?v=1';

import { THREE } from './materials.js?v=1';
import { world3D } from './world.js?v=1';

/* ============================================================================
 * 1. カメラ内部ステート ＆ 事前確保ワークバッファ（GCスパイク根絶）
 * ========================================================================== */

const camState = {
  currentY: CAMERA_TOWER_CENTER_Y,
  lookX: 0,
  lookY: CAMERA_TOWER_CENTER_Y,
  lookZ: 0
};

/** getCameraFraming() 用再利用出力オブジェクト（毎フレーム生成ゼロ） */
const framingResult = {
  baseZ: 30.5,
  idealCenterY: CAMERA_TOWER_CENTER_Y,
  aspect: 390 / 844
};

/** projectWorldToScreen() 用事前確保 Vector3 ＆ 出力バッファ */
const _projVec = new THREE.Vector3();
const _defaultProjOut = { x: 0, y: 0, visible: false };

/**
 * フレームレート非依存の指数補間係数を算出（30Hz / 60Hz / 120Hz 完全一致）
 * @param {number} rate 追従速度係数（1/秒）
 * @param {number} dt 秒
 * @returns {number}
 */
function expSmoothFactor(rate, dt) {
  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  return 1 - Math.exp(-Math.max(0.01, rate) * safeDt);
}

/* ============================================================================
 * 2. 高層タワー黄金比フレーミング計算（iPhone SE〜Pro Max 全画面自動最適化）
 * ========================================================================== */

/**
 * 画面サイズ・上部セーフエリア＋極薄HUD・下部操作デッキ占有高から、
 * タワー横幅(11.6)と高さ(16.8)がプレイ領域へジャストフィットするカメラ距離と注視点Yを算出
 * @returns {{baseZ: number, idealCenterY: number, aspect: number}}
 */
export function getCameraFraming() {
  const vw = Math.max(1, safeFinite(viewportState.w, 390));
  const vh = Math.max(1, safeFinite(viewportState.h, 844));
  const aspect = clamp(vw / vh, 0.28, 3.0);

  const fovDeg = world3D.camera ? safeFinite(world3D.camera.fov, CAMERA_FOV) : CAMERA_FOV;
  const vFovRad = THREE.MathUtils.degToRad(fovDeg);
  const tanHalfFov = Math.max(0.05, Math.tan(vFovRad * 0.5));

  // 上部占有高（GRAVITYネイティブバー回避 safeTopPx ＋ スコア専用極薄HUD topHudH）
  const topOccupied = Math.max(0, safeFinite(viewportState.safeTopPx, 52) + safeFinite(viewportState.topHudH, 30));
  // 下部占有高（SafeBottom 込みの操作デッキ高）
  const bottomOccupied = Math.max(0, safeFinite(viewportState.bottomDeckH, 136));

  // 実プレイ領域の高さ割合を算出
  const playablePxH = Math.max(vh * 0.42, vh - topOccupied - bottomOccupied);
  const playableRatioH = clamp(playablePxH / vh, 0.42, 0.92);

  // タワー横幅と縦幅の両方が画面内に収まるカメラ距離 Z を算出
  const zForWidth = (CAMERA_DESIRED_WIDTH * 0.5) / (tanHalfFov * aspect);
  const zForHeight = (CAMERA_DESIRED_HEIGHT / playableRatioH) / (2 * tanHalfFov);
  const baseZ = clamp(Math.max(zForWidth, zForHeight), 15.0, 56.0);

  // 上下UIの中央にタワー基準中心（Y=7.45）が来るように注視点Yをオフセット補正
  const worldFullH = 2 * baseZ * tanHalfFov;
  const shiftFrac = (bottomOccupied - topOccupied) / (2 * vh);
  const idealCenterY = CAMERA_TOWER_CENTER_Y - shiftFrac * worldFullH;

  framingResult.baseZ = baseZ;
  framingResult.idealCenterY = idealCenterY;
  framingResult.aspect = aspect;
  return framingResult;
}

/* ============================================================================
 * 3. カメラ即時スナップ（ステージ開始・リトライ・リサイズ時のガタつき防止）
 * ========================================================================== */

/**
 * カメラを現在ステージの理想位置へ補間なしで即時スナップ
 */
export function snapCameraToStage() {
  const camera = world3D.camera;
  if (!camera) return;

  const { baseZ, idealCenterY } = getCameraFraming();
  const px = safeFinite(player.x, 0);
  const py = safeFinite(player.y, 0);

  const targetY = idealCenterY + (py - CAMERA_TOWER_CENTER_Y) * 0.09;
  const subtleX = px * 0.08;

  camState.currentY = targetY;
  camState.lookX = subtleX * 0.45;
  camState.lookY = targetY;
  camState.lookZ = 0;

  camera.position.set(subtleX, targetY + 1.05, baseZ);
  camera.lookAt(camState.lookX, camState.lookY, camState.lookZ);

  if (world3D.scene && world3D.scene.fog) {
    world3D.scene.fog.near = baseZ + 16;
    world3D.scene.fog.far = baseZ + 62;
  }
  const desiredFar = Math.max(150, baseZ + 100);
  if (Math.abs(camera.far - desiredFar) > 1) {
    camera.far = desiredFar;
    camera.updateProjectionMatrix();
  }
}

/* ============================================================================
 * 4. 毎フレーム カメラ更新（通常・クリア・100mボス大墜落・ゲームオーバー）
 * ========================================================================== */

/**
 * 現在の gameState.phase に応じた最適なカメラ位置・注視点・霧範囲を更新
 * @param {number} dt 秒（クランプ済み経過時間）
 */
export function updateCamera(dt) {
  const camera = world3D.camera;
  if (!camera) return;

  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  const { baseZ, idealCenterY, aspect } = getCameraFraming();

  // カメラ距離に応じて霧と描画遠クリップ面を自動最適化
  if (world3D.scene && world3D.scene.fog) {
    world3D.scene.fog.near = baseZ + 16;
    world3D.scene.fog.far = baseZ + 62;
  }
  const desiredFar = Math.max(150, baseZ + 100);
  if (Math.abs(camera.far - desiredFar) > 1) {
    camera.far = desiredFar;
    camera.updateProjectionMatrix();
  }

  // 画面シェイク減衰（時間ベース）
  let shakeX = 0;
  let shakeY = 0;
  if (gameState.shakeTimer > 0) {
    gameState.shakeTimer = Math.max(0, gameState.shakeTimer - safeDt);
    const amp = gameState.shakeTimer * (gameState.phase === 'gameover' ? 0.55 : 0.85);
    shakeX = (Math.random() - 0.5) * amp;
    shakeY = (Math.random() - 0.5) * amp;
  }

  // --------------------------------------------------------------------------
  // A) ステージクリア演出ズーム（ヒロイン＆プレイヤーのダンスをクローズアップ）
  // --------------------------------------------------------------------------
  if (gameState.phase === 'stage_clear') {
    const def = stageRuntime.stageDef;
    const hr = def && def.heroine ? def.heroine : { x: 0.7, y: 14.85, clearPlayerX: -0.25, clearFriendX: 0.85 };
    const midX = ((safeFinite(hr.clearPlayerX, hr.x - 0.5) + safeFinite(hr.clearFriendX, hr.x + 0.5)) * 0.5);
    const clearY = safeFinite(hr.y, 14.85);
    const clearZ = clamp(3.6 / Math.max(0.45, aspect), 5.2, 8.6);

    const kPos = expSmoothFactor(3.8, safeDt);
    const kLook = expSmoothFactor(4.4, safeDt);

    camera.position.x += (midX - camera.position.x) * kPos;
    camera.position.y += ((clearY + 1.15) - camera.position.y) * kPos;
    camera.position.z += (clearZ - camera.position.z) * kPos;

    camState.lookX += (midX - camState.lookX) * kLook;
    camState.lookY += ((clearY + 0.55) - camState.lookY) * kLook;
    camState.lookZ += (0 - camState.lookZ) * kLook;

    camera.lookAt(camState.lookX, camState.lookY, camState.lookZ);
    return;
  }

  // --------------------------------------------------------------------------
  // B) 100m 全杭抜き完了・ボス大墜落フォーカスズーム（第2章・設計書v2.1 準拠）
  // --------------------------------------------------------------------------
  if (gameState.phase === 'rivet_collapse') {
    const bx = safeFinite(bossCtrl.x, 0);
    const by = clamp(safeFinite(bossCtrl.y, 6.0), 0.8, 13.5);
    const focusZ = clamp(Math.min(baseZ * 0.62, 9.5 / Math.max(0.45, aspect)), 11.5, 22.0);

    const kPos = expSmoothFactor(4.5, safeDt);
    const kLook = expSmoothFactor(6.0, safeDt);

    const desiredX = bx * 0.35;
    const desiredY = clamp(by + 1.4, 3.2, 13.8);

    camera.position.x += (desiredX - camera.position.x) * kPos + shakeX;
    camera.position.y += (desiredY - camera.position.y) * kPos + shakeY;
    camera.position.z += (focusZ - camera.position.z) * kPos;

    camState.lookX += (bx * 0.65 - camState.lookX) * kLook;
    camState.lookY += ((by + 0.6) - camState.lookY) * kLook;
    camState.lookZ += (0 - camState.lookZ) * kLook;

    camera.lookAt(camState.lookX, camState.lookY, camState.lookZ);
    return;
  }

  // --------------------------------------------------------------------------
  // C) ゲームオーバー演出ズーム（離れたロボットが崩れ落ちる動きをアップ表示）
  // --------------------------------------------------------------------------
  if (gameState.phase === 'gameover') {
    const px = safeFinite(player.x, 0);
    const py = safeFinite(player.y, 0);
    const pz = world3D.playerGroup ? safeFinite(world3D.playerGroup.position.z, 0) : 0;
    const failZ = clamp(3.15 / Math.max(0.45, aspect), 4.6, 7.6);

    const kPos = expSmoothFactor(5.2, safeDt);
    const kLook = expSmoothFactor(6.2, safeDt);

    const desiredCamX = clamp(px, -4.4, 4.4);
    const desiredCamY = py + 0.92;

    camera.position.x += (desiredCamX - camera.position.x) * kPos + shakeX;
    camera.position.y += (desiredCamY - camera.position.y) * kPos + shakeY;
    camera.position.z += (failZ - camera.position.z) * kPos;

    // 下部操作デッキと被らないよう注視点をわずかに下げ、画面中央やや上にキャラを映す
    camState.lookX += (px - camState.lookX) * kLook;
    camState.lookY += ((py + 0.22) - camState.lookY) * kLook;
    camState.lookZ += ((pz * 0.5) - camState.lookZ) * kLook;

    camera.lookAt(camState.lookX, camState.lookY, camState.lookZ);
    return;
  }

  // --------------------------------------------------------------------------
  // D) 通常プレイ ／ タイトル待機（高層タワー全層俯瞰＋緩やかなプレイヤー追従）
  // --------------------------------------------------------------------------
  const px = safeFinite(player.x, 0);
  const py = safeFinite(player.y, 0);
  const targetY = idealCenterY + (py - CAMERA_TOWER_CENTER_Y) * 0.09;

  const kY = expSmoothFactor(5.2, safeDt);
  const kZ = expSmoothFactor(5.5, safeDt);

  camState.currentY += (targetY - camState.currentY) * kY;

  const subtleX = px * 0.08;
  camState.lookX += (subtleX * 0.45 - camState.lookX) * kY;
  camState.lookY = camState.currentY;
  camState.lookZ = 0;

  camera.position.x += (subtleX - camera.position.x) * kY + shakeX;
  camera.position.y = camState.currentY + 1.05 + shakeY;
  camera.position.z += (baseZ - camera.position.z) * kZ;
  camera.lookAt(camState.lookX, camState.lookY, camState.lookZ);
}

/* ============================================================================
 * 5. ゼロアロケーション 3D→2D 画面座標投影（フローティングスコア表示用）
 * ========================================================================== */

/**
 * 3D ワールド座標を現在の画面 CSS ピクセル座標へ投影する（事前確保 Vector3 再利用）
 * @param {number} wx ワールドX
 * @param {number} wy ワールドY
 * @param {number} wz ワールドZ（デフォルト 0.4）
 * @param {{x: number, y: number, visible: boolean}} [outObj] 再利用出力オブジェクト
 * @returns {{x: number, y: number, visible: boolean}}
 */
export function projectWorldToScreen(wx, wy, wz = 0.4, outObj = _defaultProjOut) {
  const out = outObj || _defaultProjOut;
  const camera = world3D.camera;
  if (!camera) {
    out.x = 0;
    out.y = 0;
    out.visible = false;
    return out;
  }

  const sx = safeFinite(wx, 0);
  const sy = safeFinite(wy, 0);
  const sz = safeFinite(wz, 0.4);

  _projVec.set(sx, sy + 0.78, sz);
  _projVec.project(camera);

  const vw = Math.max(1, safeFinite(viewportState.w, 390));
  const vh = Math.max(1, safeFinite(viewportState.h, 844));

  const px = (_projVec.x * 0.5 + 0.5) * vw;
  const py = (-_projVec.y * 0.5 + 0.5) * vh;

  out.x = clamp(safeFinite(px, vw * 0.5), 24, Math.max(24, vw - 24));
  out.y = clamp(safeFinite(py, vh * 0.5), 40, Math.max(40, vh - 40));
  out.visible = Number.isFinite(_projVec.z) && _projVec.z >= -1 && _projVec.z <= 1;
  return out;
}