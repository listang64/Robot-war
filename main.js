// État du jeu minimal pour le menu et HUD
const state = {
  phase: "menu", // menu | playing
  players: 2,
  currentPlayerIndex: 0, // 0..3
  playerColors: ["blue", "red", "purple", "green"],
  turnMs: 60_000,
  turnStart: 0,
  timerId: null,
  isPaused: false,
  turnRatio: 1,
  codeBuffer: "",
  buildingSelection: null, // { type: 'silo' } | null
  // Carte (dimension fixe, on zoome pour la voir entière)
  tileSize: 28, // taille de base (utilisée pour calculs internes)
  tileScale: 1.0, // facteur d'agrandissement visuel des cases
  mapCols: 96,
  mapRows: 69,
  cols: 0,
  rows: 0,
  tiles: null, // 2D array: true=wall, false=floor
  spawns: [],
  hqs: [],
  units: [], // { id, ownerIndex, x, y, hp, recentTrail, lastDir, anim }
  programs: {}, // key unitId -> number[] commands
  simIntervalId: null,
  animRafId: null,
  simRafId: null,
  // Cartographie partagée par joueur
  playerMaps: [], // index -> { knownWalls:Set<string>, knownFree:Set<string>, visitCounts:Map<string,number> }
  nextUnitId: 1,
  nextLocalIdByPlayer: [],
  lastSimTime: 0,
  unitSpeedTilesPerSec: 4.5,
};

const q = (sel, el = document) => el.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  if (props.className) n.setAttribute("class", props.className);
  for (const c of children) n.append(c);
  return n;
};

// --- Paramètres QG ---
const HQ_SIZE_TILES = 6; // largeur/hauteur du QG en tuiles
const HQ_HALF_SPAN = Math.floor(HQ_SIZE_TILES / 2); // 3 pour 6x6
const HQ_PERIM_RADIUS = HQ_HALF_SPAN + 2; // zone de proximité pour "aller vers QG"
// Géométrie estimée de l'encoche visible dans l'image du QG
const HQ_HOLE_METRICS = {
  widthRatio: 0.20,   // largeur de la petite ouverture du bas (proportion du sprite)
  heightRatio: 0.14,  // non utilisé directement (on garde la hauteur via "tile")
  offsetYRatio: 0.128, // encore un peu plus bas
};
// Géométrie approximative du trou central (cercle) pour la jauge d'énergie
const HQ_CENTER_HOLE_METRICS = {
  diameterRatio: 0.36, // diamètre ~36% de la taille du sprite
};

function mountApp() {
  preloadHQImages();
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
  // Dimensions logiques de la carte, adaptées à l'écran pour maximiser la taille de case
  // Taille logique choisie une fois au démarrage (plus raisonnable)
  const dims = computeDesiredMapDims({ targetTile: 22 });
  state.cols = dims.cols;
  state.rows = dims.rows;
  state.tiles = generateCaveMap(state.cols, state.rows);
  state.hqs = computeHQs(state.players);
  state.units = [];
  // init cartographies partagées
  state.playerMaps = Array.from({ length: state.players }, () => ({ knownWalls: new Set(), knownFree: new Set(), visitCounts: new Map() }));
  // Spawns init: 3 unités par joueur, à côté du QG
  for (let i = 0; i < state.players; i++) {
    const colorKey = state.playerColors[i];
    const hq = state.hqs.find(h => h.colorKey === colorKey);
    if (!hq) continue;
    spawnInitialUnitsAtHQ(hq, i, 3);
  }
  // Le jeu démarre en pause
  state.isPaused = true;
  // init cartographies partagées
  
  renderApp();
  // Affiche le bouton de démarrage
  requestAnimationFrame(() => { const so = q('#startOverlay'); if (so) so.classList.add('visible'); });
  // Démarre le cycle de tour après que la HUD soit montée
  requestAnimationFrame(() => startTurnTimer());
  // Démarre la boucle de simulation
  startSimulationLoop();
}

