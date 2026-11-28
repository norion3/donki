/**
 * entity.js
 * @version v1.0 (All-4-Stage Gimmicks, Boss AI, Enemies, Fireballs & Bonus Timer - Phase 10)
 * @changes
 *   - 25m 6層ボスの4段階タル転がし演出（掴む→持ち上げ→投下）、タル転がり・はしご直下落下・1Fオイル炉点火を実装
 *   - 50m 反転コンベア制御＆警告音、エネルギー缶生成・落下・炉点火、ボス往復巡回を実装
 *   - 75m 循環エレベーター固定物理更新、バウンドジャッキ発射・放物線跳躍・飛び越えボーナス・ハイパー粉砕を実装
 *   - 100m 8本杭の脈動演出、ボス中央威嚇巡回、全杭抜き後のボス約12m大墜落＆着地衝撃演出を実装
 *   - 共通エンティティ（巡回敵・トゲ敵・はしご昇降対応の火の玉ボットAI・木箱＆ハイパー電池/コイン回収・ボーナス制限時間カウントダウン）を実装
 *   - 全エンティティ配列の O(1) スワップ削除（swapRemoveAt）・仮想時計ベース演出・周回難易度スケーリングを徹底
 *
 * Tier 3 業務モジュール：全4ステージのギミック・ボス・敵・アイテム・制限時間の統合更新
 */

import {
  PLAYER_STOMP_VY,
  POWER_UP_DURATION,
  SCORE_VALUES,
  BONUS_TIMER_STEP,
  BONUS_TIMER_INTERVAL_SEC,
  getLoopDifficulty,
  clamp,
  lerp,
  safeFinite
} from './constants.js?v=1';

import {
  getFloorY,
  getFloorSlopeDir,
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
  entities,
  swapRemoveAt,
  addScore,
  enqueueFloatText
} from './world_state.js?v=1';

import { sound } from './audio.js?v=1';
import { THREE, createBarrelMesh } from './materials.js?v=1';
import {
  world3D,
  spawnParticles,
  removeEntityMesh,
  spawnBarrelEntity,
  spawnFireballEntity,
  spawnEnergyCanEntity,
  spawnJackEntity,
  spawnPickupEntity,
  updateElevatorPlatforms
} from './world.js?v=1';

import {
  expLerp,
  expLerpAngle,
  intersectsPointBox2D
} from './physics.js?v=1';

import {
  getPunchHitbox,
  hurtPlayer,
  triggerTimeoutHit
} from './player_ctrl.js?v=1';

/* ============================================================================
 * 1. ボーナス制限時間 ＆ ハイパー電池タイマー更新（固定物理ステップ同期）
 * ========================================================================== */

/**
 * ハイパー電池残り時間とアーケード準拠ボーナス制限時間（BONUS）を仮想時計刻みで更新
 * @param {number} dt 秒（固定サブステップ）
 */
function updateStageTimers(dt) {
  gameState.elapsedStageSec += dt;

  // ハイパー電池パワータイマー
  if (gameState.powerTimer > 0) {
    gameState.powerTimer = Math.max(0, gameState.powerTimer - dt);
    gameState.hudDirty = true;
  }

  // ボーナス制限時間カウントダウン（1.8秒ごとに 100 減少、0 でタイムアウト1ダメージ）
  if (gameState.bonusTimer > 0) {
    gameState.bonusTickAccum += dt;
    while (gameState.bonusTickAccum >= BONUS_TIMER_INTERVAL_SEC) {
      gameState.bonusTickAccum -= BONUS_TIMER_INTERVAL_SEC;
      gameState.bonusTimer = Math.max(0, gameState.bonusTimer - BONUS_TIMER_STEP);
      gameState.hudDirty = true;

      if (gameState.bonusTimer <= 0) {
        triggerTimeoutHit();
        // 残HPで継続する場合は緊急再充填（1000）で再起可能にする
        if (gameState.phase === 'playing') {
          gameState.bonusTimer = 1000;
          gameState.bonusTickAccum = 0;
          gameState.hudDirty = true;
        }
        return;
      }
    }
  }
}

/* ============================================================================
 * 2. 巨大ボス AI ＆ 全4ステージ固有行動（タル投下 / 巡回 / ジャッキ投下 / 杭防衛）
 * ========================================================================== */

/**
 * 25m：4段階タル転がし演出（待機 → タル山から掴む → 持ち上げ → 押し出し転がし）
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} diff 周回難易度設定
 */
