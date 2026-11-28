/**
 * world.js
 * @version v1.0 (3D Scene, Dynamic 4-Stage Builder, WebGL Loss Guard & Entity Spawners - Phase 6)
 * @changes
 *   - Three.js シーン・カメラ・レンダラー・RoomEnvironment・ライティング（プレイヤー追従シャドウカメラ）構築を実装
 *   - iOS WebKit バックグラウンド放置対策の WebGL コンテキストロスト防護（webglcontextlost / webglcontextrestored）を実装
 *   - 高層4ステージ動的3D地形構築（25m 6層＋左フラット付6F＆タル山＆オイル炉、50m 反転コンベア視覚帯＆電動伸縮はしご、75m 循環リフト＆シャフト＆奈落分離土台、100m ピラミッド＆貫通杭穴プラグ＆中央崩落セグメント）を実装
 *   - 3体キャラクター（プレイヤー／巨大赤ボス／桜ピンクヒロイン）構築および GLTF 非同期ロード（8.5秒タイムアウト＆フォールバックロボット保証）を実装
 *   - O(1) 事前確保パーティクルメッシュプール（96個・ゼロアロケーション再利用）と全エンティティスポナー・安全破棄を実装
 *
 * Tier 2 機構モジュール：3Dワールド構築・ステージ切替・キャラクター管理・パーティクル＆エンティティ生成
 */

import {
  ROBOT_GLTF_URL,
  CAMERA_FOV,
  MAX_DPR,
  STAGE_WIDTH_HALF,
  safeFinite,
  clamp,
  lerp
} from './constants.js?v=1';

import {
  getFloorY,
  getLadderExtensionRatio,
  getElevatorPlatformY
} from './stages.js?v=1';

import {
  gameState,
  player,
  bossCtrl,
  stageRuntime,
  viewportState,
  entities,
  swapRemoveAt
} from './world_state.js?v=1';

import {
  THREE,
  getSharedGeometry,
  getSharedBoxGeo,
  getSharedCylinderGeo,
  getSharedStandardMat,
  getSharedBasicMat,
  disposeHierarchy,
  getParticleGeometry,
  getParticleMaterial,
  createBarrelMesh,
  createEnemyMesh,
  createFireballMesh,
  createEnergyCanMesh,
  createJackMesh,
  createRivetMesh,
  createCrateMesh,
  createPickupMesh,
  createFurnaceMesh,
  createGoalRingMesh,
  createPlayerAuraMesh,
  createFallbackRobot,
  tintRobotModel,
  AnimController
} from './materials.js?v=1';

import { GLTFLoader } from 'https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'https://esm.sh/three@0.160.0/examples/jsm/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'https://esm.sh/three@0.160.0/examples/jsm/utils/SkeletonUtils.js';

/* ============================================================================
 * 1. 共有 3D ワールド参照（単一オブジェクトへ集約・他モジュールから安全参照）
 * ========================================================================== */

export const world3D = {
  scene: null,
  camera: null,
  renderer: null,
  containerEl: null,
  dirLight: null,
  pmremGenerator: null,
  envTexture: null,

  /** ルートシーングループ */
  stageGroup: null,
  entityGroup: null,
  particleGroup: null,
  playerGroup: null,
  bossGroup: null,
  friendGroup: null,

  /** キャラクターアニメーション・オーラ参照 */
  playerAnim: null,
  bossAnim: null,
  friendAnim: null,
  playerAura: null,
  cachedGltf: null,

  /** ステージ動的ビジュアル参照（ステージ切替時に一括クリア） */
  goalRingMesh: null,
  furnaceFlames: [],
  conveyorVisuals: [],
  collapsibleSegments: [],
  rivetPlugMap: new Map()
};

let isWorldInitialized = false;
let contextLostCallback = null;
let contextRestoredCallback = null;

/* ============================================================================
 * 2. O(1) パーティクルメッシュプール（GCスパイク根絶・第5章 5.1 準拠）
 * ========================================================================== */

const MAX_PARTICLES = 96;
const particleFreeList = [];
const particleAllMeshes = [];

/**
 * 事前確保パーティクルメッシュプールを初期化（初回起動時のみ96メッシュ生成）
 */
function initParticlePool() {
  particleFreeList.length = 0;
  particleAllMeshes.length = 0;
  if (!world3D.particleGroup) return;

  const geo = getParticleGeometry();
  const defaultMat = getParticleMaterial(0xfbbf24);

  for (let i = 0; i < MAX_PARTICLES; i++) {
    const mesh = new THREE.Mesh(geo, defaultMat);
    mesh.visible = false;
    world3D.particleGroup.add(mesh);
    particleAllMeshes.push(mesh);
    particleFreeList.push(mesh);
  }
}

/**
 * 稼働中の全パーティクルを即時プールへ返却（ステージ切替・リトライ用）
 */
export function clearParticles() {
  for (let i = 0; i < entities.particles.length; i++) {
    const p = entities.particles[i];
    if (p && p.mesh) {
      p.mesh.visible = false;
      particleFreeList.push(p.mesh);
      p.mesh = null;
    }
  }
  entities.particles.length = 0;
}

/**
 * パーティクルを O(1) プールから放出（ゼロメッシュ新規生成）
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} colorHex
 * @param {number} count
 * @param {number} speed
 */
export function spawnParticles(x, y, z, colorHex, count = 12, speed = 5.0) {
  if (!world3D.particleGroup) return;
  const sx = safeFinite(x, 0);
  const sy = safeFinite(y, 0);
  const sz = safeFinite(z, 0);
  const spdBase = Math.max(0.5, safeFinite(speed, 5.0));
  const mat = getParticleMaterial(colorHex);
  const spawnNum = Math.min(Math.max(1, Math.floor(count)), particleFreeList.length);

  for (let i = 0; i < spawnNum; i++) {
    const mesh = particleFreeList.pop();
    if (!mesh) break;

    mesh.material = mat;
    mesh.position.set(sx, sy, sz);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.setScalar(1);
    mesh.visible = true;

    const angle = Math.random() * Math.PI * 2;
    const spd = (0.35 + Math.random() * 0.85) * spdBase;
    const maxLife = 0.36 + Math.random() * 0.28;

    entities.particles.push({
      mesh,
      vx: Math.cos(angle) * spd,
      vy: Math.abs(Math.sin(angle)) * spd + 1.8,
      vz: (Math.random() - 0.5) * spd * 0.7,
      life: maxLife,
      maxLife
    });
  }
}

/**
 * 全パーティクルを固定/描画ステップで更新し、寿命切れを O(1) スワップ削除でプール返却
 * @param {number} dt 秒
 */