function regenerateMapKeepPause() {
  // Conserve l'état de pause et les paramètres joueurs
  const wasPaused = state.isPaused;
  const dims = computeDesiredMapDims({ targetTile: 22 });
  state.cols = dims.cols; state.rows = dims.rows;
  state.tiles = generateCaveMap(state.cols, state.rows);
  state.hqs = computeHQs(state.players);
  // Réinitialise les unités et cartes partagées
  state.units = [];
  state.nextUnitId = 1; // repart des IDs 1, 2, 3...
  state.programs = {}; // nettoie les anciens programmes liés à d'anciens IDs
  state.playerMaps = Array.from({ length: state.players }, () => ({ knownWalls: new Set(), knownFree: new Set(), visitCounts: new Map() }));
  for (let i = 0; i < state.players; i++) {
    const colorKey = state.playerColors[i];
    const hq = state.hqs.find(h => h.colorKey === colorKey);
    if (hq) spawnInitialUnitsAtHQ(hq, i, 3);
  }
  // Assure pause et overlay visibles
  state.isPaused = wasPaused || true;
  const so = q('#startOverlay'); if (so && !so.classList.contains('visible')) so.classList.add('visible');
  const canvas = q('#game'); if (canvas) { resizeCanvas(canvas); drawScene(canvas); }
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
  pauseBtn.append(iconPlay());
  pauseBtn.addEventListener('click', togglePause);
  hud.append(pauseBtn);

  const pauseOverlay = el('div', { className: 'pause-overlay', id: 'pauseOverlay' }, [
    el('div', { className: 'big' }, [el('span'), el('span')])
  ]);
  hud.append(pauseOverlay);

  // Start overlay
  const startOv = el('div', { className: 'start-overlay', id: 'startOverlay' });
  const stack = el('div', { className: 'start-stack' });
  const startBtn = el('button', { className: 'start-button', textContent: 'Commencer la partie' });
  startBtn.addEventListener('click', () => { if (state.isPaused) togglePause(); const so = q('#startOverlay'); if (so) so.classList.remove('visible'); });
  const regenBtn = el('button', { className: 'start-regenerate', id: 'regenBtn', title: 'Nouvelle carte' });
  regenBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#cfd6e6" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.45 11h-2.21A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L14 10h8V2l-4.35 4.35Z"/></svg>';
  regenBtn.addEventListener('click', () => regenerateMapKeepPause());
  stack.append(startBtn, regenBtn);
  startOv.append(stack);
  hud.append(startOv);

  // Spawn panel (droite)
  const spawnPanel = renderSpawnPanel();
  hud.append(spawnPanel);

  // Program button (cerveau + engrenage)
  const progBtn = el('button', { className: 'program-btn', id: 'programBtn', title: 'Programmer (séquences)' });
  progBtn.style.setProperty('--progColor', getPlayerColor(state.currentPlayerIndex));
  const progIcon = el('div', { className: 'icon' });
  // SVG engrenage (style "settings"), mieux reconnaissable
  progIcon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#0b0e14" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.65l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96c-.5-.38-1.03-.7-1.61-.94l-.37-2.55A.5.5 0 0 0 14.3 2h-4.6a.5.5 0 0 0-.49.42l-.37 2.55c-.58.24-1.11.56-1.61.94l-2.39-.96a.5.5 0 0 0-.61.22L2.3 8.83a.5.5 0 0 0 .12.65l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.42 14.52a.5.5 0 0 0-.12.65l1.92 3.32c.14.24.43.34.69.24l2.39-.96c.5.38 1.03.7 1.61.94l.37 2.55c.05.24.25.42.49.42h4.6c.24 0 .44-.18.49-.42l.37-2.55c.58-.24 1.11-.56 1.61-.94l2.39.96c.26.1.55 0 .69-.24l1.92-3.32a.5.5 0 0 0-.12-.65l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"/></svg>';
  progBtn.append(progIcon);
  progBtn.addEventListener('click', toggleProgramOverlay);
  hud.append(progBtn);

  // Program overlay (droite + display centre)
  const progOverlay = el('div', { className: 'program-overlay', id: 'programOverlay' });
  const side = el('div', { className: 'side' });
  const keypad = el('div', { className: 'prog-keypad' });
  const keys = ['0','1','2','3','4','5','6','7','8','9'];
  keys.forEach(k => keypad.append(button(k, () => onProgKey(k))));
  keypad.append(makeIconButton('⌫', 'Retirer', onProgBackspace));
  keypad.append(makeFlagButton());
  keypad.append(makeIconButton('␣', 'Espace', onProgSpace));
  const validate = button('✔', () => onProgValidate(), 'validate');
  keypad.append(validate);
  side.append(keypad);
  progOverlay.append(side);
  const display = el('div', { className: 'prog-display', id: 'progDisplay', textContent: '' });
  progOverlay.append(display);
  hud.append(progOverlay);

  // Dev button + overlay
  const devBtn = el('button', { className: 'dev-btn', id: 'devBtn', title: 'Développeur' });
  devBtn.textContent = 'D';
  devBtn.addEventListener('click', toggleDevOverlay);
  hud.append(devBtn);
  const devOverlay = el('div', { className: 'dev-overlay', id: 'devOverlay' });
  const devSide = el('div', { className: 'side-left' });
  const devList = el('div', { className: 'dev-list' });
  const colors = [ 'blue', 'red', 'purple', 'green' ];
  for (const col of colors) {
    const b = el('button');
    const icon = el('canvas', { width: 40, height: 40 });
    drawUnitIconWithId(icon.getContext('2d'), 40, colorFromKey(col), '?');
    b.append(icon);
    b.addEventListener('click', () => selectDevSpawn('unit', col));
    devList.append(b);
  }
  // --- Bouton: -100 PV au QG du joueur courant ---
  const dmgBtn = el('button', { className: 'dev-dmg', title: '-100 PV QG actif' });
  dmgBtn.textContent = '-100 PV QG';
  dmgBtn.addEventListener('click', () => {
    const key = state.playerColors[state.currentPlayerIndex];
    const hq = state.hqs && state.hqs.find(h => h.colorKey === key);
    if (!hq) return;
    hq.hp = Math.max(0, (hq.hp ?? 1000) - 100);
    const canvas = q('#game'); if (canvas) drawScene(canvas);
    updateHqHpLine();
    // ne ferme pas l'overlay
  });
  devList.append(dmgBtn);
  // --- Bouton: +100 ENERGIE QG actif ---
  const addEnergyBtn = el('button', { className: 'dev-energy', title: '+100 Énergie QG actif' });
  addEnergyBtn.textContent = '+100 Énergie';
  addEnergyBtn.addEventListener('click', () => {
    const key = state.playerColors[state.currentPlayerIndex];
    const hq = state.hqs && state.hqs.find(h => h.colorKey === key);
    if (!hq) return;
    hq.energy = Math.min(hq.energyMax || 1000, (hq.energy ?? 0) + 100);
    const canvas = q('#game'); if (canvas) drawScene(canvas);
    // ne ferme pas l'overlay
  });
  devList.append(addEnergyBtn);
  const closeBtn = el('button', { className: 'dev-close', title: 'Fermer' });
  closeBtn.textContent = 'X';
  closeBtn.addEventListener('click', () => { const ov = q('#devOverlay'); if (ov) ov.classList.remove('visible'); devSpawnSelection = null; });
  devSide.append(devList);
  devSide.append(closeBtn);
  devOverlay.append(devSide);
  hud.append(devOverlay);

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
  const map = { blue: 'player-blue', red: 'player-red', purple: 'player-purple', green: 'player-green' };
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
  // Ferme les overlays (programmation et spawn) et réinitialise la saisie
  const progOverlayEl = q('#programOverlay');
  if (progOverlayEl) progOverlayEl.classList.remove('visible');
  const spawnPanelEl = q('#spawnPanel');
  if (spawnPanelEl) spawnPanelEl.classList.remove('visible');
  programBuffer = '';
  updateProgDisplay();
  // Met à jour la couleur du bouton de programmation
  const progBtn = q('#programBtn');
  if (progBtn) progBtn.style.setProperty('--progColor', getPlayerColor(state.currentPlayerIndex));
  drawPlayerButton();
  updateSpawnCreateIconColor();
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
  const map = { blue: '#4f8cff', red: '#f55454', purple: '#9b5cff', green: '#42d77d' };
  return map[key] || '#4f8cff';
}
function colorFromKey(key) { const map = { blue: '#4f8cff', red: '#f55454', purple: '#9b5cff', green: '#42d77d' }; return map[key] || '#4f8cff'; }