function updateBossBarrelThrower(dt, stageDef, diff) {
  const bDef = stageDef.boss;
  const bossFloor = stageDef.floors[bDef.floorIdx];
  const bossBaseX = bossCtrl.x;
  const bossBaseY = bossCtrl.y;
  const stackTopX = -4.56;
  const stackTopY = getFloorY(bossFloor, stackTopX) + 1.05;

  if (bossCtrl.phase === 'idle') {
    bossCtrl.rotY = expLerpAngle(bossCtrl.rotY, Math.PI * 0.42, 8, dt);
    if (world3D.bossGroup) world3D.bossGroup.rotation.y = bossCtrl.rotY;

    bossCtrl.spawnTimer -= dt;
    if (bossCtrl.spawnTimer <= 0) {
      bossCtrl.phase = 'grab';
      bossCtrl.timer = 0;
      bossCtrl.released = false;
      bossCtrl.nextIsIron = Math.random() < diff.ironRatio;

      if (bossCtrl.heldMesh) {
        removeEntityMesh(bossCtrl.heldMesh);
        bossCtrl.heldMesh = null;
      }
      const held = createBarrelMesh(bossCtrl.nextIsIron);
      held.position.set(stackTopX, stackTopY, 0.05);
      held.scale.setScalar(0.85);
      if (world3D.entityGroup) world3D.entityGroup.add(held);
      bossCtrl.heldMesh = held;

      if (bossCtrl.nextIsIron) {
        spawnParticles(stackTopX, stackTopY + 0.2, 0.2, 0x38bdf8, 8, 3.2);
      }
      if (world3D.bossAnim) {
        world3D.bossAnim.play('Walking', { timeScale: 1.2 });
      }
    }
    return;
  }

  bossCtrl.timer += dt;

  if (bossCtrl.phase === 'grab') {
    const p = clamp(bossCtrl.timer / 0.34, 0, 1);
    bossCtrl.rotY = expLerpAngle(bossCtrl.rotY, -Math.PI * 0.42, 14, dt);
    if (world3D.bossGroup) world3D.bossGroup.rotation.y = bossCtrl.rotY;

    if (bossCtrl.heldMesh) {
      const targetX = bossBaseX - 0.65;
      const targetY = bossBaseY + 1.05;
      bossCtrl.heldMesh.position.set(
        lerp(stackTopX, targetX, p),
        lerp(stackTopY, targetY, p),
        lerp(0.05, 0.42, p)
      );
      bossCtrl.heldMesh.scale.setScalar(lerp(0.85, 1.0, p));
    }
    if (p >= 1) {
      bossCtrl.phase = 'lift';
      bossCtrl.timer = 0;
    }
  } else if (bossCtrl.phase === 'lift') {
    const p = clamp(bossCtrl.timer / 0.42, 0, 1);
    bossCtrl.rotY = expLerpAngle(bossCtrl.rotY, Math.PI * 0.46, 11, dt);
    if (world3D.bossGroup) world3D.bossGroup.rotation.y = bossCtrl.rotY;

    if (bossCtrl.heldMesh) {
      const arcAngle = lerp(Math.PI, 0.12, p);
      const radius = 0.72;
      bossCtrl.heldMesh.position.set(
        bossBaseX + Math.cos(arcAngle) * radius,
        bossBaseY + 1.1 + Math.sin(p * Math.PI) * 0.48,
        Math.sin(arcAngle) * 0.45
      );
      bossCtrl.heldMesh.rotation.z -= dt * 3.5;
    }
    if (p >= 1) {
      bossCtrl.phase = 'throw';
      bossCtrl.timer = 0;
      if (world3D.bossAnim) {
        world3D.bossAnim.play('Punch', {
          loop: THREE.LoopOnce,
          timeScale: 1.45,
          fade: 0.05,
          force: true
        });
      }
    }
  } else if (bossCtrl.phase === 'throw') {
    if (!bossCtrl.released && bossCtrl.timer >= 0.11) {
      bossCtrl.released = true;
      const relX = bossBaseX + 0.92;
      const relY = bossBaseY + 1.0;

      if (bossCtrl.heldMesh) {
        removeEntityMesh(bossCtrl.heldMesh);
        bossCtrl.heldMesh = null;
      }

      sound.playPunch();
      spawnParticles(relX, relY, 0.15, bossCtrl.nextIsIron ? 0x38bdf8 : 0xfbbf24, 7, 3.6);
      const baseVx = (bossCtrl.nextIsIron ? 3.45 : 2.95) * diff.barrelSpeedMul;
      spawnBarrelEntity(bossCtrl.nextIsIron, relX, relY, baseVx, 1.5, bDef.floorIdx, true);
    } else if (!bossCtrl.released && bossCtrl.heldMesh) {
      bossCtrl.heldMesh.position.x += dt * 2.4;
      bossCtrl.heldMesh.position.y -= dt * 0.8;
    }

    if (bossCtrl.timer >= 0.42) {
      bossCtrl.phase = 'idle';
      bossCtrl.timer = 0;
      if (world3D.bossAnim) world3D.bossAnim.play('Idle');
      bossCtrl.spawnTimer = Math.max(
        diff.barrelIntervalMin,
        diff.barrelIntervalBase - gameState.elapsedStageSec * 0.012
      );
    }
  }
}

/**
 * 50m / 100m：ボス巡回行動（左右往復＋100m威嚇）
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} diff
 */
function updateBossPatrol(dt, stageDef, diff) {
  const bDef = stageDef.boss;
  const fl = stageDef.floors[bDef.floorIdx];
  if (!fl) return;

  const speed = safeFinite(bDef.speed, 1.2) * (0.9 + diff.barrelSpeedMul * 0.15);
  bossCtrl.x += bossCtrl.dir * speed * dt;

  if (bossCtrl.x >= bDef.patrolMax) {
    bossCtrl.x = bDef.patrolMax;
    bossCtrl.dir = -1;
  } else if (bossCtrl.x <= bDef.patrolMin) {
    bossCtrl.x = bDef.patrolMin;
    bossCtrl.dir = 1;
  }

  bossCtrl.y = getFloorY(fl, bossCtrl.x);
  const targetRotY = bossCtrl.dir > 0 ? Math.PI * 0.35 : -Math.PI * 0.35;
  bossCtrl.rotY = expLerpAngle(bossCtrl.rotY, targetRotY, 8, dt);

  if (world3D.bossGroup) {
    world3D.bossGroup.position.set(bossCtrl.x, bossCtrl.y, 0);
    world3D.bossGroup.rotation.y = bossCtrl.rotY;
  }
}

/**
 * 75m：5F 左端からバウンドジャッキを発射するボス行動
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} diff
 */
function updateBossJackThrower(dt, stageDef, diff) {
  const spawner = stageDef.jackSpawner;
  if (!spawner) return;

  bossCtrl.rotY = expLerpAngle(bossCtrl.rotY, Math.PI * 0.44, 8, dt);
  if (world3D.bossGroup) world3D.bossGroup.rotation.y = bossCtrl.rotY;

  stageRuntime.jackSpawnTimer -= dt;
  if (stageRuntime.jackSpawnTimer <= 0) {
    const fl = stageDef.floors[spawner.floorIdx];
    const startY = getFloorY(fl, spawner.startX) + 0.55;
    const vx = spawner.speed * diff.jackSpeedMul;
    const vy = spawner.bounceVy;

    spawnJackEntity(spawner.startX, startY, vx, vy, spawner.floorIdx);
    sound.playPunch();
    spawnParticles(spawner.startX, startY, 0.15, 0xfde047, 7, 3.5);

    if (world3D.bossAnim) {
      world3D.bossAnim.play('Punch', {
        loop: THREE.LoopOnce,
        timeScale: 1.5,
        fade: 0.05,
        force: true
      });
    }

    stageRuntime.jackSpawnTimer = Math.max(
      0.95,
      diff.jackInterval - gameState.elapsedStageSec * 0.008
    );
  }
}

/**
 * ボス行動ディスパッチャ
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} diff
 */
function updateBoss(dt, stageDef, diff) {
  if (bossCtrl.mode === 'barrel_thrower') {
    updateBossBarrelThrower(dt, stageDef, diff);
  } else if (bossCtrl.mode === 'patrol_boss' || bossCtrl.mode === 'rivet_boss') {
    updateBossPatrol(dt, stageDef, diff);
  } else if (bossCtrl.mode === 'jack_thrower') {
    updateBossJackThrower(dt, stageDef, diff);
  }
}

/**
 * 100m 全8本杭抜き完了後のボス約12m大墜落＆着地衝撃演出（rivet_collapse フェーズ専用）
 * @param {number} dt 秒
 */
