/**
 * main.js
 * @version v1.0 (App Entry, Single rAF Fixed-Step Loop & 4-Stage Loop Progression - Phase 14)
 * @changes
 *   - 同期起動シーケンス（injectStyles() → mountDOM() → initWorld() → initInput() → bindAudioRecoveryEvents() → 8イベント安全タップ接続）を実装
 *   - 動的 import() 経由でも確実に即起動する document.readyState 判定と Layer 1 初期スピナーの 250ms フェードアウト除去を実装
 *   - requestAnimationFrame 単一保証・WebGL コンテキストロスト時のループ停止＆安全復帰・60Hz 基準固定タイムステップ統合ループを実装
 *   - 開始待機状態（isWaitingStart）の進行完全停止とリザルト完全静止後の省電力描画スキップ（リサイズ時1フレーム再描画）を実装
 *   - 4ステージ連続＆周回ループ進行（25m → 50m → 75m → 100m → 次周回 25m）・ゲームオーバー余韻リザルト・1タップ即リスタートを実装
 *   - resize / orientationchange / visualViewport 監視および初回起動次フレームの再レイアウト同期を実装
 *
 * Tier 4 統合エントリモジュール：全モジュール結線・メインゲームループ・ステージ／周回進行管理
 */

import {
  PHYSICS_SUBSTEPS,
  STAGE_META,
  ENABLE_DEBUG_TOOLS,
  getLoopDifficulty,
  clamp,
  safeFinite
} from './constants.js?v=1';

import { getStageDef } from './stages.js?v=1';

import {
  gameState,
  stageRuntime,
  entities,
  prepareStageState,
  initNewRunState
} from './world_state.js?v=1';

import { sound } from './audio.js?v=1';

import {
  initWorld,
  loadRobotCharacters,
  buildStageWorld,
  populateStageEntities,
  syncInitialCharacterTransforms,
  updateStageVisuals,
  updateParticles,
  updateCharacterAnimations,
  updateShadowCameraFollow,
  renderScene
} from './world.js?v=1';

import {
  snapCameraToStage,
  updateCamera
} from './camera.js?v=1';

import {
  stepFixedPhysics,
  resetPhysicsAccumulator
} from './physics.js?v=1';

import {
  registerPlayerCallbacks,
  updatePlayer,
  updatePlayerGameOverAnim,
  updatePlayerStageClearAnim,
  updatePlayerRivetCollapseAnim
} from './player_ctrl.js?v=1';

import {
  stepStageElevators,
  updateAllEntities,
  updateBossCollapseAnim
} from './entity.js?v=1';

import { injectStyles } from './style.js?v=1';

import {
  uiRefs,
  mountDOM,
  bindSafeTap,
  syncSoundButtonUI,
  updateHUD,
  showModal,
  hideModal,
  finishLoadingUI,
  showStageBanner,
  hideStageBanner,
  flushFloatTextQueue,
  clearFloatTexts,
  updateLayout
} from './dom_ui.js?v=1';

import {
  initInput,
  refreshInputRects,
  resetInputState
} from './input.js?v=1';

/* ============================================================================
 * 1. ループ・起動制御ステート（rAF 単一保証 ＆ リザルト静止省電力）
 * ========================================================================== */

let isAppBooted = false;
let animFrameId = null;
let lastFrameWallMs = 0;
let idleVisualSec = 0;
let isGameOverModalShown = false;
let orientationTimerId = null;

/** リザルト表示後に省電力静止へ移行するまでの安定待ち時間（秒） */
const RESULT_SETTLE_DELAY_SEC = 0.85;

/**
 * 現在時刻（ms）を安全に取得
 * @returns {number}
 */
function getNowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

/* ============================================================================
 * 2. Layer 1 初期スピナーの 250ms フェードアウト除去（第1章 1.4 準拠）
 * ========================================================================== */

/**
 * Layer 1（gravity_loader.html / index.html）の初期ローディングオーバーレイを安全にフェードアウト除去
 */
function dismissLoaderSplash() {
  if (typeof document === 'undefined') return;
  const splash =
    document.getElementById('loader-screen') ||
    document.getElementById('gravity-loader-splash');
  if (!splash || splash.dataset.dismissed === 'true') return;

  splash.dataset.dismissed = 'true';
  splash.style.transition = 'opacity 0.25s ease';
  splash.style.opacity = '0';
  splash.style.pointerEvents = 'none';

  window.setTimeout(() => {
    if (splash && splash.parentNode) {
      splash.parentNode.removeChild(splash);
    }
  }, 260);
}

/* ============================================================================
 * 3. ステージ 3D 構築・新規ラン開始・4ステージ＆周回ループ進行
 * ========================================================================== */