// --- Images des QG (remplacement visuel) ---
const HQ_IMAGE_PATHS = {
  blue: 'images/QG-bleu.PNG',
  red: 'images/QG-rouge.PNG',
  purple: 'images/QG-violet.PNG',
  green: 'images/QG-vert.PNG',
};
const HQ_IMAGES = {};
function preloadHQImages() {
  for (const [key, path] of Object.entries(HQ_IMAGE_PATHS)) {
    const img = new Image();
    img.onload = () => { const canvas = q('#game'); if (canvas) drawScene(canvas); };
    img.src = path;
    HQ_IMAGES[key] = img;
  }
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

// --- Programmation: interactions ---
let programBuffer = '';
function toggleProgramOverlay() {
  const ov = q('#programOverlay');
  if (!ov) return;
  ov.classList.toggle('visible');
  if (ov.classList.contains('visible')) {
    programBuffer = '';
    updateProgDisplay();
  }
  const canvas = q('#game'); if (canvas) drawScene(canvas);
}
function onProgKey(k) {
  // Ajoute le chiffre sans espace. Les espaces ne viennent que du bouton "espace".
  programBuffer = (programBuffer || '') + String(k);
  updateProgDisplay();
}
function onProgBackspace() {
  // Retire le dernier caractère (chiffre ou espace)
  if (!programBuffer) return;
  programBuffer = programBuffer.slice(0, -1);
  updateProgDisplay();
}
function onProgFlag() { /* réservé */ }
function onProgSpace() {
  // Insère un séparateur visuel égal à la largeur d’un chiffre (espace insécable fine + espace)
  if (programBuffer.length === 0 || programBuffer.endsWith(' ')) { updateProgDisplay(); return; }
  programBuffer += ' ';
  updateProgDisplay();
}
function onProgValidate() {
  const ov = q('#programOverlay'); if (ov) ov.classList.remove('visible');
  const canvasR = q('#game'); if (canvasR) drawScene(canvasR);
  const tokens = (programBuffer || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) { programBuffer = ''; updateProgDisplay(); return; }
  const unitId = tokens[0];
  // Restreindre la programmation aux unités du joueur actif uniquement
  const myUnit = state.units.find(u => String(u.id) === unitId && u.ownerIndex === state.currentPlayerIndex);
  if (!myUnit) { programBuffer = ''; updateProgDisplay(); return; }
  const cmdTokens = tokens.slice(1);
  // Commande spéciale 00: réinitialise le programme du type ciblé pour le joueur actif
  if (cmdTokens.includes('00')) {
    delete state.programs[unitId];
    programBuffer = '';
    updateProgDisplay();
    return;
  }
  const commands = cmdTokens
    .filter(t => t !== '00')
    .map(t => parseInt(t, 10))
    .filter(n => Number.isFinite(n));
  state.programs[unitId] = commands;
  programBuffer = '';
  updateProgDisplay();
}
function updateProgDisplay() {
  const d = q('#progDisplay'); if (!d) return;
  // Remplace chaque espace par un espace visuel matérialisé
  if (!programBuffer) { d.textContent = ''; return; }
  let html = '';
  for (let i = 0; i < programBuffer.length; i++) {
    const ch = programBuffer[i];
    if (ch === ' ') html += '<span class="prog-space"></span>';
    else html += escapeHtml(ch);
  }
  d.innerHTML = html;
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function makeIconButton(iconText, title, handler) {
  const b = el('button', { title }); b.textContent = iconText; b.addEventListener('click', handler); return b;
}
function makeFlagButton() {
  const b = el('button', { title: 'Drapeau (marqueur)' });
  // petit drapeau stylisé via unicode
  b.textContent = '🚩';
  b.addEventListener('click', onProgFlag);
  return b;
}

// --- Dev overlay logic ---
let devSpawnSelection = null; // { type, colorKey }
function toggleDevOverlay() {
  const ov = q('#devOverlay'); if (!ov) return;
  ov.classList.toggle('visible');
  devSpawnSelection = null;
  const canvas = q('#game'); if (canvas) drawScene(canvas);
}
function selectDevSpawn(type, colorKey) {
  devSpawnSelection = { type, colorKey };
}
// Cliquer sur la carte pour placer si sélection active
document.addEventListener('click', (e) => {
  if (!devSpawnSelection) return;
  const canvas = q('#game'); if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const { tile, ox, oy } = computeCanvasMetrics(canvas);
  const gx = Math.floor((x - ox) / tile), gy = Math.floor((y - oy) / tile);
  if (!isInBounds(gx, gy)) return;
  if (isBlocked(gx, gy)) return;
  if (unitAt(gx, gy)) return;
  const ownerIndex = Math.max(0, state.playerColors.indexOf(devSpawnSelection.colorKey));
  const idNum = state.nextUnitId++;
  state.units.push({ id: idNum, ownerIndex, x: gx, y: gy, hp: 1, recentTrail: [], lastDir: null, anim: null });
  const canvas2 = q('#game'); if (canvas2) drawScene(canvas2);
  devSpawnSelection = null;
  const ov = q('#devOverlay'); if (ov) ov.classList.remove('visible');
});

// Cliquer une unité de sa couleur pour ouvrir la programmation avec ID prérempli
document.addEventListener('click', (e) => {
  const canvas = q('#game'); if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const { tile, ox, oy } = computeCanvasMetrics(canvas);
  const gx = Math.floor((x - ox) / tile), gy = Math.floor((y - oy) / tile);
  const u = state.units.find(u => u.x === gx && u.y === gy && u.ownerIndex === state.currentPlayerIndex);
  if (!u) return;
  const ov = q('#programOverlay'); if (!ov) return;
  if (!ov.classList.contains('visible')) ov.classList.add('visible');
  programBuffer = String(u.id) + ' ';
  updateProgDisplay();
});

function typeFromDigit(d) {
  switch (String(d)) {
    case '1': return 'triangle';
    case '2': return 'circle';
    case '3': return 'square';
    case '4': return 'hexagon';
    case '5': return 'star';
    default: return null;
  }
}

function programKey(ownerIndex, type) { return `${ownerIndex}:${type}`; }

function startSimulationLoop() {
  if (state.simIntervalId) clearInterval(state.simIntervalId);
  if (state.simRafId) cancelAnimationFrame(state.simRafId);
  const loop = (t) => {
    if (!state.lastSimTime) state.lastSimTime = t || performance.now();
    const now = t || performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - state.lastSimTime) / 1000));
    state.lastSimTime = now;
    if (!state.isPaused) stepSimulation(dt);
    state.simRafId = requestAnimationFrame(loop);
  };
  state.simRafId = requestAnimationFrame(loop);
}

function stepSimulation(dt = 0) {
  if (state.isPaused || !state.tiles || !state.units.length) return;
  let moved = false;
  for (const u of state.units) {
    // ignore les unités déjà en animation
    if (u.anim && performance.now() < u.anim.endTime) continue;
    const cmds = state.programs[String(u.id)];
    if (!cmds || cmds.length === 0) continue;
    // Commande 7 + 18 (QG): aller vers QG (sinon explorer jusqu'à découverte)
    if (cmds[0] === 7 && cmds[1] === 18) {
      const myHq = state.hqs.find(h => h.colorKey === state.playerColors[u.ownerIndex]);
      if (myHq) {
        // Arrêt lorsqu'on atteint le périmètre autour du 3x3
        if (isAtHQPerimeter(u.x, u.y, myHq)) continue;
        const didMove = moveTowardOrExploreInline(u, myHq.cx, myHq.cy);
        if (didMove) moved = true;
        continue;
      }
      // pas de QG? on tombera sur explorer plus bas si présent
    }
    // Commande 6: explorer (avec mémoire locale des visites)
    if (cmds.includes(6)) {
      const pm = state.playerMaps[u.ownerIndex];
      if (!pm) continue;
      const k = `${u.x},${u.y}`;
      pm.visitCounts.set(k, (pm.visitCounts.get(k) || 0) + 1);
      const step = (function choose() {
        const dirs = [ [1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1] ];
        const collect = (allowReverse) => {
          const arr = [];
          for (const d of dirs) {
            if (!allowReverse && u.lastDir && d[0] === -u.lastDir[0] && d[1] === -u.lastDir[1]) continue;
            const nx = u.x + d[0];
            const ny = u.y + d[1];
            if (!isInBounds(nx, ny)) continue;
            if (pm.knownWalls && pm.knownWalls.has(`${nx},${ny}`)) continue;
            const blocked = isBlocked(nx, ny);
            if (blocked) { if (pm.knownWalls) pm.knownWalls.add(`${nx},${ny}`); continue; }
            if (unitAt(nx, ny)) continue;
            const key = `${nx},${ny}`;
            const visits = (pm.visitCounts.get(key) || 0);
            let score = visits + Math.random() * 0.1;
            // Interdit strictement de revenir sur une des 6 dernières cases
            if (u.recentTrail && u.recentTrail.includes(key)) continue;
            if (u.lastDir && d[0] === u.lastDir[0] && d[1] === u.lastDir[1]) score -= 0.15;
            arr.push({ d, score });
          }
          return arr;
        };
        let scored = collect(false);
        if (scored.length === 0) {
          // Forcer demi-tour complet si cul-de-sac
          if (u.lastDir) {
            const d = [-u.lastDir[0], -u.lastDir[1]];
            const nx = u.x + d[0], ny = u.y + d[1];
            if (isInBounds(nx, ny) && !isBlocked(nx, ny) && !unitAt(nx, ny)) return d;
          }
          scored = collect(true);
        }
        if (scored.length === 0) return null;
        scored.sort((a, b) => a.score - b.score);
        const bestScore = scored[0].score;
        const bests = scored.filter(s => Math.abs(s.score - bestScore) < 1e-6);
        return bests[Math.floor(Math.random() * bests.length)].d;
      })();
      if (step) {
        const nx = u.x + step[0];
        const ny = u.y + step[1];
        const now = performance.now();
        // calcule une durée basée sur la vitesse pour glisser entre les cases
        const tileDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
        u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + tileDuration };
        // heading vers la nouvelle direction
        const ang = Math.atan2(ny - u.y, nx - u.x);
        u.headingFrom = (u.headingTo ?? ang);
        u.headingTo = ang;
        u.headingStart = now; u.headingEnd = now + tileDuration;
        updateRecentTrail(u, u.x, u.y);
        u.x = nx; u.y = ny; u.lastDir = step; moved = true;
          if (pm.knownFree) pm.knownFree.add(`${u.x},${u.y}`);
      }
    }
  }
  // rendu continu déjà assuré par RAF principal via drawScene dans render loop; on déclenche ici un rendu direct
  const canvas = q('#game'); if (canvas) drawScene(canvas);
}
function updateRecentTrail(u, x, y) {
  if (!u.recentTrail) u.recentTrail = [];
  const key = `${x},${y}`;
  u.recentTrail.push(key);
  if (u.recentTrail.length > 6) u.recentTrail.shift();
}