export function updateBossCollapseAnim(dt) {
  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  if (!world3D.bossGroup) return;

  if (bossCtrl.collapseDelay > 0) {
    bossCtrl.collapseDelay = Math.max(0, bossCtrl.collapseDelay - safeDt);
    // 墜落直前のガタガタ震え
    const jitter = Math.sin(gameState.simTimeSec * 45.0) * 0.09;
    world3D.bossGroup.position.set(bossCtrl.x + jitter, bossCtrl.y, 0);
    return;
  }

  if (!bossCtrl.collapseLanded) {
    bossCtrl.vy -= 21.0 * safeDt;
    bossCtrl.y += bossCtrl.vy * safeDt;
    world3D.bossGroup.rotation.z += safeDt * 4.2;

    if (bossCtrl.y <= 0.0) {
      bossCtrl.y = 0.0;
      bossCtrl.vy = 0;
      bossCtrl.collapseLanded = true;
      bossCtrl.phase = 'defeated';
      gameState.shakeTimer = 0.36;

      world3D.bossGroup.rotation.z = Math.PI; // 頭から真っ逆さまに激突
      sound.playSmash();
      spawnParticles(bossCtrl.x, 0.4, 0, 0xdc2626, 26, 7.2);
      spawnParticles(bossCtrl.x, 0.4, 0, 0xfef08a, 18, 6.2);

      if (world3D.bossAnim) {
        world3D.bossAnim.play('Death', { loop: THREE.LoopOnce, force: true });
      }
    }
    world3D.bossGroup.position.set(bossCtrl.x, bossCtrl.y, 0);
  }
}

/* ============================================================================
 * 3. 25m タル更新（転がり・はしご直下落下・オイル炉点火・パンチ/跳躍/接触）
 * ========================================================================== */

/**
 * 25m ステージのタル更新（逆順走査＋O(1)スワップ削除）
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} diff
 * @param {object} punchBox
 */
function updateBarrels(dt, stageDef, diff, punchBox) {
  if (entities.barrels.length === 0) return;
  const isPower = gameState.powerTimer > 0;
  const speedMul = diff.barrelSpeedMul;

  for (let i = entities.barrels.length - 1; i >= 0; i--) {
    const b = entities.barrels[i];
    if (!b.alive) {
      removeEntityMesh(b.mesh);
      swapRemoveAt(entities.barrels, i);
      continue;
    }

    if (b.dropBounce) {
      b.vy -= 18.0 * dt;
      b.x += b.vx * 0.85 * dt;
      b.y += b.vy * dt;
      if (b.mesh) b.mesh.rotation.z -= (b.vx / 0.36) * dt;

      const fl = stageDef.floors[b.floorIdx];
      const floorY = getFloorY(fl, b.x) + 0.36;
      if (b.y <= floorY) {
        b.y = floorY;
        b.vy = 0;
        b.dropBounce = false;
        sound.playBarrelDrop(b.id);
        spawnParticles(b.x, b.y - 0.3, 0.1, b.isIron ? 0x7dd3fc : 0xe2e8f0, 7, 3.0);
      }
    } else if (b.onLadderDrop) {
      b.vy -= 14.5 * dt;
      b.y += b.vy * dt;
      if (b.mesh) b.mesh.rotation.x += dt * 8.0;

      const targetFl = stageDef.floors[b.floorIdx - 1];
      if (targetFl) {
        const targetY = getFloorY(targetFl, b.x) + 0.36;
        if (b.y <= targetY) {
          b.y = targetY;
          b.vy = 0;
          b.floorIdx -= 1;
          b.onLadderDrop = false;
          b.lastLadder = null;
          const dir = getFloorSlopeDir(targetFl) || 1;
          b.vx = dir * (b.isIron ? 3.55 : 3.05) * speedMul;
          sound.playBarrelDrop(b.id);
        }
      } else {
        b.alive = false;
      }
    } else if (b.falling) {
      b.vy -= 19.0 * dt;
      b.x += b.vx * 0.32 * dt;
      b.y += b.vy * dt;
      const nextFl = stageDef.floors[b.floorIdx - 1];
      if (nextFl) {
        const ny = getFloorY(nextFl, b.x) + 0.36;
        if (b.y <= ny) {
          b.y = ny;
          b.vy = 0;
          b.floorIdx -= 1;
          b.falling = false;
          b.lastLadder = null;
          const dir = getFloorSlopeDir(nextFl) || 1;
          b.vx = dir * (b.isIron ? 3.6 : 3.15) * speedMul;
        }
      } else if (b.y < -2.0) {
        b.alive = false;
      }
    } else {
      const fl = stageDef.floors[b.floorIdx];
      const slopeDir = getFloorSlopeDir(fl) || 1;
      b.vx = slopeDir * (b.isIron ? 3.6 : 3.1) * speedMul;
      b.x += b.vx * dt;
      b.y = getFloorY(fl, b.x) + 0.36;
      if (b.mesh) b.mesh.rotation.z -= (b.vx / 0.36) * dt;

      // はしご直下落下判定（同一はしごにつき1回のみ抽選：フレームレート完全非依存）
      if (b.floorIdx > 0) {
        const ladders = stageDef.ladders;
        for (let l = 0; l < ladders.length; l++) {
          const lad = ladders[l];
          if (lad.toFloor !== b.floorIdx) continue;
          if (Math.abs(b.x - lad.x) < 0.14) {
            if (b.lastLadder !== lad) {
              b.lastLadder = lad;
              const dropChance = b.isIron ? 0.30 : 0.20;
              if (Math.random() < dropChance) {
                b.onLadderDrop = true;
                b.x = lad.x;
                b.vy = -1.6;
                break;
              }
            }
          }
        }
      }

      // 1F 左端のオイル炉へ到達 → タル消滅＆火の玉ボット点火
      if (b.floorIdx === 0 && stageDef.furnaces.length > 0) {
        const furnace = stageDef.furnaces[0];
        if (b.x <= furnace.x + 0.35) {
          b.alive = false;
          spawnParticles(furnace.x, furnace.y + 0.95, 0.1, 0xf97316, 12, 4.8);
          if (entities.fireballs.length < diff.fireballMax) {
            spawnFireballEntity(0, furnace.x + 0.35, stageDef, diff.fireballSpeedMul);
          }
        }
      }

      // フロア端到達処理
      if (
        b.alive &&
        ((slopeDir > 0 && b.x > fl.xMax - 0.14) || (slopeDir < 0 && b.x < fl.xMin + 0.14))
      ) {
        if (b.floorIdx === 0) {
          b.alive = false;
        } else {
          b.falling = true;
          b.vy = -0.5;
        }
      }
    }

    if (!b.alive) {
      removeEntityMesh(b.mesh);
      swapRemoveAt(entities.barrels, i);
      continue;
    }

    if (b.mesh) b.mesh.position.set(b.x, b.y, 0);

    // 1) パンチとの衝突判定
    if (punchBox.active && intersectsPointBox2D(b.x, b.y, punchBox.x, punchBox.y, punchBox.rx, punchBox.ry)) {
      if (!b.isIron || isPower) {
        removeEntityMesh(b.mesh);
        swapRemoveAt(entities.barrels, i);
        sound.playSmash();
        gameState.hitstopTimer = 0.045;
        gameState.shakeTimer = 0.12;
        spawnParticles(b.x, b.y, 0, b.isIron ? 0x38bdf8 : 0xd97706, 16, 6.2);
        const pts = b.isIron ? SCORE_VALUES.SMASH_IRON_BARREL : SCORE_VALUES.SMASH_WOOD_BARREL;
        addScore(
          pts,
          b.x,
          b.y,
          b.isIron ? `IRON SMASH! +${pts}` : `SMASH! +${pts}`,
          b.isIron ? 'yellow' : 'amber'
        );
        continue;
      } else {
        sound.playClang();
        spawnParticles(b.x, b.y, 0.2, 0x7dd3fc, 6, 4.0);
        enqueueFloatText(b.x, b.y + 0.32, 'HARD!', 'sky');
        player.punchTimer = 0;
        player.vx = -player.facing * 3.4;
      }
    }

    // 2) ジャンプ飛び越えボーナス
    if (!b.jumpedOver && !player.grounded && !player.onLadder) {
      if (Math.abs(player.x - b.x) < 0.56 && player.y > b.y + 0.24 && player.y < b.y + 1.95) {
        b.jumpedOver = true;
        sound.playBonus();
        const bonus = b.isIron ? SCORE_VALUES.JUMP_IRON_BARREL : SCORE_VALUES.JUMP_WOOD_BARREL;
        addScore(bonus, player.x, player.y + 0.32, `JUMP! +${bonus}`, 'sky');
      }
    }

    // 3) プレイヤー本体との接触判定
    const dx = Math.abs(player.x - b.x);
    const dy = Math.abs((player.y + 0.45) - b.y);
    if (dx < 0.52 && dy < 0.52) {
      if (isPower) {
        removeEntityMesh(b.mesh);
        swapRemoveAt(entities.barrels, i);
        sound.playSmash();
        spawnParticles(b.x, b.y, 0, 0xfacc15, 14, 6.0);
        addScore(SCORE_VALUES.POWER_RAM_BARREL, b.x, b.y, `POWER! +${SCORE_VALUES.POWER_RAM_BARREL}`, 'yellow');
        continue;
      } else {
        hurtPlayer(player.x < b.x ? -1 : 1);
        if (gameState.phase !== 'playing') return;
      }
    }
  }
}

