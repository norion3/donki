/**
 * dom_ui.js
 * @version v1.0 (Autonomous DOM Mount, Custom SVG UI, Safe Tap & Auto Layout - Phase 12)
 * @changes
 *   - 絵文字を一切使わず全アイコン（音量ON/OFF・リスタート・ライフハート・ボーナス時計・パンチ・ジャンプ・ガイド3種）をカスタムSVG自前描画で自律マウントする mountDOM() を実装
 *   - 改訂設計書v2.1準拠の上段スコア専用30px HUD（操作ボタンなし）と、下段中央最下端 z-index:60 の音量（初期OFF）＆リスタートボタンを実装
 *   - マスター設計書v5.0.0（第7章 7.4）準拠の 8イベント安全タップバインド規格 bindSafeTap()（8イベント stopPropagation・24px指ズレ許容・350ms二重発火防止・touchcancelリセット）を実装
 *   - 前回値キャッシュによる差分 HUD 更新 updateHUD() とゼロアロケーション予約キュー消費のフローティングスコア描画 flushFloatTextQueue() を実装
 *   - visualViewport 同期・--safe-top 環境分岐（isInAppWebView: 52px vs 8px）・キーボード展開時リサイズスキップ・3Dカメラ/レンダラー追従を行う updateLayout() を実装
 *   - オプティカルセンター動的カード配置（rAFデバウンス・開閉競合防止・背景ラバーバンド遮断）対応の showModal() / hideModal() およびステージ遷移バナーを実装
 *
 * Tier 4 UIモジュール：DOM構築・カスタムSVG描画・HUD差分更新・モーダル＆レイアウト自動調節
 */

import {
  MAX_DPR,
  POWER_UP_DURATION,
  STAGE_META,
  PlatformDetector,
  escapeHTML,
  formatScore,
  clamp,
  safeFinite
} from './constants.js?v=1';

import {
  gameState,
  viewportState,
  pendingFloatTextQueue,
  clearFloatTextQueue
} from './world_state.js?v=1';

import { isSoundEnabled } from './audio.js?v=1';
import { world3D } from './world.js?v=1';
import { projectWorldToScreen } from './camera.js?v=1';

/* ============================================================================
 * 1. カスタム SVG アイコン定義（絵文字・記号文字完全不使用・自前ベクター描画）
 * ========================================================================== */

/** 音量 OFF（デフォルト）：スピーカー本体 ＋ 右側に斜めクロス × */
const SVG_SOUND_OFF =
  '<svg class="util-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" fill-opacity="0.18"/>' +
    '<line x1="16" y1="9.5" x2="21" y2="14.5"/>' +
    '<line x1="21" y1="9.5" x2="16" y2="14.5"/>' +
  '</svg>';

/** 音量 ON：スピーカー本体 ＋ 2重音波アーク */
const SVG_SOUND_ON =
  '<svg class="util-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" fill-opacity="0.26"/>' +
    '<path d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8"/>' +
    '<path d="M18.6 5.8a8.8 8.8 0 0 1 0 12.4"/>' +
  '</svg>';

/** リスタート：270°の滑らかな円弧パス ＋ 先端アローヘッド */
const SVG_RESTART =
  '<svg class="util-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.6"/>' +
    '<polyline points="20 3.8 20 8.6 15.2 8.6"/>' +
  '</svg>';

/** パンチボタン：文字なし・衝撃波付きフィスト（拳）アイコン */
const SVG_PUNCH =
  '<svg class="action-btn-svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10 14.5v-3a2 2 0 0 1 4 0v2.5M14 14v-3.5a2 2 0 0 1 4 0V14M18 14v-2.8a2 2 0 0 1 4 0V15M22 15.2v-1.8a1.9 1.9 0 0 1 3.8 0v4.8c0 4.2-3.2 7.3-7.6 7.3h-2.4c-3.8 0-6.8-2.6-6.8-6.4v-3.1a2 2 0 0 1 4 0" fill="currentColor" fill-opacity="0.22"/>' +
    '<path d="M5.5 8.5L8 10.5M4.5 14.5H7.2M26.5 8.5L24 10.5" stroke-width="2"/>' +
  '</svg>';

/** ジャンプボタン：文字なし・太め上向きアローアイコン */
const SVG_JUMP =
  '<svg class="action-btn-svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M16 25V8"/>' +
    '<path d="M8.5 15.5L16 7.5l7.5 8"/>' +
    '<line x1="11" y1="26.5" x2="21" y2="26.5" stroke-width="2.2" stroke-opacity="0.7"/>' +
  '</svg>';

/** HUD ライフハート：カスタムSVG */
const SVG_HEART =
  '<svg class="hud-heart-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M10 17.2l-1.2-1.1C4.4 12.2 1.8 9.8 1.8 6.7 1.8 4.3 3.7 2.5 6 2.5c1.4 0 2.8.7 4 2 1.2-1.3 2.6-2 4-2 2.3 0 4.2 1.8 4.2 4.2 0 3.1-2.6 5.5-7 9.4L10 17.2z" fill="#fb7185" stroke="#fecdd3" stroke-width="1"/>' +
  '</svg>';

