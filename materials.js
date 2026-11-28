/**
 * materials.js
 * @version v1.0 (3D Mesh Factories, Shared Cache & AnimController - Phase 5)
 * @changes
 *   - バージョン固定 ESM CDN (https://esm.sh/three@0.160.0) を単一参照元として再エクスポートし、Import Map 不要で GRAVITY ローダー互換を実現
 *   - 共有ジオメトリ／マテリアルキャッシュ (sharedGeometriesSet / sharedMaterialsSet) と安全破棄 disposeHierarchy() を実装
 *   - 全3Dエンティティ工場（木タル/鉄タル・巡回敵/トゲ敵・火の玉ボット・エネルギー缶・バウンドジャッキ・光る杭・木箱・電池/コイン・オイル炉・ゴールリング・オーラ）を実装
 *   - フォールバックロボット生成 createFallbackRobot()・キャラ色変え tintRobotModel()・アニメーション制御 AnimController を実装
 *   - パーティクル用共有ジオメトリ＆色別共有マテリアル取得ヘルパーを実装
 *
 * Tier 2 機構モジュール：Three.js 単一エントリ・GPUリソース共有キャッシュ・全3Dメッシュ生成工場
 */

import * as THREE from 'https://esm.sh/three@0.160.0';
import { safeFinite } from './constants.js?v=1';

// 他モジュール（world.js / camera.js / entity.js 等）が必ず同一 Three.js インスタンスを共有するための再エクスポート
export { THREE };

/* ============================================================================
 * 1. 共有ジオメトリ ＆ マテリアルキャッシュ（第5章 5.3 3D WebGL 最適化準拠）
 * ========================================================================== */

/** パラメータキー → 共有 Geometry */
const geometryCache = new Map();
/** パラメータキー → 共有 Material */
const materialCache = new Map();

/** disposeHierarchy() で誤破棄しないよう保護する共有リソース集合 */
export const sharedGeometriesSet = new Set();
export const sharedMaterialsSet = new Set();

/**
 * 共有ジオメトリをキャッシュ取得（未登録時のみ生成して sharedGeometriesSet へ登録）
 * @param {string} key キャッシュ一意キー
 * @param {() => THREE.BufferGeometry} factory 生成関数
 * @returns {THREE.BufferGeometry}
 */
export function getSharedGeometry(key, factory) {
  let geo = geometryCache.get(key);
  if (!geo) {
    geo = factory();
    geometryCache.set(key, geo);
    sharedGeometriesSet.add(geo);
  }
  return geo;
}

/**
 * 共有マテリアルをキャッシュ取得（未登録時のみ生成して sharedMaterialsSet へ登録）
 * @param {string} key キャッシュ一意キー
 * @param {() => THREE.Material} factory 生成関数
 * @returns {THREE.Material}
 */
export function getSharedMaterial(key, factory) {
  let mat = materialCache.get(key);
  if (!mat) {
    mat = factory();
    materialCache.set(key, mat);
    sharedMaterialsSet.add(mat);
  }
  return mat;
}

/**
 * よく使う BoxGeometry のパラメータキー共有取得（ステージ鉄骨・支柱・階段用）
 * @param {number} w
 * @param {number} h
 * @param {number} d
 * @returns {THREE.BoxGeometry}
 */
export function getSharedBoxGeo(w, h, d) {
  const rw = Math.round(safeFinite(w, 1) * 1000);
  const rh = Math.round(safeFinite(h, 1) * 1000);
  const rd = Math.round(safeFinite(d, 1) * 1000);
  return getSharedGeometry(`box_${rw}_${rh}_${rd}`, () => new THREE.BoxGeometry(w, h, d));
}

/**
 * よく使う CylinderGeometry のパラメータキー共有取得（はしご・支柱用）
 * @param {number} rt
 * @param {number} rb
 * @param {number} h
 * @param {number} seg
 * @returns {THREE.CylinderGeometry}
 */
export function getSharedCylinderGeo(rt, rb, h, seg = 8) {
  const k = `cyl_${Math.round(rt * 1000)}_${Math.round(rb * 1000)}_${Math.round(h * 1000)}_${seg}`;
  return getSharedGeometry(k, () => new THREE.CylinderGeometry(rt, rb, h, seg));
}