/* ============================================================================
 * 4. 50m 反転コンベア ＆ エネルギー缶更新
 * ========================================================================== */

/**
 * 50m 反転コンベアの方向切替・警告音およびエネルギー缶のスポーン・移動・接触を更新
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} diff
 * @param {object} punchBox
 */
function updateConveyorsAndCans(dt, stageDef, diff, punchBox) {
  // 1) コンベア反転タイマー＆警告音
  const conveyors = stageRuntime.conveyorStates;
  for (let i = 0; i < conveyors.length; i++) {
    const cs = conveyors[i];
    cs.timer -= dt;
    const enteringWarn = !cs.isWarning && cs.timer <= cs.warnSec;
    cs.isWarning = cs.timer <= cs.warnSec;

    if (enteringWarn) {
      sound.playConveyorWarn();
    }

    if (cs.timer <= 0) {
      cs.dir *= -1;
      cs.timer = cs.reverseInterval;
      cs.isWarning = false;
    }
  }

  // 2) エネルギー缶スポーナー
  const spawners = stageRuntime.canSpawnTimers;
  for (let i = 0; i < spawners.length; i++) {
    const sp = spawners[i];
    sp.timer -= dt;
    if (sp.timer <= 0) {
      sp.timer = sp.interval;
      if (entities.cans.length < 7) {
        let dir = 1;
        for (let c = 0; c < conveyors.length; c++) {
          if (conveyors[c].floorIdx === sp.floorIdx) {
            dir = conveyors[c].dir;
            break;
          }
        }
        const fl = stageDef.floors[sp.floorIdx];
        if (fl) {
          const spawnX = dir > 0 ? fl.xMin + 0.42 : fl.xMax - 0.42;
          spawnEnergyCanEntity(sp.floorIdx, spawnX, dir, sp.speed, stageDef);
        }
      }
    }
  }

  // 3) エネルギー缶移動・オイル炉点火・判定
  if (entities.cans.length === 0) return;
  const isPower = gameState.powerTimer > 0;

  for (let i = entities.cans.length - 1; i >= 0; i--) {
    const can = entities.cans[i];
    if (!can.alive) {
      removeEntityMesh(can.mesh);
      swapRemoveAt(entities.cans, i);
      continue;
    }

    if (can.falling) {
      can.vy -= 18.0 * dt;
      can.y += can.vy * dt;
      const lowerFl = stageDef.floors[can.floorIdx - 1];
      if (lowerFl) {
        const ly = getFloorY(lowerFl, can.x);
        if (can.y <= ly) {
          can.y = ly;
          can.vy = 0;
          can.floorIdx -= 1;
          can.falling = false;
          // 3F(中央炉フロア)へ降りた缶は中央オイル炉方向へ滑らせる
          if (can.floorIdx === 2) {
            can.dir = can.x >= 0 ? -1 : 1;
          }
        }
      } else if (can.y < -1.5) {
        can.alive = false;
      }
    } else {
      const fl = stageDef.floors[can.floorIdx];
      let moveVx = can.dir * can.speed;
      for (let c = 0; c < conveyors.length; c++) {
        if (conveyors[c].floorIdx === can.floorIdx) {
          can.dir = conveyors[c].dir;
          moveVx = conveyors[c].dir * Math.max(can.speed, conveyors[c].speed);
          break;
        }
      }

      can.x += moveVx * dt;
      can.y = getFloorY(fl, can.x);

      // 3F 中央オイル炉到達 → 消滅＋火の玉ボット点火
      if (stageDef.furnaces.length > 0) {
        for (let f = 0; f < stageDef.furnaces.length; f++) {
          const fn = stageDef.furnaces[f];
          if (can.floorIdx === fn.floorIdx && Math.abs(can.x - fn.x) < 0.45) {
            can.alive = false;
            spawnParticles(fn.x, fn.y + 0.95, 0.1, 0xf97316, 12, 4.6);
            if (entities.fireballs.length < diff.fireballMax) {
              spawnFireballEntity(fn.floorIdx, fn.x + (Math.random() < 0.5 ? -0.5 : 0.5), stageDef, diff.fireballSpeedMul);
            }
            break;
          }
        }
      }

      if (can.alive && (can.x < fl.xMin + 0.16 || can.x > fl.xMax - 0.16)) {
        if (can.floorIdx > 0) {
          can.x = clamp(can.x, fl.xMin + 0.25, fl.xMax - 0.25);
          can.falling = true;
          can.vy = -0.6;
        } else {
          can.alive = false;
        }
      }
    }

    if (!can.alive) {
      removeEntityMesh(can.mesh);
      swapRemoveAt(entities.cans, i);
      continue;
    }

    if (can.mesh) {
      can.mesh.position.set(can.x, can.y, 0);
      can.mesh.rotation.y += dt * 3.0;
    }

    // パンチ破壊
    if (punchBox.active && intersectsPointBox2D(can.x, can.y + 0.34, punchBox.x, punchBox.y, punchBox.rx, punchBox.ry)) {
      removeEntityMesh(can.mesh);
      swapRemoveAt(entities.cans, i);
      sound.playSmash();
      gameState.hitstopTimer = 0.04;
      gameState.shakeTimer = 0.10;
      spawnParticles(can.x, can.y + 0.35, 0, 0xf97316, 14, 5.8);
      addScore(SCORE_VALUES.SMASH_CAN, can.x, can.y + 0.35, `SMASH! +${SCORE_VALUES.SMASH_CAN}`, 'amber');
      continue;
    }

    // ジャンプ飛び越えボーナス
    if (!can.jumpedOver && !player.grounded && !player.onLadder) {
      if (Math.abs(player.x - can.x) < 0.54 && player.y > can.y + 0.38 && player.y < can.y + 2.0) {
        can.jumpedOver = true;
        sound.playBonus();
        addScore(SCORE_VALUES.JUMP_CAN, player.x, player.y + 0.32, `JUMP! +${SCORE_VALUES.JUMP_CAN}`, 'sky');
      }
    }

    // プレイヤー接触判定
    if (Math.abs(player.x - can.x) < 0.50 && Math.abs((player.y + 0.42) - (can.y + 0.34)) < 0.50) {
      if (isPower) {
        removeEntityMesh(can.mesh);
        swapRemoveAt(entities.cans, i);
        sound.playSmash();
        spawnParticles(can.x, can.y + 0.35, 0, 0xfacc15, 14, 5.8);
        addScore(SCORE_VALUES.POWER_RAM_BARREL, can.x, can.y + 0.35, `POWER! +${SCORE_VALUES.POWER_RAM_BARREL}`, 'yellow');
        continue;
      } else {
        hurtPlayer(player.x < can.x ? -1 : 1);
        if (gameState.phase !== 'playing') return;
      }
    }
  }
}

