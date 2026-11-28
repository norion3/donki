/**
 * input.js
 * @version v1.0 (iOS Gesture Mask, Single-Finger Floating Jog & Safe Multi-Touch Input - Phase 13)
 * @changes
 *   - マスター設計書v5.0.0（第7章 7.1）準拠の iPhone 誤拡大・長押し・300ms ダブルタップ遮断（button / [role="button"] / input / textarea / canvas 除外）を実装
 *   - 左側絶縁フローティング仮想ジョグ（activeTouchId 単一指追跡・リサイズ＆開始時のみ getBoundingClientRect() キャッシュ・5px デッドゾーン＋非線形カーブ m^1.5・4方向ドット連動）を実装
 *   - 右手ジャンプ／パンチボタンの独立指IDマルチタッチ制御（同時押し完全保証・押下フィードバック）を実装
 *   - touchcancel / window.blur / visibilitychange(hidden) / pagehide 時の誤発射防止安全キャンセルおよびグローバル指0本フェイルセーフを実装
 *   - 開始待機状態（isWaitingStart）および非プレイ中の入力遮断、PC 確認用キーボード入力（INPUT/TEXTAREA 除外）、一括状態初期化 resetInputState() を実装
 *
 * Tier 4 入力モジュール：iOS WebKit 最適化マルチタッチ入力・ジェスチャー遮断・安全キャンセル制御
 */

import { clamp, safeFinite } from './constants.js?v=1';
import {
  gameState,
  inputState,
  resetInputFields
} from './world_state.js?v=1';
import {
  uiRefs,
  setJogDotsState
} from './dom_ui.js?v=1';

/* ============================================================================
 * 1. 定数・内部ステート・Rect キャッシュ（ドラッグ中リフロー撲滅：第7章 7.4）
 * ========================================================================== */

/** 仮想ジョグのデッドゾーン（px）および非線形カーブ指数（m^1.5） */
const JOG_DEADZONE_PX = 5.0;
const JOG_CURVE_EXP = 1.5;

/** タッチ直後のゴーストマウスイベント遮断窓（ms） */
const GHOST_MOUSE_GUARD_MS = 550;

/** 二重初期化防止フラグ */
let isInputInitialized = false;

/** 最後にタッチイベントを受け取った時刻（ゴーストマウス抑止用） */
let lastTouchTimeMs = 0;

/** 各操作系の独立アクティブ追跡ID（単一指追跡・マルチタッチ干渉防止） */
let jogTouchId = null;
let jogMouseActive = false;
let jumpTouchId = null;
let jumpMouseActive = false;
let punchTouchId = null;
let punchMouseActive = false;

/** 仮想ジョグの現在出力・フローティング原点 */
let jogOriginX = 0;
let jogOriginY = 0;
let jogMoveX = 0;
let jogMoveY = 0;

/** getBoundingClientRect() キャッシュ（リサイズ時およびドラッグ開始時のみ更新） */
const jogRectCache = {
  left: 0,
  top: 0,
  width: 144,
  height: 112,
  baseSize: 98,
  knobSize: 42,
  maxRadius: 39,
  valid: false
};

/** PC 確認用キーボード押下状態 */
const keyPressedMap = Object.create(null);

/* ============================================================================
 * 2. 内部ヘルパー（プレイ可否・ゴーストマウス判定・方向合成）
 * ========================================================================== */

/**
 * 現在ゲーム操作を受け付けて良い状態か判定（第3章 3.4：開始待機状態の進行停止原則）
 * @returns {boolean}
 */
function canAcceptGameplayInput() {
  return !gameState.isWaitingStart && gameState.phase === 'playing';
}

/**
 * タッチ直後のゴーストマウスイベントかを判定
 * @returns {boolean}
 */
function isGhostMouseEvent() {
  return (Date.now() - lastTouchTimeMs) < GHOST_MOUSE_GUARD_MS;
}