function moveTowardOrExploreInline(u, tx, ty) {
  if (u.x === tx && u.y === ty) return false;
  const dirs = [ [1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1] ];
  let best = null; let bestDist = Infinity;
  const dist0 = Math.abs(tx - u.x) + Math.abs(ty - u.y);
  // 1) Tente d'abord une amélioration stricte de distance sans revenir sur le trail récent
  for (const d of dirs) {
    const nx = u.x + d[0];
    const ny = u.y + d[1];
    if (!isInBounds(nx, ny)) continue;
    if (u.knownWalls && u.knownWalls.has(`${nx},${ny}`)) continue;
    const blocked = isBlocked(nx, ny);
    if (blocked) { if (u.knownWalls) u.knownWalls.add(`${nx},${ny}`); continue; }
    if (unitAt(nx, ny)) continue;
    const key = `${nx},${ny}`;
    // En mode retour, autorise à repasser par le trail pour retrouver le chemin
    if (u.knownFree && u.knownFree.size > 0 && !u.knownFree.has(key)) continue;
    const stepCost = (Math.abs(d[0]) + Math.abs(d[1]) === 2) ? 1.4142 : 1;
    const dist = Math.abs(tx - nx) + Math.abs(ty - ny) + 0.01 * stepCost;
    if (dist >= dist0) continue; // exige une amélioration stricte
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  let step = best;
  if (!step) {
    // 2) Pas d'amélioration stricte trouvée: autoriser distance égale (plateau), en évitant demi-tour/trail
    best = null; bestDist = Infinity;
    for (const d of dirs) {
      const nx = u.x + d[0]; const ny = u.y + d[1];
      if (!isInBounds(nx, ny)) continue;
      if (u.knownWalls && u.knownWalls.has(`${nx},${ny}`)) continue;
      const blocked = isBlocked(nx, ny);
      if (blocked) { if (u.knownWalls) u.knownWalls.add(`${nx},${ny}`); continue; }
      if (unitAt(nx, ny)) continue;
      if (u.lastDir && d[0] === -u.lastDir[0] && d[1] === -u.lastDir[1]) continue; // évite demi-tour
      const key = `${nx},${ny}`;
      // autorise le trail pour permettre le retour
      const stepCost2 = (Math.abs(d[0]) + Math.abs(d[1]) === 2) ? 1.4142 : 1;
      const dist = Math.abs(tx - nx) + Math.abs(ty - ny) + 0.005 * stepCost2;
      if (dist === dist0) { best = d; break; }
    }
    step = best;
  }
  if (!step) {
    // 3) fallback: un pas d'exploration biaisé vers l'éloignement des murs connus et la découverte
    const scored = [];
    for (const d of dirs) {
      const nx = u.x + d[0]; const ny = u.y + d[1];
      if (!isInBounds(nx, ny)) continue;
      if (u.knownWalls && u.knownWalls.has(`${nx},${ny}`)) continue;
      const blocked = isBlocked(nx, ny);
      if (blocked) { if (u.knownWalls) u.knownWalls.add(`${nx},${ny}`); continue; }
      if (unitAt(nx, ny)) continue;
      const key = `${nx},${ny}`;
    if (u.recentTrail && u.recentTrail.includes(key)) continue;
      const visits = (u.visitCounts && u.visitCounts.get(key)) || 0;
      // favorise la découverte (cases non connues) et l'éloignement des obstacles récents
      let score = visits + Math.random() * 0.1;
      if (u.knownFree && u.knownFree.size > 0 && !u.knownFree.has(key)) score -= 0.25;
      if (u.lastDir && d[0] === -u.lastDir[0] && d[1] === -u.lastDir[1]) score += 0.6;
      if (u.lastDir && d[0] === u.lastDir[0] && d[1] === u.lastDir[1]) score -= 0.15;
      scored.push({ d, score });
    }
  if (scored.length === 0) {
    // 4) ultime recours: ignorer trail mais pas les murs/unités
    for (const d of dirs) {
      const nx = u.x + d[0], ny = u.y + d[1];
      if (!isInBounds(nx, ny)) continue;
      if (isBlocked(nx, ny)) continue;
      if (unitAt(nx, ny)) continue;
      step = d; break;
    }
    if (!step) return false;
  } else {
    scored.sort((a,b) => a.score - b.score);
    const bestScore = scored[0].score;
    const bests = scored.filter(s => Math.abs(s.score - bestScore) < 1e-6);
    step = bests[Math.floor(Math.random() * bests.length)].d;
  }
  }
  const nx = u.x + step[0];
  const ny = u.y + step[1];
  const now = performance.now();
  u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + 240 };
  const ang = Math.atan2(ny - u.y, nx - u.x);
  u.headingFrom = (u.headingTo ?? ang);
  u.headingTo = ang;
  u.headingStart = now; u.headingEnd = now + 240;
  updateRecentTrail(u, u.x, u.y);
  u.x = nx; u.y = ny; u.lastDir = step; if (u.knownFree) u.knownFree.add(`${u.x},${u.y}`);
  return true;
}

// Rendu simple sur canvas (placeholder labyrinthe futur)
function resizeCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.floor(c.clientWidth * dpr);
  c.height = Math.floor(c.clientHeight * dpr);
}

function getOverlayReserves() {
  // Réserves en pixels CSS pour laisser la place aux panneaux visibles
  // Désactivé: les overlays doivent flotter AU DESSUS sans décaler la carte
  return { left: 0, right: 0 };
}

function computeCanvasMetrics(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const widthCss = canvas.width / dpr;
  const heightCss = canvas.height / dpr;
  const reserves = getOverlayReserves();
  const widthAvail = widthCss; // ne pas réduire l'espace de la carte pour les overlays
  const baseTileFit = Math.max(2, Math.floor(Math.min(widthAvail / state.cols, (heightCss - 28) / state.rows)));
  const desired = Math.max(2, Math.floor(baseTileFit * (state.tileScale || 1)));
  const tile = Math.min(baseTileFit, desired); // ne dépasse jamais l'espace disponible
  const ox = Math.floor((widthAvail - state.cols * tile) / 2);
  const oy = Math.floor((heightCss - state.rows * tile) / 2);
  return { dpr, widthCss, heightCss, tile, ox, oy };
}