/* ============================================================================
 * 5. 75m バウンドジャッキ更新（放物線跳躍・右端落下・飛び越え・ハイパー粉砕）
 * ========================================================================== */

/**
 * 75m 5F 回廊を跳ね飛ぶバウンドジャッキを更新
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} punchBox
 */
function updateJacks(dt, stageDef, punchBox) {
  if (entities.jacks.length === 0) return;
  const spawner = stageDef.jackSpawner;
  const fl = spawner ? stageDef.floors[spawner.floorIdx] : null;
  const isPower = gameState.powerTimer > 0;

  for (let i = entities.jacks.length - 1; i >= 0; i--) {
    const jk = entities.jacks[i];
    if (!jk.alive) {
      removeEntityMesh(jk.mesh);
      swapRemoveAt(entities.jacks, i);
      continue;
    }

    if (jk.dropping) {
      jk.vy -= 21.0 * dt;
      jk.y += jk.vy * dt;
      if (jk.y < -1.8) {
        removeEntityMesh(jk.mesh);
        swapRemoveAt(entities.jacks, i);
        continue;
      }
    } else {
      jk.vy -= 17.5 * dt;
      jk.x += jk.vx * dt;
      jk.y += jk.vy * dt;

      if (fl) {
        const floorY = getFloorY(fl, jk.x);
        if (jk.y <= floorY && jk.vy < 0) {
          jk.y = floorY;
          jk.vy = spawner ? spawner.bounceVy : 6.4;
          sound.playBarrelDrop(`jk_${i}`);
        }
      }

      if (spawner && jk.x >= spawner.dropEdgeX) {
        jk.dropping = true;
        jk.vx = 0;
        jk.vy = -2.2;
      }
    }

    if (jk.mesh) {
      jk.mesh.position.set(jk.x, jk.y, 0);
      // 跳躍速度に応じたバネ伸縮アニメーション
      const stretchY = clamp(1.0 + jk.vy * 0.045, 0.72, 1.32);
      jk.mesh.scale.set(1 / Math.sqrt(stretchY), stretchY, 1 / Math.sqrt(stretchY));
    }

    // パンチ判定（通常は弾かれ、ハイパー電池中なら粉砕可能）
    if (punchBox.active && intersectsPointBox2D(jk.x, jk.y + 0.36, punchBox.x, punchBox.y, punchBox.rx, punchBox.ry)) {
      if (isPower) {
        removeEntityMesh(jk.mesh);
        swapRemoveAt(entities.jacks, i);
        sound.playSmash();
        gameState.hitstopTimer = 0.045;
        gameState.shakeTimer = 0.12;
        spawnParticles(jk.x, jk.y + 0.35, 0, 0xfde047, 16, 6.2);
        addScore(SCORE_VALUES.SMASH_JACK, jk.x, jk.y + 0.35, `JACK SMASH! +${SCORE_VALUES.SMASH_JACK}`, 'yellow');
        continue;
      } else {
        sound.playClang();
        spawnParticles(jk.x, jk.y + 0.35, 0.2, 0xf43f5e, 6, 4.0);
        enqueueFloatText(jk.x, jk.y + 0.55, 'HARD!', 'rose');
        player.punchTimer = 0;
        player.vx = -player.facing * 3.4;
      }
    }

    // ジャンプ飛び越えボーナス
    if (!jk.jumpedOver && !player.grounded && !player.onLadder) {
      if (Math.abs(player.x - jk.x) < 0.62 && player.y > jk.y + 0.38 && player.y < jk.y + 2.2) {
        jk.jumpedOver = true;
        sound.playBonus();
        addScore(SCORE_VALUES.JUMP_JACK, player.x, player.y + 0.35, `JUMP! +${SCORE_VALUES.JUMP_JACK}`, 'sky');
      }
    }

    // プレイヤー接触判定
    if (Math.abs(player.x - jk.x) < 0.50 && Math.abs((player.y + 0.45) - (jk.y + 0.36)) < 0.52) {
      if (isPower) {
        removeEntityMesh(jk.mesh);
        swapRemoveAt(entities.jacks, i);
        sound.playSmash();
        spawnParticles(jk.x, jk.y + 0.35, 0, 0xfacc15, 16, 6.0);
        addScore(SCORE_VALUES.SMASH_JACK, jk.x, jk.y + 0.35, `POWER! +${SCORE_VALUES.SMASH_JACK}`, 'yellow');
        continue;
      } else {
        hurtPlayer(player.x < jk.x ? -1 : 1);
        if (gameState.phase !== 'playing') return;
      }
    }
  }
}

