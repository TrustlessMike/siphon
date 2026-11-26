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
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    return renderer;
  } catch {
    return null;
  }
}

/**
 * Procedural studio softbox environment so brushed silver-titanium ribs and
 * frosted Kamino ice-cyan glass have crisp architectural reflections on #FCFCFC.
 */
function buildStudioEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0xf8fafc);

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

  addPanel(0xffffff, 2.3, [0, 7, 1], [12, 10, 1], [Math.PI / 2, 0, 0]);
  addPanel(0xffffff, 2.5, [-7, 4, 5], [8, 8, 1], [0, Math.PI / 3, 0]);
  addPanel(0xc6f4ff, 2.0, [8, 2, 3], [8, 9, 1], [0, -Math.PI / 2.2, 0]);
  addPanel(0x18181b, 1.0, [-6, -2.5, -5], [9, 3, 1], [0, Math.PI / 4, 0]);
  addPanel(0x27272a, 1.0, [5, -3.5, -4], [10, 2.6, 1], [0, -Math.PI / 4, 0]);
  addPanel(0x0f172a, 1.0, [0, -6.5, 0], [14, 14, 1], [-Math.PI / 2, 0, 0]);

  const rt = pmrem.fromScene(envScene, 0.035);
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
    const grad = ctx.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(15, 23, 42, 0.13)');
    grad.addColorStop(0.5, 'rgba(15, 23, 42, 0.04)');
    grad.addColorStop(1, 'rgba(15, 23, 42, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Turgalium Daylight 3D Convergence Sculpture:
 * Matte porcelain-ceramic flared funnel, 6 brushed silver-titanium vertical conduit ribs
 * (6 EVM chains), and a central frosted Kamino ice-cyan (#C6F4FF) glass triangular prism core.
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

  scene.add(new THREE.HemisphereLight(0xffffff, 0xe2e8f0, 0.95));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-5, 8, 6);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xc6f4ff, 1.2);
  rim.position.set(6, 3, -4);
  scene.add(rim);

  const root = new THREE.Group();
  root.position.y = 0.05;
  scene.add(root);

  // Soft grounded studio shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 1.05),
    new THREE.MeshBasicMaterial({ map: createSoftShadowTexture(), transparent: true, depthWrite: false })
  );
  shadow.position.set(0, -1.78, -0.2);
  scene.add(shadow);

  // 1. Matte Porcelain-Ceramic Sculpted Funnel Dish (LatheGeometry)
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

  const ceramicMat = new THREE.MeshPhysicalMaterial({
    color: 0xf5f6f8,
    roughness: 0.3,
    metalness: 0.03,
    clearcoat: 0.35,
    clearcoatRoughness: 0.25,
    envMapIntensity: 0.75,
  });

  const funnelMesh = new THREE.Mesh(new THREE.LatheGeometry(funnelPoints, 96), ceramicMat);
  root.add(funnelMesh);

  // 2. Brushed Silver-Titanium Precision Collar Ring + Inner Basin
  const titaniumMat = new THREE.MeshStandardMaterial({
    color: 0xd0d5de,
    metalness: 0.94,
    roughness: 0.18,
    envMapIntensity: 1.35,
  });

  const titaniumDarkMat = new THREE.MeshStandardMaterial({
    color: 0x8a92a1,
    metalness: 0.95,
    roughness: 0.22,
    envMapIntensity: 1.3,
  });

  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(1.16, 0.048, 28, 108), titaniumMat);
  innerRing.rotation.x = Math.PI / 2;
  innerRing.position.y = 0.56;
  root.add(innerRing);

  const lowerCollar = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.03, 20, 84), titaniumDarkMat);
  lowerCollar.rotation.x = Math.PI / 2;
  lowerCollar.position.y = -0.18;
  root.add(lowerCollar);

  // 6 Brushed-Titanium Sweeping Conduit Ribs (representing Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche)
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

  // 3. Central Luminous Frosted Kamino Ice-Cyan Glass Triangular Prism Core (Solana Core)
  const prismMat = new THREE.MeshPhysicalMaterial({
    color: 0xa5efff,
    emissive: 0x38bdf8,
    emissiveIntensity: 0.1,
    roughness: 0.14,
    metalness: 0.03,
    transmission: 0.52,
    thickness: 1.2,
    ior: 1.44,
    clearcoat: 1.0,
    clearcoatRoughness: 0.07,
    transparent: true,
    opacity: 0.92,
    envMapIntensity: 1.45,
  });

  const prismGeo = new THREE.CylinderGeometry(0.36, 0.24, 2.28, 3, 1);
  const prism = new THREE.Mesh(prismGeo, prismMat);
  prism.position.y = -0.18;
  root.add(prism);

  // Subtle architectural prism edges
  const prismEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(prismGeo),
    new THREE.LineBasicMaterial({ color: 0xe0f8ff, transparent: true, opacity: 0.85 })
  );
  prism.add(prismEdges);

  // 6 Converging Dust Motes gliding down the funnel ribs into the Solana prism
  const moteGeo = new THREE.SphereGeometry(0.048, 16, 16);
  const moteMat = new THREE.MeshPhysicalMaterial({
    color: 0xc6f4ff,
    emissive: 0x0ea5e9,
    emissiveIntensity: 0.18,
    roughness: 0.15,
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

  return {
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
}