/**
 * よく使う MeshStandardMaterial のキャッシュ取得
 * @param {string} key
 * @param {object} params
 * @returns {THREE.MeshStandardMaterial}
 */
export function getSharedStandardMat(key, params) {
  return getSharedMaterial(`std_${key}`, () => new THREE.MeshStandardMaterial(params));
}

/**
 * よく使う MeshBasicMaterial のキャッシュ取得
 * @param {string} key
 * @param {object} params
 * @returns {THREE.MeshBasicMaterial}
 */
export function getSharedBasicMat(key, params) {
  return getSharedMaterial(`bas_${key}`, () => new THREE.MeshBasicMaterial(params));
}

/**
 * 階層内の非共有ジオメトリ・マテリアルのみを安全に解放する（共有キャッシュは完全保護）
 * ステージ切替・エンティティ一括破棄時に呼び出すことで GPU メモリリークを防止
 * @param {THREE.Object3D|null|undefined} root
 */
export function disposeHierarchy(root) {
  if (!root || typeof root.traverse !== 'function') return;
  try {
    root.traverse((obj) => {
      if (obj.geometry && !sharedGeometriesSet.has(obj.geometry)) {
        try {
          obj.geometry.dispose();
        } catch (_e) {}
      }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (let i = 0; i < mats.length; i++) {
          const m = mats[i];
          if (m && !sharedMaterialsSet.has(m)) {
            try {
              m.dispose();
            } catch (_e) {}
          }
        }
      }
    });
  } catch (err) {
    console.warn('[Materials] disposeHierarchy error:', err);
  }
}

/* ============================================================================
 * 2. パーティクル用共有ジオメトリ ＆ 色別マテリアル取得（ゼロリーク）
 * ========================================================================== */

/**
 * パーティクル共通キューブジオメトリを取得
 * @returns {THREE.BoxGeometry}
 */
export function getParticleGeometry() {
  return getSharedGeometry('particle_box_14', () => new THREE.BoxGeometry(0.14, 0.14, 0.14));
}

/**
 * パーティクル用の色別共有マテリアルを取得
 * @param {number} colorHex
 * @returns {THREE.MeshBasicMaterial}
 */
export function getParticleMaterial(colorHex) {
  const safeHex = Number.isFinite(colorHex) ? (colorHex >>> 0) : 0xfbbf24;
  return getSharedMaterial(`particle_mat_${safeHex}`, () => new THREE.MeshBasicMaterial({ color: safeHex }));
}

/* ============================================================================
 * 3. エンティティ別 3D メッシュ工場（全4ステージ対応・すべて共有リソース活用）
 * ========================================================================== */

/**
 * 1) 木タル ／ 鉄タル メッシュ生成（25m ステージ用）
 * Z軸方向へ寝かせた横転がり構造＋タガ2本＋回転視認マーク
 * @param {boolean} isIron
 * @returns {THREE.Group}
 */
export function createBarrelMesh(isIron = false) {
  const group = new THREE.Group();
  const radius = 0.36;
  const length = 0.66;

  const bodyGeo = getSharedGeometry('barrel_body', () => {
    const g = new THREE.CylinderGeometry(radius, radius, length, 16);
    g.rotateX(Math.PI / 2);
    return g;
  });

  const bodyMat = isIron
    ? getSharedStandardMat('barrel_iron_body', {
        color: 0x0284c7,
        emissive: 0x0369a1,
        emissiveIntensity: 0.45,
        metalness: 0.85,
        roughness: 0.2
      })
    : getSharedStandardMat('barrel_wood_body', {
        color: 0xb45309,
        roughness: 0.72,
        metalness: 0.1
      });

  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // タガ（補強リング2本）
  const hoopGeo = getSharedGeometry('barrel_hoop', () => new THREE.TorusGeometry(radius + 0.015, 0.032, 8, 20));
  const hoopMat = isIron
    ? getSharedStandardMat('barrel_iron_hoop', { color: 0x7dd3fc, metalness: 0.8, roughness: 0.3 })
    : getSharedStandardMat('barrel_wood_hoop', { color: 0x334155, metalness: 0.8, roughness: 0.3 });

  const hoopFront = new THREE.Mesh(hoopGeo, hoopMat);
  hoopFront.position.z = 0.18;
  group.add(hoopFront);

  const hoopBack = new THREE.Mesh(hoopGeo, hoopMat);
  hoopBack.position.z = -0.18;
  group.add(hoopBack);

  // 回転視認マーク
  const markGeo = getSharedBoxGeo(0.16, 0.56, length + 0.04);
  const markMat = isIron
    ? getSharedStandardMat('barrel_iron_mark', { color: 0xe0f2fe, emissive: 0x38bdf8, emissiveIntensity: 0.5 })
    : getSharedStandardMat('barrel_wood_mark', { color: 0xfde68a, roughness: 0.6, metalness: 0.1 });
  group.add(new THREE.Mesh(markGeo, markMat));

  return group;
}

