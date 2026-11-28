/**
 * player_ctrl.js
 * @version v1.0 (Player Physics, Gimmick Interaction, Fall Recovery & Phase Transitions - Phase 9)
 * @changes
 *   - プレイヤー物理移動・コヨーテタイム＆先行入力ジャンプ・ショートホップ重力・しゃがみ・A案ハイパー電池中アクション許可を実装
 *   - 固定はしご＆50m 電動伸縮はしごのマグネット吸着・伸縮上端追従クランプ・はしごジャンプ脱出を実装
 *   - 50m 反転コンベア押し流し・75m 循環エレベーター乗車／ラップアラウンド安全離脱／隣接島移乗を実装
 *   - 100m 光る杭の歩行／パンチ引き抜き・貫通穴出現・全8本抜き完了時のボス大墜落クリア遷移を実装
 *   - 高所落下（>= 2.30）＆奈落落下（Y < -1.0）時の 1 ダメージ＋直前安全床復帰を実装
 *   - 被ダメージ・ゲームオーバー確定瞬間の GRAVITY 公式スコア1回限定送信（reportFinalScoreOnce）・障害物回避ダウン演出・ステージクリアダンス演出を実装
 *
 * Tier 3 業務モジュール：プレイヤー移動・アクション・地形ギミック連動・勝敗確定遷移
 */

import {
  PLAYER_MAX_SPEED,
  PLAYER_POWER_SPEED,
  PLAYER_LADDER_SPEED,
  PLAYER_JUMP_VY,
  PLAYER_LADDER_JUMP_VY,
  PLAYER_GRAVITY_NORMAL,
  PLAYER_GRAVITY_SHORT_HOP,
  PLAYER_MAX_FALL_VY,
  PLAYER_FALL_DAMAGE_THRESHOLD,
  ABYSS_Y,
  PLAYER_COYOTE_TIME,
  PLAYER_JUMP_BUFFER_TIME,
  PLAYER_PUNCH_DURATION,
  PLAYER_PUNCH_COOLDOWN,
  PLAYER_INVULN_DURATION,
  POWER_UP_ALLOW_JUMP_AND_LADDER,
  AFTERGLOW_GAMEOVER_MS,
  AFTERGLOW_CLEAR_MS,
  AFTERGLOW_RIVET_COLLAPSE_MS,
  SCORE_VALUES,
  clamp,
  safeFinite
} from './constants.js?v=1';

import {
  getFloorY,
  isSolidFloorAt,
  isPointOverPulledRivetHole,
  isLadderConnectedToTop,
  getLadderCurrentTopY
} from './stages.js?v=1';

import {
  gameState,
  player,
  bossCtrl,
  stageRuntime,
  inputState,
  entities,
  workBuffers,
  reportFinalScoreOnce,
  scheduleSessionTimer,
  resetInputFields,
  addScore,
  enqueueFloatText,
  recordPlayerSafePoint,
  resolvePlayerRecoveryPoint,
  healPlayerOnLoopClear
} from './world_state.js?v=1';

import { sound } from './audio.js?v=1';
import { THREE } from './materials.js?v=1';
import {
  world3D,
  spawnParticles,
  applyRivetPulledVisual,
  triggerCenterFloorCollapseVisual,
  removeEntityMesh
} from './world.js?v=1';

import {
  expDamp,
  expLerp,
  expLerpAngle,
  clampStageX,
  sanitizeVelocity,
  intersectsPointBox2D
} from './physics.js?v=1';

/* ============================================================================
 * 1. Tier 4 連携コールバック登録（循環参照ゼロ・イベント通知ブリッジ）
 * ========================================================================== */

const callbacks = {
  onGameOverAfterglow: null,
  onStageClearAfterglow: null,
  onRivetCollapseAfterglow: null,
  onForceReleaseInput: null
};

/**
 * Tier 4（main.js）からフェーズ遷移・入力解放用コールバックを登録
 * @param {object} nextCallbacks
 */
export function registerPlayerCallbacks(nextCallbacks = {}) {
  callbacks.onGameOverAfterglow =
    typeof nextCallbacks.onGameOverAfterglow === 'function' ? nextCallbacks.onGameOverAfterglow : null;
  callbacks.onStageClearAfterglow =
    typeof nextCallbacks.onStageClearAfterglow === 'function' ? nextCallbacks.onStageClearAfterglow : null;
  callbacks.onRivetCollapseAfterglow =
    typeof nextCallbacks.onRivetCollapseAfterglow === 'function' ? nextCallbacks.onRivetCollapseAfterglow : null;
  callbacks.onForceReleaseInput =
    typeof nextCallbacks.onForceReleaseInput === 'function' ? nextCallbacks.onForceReleaseInput : null;
}

/**
 * 入力を安全に全解放（Tier 4 の input.js 登録済み関数＋共有フィールド両方リセット）
 */
function releaseAllInputsSafe() {
  resetInputFields();
  if (callbacks.onForceReleaseInput) {
    callbacks.onForceReleaseInput();
  }
}

/* ============================================================================
 * 2. パンチ当たり判定ボックス（事前確保バッファ再利用・ゼロアロケーション）
 * ========================================================================== */

/**
 * 現在のパンチ判定ボックスを workBuffers.punchBox へ更新して返す
 * @returns {{active: boolean, x: number, y: number, rx: number, ry: number}}
 */
export function getPunchHitbox() {
  const box = workBuffers.punchBox;
  if (player.punchTimer <= 0 || gameState.phase !== 'playing') {
    box.active = false;
    return box;
  }
  const isPower = gameState.powerTimer > 0;
  box.active = true;
  box.x = player.x + player.facing * 0.72;
  box.y = player.y + 0.55;
  box.rx = isPower ? 1.38 : 1.05;
  box.ry = 0.76;
  return box;
}

/* ============================================================================
 * 3. 安全床記録・障害物回避ダウン位置探索ヘルパー
 * ========================================================================== */

/**
 * 現在位置が復帰先として安全な固体フロア上であれば直前安全床座標を記録
 * @param {object} stageDef
 */