/** HUD ボーナスタイマー：カスタムSVG時計 */
const SVG_TIMER =
  '<svg class="hud-timer-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10" cy="11" r="6.8"/>' +
    '<path d="M10 7.6V11l2.4 1.6"/>' +
    '<line x1="7.5" y1="2.2" x2="12.5" y2="2.2"/>' +
  '</svg>';

/** タイトルミニガイド用カスタムSVG（木タル / トゲ敵 / ハイパー電池） */
const SVG_GUIDE_BARREL =
  '<svg class="modal-guide-icon" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="4" width="14" height="16" rx="4" fill="rgba(217,119,6,0.35)"/>' +
    '<line x1="5" y1="9" x2="19" y2="9"/>' +
    '<line x1="5" y1="15" x2="19" y2="15"/>' +
    '<line x1="12" y1="4" x2="12" y2="20" stroke-opacity="0.6"/>' +
  '</svg>';

const SVG_GUIDE_SPIKY =
  '<svg class="modal-guide-icon" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 17a7 7 0 0 1 14 0v2H5v-2z" fill="rgba(147,51,234,0.38)"/>' +
    '<path d="M12 4l1.8 4.8M7.2 6.5l2.2 3.8M16.8 6.5l-2.2 3.8" stroke="#fb7185"/>' +
    '<circle cx="9.8" cy="14.5" r="1.1" fill="#ffffff" stroke="none"/>' +
    '<circle cx="14.2" cy="14.5" r="1.1" fill="#ffffff" stroke="none"/>' +
  '</svg>';

const SVG_GUIDE_BATTERY =
  '<svg class="modal-guide-icon" viewBox="0 0 24 24" fill="none" stroke="#fde047" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="6.5" y="5.5" width="11" height="15" rx="2.2" fill="rgba(250,204,21,0.28)"/>' +
    '<rect x="9.5" y="2.8" width="5" height="2.7" rx="0.8" fill="#fde047"/>' +
    '<path d="M13 8.8l-3.2 4.5h2.6l-1.4 4.2 3.6-5h-2.5L13 8.8z" fill="#fef08a" stroke="none"/>' +
  '</svg>';

/* ============================================================================
 * 2. 共有 DOM 参照キャッシュ ＆ 内部ステート
 * ========================================================================== */

export const uiRefs = {
  appRoot: null,
  canvasContainer: null,
  powerFrame: null,
  floatLayer: null,
  headerEl: null,
  hudStage: null,
  hudHearts: null,
  heartNodes: [],
  hudScore: null,
  hudBonus: null,
  powerBarWrap: null,
  powerBar: null,
  stageBanner: null,
  stageBannerCode: null,
  stageBannerSub: null,
  controlsDeckEl: null,
  jogZone: null,
  jogBase: null,
  jogKnob: null,
  jogDotUp: null,
  jogDotDown: null,
  jogDotLeft: null,
  jogDotRight: null,
  rightControls: null,
  btnPunch: null,
  btnJump: null,
  utilityDock: null,
  btnSound: null,
  btnQuickReset: null,
  overlayModal: null,
  modalCard: null,
  modalBadge: null,
  modalTitle: null,
  modalDesc: null,
  modalStats: null,
  modalScoreVal: null,
  modalBestVal: null,
  modalStageVal: null,
  modalGuide: null,
  modalLoading: null,
  btnStart: null
};

/** HUD 前回値キャッシュ（変化フレームのみ DOM 更新：第7章 7.4 準拠） */
const hudCache = {
  stageText: '',
  hp: -1,
  scoreText: '',
  bonusText: '',
  bonusLow: false,
  powerVisible: false,
  powerPct: -1,
  showResetBtn: null,
  soundOn: null
};

/** ジョグ方向ドット前回値キャッシュ */
const jogDotCache = {
  up: false,
  down: false,
  left: false,
  right: false
};

/** モーダル開閉競合防止・オプティカルセンター rAF デバウンス状態 */
let isModalOpen = true;
let modalHideTimerId = null;
let modalCenterRafId = null;
let bannerHideTimerId = null;
let isMounted = false;

/** ゼロアロケーション投影用ワークバッファ */
const _floatProjOut = { x: 0, y: 0, visible: false };
const MAX_ACTIVE_FLOAT_NODES = 20;

/* ============================================================================
 * 3. 自律 DOM マウント（mountDOM：main.js 冒頭で injectStyles() 直後に同期実行）
 * ========================================================================== */

/**
 * ゲームの全 UI・キャンバスコンテナを自律的に DOM へ構築する
 * ※ Layer 1 ローダーの初期スピナーを壊さないよう既存 body 子要素は保持しつつ #app-root を生成
 * @returns {typeof uiRefs}
 */