/* ============================================================================
 * 6. 巡回敵（walker）＆ トゲ敵（spiky）更新
 * ========================================================================== */

/**
 * ステージ配置の巡回敵・トゲ敵を更新（100m 杭穴手前での自動反転付き）
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} diff
 * @param {object} punchBox
 */
function updateEnemies(dt, stageDef, diff, punchBox) {
  if (entities.enemies.length === 0) return;
  const isPower = gameState.powerTimer > 0;
  const speedScale = 0.92 + diff.barrelSpeedMul * 0.08;
  const t = gameState.simTimeSec;

  for (let i = entities.enemies.length - 1; i >= 0; i--) {
    const en = entities.enemies[i];
    if (!en.alive) {
      removeEntityMesh(en.mesh);
      swapRemoveAt(entities.enemies, i);
      continue;
    }

    const fl = stageDef.floors[en.floorIdx];
    if (!fl) continue;

    let minPatrolX = fl.xMin + 0.55;
    const maxPatrolX = fl.xMax - 0.55;
    if (stageDef.boss && stageDef.boss.floorIdx === en.floorIdx && typeof stageDef.boss.hurtMinX === 'number') {
      minPatrolX = Math.max(minPatrolX, stageDef.boss.hurtMinX + 0.45);
    }

    const nextX = en.x + en.dir * en.speed * speedScale * dt;
    // 端または 100m の抜かれた杭穴の手前で反転
    const hitRivetHole = isPointOverPulledRivetHole(en.floorIdx, nextX + en.dir * 0.28, entities.rivets);
    if (hitRivetHole) {
      en.dir *= -1;
    } else if (nextX >= maxPatrolX) {
      en.x = maxPatrolX;
      en.dir = -1;
    } else if (nextX <= minPatrolX) {
      en.x = minPatrolX;
      en.dir = 1;
    } else {
      en.x = nextX;
    }

    en.y = getFloorY(fl, en.x);
    if (en.mesh) {
      en.mesh.position.set(en.x, en.y + Math.abs(Math.sin(t * 8.0 + i)) * 0.08, 0);
      en.mesh.rotation.y = en.dir > 0 ? 0.4 : -0.4;
    }

    // 1) パンチ撃破
    if (punchBox.active && intersectsPointBox2D(en.x, en.y + 0.45, punchBox.x, punchBox.y, punchBox.rx, punchBox.ry)) {
      removeEntityMesh(en.mesh);
      swapRemoveAt(entities.enemies, i);
      sound.playSmash();
      gameState.hitstopTimer = 0.05;
      gameState.shakeTimer = 0.14;
      spawnParticles(en.x, en.y + 0.4, 0, en.type === 'spiky' ? 0xc084fc : 0x34d399, 18, 6.5);
      const pts = en.type === 'spiky' ? SCORE_VALUES.KO_SPIKY : SCORE_VALUES.KO_WALKER;
      addScore(pts, en.x, en.y + 0.35, `KO! +${pts}`, 'amber');
      continue;
    }

    // 2) プレイヤー接触・踏みつけ判定
    const dx = Math.abs(player.x - en.x);
    const dy = (player.y + 0.35) - (en.y + 0.40);
    if (dx < 0.60 && Math.abs(dy) < 0.56) {
      const isStomp = player.vy < -0.5 && player.y > en.y + 0.30;
      if (isPower) {
        removeEntityMesh(en.mesh);
        swapRemoveAt(entities.enemies, i);
        sound.playSmash();
        spawnParticles(en.x, en.y + 0.4, 0, 0xfacc15, 16, 6.0);
        addScore(SCORE_VALUES.POWER_RAM_ENEMY, en.x, en.y + 0.35, `POWER KO! +${SCORE_VALUES.POWER_RAM_ENEMY}`, 'yellow');
        continue;
      } else if (isStomp && en.type === 'walker') {
        removeEntityMesh(en.mesh);
        swapRemoveAt(entities.enemies, i);
        player.vy = PLAYER_STOMP_VY;
        player.wasFalling = false;
        player.fallStartY = player.y;
        sound.playStomp();
        gameState.hitstopTimer = 0.04;
        spawnParticles(en.x, en.y + 0.3, 0, 0x34d399, 14, 5.5);
        addScore(SCORE_VALUES.STOMP_WALKER, en.x, en.y + 0.5, `STOMP! +${SCORE_VALUES.STOMP_WALKER}`, 'emerald');
        continue;
      } else {
        if (isStomp && en.type === 'spiky') {
          enqueueFloatText(en.x, en.y + 0.85, 'トゲ！パンチで撃破', 'purple');
        }
        hurtPlayer(player.x < en.x ? -1 : 1);
        if (gameState.phase !== 'playing') return;
      }
    }
  }
}

/* ============================================================================
 * 7. 火の玉ボット（Fireball）追跡 AI 更新（はしご昇降・100m 杭穴手前反転）
 * ========================================================================== */

/**
 * 全4ステージ共通の火の玉ボット（おじゃま虫）補充＆追跡AIを更新
 * @param {number} dt
 * @param {object} stageDef
 * @param {object} diff
 * @param {object} punchBox
 */