/**
 * テキスト入力要素へフォーカス中か判定（キーボード奪取防止）
 * @returns {boolean}
 */
function isTextInputFocused() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable === true;
}

/**
 * 仮想ジョグ値とキーボード値から最終的な inputState.moveX / moveY を同期
 */
function syncDirectionalInput() {
  if (!canAcceptGameplayInput()) {
    inputState.moveX = 0;
    inputState.moveY = 0;
    setJogDotsState(0, 0);
    return;
  }

  let mx = 0;
  let my = 0;

  if (jogTouchId !== null || jogMouseActive) {
    mx = jogMoveX;
    my = jogMoveY;
  } else {
    if (keyPressedMap.ArrowLeft || keyPressedMap.KeyA) mx -= 1;
    if (keyPressedMap.ArrowRight || keyPressedMap.KeyD) mx += 1;
    if (keyPressedMap.ArrowUp || keyPressedMap.KeyW) my += 1;
    if (keyPressedMap.ArrowDown || keyPressedMap.KeyS) my -= 1;
  }

  inputState.moveX = clamp(safeFinite(mx, 0), -1, 1);
  inputState.moveY = clamp(safeFinite(my, 0), -1, 1);
  setJogDotsState(inputState.moveX, inputState.moveY);
}

/* ============================================================================
 * 3. getBoundingClientRect() キャッシュ更新（第7章 7.4 厳守）
 * ========================================================================== */

/**
 * 仮想ジョグ領域の座標・半径キャッシュを更新する
 * ※リサイズ時（updateLayout 完了後）およびジョグ開始時のみ呼び出し、move 中は一切呼ばない
 */
export function refreshInputRects() {
  const zone = uiRefs.jogZone;
  if (!zone) {
    jogRectCache.valid = false;
    return;
  }

  const rect = zone.getBoundingClientRect();
  const baseEl = uiRefs.jogBase;
  const knobEl = uiRefs.jogKnob;

  const baseSize = (baseEl && baseEl.offsetWidth > 0) ? baseEl.offsetWidth : 98;
  const knobSize = (knobEl && knobEl.offsetWidth > 0) ? knobEl.offsetWidth : 42;

  jogRectCache.left = safeFinite(rect.left, 0);
  jogRectCache.top = safeFinite(rect.top, 0);
  jogRectCache.width = Math.max(60, safeFinite(rect.width, 144));
  jogRectCache.height = Math.max(60, safeFinite(rect.height, 112));
  jogRectCache.baseSize = baseSize;
  jogRectCache.knobSize = knobSize;
  jogRectCache.maxRadius = Math.max(24, (baseSize - knobSize) * 0.5 + 11);
  jogRectCache.valid = true;
}

/* ============================================================================
 * 4. 仮想ジョグ操作（開始・移動・終了・安全キャンセル）
 * ========================================================================== */

/**
 * ジョグの見た目（ベース位置・ノブ位置・4方向ドット）を中央ニュートラルへ戻す
 */
function resetJogVisual() {
  if (uiRefs.jogBase) {
    uiRefs.jogBase.style.left = '50%';
    uiRefs.jogBase.style.top = '50%';
  }
  if (uiRefs.jogKnob) {
    uiRefs.jogKnob.style.transform = 'translate(-50%, -50%)';
  }
  setJogDotsState(0, 0);
}

/**
 * ポインタ座標からジョグ変位・デッドゾーン・非線形カーブ(m^1.5)を計算し適用（リフローゼロ）
 * @param {number} clientX
 * @param {number} clientY
 */
