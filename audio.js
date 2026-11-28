/**
 * audio.js
 * @version v1.0 (Pure Web Audio API Dynamic Synth Engine - Phase 4)
 * @changes
 *   - Tone.js を完全撤廃し、外部音声ファイルゼロの Pure Web Audio API 動的波形合成エンジンを実装
 *   - 起動時デフォルト音量 OFF・ユーザー操作同期スタック内ハード初期化（1サンプル無音アンロック＋DynamicsCompressor＋iPhone帯域ローパス）を実装
 *   - suspended / interrupted 状態での通常発音完全遮断（復帰時爆音・ノード滞留防止）を実装
 *   - iOS WebKit 5経路自動復旧（visibilitychange/pagehide/blur・onstatechange・ゾンビcurrentTime監視・2段キャプチャ先行リカバリ・300msグレース期間）を実装
 *   - 15ms線形フェードミュート・種別スロットリング・ペア別クールダウン（200件上限自動パージ）・連続密度指数減衰・主役優先ダッキング・ノード自動disconnectを実装
 *   - 全14種SE（ジャンプ・パンチ・タル着地・粉砕・鉄カン・踏みつけ・ボーナス・ハイパー電池・ダメージ・落下・杭抜き・コンベア反転警告・ステージクリア・ゲームオーバー）を実装
 *
 * Tier 1 基盤モジュール：GRAVITY iOS WebKit 最適化 Pure Web Audio API 動的音響エンジン
 */

import { clamp, safeFinite } from './constants.js?v=1';

/* ============================================================================
 * 1. 定数・音量設計・iPhone 内蔵スピーカー帯域チューニング
 * ========================================================================== */

const MASTER_GAIN_TARGET = 0.78;
const SAFE_EXP_FLOOR = 0.0001;
const CONTEXT_GRACE_MS = 300;
const ZOMBIE_WALL_WINDOW_MS = 180;
const ZOMBIE_MIN_AUDIO_ADVANCE_SEC = 0.001;
const MUTE_FADE_SEC = 0.015;
const MUTE_SUSPEND_DELAY_MS = 25;

/** iPhone 内蔵スピーカー最適化：耳障りな 2.5〜4kHz のピークを和らげるマスターローパス */
const MASTER_LOWPASS_HZ = 2850;
/** 150Hz 未満の再生限界を補う低域ボディ折り返し閾値 */
const LOW_BODY_FOLD_HZ = 310;

/** ペア／ソース別クールダウン（物理衝突の微振動連打を根絶） */
const PAIR_COOLDOWN_MS = 650;
const PAIR_MAP_PURGE_THRESHOLD = 200;

/** 連続発音密度の指数減衰時定数（ms） */
const DENSITY_DECAY_MS = 450;

/** 主役音発生後の脇役音ダッキング係数 */
const DUCKING_GAIN_MUL = 0.35;

/** 種別最小発音間隔（ms） */
const MIN_INTERVAL_MS = Object.freeze({
  jump: 60,
  punch: 70,
  barrelDrop: 45,
  smash: 55,
  clang: 65,
  stomp: 60,
  bonus: 45,
  powerUp: 120,
  hurt: 120,
  fallDamage: 120,
  rivetPull: 70,
  conveyorWarn: 110,
  clear: 200,
  gameOver: 200
});

/* ============================================================================
 * 2. 内部ステート（単一 AudioContext ＆ 5経路復旧監視）
 * ========================================================================== */

let audioCtx = null;
let masterGain = null;
let masterFilter = null;
let masterCompressor = null;
let noiseBuffer = null;
let silentUnlockBuffer = null;

let soundEnabled = false; // 第6章 6.1 ＆ 設計書 v2.1 準拠：起動時デフォルト OFF
let needsAudioRecovery = false;
let pendingTouchendUnlock = false;
let contextCreatedAtMs = 0;
let muteFadeToken = 0;

/** ゾンビ AudioContext 監視（経路 5） */
let lastZombieCheckWallMs = 0;
let lastZombieAudioTimeSec = 0;

/** スロットリング・密度・ダッキング状態 */
const lastPlayedByType = Object.create(null);
const pairCooldownMap = new Map();
let collisionDensity = 0;
let lastDensityWallMs = 0;
let duckingUntilWallMs = 0;

/** 持続ループ管理用セット（拡張・離脱時一括停止用） */
const activeLoopHandles = new Set();

/** 外部リスナー多重登録防止フラグ */
let recoveryListenersBound = false;