export function updateParticles(dt) {
  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  if (safeDt <= 0 || entities.particles.length === 0) return;

  for (let i = entities.particles.length - 1; i >= 0; i--) {
    const p = entities.particles[i];
    p.life -= safeDt;
    if (p.life <= 0) {
      if (p.mesh) {
        p.mesh.visible = false;
        particleFreeList.push(p.mesh);
      }
      swapRemoveAt(entities.particles, i);
      continue;
    }

    p.vy -= 16.0 * safeDt;
    const m = p.mesh;
    if (m) {
      m.position.x += p.vx * safeDt;
      m.position.y += p.vy * safeDt;
      m.position.z += p.vz * safeDt;
      m.rotation.x += safeDt * 9.0;
      m.rotation.y += safeDt * 7.0;
      const s = Math.max(0.02, p.life / p.maxLife);
      m.scale.setScalar(s);
    }
  }
}

/* ============================================================================
 * 3. Three.js シーン・ライティング・WebGLコンテキストロスト防護（第4章 4.1）
 * ========================================================================== */

/**
 * 環境マップ（RoomEnvironment）を安全に構築・適用
 */
function buildSceneEnvironment() {
  if (!world3D.renderer || !world3D.scene) return;
  try {
    if (world3D.envTexture) {
      world3D.envTexture.dispose();
      world3D.envTexture = null;
    }
    if (world3D.pmremGenerator) {
      world3D.pmremGenerator.dispose();
      world3D.pmremGenerator = null;
    }
    const pmrem = new THREE.PMREMGenerator(world3D.renderer);
    const roomEnv = new RoomEnvironment();
    const rt = pmrem.fromScene(roomEnv, 0.04);
    world3D.pmremGenerator = pmrem;
    world3D.envTexture = rt.texture;
    world3D.scene.environment = rt.texture;
    roomEnv.dispose();
  } catch (err) {
    console.warn('[World] RoomEnvironment skipped:', err);
  }
}

/**
 * Three.js ワールドを一括初期化してコンテナへ Canvas をマウント
 * @param {HTMLElement} containerEl
 * @param {{onContextLost?: () => void, onContextRestored?: () => void}} callbacks
 * @returns {typeof world3D}
 */
export function initWorld(containerEl, callbacks = {}) {
  if (isWorldInitialized) return world3D;
  isWorldInitialized = true;

  world3D.containerEl = containerEl;
  contextLostCallback = typeof callbacks.onContextLost === 'function' ? callbacks.onContextLost : null;
  contextRestoredCallback = typeof callbacks.onContextRestored === 'function' ? callbacks.onContextRestored : null;

  const w = Math.max(1, viewportState.w || window.innerWidth || 390);
  const h = Math.max(1, viewportState.h || window.innerHeight || 844);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  scene.fog = new THREE.Fog(0x0f172a, 38, 92);

  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, w / Math.max(1, h), 0.1, 160);
  camera.position.set(0, 8.6, 30);
  camera.lookAt(0, 7.45, 0);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false
  });
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.id = 'game-canvas';

  if (containerEl) {
    containerEl.innerHTML = '';
    containerEl.appendChild(renderer.domElement);
  }

  // ライティング（金属装甲・鉄骨・ヒロインが見映えする3点構成）
  const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.38);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 2.15);
  dirLight.position.set(10, 24, 16);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  // プレイヤー周辺追従シャドウカメラ範囲（第5章 5.3 準拠）
  dirLight.shadow.camera.left = -10;
  dirLight.shadow.camera.right = 10;
  dirLight.shadow.camera.top = 12;
  dirLight.shadow.camera.bottom = -10;
  dirLight.shadow.camera.near = 2;
  dirLight.shadow.camera.far = 52;
  dirLight.shadow.bias = -0.0005;
  scene.add(dirLight);
  scene.add(dirLight.target);

  const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.9);
  rimLight.position.set(-10, 14, -10);
  scene.add(rimLight);

  // 構造グループ生成
  const stageGroup = new THREE.Group();
  const entityGroup = new THREE.Group();
  const particleGroup = new THREE.Group();
  const playerGroup = new THREE.Group();
  const bossGroup = new THREE.Group();
  const friendGroup = new THREE.Group();

  scene.add(stageGroup);
  scene.add(entityGroup);
  scene.add(particleGroup);
  scene.add(playerGroup);
  scene.add(bossGroup);
  scene.add(friendGroup);

  world3D.scene = scene;
  world3D.camera = camera;
  world3D.renderer = renderer;
  world3D.dirLight = dirLight;
  world3D.stageGroup = stageGroup;
  world3D.entityGroup = entityGroup;
  world3D.particleGroup = particleGroup;
  world3D.playerGroup = playerGroup;
  world3D.bossGroup = bossGroup;
  world3D.friendGroup = friendGroup;

  buildSceneEnvironment();
  initParticlePool();

  // WebGL コンテキストロスト防護（第4章 4.1：iOS バックグラウンド復帰時の黒画面対策）
  const canvasEl = renderer.domElement;
  canvasEl.addEventListener('webglcontextlost', (e) => {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    gameState.isContextLost = true;
    console.warn('[World] WebGL context lost detected.');
    if (contextLostCallback) contextLostCallback();
  }, false);

  canvasEl.addEventListener('webglcontextrestored', () => {
    gameState.isContextLost = false;
    console.info('[World] WebGL context restored. Rebuilding environment.');
    buildSceneEnvironment();
    if (stageRuntime.stageDef) {
      buildStageWorld(stageRuntime.stageDef);
    }
    if (contextRestoredCallback) contextRestoredCallback();
  }, false);

  return world3D;
}

/**
 * DirectionalLight のシャドウカメラをプレイヤー周辺へ毎フレーム追従させる（第5章 5.3）
 */
export function updateShadowCameraFollow() {
  const light = world3D.dirLight;
  if (!light) return;
  const px = clamp(safeFinite(player.x, 0), -4.0, 4.0);
  const py = clamp(safeFinite(player.y, 4.0), 1.0, 14.5);
  light.position.set(px + 9.0, py + 14.0, 16.0);
  light.target.position.set(px, py, 0);
  light.target.updateMatrixWorld();
}

/**
 * 1フレーム分の 3D シーン描画を実行（コンテキストロスト時は安全スキップ）
 */
export function renderScene() {
  if (gameState.isContextLost) return;
  if (!world3D.renderer || !world3D.scene || !world3D.camera) return;
  try {
    world3D.renderer.render(world3D.scene, world3D.camera);
  } catch (err) {
    console.warn('[World] Render error:', err);
  }
}

/* ============================================================================
 * 4. 3D キャラクター構築 ＆ 非同期 GLTF ロード（8.5秒タイムアウト保証）
 * ========================================================================== */

/**
 * プレイヤー・巨大赤ボス・桜ピンクヒロインの 3D モデルを構築
 * @param {object|null} gltf
 */
