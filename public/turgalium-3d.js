import * as THREE from '/vendor/three.module.js';

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function createRenderer(canvas, width, height) {
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x0b0e13, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    return renderer;
  } catch {
    return null;
  }
}

/**
 * Procedural dark-obsidian studio environment so brushed dark titanium ribs
 * and the emerald-mint prism core catch crisp architectural highlights on #0B0E13.
 */
function buildStudioEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x0b0e13);

  const plane = new THREE.PlaneGeometry(1, 1);
  const envMats = [];
  const addPanel = (hex, intensity, pos, scale, rot) => {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex).multiplyScalar(intensity),
      side: THREE.DoubleSide,
    });
    envMats.push(mat);
    const m = new THREE.Mesh(plane, mat);
    m.position.set(...pos);
    m.scale.set(...scale);
    if (rot) m.rotation.set(...rot);
    envScene.add(m);
  };

  // Architectural soft overhead key + cool slate fill + subtle Jupiter lime/mint rim panels
  addPanel(0xf3f6fa, 1.9, [0, 7.5, 2], [11, 9, 1], [Math.PI / 2, 0, 0]);
  addPanel(0xc7f284, 1.15, [-7.5, 4.2, 4.5], [7, 7, 1], [0, Math.PI / 3, 0]);
  addPanel(0x14f195, 1.25, [8, 2.2, 3], [7, 8, 1], [0, -Math.PI / 2.2, 0]);
  addPanel(0x1a212b, 1.0, [-6, -2.5, -5], [9, 3, 1], [0, Math.PI / 4, 0]);
  addPanel(0x131820, 1.0, [5, -3.5, -4], [10, 2.6, 1], [0, -Math.PI / 4, 0]);
  addPanel(0x0b0e13, 1.0, [0, -6.5, 0], [14, 14, 1], [-Math.PI / 2, 0, 0]);

  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  plane.dispose();
  for (const m of envMats) m.dispose();
  return rt;
}

function createSoftShadowTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(20, 241, 149, 0.14)');
    grad.addColorStop(0.45, 'rgba(11, 14, 19, 0.42)');
    grad.addColorStop(1, 'rgba(11, 14, 19, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Turgalium Dark-Obsidian 3D Convergence Sculpture:
 * Satin dark anodized-titanium flared funnel, 6 brushed gunmetal-titanium conduit ribs,
 * and a central frosted emerald-mint (#14F195 / #C7F284) glass triangular prism core.
 */
export function mountTurgaliumFunnelScene(canvas) {
  if (!canvas) return { setActive() {}, setPaused() {}, isRunning() { return false; }, destroy() {} };

  const rect = canvas.getBoundingClientRect();
  const w = Math.max(280, Math.round(rect.width || 560));
  const h = Math.max(240, Math.round(rect.height || 430));
  const renderer = createRenderer(canvas, w, h);
  if (!renderer) return { setActive() {}, setPaused() {}, isRunning() { return false; }, destroy() {} };

  const scene = new THREE.Scene();
  const envRT = buildStudioEnvironment(renderer);
  scene.environment = envRT.texture;

  const camera = new THREE.PerspectiveCamera(27, w / h, 0.1, 100);
  const fitCamera = (cw, ch) => {
    const aspect = Math.max(0.75, cw / Math.max(1, ch));
    const scale = aspect < 1.3 ? Math.min(1.38, 1.3 / aspect) : 1.0;
    camera.aspect = cw / Math.max(1, ch);
    camera.position.set(0, 2.05 * scale, 6.8 * scale);
    camera.lookAt(0, -0.05, 0);
    camera.updateProjectionMatrix();
  };
  fitCamera(w, h);

  scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0b0e13, 0.8));

  const key = new THREE.DirectionalLight(0xf3f6fa, 1.45);
  key.position.set(-4.5, 8.5, 6.5);
  scene.add(key);

  const limeRim = new THREE.DirectionalLight(0xc7f284, 0.95);
  limeRim.position.set(-6.5, 3.2, -3.5);
  scene.add(limeRim);

  const mintRim = new THREE.DirectionalLight(0x14f195, 1.1);
  mintRim.position.set(6.5, 2.8, -4);
  scene.add(mintRim);

  const root = new THREE.Group();
  root.position.y = 0.05;
  scene.add(root);

  // Subtle dark obsidian contact glow shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.3, 1.1),
    new THREE.MeshBasicMaterial({ map: createSoftShadowTexture(), transparent: true, depthWrite: false })
  );
  shadow.position.set(0, -1.78, -0.2);
  scene.add(shadow);

  // 1. Satin Dark Anodized-Titanium Sculpted Funnel Dish (LatheGeometry)
  const funnelPoints = [
    new THREE.Vector2(0.46, -1.22),
    new THREE.Vector2(0.56, -0.82),
    new THREE.Vector2(0.76, -0.32),
    new THREE.Vector2(1.16, 0.16),
    new THREE.Vector2(1.68, 0.56),
    new THREE.Vector2(1.76, 0.68),
    new THREE.Vector2(1.66, 0.8),
    new THREE.Vector2(1.48, 0.78),
    new THREE.Vector2(1.06, 0.34),
    new THREE.Vector2(0.66, -0.18),
    new THREE.Vector2(0.46, -0.78),
    new THREE.Vector2(0.38, -1.22),
    new THREE.Vector2(0.46, -1.22),
  ];

  const obsidianHullMat = new THREE.MeshPhysicalMaterial({
    color: 0x1a212b,
    roughness: 0.34,
    metalness: 0.62,
    clearcoat: 0.42,
    clearcoatRoughness: 0.26,
    envMapIntensity: 1.25,
  });

  const funnelMesh = new THREE.Mesh(new THREE.LatheGeometry(funnelPoints, 96), obsidianHullMat);
  root.add(funnelMesh);

  // 2. Brushed Dark-Titanium Precision Collar Rings + Conduit Ribs
  const titaniumMat = new THREE.MeshStandardMaterial({
    color: 0x6b778a,
    metalness: 0.92,
    roughness: 0.22,
    envMapIntensity: 1.45,
  });

  const titaniumDarkMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    metalness: 0.94,
    roughness: 0.24,
    envMapIntensity: 1.35,
  });

  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(1.16, 0.048, 28, 108), titaniumMat);
  innerRing.rotation.x = Math.PI / 2;
  innerRing.position.y = 0.56;
  root.add(innerRing);

  const lowerCollar = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.03, 20, 84), titaniumDarkMat);
  lowerCollar.rotation.x = Math.PI / 2;
  lowerCollar.position.y = -0.18;
  root.add(lowerCollar);

  // 6 Brushed-Titanium Sweeping Conduit Ribs
  const ribsGroup = new THREE.Group();
  root.add(ribsGroup);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(angle) * 1.14, 0.52, Math.sin(angle) * 1.14),
      new THREE.Vector3(Math.cos(angle) * 0.78, -0.1, Math.sin(angle) * 0.78),
      new THREE.Vector3(Math.cos(angle) * 0.52, -0.78, Math.sin(angle) * 0.52),
      new THREE.Vector3(Math.cos(angle) * 0.44, -1.32, Math.sin(angle) * 0.44),
    ]);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.042, 14, false), titaniumMat);
    ribsGroup.add(tube);
  }

  // 3. Central Luminous Emerald-Mint Frosted Glass Triangular Prism Core (Solana Core)
  const prismMat = new THREE.MeshPhysicalMaterial({
    color: 0x14f195,
    emissive: 0x0ea66b,
    emissiveIntensity: 0.2,
    roughness: 0.16,
    metalness: 0.08,
    transmission: 0.48,
    thickness: 1.15,
    ior: 1.45,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    transparent: true,
    opacity: 0.9,
    envMapIntensity: 1.4,
  });

  const prismGeo = new THREE.CylinderGeometry(0.36, 0.24, 2.28, 3, 1);
  const prism = new THREE.Mesh(prismGeo, prismMat);
  prism.position.y = -0.18;
  root.add(prism);

  // Crisp subtle lime-mint architectural prism edges
  const prismEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(prismGeo),
    new THREE.LineBasicMaterial({ color: 0xc7f284, transparent: true, opacity: 0.58 })
  );
  prism.add(prismEdges);

  // 6 Converging Dust Motes gliding down the funnel ribs into the Solana prism
  const moteGeo = new THREE.SphereGeometry(0.046, 16, 16);
  const moteMat = new THREE.MeshPhysicalMaterial({
    color: 0xc7f284,
    emissive: 0x14f195,
    emissiveIntensity: 0.35,
    roughness: 0.18,
    clearcoat: 1.0,
  });
  const motes = Array.from({ length: 6 }, (_, i) => {
    const m = new THREE.Mesh(moteGeo, moteMat);
    m.userData = { phase: i / 6, angle: (i / 6) * Math.PI * 2 };
    root.add(m);
    return m;
  });

  let activeBoost = false;
  let targetRotY = 0;
  let targetRotX = 0;
  let visible = true;
  let paused = false;
  let contextLost = false;
  let destroyed = false;
  let rafId = 0;
  let last = performance.now();
  let elapsed = 0;

  const isShellHidden = () => {
    const shell = document.getElementById('siteShell');
    if (shell && (shell.classList.contains('hidden') || shell.hidden)) return true;
    return Boolean(canvas.closest('.hidden'));
  };

  const shouldRun = () =>
    !destroyed &&
    !paused &&
    !contextLost &&
    visible &&
    !document.hidden &&
    !isShellHidden() &&
    !prefersReducedMotion();

  const stopLoop = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  const startLoop = () => {
    if (!shouldRun() || rafId) return;
    last = performance.now();
    rafId = requestAnimationFrame(tick);
  };

  const syncLoopState = () => {
    if (shouldRun()) startLoop();
    else stopLoop();
  };

  const onPointerMove = (e) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    targetRotY = nx * 0.28;
    targetRotX = ny * 0.12;
  };
  canvas.addEventListener('pointermove', onPointerMove, { passive: true });

  const onContextLost = (e) => {
    e.preventDefault();
    contextLost = true;
    stopLoop();
  };
  const onContextRestored = () => {
    contextLost = false;
    renderer.render(scene, camera);
    syncLoopState();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  const onVisibilityChange = () => syncLoopState();
  document.addEventListener('visibilitychange', onVisibilityChange);

  const ro = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    if (r.width > 40 && r.height > 40) {
      fitCamera(r.width, r.height);
      renderer.setSize(Math.round(r.width), Math.round(r.height), false);
      if (!contextLost && !isShellHidden()) {
        renderer.render(scene, camera);
      }
    }
    syncLoopState();
  });
  ro.observe(canvas);

  const io = new IntersectionObserver((entries) => {
    visible = entries[0]?.isIntersecting ?? true;
    syncLoopState();
  });
  io.observe(canvas);

  const siteShellEl = document.getElementById('siteShell');
  const mo =
    siteShellEl && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => syncLoopState())
      : null;
  if (mo && siteShellEl) {
    mo.observe(siteShellEl, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  }

  const tick = (now) => {
    rafId = 0;
    if (!shouldRun()) return;

    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    const speed = activeBoost ? 1.85 : 0.75;
    elapsed += dt * speed;

    root.position.y = 0.05 + Math.sin(elapsed * 1.1) * 0.045;
    prism.rotation.y += dt * 0.35 * speed;
    ribsGroup.rotation.y -= dt * 0.1 * speed;

    motes.forEach((m) => {
      const t = (m.userData.phase + elapsed * 0.22) % 1;
      const angle = m.userData.angle + t * 1.15;
      const radius = 1.42 * (1 - t) + 0.32 * t;
      const y = 0.72 * (1 - t) + -1.25 * t;
      m.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      const s = Math.sin(t * Math.PI);
      m.scale.setScalar(0.35 + s * 0.75);
    });

    root.rotation.y += (targetRotY + Math.sin(elapsed * 0.35) * 0.07 - root.rotation.y) * 0.05;
    root.rotation.x += (targetRotX - root.rotation.x) * 0.05;

    renderer.render(scene, camera);

    if (shouldRun()) {
      rafId = requestAnimationFrame(tick);
    }
  };

  if (!isShellHidden()) {
    renderer.render(scene, camera);
  }
  syncLoopState();

  const controller = {
    setActive(isActive) {
      activeBoost = Boolean(isActive);
    },
    setPaused(isPaused) {
      paused = Boolean(isPaused);
      syncLoopState();
    },
    isRunning() {
      return rafId !== 0;
    },
    destroy() {
      destroyed = true;
      stopLoop();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      ro.disconnect();
      io.disconnect();
      mo?.disconnect();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) {
            mat.map?.dispose?.();
            mat.dispose?.();
          }
        }
      });
      envRT.dispose();
      renderer.dispose();
    },
  };

  if (typeof window !== 'undefined') {
    window.TurgaliumHero3D = Object.assign(window.TurgaliumHero3D || {}, {
      mountTurgaliumFunnelScene,
      instance: controller,
      setActive: controller.setActive,
      setPaused: controller.setPaused,
      isRunning: controller.isRunning,
      destroy: controller.destroy,
    });
  }

  return controller;
}

if (typeof window !== 'undefined' && !window.TurgaliumHero3D) {
  window.TurgaliumHero3D = { mountTurgaliumFunnelScene };
}