/* ============================================================================
 * 3. 低レベル Web Audio ヘルパー（バッファキャッシュ・安全ランプ・ノード解放）
 * ========================================================================== */

/**
 * AudioContext コンストラクタ取得
 * @returns {typeof AudioContext|null}
 */
function getAudioContextCtor() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

/**
 * 現在時刻（ms）を安全に取得
 * @returns {number}
 */
function nowWallMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

/**
 * 1 サンプル無音バッファをキャッシュ生成し同期再生（iOS WebKit ハードアンロック）
 * @param {AudioContext} ctx
 */
function playSilentUnlockBuffer(ctx) {
  if (!ctx) return;
  try {
    if (!silentUnlockBuffer || silentUnlockBuffer.sampleRate !== ctx.sampleRate) {
      silentUnlockBuffer = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
    }
    const src = ctx.createBufferSource();
    src.buffer = silentUnlockBuffer;
    src.connect(ctx.destination);
    src.onended = () => {
      try { src.disconnect(); } catch (_e) {}
    };
    src.start(0);
  } catch (_err) {
    // 非対応・状態異常時は無視して継続
  }
}

/**
 * ホワイトノイズ AudioBuffer を AudioContext ごとに1回だけ生成して再利用
 * @param {AudioContext} ctx
 * @returns {AudioBuffer|null}
 */
function getCachedNoiseBuffer(ctx) {
  if (!ctx) return null;
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) {
    return noiseBuffer;
  }
  try {
    const sampleRate = ctx.sampleRate || 44100;
    const length = Math.floor(sampleRate * 0.6);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseBuffer = buffer;
    return noiseBuffer;
  } catch (_err) {
    return null;
  }
}

/**
 * 指数ランプの安全目標値ガード（0以下による RangeError を完全防止）
 * @param {number} val
 * @returns {number}
 */
function safeExpVal(val) {
  const v = safeFinite(val, SAFE_EXP_FLOOR);
  return v < SAFE_EXP_FLOOR ? SAFE_EXP_FLOOR : v;
}

/**
 * iPhone スピーカー帯域補正：低音域は完全五度下（2/3）を安全域へ折り返すボディ周波数を算出
 * @param {number} freq
 * @returns {number}
 */
function computeBodyFreq(freq) {
  const f = Math.max(80, safeFinite(freq, 220));
  if (f < LOW_BODY_FOLD_HZ) {
    // 150Hz 未満へ落ち込む場合は1オクターブ上へ折り返し聴感を維持
    const fifthBelow = f * (2 / 3);
    return fifthBelow < 155 ? f * 1.5 : fifthBelow;
  }
  return f * 0.5;
}

/**
 * 複数ノードをまとめて安全に disconnect する終了コールバック生成
 * @param {Array<AudioNode>} nodes
 * @returns {() => void}
 */
function createDisconnectHandler(nodes) {
  return () => {
    for (let i = 0; i < nodes.length; i++) {
      try {
        if (nodes[i] && typeof nodes[i].disconnect === 'function') {
          nodes[i].disconnect();
        }
      } catch (_e) {}
    }
  };
}

/**
 * 単発オシレータ発音ヘルパー（自動 disconnect・指数ランプ安全ガード付き）
 * @param {AudioContext} ctx
 * @param {AudioNode} dest
 * @param {object} opts
 */
function scheduleTone(ctx, dest, opts) {
  const startTime = Math.max(ctx.currentTime, safeFinite(opts.startTime, ctx.currentTime));
  const duration = Math.max(0.015, safeFinite(opts.duration, 0.12));
  const attack = Math.min(duration * 0.4, Math.max(0.002, safeFinite(opts.attack, 0.004)));
  const peakGain = clamp(safeFinite(opts.gain, 0.2), SAFE_EXP_FLOOR, 1.0);
  const startFreq = Math.max(60, safeFinite(opts.freq, 440));
  const endFreq = opts.endFreq !== undefined ? Math.max(60, safeFinite(opts.endFreq, startFreq)) : startFreq;

  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = opts.type || 'triangle';

  osc.frequency.setValueAtTime(startFreq, startTime);
  if (Math.abs(endFreq - startFreq) > 0.5) {
    osc.frequency.exponentialRampToValueAtTime(safeExpVal(endFreq), startTime + duration);
  }

  gainNode.gain.setValueAtTime(SAFE_EXP_FLOOR, startTime);
  gainNode.gain.linearRampToValueAtTime(peakGain, startTime + attack);
  gainNode.gain.exponentialRampToValueAtTime(SAFE_EXP_FLOOR, startTime + duration);

  const nodes = [osc, gainNode];
  if (opts.filterFreq && opts.filterFreq > 0) {
    const filter = ctx.createBiquadFilter();
    filter.type = opts.filterType || 'lowpass';
    filter.frequency.setValueAtTime(clamp(opts.filterFreq, 120, 8000), startTime);
    if (opts.filterQ) filter.Q.setValueAtTime(clamp(opts.filterQ, 0.2, 12), startTime);
    osc.connect(filter);
    filter.connect(gainNode);
    nodes.push(filter);
  } else {
    osc.connect(gainNode);
  }

  gainNode.connect(dest);
  osc.onended = createDisconnectHandler(nodes);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.012);
}

