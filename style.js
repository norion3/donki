/**
 * style.js
 * @version v1.0 (Self-Contained iOS WebKit Mask & Minimal SVG UI Styles - Phase 11)
 * @changes
 *   - Tailwind CDN を完全撤廃し、main.js から同期実行する自律スタイル注入関数 injectStyles() を実装
 *   - マスター設計書v5.0.0準拠の iOS WebKit 完全マスク CSS（<input>/<textarea> 入力許可例外＆16px 自動ズーム防止付き）を実装
 *   - Canvas 上の GPU フリーズ要因となる backdrop-filter を完全排除し、純粋半透明 rgba() 設計へ統一
 *   - 改訂設計書v2.1準拠の上段 30px スコア専用極薄 HUD（ボタンなし・tabular-nums）と 3px 極細ハイパー電池ゲージを定義
 *   - 下段スリム操作デッキ（左：文字なしミニマル仮想ジョグ／中央最下端 z-index:60：自前SVG音量＆リスタート／右：文字なし自前SVGパンチ＆ジャンプ）と iPhone SE〜Pro Max 向けレスポンシブ最適化を定義
 *   - オプティカルセンター動的カード配置対応のオーバーレイモーダル（ラバーバンド遮断付き）・ステージバナー・フローティングスコア7色トーンを定義
 *
 * Tier 4 UIモジュール：外部CSSフレームワーク非依存の自己完結スタイルシート注入
 */

/* ============================================================================
 * 1. 定数
 * ========================================================================== */

/** 注入する <style> 要素の一意ID（多重注入防止） */
export const STYLE_ELEMENT_ID = 'rtdk-injected-styles';

/* ============================================================================
 * 2. 自己完結 CSS 本文（backdrop-filter 完全禁止・iOS WebKit 最適化済み）
 * ========================================================================== */