export function setupCharactersFromGltf(gltf) {
  if (!world3D.playerGroup || !world3D.bossGroup || !world3D.friendGroup) return;

  // 旧ミキサー＆非共有リソースの確実解放
  if (world3D.playerAnim) { world3D.playerAnim.dispose(); world3D.playerAnim = null; }
  if (world3D.bossAnim) { world3D.bossAnim.dispose(); world3D.bossAnim = null; }
  if (world3D.friendAnim) { world3D.friendAnim.dispose(); world3D.friendAnim = null; }

  disposeHierarchy(world3D.playerGroup);
  disposeHierarchy(world3D.bossGroup);
  disposeHierarchy(world3D.friendGroup);
  world3D.playerGroup.clear();
  world3D.bossGroup.clear();
  world3D.friendGroup.clear();

  world3D.cachedGltf = gltf || null;

  if (gltf && gltf.scene) {
    // 1) プレイヤー（イエローロボット）
    const pModel = SkeletonUtils.clone(gltf.scene);
    pModel.scale.setScalar(0.25);
    pModel.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    world3D.playerGroup.add(pModel);
    world3D.playerAnim = new AnimController(pModel, gltf.animations || []);
    world3D.playerAnim.play('Idle', { force: true });

    // 2) 巨大赤ボス
    const bModel = SkeletonUtils.clone(gltf.scene);
    bModel.scale.setScalar(0.54);
    tintRobotModel(bModel, { mode: 'boss' });
    world3D.bossGroup.add(bModel);
    world3D.bossAnim = new AnimController(bModel, gltf.animations || []);
    world3D.bossAnim.play('Idle', { force: true });

    // 3) 桜ピンク×パールホワイト ヒロインロボット
    const fModel = SkeletonUtils.clone(gltf.scene);
    fModel.scale.setScalar(0.23);
    tintRobotModel(fModel, { mode: 'heroine' });
    world3D.friendGroup.add(fModel);
    world3D.friendAnim = new AnimController(fModel, gltf.animations || []);
    world3D.friendAnim.play('Wave', { force: true });
  } else {
    // フォールバックモデル（通信断・タイムアウト時も完全動作）
    const pFb = createFallbackRobot(0xf59e0b, 0xfef3c7);
    pFb.scale.setScalar(0.27);
    world3D.playerGroup.add(pFb);

    const bFb = createFallbackRobot(0xdc2626, 0x334155);
    bFb.scale.setScalar(0.54);
    world3D.bossGroup.add(bFb);

    const fFb = createFallbackRobot(0xf9a8d4, 0xfff1f5);
    fFb.scale.setScalar(0.25);
    world3D.friendGroup.add(fFb);
  }

  // ハイパー電池オーラをプレイヤーへ装着
  const aura = createPlayerAuraMesh();
  world3D.playerAura = aura;
  world3D.playerGroup.add(aura);
}

/**
 * GLTF ロボットモデルを非同期ロード（8.5秒タイムアウト＋フォールバック完全保護）
 * @param {(usedFallback: boolean) => void} onComplete
 */
export function loadRobotCharacters(onComplete) {
  let finished = false;
  const finishOnce = (gltf, usedFallback) => {
    if (finished) return;
    finished = true;
    window.clearTimeout(fallbackTimer);
    setupCharactersFromGltf(gltf);
    if (typeof onComplete === 'function') {
      onComplete(usedFallback);
    }
  };

  const fallbackTimer = window.setTimeout(() => {
    console.warn('[World] GLTF load timeout, using fallback robot.');
    finishOnce(null, true);
  }, 8500);

  try {
    const loader = new GLTFLoader();
    loader.load(
      ROBOT_GLTF_URL,
      (gltf) => finishOnce(gltf, false),
      undefined,
      (err) => {
        console.warn('[World] GLTF load failed, using fallback robot:', err);
        finishOnce(null, true);
      }
    );
  } catch (err) {
    console.warn('[World] GLTF loader exception, using fallback robot:', err);
    finishOnce(null, true);
  }
}

/**
 * 3体キャラクターのアニメーションミキサーを更新
 * @param {number} dt 秒
 */
export function updateCharacterAnimations(dt) {
  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  if (world3D.playerAnim) world3D.playerAnim.update(safeDt);
  if (world3D.bossAnim) world3D.bossAnim.update(safeDt);
  if (world3D.friendAnim) world3D.friendAnim.update(safeDt);
}

/**
 * ステージ初期配置へプレイヤー・ボス・ヒロインの3Dトランスフォームを即時同期
 * @param {object} stageDef
 */
export function syncInitialCharacterTransforms(stageDef) {
  if (!stageDef) return;
  if (world3D.playerGroup) {
    world3D.playerGroup.visible = true;
    world3D.playerGroup.position.set(player.x, player.y, 0);
    world3D.playerGroup.rotation.set(0, player.facing > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
  }
  if (world3D.playerAura) {
    world3D.playerAura.visible = false;
  }

  if (world3D.bossGroup) {
    world3D.bossGroup.visible = true;
    world3D.bossGroup.position.set(bossCtrl.x, bossCtrl.y, 0);
    world3D.bossGroup.rotation.set(0, bossCtrl.rotY, 0);
  }

  if (world3D.friendGroup && stageDef.heroine) {
    world3D.friendGroup.visible = true;
    world3D.friendGroup.position.set(stageDef.heroine.x, stageDef.heroine.y, 0);
    world3D.friendGroup.rotation.set(0, -0.30, 0);
  }

  if (world3D.playerAnim) world3D.playerAnim.play('Idle', { force: true });
  if (world3D.friendAnim) world3D.friendAnim.play('Wave', { force: true });
  if (world3D.bossAnim) {
    const bossInitAnim = bossCtrl.mode === 'patrol_boss' || bossCtrl.mode === 'rivet_boss' ? 'Walking' : 'Idle';
    world3D.bossAnim.play(bossInitAnim, { force: true });
  }
}

/* ============================================================================
 * 5. 高層4ステージ 3D ジオメトリ動的構築 ＆ 安全破棄
 * ========================================================================== */

/**
 * 単一の鉄骨ビーム区間メッシュを生成して親グループへ追加
 * @param {THREE.Group} parent
 * @param {number} x0
 * @param {number} x1
 * @param {number} y0
 * @param {number} y1
 * @param {number} colorHex
 * @param {boolean} isGoalFloor
 * @param {boolean} isConveyor
 * @returns {THREE.Group}
 */
function buildBeamSegment(parent, x0, x1, y0, y1, colorHex, isGoalFloor, isConveyor) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.max(0.05, Math.hypot(dx, dy));
  const angle = Math.atan2(dy, dx);
  const cx = (x0 + x1) * 0.5;
  const cy = (y0 + y1) * 0.5;

  const beamGroup = new THREE.Group();
  beamGroup.position.set(cx, cy - 0.17, 0);
  beamGroup.rotation.z = angle;

  const beamMat = getSharedStandardMat(`beam_${colorHex}`, {
    color: colorHex,
    roughness: 0.42,
    metalness: 0.35
  });
  const trimColor = isGoalFloor ? 0xfef3c7 : (isConveyor ? 0xbae6fd : 0xfda4af);
  const trimMat = getSharedStandardMat(`trim_${trimColor}`, {
    color: trimColor,
    roughness: 0.3,
    metalness: 0.5
  });

  // メイン鉄骨デッキ
  const deck = new THREE.Mesh(getSharedBoxGeo(len, 0.34, 1.78), beamMat);
  deck.castShadow = true;
  deck.receiveShadow = true;
  beamGroup.add(deck);

  // 上部エッジの明るい視認ライン
  const topStrip = new THREE.Mesh(getSharedBoxGeo(len, 0.055, 1.84), trimMat);
  topStrip.position.y = 0.155;
  beamGroup.add(topStrip);

  // 前面の斜めトラス飾り
  const segCount = Math.max(2, Math.floor(len / 1.05));
  const strutGeo = getSharedBoxGeo(0.095, 0.30, 0.095);
  const strutMat = getSharedStandardMat('beam_strut_dark', { color: 0x0f172a, metalness: 0.6, roughness: 0.4 });
  for (let s = 0; s < segCount; s++) {
    const sx = -len * 0.5 + (s + 0.5) * (len / segCount);
    const strut = new THREE.Mesh(strutGeo, strutMat);
    strut.position.set(sx, 0, 0.90);
    strut.rotation.z = s % 2 === 0 ? 0.55 : -0.55;
    beamGroup.add(strut);
  }

  parent.add(beamGroup);
  return beamGroup;
}