/**
 * 単発ノイズバースト発音ヘルパー（キャッシュ済みノイズバッファ使用・自動 disconnect）
 * @param {AudioContext} ctx
 * @param {AudioNode} dest
 * @param {object} opts
 */
function scheduleNoise(ctx, dest, opts) {
  const buf = getCachedNoiseBuffer(ctx);
  if (!buf) return;

  const startTime = Math.max(ctx.currentTime, safeFinite(opts.startTime, ctx.currentTime));
  const duration = Math.max(0.015, Math.min(0.55, safeFinite(opts.duration, 0.12)));
  const attack = Math.min(duration * 0.35, Math.max(0.002, safeFinite(opts.attack, 0.003)));
  const peakGain = clamp(safeFinite(opts.gain, 0.18), SAFE_EXP_FLOOR, 1.0);

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const filter = ctx.createBiquadFilter();
  filter.type = opts.filterType || 'bandpass';
  const fStart = clamp(safeFinite(opts.freq, 1200), 150, 5000);
  const fEnd = opts.endFreq !== undefined ? clamp(safeFinite(opts.endFreq, fStart), 150, 5000) : fStart;
  filter.frequency.setValueAtTime(fStart, startTime);
  if (Math.abs(fEnd - fStart) > 1) {
    filter.frequency.exponentialRampToValueAtTime(safeExpVal(fEnd), startTime + duration);
  }
  filter.Q.setValueAtTime(clamp(safeFinite(opts.q, 1.2), 0.3, 10), startTime);

  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(SAFE_EXP_FLOOR, startTime);
  gainNode.gain.linearRampToValueAtTime(peakGain, startTime + attack);
  gainNode.gain.exponentialRampToValueAtTime(SAFE_EXP_FLOOR, startTime + duration);

  src.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(dest);

  const nodes = [src, filter, gainNode];
  src.onended = createDisconnectHandler(nodes);
  src.start(startTime);
  src.stop(startTime + duration + 0.012);
}

/* ============================================================================
 * 4. 同期ハード初期化 ＆ マスターバス構築 ＆ 5経路自動復旧（第6章 6.1〜6.2）
 * ========================================================================== */

/**
 * 稼働中の持続音ループをすべて即座に停止・解放
 */
export function stopAllLoops() {
  activeLoopHandles.forEach((handle) => {
    try {
      if (handle && typeof handle.stop === 'function') {
        handle.stop();
      }
    } catch (_e) {}
  });
  activeLoopHandles.clear();
}

/**
 * 同期ハード初期化：旧 AudioContext を非同期破棄し、新規コンテキスト＋マスターバスを同期構築
 * ※必ずユーザー操作（touchstart / mousedown / click）の同期スタック内から呼ぶこと
 * @param {boolean} playConfirmTone ON ボタン押下時の専用確認音を鳴らすか
 * @returns {boolean}
 */