export function mountDOM() {
  if (isMounted && uiRefs.appRoot && uiRefs.appRoot.parentNode) {
    return uiRefs;
  }

  const existing = document.getElementById('app-root');
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }

  const appRoot = document.createElement('div');
  appRoot.id = 'app-root';

  const heartsMarkup = SVG_HEART + SVG_HEART + SVG_HEART;

  appRoot.innerHTML =
    '<div id="game-canvas-container"></div>' +
    '<div id="power-frame" aria-hidden="true"></div>' +
    '<div id="float-layer" aria-hidden="true"></div>' +

    // 上段 HUD（高さ 30px・スコア等ステータス表示専用・操作ボタンなし）
    '<header id="game-header">' +
      '<div class="hud-bar">' +
        '<div class="hud-left">' +
          '<span id="hud-stage">L1·25m</span>' +
          '<div id="hud-hearts" aria-label="ライフ">' + heartsMarkup + '</div>' +
        '</div>' +
        '<div id="hud-score-wrap">' +
          '<span class="hud-score-label">SCORE</span>' +
          '<span id="hud-score">00000</span>' +
        '</div>' +
        '<div id="hud-bonus-wrap" aria-label="ボーナス制限時間">' +
          SVG_TIMER +
          '<span id="hud-bonus">5000</span>' +
        '</div>' +
      '</div>' +
      '<div id="power-bar-wrap">' +
        '<div id="power-bar"></div>' +
      '</div>' +
    '</header>' +

    // ステージ開始・切替バナー
    '<div id="stage-banner" aria-live="polite">' +
      '<span id="stage-banner-code">LOOP 1 · 25m</span>' +
      '<span id="stage-banner-sub">6層の鉄骨と転がるタルを突破せよ！</span>' +
    '</div>' +

    // 下段操作デッキ（左：文字なし仮想ジョグ / 右：文字なしカスタムSVGパンチ＆ジャンプ）
    '<div id="controls-deck">' +
      '<div id="jog-zone">' +
        '<div id="jog-base">' +
          '<span class="jog-dot jog-dot-up" id="jog-dot-up"></span>' +
          '<span class="jog-dot jog-dot-down" id="jog-dot-down"></span>' +
          '<span class="jog-dot jog-dot-left" id="jog-dot-left"></span>' +
          '<span class="jog-dot jog-dot-right" id="jog-dot-right"></span>' +
          '<div id="jog-knob"></div>' +
        '</div>' +
      '</div>' +
      '<div id="right-controls">' +
        '<div id="btn-punch" class="action-btn" role="button" tabindex="0" aria-label="パンチ">' +
          SVG_PUNCH +
        '</div>' +
        '<div id="btn-jump" class="action-btn" role="button" tabindex="0" aria-label="ジャンプ">' +
          SVG_JUMP +
        '</div>' +
      '</div>' +
    '</div>' +

    // 下段中央最下端ユーティリティドック（z-index: 60・タイトル/リザルト中でも音量操作可能）
    '<div id="utility-dock">' +
      '<div id="btn-sound" class="util-btn" role="button" tabindex="0" data-audio-toggle="true" aria-label="サウンド切替" aria-pressed="false">' +
        SVG_SOUND_OFF +
      '</div>' +
      '<div id="btn-quick-reset" class="util-btn is-hidden" role="button" tabindex="0" aria-label="リスタート">' +
        SVG_RESTART +
      '</div>' +
    '</div>' +

    // タイトル / 読み込み / リザルト オーバーレイモーダル（backdrop-filter 不使用）
    '<div id="overlay-modal">' +
      '<div class="modal-card" id="modal-card">' +
        '<div id="modal-badge" class="modal-badge">3D TOWER ACTION</div>' +
        '<h1 id="modal-title" class="modal-title">ROBOT TOWER DK</h1>' +
        '<p id="modal-desc" class="modal-desc">' +
          '25m・50m・75m・100mの全4ステージを攻略！<br>' +
          'タルや敵を<strong class="hl-sky">ジャンプ</strong>と<strong class="hl-amber">パンチ</strong>で突破し、<br>' +
          '最上階の<strong class="hl-pink">ヒロイン</strong>を救出しよう！' +
        '</p>' +

        '<div id="modal-stats" class="is-hidden">' +
          '<div class="modal-stat-row">' +
            '<span class="modal-stat-label">FINAL SCORE</span>' +
            '<span id="modal-score-val">0</span>' +
          '</div>' +
          '<div class="modal-stat-row">' +
            '<span class="modal-stat-label">HIGH SCORE</span>' +
            '<span id="modal-best-val">0</span>' +
          '</div>' +
          '<div class="modal-stat-row">' +
            '<span class="modal-stat-label">REACHED</span>' +
            '<span id="modal-stage-val">LOOP 1 · 25m</span>' +
          '</div>' +
        '</div>' +

        '<div id="modal-guide">' +
          '<div class="modal-guide-item">' +
            SVG_GUIDE_BARREL +
            '<div class="modal-guide-name c-amber">木タル</div>' +
            '<div class="modal-guide-sub">跳ぶ / 殴る</div>' +
          '</div>' +
          '<div class="modal-guide-item">' +
            SVG_GUIDE_SPIKY +
            '<div class="modal-guide-name c-purple">トゲ敵</div>' +
            '<div class="modal-guide-sub">パンチ撃破</div>' +
          '</div>' +
          '<div class="modal-guide-item">' +
            SVG_GUIDE_BATTERY +
            '<div class="modal-guide-name c-yellow">電池BOX</div>' +
            '<div class="modal-guide-sub">無敵＆2倍</div>' +
          '</div>' +
        '</div>' +

        '<div id="modal-loading">3Dロボットを読み込み中...</div>' +
        '<div id="btn-start" class="is-hidden" role="button" tabindex="0">PLAY START!</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(appRoot);

  // DOM 参照を一括キャッシュ
  uiRefs.appRoot = appRoot;
  uiRefs.canvasContainer = appRoot.querySelector('#game-canvas-container');
  uiRefs.powerFrame = appRoot.querySelector('#power-frame');
  uiRefs.floatLayer = appRoot.querySelector('#float-layer');
  uiRefs.headerEl = appRoot.querySelector('#game-header');
  uiRefs.hudStage = appRoot.querySelector('#hud-stage');
  uiRefs.hudHearts = appRoot.querySelector('#hud-hearts');
  uiRefs.heartNodes = Array.from(appRoot.querySelectorAll('#hud-hearts .hud-heart-svg'));
  uiRefs.hudScore = appRoot.querySelector('#hud-score');
  uiRefs.hudBonus = appRoot.querySelector('#hud-bonus');
  uiRefs.powerBarWrap = appRoot.querySelector('#power-bar-wrap');
  uiRefs.powerBar = appRoot.querySelector('#power-bar');
  uiRefs.stageBanner = appRoot.querySelector('#stage-banner');
  uiRefs.stageBannerCode = appRoot.querySelector('#stage-banner-code');
  uiRefs.stageBannerSub = appRoot.querySelector('#stage-banner-sub');
  uiRefs.controlsDeckEl = appRoot.querySelector('#controls-deck');
  uiRefs.jogZone = appRoot.querySelector('#jog-zone');
  uiRefs.jogBase = appRoot.querySelector('#jog-base');
  uiRefs.jogKnob = appRoot.querySelector('#jog-knob');
  uiRefs.jogDotUp = appRoot.querySelector('#jog-dot-up');
  uiRefs.jogDotDown = appRoot.querySelector('#jog-dot-down');
  uiRefs.jogDotLeft = appRoot.querySelector('#jog-dot-left');
  uiRefs.jogDotRight = appRoot.querySelector('#jog-dot-right');
  uiRefs.rightControls = appRoot.querySelector('#right-controls');
  uiRefs.btnPunch = appRoot.querySelector('#btn-punch');
  uiRefs.btnJump = appRoot.querySelector('#btn-jump');
  uiRefs.utilityDock = appRoot.querySelector('#utility-dock');
  uiRefs.btnSound = appRoot.querySelector('#btn-sound');
  uiRefs.btnQuickReset = appRoot.querySelector('#btn-quick-reset');
  uiRefs.overlayModal = appRoot.querySelector('#overlay-modal');
  uiRefs.modalCard = appRoot.querySelector('#modal-card');
  uiRefs.modalBadge = appRoot.querySelector('#modal-badge');
  uiRefs.modalTitle = appRoot.querySelector('#modal-title');
  uiRefs.modalDesc = appRoot.querySelector('#modal-desc');
  uiRefs.modalStats = appRoot.querySelector('#modal-stats');
  uiRefs.modalScoreVal = appRoot.querySelector('#modal-score-val');
  uiRefs.modalBestVal = appRoot.querySelector('#modal-best-val');
  uiRefs.modalStageVal = appRoot.querySelector('#modal-stage-val');
  uiRefs.modalGuide = appRoot.querySelector('#modal-guide');
  uiRefs.modalLoading = appRoot.querySelector('#modal-loading');
  uiRefs.btnStart = appRoot.querySelector('#btn-start');

  // モーダル背景での iOS ラバーバンドスクロール完全遮断（第7章 7.3 準拠）
  if (uiRefs.overlayModal) {
    uiRefs.overlayModal.addEventListener('touchmove', (e) => {
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
  }

  // HUDキャッシュリセット＋初期同期
  hudCache.stageText = '';
  hudCache.hp = -1;
  hudCache.scoreText = '';
  hudCache.bonusText = '';
  hudCache.bonusLow = false;
  hudCache.powerVisible = false;
  hudCache.powerPct = -1;
  hudCache.showResetBtn = null;
  hudCache.soundOn = null;

  isMounted = true;
  isModalOpen = true;
  syncSoundButtonUI(isSoundEnabled());
  updateHUD(true);
  scheduleModalCentering();

  return uiRefs;
}

/* ============================================================================
 * 4. 8イベント安全タップバインド規格（bindSafeTap：第7章 7.4 厳守）
 *    - マウス系4種＋タッチ系4種の計8イベントすべてに stopPropagation()
 *    - 24px 指ズレ許容 / 350ms 二重発火防止 / touchcancel リセット
 * ========================================================================== */

const TAP_MOVE_TOLERANCE_PX = 24;
const TAP_DEBOUNCE_MS = 350;

/**
 * UI ボタン（<div role="button"> 等）へ 8イベント安全タップ規格をバインドする
 * @param {HTMLElement|null} el
 * @param {(e: Event) => void} onTap
 * @param {{debounceMs?: number}} [options]
 */
export function bindSafeTap(el, onTap, options = {}) {
  if (!el || typeof onTap !== 'function') return;

  const debounceMs = Math.max(80, safeFinite(options.debounceMs, TAP_DEBOUNCE_MS));
  let trackingTouchId = null;
  let trackingMouse = false;
  let startX = 0;
  let startY = 0;
  let canceled = false;
  let lastFiredAt = 0;

  const clearPressState = () => {
    trackingTouchId = null;
    trackingMouse = false;
    canceled = false;
    el.classList.remove('pressed');
  };

  const triggerOnce = (e) => {
    const now = Date.now();
    if (now - lastFiredAt < debounceMs) return;
    lastFiredAt = now;
    onTap(e);
  };

  // --- タッチ系 4 イベント ---
  el.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    if (!e.changedTouches || e.changedTouches.length === 0) return;
    if (trackingTouchId !== null) return;
    const t = e.changedTouches[0];
    trackingTouchId = t.identifier;
    startX = t.clientX;
    startY = t.clientY;
    canceled = false;
    el.classList.add('pressed');
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    e.stopPropagation();
    if (trackingTouchId === null || !e.changedTouches) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === trackingTouchId) {
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (dx * dx + dy * dy > TAP_MOVE_TOLERANCE_PX * TAP_MOVE_TOLERANCE_PX) {
          canceled = true;
          el.classList.remove('pressed');
        }
        break;
      }
    }
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    e.stopPropagation();
    if (trackingTouchId === null || !e.changedTouches) return;
    let matched = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === trackingTouchId) {
        matched = true;
        break;
      }
    }
    if (!matched) return;
    const shouldFire = !canceled;
    clearPressState();
    if (shouldFire) {
      if (e.cancelable) e.preventDefault();
      triggerOnce(e);
    }
  }, { passive: false });

  el.addEventListener('touchcancel', (e) => {
    e.stopPropagation();
    clearPressState();
  }, { passive: true });

  // --- マウス系 4 イベント ---
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    trackingMouse = true;
    startX = e.clientX;
    startY = e.clientY;
    canceled = false;
    el.classList.add('pressed');
  });

  el.addEventListener('mousemove', (e) => {
    e.stopPropagation();
    if (!trackingMouse) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx * dx + dy * dy > TAP_MOVE_TOLERANCE_PX * TAP_MOVE_TOLERANCE_PX) {
      canceled = true;
      el.classList.remove('pressed');
    }
  });

  el.addEventListener('mouseup', (e) => {
    e.stopPropagation();
    if (!trackingMouse) return;
    const shouldFire = !canceled;
    clearPressState();
    if (shouldFire) {
      triggerOnce(e);
    }
  });

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    // タッチ・マウス直後のゴーストクリックは 350ms デバウンスで遮断しつつキーボード Enter 等を救済
    triggerOnce(e);
  });
}