/**
 * 100m ステージ用のフロア分割構築（抜いた杭の場所が本物の穴になり、中央が崩落可能）
 * @param {object} fl
 * @param {Array<object>} stageRivets
 */
function buildRivetCapableFloor(fl, stageRivets) {
  const floorRivets = [];
  for (let i = 0; i < stageRivets.length; i++) {
    if (stageRivets[i].floorIdx === fl.id) {
      floorRivets.push(stageRivets[i]);
    }
  }
  floorRivets.sort((a, b) => a.x - b.x);

  const center = fl.collapsibleCenter;
  const cuts = [fl.xMin];
  for (let i = 0; i < floorRivets.length; i++) {
    const r = floorRivets[i];
    cuts.push(r.x - r.holeHalfWidth, r.x + r.holeHalfWidth);
  }
  if (center) {
    cuts.push(center.xMin, center.xMax);
  }
  cuts.push(fl.xMax);

  // 昇順ソート＆近接重複統合
  cuts.sort((a, b) => a - b);
  const uniq = [cuts[0]];
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - uniq[uniq.length - 1] > 0.02) {
      uniq.push(cuts[i]);
    }
  }

  for (let i = 0; i < uniq.length - 1; i++) {
    const segMin = uniq[i];
    const segMax = uniq[i + 1];
    const segMid = (segMin + segMax) * 0.5;
    const y0 = getFloorY(fl, segMin);
    const y1 = getFloorY(fl, segMax);

    // 杭プラグ区間か判定
    let matchedRivet = null;
    for (let rIdx = 0; rIdx < floorRivets.length; rIdx++) {
      const r = floorRivets[rIdx];
      if (Math.abs(segMid - r.x) < r.holeHalfWidth * 0.9) {
        matchedRivet = r;
        break;
      }
    }

    if (matchedRivet) {
      // 杭が刺さっている間だけ床を埋めるプラグメッシュ（抜くと非表示になり本物の穴が開く）
      const plugGroup = buildBeamSegment(
        world3D.stageGroup,
        segMin,
        segMax,
        y0,
        y1,
        0xfde047,
        false,
        false
      );
      world3D.rivetPlugMap.set(matchedRivet.id, plugGroup);
      continue;
    }

    // 中央崩落区間か判定
    const isCenter = Boolean(center && segMid > center.xMin + 0.02 && segMid < center.xMax - 0.02);
    const segGroup = buildBeamSegment(
      world3D.stageGroup,
      segMin,
      segMax,
      y0,
      y1,
      fl.color,
      false,
      false
    );
    if (isCenter) {
      world3D.collapsibleSegments.push({
        group: segGroup,
        baseY: segGroup.position.y,
        vy: 0,
        rotSpeed: (Math.random() - 0.5) * 2.4,
        falling: false
      });
    }
  }
}

/**
 * 50m コンベアフロアの移動マーカー帯を構築
 * @param {object} fl
 */
function buildConveyorVisualStrip(fl) {
  const chevrons = [];
  const count = 9;
  const span = fl.xMax - fl.xMin - 0.8;
  const markerGeo = getSharedBoxGeo(0.28, 0.06, 1.48);
  const normalMat = getSharedBasicMat('conveyor_slat_cyan', { color: 0x7dd3fc });
  const warnMat = getSharedBasicMat('conveyor_slat_warn', { color: 0xfacc15 });

  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(markerGeo, normalMat);
    const startX = fl.xMin + 0.4 + (i / count) * span;
    mesh.position.set(startX, fl.yLeft + 0.015, 0);
    world3D.stageGroup.add(mesh);
    chevrons.push(mesh);
  }

  world3D.conveyorVisuals.push({
    floorIdx: fl.id,
    xMin: fl.xMin + 0.35,
    xMax: fl.xMax - 0.35,
    y: fl.yLeft + 0.015,
    chevrons,
    normalMat,
    warnMat
  });
}

/**
 * 固定はしご・50m 電動伸縮はしごの 3D ジオメトリを構築
 * @param {object} lad
 * @param {number} ladIndex
 */