function computeDesiredMapDims(opts = {}) {
  // Vise une tuile confortable (~34-42px) sans overlays.
  // Choisit des dimensions logiques multiples de 3, bornées, pour garder la grotte crédible.
  const vw = Math.max(320, Math.floor(window.innerWidth || 1024));
  const vh = Math.max(320, Math.floor(window.innerHeight || 768));
  const targetTile = Math.max(18, Math.min(40, Number(opts.targetTile) || 38));
  const cols = Math.max(48, Math.min(96, Math.floor(vw / targetTile)));
  const rows = Math.max(36, Math.min(69, Math.floor((vh - 28) / targetTile)));
  // ajuste aux bords (>= 3) et pair/impair pas critique, mais on garde >=3
  const adjCols = Math.max(16, cols - (cols % 1));
  const adjRows = Math.max(12, rows - (rows % 1));
  return { cols: adjCols, rows: adjRows };
}

function drawScene(canvas) {
  const ctx = canvas.getContext('2d');
  const { dpr, widthCss, heightCss, tile, ox, oy } = computeCanvasMetrics(canvas);

  ctx.save();
  ctx.scale(dpr, dpr);
  // Fond sol stylisé (dégradé doux + vignette légère)
  drawStylizedFloor(ctx, widthCss, heightCss);

  // Style de carte façon maquette (mêmes codes visuels que l'image):
  // - Fond sombre
  // - Zones jouables (sol) plus claires, bords arrondis, outline sombre
  if (state.tiles) drawCaveSurface(ctx, tile, ox, oy);

  // Dessin des QG des joueurs
  if (state.hqs && state.hqs.length) {
    for (const hq of state.hqs) {
      drawHQ(ctx, hq, tile, ox, oy);
    }
  }

  // Dessin des unités
  for (const u of state.units) {
    drawUnit(ctx, u, tile, ox, oy);
  }

  ctx.restore();
}

function drawStylizedFloor(ctx, widthCss, heightCss) {
  // Fond = couleur des murs
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(0, 0, widthCss, heightCss);
}

function drawCaveSurface(ctx, tile, ox, oy) {
  const w = state.cols * tile;
  const h = state.rows * tile;
  // Couleurs
  const floorBase = '#36353a';
  const wallBase = '#1c1c1c';

  // 1) Remplissage des zones SOL (couleur pleine, rectangles qui se chevauchent légèrement pour éviter toute grille)
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      if (state.tiles[y][x]) continue; // sol uniquement
      ctx.fillStyle = floorBase;
      const px = ox + x * tile - 0.5;
      const py = oy + y * tile - 0.5;
      ctx.fillRect(px, py, tile + 1, tile + 1);
    }
  }

  // 2) Expansion du bord du SOL (arrondis nets, sans contour visible)
  ctx.save();
  ctx.strokeStyle = floorBase;
  ctx.lineWidth = Math.max(2, Math.floor(tile * 0.90)); // arrondi large
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  drawFloorEdgesPath(ctx, tile, ox, oy);
  ctx.stroke();
  ctx.restore();

  // 2bis) Accents gris: petits traits rapprochés le long de certains bords de murs
  drawWallEdgeStrokes(ctx, tile, ox, oy);

  // 3) Aucun petit trait sur les murs (supprimé sur demande)
}

function drawFloorEdgesPath(ctx, tile, ox, oy) {
  const R = state.rows, C = state.cols;
  // Pour chaque arête sol/mur, on trace un segment. Les arrondis viennent de lineJoin + blur précédent.
  ctx.beginPath();
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < C; x++) {
      if (state.tiles[y][x]) continue; // sol
      // voisin haut = mur -> segment horizontal haut
      if (y - 1 >= 0 && state.tiles[y - 1][x]) {
        const x0 = ox + x * tile;
        const y0 = oy + y * tile;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + tile, y0);
      }
      // bas
      if (y + 1 < R && state.tiles[y + 1][x]) {
        const x0 = ox + x * tile;
        const y0 = oy + (y + 1) * tile;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + tile, y0);
      }
      // gauche
      if (x - 1 >= 0 && state.tiles[y][x - 1]) {
        const x0 = ox + x * tile;
        const y0 = oy + y * tile;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0, y0 + tile);
      }
      // droite
      if (x + 1 < C && state.tiles[y][x + 1]) {
        const x0 = ox + (x + 1) * tile;
        const y0 = oy + y * tile;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0, y0 + tile);
      }
    }
  }
}

function drawWallEdgeStrokes(ctx, tile, ox, oy) {
  // Dessine des petits traits gris le long de quelques bords de murs pour donner du relief
  const R = state.rows, C = state.cols;
  const strokeColor = 'rgba(180,185,195,0.26)';
  const lw = Math.max(1, Math.floor(tile * 0.06));
  const offset = Math.max(6, Math.floor(tile * 0.75)); // encore plus à l'intérieur du mur
  const segLen = Math.max(2, Math.floor(tile * 0.28));
  const gap = Math.max(2, Math.floor(tile * 0.14));

  // Clip aux murs pour que les traits restent côté mur
  const wallsClip = new Path2D();
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < C; x++) {
      if (!state.tiles[y][x]) continue;
      wallsClip.rect(ox + x * tile - 0.5, oy + y * tile - 0.5, tile + 1, tile + 1);
    }
  }
  ctx.save();
  ctx.clip(wallsClip);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';

  for (let y = 0; y < R; y++) {
    for (let x = 0; x < C; x++) {
      if (!state.tiles[y][x]) continue; // mur uniquement
      const seed = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      // Sélection aléatoire clairsemée
      if ((seed % 11) !== 0) continue;

      const px = ox + x * tile;
      const py = oy + y * tile;
      // bord gauche (mur avec sol à gauche)
      if (x - 1 >= 0 && !state.tiles[y][x - 1]) {
        for (let i = 0; i < 3; i++) {
          const sy = py + offset + i * (segLen + gap) - (segLen * 0.5);
          ctx.beginPath();
          ctx.moveTo(px + offset, sy);
          ctx.lineTo(px + offset, sy + segLen);
          ctx.stroke();
        }
      }
      // bord droit
      if (x + 1 < C && !state.tiles[y][x + 1]) {
        for (let i = 0; i < 3; i++) {
          const sy = py + offset + i * (segLen + gap) - (segLen * 0.5);
          ctx.beginPath();
          ctx.moveTo(px + tile - offset, sy);
          ctx.lineTo(px + tile - offset, sy + segLen);
          ctx.stroke();
        }
      }
      // bord haut
      if (y - 1 >= 0 && !state.tiles[y - 1][x]) {
        for (let i = 0; i < 3; i++) {
          const sx = px + offset + i * (segLen + gap) - (segLen * 0.5);
          ctx.beginPath();
          ctx.moveTo(sx, py + offset);
          ctx.lineTo(sx + segLen, py + offset);
          ctx.stroke();
        }
      }
      // bord bas
      if (y + 1 < R && !state.tiles[y + 1][x]) {
        for (let i = 0; i < 3; i++) {
          const sx = px + offset + i * (segLen + gap) - (segLen * 0.5);
          ctx.beginPath();
          ctx.moveTo(sx, py + tile - offset);
          ctx.lineTo(sx + segLen, py + tile - offset);
          ctx.stroke();
        }
      }
    }
  }

  ctx.restore();
}

function iconPause() { const d = el('div', { className: 'icon' }, [el('span'), el('span')]); return d; }
function iconPlay() { const d = el('div', { className: 'icon' }); d.classList.add('play'); d.append(el('span'), el('span')); return d; }

// (texture murale par pixel supprimée au profit d'un rendu par tuile, plus performant)

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
  for (let i = 0; i < 5; i++) grid = stepCellular(grid);

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
  const dirs = [ [1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1] ];

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
  const dirs = [ [1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1] ];
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
    ensureOpenHQArea(near.x, near.y);
    result.push({ cx: near.x, cy: near.y, colorKey: state.playerColors[i], hp: 1000, hpMax: 1000, energy: 300, energyMax: 1000 });
  }
  return result;
}