/* ============================================================================
 * 5. 音量ボタン表示同期・ジョグ方向ドット・HUD 差分更新
 * ========================================================================== */

/**
 * 下段中央の音量ボタン（自前カスタムSVG）の ON/OFF 表示を同期
 * @param {boolean} enabled
 */
export function syncSoundButtonUI(enabled) {
  const isOn = Boolean(enabled);
  if (!uiRefs.btnSound || hudCache.soundOn === isOn) return;
  hudCache.soundOn = isOn;
  uiRefs.btnSound.innerHTML = isOn ? SVG_SOUND_ON : SVG_SOUND_OFF;
  uiRefs.btnSound.classList.toggle('is-on', isOn);
  uiRefs.btnSound.setAttribute('aria-pressed', isOn ? 'true' : 'false');
}

/**
 * 下段中央のリスタートボタン表示／非表示を切替（タイトル待機中は非表示）
 * @param {boolean} visible
 */
export function updateResetButtonVisibility(visible) {
  const show = Boolean(visible);
  if (!uiRefs.btnQuickReset || hudCache.showResetBtn === show) return;
  hudCache.showResetBtn = show;
  uiRefs.btnQuickReset.classList.toggle('is-hidden', !show);
}

/**
 * 仮想ジョグ外周の4方向極小ドット（4px）の傾け方向発光を更新（差分のみ）
 * @param {number} mx -1..+1
 * @param {number} my -1..+1
 */