function buildLadderGeometry(lad, ladIndex) {
  const h = Math.max(0.5, lad.yTop - lad.yBottom);
  const isRetract = Boolean(lad.retractable);

  const railMat = isRetract
    ? getSharedStandardMat('ladder_retract_rail', {
        color: 0xfacc15,
        emissive: 0xd97706,
        emissiveIntensity: 0.35,
        metalness: 0.55,
        roughness: 0.3
      })
    : getSharedStandardMat('ladder_rail', {
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.25,
        metalness: 0.5,
        roughness: 0.3
      });

  const rungMat = isRetract
    ? getSharedStandardMat('ladder_retract_rung', { color: 0xfef08a, metalness: 0.45, roughness: 0.3 })
    : getSharedStandardMat('ladder_rung', { color: 0xe0f2fe, metalness: 0.4, roughness: 0.35 });

  const ladRoot = new THREE.Group();
  ladRoot.position.set(lad.x, lad.yBottom, -0.34);

  if (!isRetract) {
    // 固定はしご
    const railGeo = getSharedCylinderGeo(0.048, 0.048, h + 0.14, 8);
    [-0.27, 0.27].forEach((rx) => {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(rx, h * 0.5, 0);
      ladRoot.add(rail);
    });

    const rungGeo = getSharedGeometry('ladder_rung_cyl', () => {
      const g = new THREE.CylinderGeometry(0.036, 0.036, 0.56, 8);
      g.rotateZ(Math.PI / 2);
      return g;
    });
    const rungCount = Math.max(4, Math.floor(h / 0.38));
    for (let r = 0; r < rungCount; r++) {
      const ry = 0.20 + (r / rungCount) * (h - 0.26);
      const rung = new THREE.Mesh(rungGeo, rungMat);
      rung.position.set(0, ry, 0);
      ladRoot.add(rung);
    }
    world3D.stageGroup.add(ladRoot);
  } else {
    // 50m 電動伸縮はしご：下部35%は固定、上部65%が上下スライド
    const lowerH = h * 0.38;
    const upperH = h * 0.68;

    const lowerRailGeo = getSharedCylinderGeo(0.054, 0.054, lowerH, 8);
    [-0.29, 0.29].forEach((rx) => {
      const rail = new THREE.Mesh(lowerRailGeo, railMat);
      rail.position.set(rx, lowerH * 0.5, 0);
      ladRoot.add(rail);
    });

    const rungGeo = getSharedGeometry('ladder_rung_cyl', () => {
      const g = new THREE.CylinderGeometry(0.036, 0.036, 0.56, 8);
      g.rotateZ(Math.PI / 2);
      return g;
    });
    const lowerRungs = Math.max(2, Math.floor(lowerH / 0.38));
    for (let r = 0; r < lowerRungs; r++) {
      const rung = new THREE.Mesh(rungGeo, rungMat);
      rung.position.set(0, 0.18 + (r / lowerRungs) * (lowerH - 0.22), 0);
      ladRoot.add(rung);
    }

    // 上部スライド可動部
    const slideGroup = new THREE.Group();
    const upperRailGeo = getSharedCylinderGeo(0.044, 0.044, upperH, 8);
    [-0.25, 0.25].forEach((rx) => {
      const rail = new THREE.Mesh(upperRailGeo, railMat);
      rail.position.set(rx, upperH * 0.5, 0);
      slideGroup.add(rail);
    });

    const upperRungs = Math.max(3, Math.floor(upperH / 0.38));
    for (let r = 0; r < upperRungs; r++) {
      const rung = new THREE.Mesh(rungGeo, rungMat);
      rung.position.set(0, 0.18 + (r / upperRungs) * (upperH - 0.22), 0);
      slideGroup.add(rung);
    }

    ladRoot.add(slideGroup);
    world3D.stageGroup.add(ladRoot);

    stageRuntime.retractableLadders.push({
      ladderIndex: ladIndex,
      ladder: lad,
      slideGroup,
      minSlideY: 0,
      maxSlideY: h - upperH + 0.06,
      ratio: 1.0
    });
  }
}

/**
 * 75m 循環エレベーターのガイドシャフトと各リフト台を構築
 * @param {object} shaft
 */
function buildElevatorShaft(shaft) {
  const span = Math.max(1.0, shaft.yMax - shaft.yMin);
  const midY = (shaft.yMin + shaft.yMax) * 0.5;

  // 縦ガイドレール 2本（奥側）
  const guideMat = getSharedStandardMat('elev_guide_rail', {
    color: 0x475569,
    metalness: 0.7,
    roughness: 0.35
  });
  const guideGeo = getSharedCylinderGeo(0.045, 0.045, span + 0.4, 8);
  [-0.42, 0.42].forEach((gx) => {
    const rail = new THREE.Mesh(guideGeo, guideMat);
    rail.position.set(shaft.x + gx, midY, -0.45);
    world3D.stageGroup.add(rail);
  });

  // 上下プーリー（循環滑車）
  const pulleyGeo = getSharedCylinderGeo(0.24, 0.24, 0.22, 12);
  const pulleyMat = getSharedStandardMat(`elev_pulley_${shaft.color}`, {
    color: shaft.color,
    emissive: shaft.color,
    emissiveIntensity: 0.3,
    metalness: 0.6,
    roughness: 0.3
  });
  [shaft.yMin, shaft.yMax].forEach((py) => {
    const p = new THREE.Mesh(pulleyGeo, pulleyMat);
    p.rotation.x = Math.PI / 2;
    p.position.set(shaft.x, py, -0.45);
    world3D.stageGroup.add(p);
  });

  // 循環する昇降プラットフォーム群
  const platGeo = getSharedBoxGeo(shaft.width, 0.26, 1.56);
  const platMat = getSharedStandardMat(`elev_plat_${shaft.color}`, {
    color: shaft.color,
    emissive: shaft.color,
    emissiveIntensity: 0.28,
    metalness: 0.5,
    roughness: 0.3
  });
  const trimGeo = getSharedBoxGeo(shaft.width + 0.04, 0.05, 1.60);
  const trimMat = getSharedStandardMat('elev_plat_trim', { color: 0xf8fafc, roughness: 0.3 });

  for (let i = 0; i < shaft.platformCount; i++) {
    const pGroup = new THREE.Group();
    const deck = new THREE.Mesh(platGeo, platMat);
    deck.position.y = -0.13;
    deck.castShadow = true;
    deck.receiveShadow = true;
    pGroup.add(deck);

    const trim = new THREE.Mesh(trimGeo, trimMat);
    trim.position.y = -0.01;
    pGroup.add(trim);

    const initY = getElevatorPlatformY(shaft, i, 0, 1.0);
    pGroup.position.set(shaft.x, initY, 0);
    world3D.stageGroup.add(pGroup);

    stageRuntime.elevatorPlatforms.push({
      shaftId: shaft.id,
      shaft,
      platformIndex: i,
      x: shaft.x,
      width: shaft.width,
      halfWidth: shaft.width * 0.5,
      y: initY,
      prevY: initY,
      mesh: pGroup
    });
  }
}

/**
 * 既存のステージ地形・エンティティ・パーティクルの 3D メッシュをすべて安全解放
 */
export function clearStageWorld() {
  clearParticles();

  if (world3D.entityGroup) {
    disposeHierarchy(world3D.entityGroup);
    world3D.entityGroup.clear();
  }
  if (world3D.stageGroup) {
    disposeHierarchy(world3D.stageGroup);
    world3D.stageGroup.clear();
  }

  world3D.goalRingMesh = null;
  world3D.furnaceFlames.length = 0;
  world3D.conveyorVisuals.length = 0;
  world3D.collapsibleSegments.length = 0;
  world3D.rivetPlugMap.clear();
  stageRuntime.retractableLadders.length = 0;
  stageRuntime.elevatorPlatforms.length = 0;
}