/**
 * 2) 巡回敵（walker）／ トゲ敵（spiky）メッシュ生成
 * @param {'walker'|'spiky'} type
 * @returns {THREE.Group}
 */
export function createEnemyMesh(type = 'walker') {
  const group = new THREE.Group();
  const isSpiky = type === 'spiky';

  const bodyGeo = getSharedGeometry('enemy_body_sphere', () => new THREE.SphereGeometry(0.4, 14, 12));
  const bodyMat = isSpiky
    ? getSharedStandardMat('enemy_spiky_body', { color: 0x9333ea, roughness: 0.35, metalness: 0.25 })
    : getSharedStandardMat('enemy_walker_body', { color: 0x10b981, roughness: 0.35, metalness: 0.25 });

  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.42;
  body.castShadow = true;
  group.add(body);

  // ロボット目（白目＋黒目）
  const eyeWhiteGeo = getSharedGeometry('enemy_eye_white', () => new THREE.SphereGeometry(0.1, 8, 8));
  const eyePupilGeo = getSharedGeometry('enemy_eye_pupil', () => new THREE.SphereGeometry(0.055, 8, 8));
  const eyeWhiteMat = getSharedBasicMat('white', { color: 0xffffff });
  const eyePupilMat = getSharedBasicMat('dark_slate', { color: 0x0f172a });

  const eyeOffsets = [-0.15, 0.15];
  for (let i = 0; i < eyeOffsets.length; i++) {
    const ex = eyeOffsets[i];
    const ew = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
    ew.position.set(ex, 0.48, 0.34);
    group.add(ew);

    const ep = new THREE.Mesh(eyePupilGeo, eyePupilMat);
    ep.position.set(ex, 0.48, 0.42);
    group.add(ep);
  }

  if (isSpiky) {
    // 頭上の赤い警告トゲ5本
    const spikeGeo = getSharedGeometry('enemy_spike_cone', () => new THREE.ConeGeometry(0.11, 0.32, 8));
    const spikeMat = getSharedStandardMat('enemy_spike_mat', {
      color: 0xf43f5e,
      emissive: 0xe11d48,
      emissiveIntensity: 0.35,
      metalness: 0.4,
      roughness: 0.3
    });
    const spikeOffsets = [
      [0, 0.88, 0, 0, 0],
      [-0.24, 0.78, 0, 0, 0.55],
      [0.24, 0.78, 0, 0, -0.55],
      [0, 0.78, 0.2, 0.45, 0],
      [0, 0.78, -0.2, -0.45, 0]
    ];
    for (let i = 0; i < spikeOffsets.length; i++) {
      const [sx, sy, sz, rx, rz] = spikeOffsets[i];
      const sp = new THREE.Mesh(spikeGeo, spikeMat);
      sp.position.set(sx, sy, sz);
      sp.rotation.set(rx, 0, rz);
      group.add(sp);
    }
  } else {
    // 巡回敵の足
    const footGeo = getSharedBoxGeo(0.18, 0.12, 0.26);
    const footMat = getSharedStandardMat('enemy_walker_foot', { color: 0x065f46, roughness: 0.5 });
    const footLeft = new THREE.Mesh(footGeo, footMat);
    footLeft.position.set(-0.18, 0.06, 0);
    group.add(footLeft);

    const footRight = new THREE.Mesh(footGeo, footMat);
    footRight.position.set(0.18, 0.06, 0);
    group.add(footRight);
  }

  return group;
}