export function setJogDotsState(mx, my) {
  const up = my > 0.32;
  const down = my < -0.32;
  const left = mx < -0.25;
  const right = mx > 0.25;

  if (up !== jogDotCache.up) {
    jogDotCache.up = up;
    if (uiRefs.jogDotUp) uiRefs.jogDotUp.classList.toggle('is-lit', up);
  }
  if (down !== jogDotCache.down) {
    jogDotCache.down = down;
    if (uiRefs.jogDotDown) uiRefs.jogDotDown.classList.toggle('is-lit', down);
  }
  if (left !== jogDotCache.left) {
    jogDotCache.left = left;
    if (uiRefs.jogDotLeft) uiRefs.jogDotLeft.classList.toggle('is-lit', left);
  }
  if (right !== jogDotCache.right) {
    jogDotCache.right = right;
    if (uiRefs.jogDotRight) uiRefs.jogDotRight.classList.toggle('is-lit', right);
  }
}

/**
 * 上段 HUD とハイパー電池ゲージを前回値キャッシュ比較で差分更新する
 * @param {boolean} [force=false]
 */
export function updateHUD(force = false) {
  if (!isMounted) return;
  if (!force && !gameState.hudDirty) return;
  gameState.hudDirty = false;

  // 1) ステージ＆周回表記（例: L1·25m）
  const meta = STAGE_META[gameState.stageIndex] || STAGE_META[0];
  const stageText = `L${Math.max(1, gameState.loop)}·${meta.code}`;
  if (force || hudCache.stageText !== stageText) {
    hudCache.stageText = stageText;
    if (uiRefs.hudStage) uiRefs.hudStage.textContent = stageText;
  }

  // 2) ライフハート（カスタムSVGの .is-lost トグル）
  const hp = clamp(Math.floor(safeFinite(gameState.hp, 0)), 0, gameState.maxHp);
  if (force || hudCache.hp !== hp) {
    hudCache.hp = hp;
    for (let i = 0; i < uiRefs.heartNodes.length; i++) {
      uiRefs.heartNodes[i].classList.toggle('is-lost', i >= hp);
    }
  }

  // 3) スコア（桁溢れ短縮対応・ゼロ埋め）
  const scoreText = formatScore(gameState.score, true);
  if (force || hudCache.scoreText !== scoreText) {
    hudCache.scoreText = scoreText;
    if (uiRefs.hudScore) uiRefs.hudScore.textContent = scoreText;
  }

  // 4) ボーナス制限時間（1000以下で警告色）
  const bonusSafe = Math.max(0, Math.floor(safeFinite(gameState.bonusTimer, 0)));
  const bonusText = String(bonusSafe).padStart(4, '0');
  const bonusLow = bonusSafe <= 1000;
  if (force || hudCache.bonusText !== bonusText) {
    hudCache.bonusText = bonusText;
    if (uiRefs.hudBonus) uiRefs.hudBonus.textContent = bonusText;
  }
  if (force || hudCache.bonusLow !== bonusLow) {
    hudCache.bonusLow = bonusLow;
    if (uiRefs.hudBonus) uiRefs.hudBonus.classList.toggle('is-low', bonusLow);
  }

  // 5) ハイパー電池 3px ゲージ ＆ 画面枠発光
  const powerVisible = gameState.powerTimer > 0 && gameState.phase === 'playing';
  const powerPct = powerVisible
    ? Math.round(clamp((gameState.powerTimer / POWER_UP_DURATION) * 100, 0, 100))
    : 0;

  if (force || hudCache.powerVisible !== powerVisible) {
    hudCache.powerVisible = powerVisible;
    if (uiRefs.powerBarWrap) uiRefs.powerBarWrap.classList.toggle('is-visible', powerVisible);
    if (uiRefs.powerFrame) uiRefs.powerFrame.classList.toggle('is-active', powerVisible);
  }
  if (powerVisible && (force || hudCache.powerPct !== powerPct)) {
    hudCache.powerPct = powerPct;
    if (uiRefs.powerBar) uiRefs.powerBar.style.width = `${powerPct}%`;
  }

  // 6) リスタートボタン表示制御（ロード中・タイトル待機中は非表示、プレイ以降は表示）
  const showReset = !gameState.isWaitingStart && gameState.phase !== 'loading' && gameState.phase !== 'title';
  updateResetButtonVisibility(showReset);
}