/**
 * 指定ステージ定義から高層 3D 地形をまるごと動的構築
 * @param {object} stageDef
 */
export function buildStageWorld(stageDef) {
  if (!stageDef || !world3D.stageGroup || !world3D.scene) return;

  clearStageWorld();

  // ステージ別テーマ背景色＆霧色同期
  const bgColor = stageDef.themeBg || 0x0f172a;
  world3D.scene.background.setHex(bgColor);
  if (world3D.scene.fog) {
    world3D.scene.fog.color.setHex(bgColor);
  }

  // 1) ベース土台（75m は奈落を見せるため左右端下のみ配置）
  const baseMat = getSharedStandardMat('stage_base_mat', {
    color: 0x1e293b,
    roughness: 0.85,
    metalness: 0.25
  });
  if (stageDef.hasAbyss) {
    const leftBase = new THREE.Mesh(getSharedBoxGeo(3.1, 1.4, 3.2), baseMat);
    leftBase.position.set(-4.35, -0.78, 0);
    leftBase.receiveShadow = true;
    world3D.stageGroup.add(leftBase);

    const rightBase = new THREE.Mesh(getSharedBoxGeo(3.1, 1.4, 3.2), baseMat);
    rightBase.position.set(4.35, -0.38, 0);
    rightBase.receiveShadow = true;
    world3D.stageGroup.add(rightBase);
  } else {
    const base = new THREE.Mesh(getSharedBoxGeo(12.2, 1.2, 3.4), baseMat);
    base.position.set(0, -0.68, 0);
    base.receiveShadow = true;
    world3D.stageGroup.add(base);
  }

  // 2) 左右メインタワー支柱（高層 Y=16.0 まで貫通）
  const pillarGeo = getSharedBoxGeo(0.42, 16.6, 0.42);
  const pillarMat = getSharedStandardMat(`pillar_${stageDef.pillarColor || 0x334155}`, {
    color: stageDef.pillarColor || 0x334155,
    metalness: 0.6,
    roughness: 0.4
  });
  const pillarX = STAGE_WIDTH_HALF + 0.22;
  [-pillarX, pillarX].forEach((px) => {
    [-0.90, 0.90].forEach((pz) => {
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.set(px, 7.8, pz);
      p.castShadow = true;
      p.receiveShadow = true;
      world3D.stageGroup.add(p);
    });
  });

  // 3) 各フロア構築（フラット付スロープ／100m杭分割／50mコンベア対応）
  const goalFloorIdx = stageDef.heroine ? stageDef.heroine.floorIdx : -1;
  for (let i = 0; i < stageDef.floors.length; i++) {
    const fl = stageDef.floors[i];
    const isGoal = fl.id === goalFloorIdx;
    const isConveyor = Boolean(fl.conveyor);

    if (fl.collapsibleCenter) {
      buildRivetCapableFloor(fl, stageDef.rivets || []);
    } else if (typeof fl.flatUntilX === 'number') {
      // 25m 6F など：左端フラット部＋右側スロープ部の2セグメントで物理と完全一致させる
      buildBeamSegment(world3D.stageGroup, fl.xMin, fl.flatUntilX, fl.yLeft, fl.yLeft, fl.color, isGoal, isConveyor);
      buildBeamSegment(world3D.stageGroup, fl.flatUntilX, fl.xMax, fl.yLeft, fl.yRight, fl.color, isGoal, isConveyor);
    } else {
      buildBeamSegment(world3D.stageGroup, fl.xMin, fl.xMax, fl.yLeft, fl.yRight, fl.color, isGoal, isConveyor);
    }

    // 階段ステップ表現（hasSteps フロア）
    if (fl.hasSteps) {
      const stepCount = 12;
      const dx = fl.xMax - fl.xMin;
      const stepW = dx / stepCount;
      const stepGeo = getSharedBoxGeo(stepW * 0.90, 0.08, 1.56);
      const stepMat = getSharedStandardMat(`step_${fl.color}`, {
        color: fl.color === 0x14b8a6 ? 0x5eead4 : 0xfb7185,
        roughness: 0.48,
        metalness: 0.22
      });
      for (let s = 0; s < stepCount; s++) {
        const sx = fl.xMin + (s + 0.5) * stepW;
        const sy = getFloorY(fl, sx);
        const step = new THREE.Mesh(stepGeo, stepMat);
        step.position.set(sx, sy - 0.025, 0);
        step.receiveShadow = true;
        world3D.stageGroup.add(step);
      }
    }

    // 50m コンベア視覚マーカー
    if (isConveyor) {
      buildConveyorVisualStrip(fl);
    }
  }

  // 4) はしご構築（固定＆電動伸縮）
  for (let i = 0; i < stageDef.ladders.length; i++) {
    buildLadderGeometry(stageDef.ladders[i], i);
  }

  // 5) 25m タルの山（ボス横の装飾ピラミッド）
  if (stageDef.hasBarrelStack && Array.isArray(stageDef.barrelStack)) {
    const bossFloor = stageDef.floors[stageDef.boss.floorIdx];
    for (let i = 0; i < stageDef.barrelStack.length; i++) {
      const sp = stageDef.barrelStack[i];
      const bMesh = createBarrelMesh(false);
      const fy = getFloorY(bossFloor, sp.x);
      bMesh.position.set(sp.x, fy + sp.yOff, sp.z);
      bMesh.rotation.y = sp.rotY;
      world3D.stageGroup.add(bMesh);
    }
  }

  // 6) オイル炉（25m 1F左端 ／ 50m 3F中央）
  for (let i = 0; i < stageDef.furnaces.length; i++) {
    const fn = stageDef.furnaces[i];
    const fMesh = createFurnaceMesh();
    fMesh.position.set(fn.x, fn.y, 0);
    world3D.stageGroup.add(fMesh);
    const flame = fMesh.getObjectByName('furnace-flame');
    if (flame) world3D.furnaceFlames.push(flame);
  }

  // 7) 75m 循環エレベーターシャフト＆台
  for (let i = 0; i < stageDef.elevators.length; i++) {
    buildElevatorShaft(stageDef.elevators[i]);
  }

  // 8) ヒロイン足元の光るゴールリング
  if (stageDef.heroine) {
    const ring = createGoalRingMesh();
    ring.position.set(stageDef.heroine.x, stageDef.heroine.y + 0.06, 0);
    world3D.stageGroup.add(ring);
    world3D.goalRingMesh = ring;
  }

  // 9) 背景の奥行き夜景ビルシルエット
  const bgMat = getSharedStandardMat('bg_building_mat', { color: 0x1e293b, roughness: 0.9 });
  const bgSpecs = [
    [-9.5, 6.0, -9.0, 3.2, 20, 2.5],
    [-4.5, 7.5, -11.0, 4.0, 24, 3.0],
    [ 1.5, 6.5, -12.0, 4.2, 22, 3.0],
    [ 7.5, 8.0, -10.0, 3.5, 26, 2.5],
    [11.2, 5.0, -9.0, 2.8, 18, 2.5]
  ];
  for (let i = 0; i < bgSpecs.length; i++) {
    const [bx, by, bz, bw, bh, bd] = bgSpecs[i];
    const b = new THREE.Mesh(getSharedBoxGeo(bw, bh, bd), bgMat);
    b.position.set(bx, by, bz);
    world3D.stageGroup.add(b);
  }
}