/**
 * 状態初期化済みの現在ステージに対して 3D 地形・エンティティ・キャラ・カメラを一括構築
 * @param {boolean} showBanner ステージ開始バナーを表示するか
 * @param {string} [customBannerSub=''] バナーのサブテキスト上書き
 */
function buildActiveStageScene(showBanner, customBannerSub = '') {
  const stageDef = getStageDef(gameState.stageIndex);
  const diff = getLoopDifficulty(gameState.loop);

  resetPhysicsAccumulator();
  resetInputState();
  clearFloatTexts();
  sound.resetRuntime();

  buildStageWorld(stageDef);
  populateStageEntities(stageDef, diff.fireballSpeedMul);
  syncInitialCharacterTransforms(stageDef);
  snapCameraToStage();
  updateShadowCameraFollow();
  updateHUD(true);

  if (showBanner) {
    showStageBanner(gameState.stageIndex, gameState.loop, customBannerSub);
  } else {
    hideStageBanner();
  }
}

/**
 * 新規ラン（1周目 25m・スコア 0・HP 満タン）を開始またはタイトル待機を構築
 * @param {boolean} startPlaying true で即時プレイ開始、false でタイトル待機表示
 */
function startNewGame(startPlaying = true) {
  isGameOverModalShown = false;
  initNewRunState(startPlaying);

  if (startPlaying) {
    hideModal(false);
  }

  buildActiveStageScene(startPlaying);

  if (startPlaying) {
    lastFrameWallMs = getNowMs();
    if (animFrameId === null && !gameState.isContextLost) {
      startMainLoop();
    }
  }
}

/**
 * 次ステージまたは次周回 25m へシームレスに遷移
 * @param {number} nextStageIndex 0..3
 * @param {number} nextLoop 1..N
 * @param {string} [customBannerSub='']
 */
function advanceToStage(nextStageIndex, nextLoop, customBannerSub = '') {
  isGameOverModalShown = false;
  hideModal(true);
  prepareStageState(nextStageIndex, nextLoop, 'playing');
  buildActiveStageScene(true, customBannerSub);
  lastFrameWallMs = getNowMs();
}

/**
 * 25m / 50m / 75m クリア余韻完了後の次ステージ自動遷移ハンドラ
 */
function handleStageClearAfterglow() {
  if (gameState.phase !== 'stage_clear') return;
  const nextStageIdx = gameState.stageIndex + 1;
  if (nextStageIdx < STAGE_META.length) {
    advanceToStage(nextStageIdx, gameState.loop);
  } else {
    advanceToStage(0, gameState.loop + 1, '周回クリア！難易度アップ！');
  }
}

/**
 * 100m 全8本杭抜き＆ボス大墜落余韻完了後の次周回 25m 遷移ハンドラ
 */
function handleRivetCollapseAfterglow() {
  if (gameState.phase !== 'rivet_collapse') return;
  const nextLoop = gameState.loop + 1;
  const subMsg = nextLoop >= 5
    ? '最高難易度 LOOP！HP+1回復！'
    : `LOOP ${nextLoop} 突入！HP+1回復・スピードUP！`;
  advanceToStage(0, nextLoop, subMsg);
}

/**
 * ゲームオーバー余韻完了後のリザルトモーダル表示ハンドラ
 */
function handleGameOverAfterglow() {
  if (gameState.phase !== 'gameover') return;
  isGameOverModalShown = true;
  gameState.resultSettleTimer = 0;

  const meta = STAGE_META[gameState.stageIndex] || STAGE_META[0];
  let tipHtml =
    'トゲ敵は<strong class="hl-amber">パンチ</strong>、鉄タルは<strong class="hl-sky">ジャンプ</strong>でかわそう！<br>' +
    '光る木箱の電池を取ると無敵パンチ＆スコア2倍！';

  if (meta.index === 1) {
    tipHtml =
      '50mは<strong class="hl-sky">反転コンベア</strong>の警告音と<strong class="hl-amber">伸縮はしご</strong>のタイミングが鍵！<br>' +
      '中央の電池を取って一気に突破しよう！';
  } else if (meta.index === 2) {
    tipHtml =
      '75mは<strong class="hl-sky">昇降リフト</strong>を焦らず乗り継ぎ、5Fの<strong class="hl-amber">ジャッキ</strong>を跳び越えよう！<br>' +
      '高い足場からの落下ダメージにも注意！';
  } else if (meta.index === 3) {
    tipHtml =
      '100mは全8本の<strong class="hl-amber">光る杭</strong>をすべて抜くとクリア！<br>' +
      '抜いた穴は敵も越えられないのでルート作りに活かそう！';
  }

  showModal({
    badge: 'GAME OVER',
    title: 'ダウンしてしまった！',
    descHtml: tipHtml,
    btnText: 'もう一度チャレンジ！',
    showStats: true,
    showGuide: false
  });
}

