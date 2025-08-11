// État du jeu minimal pour le menu et HUD
const state = {
  phase: "menu", // menu | playing
  players: 2,
  currentPlayerIndex: 0, // 0..3
  playerColors: ["blue", "red", "purple", "yellow"],
  turnMs: 60_000,
  turnStart: 0,
  timerId: null,
  isPaused: false,
  turnRatio: 1,
  codeBuffer: "",
  buildingSelection: null, // { type: 'silo' } | null
  // Carte (dimension fixe, on zoome pour la voir entière)
  tileSize: 28, // taille de base (utilisée pour calculs internes)
  mapCols: 96,
  mapRows: 69,
  cols: 0,
  rows: 0,
  tiles: null, // 2D array: true=wall, false=floor
  spawns: [],
  hqs: [],
};

const q = (sel, el = document) => el.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  if (props.className) n.setAttribute("class", props.className);
  for (const c of children) n.append(c);
  return n;
};

function mountApp() {
  renderApp();
}

function renderApp() {
  const app = q('#app');
  app.innerHTML = '';
  if (state.phase === 'menu') {
    app.append(renderMenu());
  } else {
    app.append(renderGame());
  }
}

function renderMenu() {
  const container = el('div', { className: 'menu-screen' });
  const title = el('h1', { textContent: 'Robot War' });
  const subtitle = el('p', { className: 'subtitle', textContent: 'Sélectionnez le nombre de joueurs' });

  const choices = el('div', { className: 'select-group' });
  const options = [2,3,4];
  for (const n of options) {
    const b = button(`${n} joueurs`, () => setPlayers(n), 'btn choice');
    if (state.players === n) b.classList.add('active');
    b.dataset.value = String(n);
    choices.append(b);
  }

  const start = button('Lancer la partie', () => startGame(), 'btn primary');

  container.append(title, subtitle, choices, start);
  return container;
}

function setPlayers(n) {
  state.players = n;
  // rafraîchit seulement le groupe pour l’active
  const group = q('.select-group');
  if (!group) return;
  group.querySelectorAll('button').forEach(b => b.classList.toggle('active', Number(b.dataset.value) === n));
}

function startGame() {
  state.phase = 'playing';
  state.currentPlayerIndex = 0;
  // Dimension logique fixe de la carte
  state.cols = state.mapCols;
  state.rows = state.mapRows;
  state.tiles = generateCaveMap(state.cols, state.rows);
  state.hqs = computeHQs(state.players);
  state.isPaused = false;
  renderApp();
  // Démarre le cycle de tour après que la HUD soit montée
  setTimeout(() => startTurnTimer(), 0);
}

function renderGame() {
  const wrapper = el('div', { className: 'board' });
  const canvas = el('canvas', { id: 'game' });
  wrapper.append(canvas);

  // HUD: barre de tour + pause
  const hud = el('div', { className: 'hud' });
  const barWrap = el('div', { className: 'turnbar-wrap' }, [
    el('div', { className: 'turnbar', id: 'turnBarBottom' })
  ]);
  hud.append(barWrap);

  const pauseBtn = el('button', { className: 'pause-btn', id: 'pauseBtn', title: 'Pause/Play' });
  pauseBtn.append(iconPause());
  pauseBtn.addEventListener('click', togglePause);
  hud.append(pauseBtn);

  const pauseOverlay = el('div', { className: 'pause-overlay', id: 'pauseOverlay' }, [
    el('div', { className: 'big' }, [el('span'), el('span')])
  ]);
  hud.append(pauseOverlay);

  wrapper.append(hud);

  // Prépare le canvas et dessine la carte existante (déjà générée au lancement)
  setTimeout(() => {
    resizeCanvas(canvas);
    drawScene(canvas);
  });

  // Sur resize, on NE régénère PAS: on ajuste juste l'échelle pour voir la carte entière
  window.addEventListener('resize', () => {
    resizeCanvas(canvas);
    drawScene(canvas);
  });

  return wrapper;
}