/* ============================================================================
 * 6. オプティカルセンター動的カード配置 ＆ モーダル・ステージバナー制御（第7章 7.3）
 * ========================================================================== */

/**
 * モーダルカードをヘッダー下端・操作デッキ上端・実画面中央（75/25加重）から
 * オプティカルセンターへ動的縦配置する（rAF 多重予約デバウンス付き）
 */
export function scheduleModalCentering() {
  if (!uiRefs.overlayModal || !uiRefs.modalCard || !isModalOpen) return;
  if (modalCenterRafId !== null) return;

  modalCenterRafId = window.requestAnimationFrame(() => {
    modalCenterRafId = null;
    if (!isModalOpen || !uiRefs.overlayModal || !uiRefs.modalCard) return;

    const vh = Math.max(1, viewportState.h || window.innerHeight);
    const headerRect = uiRefs.headerEl ? uiRefs.headerEl.getBoundingClientRect() : null;
    const utilityRect = uiRefs.utilityDock ? uiRefs.utilityDock.getBoundingClientRect() : null;
    const cardRect = uiRefs.modalCard.getBoundingClientRect();

    const safeMinTop = Math.ceil((headerRect ? headerRect.bottom : (viewportState.safeTopPx + 30)) + 12);
    const safeMaxBottom = Math.floor((utilityRect ? utilityRect.top : (vh - viewportState.safeBottomPx - 48)) - 14);
    const cardH = Math.max(120, cardRect.height || 280);

    // プレイ可視領域中央（75%）＋画面全体中央（25%）のオプティカルセンター
    const visualBandCenter = (safeMinTop + safeMaxBottom) * 0.5;
    const screenCenter = vh * 0.5;
    const targetCenterY = visualBandCenter * 0.75 + screenCenter * 0.25;

    const idealTop = Math.round(targetCenterY - cardH * 0.5);
    const maxTop = Math.max(safeMinTop, safeMaxBottom - cardH);
    const clampedTop = clamp(idealTop, safeMinTop, maxTop);

    uiRefs.overlayModal.style.paddingTop = `${clampedTop}px`;
  });
}

/**
 * タイトル／リザルトオーバーレイモーダルを表示
 * @param {{
 *   badge?: string,
 *   title?: string,
 *   descHtml?: string,
 *   descText?: string,
 *   btnText?: string,
 *   showStats?: boolean,
 *   showGuide?: boolean
 * }} config
 */