function updateFireballs(dt, stageDef, diff, punchBox) {
  // 定期補充（オイル炉点火専用でないステージでも周回上限まで補充）
  const fbCfg = stageDef.fireballConfig;
  if (
    fbCfg &&
    !fbCfg.spawnFromFurnace &&
    Array.isArray(fbCfg.spawnPositions) &&
    fbCfg.spawnPositions.length > 0 &&
    entities.fireballs.length < diff.fireballMax
  ) {
    stageRuntime.fireballSpawnTimer -= dt;
    if (stageRuntime.fireballSpawnTimer <= 0) {
      stageRuntime.fireballSpawnTimer = Math.max(4.5, 8.5 - gameState.loop * 0.7);
      const pos = fbCfg.spawnPositions[entities.fireballs.length % fbCfg.spawnPositions.length];
      // プレイヤーの目の前への理不尽出現を回避
      const fl = stageDef.floors[pos.floorIdx];
      const py = fl ? getFloorY(fl, pos.x) : 0;
      if (Math.hypot(player.x - pos.x, player.y - py) > 2.2) {
        spawnFireballEntity(pos.floorIdx, pos.x, stageDef, diff.fireballSpeedMul);
        spawnParticles(pos.x, py + 0.4, 0, 0xf97316, 10, 4.2);
      }
    }
  }

  if (entities.fireballs.length === 0) return;
  const isPower = gameState.powerTimer > 0;
  const simTimeSec = gameState.simTimeSec;

  for (let i = entities.fireballs.length - 1; i >= 0; i--) {
    const fb = entities.fireballs[i];
    if (!fb.alive) {
      removeEntityMesh(fb.mesh);
      swapRemoveAt(entities.fireballs, i);
      continue;
    }

    if (fb.ladderCooldown > 0) {
      fb.ladderCooldown = Math.max(0, fb.ladderCooldown - dt);
    }

    if (fb.onLadder) {
      const lad = fb.onLadder;
      const topConnected = isLadderConnectedToTop(lad, simTimeSec);
      fb.x = expLerp(fb.x, lad.x, 12, dt);
      fb.y += fb.climbDir * (fb.speed * 0.92) * dt;

      if (lad.retractable && !topConnected && fb.climbDir > 0) {
        const curTop = getLadderCurrentTopY(lad, simTimeSec);
        if (fb.y >= curTop - 0.25) {
          fb.climbDir = -1;
        }
      }

      if (fb.climbDir > 0 && fb.y >= lad.yTop) {
        fb.y = lad.yTop;
        fb.floorIdx = lad.toFloor;
        fb.onLadder = null;
        fb.ladderCooldown = 2.0;
        fb.dir = player.x >= fb.x ? 1 : -1;
      } else if (fb.climbDir < 0 && fb.y <= lad.yBottom) {
        fb.y = lad.yBottom;
        fb.floorIdx = lad.fromFloor;
        fb.onLadder = null;
        fb.ladderCooldown = 2.0;
        fb.dir = player.x >= fb.x ? 1 : -1;
      }
    } else {
      const fl = stageDef.floors[fb.floorIdx];
      if (!fl) {
        fb.alive = false;
        removeEntityMesh(fb.mesh);
        swapRemoveAt(entities.fireballs, i);
        continue;
      }

      let minX = fl.xMin + 0.42;
      const maxX = fl.xMax - 0.42;
      if (stageDef.boss && stageDef.boss.floorIdx === fb.floorIdx && typeof stageDef.boss.hurtMinX === 'number') {
        minX = Math.max(minX, stageDef.boss.hurtMinX + 0.35);
      }

      const nextX = fb.x + fb.dir * fb.speed * dt;
      // 100m 抜かれた杭穴は火の玉も越えられない（戦略的隔離が可能）
      const blockedByHole = isPointOverPulledRivetHole(fb.floorIdx, nextX + fb.dir * 0.26, entities.rivets);
      const blockedBySolid = !isSolidFloorAt(fl, nextX, entities.rivets, stageRuntime.isCollapsed, -0.20);

      if (blockedByHole || blockedBySolid) {
        fb.dir *= -1;
      } else if (nextX >= maxX) {
        fb.x = maxX;
        fb.dir = -1;
      } else if (nextX <= minX) {
        fb.x = minX;
        fb.dir = 1;
      } else {
        fb.x = nextX;
      }
      fb.y = getFloorY(fl, fb.x);

      // ゴールバルコニー最上階へは登らないようにしつつ、プレイヤー階へ向かうはしごを選択
      const goalFloorIdx = stageDef.heroine ? stageDef.heroine.floorIdx : -1;
      if (fb.ladderCooldown <= 0) {
        const ladders = stageDef.ladders;
        for (let l = 0; l < ladders.length; l++) {
          const lad = ladders[l];
          if (Math.abs(fb.x - lad.x) >= 0.12) continue;

          // 上へ登る判定
          if (
            lad.fromFloor === fb.floorIdx &&
            lad.toFloor !== goalFloorIdx &&
            isLadderConnectedToTop(lad, simTimeSec)
          ) {
            const wantUp = player.y > fb.y + 0.8 ? 0.55 : 0.14;
            if (Math.random() < wantUp) {
              fb.onLadder = lad;
              fb.climbDir = 1;
              fb.x = lad.x;
              break;
            } else {
              fb.ladderCooldown = 0.65;
            }
          }
          // 下へ降りる判定
          else if (lad.toFloor === fb.floorIdx && isLadderConnectedToTop(lad, simTimeSec)) {
            const wantDown = player.y < fb.y - 0.8 ? 0.50 : 0.12;
            if (Math.random() < wantDown) {
              fb.onLadder = lad;
              fb.climbDir = -1;
              fb.x = lad.x;
              break;
            } else {
              fb.ladderCooldown = 0.65;
            }
          }
        }
      }
    }

    if (fb.mesh) {
      const bob = Math.abs(Math.sin(simTimeSec * 9.5 + i * 1.3)) * 0.12;
      fb.mesh.position.set(fb.x, fb.y + bob, 0);
      fb.mesh.rotation.y = fb.dir > 0 ? 0.35 : -0.35;
      const outer = fb.mesh.getObjectByName('fireball-outer');
      if (outer) {
        outer.rotation.y = simTimeSec * 4.8 + i;
        outer.rotation.x = simTimeSec * 3.1;
      }
    }

    // 1) パンチ判定（ハイパー電池中のみ粉砕可能、通常パンチは弾かれて警告）
    if (punchBox.active && intersectsPointBox2D(fb.x, fb.y + 0.40, punchBox.x, punchBox.y, punchBox.rx, punchBox.ry)) {
      if (isPower) {
        removeEntityMesh(fb.mesh);
        swapRemoveAt(entities.fireballs, i);
        sound.playSmash();
        gameState.hitstopTimer = 0.045;
        gameState.shakeTimer = 0.12;
        spawnParticles(fb.x, fb.y + 0.4, 0, 0xf97316, 16, 6.2);
        addScore(SCORE_VALUES.SMASH_FIREBALL, fb.x, fb.y + 0.4, `EXTINGUISH! +${SCORE_VALUES.SMASH_FIREBALL}`, 'yellow');
        continue;
      } else {
        sound.playClang();
        spawnParticles(fb.x, fb.y + 0.4, 0.2, 0xf97316, 6, 3.8);
        enqueueFloatText(fb.x, fb.y + 0.72, 'HOT!', 'rose');
        player.punchTimer = 0;
        player.vx = -player.facing * 3.2;
      }
    }

    // 2) ジャンプ飛び越えボーナス
    if (!fb.jumpedOver && !player.grounded && !player.onLadder) {
      if (Math.abs(player.x - fb.x) < 0.56 && player.y > fb.y + 0.35 && player.y < fb.y + 2.0) {
        fb.jumpedOver = true;
        sound.playBonus();
        addScore(SCORE_VALUES.JUMP_FIREBALL, player.x, player.y + 0.35, `JUMP! +${SCORE_VALUES.JUMP_FIREBALL}`, 'sky');
      }
    }

    // 3) プレイヤー本体との接触判定
    if (Math.abs(player.x - fb.x) < 0.52 && Math.abs((player.y + 0.42) - (fb.y + 0.38)) < 0.52) {
      if (isPower) {
        removeEntityMesh(fb.mesh);
        swapRemoveAt(entities.fireballs, i);
        sound.playSmash();
        spawnParticles(fb.x, fb.y + 0.4, 0, 0xfacc15, 16, 6.0);
        addScore(SCORE_VALUES.SMASH_FIREBALL, fb.x, fb.y + 0.4, `POWER! +${SCORE_VALUES.SMASH_FIREBALL}`, 'yellow');
        continue;
      } else {
        hurtPlayer(player.x < fb.x ? -1 : 1, { label: 'BURN!' });
        if (gameState.phase !== 'playing') return;
      }
    }
  }
}