function hardInitAudioContext(playConfirmTone = false) {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return false;

  muteFadeToken += 1;
  stopAllLoops();

  // 旧コンテキストは await せず非同期 close() で即座に手放す
  const oldCtx = audioCtx;
  audioCtx = null;
  masterGain = null;
  masterFilter = null;
  masterCompressor = null;
  noiseBuffer = null;
  silentUnlockBuffer = null;

  if (oldCtx) {
    try {
      oldCtx.onstatechange = null;
      if (oldCtx.state !== 'closed') {
        oldCtx.close().catch(() => {});
      }
    } catch (_e) {}
  }

  try {
    const ctx = new Ctor();
    const gain = ctx.createGain();
    const lowpass = ctx.createBiquadFilter();
    const compressor = ctx.createDynamicsCompressor();

    gain.gain.setValueAtTime(MASTER_GAIN_TARGET, ctx.currentTime);

    // iPhone 内蔵スピーカーの刺さる高域を抑える穏やかなローパス
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(MASTER_LOWPASS_HZ, ctx.currentTime);
    lowpass.Q.setValueAtTime(0.7, ctx.currentTime);

    // 同時多発音による音割れを防ぐソフトリミッター
    compressor.threshold.setValueAtTime(-10, ctx.currentTime);
    compressor.knee.setValueAtTime(14, ctx.currentTime);
    compressor.ratio.setValueAtTime(6, ctx.currentTime);
    compressor.attack.setValueAtTime(0.004, ctx.currentTime);
    compressor.release.setValueAtTime(0.14, ctx.currentTime);

    gain.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(ctx.destination);

    audioCtx = ctx;
    masterGain = gain;
    masterFilter = lowpass;
    masterCompressor = compressor;

    const nowMs = nowWallMs();
    contextCreatedAtMs = nowMs;
    lastZombieCheckWallMs = nowMs;
    lastZombieAudioTimeSec = ctx.currentTime;
    needsAudioRecovery = false;

    // 経路 4：onstatechange による interrupted / suspended 即検知（300ms グレース保護付き）
    ctx.onstatechange = () => {
      if (audioCtx !== ctx || !soundEnabled) return;
      const elapsedSinceCreate = nowWallMs() - contextCreatedAtMs;
      if (elapsedSinceCreate < CONTEXT_GRACE_MS) return;
      if (ctx.state === 'interrupted' || ctx.state === 'suspended') {
        needsAudioRecovery = true;
      }
    };

    // 同期 resume() ＆ 1サンプル無音バッファ再生で iOS WebKit ハードアンロック
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
    }
    playSilentUnlockBuffer(ctx);

    // ON ボタン直後の確認音のみ、同期ハード初期化内から専用再生
    if (playConfirmTone) {
      const t = ctx.currentTime + 0.005;
      scheduleTone(ctx, gain, { type: 'triangle', freq: 587.33, endFreq: 587.33, duration: 0.07, gain: 0.22, startTime: t });
      scheduleTone(ctx, gain, { type: 'triangle', freq: 880.0, endFreq: 880.0, duration: 0.11, gain: 0.24, startTime: t + 0.055 });
    }

    return true;
  } catch (err) {
    console.warn('[Audio] Hard init failed:', err);
    return false;
  }
}

/**
 * ゾンビ AudioContext 監視（経路 5：running 扱いなのに currentTime が進まない無音バグ検知）
 * ※非ジェスチャー内では再構築せず、フラグのみ立てて次回タッチで安全復旧させる
 */
function checkZombieContext() {
  if (!audioCtx || !soundEnabled) return;
  const nowMs = nowWallMs();
  if (nowMs - contextCreatedAtMs < CONTEXT_GRACE_MS) {
    lastZombieCheckWallMs = nowMs;
    lastZombieAudioTimeSec = audioCtx.currentTime;
    return;
  }

  if (audioCtx.state !== 'running') return;

  const wallElapsed = nowMs - lastZombieCheckWallMs;
  if (wallElapsed >= ZOMBIE_WALL_WINDOW_MS) {
    const audioAdvance = audioCtx.currentTime - lastZombieAudioTimeSec;
    lastZombieCheckWallMs = nowMs;
    lastZombieAudioTimeSec = audioCtx.currentTime;
    if (audioAdvance < ZOMBIE_MIN_AUDIO_ADVANCE_SEC) {
      needsAudioRecovery = true;
    }
  }
}

/**
 * 通常効果音用の発音可能ゲート（第6章 6.1 厳守）
 * suspended / interrupted 中は resume() を試行しつつ必ず null を返して発音予約を完全遮断する
 * @returns {{ctx: AudioContext, dest: GainNode}|null}
 */
function getPlayableAudio() {
  if (!soundEnabled || !audioCtx || !masterGain) return null;

  checkZombieContext();
  if (needsAudioRecovery) return null;

  if (audioCtx.state !== 'running') {
    const elapsedSinceCreate = nowWallMs() - contextCreatedAtMs;
    if (elapsedSinceCreate >= CONTEXT_GRACE_MS) {
      needsAudioRecovery = true;
    }
    try {
      audioCtx.resume().catch(() => {});
    } catch (_e) {}
    return null;
  }

  return { ctx: audioCtx, dest: masterGain };
}