/* ============================================================================
 * 4. 固定サブステップ実行 ＆ 単一 rAF メインループ（第4章 4.1〜4.2 厳守）
 * ========================================================================== */

/**
 * 60Hz 基準の固定物理サブステップ（エレベーター → プレイヤー → 全ギミック＆敵）
 * @param {number} subDtSec 固定サブステップ秒
 */
function runPhysicsSubStep(subDtSec) {
  if (gameState.phase !== 'playing' || gameState.isWaitingStart) return;
  stepStageElevators();
  updatePlayer(subDtSec);
  if (gameState.phase !== 'playing') return;
  updateAllEntities(subDtSec);
}

/**
 * 単一 requestAnimationFrame ループ本体
 * @param {number} nowMs
 */
function mainLoop(nowMs) {
  animFrameId = null;

  if (gameState.isContextLost) {
    return;
  }

  animFrameId = window.requestAnimationFrame(mainLoop);

  const safeNow = safeFinite(nowMs, getNowMs());
  if (lastFrameWallMs <= 0) {
    lastFrameWallMs = safeNow;
  }
  const deltaMs = Math.max(0, safeNow - lastFrameWallMs);
  lastFrameWallMs = safeNow;

  // リザルト完全静止省電力モード（第5章 5.2 準拠：全演出終了後は不要な毎フレーム描画をスキップ）
  if (gameState.phase === 'gameover' && gameState.isResultSettled) {
    return;
  }

  const visDt = clamp(deltaMs * 0.001, 0, 0.05);

  // ヒットストップ中は物理進行を止め、描画のみ維持して打撃手応えを出す
  if (gameState.hitstopTimer > 0) {
    gameState.hitstopTimer = Math.max(0, gameState.hitstopTimer - visDt);
    updateCamera(visDt * 0.35);
    renderScene();
    return;
  }

  // --------------------------------------------------------------------------
  // フェーズ別進行ディスパッチ
  // --------------------------------------------------------------------------
  if (gameState.phase === 'playing' && !gameState.isWaitingStart) {
    // 60Hz 基準固定タイムステップ駆動（仮想時計 simTimeSec を実実行分のみ進行）
    stepFixedPhysics(deltaMs, runPhysicsSubStep, PHYSICS_SUBSTEPS, true);

    updateStageVisuals(visDt, gameState.simTimeSec);
    updateParticles(visDt);
    updateCharacterAnimations(visDt);
    updateCamera(visDt);
  } else if (gameState.isWaitingStart || gameState.phase === 'title' || gameState.phase === 'loading') {
    // 開始待機状態の進行停止原則（第3章 3.4）：物理・入力・タイマー停止、背景アイドルのみ描画
    idleVisualSec += visDt;
    updateStageVisuals(visDt, idleVisualSec);
    updateCharacterAnimations(visDt);
    updateCamera(visDt);
  } else if (gameState.phase === 'stage_clear') {
    idleVisualSec += visDt;
    updatePlayerStageClearAnim(visDt);
    updateStageVisuals(visDt, gameState.simTimeSec + idleVisualSec);
    updateParticles(visDt);
    updateCharacterAnimations(visDt);
    updateCamera(visDt);
  } else if (gameState.phase === 'rivet_collapse') {
    idleVisualSec += visDt;
    updateBossCollapseAnim(visDt);
    updatePlayerRivetCollapseAnim(visDt);
    updateStageVisuals(visDt, gameState.simTimeSec + idleVisualSec);
    updateParticles(visDt);
    updateCharacterAnimations(visDt);
    updateCamera(visDt);
  } else if (gameState.phase === 'gameover') {
    updatePlayerGameOverAnim(visDt);
    updateParticles(visDt);
    updateCharacterAnimations(visDt);
    updateCamera(visDt);

    // リザルト表示済みかつパーティクル消滅後に完全静止省電力へ移行
    if (isGameOverModalShown && entities.particles.length === 0) {
      gameState.resultSettleTimer += visDt;
      if (gameState.resultSettleTimer >= RESULT_SETTLE_DELAY_SEC) {
        gameState.isResultSettled = true;
      }
    }
  }

  updateShadowCameraFollow();
  flushFloatTextQueue();
  updateHUD(false);
  renderScene();
}

/**
 * 単一保証されたメインループを停止
 */