/* ============================================================================
 * 6. エンティティ個別スポナー ＆ メッシュ安全削除（インプレース配列更新）
 * ========================================================================== */

/**
 * エンティティグループから対象メッシュを取り除き非共有リソースのみ解放
 * @param {THREE.Object3D|null|undefined} mesh
 */
export function removeEntityMesh(mesh) {
  if (!mesh) return;
  if (world3D.entityGroup && mesh.parent === world3D.entityGroup) {
    world3D.entityGroup.remove(mesh);
  } else if (mesh.parent) {
    mesh.parent.remove(mesh);
  }
  disposeHierarchy(mesh);
}

/**
 * 25m タルを生成して entities.barrels へ追加
 */
export function spawnBarrelEntity(isIron, x, y, vx, vy, floorIdx, dropBounce = true) {
  if (!world3D.entityGroup) return null;
  const mesh = createBarrelMesh(isIron);
  mesh.position.set(x, y, 0);
  world3D.entityGroup.add(mesh);

  const item = {
    id: `br_${Math.floor(gameState.simTimeSec * 1000)}_${entities.barrels.length}`,
    mesh,
    x,
    y,
    vx,
    vy,
    floorIdx,
    falling: false,
    dropBounce,
    onLadderDrop: false,
    isIron: Boolean(isIron),
    jumpedOver: false,
    alive: true
  };
  entities.barrels.push(item);
  return item;
}

/**
 * 巡回敵／トゲ敵を生成して entities.enemies へ追加
 */
export function spawnEnemyEntity(cfg, stageDef) {
  if (!world3D.entityGroup || !stageDef) return null;
  const fl = stageDef.floors[cfg.floorIdx] || stageDef.floors[0];
  const y = getFloorY(fl, cfg.x);
  const mesh = createEnemyMesh(cfg.type);
  mesh.position.set(cfg.x, y, 0);
  world3D.entityGroup.add(mesh);

  const item = {
    floorIdx: cfg.floorIdx,
    x: cfg.x,
    y,
    type: cfg.type,
    speed: cfg.speed,
    dir: cfg.dir,
    alive: true,
    mesh
  };
  entities.enemies.push(item);
  return item;
}

/**
 * 火の玉ボットを生成して entities.fireballs へ追加
 */
export function spawnFireballEntity(floorIdx, x, stageDef, speedMul = 1.0) {
  if (!world3D.entityGroup || !stageDef) return null;
  const fl = stageDef.floors[floorIdx] || stageDef.floors[0];
  const sx = clamp(safeFinite(x, 0), fl.xMin + 0.4, fl.xMax - 0.4);
  const y = getFloorY(fl, sx);
  const mesh = createFireballMesh();
  mesh.position.set(sx, y, 0);
  world3D.entityGroup.add(mesh);

  const item = {
    floorIdx,
    x: sx,
    y,
    dir: sx >= 0 ? -1 : 1,
    speed: 1.55 * safeFinite(speedMul, 1.0),
    onLadder: null,
    climbDir: 0,
    ladderCooldown: 1.2,
    jumpedOver: false,
    alive: true,
    mesh
  };
  entities.fireballs.push(item);
  return item;
}

/**
 * 50m エネルギー缶を生成して entities.cans へ追加
 */
export function spawnEnergyCanEntity(floorIdx, x, dir, speed, stageDef) {
  if (!world3D.entityGroup || !stageDef) return null;
  const fl = stageDef.floors[floorIdx] || stageDef.floors[0];
  const y = getFloorY(fl, x);
  const mesh = createEnergyCanMesh();
  mesh.position.set(x, y, 0);
  world3D.entityGroup.add(mesh);

  const item = {
    floorIdx,
    x,
    y,
    vy: 0,
    dir: dir >= 0 ? 1 : -1,
    speed: safeFinite(speed, 2.0),
    falling: false,
    jumpedOver: false,
    alive: true,
    mesh
  };
  entities.cans.push(item);
  return item;
}

/**
 * 75m バウンドジャッキを生成して entities.jacks へ追加
 */
export function spawnJackEntity(x, y, vx, vy, floorIdx) {
  if (!world3D.entityGroup) return null;
  const mesh = createJackMesh();
  mesh.position.set(x, y, 0);
  world3D.entityGroup.add(mesh);

  const item = {
    floorIdx,
    x,
    y,
    vx,
    vy,
    dropping: false,
    jumpedOver: false,
    alive: true,
    mesh
  };
  entities.jacks.push(item);
  return item;
}

/**
 * 100m 光る杭（Rivet）を生成して entities.rivets へ追加
 */
export function spawnRivetEntity(rDef) {
  if (!world3D.entityGroup) return null;
  const mesh = createRivetMesh();
  mesh.position.set(rDef.x, rDef.y, 0);
  world3D.entityGroup.add(mesh);

  const item = {
    id: rDef.id,
    floorIdx: rDef.floorIdx,
    x: rDef.x,
    y: rDef.y,
    holeHalfWidth: rDef.holeHalfWidth,
    pulled: false,
    mesh
  };
  entities.rivets.push(item);
  return item;
}

/**
 * 100m 杭抜き時にボルトを除去し、床のプラグを消して本物の貫通穴を開ける
 * @param {object} rivet
 */
export function applyRivetPulledVisual(rivet) {
  if (!rivet) return;
  if (rivet.mesh) {
    removeEntityMesh(rivet.mesh);
    rivet.mesh = null;
  }
  const plugGroup = world3D.rivetPlugMap.get(rivet.id);
  if (plugGroup) {
    plugGroup.visible = false;
  }
}

/**
 * 100m 全8本杭抜き完了時に中央崩落セグメントの落下を開始させる
 */
export function triggerCenterFloorCollapseVisual() {
  for (let i = 0; i < world3D.collapsibleSegments.length; i++) {
    const seg = world3D.collapsibleSegments[i];
    seg.falling = true;
    seg.vy = -1.2 - i * 0.45;
  }
}