function updateJogFromClientPoint(clientX, clientY) {
  const maxRadius = jogRectCache.maxRadius;
  let dx = safeFinite(clientX, jogOriginX) - jogOriginX;
  let dy = safeFinite(clientY, jogOriginY) - jogOriginY;

  const dist = Math.hypot(dx, dy);
  if (dist > maxRadius && dist > 0.0001) {
    const scale = maxRadius / dist;
    dx *= scale;
    dy *= scale;
  }

  if (uiRefs.jogKnob) {
    const rdx = Math.round(dx * 10) / 10;
    const rdy = Math.round(dy * 10) / 10;
    uiRefs.jogKnob.style.transform = `translate(calc(-50% + ${rdx}px), calc(-50% + ${rdy}px))`;
  }

  // デッドゾーン（5px）＋非線形カーブ m^1.5（第7章 7.4 準拠）
  const effectiveSpan = Math.max(1, maxRadius - JOG_DEADZONE_PX);
  if (dist <= JOG_DEADZONE_PX) {
    jogMoveX = 0;
    jogMoveY = 0;
  } else {
    const clampedDist = Math.min(dist, maxRadius);
    const linearMag = clamp((clampedDist - JOG_DEADZONE_PX) / effectiveSpan, 0, 1);
    const curvedMag = Math.pow(linearMag, JOG_CURVE_EXP);
    const invDist = 1 / Math.max(0.0001, dist);
    jogMoveX = clamp(dx * invDist * curvedMag, -1, 1);
    jogMoveY = clamp(-dy * invDist * curvedMag, -1, 1); // 上が +1
  }

  syncDirectionalInput();
}

/**
 * フローティング仮想ジョグの開始処理（開始時のみ Rect キャッシュ最新化）
 * @param {number} clientX
 * @param {number} clientY
 */
function beginJogAt(clientX, clientY) {
  refreshInputRects();

  const margin = jogRectCache.baseSize * 0.45;
  const minLocalX = Math.min(margin, jogRectCache.width * 0.5);
  const maxLocalX = Math.max(minLocalX, jogRectCache.width - margin);
  const minLocalY = Math.min(margin, jogRectCache.height * 0.5);
  const maxLocalY = Math.max(minLocalY, jogRectCache.height - margin);

  const localX = clamp(safeFinite(clientX, 0) - jogRectCache.left, minLocalX, maxLocalX);
  const localY = clamp(safeFinite(clientY, 0) - jogRectCache.top, minLocalY, maxLocalY);

  if (uiRefs.jogBase) {
    uiRefs.jogBase.style.left = `${Math.round(localX)}px`;
    uiRefs.jogBase.style.top = `${Math.round(localY)}px`;
  }

  jogOriginX = jogRectCache.left + localX;
  jogOriginY = jogRectCache.top + localY;
  updateJogFromClientPoint(clientX, clientY);
}

/**
 * 仮想ジョグの安全キャンセル／終了（誤入力・固着をゼロ化）
 */
function cancelJog() {
  jogTouchId = null;
  jogMouseActive = false;
  jogMoveX = 0;
  jogMoveY = 0;
  resetJogVisual();
  syncDirectionalInput();
}

/* ============================================================================
 * 5. ジャンプ ＆ パンチボタン操作（独立指追跡・中断安全キャンセル）
 * ========================================================================== */

/**
 * ジャンプボタン押下開始
 */
function pressJump() {
  if (uiRefs.btnJump) uiRefs.btnJump.classList.add('pressed');
  if (!canAcceptGameplayInput()) return;
  inputState.jumpPressed = true;
  inputState.jumpHeld = true;
}

/**
 * ジャンプボタン通常離脱
 */
function releaseJump() {
  jumpTouchId = null;
  jumpMouseActive = false;
  if (uiRefs.btnJump) uiRefs.btnJump.classList.remove('pressed');
  inputState.jumpHeld = false;
}

/**
 * ジャンプボタン安全キャンセル（touchcancel / blur 時に先行予約も即破棄）
 */
function cancelJump() {
  jumpTouchId = null;
  jumpMouseActive = false;
  if (uiRefs.btnJump) uiRefs.btnJump.classList.remove('pressed');
  inputState.jumpHeld = false;
  inputState.jumpPressed = false;
}

/**
 * パンチボタン押下開始
 */