/**
 * 3) 火の玉ボット（Fireball）メッシュ生成（25m/50m/75m/100m 共通の追跡おじゃま虫）
 * @returns {THREE.Group}
 */
export function createFireballMesh() {
  const group = new THREE.Group();

  // 内側高温コア
  const coreGeo = getSharedGeometry('fireball_core', () => new THREE.SphereGeometry(0.30, 12, 10));
  const coreMat = getSharedStandardMat('fireball_core_mat', {
    color: 0xfef08a,
    emissive: 0xf59e0b,
    emissiveIntensity: 0.9,
    roughness: 0.2
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.y = 0.36;
  group.add(core);

  // 外側炎オーラ（entity.js で回転・脈動させる）
  const outerGeo = getSharedGeometry('fireball_outer', () => new THREE.OctahedronGeometry(0.42, 0));
  const outerMat = getSharedStandardMat('fireball_outer_mat', {
    color: 0xf97316,
    emissive: 0xef4444,
    emissiveIntensity: 0.65,
    transparent: true,
    opacity: 0.82,
    roughness: 0.3
  });
  const outer = new THREE.Mesh(outerGeo, outerMat);
  outer.name = 'fireball-outer';
  outer.position.y = 0.40;
  group.add(outer);

  // 視認しやすいコミカルな目
  const eyeWhiteGeo = getSharedGeometry('fireball_eye_w', () => new THREE.SphereGeometry(0.085, 8, 8));
  const eyePupilGeo = getSharedGeometry('fireball_eye_p', () => new THREE.SphereGeometry(0.048, 8, 8));
  const eyeWhiteMat = getSharedBasicMat('white', { color: 0xffffff });
  const eyePupilMat = getSharedBasicMat('dark_slate', { color: 0x0f172a });

  [-0.12, 0.12].forEach((ex) => {
    const ew = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
    ew.position.set(ex, 0.42, 0.27);
    group.add(ew);

    const ep = new THREE.Mesh(eyePupilGeo, eyePupilMat);
    ep.position.set(ex, 0.42, 0.33);
    group.add(ep);
  });

  return group;
}

/**
 * 4) エネルギー缶メッシュ生成（50m コンベア工場用）
 * @returns {THREE.Group}
 */
export function createEnergyCanMesh() {
  const group = new THREE.Group();

  const bodyGeo = getSharedCylinderGeo(0.28, 0.28, 0.64, 14);
  const bodyMat = getSharedStandardMat('energy_can_body', {
    color: 0xea580c,
    emissive: 0x9a3412,
    emissiveIntensity: 0.35,
    metalness: 0.55,
    roughness: 0.32
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.34;
  body.castShadow = true;
  group.add(body);

  // 上下メタリックリム
  const rimGeo = getSharedCylinderGeo(0.30, 0.30, 0.06, 14);
  const rimMat = getSharedStandardMat('energy_can_rim', { color: 0xe2e8f0, metalness: 0.85, roughness: 0.25 });
  const rimTop = new THREE.Mesh(rimGeo, rimMat);
  rimTop.position.y = 0.64;
  group.add(rimTop);

  const rimBot = new THREE.Mesh(rimGeo, rimMat);
  rimBot.position.y = 0.04;
  group.add(rimBot);

  // 中央の発光チャージバンド
  const bandGeo = getSharedCylinderGeo(0.295, 0.295, 0.14, 14);
  const bandMat = getSharedStandardMat('energy_can_band', {
    color: 0xfef08a,
    emissive: 0xfacc15,
    emissiveIntensity: 0.75,
    roughness: 0.2
  });
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.position.y = 0.34;
  group.add(band);

  return group;
}

/**
 * 5) バウンドジャッキメッシュ生成（75m エレベーター塔 5F 回廊用）
 * @returns {THREE.Group}
 */
export function createJackMesh() {
  const group = new THREE.Group();

  const plateGeo = getSharedBoxGeo(0.56, 0.10, 0.44);
  const plateMat = getSharedStandardMat('jack_plate', {
    color: 0xf43f5e,
    emissive: 0xbe123c,
    emissiveIntensity: 0.35,
    metalness: 0.65,
    roughness: 0.25
  });

  const bottomPlate = new THREE.Mesh(plateGeo, plateMat);
  bottomPlate.position.y = 0.06;
  bottomPlate.castShadow = true;
  group.add(bottomPlate);

  const topPlate = new THREE.Mesh(plateGeo, plateMat);
  topPlate.position.y = 0.68;
  topPlate.castShadow = true;
  group.add(topPlate);

  // 中央のバネコイル（3段トーラス）
  const springGroup = new THREE.Group();
  springGroup.name = 'jack-spring';
  const coilGeo = getSharedGeometry('jack_coil_torus', () => {
    const g = new THREE.TorusGeometry(0.19, 0.045, 8, 16);
    g.rotateX(Math.PI / 2);
    return g;
  });
  const coilMat = getSharedStandardMat('jack_coil_mat', {
    color: 0xfde047,
    emissive: 0xca8a04,
    emissiveIntensity: 0.4,
    metalness: 0.75,
    roughness: 0.25
  });

  const coilYs = [0.20, 0.37, 0.54];
  for (let i = 0; i < coilYs.length; i++) {
    const coil = new THREE.Mesh(coilGeo, coilMat);
    coil.position.y = coilYs[i];
    springGroup.add(coil);
  }
  group.add(springGroup);

  return group;
}

/**
 * 6) 光るボルト杭（Rivet）メッシュ生成（100m 8本杭抜きステージ用）
 * @returns {THREE.Group}
 */
export function createRivetMesh() {
  const group = new THREE.Group();

  // 六角ボルト頭部
  const headGeo = getSharedCylinderGeo(0.30, 0.30, 0.24, 6);
  const headMat = getSharedStandardMat('rivet_head', {
    color: 0xfef08a,
    emissive: 0xf59e0b,
    emissiveIntensity: 0.72,
    metalness: 0.7,
    roughness: 0.22
  });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = 0.14;
  head.castShadow = true;
  group.add(head);

  // 床面へ差し込まれているシャフト部
  const shaftGeo = getSharedCylinderGeo(0.14, 0.14, 0.38, 10);
  const shaftMat = getSharedStandardMat('rivet_shaft', {
    color: 0xd97706,
    metalness: 0.65,
    roughness: 0.35
  });
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.position.y = -0.14;
  group.add(shaft);

  // 周囲の視認用グローリング（entity.js で脈動）
  const ringGeo = getSharedGeometry('rivet_glow_ring', () => {
    const g = new THREE.TorusGeometry(0.39, 0.04, 8, 18);
    g.rotateX(Math.PI / 2);
    return g;
  });
  const ringMat = getSharedBasicMat('rivet_ring_basic', {
    color: 0xfde047,
    transparent: true,
    opacity: 0.85
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.name = 'rivet-glow';
  ring.position.y = 0.04;
  group.add(ring);

  return group;
}

/**
 * 7) 木箱 ／ 電池入り光る木箱メッシュ生成
 * @param {boolean} hasBattery
 * @returns {THREE.Group}
 */
export function createCrateMesh(hasBattery = false) {
  const group = new THREE.Group();

  const boxGeo = getSharedBoxGeo(0.76, 0.76, 0.76);
  const boxMat = hasBattery
    ? getSharedStandardMat('crate_battery_box', {
        color: 0xf59e0b,
        emissive: 0xd97706,
        emissiveIntensity: 0.35,
        roughness: 0.45,
        metalness: 0.2
      })
    : getSharedStandardMat('crate_wood_box', {
        color: 0xb45309,
        roughness: 0.8,
        metalness: 0.08
      });

  const box = new THREE.Mesh(boxGeo, boxMat);
  box.position.y = 0.38;
  box.castShadow = true;
  box.receiveShadow = true;
  group.add(box);

  // 補強枠
  const crossGeo = getSharedBoxGeo(0.80, 0.12, 0.80);
  const frameMat = hasBattery
    ? getSharedStandardMat('crate_battery_frame', { color: 0xfef08a, roughness: 0.45 })
    : getSharedStandardMat('crate_wood_frame', { color: 0x78350f, roughness: 0.6 });
  const cross1 = new THREE.Mesh(crossGeo, frameMat);
  cross1.position.y = 0.38;
  group.add(cross1);

  if (hasBattery) {
    // 電池入り木箱の発光コア目印
    const glowGeo = getSharedGeometry('crate_battery_core', () => new THREE.OctahedronGeometry(0.22, 0));
    const glowMat = getSharedBasicMat('crate_glow_yellow', { color: 0xfef08a });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.set(0, 0.38, 0.38);
    group.add(glow);
  }

  return group;
}

/**
 * 8) ピックアップアイテム（ハイパー電池 ／ コイン）メッシュ生成
 * @param {'battery'|'coin'} kind
 * @returns {THREE.Group}
 */
export function createPickupMesh(kind = 'coin') {
  const group = new THREE.Group();

  if (kind === 'battery') {
    const cylGeo = getSharedCylinderGeo(0.22, 0.22, 0.52, 12);
    const cylMat = getSharedStandardMat('pickup_battery_body', {
      color: 0xfacc15,
      emissive: 0xeab308,
      emissiveIntensity: 0.7,
      metalness: 0.5,
      roughness: 0.2
    });
    const cyl = new THREE.Mesh(cylGeo, cylMat);
    cyl.position.y = 0.45;
    group.add(cyl);

    const capGeo = getSharedCylinderGeo(0.11, 0.11, 0.12, 10);
    const capMat = getSharedStandardMat('pickup_battery_cap', {
      color: 0xf8fafc,
      metalness: 0.8,
      roughness: 0.2
    });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.75;
    group.add(cap);
  } else {
    const coinGeo = getSharedGeometry('pickup_coin_cyl', () => {
      const g = new THREE.CylinderGeometry(0.26, 0.26, 0.09, 16);
      g.rotateX(Math.PI / 2);
      return g;
    });
    const coinMat = getSharedStandardMat('pickup_coin_mat', {
      color: 0xfde047,
      emissive: 0xca8a04,
      emissiveIntensity: 0.45,
      metalness: 0.85,
      roughness: 0.2
    });
    const coin = new THREE.Mesh(coinGeo, coinMat);
    coin.position.y = 0.45;
    group.add(coin);
  }

  return group;
}

/**
 * 9) オイル炉（Oil Drum Furnace）メッシュ生成（25m 1F左端 ／ 50m 3F中央）
 * @returns {THREE.Group}
 */
export function createFurnaceMesh() {
  const group = new THREE.Group();

  const drumGeo = getSharedCylinderGeo(0.42, 0.42, 0.96, 14);
  const drumMat = getSharedStandardMat('furnace_drum', {
    color: 0x1d4ed8,
    metalness: 0.6,
    roughness: 0.4
  });
  const drum = new THREE.Mesh(drumGeo, drumMat);
  drum.position.y = 0.48;
  drum.castShadow = true;
  drum.receiveShadow = true;
  group.add(drum);

  // 上下補強バンド
  const bandGeo = getSharedCylinderGeo(0.44, 0.44, 0.08, 14);
  const bandMat = getSharedStandardMat('furnace_band', { color: 0x93c5fd, metalness: 0.75, roughness: 0.3 });
  const b1 = new THREE.Mesh(bandGeo, bandMat);
  b1.position.y = 0.24;
  group.add(b1);

  const b2 = new THREE.Mesh(bandGeo, bandMat);
  b2.position.y = 0.74;
  group.add(b2);

  // ゆらめく炎コーン（world.js / entity.js でスケール＆Y回転アニメーション）
  const flameGroup = new THREE.Group();
  flameGroup.name = 'furnace-flame';
  flameGroup.position.y = 0.96;

  const outerFlameGeo = getSharedGeometry('furnace_flame_outer', () => new THREE.ConeGeometry(0.32, 0.78, 8));
  const outerFlameMat = getSharedStandardMat('furnace_flame_outer_mat', {
    color: 0xf97316,
    emissive: 0xef4444,
    emissiveIntensity: 0.85,
    transparent: true,
    opacity: 0.88,
    roughness: 0.2
  });
  const outerFlame = new THREE.Mesh(outerFlameGeo, outerFlameMat);
  outerFlame.position.y = 0.36;
  flameGroup.add(outerFlame);

  const innerFlameGeo = getSharedGeometry('furnace_flame_inner', () => new THREE.ConeGeometry(0.18, 0.52, 8));
  const innerFlameMat = getSharedBasicMat('furnace_flame_inner_mat', { color: 0xfef08a });
  const innerFlame = new THREE.Mesh(innerFlameGeo, innerFlameMat);
  innerFlame.position.y = 0.24;
  flameGroup.add(innerFlame);

  group.add(flameGroup);
  return group;
}

/**
 * 10) ヒロイン足元の光るゴールリング生成
 * @returns {THREE.Mesh}
 */
export function createGoalRingMesh() {
  const ringGeo = getSharedGeometry('goal_ring_torus', () => new THREE.TorusGeometry(0.84, 0.062, 10, 28));
  const ringMat = getSharedStandardMat('goal_ring_mat', {
    color: 0xf472b6,
    emissive: 0xec4899,
    emissiveIntensity: 0.65,
    metalness: 0.4,
    roughness: 0.2
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.name = 'goal-ring';
  ring.rotation.x = Math.PI / 2;
  return ring;
}

/**
 * 11) ハイパー電池取得時のプレイヤー発光ワイヤーフレームオーラ生成
 * @returns {THREE.Mesh}
 */
export function createPlayerAuraMesh() {
  const geo = getSharedGeometry('player_aura_ico', () => new THREE.IcosahedronGeometry(0.76, 1));
  const mat = getSharedBasicMat('player_aura_mat', {
    color: 0xfacc15,
    wireframe: true,
    transparent: true,
    opacity: 0.72
  });
  const aura = new THREE.Mesh(geo, mat);
  aura.position.y = 0.55;
  aura.visible = false;
  return aura;
}

/* ============================================================================
 * 4. 3Dロボットモデル補助（フォールバックモデル・色変え・AnimController）
 * ========================================================================== */

/**
 * GLTF 読み込み失敗／タイムアウト時でも確実に遊べる簡易フォールバックロボット生成
 * @param {number} mainColor
 * @param {number} accentColor
 * @returns {THREE.Group}
 */
export function createFallbackRobot(mainColor = 0xf59e0b, accentColor = 0xfef3c7) {
  const g = new THREE.Group();
  const mainMat = getSharedStandardMat(`fb_main_${mainColor}`, {
    color: mainColor,
    roughness: 0.35,
    metalness: 0.35
  });
  const accMat = getSharedStandardMat(`fb_acc_${accentColor}`, {
    color: accentColor,
    roughness: 0.4,
    metalness: 0.25
  });
  const eyeMat = getSharedBasicMat('dark_slate', { color: 0x0f172a });

  const torso = new THREE.Mesh(getSharedBoxGeo(1.1, 1.3, 0.8), mainMat);
  torso.position.y = 1.6;
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(getSharedBoxGeo(1.25, 0.95, 1.0), mainMat);
  head.position.y = 2.85;
  head.castShadow = true;
  g.add(head);

  const visor = new THREE.Mesh(getSharedBoxGeo(0.95, 0.35, 0.15), accMat);
  visor.position.set(0, 2.9, 0.48);
  g.add(visor);

  const eyeGeo = getSharedGeometry('fb_eye_sphere', () => new THREE.SphereGeometry(0.12, 8, 8));
  [-0.25, 0.25].forEach((ex) => {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(ex, 2.9, 0.56);
    g.add(eye);
  });

  const armGeo = getSharedBoxGeo(0.32, 1.1, 0.32);
  [-0.75, 0.75].forEach((ax) => {
    const arm = new THREE.Mesh(armGeo, accMat);
    arm.position.set(ax, 1.65, 0);
    g.add(arm);
  });

  const legGeo = getSharedBoxGeo(0.36, 0.95, 0.4);
  [-0.3, 0.3].forEach((lx) => {
    const leg = new THREE.Mesh(legGeo, accMat);
    leg.position.set(lx, 0.48, 0);
    g.add(leg);
  });

  return g;
}

/**
 * キャラクター色変えヘルパー（ボス＝赤系装甲、ヒロイン＝パステル桜ピンク×パールホワイト）
 * @param {THREE.Object3D} model
 * @param {{mode: 'boss'|'heroine'}} palette
 */
export function tintRobotModel(model, palette) {
  if (!model || !palette) return;
  model.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    child.castShadow = true;
    child.receiveShadow = true;

    const mats = Array.isArray(child.material) ? child.material : [child.material];
    const cloned = mats.map((m) => {
      const nm = m.clone();
      const matName = (nm.name || '').toLowerCase();
      if (palette.mode === 'boss') {
        if (
          matName.includes('main') ||
          matName.includes('yellow') ||
          (nm.color && nm.color.r > 0.55 && nm.color.g > 0.35)
        ) {
          nm.color.setHex(0xdc2626);
          if (nm.emissive) nm.emissive.setHex(0x450a0a);
        } else if (matName.includes('grey') || matName.includes('gray')) {
          nm.color.setHex(0x334155);
        }
      } else if (palette.mode === 'heroine') {
        if (
          matName.includes('main') ||
          matName.includes('yellow') ||
          (nm.color && nm.color.r > 0.55 && nm.color.g > 0.35 && nm.color.b < 0.35)
        ) {
          nm.color.setHex(0xf9a8d4);
          if (nm.emissive) {
            nm.emissive.setHex(0xf472b6);
            nm.emissiveIntensity = 0.16;
          }
          if (typeof nm.roughness === 'number') nm.roughness = 0.32;
        } else if (matName.includes('grey') || matName.includes('gray')) {
          nm.color.setHex(0xfff1f5);
          if (typeof nm.roughness === 'number') nm.roughness = 0.28;
        }
      }
      return nm;
    });
    child.material = Array.isArray(child.material) ? cloned : cloned[0];
  });
}

/**
 * GLTF ロボット用アニメーションコントローラー
 */
export class AnimController {
  /**
   * @param {THREE.Object3D} model
   * @param {Array<THREE.AnimationClip>} animations
   */
  constructor(model, animations) {
    this.rootModel = model;
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = Object.create(null);
    this.currentName = null;

    if (Array.isArray(animations)) {
      for (let i = 0; i < animations.length; i++) {
        const clip = animations[i];
        if (clip && clip.name) {
          this.actions[clip.name] = this.mixer.clipAction(clip);
        }
      }
    }
  }

  /**
   * クリップ名を指定してアニメーションをクロスフェード再生
   * @param {string} name
   * @param {{loop?: number, timeScale?: number, fade?: number, force?: boolean}} options
   */
  play(name, { loop = THREE.LoopRepeat, timeScale = 1.0, fade = 0.12, force = false } = {}) {
    const next = this.actions[name];
    if (!next) return;
    if (this.currentName === name && !force) {
      next.timeScale = timeScale;
      return;
    }
    const prev = this.currentName ? this.actions[this.currentName] : null;
    next.reset();
    next.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
    next.clampWhenFinished = loop === THREE.LoopOnce;
    next.timeScale = timeScale;
    next.play();
    if (prev && prev !== next) {
      prev.crossFadeTo(next, fade, false);
    }
    this.currentName = name;
  }

  /**
   * アニメーションミキサーを安全に更新
   * @param {number} dt 秒
   */
  update(dt) {
    if (!this.mixer) return;
    const safeDt = Math.max(0, safeFinite(dt, 0));
    if (safeDt > 0) {
      this.mixer.update(safeDt);
    }
  }

  /**
   * ミキサー参照を解放
   */
  dispose() {
    if (this.mixer) {
      try {
        this.mixer.stopAllAction();
        if (this.rootModel) {
          this.mixer.uncacheRoot(this.rootModel);
        }
      } catch (_e) {}
    }
    this.actions = Object.create(null);
    this.currentName = null;
  }
}