function button(label, onClick, className = '') {
  const b = el('button', { textContent: label, className });
  b.addEventListener('click', onClick);
  return b;
}

function openNewGameDialog() {
  closeAnyDialog();
  const overlay = el('div', { className: 'overlay', id: 'overlay' });
  const content = el('div', { className: 'dialog' }, [
    el('h2', { textContent: 'Nouvelle partie' }),
    el('p', { textContent: 'Choisissez le nombre de joueurs:' }),
    el('div', { className: 'row' }, [
      button('2 joueurs', () => beginGame(2), 'icon'),
      button('3 joueurs', () => beginGame(3), 'icon'),
      button('4 joueurs', () => beginGame(4), 'icon'),
    ]),
  ]);
  overlay.append(content);
  q('.board').append(overlay);
}

function closeAnyDialog() {
  const ov = q('#overlay');
  if (ov) ov.remove();
}

function beginGame(players) {
  state.players = players;
  state.currentPlayerIndex = 0;
  state.phase = 'playing';
  closeAnyDialog();
  startTurnTimer();
  drawPlayerButton();
}

function drawPlayerButton() {
  const color = state.playerColors[state.currentPlayerIndex];
  const map = { blue: 'player-blue', red: 'player-red', purple: 'player-purple', yellow: 'player-yellow' };
  const btn = q('#playerBtn');
  if (!btn) return; // HUD sans bouton joueur dans la vue actuelle
  btn.className = map[color] || 'player-blue';
  btn.textContent = `Joueur ${state.currentPlayerIndex + 1}`;
  btn.onclick = () => toggleEntryPad();
}

function toggleEntryPad() {
  const dock = q('.bottom-dock');
  // Rien à ouvrir/fermer explicitement ici, le pavé est toujours visible dans cette v1
}

function renderNumpad() {
  const wrap = el('div', { className: 'numpad', id: 'numpad' });
  const keys = ['7','8','9','4','5','6','1','2','3','0','⌫','OK'];
  for (const k of keys) {
    const b = button(k, () => onPad(k));
    wrap.append(b);
  }
  return wrap;
}

function onPad(k) {
  const input = q('#codeInput');
  if (k === '⌫') {
    input.value = input.value.trimEnd().slice(0, -1);
    return;
  }
  if (k === 'OK') {
    commitCode();
    return;
  }
  // Ajoute un espace si nécessaire
  input.value = (input.value + ' ' + k).trim().replace(/\s+/g, ' ');
}

function commitCode() {
  const input = q('#codeInput');
  state.codeBuffer = input.value.trim();
  if (!state.codeBuffer) return;
  // Pour la v1 on log seulement
  console.log(`Code validé pour Joueur ${state.currentPlayerIndex + 1}:`, state.codeBuffer);
  input.value = '';
}

function renderBuildMenu() {
  const wrap = el('div', { className: 'build-menu' });
  const tile = el('div', { className: 'build-tile' }, [
    el('div', { className: 'title', textContent: 'Silo' }),
    el('div', { className: 'cost', textContent: 'Coût: 5 minerais' }),
    button('Placer', () => selectBuilding('silo'), 'icon')
  ]);
  wrap.append(tile);
  return wrap;
}

function selectBuilding(type) {
  state.buildingSelection = { type };
  console.log('Construction sélectionnée:', type);
}

// Tour
function startTurnTimer() {
  state.turnStart = performance.now();
  state.turnRatio = 1;
  updateTurnBar(1);
  if (state.timerId) cancelAnimationFrame(state.timerId);
  const tick = () => {
    if (!state.isPaused) {
      const elapsed = performance.now() - state.turnStart;
      const remainRatio = Math.max(0, 1 - (elapsed / state.turnMs));
      state.turnRatio = remainRatio;
      updateTurnBar(state.turnRatio);
      if (remainRatio <= 0) { nextPlayer(); return; }
    }
    state.timerId = requestAnimationFrame(tick);
  };
  state.timerId = requestAnimationFrame(tick);
}