const APP_CSS = `
/* --------------------------------------------------------------------------
 * 1) iOS WebKit 完全マスク ＆ ルート固定（第7章 7.1 厳守）
 * -------------------------------------------------------------------------- */
:root {
  --safe-top: calc(env(safe-area-inset-top, 0px) + 52px);
  --safe-bottom: max(20px, env(safe-area-inset-bottom, 0px));
  --hud-height: 30px;
  --deck-height: 112px;
  --accent-amber: #fbbf24;
  --accent-orange: #f97316;
  --accent-cyan: #38bdf8;
  --accent-pink: #f472b6;
  --accent-rose: #fb7185;
  --accent-emerald: #34d399;
}

*, *::before, *::after {
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}

input, textarea {
  user-select: text;
  -webkit-user-select: text;
  touch-action: manipulation;
  font-size: 16px;
}

html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: fixed;
  top: 0;
  left: 0;
  overscroll-behavior: none;
  -webkit-overscroll-behavior: none;
  background-color: #0f172a;
  color: #f8fafc;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* --------------------------------------------------------------------------
 * 2) アプリルートコンテナ ＆ 3D キャンバス
 * -------------------------------------------------------------------------- */
#app-root {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: #0f172a;
  touch-action: none;
}

#game-canvas-container {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  touch-action: none;
}

#game-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  outline: none;
}

/* --------------------------------------------------------------------------
 * 3) ハイパー電池発光フレーム ＆ フローティングスコアレイヤー
 * -------------------------------------------------------------------------- */
#power-frame {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 10;
  opacity: 0;
  transition: opacity 0.25s ease;
  box-shadow: inset 0 0 32px rgba(250, 204, 21, 0.52);
}

#power-frame.is-active {
  opacity: 1;
}

#float-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 35;
  overflow: hidden;
}

.float-text {
  position: absolute;
  pointer-events: none;
  font-weight: 900;
  font-size: 16px;
  letter-spacing: 0.02em;
  line-height: 1;
  white-space: nowrap;
  text-shadow: 0 2px 5px rgba(0, 0, 0, 0.92), 0 0 8px rgba(0, 0, 0, 0.55);
  transform: translate(-50%, -50%);
  animation: rtdkFloatUp 0.85s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  will-change: transform, opacity;
}

.float-text.tone-amber   { color: #fcd34d; font-size: 17px; }
.float-text.tone-sky     { color: #7dd3fc; font-size: 15px; }
.float-text.tone-yellow  { color: #fef08a; font-size: 19px; }
.float-text.tone-rose    { color: #fda4af; font-size: 18px; }
.float-text.tone-emerald { color: #6ee7b7; font-size: 18px; }
.float-text.tone-pink    { color: #f9a8d4; font-size: 20px; }
.float-text.tone-purple  { color: #d8b4fe; font-size: 14px; }

@keyframes rtdkFloatUp {
  0%   { opacity: 0; transform: translate(-50%, -25%) scale(0.65); }
  18%  { opacity: 1; transform: translate(-50%, -62%) scale(1.12); }
  100% { opacity: 0; transform: translate(-50%, -165%) scale(0.96); }
}

/* --------------------------------------------------------------------------
 * 4) 上段 HUD（高さ 30px・スコア等表示専用・操作ボタンなし：設計書v2.1）
 * -------------------------------------------------------------------------- */
#game-header {
  position: absolute;
  top: var(--safe-top);
  left: 0;
  right: 0;
  z-index: 50;
  padding: 0 10px;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.hud-bar {
  width: 100%;
  max-width: 440px;
  height: var(--hud-height);
  padding: 0 10px;
  border-radius: 15px;
  background-color: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.hud-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex-shrink: 0;
}

#hud-stage {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.04em;
  color: #fbbf24;
  background-color: rgba(251, 191, 36, 0.14);
  border: 1px solid rgba(251, 191, 36, 0.28);
  padding: 2px 6px;
  border-radius: 8px;
  line-height: 1.1;
  white-space: nowrap;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}

#hud-hearts {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.hud-heart-svg {
  width: 14px;
  height: 14px;
  display: block;
  transition: transform 0.18s ease, opacity 0.18s ease;
}

.hud-heart-svg.is-lost {
  opacity: 0.25;
  transform: scale(0.86);
}

#hud-score-wrap {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.hud-score-label {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #94a3b8;
  flex-shrink: 0;
}

#hud-score {
  font-size: 15px;
  font-weight: 900;
  color: #ffffff;
  letter-spacing: 0.03em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  white-space: nowrap;
}

#hud-bonus-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.hud-timer-svg {
  width: 13px;
  height: 13px;
  display: block;
  color: #38bdf8;
  flex-shrink: 0;
}

#hud-bonus {
  font-size: 12px;
  font-weight: 900;
  color: #7dd3fc;
  min-width: 34px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  white-space: nowrap;
}

#hud-bonus.is-low {
  color: #fb7185;
}

/* ハイパー電池 3px 極細ゲージ（HUDバー直下） */
#power-bar-wrap {
  width: calc(100% - 24px);
  max-width: 416px;
  height: 3px;
  margin-top: 3px;
  border-radius: 9999px;
  background-color: rgba(15, 23, 42, 0.85);
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.16s ease;
}

#power-bar-wrap.is-visible {
  opacity: 1;
}

#power-bar {
  width: 100%;
  height: 100%;
  border-radius: 9999px;
  background: linear-gradient(90deg, #fef08a 0%, #fbbf24 55%, #f97316 100%);
  transform-origin: left center;
}

/* --------------------------------------------------------------------------
 * 5) ステージ遷移バナー（短時間通知・非遮蔽）
 * -------------------------------------------------------------------------- */
#stage-banner {
  position: absolute;
  top: calc(var(--safe-top) + var(--hud-height) + 14px);
  left: 50%;
  transform: translateX(-50%) translateY(-8px);
  z-index: 40;
  pointer-events: none;
  padding: 6px 14px;
  border-radius: 9999px;
  background-color: rgba(15, 23, 42, 0.86);
  border: 1px solid rgba(251, 191, 36, 0.45);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  text-align: center;
  opacity: 0;
  transition: opacity 0.24s ease, transform 0.24s ease;
  white-space: nowrap;
}

#stage-banner.is-visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

#stage-banner-code {
  display: block;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.08em;
  color: #fde047;
  line-height: 1.15;
}

#stage-banner-sub {
  display: block;
  font-size: 10px;
  font-weight: 700;
  color: #cbd5e1;
  margin-top: 2px;
}

/* --------------------------------------------------------------------------
 * 6) 下段操作デッキ（スリム＆文字なしミニマルUI：設計書v2.1）
 * -------------------------------------------------------------------------- */
#controls-deck {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 25;
  height: calc(var(--deck-height) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  background: linear-gradient(to top, rgba(2, 6, 23, 0.88) 0%, rgba(15, 23, 42, 0.46) 68%, rgba(15, 23, 42, 0) 100%);
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  pointer-events: none;
}

/* 左手エリア：文字なしミニマル仮想ジョグ（左端 0〜144px 透明反応ゾーン） */
#jog-zone {
  position: relative;
  width: 144px;
  height: var(--deck-height);
  flex-shrink: 0;
  pointer-events: auto;
  touch-action: none;
}

#jog-base {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 98px;
  height: 98px;
  border-radius: 9999px;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle at 35% 35%, rgba(255, 255, 255, 0.12), rgba(15, 23, 42, 0.48));
  border: 1.5px solid rgba(255, 255, 255, 0.24);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.38), inset 0 0 14px rgba(56, 189, 248, 0.12);
  pointer-events: none;
}

#jog-knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 42px;
  height: 42px;
  border-radius: 9999px;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle at 32% 30%, rgba(248, 250, 252, 0.92), rgba(148, 163, 184, 0.86) 68%, rgba(71, 85, 105, 0.92));
  border: 1.5px solid rgba(255, 255, 255, 0.78);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.55);
  pointer-events: none;
}

/* 外周4方向の極小ドット（4px・傾け方向のみ淡く発光） */
.jog-dot {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 9999px;
  background-color: rgba(255, 255, 255, 0.28);
  pointer-events: none;
  transition: background-color 0.08s ease, transform 0.08s ease;
}

.jog-dot-up    { top: 7px;    left: 50%; transform: translateX(-50%); }
.jog-dot-down  { bottom: 7px; left: 50%; transform: translateX(-50%); }
.jog-dot-left  { left: 7px;   top: 50%;  transform: translateY(-50%); }
.jog-dot-right { right: 7px;  top: 50%;  transform: translateY(-50%); }

.jog-dot.is-lit {
  background-color: #7dd3fc;
  box-shadow: 0 0 6px rgba(56, 189, 248, 0.9);
}

/* 右手エリア：文字なしカスタムSVGパンチ(60px) ＆ ジャンプ(72px) */
#right-controls {
  position: relative;
  width: 146px;
  height: var(--deck-height);
  flex-shrink: 0;
  pointer-events: auto;
  touch-action: none;
}

.action-btn {
  position: absolute;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  touch-action: none;
  transition: transform 0.06s ease, box-shadow 0.06s ease, filter 0.08s ease;
  box-shadow: 0 5px 0 rgba(0, 0, 0, 0.42), 0 8px 16px rgba(0, 0, 0, 0.34), inset 0 1.5px 2px rgba(255, 255, 255, 0.42);
}

/* 透明 Hit Slop（見た目を邪魔せず快適タップ領域を確保） */
.action-btn::after {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 9999px;
}

.action-btn.pressed {
  transform: translateY(3px) scale(0.93);
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.42), 0 4px 8px rgba(0, 0, 0, 0.32), inset 0 2px 4px rgba(0, 0, 0, 0.25);
  filter: brightness(1.16);
}

#btn-punch {
  left: 4px;
  top: 6px;
  width: 60px;
  height: 60px;
  background: radial-gradient(circle at 30% 28%, rgba(251, 191, 36, 0.92), rgba(234, 88, 12, 0.88) 72%, rgba(185, 28, 28, 0.90));
  border: 2px solid rgba(254, 243, 199, 0.78);
  color: #ffffff;
}

#btn-jump {
  right: 8px;
  bottom: 8px;
  width: 72px;
  height: 72px;
  background: radial-gradient(circle at 30% 28%, rgba(56, 189, 248, 0.92), rgba(37, 99, 235, 0.88) 72%, rgba(67, 56, 202, 0.90));
  border: 2px solid rgba(224, 242, 254, 0.82);
  color: #ffffff;
}

.action-btn-svg {
  pointer-events: none;
  display: block;
}

#btn-punch .action-btn-svg {
  width: 28px;
  height: 28px;
}

#btn-jump .action-btn-svg {
  width: 32px;
  height: 32px;
}

/* --------------------------------------------------------------------------
 * 7) 下段中央最下端ユーティリティドック（音量＆リスタート・自前SVG・z-index:60）
 * -------------------------------------------------------------------------- */
#utility-dock {
  position: absolute;
  left: 50%;
  bottom: calc(var(--safe-bottom) + 6px);
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  pointer-events: auto;
  touch-action: none;
}

.util-btn {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 9999px;
  background-color: rgba(15, 23, 42, 0.78);
  border: 1.5px solid rgba(148, 163, 184, 0.34);
  color: #94a3b8;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  touch-action: none;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.40);
  transition: transform 0.08s ease, border-color 0.14s ease, color 0.14s ease, background-color 0.14s ease;
}

/* 44px 相当の透明 Hit Slop（SE 375px でも左右操作域と完全絶縁） */
.util-btn::after {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 9999px;
}

.util-btn.pressed {
  transform: scale(0.90);
  background-color: rgba(30, 41, 59, 0.92);
}

#btn-sound.is-on {
  color: #38bdf8;
  border-color: rgba(56, 189, 248, 0.65);
  background-color: rgba(12, 34, 58, 0.86);
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.28), 0 3px 10px rgba(0, 0, 0, 0.40);
}

#btn-quick-reset {
  color: #cbd5e1;
}

.util-btn.is-hidden {
  display: none;
}

.util-btn-svg {
  width: 17px;
  height: 17px;
  display: block;
  pointer-events: none;
}

/* --------------------------------------------------------------------------
 * 8) タイトル / 読み込み / リザルト オーバーレイモーダル（第7章 7.3 準拠）
 *    ※ backdrop-filter 完全禁止・オプティカルセンター動的 padding-top 対応
 * -------------------------------------------------------------------------- */
#overlay-modal {
  position: absolute;
  inset: 0;
  z-index: 45;
  background-color: rgba(8, 13, 26, 0.78);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: calc(var(--safe-top) + 52px) 18px calc(var(--safe-bottom) + 54px);
  opacity: 1;
  transition: opacity 0.24s ease;
  touch-action: none;
  overscroll-behavior: none;
}

#overlay-modal.is-hidden {
  opacity: 0;
  pointer-events: none;
}

.modal-card {
  width: 100%;
  max-width: 344px;
  background: linear-gradient(180deg, rgba(30, 41, 59, 0.96) 0%, rgba(15, 23, 42, 0.98) 100%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 24px;
  padding: 20px 18px 18px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.62);
  text-align: center;
  position: relative;
  overflow: hidden;
  touch-action: none;
}

.modal-badge {
  display: inline-block;
  padding: 3px 11px;
  border-radius: 9999px;
  background-color: rgba(251, 191, 36, 0.16);
  border: 1px solid rgba(251, 191, 36, 0.42);
  color: #fcd34d;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.10em;
  margin-bottom: 8px;
}

.modal-title {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: -0.01em;
  color: #ffffff;
  line-height: 1.2;
}

.modal-desc {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.55;
  color: #cbd5e1;
}

.modal-desc strong {
  font-weight: 800;
}

.modal-desc .hl-sky   { color: #7dd3fc; }
.modal-desc .hl-amber { color: #fcd34d; }
.modal-desc .hl-pink  { color: #f9a8d4; }

/* リザルト統計ブロック */
#modal-stats {
  background-color: rgba(2, 6, 23, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 16px;
  padding: 11px 14px;
  margin-bottom: 14px;
}

#modal-stats.is-hidden {
  display: none;
}

.modal-stat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modal-stat-row + .modal-stat-row {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.modal-stat-label {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.06em;
  color: #94a3b8;
}

#modal-score-val {
  font-size: 20px;
  font-weight: 900;
  color: #fbbf24;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}

#modal-best-val {
  font-size: 14px;
  font-weight: 900;
  color: #7dd3fc;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}

#modal-stage-val {
  font-size: 12px;
  font-weight: 800;
  color: #e2e8f0;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}

/* 遊び方 3カラムミニガイド（タイトル時のみ表示） */
#modal-guide {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  margin-bottom: 14px;
}

#modal-guide.is-hidden {
  display: none;
}

.modal-guide-item {
  background-color: rgba(2, 6, 23, 0.56);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}

.modal-guide-icon {
  width: 22px;
  height: 22px;
  display: block;
}

.modal-guide-name {
  font-size: 11px;
  font-weight: 900;
  line-height: 1.1;
}

.modal-guide-name.c-amber  { color: #fcd34d; }
.modal-guide-name.c-purple { color: #d8b4fe; }
.modal-guide-name.c-yellow { color: #fde047; }

.modal-guide-sub {
  font-size: 9.5px;
  font-weight: 700;
  color: #94a3b8;
  line-height: 1.1;
}

/* ローディング表示 */
#modal-loading {
  padding: 10px 0;
  font-size: 13px;
  font-weight: 800;
  color: #7dd3fc;
  letter-spacing: 0.04em;
  animation: rtdkPulse 1.2s ease-in-out infinite;
}

#modal-loading.is-hidden {
  display: none;
}

@keyframes rtdkPulse {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1.0; }
}

/* スタート／リトライ CTA ボタン（<div role="button">） */
#btn-start {
  width: 100%;
  padding: 13px 18px;
  border-radius: 16px;
  background: linear-gradient(90deg, #fbbf24 0%, #f97316 52%, #f43f5e 100%);
  border: 1.5px solid rgba(255, 255, 255, 0.32);
  box-shadow: 0 8px 20px rgba(249, 115, 22, 0.34);
  color: #ffffff;
  font-size: 16px;
  font-weight: 900;
  letter-spacing: 0.05em;
  text-align: center;
  cursor: pointer;
  touch-action: none;
  transition: transform 0.08s ease, filter 0.10s ease;
}

#btn-start.pressed {
  transform: scale(0.96);
  filter: brightness(1.1);
}

#btn-start.is-hidden {
  display: none;
}

/* --------------------------------------------------------------------------
 * 9) 端末サイズ別レスポンシブ最適化（iPhone SE 375px / Pro Max 430px / 低高画面）
 * -------------------------------------------------------------------------- */
@media (max-width: 380px) {
  :root {
    --deck-height: 98px;
  }

  #jog-zone {
    width: 136px;
  }

  #jog-base {
    width: 90px;
    height: 90px;
  }

  #jog-knob {
    width: 38px;
    height: 38px;
  }

  #right-controls {
    width: 138px;
  }

  #btn-punch {
    left: 2px;
    top: 4px;
    width: 58px;
    height: 58px;
  }

  #btn-jump {
    right: 6px;
    bottom: 6px;
    width: 70px;
    height: 70px;
  }
}

@media (min-width: 420px) {
  #jog-zone {
    width: 152px;
  }

  #jog-base {
    width: 100px;
    height: 100px;
  }

  #right-controls {
    width: 152px;
  }
}

@media (max-height: 560px) {
  :root {
    --deck-height: 88px;
  }

  #jog-zone {
    width: 126px;
  }

  #jog-base {
    width: 80px;
    height: 80px;
  }

  #jog-knob {
    width: 34px;
    height: 34px;
  }

  #right-controls {
    width: 132px;
  }

  #btn-punch {
    top: 3px;
    width: 48px;
    height: 48px;
  }

  #btn-jump {
    bottom: 4px;
    width: 58px;
    height: 58px;
  }

  #btn-punch .action-btn-svg {
    width: 22px;
    height: 22px;
  }

  #btn-jump .action-btn-svg {
    width: 26px;
    height: 26px;
  }

  .modal-card {
    padding: 14px 14px 12px;
  }

  .modal-title {
    font-size: 19px;
  }
}
`;

/* ============================================================================
 * 3. スタイル同期注入 API（main.js 冒頭で mountDOM() より前に必ず実行）
 * ========================================================================== */

/**
 * アプリケーション用自己完結スタイルシートを <head> へ同期注入する
 * 既に注入済みの場合は安全にスキップする
 * @returns {boolean} 新規注入した場合 true
 */
export function injectStyles() {
  if (typeof document === 'undefined' || !document.head) return false;
  if (document.getElementById(STYLE_ELEMENT_ID)) return false;

  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ELEMENT_ID;
  styleEl.textContent = APP_CSS;
  document.head.appendChild(styleEl);
  return true;
}