export function showModal(config = {}) {
  if (!uiRefs.overlayModal) return;

  if (modalHideTimerId !== null) {
    window.clearTimeout(modalHideTimerId);
    modalHideTimerId = null;
  }

  isModalOpen = true;
  uiRefs.overlayModal.style.display = 'flex';

  if (uiRefs.modalBadge && config.badge !== undefined) {
    uiRefs.modalBadge.textContent = String(config.badge);
  }
  if (uiRefs.modalTitle && config.title !== undefined) {
    uiRefs.modalTitle.textContent = String(config.title);
  }
  if (uiRefs.modalDesc) {
    if (config.descHtml !== undefined) {
      uiRefs.modalDesc.innerHTML = config.descHtml;
    } else if (config.descText !== undefined) {
      uiRefs.modalDesc.textContent = String(config.descText);
    }
  }
  if (uiRefs.btnStart && config.btnText !== undefined) {
    uiRefs.btnStart.textContent = String(config.btnText);
  }

  const showStats = Boolean(config.showStats);
  const showGuide = config.showGuide !== undefined ? Boolean(config.showGuide) : !showStats;

  if (uiRefs.modalStats) {
    uiRefs.modalStats.classList.toggle('is-hidden', !showStats);
  }
  if (uiRefs.modalGuide) {
    uiRefs.modalGuide.classList.toggle('is-hidden', !showGuide);
  }

  if (showStats) {
    if (uiRefs.modalScoreVal) {
      uiRefs.modalScoreVal.textContent = formatScore(gameState.score, false);
    }
    if (uiRefs.modalBestVal) {
      uiRefs.modalBestVal.textContent = formatScore(gameState.bestScore, false);
    }
    if (uiRefs.modalStageVal) {
      const meta = STAGE_META[gameState.stageIndex] || STAGE_META[0];
      uiRefs.modalStageVal.textContent = `LOOP ${Math.max(1, gameState.loop)} · ${meta.code}`;
    }
  }

  // 次フレームでフェードイン＆オプティカルセンター算出
  window.requestAnimationFrame(() => {
    if (!isModalOpen || !uiRefs.overlayModal) return;
    uiRefs.overlayModal.classList.remove('is-hidden');
    scheduleModalCentering();
  });
}

/**
 * オーバーレイモーダルを競合安全に閉じる（開閉競合防止ガード付き：第7章 7.3）
 * @param {boolean} [immediate=false]
 */
export function hideModal(immediate = false) {
  if (!uiRefs.overlayModal) return;

  if (modalHideTimerId !== null) {
    window.clearTimeout(modalHideTimerId);
    modalHideTimerId = null;
  }

  isModalOpen = false;
  uiRefs.overlayModal.classList.add('is-hidden');

  if (immediate) {
    uiRefs.overlayModal.style.display = 'none';
    return;
  }

  modalHideTimerId = window.setTimeout(() => {
    modalHideTimerId = null;
    if (!isModalOpen && uiRefs.overlayModal) {
      uiRefs.overlayModal.style.display = 'none';
    }
  }, 260);
}

/**
 * 3Dモデルロード完了後にローディング表示を隠し START ボタンを出現させる
 */
export function finishLoadingUI() {
  if (uiRefs.modalLoading) uiRefs.modalLoading.classList.add('is-hidden');
  if (uiRefs.btnStart) uiRefs.btnStart.classList.remove('is-hidden');
  scheduleModalCentering();
}

/**
 * ステージ開始・切替時の短時間バナーを表示
 * @param {number} stageIndex
 * @param {number} loopNum
 * @param {string} [customSub]
 */
export function showStageBanner(stageIndex, loopNum, customSub = '') {
  if (!uiRefs.stageBanner) return;

  if (bannerHideTimerId !== null) {
    window.clearTimeout(bannerHideTimerId);
    bannerHideTimerId = null;
  }

  const meta = STAGE_META[stageIndex] || STAGE_META[0];
  if (uiRefs.stageBannerCode) {
    uiRefs.stageBannerCode.textContent = `LOOP ${Math.max(1, loopNum)} · ${meta.name}`;
  }
  if (uiRefs.stageBannerSub) {
    uiRefs.stageBannerSub.textContent = customSub || meta.shortDesc;
  }

  uiRefs.stageBanner.classList.add('is-visible');
  bannerHideTimerId = window.setTimeout(() => {
    bannerHideTimerId = null;
    if (uiRefs.stageBanner) {
      uiRefs.stageBanner.classList.remove('is-visible');
    }
  }, 2200);
}

/**
 * ステージ遷移バナーを即時非表示
 */
export function hideStageBanner() {
  if (bannerHideTimerId !== null) {
    window.clearTimeout(bannerHideTimerId);
    bannerHideTimerId = null;
  }
  if (uiRefs.stageBanner) {
    uiRefs.stageBanner.classList.remove('is-visible');
  }
}

/* ============================================================================
 * 7. フローティングスコア予約キュー消費描画（XSS安全・二重回収・上限保護）
 * ========================================================================== */

/**
 * Tier 3 が pendingFloatTextQueue へ予約したフローティングテキストを一括生成・描画
 */
