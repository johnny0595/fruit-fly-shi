/* The 3D fly and its stage. Procedural Drosophila in three.js (r149, global THREE).
 *
 * Fly space: +x forward (head), +y up, +z the fly's left. Units roughly 1 = 0.7 mm.
 * The app drives it with one call per frame: stage.frame(dt, event, progress, info)
 *   event: idle | stonks | hold | exit | escape | retreat
 */
(function () {
  const T = THREE;
  T.ColorManagement.legacyMode = false; // hex colours are sRGB, like everywhere else
  const V = (x, y, z) => new T.Vector3(x, y, z);
  const UP = V(0, 1, 0);
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  function canvasTex(w, h, draw, repeat) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    const t = new T.CanvasTexture(c);
    t.encoding = T.sRGBEncoding;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    t.anisotropy = 4;
    return t;
  }

  // ---------- textures ----------
  const linear = (t) => { t.encoding = T.LinearEncoding; return t; };
  const noise = () => linear(canvasTex(256, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) { const v = 110 + Math.random() * 90; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
  }, [3, 3]));
  const facets = () => linear(canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
    const r = 5.2, dx = r * 1.75, dy = r * 1.52;
    for (let row = 0, y = 0; y < h + dy; row++, y += dy)
      for (let x = (row % 2) * dx / 2; x < w + dx; x += dx) {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, "#fff"); gr.addColorStop(0.75, "#bbb"); gr.addColorStop(1, "#222");
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      }
  }));
  const bands = () => canvasTex(64, 512, (g, w, h) => {
    // abdomen: tan segments with dark posterior bands (mapped along the body axis)
    g.fillStyle = "#b08850"; g.fillRect(0, 0, w, h);
    const n = 6;
    for (let k = 0; k < n; k++) {
      const y0 = h * (0.14 + k * 0.13);
      const gr = g.createLinearGradient(0, y0, 0, y0 + h * 0.07);
      gr.addColorStop(0, "rgba(45,25,10,0)"); gr.addColorStop(0.5, "rgba(45,25,10,.85)"); gr.addColorStop(1, "rgba(45,25,10,.2)");
      g.fillStyle = gr; g.fillRect(0, y0, w, h * 0.07);
    }
  });
  const thoraxTex = () => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#a9814c"; g.fillRect(0, 0, w, h);
    for (const [x, a] of [[0.38, 0.35], [0.5, 0.25], [0.62, 0.35]]) {
      const gr = g.createLinearGradient(w * (x - 0.05), 0, w * (x + 0.05), 0);
      gr.addColorStop(0, "rgba(90,60,35,0)"); gr.addColorStop(0.5, `rgba(90,60,35,${a})`); gr.addColorStop(1, "rgba(90,60,35,0)");
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }
  });
  const wingTex = () => canvasTex(512, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,.55)"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(70,50,30,.9)"; g.lineWidth = 3; g.lineCap = "round";
    const vein = (pts) => { g.beginPath(); g.moveTo(pts[0][0] * w, pts[0][1] * h); for (const [x, y] of pts.slice(1)) g.lineTo(x * w, y * h); g.stroke(); };
    vein([[0, 0.5], [0.45, 0.18], [1, 0.12]]);
    vein([[0, 0.5], [0.5, 0.33], [1, 0.32]]);
    vein([[0.02, 0.5], [0.5, 0.52], [0.98, 0.55]]);
    vein([[0.05, 0.52], [0.5, 0.7], [0.92, 0.8]]);
    vein([[0.1, 0.55], [0.45, 0.85]]);
    g.lineWidth = 2; vein([[0.42, 0.33], [0.42, 0.52]]); vein([[0.66, 0.52], [0.68, 0.74]]);
  });

  // ---------- geometry helpers ----------
  function ellipsoid(r, mat, segs = 48) {
    const geo = new T.SphereGeometry(1, segs, Math.round(segs * 0.75));
    const m = new T.Mesh(geo, mat);
    m.scale.set(r[0], r[1], r[2]);
    m.castShadow = true;
    return m;
  }
  function segment(radius, mat) {
    const geo = new T.CylinderGeometry(radius * 0.85, radius, 1, 10);
    geo.translate(0, 0.5, 0);
    const m = new T.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }
  function span(mesh, a, b) {
    const d = b.clone().sub(a), len = d.length();
    mesh.position.copy(a);
    mesh.quaternion.setFromUnitVectors(UP, d.normalize());
    mesh.scale.set(1, len, 1);
  }
  function ik(hip, foot, l1, l2, pole) {
    const d = foot.clone().sub(hip);
    const dist = Math.min(d.length(), (l1 + l2) * 0.995);
    const dir = d.normalize();
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    return { knee: hip.clone().add(dir.clone().multiplyScalar(a)).add(pp.multiplyScalar(h)), foot: hip.clone().add(dir.multiplyScalar(dist)) };
  }

  class Fly {
    constructor(scene) {
      const root = new T.Group(); this.root = root; scene.add(root);
      const body = new T.Group(); this.body = body; root.add(body);

      const chitin = new T.MeshPhysicalMaterial({ color: 0xffffff, map: thoraxTex(), roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4, bumpMap: noise(), bumpScale: 0.004, sheen: 0.3, sheenColor: new T.Color(0xd9b98a), envMapIntensity: 0.7 });
      const headMat = new T.MeshPhysicalMaterial({ color: 0xb98d55, roughness: 0.55, clearcoat: 0.25, bumpMap: noise(), bumpScale: 0.003 });
      const abdMat = new T.MeshPhysicalMaterial({ color: 0xffffff, map: bands(), roughness: 0.45, clearcoat: 0.4, bumpMap: noise(), bumpScale: 0.003, envMapIntensity: 0.7 });
      const eyeMat = new T.MeshPhysicalMaterial({ color: 0x9e0b12, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.06, bumpMap: facets(), bumpScale: 0.02, emissive: 0x3a0204, envMapIntensity: 1.4 });
      const legMat = new T.MeshStandardMaterial({ color: 0x7a5228, roughness: 0.6, bumpMap: noise(), bumpScale: 0.002 });
      const tarsMat = new T.MeshStandardMaterial({ color: 0x2e1c0c, roughness: 0.7 });
      const hairMat = new T.MeshStandardMaterial({ color: 0x24160a, roughness: 0.8 });
      this.legMat = legMat;

      // thorax
      const thorax = ellipsoid([0.5, 0.44, 0.42], chitin); thorax.position.set(0, 1.0, 0); body.add(thorax);
      const scutellum = ellipsoid([0.2, 0.12, 0.22], chitin); scutellum.position.set(-0.42, 1.3, 0); body.add(scutellum);
      // abdomen: sphere with poles along x so the band texture rings the body
      const abdGeo = new T.SphereGeometry(1, 48, 36); abdGeo.rotateZ(Math.PI / 2);
      const abdomen = new T.Mesh(abdGeo, abdMat); abdomen.scale.set(0.62, 0.38, 0.4); abdomen.position.set(-0.82, 0.9, 0); abdomen.rotation.z = 0.16; abdomen.castShadow = true;
      body.add(abdomen); this.abdomen = abdomen;
      // head
      const head = new T.Group(); head.position.set(0.6, 1.08, 0); body.add(head); this.head = head;
      const skull = ellipsoid([0.2, 0.3, 0.34], headMat); head.add(skull);
      const face = ellipsoid([0.1, 0.2, 0.1], headMat); face.position.set(0.17, -0.04, 0); head.add(face);
      for (const s of [-1, 1]) {
        const eye = ellipsoid([0.2, 0.29, 0.17], eyeMat, 64); eye.position.set(0.04, 0.03, s * 0.24); eye.rotation.y = s * -0.35; head.add(eye);
        const ant = segment(0.025, headMat); span(ant, V(0.2, 0.12, s * 0.06), V(0.3, 0.06, s * 0.1)); head.add(ant);
        const arista = segment(0.006, hairMat); span(arista, V(0.3, 0.06, s * 0.1), V(0.42, 0.2, s * 0.2)); head.add(arista);
      }
      for (const [y, z] of [[0.29, 0], [0.27, 0.05], [0.27, -0.05]]) { const o = ellipsoid([0.025, 0.02, 0.025], eyeMat, 12); o.position.set(-0.04, y, z); head.add(o); }
      // proboscis
      this.prob = new T.Group(); this.prob.position.set(0.18, -0.24, 0); head.add(this.prob);
      this.rostrum = segment(0.045, headMat); this.prob.add(this.rostrum);
      this.labellum = ellipsoid([0.07, 0.05, 0.09], headMat); this.prob.add(this.labellum);
      // bristles on thorax and head
      const hairGeo = new T.ConeGeometry(0.007, 0.12, 4); hairGeo.translate(0, 0.06, 0);
      const hairs = new T.InstancedMesh(hairGeo, hairMat, 140);
      const m4 = new T.Matrix4(), q = new T.Quaternion();
      for (let i = 0; i < 140; i++) {
        const onHead = i >= 110;
        const th = Math.random() * Math.PI * 2, ph = Math.random() * 1.2;
        const n = V(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
        const c = onHead ? V(0.6, 1.08, 0) : V(0, 1.0, 0), r = onHead ? [0.2, 0.3, 0.34] : [0.56, 0.5, 0.46];
        const p = V(c.x + n.x * r[0], c.y + n.y * r[1], c.z + n.z * r[2]);
        const dir = n.clone().add(V(-0.9, 0.2, 0)).normalize();
        q.setFromUnitVectors(UP, dir);
        m4.compose(p, q, V(1, onHead ? 0.6 : 0.7 + Math.random() * 0.8, 1));
        hairs.setMatrixAt(i, m4);
      }
      body.add(hairs);
      // wings
      const shape = new T.Shape();
      shape.moveTo(0, 0); shape.bezierCurveTo(0.35, 0.2, 1.2, 0.3, 1.75, 0.12);
      shape.bezierCurveTo(1.9, 0.0, 1.85, -0.25, 1.5, -0.33); shape.bezierCurveTo(1.0, -0.42, 0.4, -0.25, 0, 0);
      const wgeo = new T.ShapeGeometry(shape, 24);
      wgeo.computeBoundingBox();
      const bb = wgeo.boundingBox, uv = wgeo.attributes.uv, pos = wgeo.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y));
      wgeo.rotateX(-Math.PI / 2); // lie flat, span along +x
      const wmat = new T.MeshPhysicalMaterial({ color: 0xc9d6e6, map: wingTex(), transparent: true, opacity: 0.3, roughness: 0.15, metalness: 0, iridescence: 1, iridescenceIOR: 1.35, iridescenceThicknessRange: [200, 700], side: T.DoubleSide, depthWrite: false });
      this.wings = [-1, 1].map((s) => {
        const pivot = new T.Group(); pivot.position.set(-0.08, 1.36, s * 0.16); body.add(pivot);
        const w = new T.Mesh(wgeo, wmat); w.rotation.y = Math.PI; w.scale.set(0.85, 1, -s * 0.85); pivot.add(w); // span backwards
        return { pivot, side: s };
      });
      // legs: hip in body space, rest foot in root space
      this.legs = [
        { hip: V(0.32, 0.66, 0.16), foot: V(1.05, 0, 0.72), l1: 0.62, l2: 0.68, front: true },
        { hip: V(0.04, 0.6, 0.22), foot: V(0.15, 0, 1.12), l1: 0.7, l2: 0.78 },
        { hip: V(-0.22, 0.64, 0.2), foot: V(-0.95, 0, 0.98), l1: 0.72, l2: 0.84 },
      ].flatMap((L) => [-1, 1].map((s) => {
        const leg = { ...L, s, hip: V(L.hip.x, L.hip.y, L.hip.z * s), foot: V(L.foot.x, L.foot.y, L.foot.z * s), cur: V(L.foot.x, 0, L.foot.z * s) };
        leg.femur = segment(0.042, legMat); leg.tibia = segment(0.028, legMat); leg.tarsus = segment(0.018, tarsMat);
        leg.kneeBall = ellipsoid([0.04, 0.04, 0.04], legMat, 12);
        root.add(leg.femur, leg.tibia, leg.tarsus, leg.kneeBall);
        return leg;
      }));
    }

    pose(st, t) {
      const b = this.body;
      b.position.set(st.x, st.lift + st.bob, 0);
      b.rotation.set(st.roll, 0, st.pitch);
      b.updateMatrix();
      this.head.rotation.set(st.headRoll, st.headYaw, 0);
      // proboscis reaches forward-down toward the food
      const L = 0.08 + st.prob * 0.42;
      this.prob.rotation.z = -0.5 - st.prob * 0.45;
      span(this.rostrum, V(0, 0, 0), V(0, -L, 0));
      this.labellum.position.set(0, -L - 0.03, 0);
      this.labellum.scale.set(0.07 * (1 + st.prob * 0.4), 0.05, 0.09 * (1 + st.prob * 0.4));
      // wings: folded over the abdomen, or a flapping blur
      for (const w of this.wings) {
        const flap = st.flap ? Math.sin(t * 0.09) * 1.1 : 0;
        w.pivot.rotation.set(w.side * (st.flap ? 0.2 + flap : 0.32 + st.spread * 0.25), w.side * (0.32 + st.spread * 0.6), st.flap ? 0.25 : 0.12);
      }
      const bodyM = b.matrix;
      const sideOut = (s) => V(0, 0.9, s * 1).normalize();
      for (const leg of this.legs) {
        const hip = leg.hip.clone().applyMatrix4(bodyM);
        let target = leg.foot.clone();
        target.x += st.x;
        if (st.walk) { // tripod gait backwards
          const group = (leg.front || leg.l1 > 0.71) ? (leg.s > 0) : (leg.s < 0);
          const ph = t * 0.012 + (group ? 0 : Math.PI);
          target.x += Math.sin(ph) * 0.16;
          target.y += Math.max(0, Math.cos(ph)) * 0.14;
        }
        if (st.air > 0) {
          const tuck = hip.clone().add(V(leg.front ? 0.2 : -0.15 + (leg.l1 > 0.71 ? -0.2 : 0), -0.75, leg.s * 0.35));
          target.lerp(tuck, st.air);
        }
        if (leg.front && st.groom > 0) {
          const rub = V(0.92 + st.x, 1.0 + st.lift + Math.sin(t * 0.018) * 0.05, leg.s * (0.05 + Math.sin(t * 0.02 + leg.s) * 0.04));
          target.lerp(rub, st.groom);
        }
        leg.cur.lerp(target, 0.5);
        const pole = sideOut(leg.s).add(V(leg.front && st.groom > 0.5 ? 0.6 : 0, 0, 0));
        const { knee, foot } = ik(hip, leg.cur, leg.l1, leg.l2, pole);
        span(leg.femur, hip, knee); span(leg.tibia, knee, foot);
        leg.kneeBall.position.copy(knee);
        const out = V(leg.front ? 0.12 : leg.l1 > 0.71 ? -0.12 : 0, -0.02, leg.s * 0.1);
        span(leg.tarsus, foot, foot.clone().add(out));
      }
    }
  }

  function candleMesh(color) {
    const g = new T.Group();
    const mat = new T.MeshPhysicalMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.2, clearcoat: 1, toneMapped: false });
    const bodyGeo = new T.BoxGeometry(0.2, 1, 0.2); bodyGeo.translate(0, 0.5, 0);
    const body = new T.Mesh(bodyGeo, mat); body.castShadow = true;
    const wick = new T.Mesh(new T.BoxGeometry(0.03, 1.5, 0.03), mat); wick.position.y = 0.6;
    g.add(body, wick);
    const light = new T.PointLight(color, 0, 2.5); light.position.y = 0.6; g.add(light);
    g.userData = { body, wick, mat, light };
    return g;
  }

  class FlyStage {
    constructor(canvas, chartCanvas) {
      this.canvas = canvas;
      const r = new T.WebGLRenderer({ canvas, antialias: true });
      r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      r.outputEncoding = T.sRGBEncoding;
      r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 0.95;
      r.shadowMap.enabled = true; r.shadowMap.type = T.PCFSoftShadowMap;
      this.r = r;
      const scene = new T.Scene(); this.scene = scene;
      scene.background = new T.Color(0x05070b);
      scene.fog = new T.Fog(0x05070b, 9, 22);

      // studio environment for reflections on the eyes and chitin
      const env = new T.Scene();
      env.add(new T.Mesh(new T.BoxGeometry(30, 30, 30), new T.MeshBasicMaterial({ color: 0x0b0e14, side: T.BackSide })));
      for (const [p, c, s] of [[[6, 8, 4], 0xfff1dc, [6, 1, 6]], [[-8, 3, -2], 0x6fa8ff, [1, 6, 8]], [[0, 4, -9], 0x3b4a66, [12, 4, 1]], [[5, 2, -6], 0x3ddc84, [2, 2, 1]]]) {
        const m = new T.Mesh(new T.BoxGeometry(...s), new T.MeshBasicMaterial({ color: c })); m.position.set(...p); env.add(m);
      }
      scene.environment = new T.PMREMGenerator(r).fromScene(env, 0.04).texture;

      scene.add(new T.HemisphereLight(0x9fb8e0, 0x14100c, 0.55));
      const key = new T.DirectionalLight(0xfff0dc, 2.2); key.position.set(4, 7, 5); key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = key.shadow.camera.bottom = -3; key.shadow.camera.right = key.shadow.camera.top = 3; key.shadow.radius = 4; key.shadow.bias = -0.0005;
      scene.add(key);
      const rim = new T.DirectionalLight(0x7fb0ff, 1.4); rim.position.set(-5, 3, -4); scene.add(rim);

      // floor: shadow catcher + glowing grid
      const floor = new T.Mesh(new T.PlaneGeometry(60, 60), new T.ShadowMaterial({ opacity: 0.55 }));
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
      const grid = new T.GridHelper(60, 120, 0x2a4a74, 0x16263c); grid.position.y = 0.001; scene.add(grid);
      this.grid = grid;

      // the trading screen behind the fly
      this.chartTex = new T.CanvasTexture(chartCanvas); this.chartTex.encoding = T.sRGBEncoding; this.chartTex.anisotropy = 8;
      const screen = new T.Mesh(new T.PlaneGeometry(9.6, 5.4), new T.MeshBasicMaterial({ map: this.chartTex, toneMapped: false }));
      screen.position.set(-0.9, 2.95, -5.2); screen.rotation.y = 0.22; scene.add(screen);
      const bezel = new T.Mesh(new T.PlaneGeometry(9.8, 5.6), new T.MeshBasicMaterial({ color: 0x1a2232 }));
      bezel.position.copy(screen.position).add(V(0.0, 0, -0.02)); bezel.rotation.y = 0.22; scene.add(bezel);
      const glow = new T.PointLight(0x5c8cff, 0.6, 9); glow.position.set(-0.6, 3, -3); scene.add(glow);
      this.screen = screen;

      this.fly = new Fly(scene); this.fly.root.scale.setScalar(1.25);
      this.food = candleMesh(0x19c26c); this.food.position.set(1.2, 0, 0); this.food.visible = false; this.fly.root.add(this.food);
      this.crash = candleMesh(0xff3b3b); this.crash.visible = false; scene.add(this.crash);

      this.camera = new T.PerspectiveCamera(32, 1, 0.05, 80);
      this.st = { x: 0, lift: 0, bob: 0, pitch: 0, roll: 0, headYaw: 0, headRoll: 0, prob: 0, groom: 0, air: 0, flap: false, spread: 0, walk: false };
      this.food_h = 0; this.t = 0; this.shake = 0;
      this.resize();
      addEventListener("resize", () => this.resize());
    }

    resize() {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (!w || !h) return;
      this.r.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.fov = w / h < 1 ? 44 : 32;
      this.camera.updateProjectionMatrix();
    }

    chartChanged() { this.chartTex.needsUpdate = true; }

    /* ev: idle|stonks|hold|exit|escape|retreat; p: 0..1 progress; info: {pos, groom} */
    frame(dt, ev, p, info) {
      this.t += dt;
      const t = this.t, st = this.st, k = 1 - Math.exp(-dt / 120);
      const target = { prob: 0, groom: 0, spread: 0, headYaw: Math.sin(t / 1300) * 0.12, food: 0 };
      st.flap = false; st.walk = false; st.air = 0; let lift = 0, pitch = 0, x = 0, shake = 0;
      if (ev === "idle") target.groom = info.groom ? 1 : 0;
      if (ev === "stonks") { target.prob = p > 0.3 ? 1 : 0; target.food = info.pos; target.headYaw = 0; }
      if (ev === "hold") { target.prob = 1; target.food = info.pos; target.headYaw = 0; }
      if (ev === "exit") { target.food = 0; target.headYaw = -0.4; }
      if (ev === "retreat") { st.walk = p < 0.8; x = -0.5 * ease(p / 0.8); target.headYaw = 0.3 * Math.sin(t / 200); }
      if (ev === "escape") {
        target.food = 0; target.prob = 0;
        if (p < 0.2) { lift = -0.12 * ease(p / 0.2); pitch = 0.12 * ease(p / 0.2); }
        else if (p < 0.28) { const q = (p - 0.2) / 0.08; lift = lerp(-0.12, 0.6, q); st.air = q; st.flap = true; pitch = -0.2; }
        else if (p < 0.72) { const q = (p - 0.28) / 0.44; lift = 0.6 + q * q * 9; x = q * 2; st.air = 1; st.flap = true; pitch = -0.35; }
        else { const q = ease((p - 0.72) / 0.28); lift = 6 * Math.pow(1 - q, 2); st.air = clamp01(lift / 0.4); st.flap = lift > 0.02; pitch = -0.15 * (1 - q); }
        if (p > 0.16 && p < 0.34) shake = 0.06 * (1 - (p - 0.16) / 0.18);
        st.prob = Math.min(st.prob, 0.2); st.groom = 0; this.food_h *= 0.8;
      }
      st.prob += (target.prob - st.prob) * k;
      st.groom += (target.groom - st.groom) * (1 - Math.exp(-dt / 250));
      st.headYaw += (target.headYaw - st.headYaw) * k;
      st.spread += ((st.flap ? 1 : 0) - st.spread) * k;
      st.lift = lift; st.pitch = pitch; st.x = x;
      st.bob = st.air > 0 ? 0 : Math.sin(t / 700) * 0.008 + (ev === "hold" ? Math.sin(t / 110) * 0.006 : 0);
      st.headRoll = st.groom * Math.sin(t / 300) * 0.15;
      this.fly.pose(st, t);

      // the green candle it eats grows with position size
      this.food_h += ((ev === "stonks" ? info.pos * ease(p / 0.3) : target.food) - this.food_h) * (ev === "stonks" ? 1 : k);
      const fh = this.food_h;
      this.food.visible = fh > 0.02;
      if (this.food.visible) {
        const u = this.food.userData, h = 0.42 * Math.min(1, fh * 4), wdt = 0.45 + Math.min(1, fh) * 0.75;
        u.body.scale.set(wdt, h, wdt); u.wick.scale.y = (h + 0.16) / 1.5; u.wick.position.y = (h + 0.16) / 2;
        u.light.intensity = 1.2 + st.prob * Math.sin(t / 90) * 0.6;
      }
      // the red crash candle looms from the screen toward the camera
      this.crash.visible = ev === "escape" && p < 0.42;
      if (this.crash.visible) {
        const q = clamp01(p / 0.42), from = V(-1.6, 3.0, -4.9), to = this.camera.position.clone().add(V(-2.6, 0.6, -2.2));
        this.crash.position.copy(from.lerp(to, Math.pow(q, 2.2)));
        const s = 0.6 + q * 1.4; this.crash.scale.set(s, s, s);
        this.crash.rotation.set(q * 0.6, q * 2, q * 0.3);
        this.crash.userData.light.intensity = 3 * q;
      }
      // camera: slow drift, follows the takeoff, shakes on the crash
      const a = 0.5 + Math.sin(t / 7000) * 0.1, radius = innerWidth < 700 ? 9.5 : 8.2;
      const look = V(-0.2 + x * 0.7, 1.95 + Math.min(lift, 2.5) * 0.4, -1.2);
      this.camera.position.set(Math.sin(a) * radius, 2.6 + Math.min(lift, 2.5) * 0.25, Math.cos(a) * radius);
      if (shake) this.camera.position.add(V((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
      this.camera.lookAt(look);
      this.r.render(this.scene, this.camera);
    }
  }

  window.FlyStage = FlyStage;
})();