function pressPunch() {
  if (uiRefs.btnPunch) uiRefs.btnPunch.classList.add('pressed');
  if (!canAcceptGameplayInput()) return;
  inputState.punchPressed = true;
}

/**
 * パンチボタン通常離脱
 */
function releasePunch() {
  punchTouchId = null;
  punchMouseActive = false;
  if (uiRefs.btnPunch) uiRefs.btnPunch.classList.remove('pressed');
}

/**
 * パンチボタン安全キャンセル（touchcancel / blur 時に遅れ暴発を 0% に遮断）
 */
function cancelPunch() {
  punchTouchId = null;
  punchMouseActive = false;
  if (uiRefs.btnPunch) uiRefs.btnPunch.classList.remove('pressed');
  inputState.punchPressed = false;
}

/* ============================================================================
 * 6. 一括状態リセット（resetInputState：第7章 7.4 必須規格）
 * ========================================================================== */

/**
 * すべてのタッチ追跡ID・マウス状態・キーボード状態・視覚状態・先行予約を完全初期化する
 * リトライ・ステージ遷移・ゲームオーバー・リサイズ・BG離脱時に呼び出す
 */
export function resetInputState() {
  jogTouchId = null;
  jogMouseActive = false;
  jogMoveX = 0;
  jogMoveY = 0;

  jumpTouchId = null;
  jumpMouseActive = false;
  punchTouchId = null;
  punchMouseActive = false;

  for (const code in keyPressedMap) {
    keyPressedMap[code] = false;
  }

  resetInputFields();
  resetJogVisual();
  if (uiRefs.btnJump) uiRefs.btnJump.classList.remove('pressed');
  if (uiRefs.btnPunch) uiRefs.btnPunch.classList.remove('pressed');
}

/* ============================================================================
 * 7. iPhone 誤拡大・長押し・300ms ダブルタップ遮断（第7章 7.1 厳守）
 * ========================================================================== */

/**
 * iOS WebKit の不要ジェスチャー（ピンチ・長押しコンテキスト・300ms ダブルタップ拡大）を遮断
 * ※ button, [role="button"], input, textarea, canvas は必ず除外して UI・連打競合を防ぐ
 */
function bindIOSGestureMask() {
  const prevent = (e) => {
    if (e && e.cancelable) e.preventDefault();
  };

  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('gesturechange', prevent, { passive: false });
  document.addEventListener('gestureend', prevent, { passive: false });
  window.addEventListener('contextmenu', prevent, { passive: false });

  let lastTouchEndAt = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    const target = e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (
      now - lastTouchEndAt <= 300 &&
      (!target || !target.closest('button, [role="button"], input, textarea, canvas'))
    ) {
      if (e.cancelable) e.preventDefault();
    }
    lastTouchEndAt = now;
  }, { passive: false });
}

/* ============================================================================
 * 8. 仮想ジョグ・アクションボタン・キーボード・フェイルセーフ一括バインド
 * ========================================================================== */

/**
 * TouchList 内から指定 identifier の Touch を高速検索
 * @param {TouchList|null|undefined} touchList
 * @param {number|null} id
 * @returns {Touch|null}
 */
function findTouchById(touchList, id) {
  if (!touchList || id === null) return null;
  for (let i = 0; i < touchList.length; i++) {
    if (touchList[i].identifier === id) {
      return touchList[i];
    }
  }
  return null;
}

/**
 * 仮想ジョグ（#jog-zone）へ単一指追跡タッチ＆マウスイベントをバインド
 */