export function flushFloatTextQueue() {
  const count = pendingFloatTextQueue.count;
  if (count <= 0) return;

  const layer = uiRefs.floatLayer;
  if (!layer) {
    clearFloatTextQueue();
    return;
  }

  for (let i = 0; i < count; i++) {
    const item = pendingFloatTextQueue.items[i];
    if (!item || !item.text) continue;

    // 同時表示数上限を超えた古い要素を間引いてDOM肥大化を防止
    while (layer.childElementCount >= MAX_ACTIVE_FLOAT_NODES && layer.firstElementChild) {
      layer.removeChild(layer.firstElementChild);
    }

    const proj = projectWorldToScreen(item.wx, item.wy, 0.4, _floatProjOut);
    if (!proj.visible) continue;

    const el = document.createElement('div');
    const safeTone = escapeHTML(item.tone || 'amber').replace(/[^a-z]/g, '') || 'amber';
    el.className = `float-text tone-${safeTone}`;
    el.style.left = `${Math.round(proj.x)}px`;
    el.style.top = `${Math.round(proj.y)}px`;
    el.textContent = item.text;

    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      if (el.parentNode) el.parentNode.removeChild(el);
    };

    el.addEventListener('animationend', cleanup, { once: true });
    window.setTimeout(cleanup, 920);
    layer.appendChild(el);
  }

  clearFloatTextQueue();
}

/**
 * 表示中の全フローティングテキストを即時クリア（リトライ・ステージ切替用）
 */
export function clearFloatTexts() {
  clearFloatTextQueue();
  if (uiRefs.floatLayer) {
    uiRefs.floatLayer.innerHTML = '';
  }
}

/* ============================================================================
 * 8. 画面サイズ自動取得・自動調節（updateLayout：第7章 7.2 厳守）
 * ========================================================================== */

/**
 * iPhone WebView / 通常ブラウザの画面サイズ・セーフエリア・3Dレンダラー・カメラを一括同期
 * - キーボード展開中（INPUT / TEXTAREA フォーカス中）は Canvas 潰れ防止のため即スキップ
 * - --safe-top は PlatformDetector.isInAppWebView に応じて 52px / 8px へ厳密分岐
 * @param {{onAfterResize?: (sizeChanged: boolean) => void}} [options]
 * @returns {boolean} 画面サイズが変化した場合 true
 */
export function updateLayout(options = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  // キーボード展開中は Canvas を潰さない（第7章 7.2 必須ガード）
  const activeTag = document.activeElement ? document.activeElement.tagName : '';
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return false;

  const vv = window.visualViewport;
  const vw = Math.max(1, Math.floor(vv ? vv.width : window.innerWidth));
  const vh = Math.max(1, Math.floor(vv ? vv.height : window.innerHeight));
  const offsetTop = Math.round(vv ? vv.offsetTop : 0);
  const offsetLeft = Math.round(vv ? vv.offsetLeft : 0);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  const sizeChanged = Math.abs(vw - viewportState.w) > 1 || Math.abs(vh - viewportState.h) > 1;

  // ルートコンテナを visualViewport へ厳密同期
  if (uiRefs.appRoot) {
    uiRefs.appRoot.style.width = `${vw}px`;
    uiRefs.appRoot.style.height = `${vh}px`;
    uiRefs.appRoot.style.top = `${offsetTop}px`;
    uiRefs.appRoot.style.left = `${offsetLeft}px`;
  }

  // --safe-top / --safe-bottom の環境分岐（GRAVITY WebView 52px vs 通常ブラウザ 8px）
  const rootEl = document.documentElement;
  const topAddPx = PlatformDetector.isInAppWebView ? 52 : 8;
  const safeBottomMin = vh >= 812 ? 24 : 14;
  rootEl.style.setProperty('--safe-top', `calc(env(safe-area-inset-top, 0px) + ${topAddPx}px)`);
  rootEl.style.setProperty('--safe-bottom', `max(${safeBottomMin}px, env(safe-area-inset-bottom, 0px))`);

  // 実測した HUD・デッキ・セーフエリア高さを viewportState へ反映（camera.js が参照）
  const headerRect = uiRefs.headerEl ? uiRefs.headerEl.getBoundingClientRect() : null;
  const deckRect = uiRefs.controlsDeckEl ? uiRefs.controlsDeckEl.getBoundingClientRect() : null;

  viewportState.w = vw;
  viewportState.h = vh;
  viewportState.dpr = dpr;
  viewportState.safeTopPx = headerRect && headerRect.top > 0 ? Math.round(headerRect.top) : topAddPx;
  viewportState.topHudH = headerRect && headerRect.height > 0 ? Math.round(headerRect.height) : 30;
  viewportState.bottomDeckH = deckRect && deckRect.height > 0 ? Math.round(deckRect.height) : 136;
  viewportState.safeBottomPx = safeBottomMin;

  // Three.js カメラ ＆ レンダラー同期（DPR 上限 MAX_DPR = 2）
  if (world3D.renderer && world3D.camera) {
    world3D.camera.aspect = vw / Math.max(1, vh);
    world3D.camera.updateProjectionMatrix();
    world3D.renderer.setPixelRatio(dpr);
    world3D.renderer.setSize(vw, vh, false);
  }

  if (isModalOpen) {
    scheduleModalCentering();
  }

  if (typeof options.onAfterResize === 'function') {
    options.onAfterResize(sizeChanged);
  }

  return sizeChanged;
}