/**
 * 1段目キャプチャ先行リカバリ（touchstart / mousedown）
 * 音量ボタン自身は除外し、ゲーム操作より先にハード再構築を実行
 * @param {Event} e
 */
function handleCapturePointerStart(e) {
  if (!soundEnabled) return;
  const target = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
  if (target && target.closest('[data-audio-toggle="true"]')) return;

  const nowMs = nowWallMs();
  const inGrace = (nowMs - contextCreatedAtMs) < CONTEXT_GRACE_MS;

  if (!audioCtx || needsAudioRecovery || (!inGrace && audioCtx.state !== 'running')) {
    hardInitAudioContext(false);
    pendingTouchendUnlock = true;
  } else if (audioCtx.state !== 'running') {
    try { audioCtx.resume().catch(() => {}); } catch (_e) {}
    pendingTouchendUnlock = true;
  }
}

/**
 * 2段目キャプチャ先行リカバリ（touchend / click）
 * User Activation が最も通りやすい終了瞬間に既存 Context を壊さずダメ押しアンロック
 * @param {Event} e
 */
function handleCapturePointerEnd(e) {
  if (!soundEnabled || !pendingTouchendUnlock) return;
  const target = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
  if (target && target.closest('[data-audio-toggle="true"]')) return;

  pendingTouchendUnlock = false;
  if (!audioCtx) return;
  try {
    if (audioCtx.state !== 'running') {
      audioCtx.resume().catch(() => {});
    }
    playSilentUnlockBuffer(audioCtx);
    if (masterGain) {
      masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      masterGain.gain.setValueAtTime(MASTER_GAIN_TARGET, audioCtx.currentTime);
    }
  } catch (_err) {}
}

/**
 * 経路 1〜3：離脱（hidden / pagehide / blur）と復帰（visible / pageshow / focus）の監視
 */
function markBackgroundSuspended() {
  stopAllLoops();
  if (soundEnabled) {
    needsAudioRecovery = true;
  }
}

function attemptForegroundResume() {
  if (!soundEnabled || !audioCtx) return;
  try {
    if (audioCtx.state !== 'running') {
      audioCtx.resume().catch(() => {});
    }
  } catch (_e) {}
}

/**
 * iOS WebKit 5経路自動復旧イベントを単一登録
 */
export function bindAudioRecoveryEvents() {
  if (recoveryListenersBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  recoveryListenersBound = true;

  // 経路 1：visibilitychange
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      markBackgroundSuspended();
    } else {
      attemptForegroundResume();
    }
  });

  // 経路 2：pagehide / pageshow
  window.addEventListener('pagehide', markBackgroundSuspended);
  window.addEventListener('pageshow', attemptForegroundResume);

  // 経路 3：blur / focus
  window.addEventListener('blur', markBackgroundSuspended);
  window.addEventListener('focus', attemptForegroundResume);

  // 2段構えキャプチャ先行リカバリ（{ capture: true, passive: true }）
  window.addEventListener('touchstart', handleCapturePointerStart, { capture: true, passive: true });
  window.addEventListener('mousedown', handleCapturePointerStart, { capture: true, passive: true });
  window.addEventListener('touchend', handleCapturePointerEnd, { capture: true, passive: true });
  window.addEventListener('click', handleCapturePointerEnd, { capture: true, passive: true });
}

/* ============================================================================
 * 5. スロットリング・ペア別クールダウン・密度減衰・主役優先ダッキング（第6章 6.3）
 * ========================================================================== */

/**
 * 種別最小間隔スロットリング判定
 * @param {string} type
 * @returns {boolean} 再生許可なら true
 */
function allowByTypeInterval(type) {
  const nowMs = nowWallMs();
  const minGap = MIN_INTERVAL_MS[type] || 50;
  const prev = lastPlayedByType[type] || 0;
  if (nowMs - prev < minGap) return false;
  lastPlayedByType[type] = nowMs;
  return true;
}

/**
 * ペア／ソース別クールダウン（Map サイズ 200 超で期限切れ自動パージ）
 * @param {string|null|undefined} pairKey
 * @param {number} cooldownMs
 * @returns {boolean}
 */