function stopMainLoop() {
  if (animFrameId !== null) {
    window.cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

/**
 * 単一保証されたメインループを開始（二重起動を物理遮断）
 */
function startMainLoop() {
  stopMainLoop();
  lastFrameWallMs = getNowMs();
  animFrameId = window.requestAnimationFrame(mainLoop);
}

/* ============================================================================
 * 5. リサイズ ＆ レイアウト同期監視（第7章 7.2 準拠）
 * ========================================================================== */

/**
 * レイアウト再計算＋入力Rectキャッシュ更新＋省電力静止中の1フレーム再描画
 */
function handleLayoutResize() {
  updateLayout({
    onAfterResize: (sizeChanged) => {
      refreshInputRects();
      if (sizeChanged) {
        resetInputState();
      }
      if (gameState.isResultSettled && !gameState.isContextLost) {
        updateCamera(0.016);
        renderScene();
      }
    }
  });
}

/**
 * 画面リサイズ・回転・visualViewport・キーボード blur の監視を単一登録
 */
function bindLayoutListeners() {
  window.addEventListener('resize', handleLayoutResize);

  window.addEventListener('orientationchange', () => {
    if (orientationTimerId !== null) {
      window.clearTimeout(orientationTimerId);
    }
    orientationTimerId = window.setTimeout(() => {
      orientationTimerId = null;
      handleLayoutResize();
    }, 150);
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleLayoutResize);
    window.visualViewport.addEventListener('scroll', handleLayoutResize);
  }

  // 万一テキスト入力から抜けた際の iOS スクロールズレ復帰（第7章 7.2 準拠）
  window.addEventListener('focusout', () => {
    window.scrollTo(0, 0);
    handleLayoutResize();
  });

  // WebView 起動直後のレイアウト確定ズレ対策：次フレームで1回追加同期
  window.requestAnimationFrame(handleLayoutResize);
}

/* ============================================================================
 * 6. アプリケーション起動シーケンス（自律 DOM マウント順序厳守）
 * ========================================================================== */

/**
 * アプリ全体を同期初期化し、GLTF ロード完了後にタイトル画面を操作可能にする
 */
function bootApplication() {
  if (isAppBooted) return;
  isAppBooted = true;

  // デバッグ3層遮断確認（ENABLE_DEBUG_TOOLS === false のためデバッグ要素・イベントは一切生成しない）
  if (ENABLE_DEBUG_TOOLS) {
    console.info('[Main] Debug tools enabled.');
  }

  // 1) 最優先同期マウント：必ず injectStyles() → mountDOM() の順で実行（第1章 1.4 厳守）
  injectStyles();
  mountDOM();

  // 2) 画面レイアウト初期同期
  handleLayoutResize();

  // 3) 3D ワールド構築（WebGL コンテキストロスト防護コールバック接続）
  initWorld(uiRefs.canvasContainer, {
    onContextLost: () => {
      stopMainLoop();
      resetInputState();
      sound.stopAllLoops();
    },
    onContextRestored: () => {
      resetPhysicsAccumulator();
      handleLayoutResize();
      if (stageRuntime.stageDef) {
        populateStageEntities(stageRuntime.stageDef, getLoopDifficulty(gameState.loop).fireballSpeedMul);
        syncInitialCharacterTransforms(stageRuntime.stageDef);
      }
      snapCameraToStage();
      startMainLoop();
    }
  });

  // 4) 入力・iOS ジェスチャーマスク・Web Audio 5経路自動復旧バインド
  initInput();
  sound.bindRecovery();
  syncSoundButtonUI(sound.isEnabled());

  // 5) プレイヤー遷移コールバック結線
  registerPlayerCallbacks({
    onGameOverAfterglow: handleGameOverAfterglow,
    onStageClearAfterglow: handleStageClearAfterglow,
    onRivetCollapseAfterglow: handleRivetCollapseAfterglow,
    onForceReleaseInput: resetInputState
  });

  // 6) UI ボタンへ 8イベント安全タップ規格を接続
  bindSafeTap(
    uiRefs.btnSound,
    () => {
      const nextOn = sound.toggle();
      syncSoundButtonUI(nextOn);
    },
    { debounceMs: 220 }
  );

  bindSafeTap(uiRefs.btnQuickReset, () => {
    startNewGame(true);
  });

  bindSafeTap(uiRefs.btnStart, () => {
    startNewGame(true);
  });

  // 7) レスポンシブリサイズ監視開始
  bindLayoutListeners();

  // 8) タイトル待機用の 1周目 25m 高層タワー背景を先行構築し、ループ開始＆スピナー除去
  initNewRunState(false);
  buildActiveStageScene(false);
  startMainLoop();
  dismissLoaderSplash();

  // 9) 3D ロボットモデル（GLTF）を非同期ロード（8.5秒タイムアウト＆フォールバック完全保護）
  loadRobotCharacters(() => {
    syncInitialCharacterTransforms(getStageDef(gameState.stageIndex));
    snapCameraToStage();
    finishLoadingUI();
    handleLayoutResize();
  });
}

// 動的 import() 経由では DOMContentLoaded 発火済みのため readyState で即時起動（第1章 1.4 厳守）
if (typeof document !== 'undefined') {
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    bootApplication();
  } else {
    document.addEventListener('DOMContentLoaded', bootApplication, { once: true });
  }
}