function bindJogControls() {
  const zone = uiRefs.jogZone;
  if (!zone) return;

  zone.addEventListener('touchstart', (e) => {
    lastTouchTimeMs = Date.now();
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();

    if (!canAcceptGameplayInput()) return;
    // 単一操作指追跡：既に指を追跡中なら 2本目の指を遮断
    if (jogTouchId !== null) return;
    if (!e.changedTouches || e.changedTouches.length === 0) return;

    const t = e.changedTouches[0];
    jogTouchId = t.identifier;
    beginJogAt(t.clientX, t.clientY);
  }, { passive: false });

  zone.addEventListener('touchmove', (e) => {
    if (jogTouchId === null) return;
    const t = findTouchById(e.changedTouches, jogTouchId);
    if (!t) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    updateJogFromClientPoint(t.clientX, t.clientY);
  }, { passive: false });

  zone.addEventListener('touchend', (e) => {
    lastTouchTimeMs = Date.now();
    if (jogTouchId === null) return;
    const t = findTouchById(e.changedTouches, jogTouchId);
    if (!t) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    cancelJog();
  }, { passive: false });

  zone.addEventListener('touchcancel', (e) => {
    lastTouchTimeMs = Date.now();
    if (jogTouchId === null) return;
    const t = findTouchById(e.changedTouches, jogTouchId);
    if (!t) return;
    e.stopPropagation();
    cancelJog();
  }, { passive: true });

  // PC ブラウザ確認用マウス操作
  zone.addEventListener('mousedown', (e) => {
    if (isGhostMouseEvent() || e.button !== 0) return;
    if (!canAcceptGameplayInput()) return;
    e.preventDefault();
    e.stopPropagation();
    jogMouseActive = true;
    beginJogAt(e.clientX, e.clientY);
  });

  window.addEventListener('mousemove', (e) => {
    if (!jogMouseActive) return;
    if (e.buttons === 0) {
      cancelJog();
      return;
    }
    updateJogFromClientPoint(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', () => {
    if (jogMouseActive) {
      cancelJog();
    }
  });
}

/**
 * ジャンプ＆パンチボタンへ独立指IDマルチタッチ＆マウスイベントをバインド
 */
function bindActionButtons() {
  const btnJump = uiRefs.btnJump;
  const btnPunch = uiRefs.btnPunch;

  if (btnJump) {
    btnJump.addEventListener('touchstart', (e) => {
      lastTouchTimeMs = Date.now();
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      if (jumpTouchId !== null || !e.changedTouches || e.changedTouches.length === 0) return;
      jumpTouchId = e.changedTouches[0].identifier;
      pressJump();
    }, { passive: false });

    btnJump.addEventListener('touchend', (e) => {
      lastTouchTimeMs = Date.now();
      if (jumpTouchId === null) return;
      if (!findTouchById(e.changedTouches, jumpTouchId)) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      releaseJump();
    }, { passive: false });

    btnJump.addEventListener('touchcancel', (e) => {
      lastTouchTimeMs = Date.now();
      if (jumpTouchId === null) return;
      if (!findTouchById(e.changedTouches, jumpTouchId)) return;
      e.stopPropagation();
      cancelJump();
    }, { passive: true });

    btnJump.addEventListener('mousedown', (e) => {
      if (isGhostMouseEvent() || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      jumpMouseActive = true;
      pressJump();
    });
  }

  if (btnPunch) {
    btnPunch.addEventListener('touchstart', (e) => {
      lastTouchTimeMs = Date.now();
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      if (punchTouchId !== null || !e.changedTouches || e.changedTouches.length === 0) return;
      punchTouchId = e.changedTouches[0].identifier;
      pressPunch();
    }, { passive: false });

    btnPunch.addEventListener('touchend', (e) => {
      lastTouchTimeMs = Date.now();
      if (punchTouchId === null) return;
      if (!findTouchById(e.changedTouches, punchTouchId)) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      releasePunch();
    }, { passive: false });

    btnPunch.addEventListener('touchcancel', (e) => {
      lastTouchTimeMs = Date.now();
      if (punchTouchId === null) return;
      if (!findTouchById(e.changedTouches, punchTouchId)) return;
      e.stopPropagation();
      cancelPunch();
    }, { passive: true });

    btnPunch.addEventListener('mousedown', (e) => {
      if (isGhostMouseEvent() || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      punchMouseActive = true;
      pressPunch();
    });
  }

  // マウスボタン枠外離脱フェイルセーフ
  window.addEventListener('mouseup', () => {
    if (jumpMouseActive) releaseJump();
    if (punchMouseActive) releasePunch();
  });
}

/**
 * PC 確認用キーボード入力バインド（INPUT/TEXTAREA フォーカス中は完全非干渉）
 */
function bindKeyboardControls() {
  window.addEventListener('keydown', (e) => {
    if (isTextInputFocused()) return;

    const code = e.code;
    if (
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Space'
    ) {
      if (e.cancelable) e.preventDefault();
    }

    if (!canAcceptGameplayInput()) return;

    if (!keyPressedMap[code]) {
      if (code === 'Space') {
        inputState.jumpPressed = true;
        inputState.jumpHeld = true;
      } else if (code === 'KeyF' || code === 'KeyJ' || code === 'KeyZ' || code === 'Enter') {
        inputState.punchPressed = true;
      }
    }

    keyPressedMap[code] = true;
    syncDirectionalInput();
  });

  window.addEventListener('keyup', (e) => {
    const code = e.code;
    keyPressedMap[code] = false;
    if (code === 'Space') {
      inputState.jumpHeld = false;
    }
    syncDirectionalInput();
  });
}

/**
 * グローバル安全キャンセル＆フェイルセーフ監視（通知・アプリ切替・指0本検出で固着/誤発射根絶）
 */
function bindGlobalCancelFailsafes() {
  // 画面外で指を離した場合の個別指ID追尾解放
  window.addEventListener('touchend', (e) => {
    lastTouchTimeMs = Date.now();
    if (jogTouchId !== null && findTouchById(e.changedTouches, jogTouchId)) {
      cancelJog();
    }
    if (jumpTouchId !== null && findTouchById(e.changedTouches, jumpTouchId)) {
      releaseJump();
    }
    if (punchTouchId !== null && findTouchById(e.changedTouches, punchTouchId)) {
      releasePunch();
    }
    // 画面上の指が 0 本になった瞬間の完全安全解放
    if (!e.touches || e.touches.length === 0) {
      if (jogTouchId !== null) cancelJog();
      if (jumpTouchId !== null) releaseJump();
      if (punchTouchId !== null) releasePunch();
    }
  }, { passive: true, capture: true });

  // 操作中断イベント（touchcancel）は必ず誤発射しない専用キャンセルへ委譲
  window.addEventListener('touchcancel', (e) => {
    lastTouchTimeMs = Date.now();
    if (jogTouchId !== null && findTouchById(e.changedTouches, jogTouchId)) {
      cancelJog();
    }
    if (jumpTouchId !== null && findTouchById(e.changedTouches, jumpTouchId)) {
      cancelJump();
    }
    if (punchTouchId !== null && findTouchById(e.changedTouches, punchTouchId)) {
      cancelPunch();
    }
    if (!e.touches || e.touches.length === 0) {
      cancelJog();
      cancelJump();
      cancelPunch();
    }
  }, { passive: true, capture: true });

  // アプリ切替・通知割り込み・タブ非表示時は全入力を安全キャンセル（誤発射ゼロ）
  window.addEventListener('blur', resetInputState);
  window.addEventListener('pagehide', resetInputState);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resetInputState();
    }
  });
}

/* ============================================================================
 * 9. 公開初期化 API（main.js から mountDOM() 完了後に1回だけ呼び出し）
 * ========================================================================== */

/**
 * 全入力制御・iOS ジェスチャーマスク・Rect キャッシュを単一登録で初期化する
 */
export function initInput() {
  if (isInputInitialized) return;
  isInputInitialized = true;

  bindIOSGestureMask();
  bindJogControls();
  bindActionButtons();
  bindKeyboardControls();
  bindGlobalCancelFailsafes();
  refreshInputRects();
}