function findOpenCenterNear(tx, ty, minSeparation, placed) {
  // Cherche un centre de HQ_SIZE_TILES x HQ_SIZE_TILES au sol proche du point cible, en respectant une séparation minimale
  const maxR = Math.floor(Math.max(state.cols, state.rows) / 4);
  for (let r = 0; r <= maxR; r++) {
    for (let y = Math.max(1, ty - r); y <= Math.min(state.rows - 2, ty + r); y++) {
      const xs = [Math.max(1, tx - r), Math.min(state.cols - 2, tx + r)];
      for (const x of xs) {
        if (isClearHQArea(x, y) && farFromOthers(x, y, placed, minSeparation)) return { x, y };
      }
    }
    for (let x = Math.max(1, tx - r); x <= Math.min(state.cols - 2, tx + r); x++) {
      const ys = [Math.max(1, ty - r), Math.min(state.rows - 2, ty + r)];
      for (const y of ys) {
        if (isClearHQArea(x, y) && farFromOthers(x, y, placed, minSeparation)) return { x, y };
      }
    }
  }
  // défaut: clippe aux bornes et renvoie
  return { x: Math.min(state.cols - 2, Math.max(1, tx)), y: Math.min(state.rows - 2, Math.max(1, ty)) };
}

function isClearHQArea(cx, cy) {
  for (let y = cy - HQ_HALF_SPAN; y <= cy + HQ_HALF_SPAN; y++) {
    for (let x = cx - HQ_HALF_SPAN; x <= cx + HQ_HALF_SPAN; x++) {
      if (y <= 0 || y >= state.rows - 1 || x <= 0 || x >= state.cols - 1) return false;
      if (state.tiles[y][x]) return false;
    }
  }
  return true;
}