function allowByPairCooldown(pairKey, cooldownMs = PAIR_COOLDOWN_MS) {
  if (!pairKey) return true;
  const nowMs = nowWallMs();

  if (pairCooldownMap.size > PAIR_MAP_PURGE_THRESHOLD) {
    pairCooldownMap.forEach((expireMs, key) => {
      if (expireMs <= nowMs) {
        pairCooldownMap.delete(key);
      }
    });
  }

  const until = pairCooldownMap.get(pairKey) || 0;
  if (nowMs < until) return false;
  pairCooldownMap.set(pairKey, nowMs + cooldownMs);
  return true;
}

/**
 * 連続発音密度を更新し、聴覚疲労を防ぐ音量スケール（0.45〜1.0）を返す
 * @returns {number}
 */
function computeDensityGainScale() {
  const nowMs = nowWallMs();
  const dtMs = Math.max(0, nowMs - lastDensityWallMs);
  lastDensityWallMs = nowMs;
  collisionDensity = collisionDensity * Math.exp(-dtMs / DENSITY_DECAY_MS) + 1;
  return clamp(1 / (1 + Math.max(0, collisionDensity - 1.5) * 0.22), 0.45, 1.0);
}

/**
 * 主役音再生時に脇役音ダッキング窓を設定
 * @param {number} durationMs
 */
function triggerLeadDucking(durationMs = 240) {
  const target = nowWallMs() + durationMs;
  if (target > duckingUntilWallMs) {
    duckingUntilWallMs = target;
  }
}

/**
 * 脇役音用のダッキング音量係数を取得
 * @returns {number}
 */
function getSupportDuckingScale() {
  return nowWallMs() < duckingUntilWallMs ? DUCKING_GAIN_MUL : 1.0;
}

/* ============================================================================
 * 6. 公開コントロール API（初期OFF・15msフェードミュート・切替）
 * ========================================================================== */

/**
 * 現在の音量有効状態を取得
 * @returns {boolean}
 */
export function isSoundEnabled() {
  return soundEnabled;
}

/**
 * 音量 ON / OFF を安全に切替（ON は同期ハード初期化、OFF は 15ms 線形フェード→25ms後 suspend）
 * @param {boolean} enabled
 * @returns {boolean} 切替後の状態
 */
export function setSoundEnabled(enabled) {
  const next = Boolean(enabled);
  if (next === soundEnabled) {
    if (next && (!audioCtx || needsAudioRecovery || audioCtx.state !== 'running')) {
      hardInitAudioContext(false);
    }
    return soundEnabled;
  }

  soundEnabled = next;
  muteFadeToken += 1;
  const currentToken = muteFadeToken;

  if (soundEnabled) {
    needsAudioRecovery = false;
    pendingTouchendUnlock = false;
    hardInitAudioContext(true);
  } else {
    stopAllLoops();
    needsAudioRecovery = false;
    pendingTouchendUnlock = false;
    const ctx = audioCtx;
    const gain = masterGain;
    if (ctx && gain) {
      try {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(Math.max(SAFE_EXP_FLOOR, gain.gain.value), now);
        gain.gain.linearRampToValueAtTime(SAFE_EXP_FLOOR, now + MUTE_FADE_SEC);
      } catch (_e) {}

      window.setTimeout(() => {
        if (muteFadeToken !== currentToken || soundEnabled) return;
        if (audioCtx === ctx && ctx.state === 'running') {
          try {
            ctx.suspend().catch(() => {});
          } catch (_e) {}
        }
      }, MUTE_SUSPEND_DELAY_MS);
    }
  }

  return soundEnabled;
}

/**
 * 音量トグル（音量ボタンの安全タップハンドラから同期呼び出し）
 * @returns {boolean} 切替後の soundEnabled
 */
export function toggleSound() {
  return setSoundEnabled(!soundEnabled);
}

/**
 * リトライ・ステージ切替時の音響内部状態クリーンアップ
 */
export function resetAudioRuntime() {
  stopAllLoops();
  pairCooldownMap.clear();
  collisionDensity = 0;
  duckingUntilWallMs = 0;
}

/* ============================================================================
 * 7. 全14種 動的波形合成効果音（レトロポップ × iPhoneスピーカー最適化）
 * ========================================================================== */

/** 1) ジャンプ */
export function playJump() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('jump')) return;
  const t = a.ctx.currentTime;
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 330, endFreq: 740, duration: 0.13, gain: 0.24, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'sine', freq: 523.25, endFreq: 880, duration: 0.10, gain: 0.12, startTime: t + 0.03 });
}