function tryRecordCurrentSafePoint(stageDef) {
  if (!stageDef || !player.grounded || player.onLadder || player.onElevator) return;
  const fl = stageDef.floors[player.currentFloorIdx];
  if (!fl) return;

  // 端ギリギリ・杭穴・崩落中央は除外
  if (!isSolidFloorAt(fl, player.x, entities.rivets, stageRuntime.isCollapsed, -0.32)) return;

  // 杭穴のすぐ際も少し余裕を持たせる
  for (let i = 0; i < entities.rivets.length; i++) {
    const r = entities.rivets[i];
    if (r.pulled && r.floorIdx === fl.id && Math.abs(player.x - r.x) < r.holeHalfWidth + 0.28) {
      return;
    }
  }

  // オイル炉のすぐ横は除外
  for (let i = 0; i < stageDef.furnaces.length; i++) {
    const fn = stageDef.furnaces[i];
    if (fn.floorIdx === fl.id && Math.abs(player.x - fn.x) < 0.85) {
      return;
    }
  }

  // 25m / 75m のボス接触ゾーンは除外
  if (stageDef.boss && stageDef.boss.floorIdx === fl.id && typeof stageDef.boss.hurtMinX === 'number') {
    if (player.x < stageDef.boss.hurtMinX + 0.30) return;
  }

  recordPlayerSafePoint(player.currentFloorIdx, player.x, player.y);
}

/**
 * ダウン演出時にタル・敵・木箱・火の玉・ボスから最も離れた安全な倒れ位置を探索
 * @param {number} fromX
 * @param {number} floorIdx
 * @param {number} knockDir
 * @returns {number}
 */
function findSafeDeathX(fromX, floorIdx, knockDir) {
  const def = stageRuntime.stageDef;
  const fl = (def && def.floors[floorIdx]) ? def.floors[floorIdx] : (def ? def.floors[0] : null);
  if (!fl) return fromX;

  let minX = fl.xMin + 0.55;
  const maxX = fl.xMax - 0.55;
  if (def.boss && def.boss.floorIdx === floorIdx && typeof def.boss.hurtMinX === 'number') {
    minX = Math.max(minX, def.boss.hurtMinX + 0.40);
  }
  if (minX >= maxX) {
    return (fl.xMin + fl.xMax) * 0.5;
  }

  const dir = knockDir >= 0 ? 1 : -1;
  const baseY = getFloorY(fl, clamp(fromX, minX, maxX));

  let bestX = clamp(fromX + dir * 1.40, minX, maxX);
  let bestScore = -Infinity;

  for (let x = minX; x <= maxX + 0.001; x += 0.25) {
    const cx = Math.min(x, maxX);
    if (!isSolidFloorAt(fl, cx, entities.rivets, stageRuntime.isCollapsed, -0.25)) continue;

    const distFromOrigin = Math.abs(cx - fromX);
    if (distFromOrigin < 0.65 || distFromOrigin > 2.75) continue;

    let minObsDist = 4.0;
    for (let i = 0; i < entities.barrels.length; i++) {
      const b = entities.barrels[i];
      if (b.alive && Math.abs(b.y - baseY) < 1.9) {
        const d = Math.abs(cx - b.x);
        if (d < minObsDist) minObsDist = d;
      }
    }
    for (let i = 0; i < entities.enemies.length; i++) {
      const en = entities.enemies[i];
      if (en.alive && Math.abs(en.y - baseY) < 1.9) {
        const d = Math.abs(cx - en.x);
        if (d < minObsDist) minObsDist = d;
      }
    }
    for (let i = 0; i < entities.fireballs.length; i++) {
      const fb = entities.fireballs[i];
      if (fb.alive && Math.abs(fb.y - baseY) < 1.9) {
        const d = Math.abs(cx - fb.x);
        if (d < minObsDist) minObsDist = d;
      }
    }
    for (let i = 0; i < entities.crates.length; i++) {
      const cr = entities.crates[i];
      if (cr.alive && Math.abs(cr.y - baseY) < 1.9) {
        const d = Math.abs(cx - cr.x);
        if (d < minObsDist) minObsDist = d;
      }
    }
    if (def.boss && def.boss.floorIdx === floorIdx) {
      const bd = Math.abs(cx - bossCtrl.x);
      if (bd < minObsDist) minObsDist = bd;
    }

    const dirBonus = ((cx - fromX) * dir > 0) ? 0.45 : 0;
    const distPenalty = Math.abs(distFromOrigin - 1.40) * 0.25;
    const score = Math.min(minObsDist, 2.4) * 2.2 + dirBonus - distPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestX = cx;
    }
  }

  return bestX;
}

/* ============================================================================
 * 4. ダメージ・落下ダメージ復帰・ゲームオーバー確定（公式スコア即時送信）
 * ========================================================================== */

/**
 * プレイヤーを直前安全床へ復帰させる（落下ダメージ／奈落落下専用）
 */
function warpPlayerToSafeRecovery() {
  const safe = resolvePlayerRecoveryPoint();
  player.currentFloorIdx = safe.floorIdx;
  player.x = safe.x;
  player.y = safe.y + 0.04;
  player.z = 0;
  player.vx = 0;
  player.vy = 0;
  player.grounded = true;
  player.onLadder = null;
  player.onElevator = null;
  player.isCrouching = false;
  player.wasFalling = false;
  player.fallStartY = safe.y;

  if (world3D.playerGroup) {
    world3D.playerGroup.position.set(player.x, player.y, 0);
  }
  spawnParticles(player.x, player.y + 0.5, 0, 0x38bdf8, 12, 4.2);
}

/**
 * ゲームオーバー確定処理（GRAVITY 公式スコアを確定瞬間に 1 回限定で即時送信）
 * @param {number} knockDir
 * @param {boolean} fromAbyss
 */