function ensureOpenHQArea(cx, cy) {
  for (let y = cy - HQ_HALF_SPAN; y <= cy + HQ_HALF_SPAN; y++) {
    for (let x = cx - HQ_HALF_SPAN; x <= cx + HQ_HALF_SPAN; x++) {
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
  const size = tile * HQ_SIZE_TILES; // couvre le HQ_SIZE_TILES x HQ_SIZE_TILES
  const img = HQ_IMAGES[hq.colorKey];

  if (img && img.complete && img.naturalWidth > 0) {
    // Jauges derrière l'image, visibles via les ouvertures
    drawHQEnergyBar(ctx, hq, tile, cx, cy, size);
    drawHQHealthBar(ctx, hq, tile, cx, cy, size, 'hole');
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
    return;
  }

  // Fallback minimal si l'image n'est pas prête: disque couleur à la taille du QG
  const radius = tile * (HQ_SIZE_TILES / 2);
  const palette = { blue: '#4f8cff', red: '#f55454', purple: '#9b5cff', green: '#42d77d' };
  const base = palette[hq.colorKey] || '#4f8cff';
  ctx.save();
  const grad = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius);
  grad.addColorStop(0, lighten(base, 0.25));
  grad.addColorStop(1, shade(base, 0.65));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Jauge de vie (fallback, visible en dessous de l'image vectorielle)
  drawHQHealthBar(ctx, hq, tile, cx, cy, size, 'below');
}

function drawHQHealthBar(ctx, hq, tile, cx, cy, size, placement = 'hole') {
  let barWidth, barHeight, x, y;
  if (placement === 'hole') {
    // Barre centrée DANS l'encoche de l'image (derrière l'image)
    barWidth = Math.floor(size * (HQ_HOLE_METRICS.widthRatio));
    // Hauteur augmentée encore
    barHeight = Math.max(6, Math.floor(tile * 0.32));
    const offsetY = Math.floor(size * HQ_HOLE_METRICS.offsetYRatio); // décalage depuis le centre vers le bas
    x = Math.round(cx - barWidth / 2);
    y = Math.round(cy + offsetY - barHeight / 2);
  } else {
    // Barre SOUS l'image (fallback)
    barWidth = Math.floor(size * (HQ_HOLE_METRICS.widthRatio));
    barHeight = Math.max(6, Math.floor(tile * 0.3));
    const gap = Math.max(1, Math.floor(tile * 0.12));
    x = Math.round(cx - barWidth / 2);
    y = Math.round(cy + size / 2 + gap);
  }
  const ratio = Math.max(0, Math.min(1, (hq && hq.hpMax) ? (hq.hp / hq.hpMax) : 1));

  // Fond et contour
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeStyle = 'rgba(240,240,255,0.35)';
  ctx.lineWidth = Math.max(1, Math.floor(tile * 0.06));
  ctx.beginPath();
  ctx.rect(x, y, barWidth, barHeight);
  ctx.fill();
  ctx.stroke();

  // Remplissage vert selon ratio
  const fillWidth = Math.floor(barWidth * ratio);
  ctx.fillStyle = '#39ff14';
  ctx.beginPath();
  ctx.rect(x, y, fillWidth, barHeight);
  ctx.fill();
  ctx.restore();
}

function drawHQEnergyBar(ctx, hq, tile, cx, cy, size) {
  // Jauge verticale dans le trou central (remplissage 0 -> bas, 1000 -> haut)
  const d = Math.floor(size * HQ_CENTER_HOLE_METRICS.diameterRatio);
  const r = Math.floor(d / 2);
  const thickness = Math.max(1, Math.floor(tile * 0.06));
  const innerR = Math.max(1, r - thickness);
  const innerD = innerR * 2;
  const innerX = Math.round(cx - innerR);
  const innerY = Math.round(cy - innerR);
  const e = (hq && typeof hq.energy === 'number') ? hq.energy : 0;
  const eMax = (hq && typeof hq.energyMax === 'number') ? hq.energyMax : 1000;
  const ratio = Math.max(0, Math.min(1, eMax > 0 ? (e / eMax) : 0));

  ctx.save();
  // Fond assombri (cercle plein)
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Clip à l'intérieur du trou pour garder les bords arrondis
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.clip();

  // Remplissage vertical (bottom->top) en jaune sur toute la hauteur utile
  // Zone utile centrée verticalement, hauteur ≈ 1 tuile (taille d'une unité)
  const usable = Math.max(4, Math.min(innerD, Math.floor(tile * 1.0)));
  let yBase = innerY + Math.floor((innerD - usable) / 2);
  const offsetUp = Math.floor(tile * 0.20); // décalage vers le haut
  yBase = Math.max(innerY, yBase - offsetUp);
  const fillHeight = Math.floor(usable * ratio);
  ctx.fillStyle = '#ffd54a';
  ctx.fillRect(innerX, yBase + (usable - fillHeight), innerD, fillHeight);
  ctx.restore();
}

// --- Panel et logique de spawn ---
function renderSpawnPanel() {
  const panel = el('div', { className: 'spawn-panel', id: 'spawnPanel' });
  // En-tête QG + PV (centrés)
  const header = el('div', { style: 'text-align:center;' });
  const title = el('h3', { textContent: 'QG', style: 'margin:0 0 4px 0;' });
  const hpLabel = el('div', { id: 'hqHpLabel', textContent: 'Points de vie', style: 'color:#39ff14;font-weight:800;margin:0 0 4px 0;' });
  const hpLine = el('div', { id: 'hqHpLine', style: 'color:#39ff14;font-weight:800;margin:0 0 12px 0;' });
  const energyLabel = el('div', { id: 'hqEnergyLabel', textContent: 'Énergie', style: 'color:#ffd54a;font-weight:800;margin:6px 0 4px 0;' });
  const energyLine = el('div', { id: 'hqEnergyLine', style: 'color:#ffd54a;font-weight:800;margin:0 0 10px 0;' });
  header.append(title, hpLabel, hpLine, energyLabel, energyLine);
  panel.append(header);

  const list = el('div', { className: 'unit-list' });
  const card = el('div', { className: 'unit-card' });
  const icon = el('canvas', { width: 48, height: 48, id: 'spawnCreateIcon' });
  const colorForSpawn = getPlayerColor(state.currentPlayerIndex);
  drawUnitIconWithId(icon.getContext('2d'), 48, colorForSpawn, '?');
  const btn = button('Créer', () => spawnUnit());
  card.append(icon, btn);
  list.append(card);
  panel.append(list);
  // init texte PV
  updateHqHpLine();
  return panel;
}

function updateHqHpLine() {
  const hpLine = q('#hqHpLine');
  if (!hpLine) return;
  const key = state.playerColors[state.currentPlayerIndex];
  const hq = state.hqs && state.hqs.find(h => h.colorKey === key);
  if (!hq) { hpLine.textContent = ''; return; }
  hpLine.textContent = `${hq.hp} / ${hq.hpMax}`;
  hpLine.style.color = '#39ff14';
  hpLine.style.fontWeight = '800';
  const energyLine = q('#hqEnergyLine');
  if (energyLine) energyLine.textContent = `${hq.energy} / ${hq.energyMax}`;
}

function updateSpawnCreateIconColor() {
  const cv = q('#spawnCreateIcon');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  drawUnitIconWithId(ctx, cv.width, getPlayerColor(state.currentPlayerIndex), '?');
}

function drawTriangleIcon(ctx, size, color) {
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  // anneau
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(200, 210, 230, 0.45)';
  ctx.lineWidth = Math.max(2, Math.floor(size * 0.08));
  ctx.arc(c, c, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  // triangle
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(c, c - size * 0.22);
  ctx.lineTo(c - size * 0.22, c + size * 0.18);
  ctx.lineTo(c + size * 0.22, c + size * 0.18);
  ctx.closePath();
  ctx.fill();
}

function drawCircleIcon(ctx, size, color) {
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(200, 210, 230, 0.45)';
  ctx.lineWidth = Math.max(2, Math.floor(size * 0.08));
  ctx.arc(c, c, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(c, c, size * 0.24, 0, Math.PI * 2);
  ctx.fill();
}

function drawSquareIcon(ctx, size, color) {
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(200, 210, 230, 0.45)';
  ctx.lineWidth = Math.max(2, Math.floor(size * 0.08));
  ctx.arc(c, c, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = color;
  const half = size * 0.19;
  ctx.rect(c - half, c - half, half * 2, half * 2);
  ctx.fill();
}

function drawHexagonIcon(ctx, size, color) {
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(200, 210, 230, 0.45)';
  ctx.lineWidth = Math.max(2, Math.floor(size * 0.08));
  ctx.arc(c, c, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  const r = size * 0.30;
  ctx.beginPath();
  ctx.fillStyle = color;
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + i * (Math.PI / 3);
    const x = c + Math.cos(a) * r;
    const y = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function drawStarIcon(ctx, size, color) {
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(200, 210, 230, 0.45)';
  ctx.lineWidth = Math.max(2, Math.floor(size * 0.08));
  ctx.arc(c, c, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = color;
  const spikes = 5;
  const outer = size * 0.30;
  const inner = size * 0.14;
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (Math.PI / spikes) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? outer : inner;
    const x = c + Math.cos(ang) * rad;
    const y = c + Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

  // Ouvre/ferme le panel lors du clic sur un QG du joueur actif
document.addEventListener('click', (e) => {
  if (state.phase !== 'playing') return;
  const panel = q('#spawnPanel');
  const canvas = q('#game');
  if (!panel || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left; const y = e.clientY - rect.top;
  // convertit en coordonnées carte
  const { tile, ox, oy } = computeCanvasMetrics(canvas);
  const gx = Math.floor((x - ox) / tile);
  const gy = Math.floor((y - oy) / tile);
  // Vérifie clic sur un QG du joueur actif
  const activeKey = state.playerColors[state.currentPlayerIndex];
  const myHq = state.hqs.find(h => h.colorKey === activeKey);
  if (myHq && Math.abs(gx - myHq.cx) <= HQ_HALF_SPAN && Math.abs(gy - myHq.cy) <= HQ_HALF_SPAN) {
    // toggle panel
    panel.classList.toggle('visible');
    // recolor toutes les icônes selon le joueur actif
    recolorSpawnPanelIcons();
    updateHqHpLine();
    const canvas2 = q('#game'); if (canvas2) drawScene(canvas2);
  } else if (!panel.contains(e.target)) {
    panel.classList.remove('visible');
    const canvas2 = q('#game'); if (canvas2) drawScene(canvas2);
  }
});

function recolorSpawnPanelIcons() {
  const panel = q('#spawnPanel'); if (!panel) return;
  const color = getPlayerColor(state.currentPlayerIndex);
  const map = {
    triangle: drawTriangleIcon,
    circle: drawCircleIcon,
    square: drawSquareIcon,
    hexagon: drawHexagonIcon,
    star: drawStarIcon,
  };
  panel.querySelectorAll('canvas').forEach(cv => {
    const t = cv.dataset.type;
    const fn = map[t];
    if (fn) fn(cv.getContext('2d'), cv.width, color);
  });
  updateHqHpLine();
}

function spawnUnit() {
  const activeKey = state.playerColors[state.currentPlayerIndex];
  const hq = state.hqs.find(h => h.colorKey === activeKey);
  if (!hq) return;
  // Cherche la case libre la plus proche AUTOUR du QG (infranchissable)
  let spot = null;
  for (let r = HQ_HALF_SPAN + 1; r <= HQ_HALF_SPAN + 4 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // anneau
        const x = hq.cx + dx;
        const y = hq.cy + dy;
        if (!isInBounds(x, y)) continue;
        if (isBlocked(x, y)) continue;
        if (unitAt(x, y)) continue;
        spot = { x, y }; break;
      }
    }
  }
  if (!spot) return;
  const idNum = state.nextUnitId++;
  state.units.push({ id: idNum, ownerIndex: state.currentPlayerIndex, x: spot.x, y: spot.y, hp: 1, recentTrail: [], lastDir: null, anim: null, headingFrom: 0, headingTo: 0, headingStart: 0, headingEnd: 0 });
  // Marque la case comme connue libre pour ce joueur
  const pm = state.playerMaps[state.currentPlayerIndex];
  if (pm) pm.knownFree.add(`${spot.x},${spot.y}`);
  const panel = q('#spawnPanel'); if (panel) panel.classList.remove('visible');
  const canvas = q('#game'); if (canvas) drawScene(canvas);
}

function spawnInitialUnitsAtHQ(hq, ownerIndex, count) {
  const candidates = [];
  for (let dy = -(HQ_HALF_SPAN + 2); dy <= (HQ_HALF_SPAN + 2); dy++) {
    for (let dx = -(HQ_HALF_SPAN + 2); dx <= (HQ_HALF_SPAN + 2); dx++) {
      const x = hq.cx + dx, y = hq.cy + dy;
      if (!isInBounds(x, y)) continue;
      if (isHQCell(x, y)) continue;
      if (isBlocked(x, y)) continue;
      candidates.push({ x, y });
    }
  }
  let i = 0; const pm = state.playerMaps[ownerIndex];
  while (i < count && candidates.length) {
    const idx = Math.floor(Math.random() * candidates.length);
    const spot = candidates.splice(idx, 1)[0];
    if (unitAt(spot.x, spot.y)) continue;
    const idNum = state.nextUnitId++;
    state.units.push({ id: idNum, ownerIndex, x: spot.x, y: spot.y, hp: 1, recentTrail: [], lastDir: null, anim: null, headingFrom: 0, headingTo: 0, headingStart: 0, headingEnd: 0 });
    if (pm) pm.knownFree.add(`${spot.x},${spot.y}`);
    i++;
  }
}

function isInBounds(x, y) { return x > 0 && y > 0 && x < state.cols - 1 && y < state.rows - 1; }
function unitAt(x, y) { return state.units.some(u => u.x === x && u.y === y); }
function cryptoRandomId() { return Math.random().toString(36).slice(2, 10); }

function drawUnit(ctx, u, tile, ox, oy) {
  const now = performance.now();
  const tx = u.anim && u.anim.endTime > now ? u.anim.fromX + (u.anim.toX - u.anim.fromX) * easeOutCubic((now - u.anim.startTime) / (u.anim.endTime - u.anim.startTime)) : u.x;
  const ty = u.anim && u.anim.endTime > now ? u.anim.fromY + (u.anim.toY - u.anim.fromY) * easeOutCubic((now - u.anim.startTime) / (u.anim.endTime - u.anim.startTime)) : u.y;
  const cx = ox + (tx + 0.5) * tile;
  const cy = oy + (ty + 0.5) * tile;
  const r = tile * 0.46; // cercle intérieur bien centré
  const color = getPlayerColor(u.ownerIndex);
  const wallColor = '#151515';
  ctx.save();
  // remplissage intérieur (même teinte que les murs)
  const ringW = Math.max(3, Math.floor(tile * 0.22));
  const innerR = Math.max(1, r - ringW * 0.5);
  ctx.fillStyle = wallColor;
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.fill();
  // anneau épais pour futur jauges (couleur fixe)
  ctx.lineWidth = ringW;
  ctx.strokeStyle = '#222222';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  // ID centré (ID global unique)
  ctx.fillStyle = color;
  ctx.font = `${Math.floor(tile * 0.6)}px ui-monospace, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(u.id), cx, cy + 1);

  // Indicateur de direction (heading)
  const now2 = performance.now();
  const headingT = (u.headingEnd && u.headingEnd > now2)
    ? easeOutCubic((now2 - u.headingStart) / (u.headingEnd - u.headingStart)) : 1;
  const heading = (u.headingFrom ?? 0) + ((u.headingTo ?? 0) - (u.headingFrom ?? 0)) * Math.min(1, Math.max(0, headingT));
  // Petit trait à l'extérieur du cercle: part légèrement au-delà du bord et s'étend vers l'extérieur
  const startLen = r * 1.02;
  const endLen = r * 1.45;
  const sx = cx + Math.cos(heading) * startLen;
  const sy = cy + Math.sin(heading) * startLen;
  const hx = cx + Math.cos(heading) * endLen;
  const hy = cy + Math.sin(heading) * endLen;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, Math.floor(tile * 0.14));
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.restore();
}

function drawUnitIconWithId(ctx, size, color, idText) {
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  const wallColor = '#151515';
  const r = size * 0.42;
  const ringW = Math.max(2, Math.floor(size * 0.18));
  const innerR = Math.max(1, r - ringW * 0.5);
  // remplissage intérieur
  ctx.beginPath();
  ctx.fillStyle = wallColor;
  ctx.arc(c, c, innerR, 0, Math.PI * 2);
  ctx.fill();
  // anneau épais (couleur fixe)
  ctx.beginPath();
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = ringW;
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.stroke();
  // id
  ctx.fillStyle = color;
  ctx.font = `${Math.floor(size * 0.6)}px ui-monospace, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(idText), c, c + 1);
}

function easeOutCubic(t) { t = Math.min(1, Math.max(0, t)); return 1 - Math.pow(1 - t, 3); }

// Chaque symbole utilise hp (0..1) pour un remplissage vertical
function drawTriangleSymbol(ctx, cx, cy, r, hp) {
  const inner = r * 0.78; // triangle pleinement centré dans l'anneau
  const angles = [-Math.PI / 2, 5 * Math.PI / 6, Math.PI / 6];
  const verts = angles.map(a => ({ x: cx + Math.cos(a) * inner, y: cy + Math.sin(a) * inner }));
  const cutY = cy + inner - (inner * 2 * hp);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  ctx.lineTo(verts[1].x, verts[1].y);
  ctx.lineTo(verts[2].x, verts[2].y);
  ctx.closePath();
  ctx.clip();
  ctx.beginPath();
  ctx.rect(cx - inner, cutY, inner * 2, inner * 2);
  ctx.fill();
  ctx.restore();
}

function drawCircleSymbol(ctx, cx, cy, r, hp) {
  ctx.save();
  ctx.beginPath();
  const inner = r * 0.62; // plus petit
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.clip();
  const cutY = cy + inner - (inner * 2 * hp);
  ctx.beginPath();
  ctx.rect(cx - inner, cutY, inner * 2, inner * 2);
  ctx.fill();
  ctx.restore();
}

function drawSquareSymbol(ctx, cx, cy, r, hp) {
  const half = r * 0.62; // plus petit
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - half, cy - half, half * 2, half * 2);
  ctx.clip();
  const cutY = cy + half - (half * 2 * hp);
  ctx.beginPath();
  ctx.rect(cx - half, cutY, half * 2, half * 2);
  ctx.fill();
  ctx.restore();
}

function drawHexagonSymbol(ctx, cx, cy, r, hp) {
  const inner = r * 0.80; // bien à l'intérieur de l'anneau
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + i * (Math.PI / 3);
    const x = cx + Math.cos(a) * inner;
    const y = cy + Math.sin(a) * inner;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.clip();
  const cutY = cy + inner - (inner * 2 * hp);
  ctx.beginPath();
  ctx.rect(cx - inner, cutY, inner * 2, inner * 2);
  ctx.fill();
  ctx.restore();
}

function drawStarSymbol(ctx, cx, cy, r, hp) {
  const spikes = 5;
  const outer = r * 0.95;
  const inner = r * 0.42;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (Math.PI / spikes) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? outer : inner;
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.clip();
  const cutY = cy + outer - (outer * 2 * hp);
  ctx.beginPath();
  ctx.rect(cx - r, cutY, r * 2, r * 2);
  ctx.fill();
  ctx.restore();
}

// Les cases du QG (HQ_SIZE_TILES x HQ_SIZE_TILES) sont infranchissables
function isHQCell(x, y) {
  if (!state.hqs) return false;
  for (const h of state.hqs) {
    if (Math.abs(x - h.cx) <= HQ_HALF_SPAN && Math.abs(y - h.cy) <= HQ_HALF_SPAN) return true;
  }
  return false;
}

function isAtHQPerimeter(x, y, hq) {
  // Arrêt dans un carré proportionnel à la taille du QG: Chebyshev <= HQ_PERIM_RADIUS
  return Math.abs(x - hq.cx) <= HQ_PERIM_RADIUS && Math.abs(y - hq.cy) <= HQ_PERIM_RADIUS;
}

function isBlocked(x, y) {
  if (!isInBounds(x, y)) return true;
  if (state.tiles && state.tiles[y][x]) return true; // mur
  if (isHQCell(x, y)) return true; // QG zone
  return false;
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