/** 2) パンチ（素振り・打撃初動） */
export function playPunch() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('punch')) return;
  const t = a.ctx.currentTime;
  const scale = computeDensityGainScale();
  scheduleNoise(a.ctx, a.dest, { filterType: 'bandpass', freq: 1450, endFreq: 520, q: 1.4, duration: 0.08, gain: 0.22 * scale, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'square', freq: 240, endFreq: 135, duration: 0.075, gain: 0.16 * scale, filterFreq: 950, startTime: t });
}

/** 3) タル着地（脇役音・ペア別クールダウン＆ダッキング対応） */
export function playBarrelDrop(sourceKey = null) {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('barrelDrop') || !allowByPairCooldown(sourceKey)) return;
  const t = a.ctx.currentTime;
  const mul = computeDensityGainScale() * getSupportDuckingScale();
  const bodyHz = computeBodyFreq(185);
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: bodyHz, endFreq: Math.max(120, bodyHz * 0.65), duration: 0.09, gain: 0.20 * mul, startTime: t });
  scheduleNoise(a.ctx, a.dest, { filterType: 'lowpass', freq: 880, endFreq: 380, q: 0.9, duration: 0.06, gain: 0.14 * mul, startTime: t });
}

/** 4) 粉砕（木タル・木箱・敵・ハイパー撃破：主役音） */
export function playSmash() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('smash')) return;
  triggerLeadDucking(220);
  const t = a.ctx.currentTime;
  const scale = computeDensityGainScale();
  scheduleNoise(a.ctx, a.dest, { filterType: 'bandpass', freq: 1800, endFreq: 420, q: 1.0, duration: 0.14, gain: 0.28 * scale, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'sawtooth', freq: 280, endFreq: 140, duration: 0.10, gain: 0.18 * scale, filterFreq: 1200, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 523.25, endFreq: 783.99, duration: 0.11, gain: 0.20 * scale, startTime: t + 0.025 });
}

/** 5) 鉄カン（通常パンチで鉄タルに弾かれた時の金属音） */
export function playClang() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('clang')) return;
  const t = a.ctx.currentTime;
  scheduleTone(a.ctx, a.dest, { type: 'square', freq: 1174.66, endFreq: 1120, duration: 0.09, gain: 0.15, filterFreq: 2400, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 1760.0, endFreq: 1680, duration: 0.12, gain: 0.16, startTime: t + 0.008 });
}

/** 6) 踏みつけ（巡回敵ストンプ：主役音） */
export function playStomp() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('stomp')) return;
  triggerLeadDucking(180);
  const t = a.ctx.currentTime;
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 440, endFreq: 660, duration: 0.075, gain: 0.24, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 660, endFreq: 987.77, duration: 0.12, gain: 0.24, startTime: t + 0.055 });
}

/** 7) ボーナス（タル飛び越え・コイン取得） */
export function playBonus() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('bonus')) return;
  const t = a.ctx.currentTime;
  const scale = computeDensityGainScale();
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 880.0, endFreq: 880.0, duration: 0.075, gain: 0.20 * scale, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 1318.51, endFreq: 1318.51, duration: 0.14, gain: 0.22 * scale, startTime: t + 0.055 });
}

/** 8) ハイパー電池取得（無敵パワーアップ：主役音） */
export function playPowerUp() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('powerUp')) return;
  triggerLeadDucking(320);
  const t = a.ctx.currentTime;
  const freqs = [523.25, 659.25, 783.99, 1046.5, 1318.51];
  for (let i = 0; i < freqs.length; i++) {
    scheduleTone(a.ctx, a.dest, {
      type: i === freqs.length - 1 ? 'square' : 'triangle',
      freq: freqs[i],
      endFreq: freqs[i],
      duration: i === freqs.length - 1 ? 0.20 : 0.09,
      gain: i === freqs.length - 1 ? 0.18 : 0.22,
      filterFreq: 2400,
      startTime: t + i * 0.055
    });
  }
}

/** 9) 被ダメージ（接触ダメージ：主役音） */
export function playHurt() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('hurt')) return;
  triggerLeadDucking(260);
  const t = a.ctx.currentTime;
  scheduleTone(a.ctx, a.dest, { type: 'sawtooth', freq: 310, endFreq: 165, duration: 0.12, gain: 0.22, filterFreq: 1300, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'square', freq: 220, endFreq: 145, duration: 0.15, gain: 0.18, filterFreq: 980, startTime: t + 0.08 });
}