function finalizeGameOver(knockDir, fromAbyss = false) {
  gameState.phase = 'gameover';
  gameState.isWaitingStart = false;
  gameState.isResultSettled = false;
  gameState.resultSettleTimer = 0;
  gameState.shakeTimer = 0.18;
  gameState.hudDirty = true;

  // 第2章 2.2 絶対厳守：余韻演出を待たず確定瞬間にスナップショットスコアを1回だけ即時送信
  reportFinalScoreOnce();

  if (fromAbyss) {
    warpPlayerToSafeRecovery();
  }

  player.invulnTimer = 0;
  player.onLadder = null;
  player.onElevator = null;
  player.isCrouching = false;
  player.punchTimer = 0;
  workBuffers.punchBox.active = false;

  player.deathTargetX = findSafeDeathX(player.x, player.currentFloorIdx, knockDir || -player.facing);
  player.deathZ = 0.34;
  player.deathDelay = 0.24;
  player.deathAnimStarted = false;
  player.vx = 0;
  player.vy = 3.6;

  if (world3D.playerGroup) {
    world3D.playerGroup.visible = true;
  }
  if (world3D.playerAura) {
    world3D.playerAura.visible = false;
  }

  releaseAllInputsSafe();
  sound.playGameOver();

  if (world3D.playerAnim) {
    world3D.playerAnim.play('Jump', { loop: THREE.LoopOnce, timeScale: 1.1, fade: 0.05, force: true });
  }
  if (world3D.bossAnim) {
    world3D.bossAnim.play('Yes', { loop: THREE.LoopRepeat, force: true });
  }

  // 余韻（Afterglow）完了後にリザルトモーダル表示を通知（世代管理タイマー）
  scheduleSessionTimer(() => {
    if (gameState.phase !== 'gameover') return;
    if (callbacks.onGameOverAfterglow) {
      callbacks.onGameOverAfterglow();
    }
  }, AFTERGLOW_GAMEOVER_MS);
}

/**
 * プレイヤー被ダメージ処理（通常接触・高所落下・奈落落下・タイムアウト共通）
 * @param {number} [knockDir=0] ノックバック方向 (+1 / -1)
 * @param {{isFallDamage?: boolean, fromAbyss?: boolean, label?: string}} [options]
 */
export function hurtPlayer(knockDir = 0, options = {}) {
  if (gameState.phase !== 'playing') return;

  const isFallDamage = Boolean(options.isFallDamage);
  const fromAbyss = Boolean(options.fromAbyss);

  // 無敵時間中の扱い：通常ダメージは無視、奈落落下のみノーダメージで安全床へ即時救出
  if (player.invulnTimer > 0) {
    if (fromAbyss) {
      warpPlayerToSafeRecovery();
    }
    return;
  }

  gameState.hp = Math.max(0, gameState.hp - 1);
  gameState.hudDirty = true;

  if (isFallDamage || fromAbyss) {
    sound.playFallDamage();
    spawnParticles(player.x, Math.max(0, player.y + 0.4), 0, 0xfb7185, 16, 5.2);
    enqueueFloatText(player.x, Math.max(0.6, player.y + 0.4), options.label || 'FALL -1', 'rose');
  } else {
    sound.playHurt();
    spawnParticles(player.x, player.y + 0.5, 0, 0xf43f5e, 14, 5.0);
    enqueueFloatText(player.x, player.y + 0.45, options.label || 'OUCH!', 'rose');
  }

  if (gameState.hp <= 0) {
    finalizeGameOver(knockDir, fromAbyss);
    return;
  }

  // 残ライフあり：落下系は直前安全床へ即時復帰、通常接触はノックバック
  player.invulnTimer = PLAYER_INVULN_DURATION;
  gameState.shakeTimer = 0.24;

  if (isFallDamage || fromAbyss) {
    warpPlayerToSafeRecovery();
  } else {
    player.onLadder = null;
    player.onElevator = null;
    player.isCrouching = false;
    player.vy = 5.4;
    player.vx = (knockDir || -player.facing) * 3.4;
    player.grounded = false;
    player.wasFalling = false;
    player.fallStartY = player.y;
  }
}

/**
 * アーケード準拠ボーナス制限時間 0 到達時のタイムアウトダメージ
 */
export function triggerTimeoutHit() {
  if (gameState.phase !== 'playing') return;
  player.invulnTimer = 0; // タイムアウトは無敵貫通で確実に1ダメージ
  hurtPlayer(-player.facing, { isFallDamage: true, fromAbyss: false, label: 'TIME UP!' });
}

/* ============================================================================
 * 5. ステージクリア ＆ 100m 全杭抜きボス大墜落クリア遷移
 * ========================================================================== */

/**
 * 25m / 50m / 75m 最上階ヒロイン救出クリア遷移
 */
export function triggerStageClear() {
  if (gameState.phase !== 'playing') return;
  const def = stageRuntime.stageDef;
  const hr = def ? def.heroine : null;

  gameState.phase = 'stage_clear';
  gameState.isWaitingStart = false;
  gameState.hudDirty = true;

  // ステージクリア基礎点 ＋ 残ボーナス制限時間（ハイパー2倍対象外）
  const clearBonus = SCORE_VALUES.STAGE_CLEAR_BASE + Math.max(0, Math.floor(gameState.bonusTimer));
  addScore(clearBonus, player.x, player.y + 0.65, `CLEAR +${clearBonus}!`, 'pink', false);

  sound.playClear(false);
  const fxX = hr ? hr.x : player.x;
  const fxY = (hr ? hr.y : player.y) + 1.0;
  spawnParticles(fxX, fxY, 0, 0xf472b6, 24, 6.2);
  spawnParticles(fxX, fxY, 0, 0xfacc15, 20, 6.2);

  if (bossCtrl.heldMesh) {
    removeEntityMesh(bossCtrl.heldMesh);
    bossCtrl.heldMesh = null;
  }
  bossCtrl.phase = 'idle';

  player.onLadder = null;
  player.onElevator = null;
  player.vx = 0;
  player.vy = 0;
  player.punchTimer = 0;
  workBuffers.punchBox.active = false;
  if (hr) {
    player.y = hr.y;
  }

  if (world3D.playerGroup) world3D.playerGroup.visible = true;
  if (world3D.playerAura) world3D.playerAura.visible = false;
  releaseAllInputsSafe();

  if (world3D.playerAnim) world3D.playerAnim.play('Dance', { force: true });
  if (world3D.friendAnim) world3D.friendAnim.play('Dance', { force: true });
  if (world3D.bossAnim) world3D.bossAnim.play('Death', { loop: THREE.LoopOnce, force: true });

  scheduleSessionTimer(() => {
    if (gameState.phase !== 'stage_clear') return;
    if (callbacks.onStageClearAfterglow) {
      callbacks.onStageClearAfterglow();
    }
  }, AFTERGLOW_CLEAR_MS);
}