function updateTurnBar(ratio) {
  const bar = q('#turnBarBottom');
  if (!bar) return;
  bar.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(3)}%`;
  const color = getPlayerColor(state.currentPlayerIndex);
  bar.style.setProperty('--barColor', color);
}

function nextPlayer() {
  if (state.timerId) { cancelAnimationFrame(state.timerId); state.timerId = null; }
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players;
  state.isPaused = false;
  state.turnStart = performance.now();
  state.turnRatio = 1;
  const bar = q('#turnBarBottom');
  if (bar) {
    bar.style.width = '100%';
    bar.style.setProperty('--barColor', getPlayerColor(state.currentPlayerIndex));
  }
  drawPlayerButton();
  if (state.timerId) cancelAnimationFrame(state.timerId);
  const tick = () => {
    if (!state.isPaused) {
      const elapsed = performance.now() - state.turnStart;
      state.turnRatio = Math.max(0, 1 - (elapsed / state.turnMs));
      updateTurnBar(state.turnRatio);
      if (state.turnRatio <= 0) { nextPlayer(); return; }
    }
    state.timerId = requestAnimationFrame(tick);
  };
  state.timerId = requestAnimationFrame(tick);
}

function getPlayerColor(idx) {
  const key = state.playerColors[idx];
  const map = { blue: '#4f8cff', red: '#f55454', purple: '#9b5cff', yellow: '#ffd166' };
  return map[key] || '#4f8cff';
}

function togglePause() {
  state.isPaused = !state.isPaused;
  const btn = q('#pauseBtn');
  const overlay = q('#pauseOverlay');
  if (state.isPaused) {
    btn.classList.add('play');
    btn.innerHTML = '';
    btn.append(iconPlay());
    overlay.style.display = 'grid';
  } else {
    // recalcule turnStart pour conserver la progression actuelle
    const bar = q('#turnBarBottom');
    const widthStr = bar && bar.style.width ? parseFloat(bar.style.width) : 100;
    const remain = Math.max(0, Math.min(100, widthStr)) / 100;
    state.turnStart = performance.now() - (state.turnMs * (1 - remain));
    btn.classList.remove('play');
    btn.innerHTML = '';
    btn.append(iconPause());
    overlay.style.display = 'none';
  }
}

// Rendu simple sur canvas (placeholder labyrinthe futur)
function resizeCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.floor(c.clientWidth * dpr);
  c.height = Math.floor(c.clientHeight * dpr);
}

function drawScene(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const widthCss = canvas.width / dpr;
  const heightCss = canvas.height / dpr;
  // Choisit une échelle pour afficher TOUTE la carte
  // Réserve 28px en bas pour la barre de tour
  const tile = Math.floor(Math.min(widthCss / state.cols, (heightCss - 28) / state.rows));
  const ox = Math.floor((widthCss - state.cols * tile) / 2);
  const oy = Math.floor((heightCss - state.rows * tile) / 2);

  ctx.save();
  ctx.scale(dpr, dpr);
  // Fond sol
  ctx.fillStyle = '#0d1118';
  ctx.fillRect(0, 0, widthCss, heightCss);

  // Dessine murs avec texture bruitée fine (avant la grille)
  if (state.tiles) {
    const tex = getOrCreateWallTexture(tile);
    if (tex) ctx.drawImage(tex, ox, oy);
  }

  // Grille discrète (dessinée APRÈS, pour qu'elle recouvre murs et sol)
  ctx.globalAlpha = 0.10;
  ctx.strokeStyle = '#2a3244';
  ctx.beginPath();
  for (let gx = 0; gx <= state.cols; gx++) {
    const px = ox + gx * tile; ctx.moveTo(px, oy); ctx.lineTo(px, oy + state.rows * tile);
  }
  for (let gy = 0; gy <= state.rows; gy++) {
    const py = oy + gy * tile; ctx.moveTo(ox, py); ctx.lineTo(ox + state.cols * tile, py);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Dessin des QG des joueurs
  if (state.hqs && state.hqs.length) {
    for (const hq of state.hqs) {
      drawHQ(ctx, hq, tile, ox, oy);
    }
  }

  ctx.restore();
}

function iconPause() { const d = el('div', { className: 'icon' }, [el('span'), el('span')]); return d; }
function iconPlay() { const d = el('div', { className: 'icon' }); d.classList.add('play'); d.append(el('span'), el('span')); return d; }

// Cache pour éviter de reconstruire la texture si le tile ne change pas
let wallTextureCache = { tile: 0, canvas: null };
function getOrCreateWallTexture(tile) {
  if (wallTextureCache.canvas && wallTextureCache.tile === tile) return wallTextureCache.canvas;
  const w = state.cols * tile;
  const h = state.rows * tile;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  const img = octx.createImageData(w, h);
  const data = img.data;
  const base = hexToRgb('#4b3a2c');
  // fréquence du bruit, légèrement augmentée
  const scale = 0.095; // plus petit -> motifs larges, plus grand -> motifs fins
  for (let y = 0; y < h; y++) {
    const ty = Math.floor(y / tile);
    for (let x = 0; x < w; x++) {
      const tx = Math.floor(x / tile);
      const idx = (y * w + x) * 4;
      if (!state.tiles[ty] || !state.tiles[ty][tx]) { data[idx+3] = 0; continue; }
      const n = fbmNoise2D(x * scale, y * scale, 4); // 0..1
      const delta = (n - 0.5) * 0.35; // +-35% pour un peu plus de contraste
      // mélange vers noir/blanc selon signe
      const mixTo = delta >= 0 ? 255 : 0;
      const t = Math.abs(delta);
      data[idx+0] = Math.round(base.r + (mixTo - base.r) * t);
      data[idx+1] = Math.round(base.g + (mixTo - base.g) * t);
      data[idx+2] = Math.round(base.b + (mixTo - base.b) * t);
      data[idx+3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  wallTextureCache = { tile, canvas: off };
  return off;
}

// --- Génération procédurale type grotte avec alvéoles et couloirs ---
function generateCaveMap(cols, rows) {
  // On tente plusieurs générations jusqu'à obtenir un ratio de sol "crédible"
  const targetMin = 0.40, targetMax = 0.62;
  let wallChance = 0.50;
  let last = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    let grid = generateOnce(cols, rows, wallChance);
    const ratio = floorRatio(grid);
    last = grid;
    if (ratio >= targetMin && ratio <= targetMax) return grid;
    // Ajuste la densité et réessaie
    if (ratio > targetMax) wallChance = Math.min(0.65, wallChance + 0.04); // trop de sol -> plus de murs au départ
    else wallChance = Math.max(0.35, wallChance - 0.04); // pas assez de sol -> moins de murs
  }
  return last;
}

function generateOnce(cols, rows, wallChance) {
  // 1) Grille aléatoire initiale (bords toujours murs)
  let grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      grid[y][x] = border ? true : Math.random() < wallChance;
    }
  }

  // 2) Automate cellulaire (cave-like)
  for (let i = 0; i < 6; i++) grid = stepCellular(grid);

  // 3) Nettoyage: supprime petites poches de sol et petites masses de murs
  grid = removeSmallRegions(grid, false, 30); // petites cavités -> murs
  grid = removeSmallRegions(grid, true, 50);  // petites bosses de murs -> sol

  // 4) Alvéoles aux coins (sans tout ouvrir)
  const chambers = buildCornerChambers(cols, rows);
  for (const ch of chambers) carveCircle(grid, ch.cx, ch.cy, Math.floor(ch.r * 0.8));
  state.spawns = chambers.map(c => ({ x: c.cx, y: c.cy }));

  // 5) Connectivité totale par couloirs fins
  connectAllRegions(grid);

  return grid;
}

function stepCellular(grid) {
  const rows = grid.length; const cols = grid[0].length;
  const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      if (border) { out[y][x] = true; continue; }
      const wallsAround = countWallNeighbors(grid, x, y);
      out[y][x] = wallsAround >= 5; // règle douce pour garder les galeries
    }
  }
  return out;
}

function countWallNeighbors(grid, x, y) {
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[0].length) { count++; continue; }
      if (grid[ny][nx]) count++;
    }
  }
  return count;
}

function buildCornerChambers(cols, rows) {
  const r = Math.max(6, Math.floor(Math.min(cols, rows) * 0.12));
  const margin = r + 2;
  return [
    { cx: margin, cy: margin, r },
    { cx: cols - 1 - margin, cy: margin, r },
    { cx: margin, cy: rows - 1 - margin, r },
    { cx: cols - 1 - margin, cy: rows - 1 - margin, r },
  ];
}

function carveCircle(grid, cx, cy, r) {
  const rows = grid.length, cols = grid[0].length;
  for (let y = Math.max(1, cy - r); y <= Math.min(rows - 2, cy + r); y++) {
    for (let x = Math.max(1, cx - r); x <= Math.min(cols - 2, cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) grid[y][x] = false;
    }
  }
}

function connectAllRegions(grid) {
  const regions = findFloorRegions(grid);
  if (regions.length <= 1) return;
  // Prend la région contenant la 1ère chambre comme principale (ou la plus grande sinon)
  let mainIndex = 0;
  if (state.spawns && state.spawns.length) {
    const seed = state.spawns[0];
    mainIndex = regions.findIndex(r => r.cells.some(c => c.x === seed.x && c.y === seed.y));
    if (mainIndex < 0) mainIndex = 0;
  } else {
    // plus grande région
    let max = -1; let idx = 0;
    regions.forEach((r, i) => { if (r.cells.length > max) { max = r.cells.length; idx = i; } });
    mainIndex = idx;
  }

  const connected = new Set([mainIndex]);
  // Connecte itérativement chaque région non connectée à la région principale via un couloir
  while (connected.size < regions.length) {
    let targetIndex = -1;
    let bestDist = Infinity;
    let bestPair = null;
    for (let i = 0; i < regions.length; i++) {
      if (connected.has(i)) continue;
      // trouve pair de cellules la plus proche entre cette région et une déjà connectée
      for (const ci of regions[i].cells) {
        for (const m of connected) {
          // centroid de la région principale m
          const cm = regions[m].centroid;
          const dx = cm.x - ci.x; const dy = cm.y - ci.y;
          const d = dx * dx + dy * dy;
          if (d < bestDist) { bestDist = d; targetIndex = i; bestPair = { from: ci, to: cm }; }
        }
      }
    }
    if (targetIndex === -1 || !bestPair) break;
    carveCorridor(grid, bestPair.from, bestPair.to, 1 + (Math.random() < 0.5 ? 1 : 0));
    // recalcul des régions n'est pas nécessaire si on suppose la connexion faite
    connected.add(targetIndex);
  }
}

function findFloorRegions(grid) {
  const rows = grid.length, cols = grid[0].length;
  const visited = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  const regions = [];
  const dirs = [ [1,0], [-1,0], [0,1], [0,-1] ];

  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      if (!grid[y][x] && !visited[y][x]) {
        const cells = [];
        const stack = [{ x, y }];
        visited[y][x] = true;
        while (stack.length) {
          const cur = stack.pop();
          cells.push(cur);
          for (const [dx, dy] of dirs) {
            const nx = cur.x + dx, ny = cur.y + dy;
            if (nx <= 0 || ny <= 0 || nx >= cols - 1 || ny >= rows - 1) continue;
            if (!grid[ny][nx] && !visited[ny][nx]) { visited[ny][nx] = true; stack.push({ x: nx, y: ny }); }
          }
        }
        const centroid = {
          x: Math.round(cells.reduce((a, c) => a + c.x, 0) / cells.length),
          y: Math.round(cells.reduce((a, c) => a + c.y, 0) / cells.length),
        };
        regions.push({ cells, centroid });
      }
    }
  }
  return regions;
}

function carveCorridor(grid, from, to, thickness) {
  const fx = (from && (from.x ?? from.cx)) ?? 1;
  const fy = (from && (from.y ?? from.cy)) ?? 1;
  const tx = (to && (to.x ?? to.cx)) ?? (grid[0].length - 2);
  const ty = (to && (to.y ?? to.cy)) ?? (grid.length - 2);
  const line = bresenham(fx, fy, tx, ty);
  for (const p of line) {
    carveDisk(grid, p.x, p.y, thickness);
  }
}

function carveDisk(grid, cx, cy, r) {
  const rows = grid.length, cols = grid[0].length;
  for (let y = Math.max(1, cy - r); y <= Math.min(rows - 2, cy + r); y++) {
    for (let x = Math.max(1, cx - r); x <= Math.min(cols - 2, cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) grid[y][x] = false;
    }
  }
}

function bresenham(x0, y0, x1, y1) {
  const points = [];
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    points.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return points;
}

// Tunnels aléatoires pour multiplier les galeries
// Supprime les petites régions (sol ou mur) selon un seuil
function removeSmallRegions(grid, forWalls, minSize) {
  const rows = grid.length, cols = grid[0].length;
  const visited = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  const dirs = [ [1,0], [-1,0], [0,1], [0,-1] ];
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      if (visited[y][x]) continue;
      if (grid[y][x] !== forWalls) continue; // on ne cible que le type demandé
      const cells = [];
      const stack = [{ x, y }];
      visited[y][x] = true;
      while (stack.length) {
        const cur = stack.pop();
        cells.push(cur);
        for (const [dx, dy] of dirs) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx <= 0 || ny <= 0 || nx >= cols - 1 || ny >= rows - 1) continue;
          if (!visited[ny][nx] && grid[ny][nx] === forWalls) { visited[ny][nx] = true; stack.push({ x: nx, y: ny }); }
        }
      }
      if (cells.length < minSize) {
        // inverse: petites zones deviennent l'autre type
        for (const c of cells) grid[c.y][c.x] = !forWalls;
      }
    }
  }
  return grid;
}

function floorRatio(grid) {
  const rows = grid.length, cols = grid[0].length;
  let floors = 0;
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      if (!grid[y][x]) floors++;
    }
  }
  return floors / ((rows - 2) * (cols - 2));
}

// --- Placement et rendu des QG ---
function computeHQs(numPlayers) {
  // Utilise les chambres d'angle comme candidats de spawn, sinon coins bruts
  const cands = (state.spawns && state.spawns.length === 4)
    ? state.spawns.map(s => ({ x: s.x, y: s.y }))
    : [
        { x: 2, y: 2 },
        { x: state.cols - 3, y: 2 },
        { x: 2, y: state.rows - 3 },
        { x: state.cols - 3, y: state.rows - 3 },
      ];
  const pick = {
    2: [0, 3],
    3: [0, 1, 2],
    4: [0, 1, 2, 3],
  }[numPlayers] || [0, 3];

  const result = [];
  const minSep = Math.floor(Math.min(state.cols, state.rows) / 3);
  for (let i = 0; i < pick.length; i++) {
    const target = cands[pick[i]];
    const near = findOpenCenterNear(target.x, target.y, minSep, result);
    ensureOpen3x3(near.x, near.y);
    result.push({ cx: near.x, cy: near.y, colorKey: state.playerColors[i] });
  }
  return result;
}

function findOpenCenterNear(tx, ty, minSeparation, placed) {
  // Cherche un centre de 3x3 au sol proche du point cible, en respectant une séparation minimale
  const maxR = Math.floor(Math.max(state.cols, state.rows) / 4);
  for (let r = 0; r <= maxR; r++) {
    for (let y = Math.max(1, ty - r); y <= Math.min(state.rows - 2, ty + r); y++) {
      const xs = [Math.max(1, tx - r), Math.min(state.cols - 2, tx + r)];
      for (const x of xs) {
        if (isClear3x3(x, y) && farFromOthers(x, y, placed, minSeparation)) return { x, y };
      }
    }
    for (let x = Math.max(1, tx - r); x <= Math.min(state.cols - 2, tx + r); x++) {
      const ys = [Math.max(1, ty - r), Math.min(state.rows - 2, ty + r)];
      for (const y of ys) {
        if (isClear3x3(x, y) && farFromOthers(x, y, placed, minSeparation)) return { x, y };
      }
    }
  }
  // défaut: clippe aux bornes et renvoie
  return { x: Math.min(state.cols - 2, Math.max(1, tx)), y: Math.min(state.rows - 2, Math.max(1, ty)) };
}

function isClear3x3(cx, cy) {
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (y <= 0 || y >= state.rows - 1 || x <= 0 || x >= state.cols - 1) return false;
      if (state.tiles[y][x]) return false;
    }
  }
  return true;
}

function ensureOpen3x3(cx, cy) {
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (y > 0 && y < state.rows - 1 && x > 0 && x < state.cols - 1) state.tiles[y][x] = false;
    }
  }
}

function farFromOthers(cx, cy, list, minSep) {
  for (const h of list) {
    const dx = h.cx - cx; const dy = h.cy - cy;
    if (Math.hypot(dx, dy) < minSep) return false;
  }
  return true;
}

function drawHQ(ctx, hq, tile, ox, oy) {
  const cx = ox + (hq.cx + 0.5) * tile;
  const cy = oy + (hq.cy + 0.5) * tile;
  const radius = tile * 1.5; // ~3x3 cases
  const palette = { blue: '#4f8cff', red: '#f55454', purple: '#9b5cff', yellow: '#ffd166' };
  const base = palette[hq.colorKey] || '#4f8cff';

  ctx.save();
  // disque externe dégradé
  const grad = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius);
  grad.addColorStop(0, lighten(base, 0.25));
  grad.addColorStop(1, shade(base, 0.65));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // anneau interne
  ctx.lineWidth = Math.max(2, Math.floor(tile * 0.15));
  ctx.strokeStyle = shade(base, 0.45);
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  // noyau
  ctx.fillStyle = shade(base, 0.2);
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.35, 0, Math.PI * 2);
  ctx.fill();

  // ombre portée douce vers la droite-bas
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.filter = 'blur(4px)';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.arc(cx + radius * 0.25, cy + radius * 0.25, radius * 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

function lighten(hex, t) { return mix(hex, '#ffffff', t); }
function shade(hex, t) { return mix(hex, '#000000', t); }
function mix(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}
function hexToRgb(h) {
  const s = h.replace('#','');
  const t = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  const n = parseInt(t, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Bruit simple déterministe basé sur hash pour nuances de roches
function noise2D(x, y) {
  // hash integer -> 0..1
  const xi = Math.floor(x), yi = Math.floor(y);
  let n = (xi * 73856093) ^ (yi * 19349663);
  n = (n << 13) ^ n;
  const nn = (n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff;
  return (nn / 0x7fffffff);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(t) { return t * t * (3 - 2 * t); }
function valueNoise2D(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1, y1 = y0 + 1;
  const sx = smoothstep(x - x0);
  const sy = smoothstep(y - y0);
  const n00 = noise2D(x0, y0);
  const n10 = noise2D(x1, y0);
  const n01 = noise2D(x0, y1);
  const n11 = noise2D(x1, y1);
  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);
  return lerp(ix0, ix1, sy);
}

function fbmNoise2D(x, y, octaves = 4) {
  let total = 0;
  let freq = 1;
  let amp = 1;
  let maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise2D(x * freq, y * freq) * amp;
    maxAmp += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return total / maxAmp;
}

// Lancement
window.addEventListener('DOMContentLoaded', mountApp);