/** 10) 落下ダメージ（高所落下・奈落落下からの1ダメージ復帰：主役音） */
export function playFallDamage() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('fallDamage')) return;
  triggerLeadDucking(280);
  const t = a.ctx.currentTime;
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 520, endFreq: 175, duration: 0.24, gain: 0.24, startTime: t });
  scheduleNoise(a.ctx, a.dest, { filterType: 'lowpass', freq: 920, endFreq: 280, q: 1.0, duration: 0.12, gain: 0.20, startTime: t + 0.14 });
}

/** 11) 100m 杭抜き（重厚なボルト引き抜き＋達成チャイム：主役音） */
export function playRivetPull() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('rivetPull')) return;
  triggerLeadDucking(220);
  const t = a.ctx.currentTime;
  scheduleTone(a.ctx, a.dest, { type: 'square', freq: 293.66, endFreq: 587.33, duration: 0.09, gain: 0.18, filterFreq: 1800, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'triangle', freq: 739.99, endFreq: 1174.66, duration: 0.14, gain: 0.22, startTime: t + 0.06 });
}

/** 12) 50m コンベア反転警告（脇役音・ダッキング対象） */
export function playConveyorWarn() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('conveyorWarn')) return;
  const t = a.ctx.currentTime;
  const mul = getSupportDuckingScale();
  scheduleTone(a.ctx, a.dest, { type: 'square', freq: 622.25, endFreq: 622.25, duration: 0.055, gain: 0.11 * mul, filterFreq: 1700, startTime: t });
  scheduleTone(a.ctx, a.dest, { type: 'square', freq: 466.16, endFreq: 466.16, duration: 0.065, gain: 0.11 * mul, filterFreq: 1700, startTime: t + 0.075 });
}

/** 13) ステージクリア／周回クリアファンファーレ（主役音） */
export function playClear(isLoopClear = false) {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('clear')) return;
  triggerLeadDucking(360);
  const t = a.ctx.currentTime;
  const notes = isLoopClear
    ? [
        [523.25, 0.00, 0.10],
        [659.25, 0.09, 0.10],
        [783.99, 0.18, 0.10],
        [1046.50, 0.28, 0.14],
        [783.99, 0.43, 0.10],
        [1046.50, 0.54, 0.16],
        [1318.51, 0.70, 0.28]
      ]
    : [
        [523.25, 0.00, 0.10],
        [659.25, 0.10, 0.10],
        [783.99, 0.20, 0.10],
        [1046.50, 0.32, 0.14],
        [783.99, 0.46, 0.10],
        [1046.50, 0.58, 0.24]
      ];

  for (let i = 0; i < notes.length; i++) {
    const [freq, offset, dur] = notes[i];
    scheduleTone(a.ctx, a.dest, {
      type: 'triangle',
      freq,
      endFreq: freq,
      duration: dur,
      gain: 0.24,
      startTime: t + offset
    });
  }
}

/** 14) ゲームオーバー終幕音（主役音） */
export function playGameOver() {
  const a = getPlayableAudio();
  if (!a || !allowByTypeInterval('gameOver')) return;
  triggerLeadDucking(360);
  const t = a.ctx.currentTime;
  const notes = [
    [392.00, 0.00, 0.15],
    [369.99, 0.16, 0.15],
    [349.23, 0.32, 0.16],
    [329.63, 0.50, 0.34]
  ];
  for (let i = 0; i < notes.length; i++) {
    const [freq, offset, dur] = notes[i];
    scheduleTone(a.ctx, a.dest, {
      type: 'triangle',
      freq,
      endFreq: i === notes.length - 1 ? freq * 0.94 : freq,
      duration: dur,
      gain: 0.23,
      startTime: t + offset
    });
  }
}

/* ============================================================================
 * 8. 統合オブジェクトエクスポート（既存呼び出し規約との親和性確保）
 * ========================================================================== */

export const sound = Object.freeze({
  isEnabled: isSoundEnabled,
  setEnabled: setSoundEnabled,
  toggle: toggleSound,
  bindRecovery: bindAudioRecoveryEvents,
  stopAllLoops,
  resetRuntime: resetAudioRuntime,
  playJump,
  playPunch,
  playBarrelDrop,
  playSmash,
  playClang,
  playStomp,
  playBonus,
  playPowerUp,
  playHurt,
  playFallDamage,
  playRivetPull,
  playConveyorWarn,
  playClear,
  playGameOver
});