/**
 * 100m 全8本杭抜き完了 → 中央床崩落＆ボス大墜落 → 周回クリア遷移
 */
export function triggerRivetCollapseClear() {
  if (gameState.phase !== 'playing') return;

  gameState.phase = 'rivet_collapse';
  gameState.isWaitingStart = false;
  stageRuntime.isCollapsed = true;
  gameState.shakeTimer = 0.42;
  gameState.hudDirty = true;

  // 周回クリアボーナス ＋ 残ボーナス制限時間 ＋ HP+1回復
  const loopBonus = SCORE_VALUES.LOOP_CLEAR_BONUS + Math.max(0, Math.floor(gameState.bonusTimer));
  addScore(loopBonus, bossCtrl.x, bossCtrl.y + 0.9, `LOOP CLEAR +${loopBonus}!`, 'yellow', false);
  healPlayerOnLoopClear();

  sound.playClear(true);
  triggerCenterFloorCollapseVisual();

  // ボスを中央崩落落下フェーズへ切り替え
  bossCtrl.phase = 'falling';
  bossCtrl.vy = 2.2;
  bossCtrl.collapseDelay = 0.22;
  bossCtrl.collapseLanded = false;

  spawnParticles(bossCtrl.x, bossCtrl.y + 0.4, 0, 0xf59e0b, 26, 6.8);
  spawnParticles(bossCtrl.x, bossCtrl.y + 0.4, 0, 0xfef08a, 20, 6.2);

  // プレイヤーが中央崩落範囲に居た場合は左右の安全な外枠へスライド退避
  player.onLadder = null;
  player.onElevator = null;
  player.vx = 0;
  player.vy = 0;
  player.punchTimer = 0;
  workBuffers.punchBox.active = false;
  if (Math.abs(player.x) < 2.25) {
    player.x = player.x < 0 ? -2.95 : 2.95;
  }

  if (world3D.playerGroup) world3D.playerGroup.visible = true;
  if (world3D.playerAura) world3D.playerAura.visible = false;
  releaseAllInputsSafe();

  if (world3D.playerAnim) world3D.playerAnim.play('Dance', { force: true });
  if (world3D.friendAnim) world3D.friendAnim.play('Dance', { force: true });
  if (world3D.bossAnim) {
    world3D.bossAnim.play('Jump', { loop: THREE.LoopOnce, timeScale: 0.9, fade: 0.06, force: true });
  }

  scheduleSessionTimer(() => {
    if (gameState.phase !== 'rivet_collapse') return;
    if (callbacks.onRivetCollapseAfterglow) {
      callbacks.onRivetCollapseAfterglow();
    }
  }, AFTERGLOW_RIVET_COLLAPSE_MS);
}

/* ============================================================================
 * 6. 100m 光る杭（Rivet）引き抜き判定（歩行跨ぎ／パンチ両対応）
 * ========================================================================== */

/**
 * プレイヤーの歩行またはパンチによる 100m 杭抜きをチェック・適用
 * @param {object} punchBox
 */
function checkPlayerRivetPull(punchBox) {
  if (entities.rivets.length === 0 || gameState.phase !== 'playing') return;

  for (let i = 0; i < entities.rivets.length; i++) {
    const r = entities.rivets[i];
    if (r.pulled) continue;

    const hitByWalk =
      !player.onLadder &&
      Math.abs(player.x - r.x) < 0.44 &&
      Math.abs(player.y - r.y) < 0.56;

    const hitByPunch =
      punchBox.active &&
      intersectsPointBox2D(r.x, r.y + 0.14, punchBox.x, punchBox.y, punchBox.rx, punchBox.ry);

    if (!hitByWalk && !hitByPunch) continue;

    r.pulled = true;
    stageRuntime.pulledRivetCount += 1;
    applyRivetPulledVisual(r);

    sound.playRivetPull();
    spawnParticles(r.x, r.y + 0.18, 0, 0xfef08a, 14, 5.5);
    addScore(SCORE_VALUES.RIVET_PULL, r.x, r.y + 0.35, `RIVET! +${SCORE_VALUES.RIVET_PULL}`, 'yellow');

    // 歩いて抜いた直後に自分の足元の穴へ理不尽落下しないよう小ホップ補助
    if (hitByWalk && !hitByPunch && player.grounded) {
      player.vy = Math.max(player.vy, 3.6);
      player.grounded = false;
      player.fallStartY = player.y;
      player.wasFalling = false;
    }

    // 8本すべて抜いたら即座にボス大墜落クリア演出へ
    if (stageRuntime.totalRivetCount > 0 && stageRuntime.pulledRivetCount >= stageRuntime.totalRivetCount) {
      triggerRivetCollapseClear();
      return;
    }
  }
}

/* ============================================================================
 * 7. プレイヤー固定物理ステップ更新（updatePlayer）
 * ========================================================================== */

/**
 * プレイヤーの物理移動・アクション・ギミック連動を固定サブステップで更新
 * @param {number} dt 秒（固定サブステップ幅）
 */