/**
 * 木箱を生成して entities.crates へ追加
 */
export function spawnCrateEntity(cfg, stageDef) {
  if (!world3D.entityGroup || !stageDef) return null;
  const fl = stageDef.floors[cfg.floorIdx] || stageDef.floors[0];
  const y = getFloorY(fl, cfg.x);
  const mesh = createCrateMesh(cfg.hasBattery);
  mesh.position.set(cfg.x, y, 0);
  world3D.entityGroup.add(mesh);

  const item = {
    floorIdx: cfg.floorIdx,
    x: cfg.x,
    y,
    hasBattery: Boolean(cfg.hasBattery),
    alive: true,
    mesh
  };
  entities.crates.push(item);
  return item;
}

/**
 * コイン／ハイパー電池ピックアップを生成して entities.pickups へ追加
 */
export function spawnPickupEntity(kind, x, y) {
  if (!world3D.entityGroup) return null;
  const mesh = createPickupMesh(kind);
  mesh.position.set(x, y, 0);
  world3D.entityGroup.add(mesh);

  const item = {
    kind,
    x,
    y,
    collected: false,
    mesh
  };
  entities.pickups.push(item);
  return item;
}

/**
 * ステージ定義に従い、初期配置の敵・木箱・コイン・杭・初期火の玉を一括生成
 * @param {object} stageDef
 * @param {number} fireballSpeedMul
 */
export function populateStageEntities(stageDef, fireballSpeedMul = 1.0) {
  if (!stageDef) return;

  for (let i = 0; i < stageDef.enemies.length; i++) {
    spawnEnemyEntity(stageDef.enemies[i], stageDef);
  }
  for (let i = 0; i < stageDef.crates.length; i++) {
    spawnCrateEntity(stageDef.crates[i], stageDef);
  }
  for (let i = 0; i < stageDef.coins.length; i++) {
    const co = stageDef.coins[i];
    const fl = stageDef.floors[co.floorIdx] || stageDef.floors[0];
    spawnPickupEntity('coin', co.x, getFloorY(fl, co.x));
  }
  for (let i = 0; i < stageDef.rivets.length; i++) {
    spawnRivetEntity(stageDef.rivets[i]);
  }

  // 初期火の玉ボット配置（50m/75m/100m）
  const fbCfg = stageDef.fireballConfig;
  if (fbCfg && fbCfg.initialCount > 0 && Array.isArray(fbCfg.spawnPositions)) {
    const count = Math.min(fbCfg.initialCount, fbCfg.spawnPositions.length);
    for (let i = 0; i < count; i++) {
      const pos = fbCfg.spawnPositions[i];
      spawnFireballEntity(pos.floorIdx, pos.x, stageDef, fireballSpeedMul);
    }
  }
}

/* ============================================================================
 * 7. ステージ動的ビジュアル更新（時間ベース・120Hz 倍速防止：第5章 5.2 準拠）
 * ========================================================================== */

/**
 * ゴールリング・オイル炉の炎・50m コンベア帯＆伸縮はしご・100m 中央崩落のビジュアルを更新
 * @param {number} dt 秒
 * @param {number} simTimeSec 仮想時計（秒）
 */
export function updateStageVisuals(dt, simTimeSec) {
  const safeDt = clamp(safeFinite(dt, 0), 0, 0.05);
  const t = safeFinite(simTimeSec, 0);

  // ゴールリング回転
  if (world3D.goalRingMesh) {
    world3D.goalRingMesh.rotation.z = t * 2.0;
  }

  // オイル炉の炎揺らめき（秒ベース三角関数）
  for (let i = 0; i < world3D.furnaceFlames.length; i++) {
    const flame = world3D.furnaceFlames[i];
    const pulse = 0.88 + Math.sin(t * 14.0 + i * 1.7) * 0.16;
    flame.scale.set(1.0, pulse, 1.0);
    flame.rotation.y = t * 5.0 + i;
  }

  // 50m 反転コンベア移動ストリップ＆警告点滅
  for (let i = 0; i < world3D.conveyorVisuals.length; i++) {
    const cv = world3D.conveyorVisuals[i];
    let cState = null;
    for (let j = 0; j < stageRuntime.conveyorStates.length; j++) {
      if (stageRuntime.conveyorStates[j].floorIdx === cv.floorIdx) {
        cState = stageRuntime.conveyorStates[j];
        break;
      }
    }
    if (!cState) continue;

    const span = Math.max(0.1, cv.xMax - cv.xMin);
    const useWarnMat = cState.isWarning && (Math.floor(t * 12) % 2 === 0);
    const activeMat = useWarnMat ? cv.warnMat : cv.normalMat;
    const dx = cState.dir * cState.speed * safeDt;

    for (let k = 0; k < cv.chevrons.length; k++) {
      const m = cv.chevrons[k];
      let nx = m.position.x + dx;
      if (nx > cv.xMax) nx -= span;
      if (nx < cv.xMin) nx += span;
      m.position.x = nx;
      if (m.material !== activeMat) {
        m.material = activeMat;
      }
    }
  }

  // 50m 電動伸縮はしごスライド位置同期
  for (let i = 0; i < stageRuntime.retractableLadders.length; i++) {
    const rl = stageRuntime.retractableLadders[i];
    const ratio = getLadderExtensionRatio(rl.ladder, t);
    rl.ratio = ratio;
    if (rl.slideGroup) {
      rl.slideGroup.position.y = lerp(rl.minSlideY, rl.maxSlideY, ratio);
    }
  }

  // 100m 中央崩落セグメントの落下アニメーション
  for (let i = 0; i < world3D.collapsibleSegments.length; i++) {
    const seg = world3D.collapsibleSegments[i];
    if (!seg.falling || !seg.group) continue;
    seg.vy -= 18.0 * safeDt;
    seg.group.position.y += seg.vy * safeDt;
    seg.group.rotation.z += seg.rotSpeed * safeDt;
    if (seg.group.position.y < -4.0) {
      seg.group.visible = false;
      seg.falling = false;
    }
  }
}

/**
 * 75m 循環エレベーターの物理・描画位置を更新（固定物理ステップから呼び出す）
 * @param {number} simTimeSec 仮想時計（秒）
 * @param {number} speedMul 周回速度倍率
 */
export function updateElevatorPlatforms(simTimeSec, speedMul = 1.0) {
  const plats = stageRuntime.elevatorPlatforms;
  for (let i = 0; i < plats.length; i++) {
    const p = plats[i];
    p.prevY = p.y;
    const nextY = getElevatorPlatformY(p.shaft, p.platformIndex, simTimeSec, speedMul);
    p.y = nextY;
    if (p.mesh) {
      p.mesh.position.y = nextY;
    }
  }
}