/* ============================================================================
 * 8. 100m 杭の脈動ビジュアル・木箱破壊・電池＆コイン回収
 * ========================================================================== */

/**
 * 100m 未引き抜きボルト杭の発光脈動を更新（時間ベース）
 */
function updateRivetsVisual() {
  if (entities.rivets.length === 0) return;
  const t = gameState.simTimeSec;
  for (let i = 0; i < entities.rivets.length; i++) {
    const r = entities.rivets[i];
    if (r.pulled || !r.mesh) continue;
    const glow = r.mesh.getObjectByName('rivet-glow');
    if (glow) {
      const s = 0.92 + Math.sin(t * 6.5 + i * 0.8) * 0.14;
      glow.scale.set(s, s, 1);
      glow.rotation.z = t * 2.2 + i;
    }
  }
}

/**
 * 木箱破壊（パンチまたはハイパー電池接触）と電池／コイン回収を更新
 * @param {number} dt
 * @param {object} punchBox
 */
function updateCratesAndPickups(dt, punchBox) {
  const t = gameState.simTimeSec;
  const isPower = gameState.powerTimer > 0;

  // 1) 木箱
  for (let i = entities.crates.length - 1; i >= 0; i--) {
    const cr = entities.crates[i];
    if (!cr.alive) {
      removeEntityMesh(cr.mesh);
      swapRemoveAt(entities.crates, i);
      continue;
    }

    if (cr.hasBattery && cr.mesh) {
      cr.mesh.position.y = cr.y + Math.sin(t * 5.0 + i) * 0.04;
    }

    const hitByPunch =
      punchBox.active &&
      intersectsPointBox2D(cr.x, cr.y + 0.40, punchBox.x, punchBox.y, punchBox.rx, punchBox.ry);
    const hitByPowerRam =
      isPower &&
      Math.abs(player.x - cr.x) < 0.65 &&
      Math.abs((player.y + 0.42) - (cr.y + 0.40)) < 0.65;

    if (hitByPunch || hitByPowerRam) {
      const spawnX = cr.x;
      const spawnY = cr.y;
      const kind = cr.hasBattery ? 'battery' : 'coin';

      removeEntityMesh(cr.mesh);
      swapRemoveAt(entities.crates, i);

      sound.playSmash();
      gameState.hitstopTimer = 0.035;
      spawnParticles(spawnX, spawnY + 0.4, 0, 0xb45309, 14, 5.5);
      addScore(SCORE_VALUES.CRATE_BREAK, spawnX, spawnY + 0.35, `BREAK! +${SCORE_VALUES.CRATE_BREAK}`, 'amber');
      spawnPickupEntity(kind, spawnX, spawnY);
    }
  }

  // 2) ピックアップ（ハイパー電池／コイン）
  for (let i = entities.pickups.length - 1; i >= 0; i--) {
    const pk = entities.pickups[i];
    if (pk.collected) {
      removeEntityMesh(pk.mesh);
      swapRemoveAt(entities.pickups, i);
      continue;
    }

    if (pk.mesh) {
      pk.mesh.rotation.y += dt * 3.2;
      pk.mesh.position.y = pk.y + Math.sin(t * 4.5 + pk.x) * 0.10;
    }

    if (Math.abs(player.x - pk.x) < 0.72 && Math.abs(player.y - pk.y) < 0.88) {
      const kind = pk.kind;
      const px = pk.x;
      const py = pk.y;
      removeEntityMesh(pk.mesh);
      swapRemoveAt(entities.pickups, i);

      if (kind === 'battery') {
        gameState.powerTimer = POWER_UP_DURATION;
        gameState.hudDirty = true;
        sound.playPowerUp();
        spawnParticles(px, py + 0.5, 0, 0xfacc15, 22, 6.5);
        addScore(SCORE_VALUES.BATTERY, px, py + 0.55, 'HYPER PUNCH!', 'yellow', false);
      } else {
        sound.playBonus();
        spawnParticles(px, py + 0.5, 0, 0xfde047, 10, 4.5);
        addScore(SCORE_VALUES.COIN, px, py + 0.42, `+${SCORE_VALUES.COIN}`, 'yellow');
      }
    }
  }
}

/* ============================================================================
 * 9. 統合更新エントリ（固定物理サブステップから毎ステップ呼び出し）
 * ========================================================================== */

/**
 * 75m 循環エレベーターをプレイヤー物理より先に更新する専用フック
 * （プレイヤーの乗車追従と前フレーム位置差分 prevY を厳密一致させるため分離）
 */
export function stepStageElevators() {
  if (stageRuntime.elevatorPlatforms.length === 0) return;
  const diff = getLoopDifficulty(gameState.loop);
  const elevSpeedMul = 0.92 + diff.conveyorSpeedMul * 0.08;
  updateElevatorPlatforms(gameState.simTimeSec, elevSpeedMul);
}

/**
 * 全4ステージのタイマー・ボス・タル・コンベア＆缶・ジャッキ・敵・火の玉・杭・木箱＆アイテムを一括更新
 * @param {number} dt 秒（固定サブステップ幅）
 */
export function updateAllEntities(dt) {
  if (gameState.phase !== 'playing') return;
  const stageDef = stageRuntime.stageDef;
  if (!stageDef) return;

  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  if (safeDt <= 0) return;

  const diff = getLoopDifficulty(gameState.loop);
  const punchBox = getPunchHitbox();

  updateStageTimers(safeDt);
  if (gameState.phase !== 'playing') return;

  updateBoss(safeDt, stageDef, diff);
  updateBarrels(safeDt, stageDef, diff, punchBox);
  if (gameState.phase !== 'playing') return;

  updateConveyorsAndCans(safeDt, stageDef, diff, punchBox);
  if (gameState.phase !== 'playing') return;

  updateJacks(safeDt, stageDef, punchBox);
  if (gameState.phase !== 'playing') return;

  updateEnemies(safeDt, stageDef, diff, punchBox);
  if (gameState.phase !== 'playing') return;

  updateFireballs(safeDt, stageDef, diff, punchBox);
  if (gameState.phase !== 'playing') return;

  updateRivetsVisual();
  updateCratesAndPickups(safeDt, punchBox);
}