export function updatePlayer(dt) {
  if (gameState.phase !== 'playing') return;
  const stageDef = stageRuntime.stageDef;
  if (!stageDef) return;

  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  if (safeDt <= 0) return;

  const mx = clamp(safeFinite(inputState.moveX, 0), -1, 1);
  const my = clamp(safeFinite(inputState.moveY, 0), -1, 1);
  const simTimeSec = gameState.simTimeSec;
  const isPower = gameState.powerTimer > 0;
  const canJumpAndLadder = !isPower || POWER_UP_ALLOW_JUMP_AND_LADDER;

  // 各種タイマー減算
  if (player.coyoteTimer > 0) player.coyoteTimer = Math.max(0, player.coyoteTimer - safeDt);
  if (player.jumpBufferTimer > 0) player.jumpBufferTimer = Math.max(0, player.jumpBufferTimer - safeDt);
  if (player.punchTimer > 0) player.punchTimer = Math.max(0, player.punchTimer - safeDt);
  if (player.punchCooldown > 0) player.punchCooldown = Math.max(0, player.punchCooldown - safeDt);
  if (player.invulnTimer > 0) player.invulnTimer = Math.max(0, player.invulnTimer - safeDt);

  // ジャンプ先行入力バッファ取り込み
  if (inputState.jumpPressed) {
    inputState.jumpPressed = false;
    if (canJumpAndLadder) {
      player.jumpBufferTimer = PLAYER_JUMP_BUFFER_TIME;
    }
  }

  // パンチ入力取り込み
  if (inputState.punchPressed) {
    inputState.punchPressed = false;
    if (player.punchCooldown <= 0 && !player.onLadder) {
      player.punchTimer = PLAYER_PUNCH_DURATION;
      player.punchCooldown = PLAYER_PUNCH_COOLDOWN;
      sound.playPunch();
      if (world3D.playerAnim) {
        world3D.playerAnim.play('Punch', {
          loop: THREE.LoopOnce,
          timeScale: 1.75,
          fade: 0.05,
          force: true
        });
      }
      player.vx = sanitizeVelocity(player.vx + player.facing * 2.1, 12);
    }
  }

  // --------------------------------------------------------------------------
  // 1) はしごのマグネット吸着チェック（固定＆50m 電動伸縮はしご両対応）
  // --------------------------------------------------------------------------
  if (!player.onLadder && canJumpAndLadder && Math.abs(my) > 0.40 && player.vy <= 1.2) {
    const ladders = stageDef.ladders;
    for (let i = 0; i < ladders.length; i++) {
      const lad = ladders[i];
      if (Math.abs(player.x - lad.x) >= 0.72) continue;

      const curTopY = getLadderCurrentTopY(lad, simTimeSec);
      const topConnected = isLadderConnectedToTop(lad, simTimeSec);

      // 下から上へ登り始める
      if (my > 0.40 && player.y >= lad.yBottom - 0.35 && player.y <= curTopY - 0.20) {
        player.onLadder = lad;
        player.onElevator = null;
        player.grounded = false;
        player.vx = 0;
        player.vy = 0;
        player.wasFalling = false;
        player.fallStartY = player.y;
        break;
      }

      // 上階から下へ降り始める（伸縮はしごは上端接続中のみ降りられる）
      if (my < -0.40 && topConnected && player.y >= lad.yTop - 0.45 && player.y <= lad.yTop + 0.45) {
        player.onLadder = lad;
        player.onElevator = null;
        player.y = lad.yTop - 0.14;
        player.grounded = false;
        player.vx = 0;
        player.vy = 0;
        player.wasFalling = false;
        player.fallStartY = player.y;
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // 2A) はしご昇降中
  // --------------------------------------------------------------------------
  if (player.onLadder) {
    const lad = player.onLadder;
    const curTopY = getLadderCurrentTopY(lad, simTimeSec);
    const topConnected = isLadderConnectedToTop(lad, simTimeSec);

    player.x = expLerp(player.x, lad.x, 16, safeDt);
    player.y += my * PLAYER_LADDER_SPEED * safeDt;
    player.isCrouching = false;
    player.wasFalling = false;
    player.fallStartY = player.y;

    // 電動伸縮はしごが縮んでいる最中は上端を超えないよう安全クランプ
    if (lad.retractable && !topConnected && player.y > curTopY - 0.18) {
      player.y = Math.max(lad.yBottom, curTopY - 0.18);
    }

    if (player.jumpBufferTimer > 0 && canJumpAndLadder) {
      // はしごからのジャンプ脱出
      player.onLadder = null;
      player.vy = PLAYER_LADDER_JUMP_VY;
      player.vx = mx * 4.4;
      player.jumpBufferTimer = 0;
      player.fallStartY = player.y;
      player.wasFalling = false;
      sound.playJump();
      if (world3D.playerAnim) {
        world3D.playerAnim.play('Jump', { loop: THREE.LoopOnce, force: true });
      }
    } else if (topConnected && player.y >= lad.yTop) {
      // 上階へ登り切り
      player.y = lad.yTop;
      player.currentFloorIdx = lad.toFloor;
      player.onLadder = null;
      player.grounded = true;
      player.fallStartY = player.y;
      tryRecordCurrentSafePoint(stageDef);
    } else if (player.y <= lad.yBottom) {
      // 下階へ降り切り
      player.y = lad.yBottom;
      player.currentFloorIdx = lad.fromFloor;
      player.onLadder = null;
      player.grounded = true;
      player.fallStartY = player.y;
      tryRecordCurrentSafePoint(stageDef);
    }

    if (world3D.playerGroup) {
      world3D.playerGroup.rotation.y = expLerpAngle(world3D.playerGroup.rotation.y, Math.PI, 12, safeDt);
    }
    if (world3D.playerAnim) {
      if (Math.abs(my) > 0.15) {
        world3D.playerAnim.play('Walking', { timeScale: 1.6 });
      } else {
        world3D.playerAnim.play('Idle');
      }
    }
  }
  // --------------------------------------------------------------------------
  // 2B) 通常移動・コンベア・エレベーター乗車・ジャンプ・着地＆落下ダメージ
  // --------------------------------------------------------------------------
  else {
    const maxSpeed = isPower ? PLAYER_POWER_SPEED : PLAYER_MAX_SPEED;
    player.isCrouching = player.grounded && my < -0.55 && Math.abs(mx) < 0.35;

    if (player.isCrouching) {
      player.vx = expDamp(player.vx, 0.78, safeDt);
    } else {
      const targetVx = mx * maxSpeed;
      const accelRate = player.grounded ? 24 : 14;
      player.vx = expLerp(player.vx, targetVx, accelRate, safeDt);
      if (Math.abs(mx) > 0.10) {
        player.facing = mx > 0 ? 1 : -1;
      }
    }

    // 50m 反転コンベアの押し流し速度を算出
    let conveyorVx = 0;
    if (player.grounded && !player.onElevator && stageRuntime.conveyorStates.length > 0) {
      for (let i = 0; i < stageRuntime.conveyorStates.length; i++) {
        const cs = stageRuntime.conveyorStates[i];
        if (cs.floorIdx === player.currentFloorIdx) {
          conveyorVx = cs.dir * cs.speed;
          break;
        }
      }
    }

    if (player.grounded) {
      player.coyoteTimer = PLAYER_COYOTE_TIME;
    }

    // ジャンプ発火
    if (player.jumpBufferTimer > 0 && player.coyoteTimer > 0 && canJumpAndLadder) {
      player.vy = PLAYER_JUMP_VY;
      player.grounded = false;
      player.onElevator = null;
      player.coyoteTimer = 0;
      player.jumpBufferTimer = 0;
      player.wasFalling = false;
      player.fallStartY = player.y;
      sound.playJump();
      if (world3D.playerAnim) {
        world3D.playerAnim.play('Jump', { loop: THREE.LoopOnce, timeScale: 1.2, force: true });
      }
    }

    // 75m 循環エレベーター乗車中の上下追従＆ラップアラウンド安全離脱
    let ridingElev = player.onElevator;
    if (ridingElev) {
      const elevJumpDelta = Math.abs(ridingElev.y - ridingElev.prevY);
      const nearShaftEnd =
        (ridingElev.shaft.dir > 0 && ridingElev.y >= ridingElev.shaft.yMax - 0.30) ||
        (ridingElev.shaft.dir < 0 && ridingElev.y <= ridingElev.shaft.yMin + 0.30);

      if (elevJumpDelta > 1.8 || nearShaftEnd) {
        // 循環端ワープ時は強制離脱して安全に落下判定へ移す
        player.onElevator = null;
        player.grounded = false;
        player.wasFalling = true;
        player.fallStartY = player.y;
        ridingElev = null;
      } else {
        player.y = ridingElev.y;
        player.vy = 0;
        player.grounded = true;
        player.wasFalling = false;
        player.fallStartY = player.y;
      }
    }

    // 落下開始点トラッキング（最高点または踏み外し点を正確に記録）
    if (!player.grounded) {
      if (player.vy <= 0) {
        if (!player.wasFalling) {
          player.wasFalling = true;
          player.fallStartY = player.y;
        } else if (player.y > player.fallStartY) {
          player.fallStartY = player.y;
        }
      } else {
        player.wasFalling = false;
        player.fallStartY = player.y;
      }
    } else {
      player.wasFalling = false;
      player.fallStartY = player.y;
    }

    // 重力適用（エレベーター非乗車中）
    const prevY = player.y;
    if (!ridingElev) {
      const gravity = (!inputState.jumpHeld && player.vy > 1.5)
        ? PLAYER_GRAVITY_SHORT_HOP
        : PLAYER_GRAVITY_NORMAL;
      player.vy = Math.max(PLAYER_MAX_FALL_VY, sanitizeVelocity(player.vy - gravity * safeDt, 20));
      player.y += player.vy * safeDt;
    }

    // 水平移動（コンベア押し流し加算＋タワー幅クランプ）
    player.x = clampStageX(player.x + (player.vx + conveyorVx) * safeDt, 0.35);

    // 乗車中エレベーターから横へ降りたかチェック
    if (ridingElev) {
      if (Math.abs(player.x - ridingElev.x) > ridingElev.halfWidth + 0.22) {
        player.onElevator = null;
        player.grounded = false;
        player.wasFalling = true;
        player.fallStartY = player.y;
        ridingElev = null;
      }
    }

    // ------------------------------------------------------------------------
    // 3) 固体フロア着地判定（100m 杭穴・中央崩落・75m 島フロア全対応）
    // ------------------------------------------------------------------------
    let landedOnSolidFloor = false;
    const floors = stageDef.floors;
    for (let i = floors.length - 1; i >= 0; i--) {
      const fl = floors[i];
      if (!isSolidFloorAt(fl, player.x, entities.rivets, stageRuntime.isCollapsed, 0.14)) {
        continue;
      }

      const floorY = getFloorY(fl, player.x);
      const wasOnThisFloor =
        player.grounded &&
        !ridingElev &&
        player.currentFloorIdx === i &&
        Math.abs(player.y - floorY) < 0.46;

      // エレベーターから隣接島フロアへのスムーズな水平移乗
      const steppingOffElevToFloor =
        Boolean(ridingElev) &&
        Math.abs(player.y - floorY) < 0.38 &&
        Math.abs(player.x - ridingElev.x) > ridingElev.halfWidth * 0.75;

      const fallingOntoFloor =
        !ridingElev &&
        player.vy <= 0 &&
        prevY >= floorY - 0.26 &&
        player.y <= floorY + 0.10;

      if (wasOnThisFloor || steppingOffElevToFloor || fallingOntoFloor) {
        const fallDist = (!wasOnThisFloor && !steppingOffElevToFloor && player.wasFalling)
          ? (player.fallStartY - floorY)
          : 0;

        player.y = floorY;
        player.vy = 0;
        player.grounded = true;
        player.onElevator = null;
        player.currentFloorIdx = i;
        player.wasFalling = false;
        player.fallStartY = floorY;
        landedOnSolidFloor = true;

        // 高所落下ダメージ判定（>= 2.30 ユニットで 1ダメージ＋直前安全床復帰）
        if (fallDist >= PLAYER_FALL_DAMAGE_THRESHOLD) {
          hurtPlayer(-player.facing, { isFallDamage: true, fromAbyss: false, label: 'FALL -1' });
          return;
        }

        tryRecordCurrentSafePoint(stageDef);
        break;
      }
    }

    // ------------------------------------------------------------------------
    // 4) 75m 循環エレベーター着地キャッチ判定（固体フロア非着地時）
    // ------------------------------------------------------------------------
    if (!landedOnSolidFloor && !ridingElev && stageRuntime.elevatorPlatforms.length > 0 && player.vy <= 0) {
      const plats = stageRuntime.elevatorPlatforms;
      for (let i = 0; i < plats.length; i++) {
        const plat = plats[i];
        if (Math.abs(plat.y - plat.prevY) > 1.8) continue;
        if (Math.abs(player.x - plat.x) > plat.halfWidth + 0.20) continue;

        if (prevY >= plat.prevY - 0.26 && player.y <= plat.y + 0.16) {
          const fallDist = player.wasFalling ? (player.fallStartY - plat.y) : 0;

          player.y = plat.y;
          player.vy = 0;
          player.grounded = true;
          player.onElevator = plat;
          player.wasFalling = false;
          player.fallStartY = plat.y;

          if (fallDist >= PLAYER_FALL_DAMAGE_THRESHOLD) {
            hurtPlayer(-player.facing, { isFallDamage: true, fromAbyss: false, label: 'FALL -1' });
            return;
          }
          break;
        }
      }
    }

    if (!landedOnSolidFloor && !player.onElevator) {
      player.grounded = false;
    }

    // ------------------------------------------------------------------------
    // 5) 奈落落下（75m Y < -1.0）＆ 最下段床抜け安全クランプ
    // ------------------------------------------------------------------------
    if (stageDef.hasAbyss) {
      if (player.y < ABYSS_Y) {
        hurtPlayer(-player.facing, { isFallDamage: true, fromAbyss: true, label: 'FALL -1' });
        return;
      }
    } else if (player.y < 0) {
      // 1F は常に地面（25m/50m/100m）
      const floor0 = stageDef.floors[0];
      const f0Y = floor0 ? getFloorY(floor0, player.x) : 0;
      const fallDist = player.wasFalling ? (player.fallStartY - f0Y) : 0;
      player.y = f0Y;
      player.vy = 0;
      player.grounded = true;
      player.currentFloorIdx = 0;
      player.wasFalling = false;
      player.fallStartY = f0Y;

      if (fallDist >= PLAYER_FALL_DAMAGE_THRESHOLD) {
        hurtPlayer(-player.facing, { isFallDamage: true, fromAbyss: false, label: 'FALL -1' });
        return;
      }
      tryRecordCurrentSafePoint(stageDef);
    }

    // 100m 杭穴の真上に立っていた場合は即座に穴へ落とす
    if (
      player.grounded &&
      !player.onElevator &&
      isPointOverPulledRivetHole(player.currentFloorIdx, player.x, entities.rivets)
    ) {
      player.grounded = false;
      player.wasFalling = true;
      player.fallStartY = player.y;
    }

    // 向き・アニメーション更新
    const targetRotY = player.facing > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    if (world3D.playerGroup) {
      world3D.playerGroup.rotation.y = expLerpAngle(world3D.playerGroup.rotation.y, targetRotY, 16, safeDt);
    }

    if (world3D.playerAnim && player.punchTimer <= 0) {
      if (!player.grounded) {
        // ジャンプ中は Jump モーションを維持
      } else if (player.isCrouching) {
        world3D.playerAnim.play('Sitting');
      } else if (Math.abs(player.vx) > 2.4) {
        world3D.playerAnim.play('Running', { timeScale: isPower ? 1.35 : 1.1 });
      } else if (Math.abs(player.vx) > 0.35) {
        world3D.playerAnim.play('Walking', { timeScale: 1.2 });
      } else {
        world3D.playerAnim.play('Idle');
      }
    }
  }

  // --------------------------------------------------------------------------
  // 6) 3D プレイヤー位置・無敵点滅・ハイパー電池オーラ同期
  // --------------------------------------------------------------------------
  if (world3D.playerGroup) {
    world3D.playerGroup.position.set(player.x, player.y, 0);
    if (player.invulnTimer > 0) {
      // 時間ベース点滅（120Hz 倍速防止）
      world3D.playerGroup.visible = Math.floor(player.invulnTimer * 18) % 2 === 0;
    } else {
      world3D.playerGroup.visible = true;
    }
  }

  if (world3D.playerAura) {
    world3D.playerAura.visible = isPower;
    if (isPower) {
      world3D.playerAura.rotation.y += safeDt * 4.5;
      world3D.playerAura.rotation.x += safeDt * 2.5;
    }
  }

  // --------------------------------------------------------------------------
  // 7) 100m 光る杭引き抜きチェック
  // --------------------------------------------------------------------------
  const punchBox = getPunchHitbox();
  checkPlayerRivetPull(punchBox);
  if (gameState.phase !== 'playing') return;

  // --------------------------------------------------------------------------
  // 8) オイル炉（炎）接触チェック（25m 1F左端 / 50m 3F中央）
  // --------------------------------------------------------------------------
  for (let i = 0; i < stageDef.furnaces.length; i++) {
    const fn = stageDef.furnaces[i];
    if (Math.abs(player.x - fn.x) < 0.56 && Math.abs((player.y + 0.45) - (fn.y + 0.65)) < 0.68) {
      hurtPlayer(player.x < fn.x ? -1 : 1, { label: 'HOT!' });
      return;
    }
  }

  // --------------------------------------------------------------------------
  // 9) 巨大ボス本体との接触チェック（全4ステージ対応）
  // --------------------------------------------------------------------------
  const bDef = stageDef.boss;
  if (bDef && bossCtrl.phase !== 'falling' && bossCtrl.phase !== 'defeated') {
    if (typeof bDef.hurtMinX === 'number') {
      // 25m / 75m：左端固定ボスの占有領域チェック
      if (
        player.currentFloorIdx === bDef.floorIdx &&
        player.x < bDef.hurtMinX &&
        Math.abs(player.y - bossCtrl.y) < 1.35
      ) {
        hurtPlayer(1);
        player.x = bDef.hurtMinX + 0.12;
        return;
      }
    } else {
      // 50m / 100m：巡回ボス本体との距離接触チェック
      if (Math.abs(player.x - bossCtrl.x) < 0.85 && Math.abs((player.y + 0.45) - (bossCtrl.y + 0.75)) < 1.15) {
        const pushDir = player.x < bossCtrl.x ? -1 : 1;
        hurtPlayer(pushDir);
        player.x = clampStageX(player.x + pushDir * 0.45, 0.35);
        return;
      }
    }
  }

  // --------------------------------------------------------------------------
  // 10) ゴール判定（25m / 50m / 75m 最上階ヒロイン到達）
  // --------------------------------------------------------------------------
  if (stageDef.clearCondition === 'reach_heroine' && stageDef.heroine) {
    const hr = stageDef.heroine;
    if (
      player.currentFloorIdx === hr.floorIdx &&
      Math.abs(player.x - hr.x) < (hr.goalRadius || 1.05) &&
      Math.abs(player.y - hr.y) < 1.0
    ) {
      triggerStageClear();
    }
  }
}

/* ============================================================================
 * 8. 余韻（Afterglow）専用アニメーション更新（GameOver / Clear / 100m Collapse）
 * ========================================================================== */

/**
 * ゲームオーバー余韻中のプレイヤー退避＆崩れ落ち演出更新
 * @param {number} dt 秒
 */
export function updatePlayerGameOverAnim(dt) {
  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  const stageDef = stageRuntime.stageDef;
  if (!stageDef || !world3D.playerGroup) return;

  world3D.playerGroup.visible = true;
  const fl = stageDef.floors[player.currentFloorIdx] || stageDef.floors[0];
  let minX = fl.xMin + 0.45;
  const maxX = fl.xMax - 0.45;
  if (stageDef.boss && stageDef.boss.floorIdx === fl.id && typeof stageDef.boss.hurtMinX === 'number') {
    minX = Math.max(minX, stageDef.boss.hurtMinX + 0.35);
  }

  player.x = expLerp(player.x, player.deathTargetX, 11, safeDt);
  if (minX < maxX) {
    player.x = clamp(player.x, minX, maxX);
  }

  const floorY = getFloorY(fl, player.x);
  player.vy -= 24.0 * safeDt;
  player.y += player.vy * safeDt;
  let onGround = false;
  if (player.y <= floorY) {
    player.y = floorY;
    player.vy = 0;
    onGround = true;
  }

  const nextZ = expLerp(world3D.playerGroup.position.z, player.deathZ, 9, safeDt);
  world3D.playerGroup.position.set(player.x, player.y, nextZ);

  // 近くに障害物が残っていれば奥＆外側へ退かしてダウン演出の被りを防止
  for (let i = 0; i < entities.barrels.length; i++) {
    const b = entities.barrels[i];
    if (!b.alive || !b.mesh) continue;
    const dx = b.x - player.x;
    if (Math.abs(dx) < 1.25 && Math.abs(b.y - player.y) < 1.5) {
      const push = dx >= 0 ? 1 : -1;
      b.x += push * safeDt * 2.2;
      b.mesh.position.x = b.x;
      b.mesh.position.z = expLerp(b.mesh.position.z, -0.35, 6, safeDt);
    }
  }
  for (let i = 0; i < entities.enemies.length; i++) {
    const en = entities.enemies[i];
    if (!en.alive || !en.mesh) continue;
    const dx = en.x - player.x;
    if (Math.abs(dx) < 1.25 && Math.abs(en.y - player.y) < 1.5) {
      const push = dx >= 0 ? 1 : -1;
      en.x += push * safeDt * 2.0;
      en.mesh.position.x = en.x;
      en.mesh.position.z = expLerp(en.mesh.position.z, -0.35, 6, safeDt);
    }
  }

  // 少し離れたタイミングで Death モーション開始
  player.deathDelay = Math.max(0, player.deathDelay - safeDt);
  if (
    !player.deathAnimStarted &&
    (player.deathDelay <= 0 || (onGround && Math.abs(player.x - player.deathTargetX) < 0.25))
  ) {
    player.deathAnimStarted = true;
    if (world3D.playerAnim) {
      world3D.playerAnim.play('Death', { loop: THREE.LoopOnce, timeScale: 0.9, fade: 0.08, force: true });
    }
  }

  const targetRotY = player.facing > 0 ? 0.35 : -0.35;
  world3D.playerGroup.rotation.y = expLerpAngle(world3D.playerGroup.rotation.y, targetRotY, 7, safeDt);

  // フォールバックモデル使用時も離れてからコテンと倒れる
  if (!world3D.playerAnim && player.deathAnimStarted) {
    world3D.playerGroup.rotation.z = expLerp(
      world3D.playerGroup.rotation.z,
      -player.facing * (Math.PI * 0.46),
      7,
      safeDt
    );
  }
}

/**
 * ステージクリア余韻中のヒロイン横並びダンス演出更新
 * @param {number} dt 秒
 */
export function updatePlayerStageClearAnim(dt) {
  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  const stageDef = stageRuntime.stageDef;
  const hr = stageDef ? stageDef.heroine : null;
  if (!hr || !world3D.playerGroup || !world3D.friendGroup) return;

  const targetPX = safeFinite(hr.clearPlayerX, hr.x - 0.85);
  const targetFX = safeFinite(hr.clearFriendX, hr.x + 0.25);

  player.x = expLerp(player.x, targetPX, 7, safeDt);
  player.y = expLerp(player.y, hr.y, 10, safeDt);

  world3D.playerGroup.position.set(
    player.x,
    player.y,
    expLerp(world3D.playerGroup.position.z, 0.08, 7, safeDt)
  );
  world3D.playerGroup.rotation.y = expLerpAngle(world3D.playerGroup.rotation.y, 0.15, 8, safeDt);

  world3D.friendGroup.position.x = expLerp(world3D.friendGroup.position.x, targetFX, 7, safeDt);
  world3D.friendGroup.position.z = expLerp(world3D.friendGroup.position.z, 0.08, 7, safeDt);
  world3D.friendGroup.rotation.y = expLerpAngle(world3D.friendGroup.rotation.y, -0.15, 8, safeDt);
}

/**
 * 100m 全杭抜き崩落余韻中のプレイヤー姿勢安定化
 * @param {number} dt 秒
 */
export function updatePlayerRivetCollapseAnim(dt) {
  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  if (!world3D.playerGroup) return;
  world3D.playerGroup.position.set(player.x, player.y, 0.06);
  world3D.playerGroup.rotation.y = expLerpAngle(world3D.playerGroup.rotation.y, 0, 8, safeDt);
}