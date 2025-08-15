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
  units: [], // { id, ownerIndex, x, y, hp, recentTrail, lastDir, anim, lastAttackTime }
  programs: {}, // key unitId -> number[] commands
  explosions: [], // { x, y, startTime, duration, particles: [{x, y, vx, vy, life}] }
  activeLasers: [], // { unitId, targetId, targetType, startTime, playerColor }
  simIntervalId: null,
  animRafId: null,
  simRafId: null,
  // Cartographie partagée par joueur
  playerMaps: [],
  // Sélection de modules pour la création d'unités
  selectedModules: { movement: 0, shield: 0, attack: 0, ranged_attack: 0 }, // index -> { knownWalls:Set<string>, knownFree:Set<string>, visitCounts:Map<string,number> }
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
// Rayon bloquant (chevauchement interdit) légèrement plus petit pour permettre aux unités de s'approcher d'une case
const HQ_BLOCK_HALF_SPAN = Math.max(1, HQ_HALF_SPAN - 1);
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
  state.playerMaps = Array.from({ length: state.players }, () => ({ knownWalls: new Set(), knownFree: new Set(), visitCounts: new Map(), discoveredEnemyHQs: new Set() }));
  // populateFullMapKnowledge(); // Commenté: les joueurs doivent explorer pour découvrir la carte
  // Plus de spawn initial automatique
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
  state.playerMaps = Array.from({ length: state.players }, () => ({ knownWalls: new Set(), knownFree: new Set(), visitCounts: new Map(), discoveredEnemyHQs: new Set() }));
  // populateFullMapKnowledge(); // Commenté: les joueurs doivent explorer pour découvrir la carte
  // Plus de spawn initial automatique
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
  
  // Bouton spécial: Unité rouge avec 2 modules de déplacement
  const redUnitBtn = el('button', { className: 'dev-special', title: 'Unité rouge 2 mouvements' });
  redUnitBtn.textContent = 'Rouge 2M';
  redUnitBtn.style.backgroundColor = '#ff4444';
  redUnitBtn.style.color = 'white';
  redUnitBtn.addEventListener('click', () => selectDevSpawn('unit_2movement', 'red'));
  devList.append(redUnitBtn);
  
  // Bouton spécial: Unité rouge CAC avec 2 mouvements + 1 attaque CAC
  const redCacBtn = el('button', { className: 'dev-special', title: 'Unité rouge CAC: 2 mouvements, 1 attaque CAC' });
  redCacBtn.textContent = 'Rouge CAC';
  redCacBtn.style.backgroundColor = '#cc3333';
  redCacBtn.style.color = 'white';
  redCacBtn.addEventListener('click', () => selectDevSpawn('unit_cac', 'red'));
  devList.append(redCacBtn);
  

  
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
  // --- Bouton: Endommager modules unité ---
  const damageModuleBtn = el('button', { className: 'dev-damage-module', title: 'Endommager la dernière unité créée (boucliers en priorité)' });
  damageModuleBtn.textContent = 'Dmg Unité';
  damageModuleBtn.addEventListener('click', () => {
    // Trouve la dernière unité créée (ID le plus élevé) qui a des modules
    const unitsWithModules = state.units.filter(u => u.modules && u.modules.length > 0);
    if (unitsWithModules.length === 0) return;
    
    // Trier par ID décroissant pour avoir la dernière créée en premier
    unitsWithModules.sort((a, b) => b.id - a.id);
    const lastUnit = unitsWithModules[0];
    
    // Appliquer 25 dégâts en utilisant le système de priorité des boucliers
    damageUnit(lastUnit, 25);
    
    const canvas = q('#game'); if (canvas) drawScene(canvas);
  });
  devList.append(damageModuleBtn);
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
    startUiAnimationLoop();
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
  // Remet à zéro les compteurs de modules pour le nouveau joueur
  state.selectedModules.movement = 0;
  state.selectedModules.shield = 0;
  state.selectedModules.attack = 0;
  state.selectedModules.ranged_attack = 0;
  updateModuleDisplay();
  updateEnergyCost();
  updateAttackButtonsState();
  // Met à jour la couleur du bouton de programmation
  const progBtn = q('#programBtn');
  if (progBtn) progBtn.style.setProperty('--progColor', getPlayerColor(state.currentPlayerIndex));
  drawPlayerButton();
  updateSpawnCreateIconColor();
  // S'assure que la connaissance globale reste en place pour tous les joueurs
  populateFullMapKnowledge();
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
  // Commande spéciale 00: détruit l'unité ciblée
  if (cmdTokens.includes('00')) {
    // Supprimer l'unité de la liste
    const unitIndex = state.units.findIndex(u => u.id === myUnit.id);
    if (unitIndex !== -1) {
      // Créer une explosion à la position de l'unité avant de la détruire
      createExplosion(myUnit.x, myUnit.y);
      
      // Supprimer l'unité du jeu
      state.units.splice(unitIndex, 1);
      
      // Supprimer le programme associé
      delete state.programs[unitId];
      
      console.log(`Unité ${unitId} détruite par commande 00`);
      
      // Mettre à jour l'affichage
      const canvas = q('#game'); 
      if (canvas) drawScene(canvas);
    }
    
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
  // Les unités créées via le développeur ont des modules prédéfinis
  let modules = [];
  
  if (devSpawnSelection.type === 'unit_2movement') {
    // Unité spéciale avec seulement 2 modules de mouvement
    modules = [
      { type: 'movement', hp: 100, maxHp: 100 },
      { type: 'movement', hp: 100, maxHp: 100 }
    ];
  } else if (devSpawnSelection.type === 'unit_cac') {
    // Unité rouge CAC: 2 mouvements + 1 attaque CAC
    modules = [
      { type: 'movement', hp: 100, maxHp: 100 },
      { type: 'movement', hp: 100, maxHp: 100 },
      { type: 'attack', hp: 100, maxHp: 100 }
    ];

  } else {
    // Unité normale avec modules complets
    modules = [
      // 3 modules de mouvement
      { type: 'movement', hp: 100, maxHp: 100 },
      { type: 'movement', hp: 100, maxHp: 100 },
      { type: 'movement', hp: 100, maxHp: 100 },
      // 1 module de bouclier
      { type: 'shield', hp: 100, maxHp: 100 },
      // 2 modules d'attaque à distance
      { type: 'ranged_attack', hp: 100, maxHp: 100 },
      { type: 'ranged_attack', hp: 100, maxHp: 100 }
    ];
  }
  state.units.push({ id: idNum, ownerIndex, x: gx, y: gy, hp: 1, modules: modules, recentTrail: [], lastDir: null, anim: null, lastAttackTime: null });
  
  // Ajouter la position de spawn à la connaissance du joueur
  const pm = state.playerMaps[ownerIndex];
  if (pm && pm.knownFree) {
    pm.knownFree.add(`${gx},${gy}`);
  }
  
  // Vérifier si cette nouvelle unité découvre un QG ennemie
  const newUnit = state.units[state.units.length - 1];
  checkForEnemyHQDiscovery(newUnit);
  
  // Programmer automatiquement l'unité
  if (devSpawnSelection.type === 'unit_2movement') {
    // Unité rouge spéciale: seulement exploration
    state.programs[String(idNum)] = [6];
    console.log(`Unité rouge ${idNum} créée avec programmation d'exploration simple`);
  } else if (devSpawnSelection.type === 'unit_cac') {
    // Unité rouge CAC: programmation avancée
    state.programs[String(idNum)] = [6, 11, 5, 12, 15, 2, 14, 6];
    console.log(`Unité rouge ${devSpawnSelection.type} ${idNum} créée avec programmation avancée`);
  } else {
    // Unités normales: séquence complète
    state.programs[String(idNum)] = [6, 11, 5, 12, 15, 2];
    console.log(`Unité développeur ${idNum} créée avec modules prédéfinis et programmée automatiquement`);
  }
  
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
  
  // Vérifier les découvertes de QG pour toutes les unités
  for (const u of state.units) {
    checkForEnemyHQDiscovery(u);
  }
  
  // Commenté pour réduire les logs
  // for (const u of state.units) {
  //   const cmds = state.programs[String(u.id)] || [];
  //   if (cmds.length > 0) {
  //     console.log(`DEBUG stepSimulation: Unité ${u.id} a les commandes:`, cmds);
  //   }
  // }
  
  // Supprimer les unités qui n'ont plus aucun module fonctionnel
  const unitsToRemove = [];
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i];
    if (!hasAnyWorkingModule(u)) {
      unitsToRemove.push(i);
    }
  }
  
  // Supprimer les unités en partant de la fin pour ne pas décaler les indices
  for (let i = unitsToRemove.length - 1; i >= 0; i--) {
    const unitIndex = unitsToRemove[i];
    const removedUnit = state.units[unitIndex];
    console.log(`Unité ${removedUnit.id} supprimée (plus de modules fonctionnels)`);
    
    // Créer une animation d'explosion avant de supprimer l'unité
    createExplosion(removedUnit.x, removedUnit.y);
    
    state.units.splice(unitIndex, 1);
    // Nettoyer aussi ses programmes
    delete state.programs[String(removedUnit.id)];
  }
  
  // Redessiner la scène si des unités ont été supprimées
  if (unitsToRemove.length > 0) {
    const canvas = q('#game'); 
    if (canvas) drawScene(canvas);
  }
  
  let moved = false;
  for (const u of state.units) {
    // ignore les unités déjà en animation
    if (u.anim && performance.now() < u.anim.endTime) {
      const animDuration = u.anim.endTime - u.anim.startTime;
      
      // Sécurité : si l'animation dure plus de 10 secondes, la forcer à se terminer
      if (animDuration > 10000) {
        console.log(`⚠️ CORRECTION: Animation trop longue pour unité ${u.id}, forcer l'arrêt`);
        u.anim = null;
      } else {
        continue;
      }
    }
    const cmds = state.programs[String(u.id)];
    if (!cmds || cmds.length === 0) {
      continue;
    }
    
    // Traitement des nouvelles commandes conditionnelles et d'attaque
    const processed = processAdvancedCommands(u, cmds);
    if (processed) {
      if (processed.moved) moved = true;
      continue;
    }
    
    // Vérifier si l'unité peut se déplacer (a des modules de mouvement fonctionnels)
    if (!hasWorkingMovementModule(u)) {
      continue; // L'unité ne peut pas se déplacer
    }
    // Commande 7 + 18 (QG): aller vers QG (sinon explorer jusqu'à découverte)
    if (cmds[0] === 7 && cmds[1] === 18) {
      const myHq = state.hqs.find(h => h.colorKey === state.playerColors[u.ownerIndex]);
      if (myHq) {
        if (isAtHQPerimeter(u.x, u.y, myHq)) continue;
        const stepTo = planStepToHQUsingSharedMap(u, myHq);
        if (stepTo) {
          const now = performance.now();
          const speedModifier = getSpeedModifier(u);
          const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
          const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
          u.anim = { fromX: u.x, fromY: u.y, toX: stepTo.x, toY: stepTo.y, startTime: now, endTime: now + tileDuration };
          const ang = Math.atan2(stepTo.y - u.y, stepTo.x - u.x);
          u.headingFrom = (u.headingTo ?? ang);
          u.headingTo = ang;
          u.headingStart = now; u.headingEnd = now + tileDuration;
          updateRecentTrail(u, u.x, u.y);
          u.x = stepTo.x; u.y = stepTo.y; u.lastDir = [Math.sign(stepTo.x - u.anim.fromX), Math.sign(stepTo.y - u.anim.fromY)]; moved = true;
          const pm2 = state.playerMaps[u.ownerIndex]; if (pm2 && pm2.knownFree) pm2.knownFree.add(`${u.x},${u.y}`);
          continue;
        }
        // fallback 1: tente de rejoindre la zone connue puis chemin direct HQ
        const bridge = planStepBridgeToKnownThenHQ(u, myHq);
        if (bridge) {
          const now2 = performance.now();
          const speedModifier = getSpeedModifier(u);
          const baseTd = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
          const td = speedModifier > 0 ? Math.floor(baseTd / speedModifier) : baseTd * 10;
          u.anim = { fromX: u.x, fromY: u.y, toX: bridge.x, toY: bridge.y, startTime: now2, endTime: now2 + td };
          const ang2 = Math.atan2(bridge.y - u.y, bridge.x - u.x);
          u.headingFrom = (u.headingTo ?? ang2);
          u.headingTo = ang2; u.headingStart = now2; u.headingEnd = now2 + td;
          updateRecentTrail(u, u.x, u.y);
          u.x = bridge.x; u.y = bridge.y; u.lastDir = [Math.sign(bridge.x - u.anim.fromX), Math.sign(bridge.y - u.anim.fromY)]; moved = true;
          const pm3 = state.playerMaps[u.ownerIndex]; if (pm3 && pm3.knownFree) pm3.knownFree.add(`${u.x},${u.y}`);
          continue;
        }
        // fallback 2: stratégie locale si pas de pont
        const didMove = moveTowardOrExploreInline(u, myHq.cx, myHq.cy);
        if (didMove) moved = true;
        continue;
      }
      // pas de QG? on tombera sur explorer plus bas si présent
    }
    
    // Commande 7 + 20 (QG ennemie): aller vers le QG ennemie le plus proche
    if (cmds[0] === 7 && cmds[1] === 20) {
      // Vérifier d'abord si on découvre de nouveaux QG
      checkForEnemyHQDiscovery(u);
      const nearestEnemyHQ = findNearestDiscoveredEnemyHQ(u);
      if (nearestEnemyHQ) {
        console.log(`Unité ${u.id}: Se déplace vers QG ennemie ${nearestEnemyHQ.colorKey} à (${nearestEnemyHQ.cx}, ${nearestEnemyHQ.cy})`);
        
        // Utiliser la connaissance globale pour naviguer vers QG ennemie découvert
        const stepTo = planStepToDiscoveredHQ(u, nearestEnemyHQ);
        if (stepTo) {
          console.log(`Unité ${u.id}: Chemin global trouvé vers QG ennemie découvert`);
          const now = performance.now();
          const speedModifier = getSpeedModifier(u);
          const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
          const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
          u.anim = { fromX: u.x, fromY: u.y, toX: stepTo.x, toY: stepTo.y, startTime: now, endTime: now + tileDuration };
          const ang = Math.atan2(stepTo.y - u.y, stepTo.x - u.x);
          u.headingFrom = (u.headingTo ?? ang);
          u.headingTo = ang;
          u.headingStart = now; u.headingEnd = now + tileDuration;
          updateRecentTrail(u, u.x, u.y);
          u.x = stepTo.x; u.y = stepTo.y; u.lastDir = [Math.sign(stepTo.x - u.anim.fromX), Math.sign(stepTo.y - u.anim.fromY)]; moved = true;
          const pm2 = state.playerMaps[u.ownerIndex]; if (pm2 && pm2.knownFree) pm2.knownFree.add(`${u.x},${u.y}`);
          continue;
        } else {
          console.log(`Unité ${u.id}: Aucun chemin connu vers QG ennemie, exploration pour le découvrir`);
          // Explorer aléatoirement pour découvrir des QG
          const didMove = moveTowardEnemyHQWithPlayerKnowledge(u, u.x + Math.random() * 20 - 10, u.y + Math.random() * 20 - 10);
          if (didMove) moved = true;
          continue;
        }
      } else {
        console.log(`Unité ${u.id}: Aucun QG ennemie trouvé, exploration`);
        // Fallback: explorer pour chercher des QG ennemis
        const didMove = moveTowardOrExploreInline(u, u.x + Math.random() * 10 - 5, u.y + Math.random() * 10 - 5);
        if (didMove) moved = true;
        continue;
      }
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
        const speedModifier = getSpeedModifier(u);
        const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
        const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
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
  const speedModifier = getSpeedModifier(u);
  const baseDuration = 240;
  const duration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
  u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + duration };
  const ang = Math.atan2(ny - u.y, nx - u.x);
  u.headingFrom = (u.headingTo ?? ang);
  u.headingTo = ang;
  u.headingStart = now; u.headingEnd = now + duration;
  updateRecentTrail(u, u.x, u.y);
  u.x = nx; u.y = ny; u.lastDir = step; if (u.knownFree) u.knownFree.add(`${u.x},${u.y}`);
  return true;
}

// Traite les commandes avancées (détection, conditionnelles, attaque)
function processAdvancedCommands(u, cmds) {
  // Nouvelles commandes:
  // 5 = DETECTE (suivi de la cible à détecter)
  // 7 = DEPLACER (suivi de la cible vers laquelle se déplacer)
  // 11 = SI
  // 15 = ALORS 
  // 14 = SINON
  // 12 = ROBOT_ENNEMIE (unité ennemie)
  // 18 = QG (son propre QG)
  // 20 = QG_ENNEMIE (QG ennemie)
  // 2 = ATTAQUE
  
  // Traiter les commandes dans l'ordre
  
  // D'abord vérifier s'il y a une structure SI...ALORS...SINON
  const siIndex = cmds.indexOf(11); // SI
  if (siIndex !== -1) {
    return processConditionalCommand(u, cmds, siIndex);
  }
  
  // Traiter les commandes de déplacement vers QG ennemie [7, 20]
  if (cmds.length >= 2 && cmds[0] === 7 && cmds[1] === 20) {
    console.log(`DEBUG processAdvancedCommands: Traitement 7+20 pour unité ${u.id}`);
    
    // Vérifier si l'unité peut se déplacer
    if (!hasWorkingMovementModule(u)) {
      console.log(`Unité ${u.id}: Pas de module de mouvement fonctionnel`);
      return { moved: false };
    }
    
    // Vérifier et découvrir les QG
    checkForEnemyHQDiscovery(u);
    const nearestEnemyHQ = findNearestDiscoveredEnemyHQ(u);
    
    if (nearestEnemyHQ) {
      console.log(`🎯 SWITCH: QG découvert = OUI - Unité ${u.id} vers QG ${nearestEnemyHQ.colorKey} à (${nearestEnemyHQ.cx}, ${nearestEnemyHQ.cy})`);
      
      // Utiliser la connaissance globale pour naviguer vers QG ennemie découvert
      const stepTo = planStepToDiscoveredHQ(u, nearestEnemyHQ);
      if (stepTo) {
        console.log(`Unité ${u.id}: Chemin global trouvé vers QG ennemie découvert`);
        const now = performance.now();
        const speedModifier = getSpeedModifier(u);
        const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
        const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
        u.anim = { fromX: u.x, fromY: u.y, toX: stepTo.x, toY: stepTo.y, startTime: now, endTime: now + tileDuration };
        const ang = Math.atan2(stepTo.y - u.y, stepTo.x - u.x);
        u.headingFrom = (u.headingTo ?? ang);
        u.headingTo = ang;
        u.headingStart = now; u.headingEnd = now + tileDuration;
        updateRecentTrail(u, u.x, u.y);
        u.x = stepTo.x; u.y = stepTo.y; u.lastDir = [Math.sign(stepTo.x - u.anim.fromX), Math.sign(stepTo.y - u.anim.fromY)];
        const pm2 = state.playerMaps[u.ownerIndex]; if (pm2 && pm2.knownFree) pm2.knownFree.add(`${u.x},${u.y}`);
        return { moved: true };
      } else {
        console.log(`Unité ${u.id}: Aucun chemin global trouvé vers QG ennemie, exploration normale`);
        // Utiliser l'exploration normale (commande 6) pour découvrir le QG
        return executeExploreAction(u);
      }
    } else {
      console.log(`🔍 SWITCH: QG découvert = NON - Unité ${u.id} exploration normale (commande 6)`);
      
      // COPIE EXACTE du code d'exploration commande 6
      const pm = state.playerMaps[u.ownerIndex];
      if (!pm) return { moved: false };
      
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
            const nx = u.x + d[0];
            const ny = u.y + d[1];
            if (isInBounds(nx, ny) && !isBlocked(nx, ny) && !unitAt(nx, ny)) return d;
          }
          scored = collect(true);
        }
        if (scored.length === 0) return null;
        scored.sort((a, b) => a.score - b.score);
        return scored[0].d;
      })();
      
      if (step) {
        const nx = u.x + step[0];
        const ny = u.y + step[1];
        
        const now = performance.now();
        const speedModifier = getSpeedModifier(u);
        const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
        const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
        
        u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + tileDuration };
        const ang = Math.atan2(ny - u.y, nx - u.x);
        u.headingFrom = (u.headingTo ?? ang);
        u.headingTo = ang;
        u.headingStart = now; u.headingEnd = now + tileDuration;
        
        updateRecentTrail(u, u.x, u.y);
        u.x = nx; u.y = ny; u.lastDir = step;
        if (pm.knownFree) pm.knownFree.add(`${u.x},${u.y}`);
        
        return { moved: true };
      }
      
      return { moved: false };
    }
  }
  
  // Sinon, chercher une commande d'attaque directe (pas dans une condition)
  if (cmds.includes(2)) {
    return processAttackCommand(u);
  }
  
  return null; // Aucune commande avancée trouvée
}

// Fonction pour fuir un ennemi
function fleeFromEnemy(u, enemy) {
  const dirs = [[1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1]];
  let bestDir = null;
  let maxDistance = -1;

  for (const [dx, dy] of dirs) {
    const nx = u.x + dx;
    const ny = u.y + dy;
    
    if (isInBounds(nx, ny) && !isBlocked(nx, ny) && !unitAt(nx, ny)) {
      const newDistance = Math.abs(nx - enemy.x) + Math.abs(ny - enemy.y);
      if (newDistance > maxDistance) {
        maxDistance = newDistance;
        bestDir = [dx, dy];
      }
    }
  }

  if (bestDir) {
    const [dx, dy] = bestDir;
    const nx = u.x + dx;
    const ny = u.y + dy;
    console.log(`Unité ${u.id}: Fuite vers (${nx}, ${ny})`);
    
    // Créer l'animation de mouvement
    const now = performance.now();
    const speedModifier = getSpeedModifier(u);
    const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
    const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
    
    u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + tileDuration };
    const ang = Math.atan2(ny - u.y, nx - u.x);
    u.headingFrom = (u.headingTo ?? ang);
    u.headingTo = ang;
    u.headingStart = now; u.headingEnd = now + tileDuration;
    
    updateRecentTrail(u, u.x, u.y);
    u.x = nx; u.y = ny; u.lastDir = [dx, dy];
    
    // Mettre à jour la connaissance du joueur
    const pm = state.playerMaps[u.ownerIndex];
    if (pm && pm.knownFree) pm.knownFree.add(`${u.x},${u.y}`);
    
    return { moved: true };
  }

  console.log(`Unité ${u.id}: Impossible de fuir, reste sur place`);
  return { moved: false };
}

// Traite les commandes d'attaque
function processAttackCommand(u) {
  // Vérifier d'abord si l'unité a des modules d'attaque à distance
  const hasRangedAttack = u.modules && u.modules.some(m => m.type === 'ranged_attack' && m.hp > 0);
  const hasMeleeAttack = u.modules && u.modules.some(m => m.type === 'attack' && m.hp > 0);
  
  // Si unité distance-seulement, vérifier si elle doit fuir d'abord
  if (hasRangedAttack && !hasMeleeAttack) {
    const threatEnemy = findNearestEnemyUnit(u);
    if (threatEnemy && threatEnemy.type === 'unit') {
      const threatDistance = Math.abs(u.x - threatEnemy.x) + Math.abs(u.y - threatEnemy.y);
      if (threatDistance <= 2) { // Unité ennemie trop proche
        console.log(`Unité ${u.id}: Unité ennemie à ${threatDistance} cases, fuite prioritaire`);
        return fleeFromEnemy(u, threatEnemy);
      }
    }
  }
  
  let nearestEnemy = null;
  let attackType = null;
  
  if (hasRangedAttack) {
    // Chercher d'abord des ennemis à portée d'attaque à distance (6 cases)
    nearestEnemy = findNearestEnemyUnitInRange(u, 6);
    if (nearestEnemy) {
      attackType = 'ranged';
      console.log(`Unité ${u.id}: Cible à distance trouvée: ${nearestEnemy.type} à (${nearestEnemy.x}, ${nearestEnemy.y})`);
    }
  }
  
  if (!nearestEnemy && hasMeleeAttack) {
    // Si pas d'ennemi à distance ou pas de module à distance, chercher en C.A.C
    nearestEnemy = findNearestEnemyUnit(u);
    if (nearestEnemy) {
      const distance = Math.abs(u.x - nearestEnemy.x) + Math.abs(u.y - nearestEnemy.y);
      // Vérifier si à portée C.A.C
      if (nearestEnemy.type === 'unit' && distance <= 1) {
        attackType = 'melee';
      } else if (nearestEnemy.type === 'hq' && distance <= HQ_PERIM_RADIUS) {
        attackType = 'melee';
      } else {
        nearestEnemy = null; // Pas à portée C.A.C
      }
    }
  }
  
  // Si unité a seulement attaque à distance et ennemi trop proche, fuir
  if (!nearestEnemy && hasRangedAttack && !hasMeleeAttack) {
    const closeEnemy = findNearestEnemyUnit(u);
    if (closeEnemy) {
      const distance = Math.abs(u.x - closeEnemy.x) + Math.abs(u.y - closeEnemy.y);
      console.log(`Unité ${u.id}: Ennemi proche détecté: ${closeEnemy.type} à distance ${distance}`);
      
      // Fuir si ennemi trop proche (unités: 2 cases, QG: 3 cases)
      const fleeDistance = closeEnemy.type === 'unit' ? 2 : 3;
      if (distance <= fleeDistance) {
        console.log(`Unité ${u.id}: ${closeEnemy.type} ennemi trop proche (${distance}), fuite pour maintenir distance`);
        return fleeFromEnemy(u, closeEnemy);
      }
    }
  }

  if (!nearestEnemy) {
    // Chercher des ennemis plus loin pour les suivre
    const distantEnemy = findNearestEnemyUnit(u);
    if (distantEnemy) {
      console.log(`Unité ${u.id}: Ennemi hors portée, poursuite de la cible`);
      return moveTowardTarget(u, distantEnemy.x, distantEnemy.y) ? { moved: true } : { moved: false };
    }
    
    console.log(`Unité ${u.id}: Aucun ennemi à portée d'attaque, retour à l'exploration`);
    return executeExploreAction(u);
  }
  
  // Attaquer avec le type approprié
  const now = performance.now();
  const attackCooldown = 1000; // 1 seconde entre les attaques
    
  // Vérifier si assez de temps s'est écoulé depuis la dernière attaque
  if (!u.lastAttackTime || (now - u.lastAttackTime) >= attackCooldown) {
    const isRangedAttack = attackType === 'ranged';
    const attackDamage = calculateAttackDamage(u, isRangedAttack);
    console.log(`Unité ${u.id}: ${isRangedAttack ? 'Attaque à distance' : 'Attaque C.A.C'} = ${attackDamage} dégâts`);
      if (attackDamage > 0) {
        if (nearestEnemy.type === 'unit') {
          // Attaquer une unité
          console.log(`Unité ${u.id} attaque l'unité ${nearestEnemy.target.id} pour ${attackDamage} dégâts`);
          damageUnit(nearestEnemy.target, attackDamage);
        } else if (nearestEnemy.type === 'hq') {
          // Attaquer un QG
          const distanceToHQ = Math.abs(u.x - nearestEnemy.target.cx) + Math.abs(u.y - nearestEnemy.target.cy);
          console.log(`Unité ${u.id} attaque le QG ${nearestEnemy.target.colorKey} pour ${attackDamage} dégâts (distance: ${distanceToHQ})`);
          damageHQ(nearestEnemy.target, attackDamage);
        }
        
        // Enregistrer le temps de cette attaque
        u.lastAttackTime = now;
        
        // Créer l'animation appropriée
        if (isRangedAttack) {
          // Animation laser continu pour attaque à distance
          createContinuousLaser(u, nearestEnemy, state.playerColors[u.ownerIndex]);
        } else {
          // Animation explosion pour attaque C.A.C
          createAttackExplosion(nearestEnemy.x, nearestEnemy.y);
        }
        
        return { moved: false }; // L'attaque ne compte pas comme un mouvement
      } else {
        // Plus de modules d'attaque fonctionnels, retourner à l'exploration
        console.log(`Unité ${u.id}: Plus de modules d'attaque, retour à l'exploration`);
        return executeExploreAction(u);
      }
  } else {
    // En attente du cooldown, ne pas bouger
    const remainingCooldown = Math.ceil((attackCooldown - (now - u.lastAttackTime)) / 1000);
    console.log(`Unité ${u.id} en cooldown d'attaque (${remainingCooldown}s restantes)`);
    return { moved: false };
  }
}

// Vérifie si une unité est en train d'attaquer un QG
function isUnitAttackingHQ(u) {
  const nearestEnemy = findNearestEnemyUnit(u);
  if (!nearestEnemy || nearestEnemy.type !== 'hq') return false;
  
  const distance = Math.abs(u.x - nearestEnemy.x) + Math.abs(u.y - nearestEnemy.y);
  return distance <= HQ_PERIM_RADIUS; // Si dans le périmètre d'attaque du QG
}

// Vérifie si une unité est en train d'attaquer (QG ou autre unité)
function isUnitAttacking(u) {
  const nearestEnemy = findNearestEnemyUnit(u);
  if (!nearestEnemy) return false;
  
  const distance = Math.abs(u.x - nearestEnemy.x) + Math.abs(u.y - nearestEnemy.y);
  
  if (nearestEnemy.type === 'hq') {
    return distance <= 8; // Attaque QG - zone élargie
  } else {
    return distance <= 6; // Attaque unité - zone élargie
  }
}

// Traite les commandes conditionnelles (SI...ALORS...SINON)
function processConditionalCommand(u, cmds, siIndex) {
  // Structure attendue: [commandes préliminaires] SI condition ALORS action [SINON action]
  const alorsIndex = cmds.indexOf(15); // ALORS
  const sinonIndex = cmds.indexOf(14); // SINON
  
  console.log(`Unité ${u.id}: Traitement commandes conditionnelles:`, cmds);
  
  if (alorsIndex === -1) {
    console.log(`Unité ${u.id}: Structure SI sans ALORS`);
    return null;
  }
  
  // Vérifier si l'unité est déjà en train d'attaquer (QG ou unité)
  const isAttackingEnemy = isUnitAttacking(u);
  
  // D'abord, exécuter les commandes avant SI (comme l'exploration) seulement si pas en train d'attaquer
  const commandesAvantSI = cmds.slice(0, siIndex);
  console.log(`Unité ${u.id}: Commandes avant SI:`, commandesAvantSI);
  console.log(`Unité ${u.id}: En train d'attaquer:`, isAttackingEnemy);
  
  let hasMoved = false;
  if (commandesAvantSI.length > 0 && !isAttackingEnemy) {
    const resultPrelim = executeAction(u, commandesAvantSI);
    console.log(`Unité ${u.id}: Résultat commandes préliminaires:`, resultPrelim);
    hasMoved = resultPrelim && resultPrelim.moved;
  } else if (isAttackingEnemy) {
    console.log(`Unité ${u.id}: Attaque en cours, pas d'exploration préliminaire`);
  }
  
  // Extraire la condition (entre SI et ALORS)
  const condition = cmds.slice(siIndex + 1, alorsIndex);
  console.log(`Unité ${u.id}: Condition à évaluer:`, condition);
  
  // Évaluer la condition
  const conditionResult = evaluateCondition(u, condition);
  console.log(`Unité ${u.id}: Résultat de la condition:`, conditionResult);
  
  let actionToExecute = [];
  if (conditionResult) {
    // Exécuter la partie ALORS
    if (sinonIndex !== -1) {
      actionToExecute = cmds.slice(alorsIndex + 1, sinonIndex);
    } else {
      actionToExecute = cmds.slice(alorsIndex + 1);
    }
  } else if (sinonIndex !== -1) {
    // Exécuter la partie SINON
    actionToExecute = cmds.slice(sinonIndex + 1);
  } else {
    // Pas de SINON et condition fausse : continuer les commandes préliminaires (explorer) sauf si on attaque
    if (!hasMoved && commandesAvantSI.length > 0 && !isAttackingEnemy) {
      console.log(`Unité ${u.id}: Condition fausse, continuation de l'exploration`);
      actionToExecute = commandesAvantSI;
    } else if (isAttackingEnemy) {
      console.log(`Unité ${u.id}: En attaque, pas d'exploration automatique`);
    }
  }
  
  // Exécuter l'action conditionnelle
  console.log(`Unité ${u.id}: Action à exécuter:`, actionToExecute);
  if (actionToExecute.length > 0) {
    const result = executeAction(u, actionToExecute);
    console.log(`Unité ${u.id}: Résultat de l'action:`, result);
    return result;
  }
  
  console.log(`Unité ${u.id}: Aucune action à exécuter`);
  return { moved: false };
}

// Évalue une condition
function evaluateCondition(u, condition) {
  if (condition.length < 2) return false;
  
  const command = condition[0];
  const target = condition[1];
  
  // 5 = DETECTE
  if (command === 5) {
    // 12 = ROBOT_ENNEMIE (unité ennemie)
    if (target === 12) {
      return detectEnemyUnit(u);
    }
    // 18 = QG (détection du QG)
    if (target === 18) {
      return detectHQ(u);
    }
    // 20 = QG_ENNEMIE (QG ennemie)
    if (target === 20) {
      return detectEnemyHQ(u);
    }
  }
  
  return false;
}

// Détecte s'il y a une unité ennemie (robot ou QG) à proximité
function detectEnemyUnit(u) {
  const detectionRange = 7; // Portée de détection élargie pour QG
  
  // Détecter les unités ennemies
  const enemyUnits = state.units.filter(unit => 
    unit.ownerIndex !== u.ownerIndex &&
    Math.abs(unit.x - u.x) <= detectionRange &&
    Math.abs(unit.y - u.y) <= detectionRange
  );
  
  // Détecter les QG ennemis
  const enemyHQs = state.hqs.filter(hq => 
    hq.colorKey !== state.playerColors[u.ownerIndex] &&
    Math.abs(hq.cx - u.x) <= detectionRange &&
    Math.abs(hq.cy - u.y) <= detectionRange
  );
  
  return enemyUnits.length > 0 || enemyHQs.length > 0;
}

// Détecte s'il y a un QG à proximité
function detectHQ(u) {
  const detectionRange = 5; // Portée de détection pour les QG
  const enemyHQs = state.hqs.filter(hq => 
    hq.colorKey !== state.playerColors[u.ownerIndex] &&
    Math.abs(hq.cx - u.x) <= detectionRange &&
    Math.abs(hq.cy - u.y) <= detectionRange
  );
  
  return enemyHQs.length > 0;
}

// Détecte s'il y a un QG ennemie à proximité (spécifiquement)
function detectEnemyHQ(u) {
  const detectionRange = 4; // Portée de détection pour les QG ennemis
  
  // Détecter seulement les QG ennemis (pas les siens)
  const enemyHQs = state.hqs.filter(hq => 
    hq.colorKey !== state.playerColors[u.ownerIndex] &&
    Math.abs(hq.cx - u.x) <= detectionRange &&
    Math.abs(hq.cy - u.y) <= detectionRange
  );
  
  console.log(`Unité ${u.id}: Détection QG ennemie - ${enemyHQs.length} QG(s) ennemie(s) détecté(s)`);
  return enemyHQs.length > 0;
}

// Exécute une action donnée
function executeAction(u, action) {
  console.log(`Unité ${u.id}: Exécution de l'action:`, action);
  
  if (action.includes(2)) {
    // Action d'attaque
    return processAttackCommand(u);
  }
  
  if (action.includes(6)) {
    // Action d'exploration explicite
    console.log(`Unité ${u.id}: Tentative d'exploration`);
    
    // Vérifier si l'unité peut se déplacer
    if (!hasWorkingMovementModule(u)) {
      console.log(`Unité ${u.id}: Pas de module de mouvement fonctionnel`);
      return { moved: false };
    }
    
    const pm = state.playerMaps[u.ownerIndex];
    if (!pm) {
      console.log(`Unité ${u.id}: Pas de carte de joueur`);
      return { moved: false };
    }
    
    const k = `${u.x},${u.y}`;
    pm.visitCounts.set(k, (pm.visitCounts.get(k) || 0) + 1);
    
    // Utiliser la même logique que dans la boucle principale d'exploration
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
          if (u.recentTrail && u.recentTrail.includes(key)) continue;
          if (u.lastDir && d[0] === u.lastDir[0] && d[1] === u.lastDir[1]) score -= 0.15;
          arr.push({ d, score });
        }
        return arr;
      };
      
      let scored = collect(false);
      if (scored.length === 0) {
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
      const speedModifier = getSpeedModifier(u);
      const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
      const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
      u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + tileDuration };
      const ang = Math.atan2(ny - u.y, nx - u.x);
      u.headingFrom = (u.headingTo ?? ang);
      u.headingTo = ang;
      u.headingStart = now; u.headingEnd = now + tileDuration;
      updateRecentTrail(u, u.x, u.y);
      u.x = nx; u.y = ny; u.lastDir = step;
      if (pm.knownFree) pm.knownFree.add(`${u.x},${u.y}`);
      console.log(`Unité ${u.id}: Exploration réussie vers (${nx}, ${ny})`);
      return { moved: true };
    } else {
      console.log(`Unité ${u.id}: Aucune direction d'exploration trouvée`);
      return { moved: false };
    }
  }
  
  // Action de déplacement vers QG ennemie [7, 20]
  if (action.length === 2 && action[0] === 7 && action[1] === 20) {
    console.log(`Unité ${u.id}: Déplacement vers QG ennemie`);
    
    // Vérifier si l'unité peut se déplacer
    if (!hasWorkingMovementModule(u)) {
      console.log(`Unité ${u.id}: Pas de module de mouvement fonctionnel`);
      return { moved: false };
    }
    
    // Vérifier d'abord si on découvre de nouveaux QG
    checkForEnemyHQDiscovery(u);
    const nearestEnemyHQ = findNearestDiscoveredEnemyHQ(u);
    if (nearestEnemyHQ) {
      console.log(`Unité ${u.id}: QG ennemie ${nearestEnemyHQ.colorKey} trouvé à (${nearestEnemyHQ.cx}, ${nearestEnemyHQ.cy})`);
      
      // Utiliser la connaissance globale pour naviguer vers QG ennemie découvert
      const stepTo = planStepToDiscoveredHQ(u, nearestEnemyHQ);
      if (stepTo) {
        console.log(`Unité ${u.id}: Chemin global trouvé vers QG ennemie découvert`);
        const now = performance.now();
        const speedModifier = getSpeedModifier(u);
        const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
        const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
        u.anim = { fromX: u.x, fromY: u.y, toX: stepTo.x, toY: stepTo.y, startTime: now, endTime: now + tileDuration };
        const ang = Math.atan2(stepTo.y - u.y, stepTo.x - u.x);
        u.headingFrom = (u.headingTo ?? ang);
        u.headingTo = ang;
        u.headingStart = now; u.headingEnd = now + tileDuration;
        updateRecentTrail(u, u.x, u.y);
        u.x = stepTo.x; u.y = stepTo.y; u.lastDir = [Math.sign(stepTo.x - u.anim.fromX), Math.sign(stepTo.y - u.anim.fromY)];
        const pm2 = state.playerMaps[u.ownerIndex]; if (pm2 && pm2.knownFree) pm2.knownFree.add(`${u.x},${u.y}`);
        return { moved: true };
      } else {
        console.log(`Unité ${u.id}: Aucun chemin connu vers QG ennemie, exploration pour le découvrir`);
        // Pas de chemin connu: explorer pour découvrir le chemin vers le QG ennemie
        const pm = state.playerMaps[u.ownerIndex];
        if (pm) {
          const k = `${u.x},${u.y}`;
          pm.visitCounts.set(k, (pm.visitCounts.get(k) || 0) + 1);
          
          // Explorer en direction générale du QG ennemie
          const dirX = nearestEnemyHQ.cx > u.x ? 1 : (nearestEnemyHQ.cx < u.x ? -1 : 0);
          const dirY = nearestEnemyHQ.cy > u.y ? 1 : (nearestEnemyHQ.cy < u.y ? -1 : 0);
          
          // Essayer d'explorer dans la direction du QG
          const exploreTargetX = u.x + dirX * 5;
          const exploreTargetY = u.y + dirY * 5;
          
          const didMove = moveTowardEnemyHQWithPlayerKnowledge(u, exploreTargetX, exploreTargetY);
          return { moved: didMove };
        }
        return { moved: false };
      }
    } else {
      console.log(`Unité ${u.id}: Aucun QG ennemie trouvé, exploration aléatoire`);
      // Fallback: explorer pour chercher des QG ennemis
      const targetX = u.x + Math.floor(Math.random() * 21) - 10; // -10 à +10
      const targetY = u.y + Math.floor(Math.random() * 21) - 10;
      const didMove = moveTowardOrExploreInline(u, targetX, targetY);
      return { moved: didMove };
    }
  }
  
  // Action de déplacement vers son propre QG [7, 18]
  if (action.length === 2 && action[0] === 7 && action[1] === 18) {
    console.log(`Unité ${u.id}: Déplacement vers son QG`);
    
    // Vérifier si l'unité peut se déplacer
    if (!hasWorkingMovementModule(u)) {
      console.log(`Unité ${u.id}: Pas de module de mouvement fonctionnel`);
      return { moved: false };
    }
    
    const myHq = state.hqs.find(h => h.colorKey === state.playerColors[u.ownerIndex]);
    if (myHq) {
      console.log(`Unité ${u.id}: Son QG ${myHq.colorKey} trouvé à (${myHq.cx}, ${myHq.cy})`);
      const didMove = moveTowardOrExploreInline(u, myHq.cx, myHq.cy);
      return { moved: didMove };
    } else {
      console.log(`Unité ${u.id}: Son QG non trouvé, exploration`);
      return executeExploreAction(u);
    }
  }
  
  console.log(`Unité ${u.id}: Action inconnue:`, action);
  return { moved: false };
}

// Trouve la cible ennemie la plus proche pour attaque à distance (portée par défaut 6)
function findNearestEnemyUnitInRange(u, maxRange = 6) {
  let nearest = null;
  let minDistance = Infinity;
  
  // Chercher parmi les unités ennemies dans la portée
  const enemies = state.units.filter(unit => unit.ownerIndex !== u.ownerIndex);
  for (const enemy of enemies) {
    const distance = Math.abs(u.x - enemy.x) + Math.abs(u.y - enemy.y);
    if (distance <= maxRange && distance < minDistance) {
      minDistance = distance;
      nearest = { type: 'unit', target: enemy, x: enemy.x, y: enemy.y };
    }
  }
  
  // Chercher parmi les QG ennemis dans la portée
  const enemyHQs = state.hqs.filter(hq => hq.colorKey !== state.playerColors[u.ownerIndex]);
  for (const hq of enemyHQs) {
    const distance = Math.abs(u.x - hq.cx) + Math.abs(u.y - hq.cy);
    console.log(`Unité ${u.id}: QG ${hq.colorKey} à (${hq.cx}, ${hq.cy}), distance ${distance}, maxRange ${maxRange}`);
    if (distance <= maxRange && distance < minDistance) {
      minDistance = distance;
      nearest = { type: 'hq', target: hq, x: hq.cx, y: hq.cy };
      console.log(`Unité ${u.id}: QG ${hq.colorKey} sélectionné comme cible à distance`);
    }
  }
  
  return nearest;
}

// Trouve la cible ennemie la plus proche (unité ou QG)
function findNearestEnemyUnit(u) {
  let nearest = null;
  let minDistance = Infinity;
  
  // Chercher parmi les unités ennemies
  const enemies = state.units.filter(unit => unit.ownerIndex !== u.ownerIndex);
  for (const enemy of enemies) {
    const distance = Math.abs(u.x - enemy.x) + Math.abs(u.y - enemy.y);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = { type: 'unit', target: enemy, x: enemy.x, y: enemy.y };
    }
  }
  
  // Chercher parmi les QG ennemis
  const enemyHQs = state.hqs.filter(hq => hq.colorKey !== state.playerColors[u.ownerIndex]);
  for (const hq of enemyHQs) {
    const distance = Math.abs(u.x - hq.cx) + Math.abs(u.y - hq.cy);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = { type: 'hq', target: hq, x: hq.cx, y: hq.cy };
    }
  }
  
  return nearest;
}

// Trouve le QG ennemie le plus proche que le joueur a découvert
function findNearestEnemyHQ(u) {
  let nearest = null;
  let minDistance = Infinity;
  
  const pm = state.playerMaps[u.ownerIndex];
  if (!pm) return null;
  
  // Chercher seulement parmi les QG ennemis dans la zone connue du joueur
  const enemyHQs = state.hqs.filter(hq => hq.colorKey !== state.playerColors[u.ownerIndex]);
  for (const hq of enemyHQs) {
    // Vérifier si le joueur a découvert cette zone (QG à portée de détection)
    let discovered = false;
    
    // Un QG est "découvert" si le joueur a exploré près de sa zone
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const checkX = hq.cx + dx;
        const checkY = hq.cy + dy;
        const key = `${checkX},${checkY}`;
        if (pm.knownFree && pm.knownFree.has(key)) {
          discovered = true;
          break;
        }
      }
      if (discovered) break;
    }
    
    if (discovered) {
      const distance = Math.abs(u.x - hq.cx) + Math.abs(u.y - hq.cy);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = hq;
      }
    }
  }
  
  return nearest;
}

// Vérifie si l'unité découvre de nouveaux QG ennemis à proximité
function checkForEnemyHQDiscovery(u) {
  const pm = state.playerMaps[u.ownerIndex];
  if (!pm) {
    console.log(`DEBUG: Pas de playerMap pour unité ${u.id} (ownerIndex: ${u.ownerIndex})`);
    return;
  }
  
  const enemyHQs = state.hqs.filter(hq => hq.colorKey !== state.playerColors[u.ownerIndex]);
  for (const hq of enemyHQs) {
    // Distance de découverte : 5 cases autour du QG
    const distance = Math.abs(u.x - hq.cx) + Math.abs(u.y - hq.cy);
    
    if (distance <= 5) {
      const hqKey = `${hq.colorKey}_${hq.cx}_${hq.cy}`;
      if (!pm.discoveredEnemyHQs.has(hqKey)) {
        pm.discoveredEnemyHQs.add(hqKey);
        console.log(`🎯 QG ennemie ${hq.colorKey} découvert à (${hq.cx}, ${hq.cy}) par unité ${u.id}!`);
      }
    }
  }
}

// Planifie un déplacement vers un QG découvert en utilisant la connaissance globale
function planStepToDiscoveredHQ(u, hq) {
  console.log(`DEBUG planStepToDiscoveredHQ: Unité ${u.id} à (${u.x}, ${u.y}) vers QG à (${hq.cx}, ${hq.cy})`);
  
  // Vérifier si l'unité est déjà au périmètre du QG
  if (isAtHQPerimeter(u.x, u.y, hq)) {
    console.log(`DEBUG: Unité ${u.id} déjà au périmètre du QG`);
    return null;
  }
  
  // Trouver la case la plus proche du périmètre du QG
  let targetX = hq.cx, targetY = hq.cy;
  let minDistance = Infinity;
  
  // Chercher autour du périmètre du QG
  for (let dx = -HQ_PERIM_RADIUS; dx <= HQ_PERIM_RADIUS; dx++) {
    for (let dy = -HQ_PERIM_RADIUS; dy <= HQ_PERIM_RADIUS; dy++) {
      const px = hq.cx + dx;
      const py = hq.cy + dy;
      
      // Vérifier si c'est au périmètre et accessible
      const distToHQ = Math.abs(dx) + Math.abs(dy);
      if (distToHQ === HQ_PERIM_RADIUS && !isHQCell(px, py) && isInBounds(px, py) && !(state.tiles[py] && state.tiles[py][px])) {
        const distToUnit = Math.abs(u.x - px) + Math.abs(u.y - py);
        if (distToUnit < minDistance) {
          minDistance = distToUnit;
          targetX = px;
          targetY = py;
        }
      }
    }
  }
  
  console.log(`DEBUG: Cible périmètre trouvée à (${targetX}, ${targetY}), distance: ${minDistance}`);
  
  // Utilise la carte globale (state.tiles) pour les QG découverts
  const startKey = `${u.x},${u.y}`;
  const goalKey = `${targetX},${targetY}`;

  // Fonction qui utilise la connaissance globale de la carte
  const isGloballyWalkable = (x, y) => {
    if (!isInBounds(x, y)) return false;
    if (isHQCell(x, y)) return false; // Aucune cellule HQ n'est traversable
    if (state.tiles[y] && state.tiles[y][x]) return false; // Mur global
    return true;
  };

  console.log(`DEBUG: Position de départ (${u.x}, ${u.y}) walkable: ${isGloballyWalkable(u.x, u.y)}`);
  console.log(`DEBUG: Position cible (${targetX}, ${targetY}) walkable: ${isGloballyWalkable(targetX, targetY)}`);
  
  if (!isGloballyWalkable(u.x, u.y)) {
    console.log(`DEBUG: Position de départ non walkable`);
    return null;
  }
  
  if (!isGloballyWalkable(targetX, targetY)) {
    console.log(`DEBUG: Position cible non walkable`);
    return null;
  }

  // A* avec carte globale
  const openSet = new Set([startKey]);
  const cameFrom = new Map();
  const gScore = new Map();
  const fScore = new Map();

  gScore.set(startKey, 0);
  fScore.set(startKey, Math.abs(u.x - targetX) + Math.abs(u.y - targetY));

  while (openSet.size > 0) {
    let current = null;
    let lowestF = Infinity;
    for (const key of openSet) {
      const f = fScore.get(key) || Infinity;
      if (f < lowestF) {
        lowestF = f;
        current = key;
      }
    }

    if (!current) break;
    openSet.delete(current);

    if (current === goalKey) {
      // Reconstruire le chemin
      const path = [];
      let temp = current;
      while (cameFrom.has(temp)) {
        const [x, y] = temp.split(',').map(Number);
        path.unshift({ x, y });
        temp = cameFrom.get(temp);
      }
      return path.length > 0 ? path[0] : null;
    }

    const [cx, cy] = current.split(',').map(Number);
    const neighbors = [
      [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
      [cx + 1, cy + 1], [cx + 1, cy - 1], [cx - 1, cy + 1], [cx - 1, cy - 1]
    ];

    for (const [nx, ny] of neighbors) {
      if (!isGloballyWalkable(nx, ny)) continue;
      if (unitAt(nx, ny)) continue;

      const neighborKey = `${nx},${ny}`;
      const tentativeG = (gScore.get(current) || 0) + 1;

      if (!gScore.has(neighborKey) || tentativeG < gScore.get(neighborKey)) {
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentativeG);
        const h = Math.abs(nx - targetX) + Math.abs(ny - targetY);
        fScore.set(neighborKey, tentativeG + h);
        openSet.add(neighborKey);
      }
    }
  }

  console.log(`DEBUG: Aucun chemin A* trouvé de (${u.x}, ${u.y}) vers (${targetX}, ${targetY})`);
  return null; // Aucun chemin trouvé
}

// Exploration systématique pour éviter de tourner en rond
function exploreSystematically(u) {
  const pm = state.playerMaps[u.ownerIndex];
  if (!pm) return false;
  
  console.log(`Unité ${u.id}: Exploration systématique depuis (${u.x}, ${u.y})`);
  
  // 1. Diviser la carte en secteurs et explorer le secteur le moins visité
  const sectorSize = 16; // Taille de chaque secteur
  const sectorsX = Math.ceil(state.mapCols / sectorSize);
  const sectorsY = Math.ceil(state.mapRows / sectorSize);
  
  // Calculer le secteur actuel
  const currentSectorX = Math.floor(u.x / sectorSize);
  const currentSectorY = Math.floor(u.y / sectorSize);
  
  console.log(`DEBUG: Secteur actuel (${currentSectorX}, ${currentSectorY})`);
  
  // Compter les visites par secteur
  const sectorVisits = {};
  for (const [key, count] of pm.visitCounts.entries()) {
    const [x, y] = key.split(',').map(Number);
    const sx = Math.floor(x / sectorSize);
    const sy = Math.floor(y / sectorSize);
    const sectorKey = `${sx},${sy}`;
    sectorVisits[sectorKey] = (sectorVisits[sectorKey] || 0) + count;
  }
  
  // Trouver le secteur le moins visité accessible
  let targetSectorX = currentSectorX;
  let targetSectorY = currentSectorY;
  let minVisits = Infinity;
  
  // Vérifier si on reste trop longtemps dans le même secteur
  const currentSectorKey = `${currentSectorX},${currentSectorY}`;
  const currentSectorVisits = sectorVisits[currentSectorKey] || 0;
  const forceDistantExploration = currentSectorVisits > 20; // Si plus de 20 visites dans le secteur actuel
  
  console.log(`DEBUG: Secteur actuel visites: ${currentSectorVisits}, forcer exploration lointaine: ${forceDistantExploration}`);
  
  for (let sx = 0; sx < sectorsX; sx++) {
    for (let sy = 0; sy < sectorsY; sy++) {
      const sectorKey = `${sx},${sy}`;
      const visits = sectorVisits[sectorKey] || 0;
      
      // Priorité aux secteurs non visités ou peu visités
      if (visits < minVisits) {
        // Forcer l'exploration loin du secteur actuel
        const distance = Math.abs(sx - currentSectorX) + Math.abs(sy - currentSectorY);
        
        // Pour les secteurs jamais visités, accepter distance >= 2
        // Pour les secteurs peu visités, exiger distance >= 3 pour forcer l'exploration lointaine
        // Si on force l'exploration lointaine, exiger distance >= 4
        let minDistance = visits === 0 ? 2 : 3;
        if (forceDistantExploration) minDistance = Math.max(minDistance, 4);
        
        if (distance >= minDistance) {
          minVisits = visits;
          targetSectorX = sx;
          targetSectorY = sy;
          console.log(`DEBUG: Nouveau secteur candidat (${sx}, ${sy}) distance: ${distance}, visites: ${visits}`);
        }
      }
    }
  }
  
  // Calculer le centre du secteur cible
  const targetCenterX = targetSectorX * sectorSize + sectorSize / 2;
  const targetCenterY = targetSectorY * sectorSize + sectorSize / 2;
  
  console.log(`DEBUG: Secteur cible (${targetSectorX}, ${targetSectorY}) visites: ${minVisits}, centre: (${targetCenterX}, ${targetCenterY})`);
  
  // 2. Se diriger vers ce secteur en utilisant l'exploration directionnelle
  const dirX = targetCenterX > u.x ? 1 : (targetCenterX < u.x ? -1 : 0);
  const dirY = targetCenterY > u.y ? 1 : (targetCenterY < u.y ? -1 : 0);
  
  console.log(`DEBUG: Position actuelle (${u.x}, ${u.y}), centre cible (${targetCenterX}, ${targetCenterY})`);
  
  console.log(`DEBUG: Direction générale vers secteur: (${dirX}, ${dirY})`);
  
  // 3. Chercher une case libre dans cette direction générale
  const directions = [
    [dirX, dirY], // Direction principale
    [dirX, 0], [0, dirY], // Directions secondaires
    [dirX, -dirY], [-dirX, dirY], // Directions diagonales alternatives
    [-dirX, -dirY], [1, 0], [-1, 0], [0, 1], [0, -1] // Fallback toutes directions
  ];
  
  for (const [dx, dy] of directions) {
    const nx = u.x + dx;
    const ny = u.y + dy;
    
    console.log(`DEBUG: Test direction (${dx}, ${dy}) vers (${nx}, ${ny})`);
    
    if (!isInBounds(nx, ny)) {
      console.log(`DEBUG: (${nx}, ${ny}) hors limites`);
      continue;
    }
    
    if (unitAt(nx, ny)) {
      console.log(`DEBUG: (${nx}, ${ny}) occupée par une unité`);
      continue;
    }
    
    // Vérifier si c'est un mur ou une case de QG
    if (state.tiles[ny] && state.tiles[ny][nx]) {
      console.log(`DEBUG: (${nx}, ${ny}) est un mur`);
      if (pm.knownWalls) pm.knownWalls.add(`${nx},${ny}`);
      continue;
    }
    
    // Vérifier si c'est une case de QG (non franchissable)
    if (isHQCell(nx, ny)) {
      console.log(`DEBUG: (${nx}, ${ny}) est une case QG, éviter`);
      continue;
    }
    
    // Éviter de revenir sur les dernières cases visitées
    const key = `${nx},${ny}`;
    if (u.recentTrail && u.recentTrail.includes(key)) {
      console.log(`DEBUG: (${nx}, ${ny}) dans recentTrail:`, u.recentTrail);
      continue;
    }
    
    // Effectuer le mouvement
    console.log(`Unité ${u.id}: Exploration systématique vers (${nx}, ${ny}) avec direction (${dx}, ${dy})`);
    
    const now = performance.now();
    const speedModifier = getSpeedModifier(u);
    const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
    const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
    
    u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + tileDuration };
    const ang = Math.atan2(ny - u.y, nx - u.x);
    u.headingFrom = (u.headingTo ?? ang);
    u.headingTo = ang;
    u.headingStart = now; u.headingEnd = now + tileDuration;
    
    updateRecentTrail(u, u.x, u.y);
    u.x = nx; u.y = ny;
    u.lastDir = [dx, dy];
    
    // Mettre à jour les connaissances
    if (pm.knownFree) pm.knownFree.add(`${nx},${ny}`);
    if (pm.visitCounts) pm.visitCounts.set(`${nx},${ny}`, (pm.visitCounts.get(`${nx},${ny}`) || 0) + 1);
    
    return true;
  }
  
  console.log(`Unité ${u.id}: Aucune direction libre trouvée, essai avec backtracking autorisé`);
  
  // SECOURS: Si complètement bloqué, autoriser le backtracking (ignorer recentTrail)
  for (const [dx, dy] of directions) {
    const nx = u.x + dx;
    const ny = u.y + dy;
    
    console.log(`DEBUG SECOURS: Test direction (${dx}, ${dy}) vers (${nx}, ${ny}) sans restriction trail`);
    
    if (!isInBounds(nx, ny)) {
      console.log(`DEBUG SECOURS: (${nx}, ${ny}) hors limites`);
      continue;
    }
    
    if (unitAt(nx, ny)) {
      console.log(`DEBUG SECOURS: (${nx}, ${ny}) occupée par une unité`);
      continue;
    }
    
    // Vérifier si c'est un mur
    if (state.tiles[ny] && state.tiles[ny][nx]) {
      console.log(`DEBUG SECOURS: (${nx}, ${ny}) est un mur`);
      continue;
    }
    
    // Vérifier si c'est une case de QG (non franchissable)
    if (isHQCell(nx, ny)) {
      console.log(`DEBUG SECOURS: (${nx}, ${ny}) est une case QG, éviter`);
      continue;
    }
    
    // IGNORER recentTrail pour le secours !
    console.log(`Unité ${u.id}: Exploration secours (backtracking) vers (${nx}, ${ny})`);
    
    const now = performance.now();
    const speedModifier = getSpeedModifier(u);
    const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
    const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
    
    u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + tileDuration };
    const ang = Math.atan2(ny - u.y, nx - u.x);
    u.headingFrom = (u.headingTo ?? ang);
    u.headingTo = ang;
    u.headingStart = now; u.headingEnd = now + tileDuration;
    
    updateRecentTrail(u, u.x, u.y);
    u.x = nx; u.y = ny;
    u.lastDir = [dx, dy];
    
    // Mettre à jour les connaissances
    if (pm.knownFree) pm.knownFree.add(`${nx},${ny}`);
    if (pm.visitCounts) pm.visitCounts.set(`${nx},${ny}`, (pm.visitCounts.get(`${nx},${ny}`) || 0) + 1);
    
    return true;
  }
  
  console.log(`Unité ${u.id}: Aucune direction d'exploration systématique trouvée même avec backtracking`);
  return false;
}

// Trouve le QG ennemie le plus proche découvert par l'équipe
function findNearestDiscoveredEnemyHQ(u) {
  const pm = state.playerMaps[u.ownerIndex];
  if (!pm) {
    console.log(`DEBUG findNearestDiscoveredEnemyHQ: Pas de playerMap pour unité ${u.id} (ownerIndex: ${u.ownerIndex})`);
    return null;
  }
  
  console.log(`DEBUG findNearestDiscoveredEnemyHQ: Unité ${u.id} (joueur ${u.ownerIndex}) cherche QG découverts`);
  console.log(`DEBUG: QGs découverts par joueur ${u.ownerIndex}:`, Array.from(pm.discoveredEnemyHQs));
  
  let nearest = null;
  let minDistance = Infinity;
  
  const enemyHQs = state.hqs.filter(hq => hq.colorKey !== state.playerColors[u.ownerIndex]);
  console.log(`DEBUG: ${enemyHQs.length} QGs ennemis au total`);
  
  for (const hq of enemyHQs) {
    const hqKey = `${hq.colorKey}_${hq.cx}_${hq.cy}`;
    console.log(`DEBUG: Vérification QG ${hqKey}, découvert: ${pm.discoveredEnemyHQs.has(hqKey)}`);
    if (pm.discoveredEnemyHQs.has(hqKey)) {
      const distance = Math.abs(u.x - hq.cx) + Math.abs(u.y - hq.cy);
      console.log(`DEBUG: QG découvert ${hqKey}, distance: ${distance}`);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = hq;
      }
    }
  }
  
  console.log(`DEBUG: QG le plus proche trouvé:`, nearest ? `${nearest.colorKey} à (${nearest.cx}, ${nearest.cy})` : 'aucun');
  return nearest;
}

// Calcule les dégâts d'attaque basés sur les modules d'attaque
function calculateAttackDamage(u, isRanged = false) {
  if (!u.modules || u.modules.length === 0) {
    console.log(`Unité ${u.id}: Aucun module`);
    return 0;
  }
  
  if (isRanged) {
    const rangedAttackModules = u.modules.filter(m => m.type === 'ranged_attack' && m.hp > 0);
    console.log(`Unité ${u.id}: ${rangedAttackModules.length} modules d'attaque à distance fonctionnels`);
    return rangedAttackModules.length * 10; // 10 dégâts par module d'attaque à distance
  } else {
    const attackModules = u.modules.filter(m => m.type === 'attack' && m.hp > 0);
    console.log(`Unité ${u.id}: ${attackModules.length} modules d'attaque C.A.C fonctionnels`);
    return attackModules.length * 30; // 30 dégâts par module d'attaque C.A.C
  }
}

// Applique des dégâts à un QG
function damageHQ(hq, damage) {
  if (!hq) return;
  
  const oldHp = hq.hp || 0;
  hq.hp = Math.max(0, oldHp - damage);
  
  console.log(`QG ${hq.colorKey} : ${oldHp} -> ${hq.hp} HP (${damage} dégâts)`);
  
  // Mettre à jour l'affichage si c'est le QG du joueur actuel
  if (hq.colorKey === state.playerColors[state.currentPlayerIndex]) {
    updateHqHpLine();
  }
  
  // Si le QG est détruit, créer une grosse explosion et le supprimer
  if (hq.hp <= 0) {
    const frenchColor = translateColorToFrench(hq.colorKey);
    console.log(`💥 QG ${frenchColor} détruit !`);
    
    // Créer une grosse explosion au centre du QG
    createHQExplosion(hq.cx, hq.cy);
    
    // Détruire toutes les unités et bâtiments de ce joueur
    destroyPlayerUnitsAndBuildings(hq.colorKey);
    
    // Supprimer le QG de la liste
    const hqIndex = state.hqs.findIndex(h => h.colorKey === hq.colorKey);
    if (hqIndex !== -1) {
      state.hqs.splice(hqIndex, 1);
      console.log(`QG ${frenchColor} retiré de la carte`);
    }
    
    // Vérifier condition de victoire
    checkVictoryCondition();
    
    // Redessiner la scène
    const canvas = q('#game');
    if (canvas) drawScene(canvas);
  }
}

// Détruit toutes les unités et bâtiments d'un joueur
function destroyPlayerUnitsAndBuildings(colorKey) {
  const frenchColor = translateColorToFrench(colorKey);
  console.log(`🔥 Destruction de toutes les unités et bâtiments ${frenchColor}`);
  
  // Trouver l'index du joueur par sa couleur
  const playerIndex = state.playerColors.indexOf(colorKey);
  if (playerIndex === -1) {
    console.log(`Erreur: Couleur ${frenchColor} non trouvée`);
    return;
  }
  
  // Détruire toutes les unités de ce joueur
  const unitsToDestroy = state.units.filter(u => u.ownerIndex === playerIndex);
  console.log(`Destruction de ${unitsToDestroy.length} unités ${frenchColor}`);
  
  unitsToDestroy.forEach(unit => {
    // Créer une petite explosion pour chaque unité détruite
    createAttackExplosion(unit.x, unit.y);
    console.log(`💀 Unité ${unit.id} (${frenchColor}) détruite`);
  });
  
  // Retirer toutes les unités de ce joueur
  state.units = state.units.filter(u => u.ownerIndex !== playerIndex);
  
  // TODO: Ajouter destruction d'autres bâtiments si nécessaire (usines, etc.)
  
  console.log(`✅ Tous les éléments ${frenchColor} ont été détruits`);
}

// Vérifie la condition de victoire et affiche le message si quelqu'un a gagné
function checkVictoryCondition() {
  console.log(`🏆 Vérification condition de victoire...`);
  console.log(`QGs restants: ${state.hqs.length}`);
  
  if (state.hqs.length <= 1) {
    // Fin de partie !
    if (state.hqs.length === 1) {
      // Un seul QG restant = victoire
      const winnerHQ = state.hqs[0];
      const winnerColor = winnerHQ.colorKey;
      const frenchColor = translateColorToFrench(winnerColor);
      console.log(`🎉 Victoire du joueur ${frenchColor} !`);
      displayVictoryMessage(winnerColor);
    } else {
      // Aucun QG restant = match nul (cas improbable)
      console.log(`⚖️ Match nul - aucun QG restant`);
      displayVictoryMessage(null);
    }
    
    // Arrêter la simulation
    stopSimulation();
  } else {
    console.log(`⏳ Partie continue - ${state.hqs.length} QGs restants`);
  }
}

// Traduit les couleurs anglaises vers le français
function translateColorToFrench(englishColor) {
  const colorTranslations = {
    'blue': 'bleu',
    'red': 'rouge', 
    'green': 'vert',
    'purple': 'violet'
  };
  
  return colorTranslations[englishColor] || englishColor;
}

// Affiche le message de victoire
function displayVictoryMessage(winnerColor) {
  // Créer ou trouver la div de message de victoire
  let victoryDiv = q('#victory-message');
  
  if (!victoryDiv) {
    victoryDiv = document.createElement('div');
    victoryDiv.id = 'victory-message';
    victoryDiv.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 30px 50px;
      border-radius: 15px;
      font-size: 24px;
      font-weight: bold;
      text-align: center;
      border: 3px solid #gold;
      box-shadow: 0 0 20px rgba(255, 215, 0, 0.5);
      z-index: 1000;
      font-family: Arial, sans-serif;
    `;
    document.body.appendChild(victoryDiv);
  }
  
  if (winnerColor) {
    const frenchColor = translateColorToFrench(winnerColor);
    victoryDiv.innerHTML = `
      <div style="font-size: 32px; margin-bottom: 15px;">🏆 VICTOIRE ! 🏆</div>
      <div style="font-size: 24px; color: ${winnerColor};">
        Félicitations au joueur <strong style="text-transform: uppercase;">${frenchColor}</strong> !
      </div>
      <div style="font-size: 16px; margin-top: 20px; opacity: 0.8;">
        Vous avez conquis tous les QGs ennemis !
      </div>
    `;
  } else {
    victoryDiv.innerHTML = `
      <div style="font-size: 32px; margin-bottom: 15px;">⚖️ MATCH NUL ⚖️</div>
      <div style="font-size: 20px;">
        Tous les QGs ont été détruits simultanément !
      </div>
    `;
  }
  
  victoryDiv.style.display = 'block';
}

// Arrête la simulation de jeu
function stopSimulation() {
  console.log(`⏹️ Arrêt de la simulation - Partie terminée`);
  
  // Arrêter la boucle d'animation si elle existe
  if (window.gameAnimationId) {
    cancelAnimationFrame(window.gameAnimationId);
    window.gameAnimationId = null;
  }
  
  // Désactiver les contrôles de jeu
  const stepButton = q('#step-btn');
  const playButton = q('#play-btn');
  
  if (stepButton) stepButton.disabled = true;
  if (playButton) playButton.disabled = true;
  
  console.log(`✅ Simulation arrêtée avec succès`);
}

// Déplace une unité vers une cible
function moveTowardTarget(u, targetX, targetY) {
  if (!hasWorkingMovementModule(u)) return false;
  
  const moved = moveTowardOrExploreInline(u, targetX, targetY);
  return moved;
}

// Exécute l'action d'exploration
function executeExploreAction(u) {
  const pm = state.playerMaps[u.ownerIndex];
  if (!pm) return { moved: false };
  
  const k = `${u.x},${u.y}`;
  pm.visitCounts.set(k, (pm.visitCounts.get(k) || 0) + 1);
  
  // Utiliser la logique d'exploration existante simplifiée
  const dirs = [ [1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1] ];
  let bestMove = null;
  let bestScore = Infinity;
  
  for (const d of dirs) {
    const nx = u.x + d[0];
    const ny = u.y + d[1];
    if (!isInBounds(nx, ny)) continue;
    if (isBlocked(nx, ny)) continue;
    if (unitAt(nx, ny)) continue;
    
    const key = `${nx},${ny}`;
    if (u.recentTrail && u.recentTrail.includes(key)) continue;
    
    const visits = (pm.visitCounts.get(key) || 0);
    if (visits < bestScore) {
      bestScore = visits;
      bestMove = d;
    }
  }
  
  if (bestMove) {
    const nx = u.x + bestMove[0];
    const ny = u.y + bestMove[1];
    const now = performance.now();
    const speedModifier = getSpeedModifier(u);
    const baseDuration = Math.max(120, Math.floor(1000 / state.unitSpeedTilesPerSec));
    const tileDuration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
    u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + tileDuration };
    const ang = Math.atan2(ny - u.y, nx - u.x);
    u.headingFrom = (u.headingTo ?? ang);
    u.headingTo = ang;
    u.headingStart = now; u.headingEnd = now + tileDuration;
    updateRecentTrail(u, u.x, u.y);
    u.x = nx; u.y = ny; u.lastDir = bestMove;
    if (pm.knownFree) pm.knownFree.add(`${u.x},${u.y}`);
    return { moved: true };
  }
  
  return { moved: false };
}

// Planifie un pas vers le QG en utilisant la cartographie partagée (connue du joueur).
// Utilise un A* sur les cases connues libres (knownFree) et non-murs connus (pas dans knownWalls),
// avec heuristique manhattan vers le QG. Si aucun chemin connu, retourne null.
function planStepToHQUsingSharedMap(u, hq) {
  const pm = state.playerMaps[u.ownerIndex];
  if (!pm) return null;
  const knownFree = pm.knownFree || new Set();
  const knownWalls = pm.knownWalls || new Set();
  const startKey = `${u.x},${u.y}`;
  const goalKey = `${hq.cx},${hq.cy}`;

  // Les unités ne peuvent jamais traverser les cellules des QG, même pour aller au centre
  const isKnownWalkable = (x, y) => {
    if (!isInBounds(x, y)) return false;
    // Utiliser seulement la connaissance du joueur (pas la carte globale)
    const key = `${x},${y}`;
    if (knownWalls.has(key)) return false; // Mur connu par ce joueur
    if (isHQCell(x, y)) return false; // Aucune cellule HQ n'est traversable
    // Si la case n'est pas dans knownFree ET pas explorée, on peut pas la traverser
    if (!knownFree.has(key)) return false; // Case non explorée par ce joueur
    return true;
  };

  if (!isKnownWalkable(u.x, u.y)) return null;

  const neighbors = (x, y) => {
    const dirs = [ [1,0], [-1,0], [0,1], [0,-1] ];
    const arr = [];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (!isKnownWalkable(nx, ny)) continue;
      if (unitAt(nx, ny)) continue;
      arr.push({ x: nx, y: ny });
    }
    return arr;
  };

  // Heuristique: distance vers le périmètre du QG (pas le centre)
  const h = (x, y) => {
    // Distance vers le bord le plus proche du périmètre HQ
    const dx = Math.max(0, Math.abs(x - hq.cx) - HQ_PERIM_RADIUS);
    const dy = Math.max(0, Math.abs(y - hq.cy) - HQ_PERIM_RADIUS);
    return dx + dy;
  };

  const open = new MinHeap((a, b) => a.f - b.f);
  const gScore = new Map();
  const fScore = new Map();
  const came = new Map();
  const pushNode = (x, y, g, f, parentKey) => {
    const k = `${x},${y}`;
    if (gScore.has(k) && g >= gScore.get(k)) return;
    gScore.set(k, g); fScore.set(k, f); if (parentKey) came.set(k, parentKey);
    open.push({ x, y, f });
  };
  pushNode(u.x, u.y, 0, h(u.x, u.y), null);

  const closed = new Set();
  let foundKey = null;
  while (!open.isEmpty()) {
    const cur = open.pop();
    const ck = `${cur.x},${cur.y}`;
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (isAtHQPerimeter(cur.x, cur.y, hq)) { foundKey = ck; break; }
    for (const nb of neighbors(cur.x, cur.y)) {
      const nk = `${nb.x},${nb.y}`;
      if (closed.has(nk)) continue;
      const tentativeG = (gScore.get(ck) || 0) + 1;
      pushNode(nb.x, nb.y, tentativeG, tentativeG + h(nb.x, nb.y), ck);
    }
  }
  if (!foundKey) return null;
  // remonte un seul pas
  let curKey = foundKey;
  let prevKey = came.get(curKey);
  if (!prevKey) return null;
  while (came.get(prevKey) && prevKey !== startKey) {
    curKey = prevKey;
    prevKey = came.get(prevKey);
  }
  const [sx, sy] = curKey.split(',').map(n => parseInt(n, 10));
  return { x: sx, y: sy };
}

// Min-heap simple pour A*
class MinHeap {
  constructor(compare) { this.compare = compare; this.arr = []; }
  isEmpty() { return this.arr.length === 0; }
  push(v) { this.arr.push(v); this._up(this.arr.length - 1); }
  pop() {
    if (this.arr.length === 1) return this.arr.pop();
    const top = this.arr[0];
    this.arr[0] = this.arr.pop();
    this._down(0);
    return top;
  }
  _up(i) {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.compare(this.arr[i], this.arr[p]) >= 0) break;
      [this.arr[i], this.arr[p]] = [this.arr[p], this.arr[i]];
      i = p;
    }
  }
  _down(i) {
    const n = this.arr.length;
    while (true) {
      let l = i * 2 + 1, r = i * 2 + 2, m = i;
      if (l < n && this.compare(this.arr[l], this.arr[m]) < 0) m = l;
      if (r < n && this.compare(this.arr[r], this.arr[m]) < 0) m = r;
      if (m === i) break;
      [this.arr[i], this.arr[m]] = [this.arr[m], this.arr[i]];
      i = m;
    }
  }
}

// Cherche un "pont" jusqu'à la zone connue (knownFree) la plus proche, puis un pas dans sa direction.
function planStepBridgeToKnownThenHQ(u, hq) {
  // Avec connaissance globale, ce pont n'est plus requis; on fait un BFS vers la cible pour un pas robuste.
  const startKey = `${u.x},${u.y}`;
  const ql = [{ x: u.x, y: u.y }];
  const prev = new Map(); prev.set(startKey, null);
  const seen = new Set([startKey]);
  const dirs = [ [1,0], [-1,0], [0,1], [0,-1] ];
  let endKey = null;
  while (ql.length) {
    const cur = ql.shift();
    if (cur.x === hq.cx && cur.y === hq.cy) { endKey = `${cur.x},${cur.y}`; break; }
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const nk = `${nx},${ny}`;
      if (seen.has(nk)) continue;
      if (!isInBounds(nx, ny)) continue;
      if (state.tiles[ny][nx]) continue; // mur réel
      if (unitAt(nx, ny)) continue;
      seen.add(nk); prev.set(nk, `${cur.x},${cur.y}`); ql.push({ x: nx, y: ny });
    }
  }
  if (!endKey) return null;
  // remonte un seul pas depuis la position actuelle
  let curKey = endKey;
  let parent = prev.get(curKey);
  if (!parent) return null;
  while (prev.get(parent) && parent !== startKey) {
    curKey = parent; parent = prev.get(parent);
  }
  const [sx, sy] = curKey.split(',').map(n => parseInt(n, 10));
  return { x: sx, y: sy };
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

// Remplit la connaissance de carte globale pour chaque joueur (toutes cases connues)
function populateFullMapKnowledge() {
  if (!state.tiles || !state.rows || !state.cols || !state.playerMaps) return;
  for (let p = 0; p < state.players; p++) {
    const pm = state.playerMaps[p];
    if (!pm) continue;
    pm.knownFree = pm.knownFree || new Set();
    pm.knownWalls = pm.knownWalls || new Set();
    pm.knownFree.clear();
    pm.knownWalls.clear();
    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        if (state.tiles[y][x]) {
          pm.knownWalls.add(`${x},${y}`);
        } else if (isHQCell(x, y)) {
          // Les cellules des QG sont considérées comme des murs (infranchissables)
          pm.knownWalls.add(`${x},${y}`);
        } else {
          pm.knownFree.add(`${x},${y}`);
        }
      }
    }
  }
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

  // Dessin des unités d'abord (sous le QG)
  for (const u of state.units) {
    drawUnit(ctx, u, tile, ox, oy);
  }

  // Dessin des QG par-dessus les unités (unités apparaissent sous l'image du QG)
  if (state.hqs && state.hqs.length) {
    for (const hq of state.hqs) {
      drawHQ(ctx, hq, tile, ox, oy);
    }
  }

  // Dessiner les explosions par-dessus tout
  drawExplosions(ctx, tile, ox, oy);

  ctx.restore();
}

// Boucle d'animation UI pour effets visuels (ondulation énergie)
let uiAnimRafId = null;
function startUiAnimationLoop() {
  if (uiAnimRafId) cancelAnimationFrame(uiAnimRafId);
  const canvas = q('#game');
  if (!canvas) return;
  const tick = () => {
    // Redessine périodiquement pour animer l'onde
    drawScene(canvas);
    uiAnimRafId = requestAnimationFrame(tick);
  };
  uiAnimRafId = requestAnimationFrame(tick);
}

function drawExplosions(ctx, tile, ox, oy) {
  const now = performance.now();
  
  // Nettoyer les explosions terminées
  state.explosions = state.explosions.filter(explosion => {
    const elapsed = now - explosion.startTime;
    return elapsed < explosion.duration;
  });
  
  // Nettoyer les lasers inactifs (plus de portée ou cible détruite)
  cleanupActiveLasers();
  
  // Dessiner les lasers actifs
  drawActiveLasers(ctx, tile, ox, oy);
  
  // Dessiner chaque explosion active
  for (const explosion of state.explosions) {
    const elapsed = now - explosion.startTime;
    const progress = elapsed / explosion.duration; // 0.0 à 1.0
    
    if (explosion.type === 'laser') {
      // Rendu spécial pour les lasers
      const fromX = ox + explosion.fromX * tile + tile / 2;
      const fromY = oy + explosion.fromY * tile + tile / 2;
      const toX = ox + explosion.toX * tile + tile / 2;
      const toY = oy + explosion.toY * tile + tile / 2;
      
      ctx.save();
      
      // Couleur du laser basée sur la couleur du joueur
      const playerColor = colorFromKey(explosion.playerColor);
      
      // Effet de fondu (apparition puis disparition)
      const alpha = progress < 0.3 ? progress / 0.3 : (1 - progress) / 0.7;
      
      // Dessiner le laser principal
      ctx.strokeStyle = playerColor;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(toX, toY);
      ctx.stroke();
      
      // Effet de lueur
      ctx.shadowColor = playerColor;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 1;
      ctx.globalAlpha = alpha * 0.5;
      
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(toX, toY);
      ctx.stroke();
      
      ctx.restore();
      continue;
    }
    
    // Rendu normal pour les explosions
    const centerX = ox + explosion.tileX * tile + tile / 2;
    const centerY = oy + explosion.tileY * tile + tile / 2;
    
    ctx.save();
    
    // Mettre à jour et dessiner chaque particule
    for (const particle of explosion.particles) {
      // Mise à jour de la position
      particle.x += particle.vx * tile * 0.03; // Vitesse adaptée au tile
      particle.y += particle.vy * tile * 0.03;
      particle.life = 1.0 - progress; // Diminue avec le temps
      
      if (particle.life > 0) {
        // Position de la particule
        const px = centerX + particle.x;
        const py = centerY + particle.y;
        
        // Taille et opacité basées sur la vie restante
        const size = Math.max(1, tile * 0.15 * particle.life);
        const alpha = particle.life * 0.8;
        
        // Couleur de l'explosion (orange/rouge)
        const red = Math.floor(255 * Math.min(1, particle.life + 0.5));
        const green = Math.floor(200 * particle.life);
        const blue = 0;
        
        ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fill();
        
        // Ajouter un petit halo
        if (particle.life > 0.5) {
          ctx.fillStyle = `rgba(255, 255, 100, ${alpha * 0.3})`;
          ctx.beginPath();
          ctx.arc(px, py, size * 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    
    ctx.restore();
  }
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
    ensureOpenHQClearance(near.x, near.y, 2); // garantit 2 cases de sol autour du QG
    result.push({ cx: near.x, cy: near.y, colorKey: state.playerColors[i], hp: 1000, hpMax: 1000, energy: 900, energyMax: 1000 });
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
  for (let y = cy - HQ_BLOCK_HALF_SPAN; y <= cy + HQ_BLOCK_HALF_SPAN; y++) {
    for (let x = cx - HQ_BLOCK_HALF_SPAN; x <= cx + HQ_BLOCK_HALF_SPAN; x++) {
      if (y > 0 && y < state.rows - 1 && x > 0 && x < state.cols - 1) state.tiles[y][x] = false;
    }
  }
}

// Ouvre une couronne de "clearance" autour du QG pour éviter tout blocage des sorties
function ensureOpenHQClearance(cx, cy, clearanceTiles = 2) {
  // Ouvre une CROIX (N/E/S/O) autour du centre du QG,
  // jusqu'à HQ_HALF_SPAN + clearanceTiles cases depuis le centre.
  const maxSpan = HQ_HALF_SPAN + Math.max(1, clearanceTiles);
  for (let r = 1; r <= maxSpan; r++) {
    // vers le nord
    if (cy - r > 0 && cy - r < state.rows - 1) state.tiles[cy - r][cx] = false;
    // vers le sud
    if (cy + r > 0 && cy + r < state.rows - 1) state.tiles[cy + r][cx] = false;
    // vers l'ouest
    if (cx - r > 0 && cx - r < state.cols - 1) state.tiles[cy][cx - r] = false;
    // vers l'est
    if (cx + r > 0 && cx + r < state.cols - 1) state.tiles[cy][cx + r] = false;
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
  const baseColor = colorFromKey(hq.colorKey);

  if (img && img.complete && img.naturalWidth > 0) {
    // Jauges derrière l'image, visibles via les ouvertures
    drawHQHalo(ctx, cx, cy, size, baseColor);
    drawHQEnergyBar(ctx, hq, tile, cx, cy, size);
    drawHQHealthBar(ctx, hq, tile, cx, cy, size, 'hole');
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
    return;
  }

  // Fallback minimal si l'image n'est pas prête: halo + disque couleur à la taille du QG
  const radius = tile * (HQ_SIZE_TILES / 2);
  const palette = { blue: '#4f8cff', red: '#f55454', purple: '#9b5cff', green: '#42d77d' };
  const base = palette[hq.colorKey] || '#4f8cff';
  ctx.save();
  drawHQHalo(ctx, cx, cy, size, base);
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

function drawHQHalo(ctx, cx, cy, size, baseColor) {
  const rgb = hexToRgb(baseColor);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const inner = size * 0.30;
  const outer = size * 1.20;
  const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`);
  grad.addColorStop(0.6, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.10)`);
  grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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

  // Remplissage vertical (bottom->top) avec crête ondulée
  const usable = Math.max(4, Math.min(innerD, Math.floor(tile * 1.0)));
  let yBase = innerY + Math.floor((innerD - usable) / 2);
  const offsetUp = Math.floor(tile * 0.20);
  yBase = Math.max(innerY, yBase - offsetUp);
  const fillHeight = Math.floor(usable * ratio);
  const yTop = yBase + (usable - fillHeight);

  // Zone pleine sous l'onde
  if (fillHeight > 0) {
    ctx.fillStyle = '#ffd54a';
    ctx.fillRect(innerX, Math.min(innerY + innerD, yTop + Math.max(0, Math.floor(tile * 0.08))), innerD, Math.max(0, (yBase + usable) - (yTop + Math.max(0, Math.floor(tile * 0.08)))));

    // Crête ondulée
    const cycles = 2.2; // vagues
    const phase = performance.now() * 0.003; // plus lent
    const amp = Math.min(Math.max(1, Math.floor(tile * 0.08)), Math.floor(fillHeight * 0.4)); // moins haut
    ctx.beginPath();
    ctx.moveTo(innerX, yTop + amp * Math.sin(phase));
    for (let i = 0; i <= innerD; i++) {
      const x = innerX + i;
      const t = (i / innerD) * (Math.PI * 2 * cycles);
      const y = yTop + amp * Math.sin(t + phase);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(innerX + innerD, yBase + usable);
    ctx.lineTo(innerX, yBase + usable);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// --- Panel et logique de spawn ---
function renderSpawnPanel() {
  const panel = el('div', { className: 'spawn-panel', id: 'spawnPanel' });


  // Ligne Points de vie avec cœur rouge
  const hpDisplayLine = el('div', { 
    style: 'display:flex;align-items:center;justify-content:center;gap:6px;margin:8px 0;' 
  });
  const heartIcon = el('span', { 
    textContent: '❤️', 
    style: 'font-size:14px;' 
  });
  const hpDisplay = el('div', { 
    id: 'hqHpDisplay',
    textContent: '1000 / 1000',
    style: 'color:#ff4444;font-weight:600;font-size:14px;' 
  });
  hpDisplayLine.append(heartIcon, hpDisplay);
  
  // Ligne Énergie avec éclair jaune
  const energyDisplayLine = el('div', { 
    style: 'display:flex;align-items:center;justify-content:center;gap:6px;margin:8px 0;' 
  });
  const lightningIcon = el('span', { 
    textContent: '⚡', 
    style: 'font-size:14px;' 
  });
  const energyDisplay = el('div', { 
    id: 'hqEnergyDisplay',
    textContent: '900 / 1000',
    style: 'color:#ffd54a;font-weight:600;font-size:14px;' 
  });
  energyDisplayLine.append(lightningIcon, energyDisplay);
  
  // Séparateur "----"
  const separator = el('div', { 
    textContent: '----', 
    style: 'text-align:center;color:#9aa4b2;margin:8px 0;font-weight:600;' 
  });
  
  // Titre "Usine à Robots"
  const mainTitle = el('div', { 
    textContent: 'Usine à Robots', 
    style: 'text-align:center;color:#cfd6e6;font-size:16px;font-weight:600;margin-bottom:12px;position:relative;z-index:10;' 
  });
  
  // BOX 1: Création d'unité
  const creationBox = el('div', { className: 'unit-card' });
  
  const createLine = el('div', { 
    style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;gap:16px;' 
  });
  const btn = button('Créer', () => spawnUnit());
  btn.id = 'createBtn'; // Ajouter un ID pour pouvoir le retrouver
  btn.style.fontSize = '12px';
  btn.style.padding = '6px 12px';
  btn.style.borderRadius = '6px';
  btn.style.border = '1px solid #178a57';
  btn.style.background = 'linear-gradient(180deg, #2ec27e, #1f9e66)';
  btn.style.color = '#0b0e14';
  btn.style.fontWeight = '600';
  btn.style.cursor = 'pointer';
  
  const energyCost = el('div', { 
    id: 'energyCost',
    textContent: '0 ⚡',
    style: 'color:#ff4444;font-size:11px;font-weight:600;padding:6px;background:rgba(255,68,68,0.1);border-radius:4px;border:1px solid rgba(255,68,68,0.3);' 
  });
  createLine.append(btn, energyCost);
  creationBox.append(createLine);
  
  // Titre Modules (au-dessus des boxes)
  const moduleTitle = el('div', { 
    textContent: 'Modules', 
    style: 'text-align:center;color:#cfd6e6;font-size:14px;font-weight:600;margin:12px 0 8px 0;' 
  });
  
  // BOX 2: Module Mouvement
  const movementBox = el('div', { className: 'unit-card' });
  
  // Module Mouvement avec tout aligné horizontalement
  const moduleLine = el('div', { 
    style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;gap:12px;' 
  });
  
  // Container pour Mouvement + coût (à gauche)
  const movementLabelContainer = el('div', { 
    style: 'display:flex;flex-direction:column;align-items:center;' 
  });
  const movementLabel = el('span', { 
    textContent: 'Mouvement', 
    style: 'font-size:15px;color:#cfd6e6;margin-bottom:4px;font-weight:600;' 
  });
  const movementCost = el('span', { 
    textContent: '50', 
    style: 'color:#ffd54a;font-size:14px;font-weight:800;' 
  });
  movementLabelContainer.append(movementLabel, movementCost);
  
  // Container pour les contrôles (à droite)
  const controlsContainer = el('div', { 
    style: 'display:flex;align-items:center;gap:6px;' 
  });
  
  const movementCount = el('div', { 
    id: 'movementCount',
    textContent: '0', 
    style: 'background:#6b7280;color:#fff;border-radius:4px;padding:3px 6px;font-size:11px;min-width:20px;text-align:center;font-weight:600;' 
  });
  const movementMinus = el('button', { 
    textContent: '−',
    style: 'width:20px;height:20px;border-radius:4px;border:1px solid #4b5563;background:#374151;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;' 
  });
  const movementPlus = el('button', { 
    textContent: '+',
    style: 'width:20px;height:20px;border-radius:4px;border:1px solid #4b5563;background:#374151;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;' 
  });
  
  controlsContainer.append(movementCount, movementMinus, movementPlus);
  moduleLine.append(movementLabelContainer, controlsContainer);
  
  movementPlus.addEventListener('click', () => {
    const total = getTotalModules();
    if (total < 10) {
      state.selectedModules.movement++;
      updateModuleDisplay();
      updateEnergyCost();
    }
  });
  
  movementMinus.addEventListener('click', () => {
    if (state.selectedModules.movement > 0) {
      state.selectedModules.movement--;
      updateModuleDisplay();
      updateEnergyCost();
    }
  });
  
  movementBox.append(moduleLine);
  
  // BOX 3: Module Armure
  const armorBox = el('div', { className: 'unit-card' });
  
  const armorLine = el('div', { 
    style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;gap:12px;' 
  });
  
  // Container pour Armure + coût (à gauche)
  const armorLabelContainer = el('div', { 
    style: 'display:flex;flex-direction:column;align-items:center;' 
  });
  const shieldLabel = el('span', { 
    textContent: 'Bouclier', 
    style: 'font-size:15px;color:#cfd6e6;margin-bottom:4px;font-weight:600;' 
  });
  const shieldCost = el('span', { 
    textContent: '150', 
    style: 'color:#ffd54a;font-size:14px;font-weight:800;' 
  });
  armorLabelContainer.append(shieldLabel, shieldCost);
  
  // Container pour les contrôles (à droite)
  const armorControlsContainer = el('div', { 
    style: 'display:flex;align-items:center;gap:6px;' 
  });
  
  const shieldCount = el('div', { 
    id: 'shieldCount',
    textContent: '0', 
    style: 'background:#6b7280;color:#fff;border-radius:4px;padding:3px 6px;font-size:11px;min-width:20px;text-align:center;font-weight:600;' 
  });
  const armorMinus = el('button', { 
    textContent: '−',
    style: 'width:20px;height:20px;border-radius:4px;border:1px solid #4b5563;background:#374151;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;' 
  });
  const armorPlus = el('button', { 
    textContent: '+',
    style: 'width:20px;height:20px;border-radius:4px;border:1px solid #4b5563;background:#374151;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;' 
  });
  
  armorControlsContainer.append(shieldCount, armorMinus, armorPlus);
  armorLine.append(armorLabelContainer, armorControlsContainer);
  
  // Event listeners pour Bouclier
  armorPlus.addEventListener('click', () => {
    const total = getTotalModules();
    if (total < 10) {
      state.selectedModules.shield++;
      updateModuleDisplay();
      updateEnergyCost();
    }
  });
  
  armorMinus.addEventListener('click', () => {
    if (state.selectedModules.shield > 0) {
      state.selectedModules.shield--;
      updateModuleDisplay();
      updateEnergyCost();
    }
  });

  armorBox.append(armorLine);

  // BOX 4: Module Attaque
  const attackBox = el('div', { className: 'unit-card' });
  
  const attackLine = el('div', { 
    style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;gap:12px;' 
  });
  
  // Container pour Attaque + coût (à gauche)
  const attackLabelContainer = el('div', { 
    style: 'display:flex;flex-direction:column;align-items:center;' 
  });
  const attackLabel = el('span', { 
    textContent: 'Attaque C.A.C', 
    style: 'font-size:15px;color:#cfd6e6;margin-bottom:4px;font-weight:600;' 
  });
  const attackCost = el('span', { 
    textContent: '80', 
    style: 'color:#ffd54a;font-size:14px;font-weight:800;' 
  });
  attackLabelContainer.append(attackLabel, attackCost);
  
  // Container pour les contrôles (à droite)
  const attackControlsContainer = el('div', { 
    style: 'display:flex;align-items:center;gap:6px;' 
  });
  
  const attackCount = el('div', { 
    id: 'attackCount',
    textContent: '0', 
    style: 'background:#6b7280;color:#fff;border-radius:4px;padding:3px 6px;font-size:11px;min-width:20px;text-align:center;font-weight:600;' 
  });
  const attackMinus = el('button', { 
    textContent: '−',
    style: 'width:20px;height:20px;border-radius:4px;border:1px solid #4b5563;background:#374151;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;' 
  });
  const attackPlus = el('button', { 
    textContent: '+',
    style: 'width:20px;height:20px;border-radius:4px;border:1px solid #4b5563;background:#374151;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;' 
  });
  
  attackControlsContainer.append(attackCount, attackMinus, attackPlus);
  attackLine.append(attackLabelContainer, attackControlsContainer);
  
  // Event listeners pour Attaque
  attackPlus.addEventListener('click', () => {
    const total = getTotalModules();
    if (total < 10 && state.selectedModules.ranged_attack === 0) {
      state.selectedModules.attack++;
      updateModuleDisplay();
      updateEnergyCost();
      updateAttackButtonsState();
    }
  });
  
  attackMinus.addEventListener('click', () => {
    if (state.selectedModules.attack > 0) {
      state.selectedModules.attack--;
      updateModuleDisplay();
      updateEnergyCost();
      updateAttackButtonsState();
    }
  });

  attackBox.append(attackLine);

  // BOX 5: Module Attaque à distance
  const rangedAttackBox = el('div', { className: 'unit-card' });
  
  const rangedAttackLine = el('div', { 
    style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;gap:12px;' 
  });
  
  // Container pour Attaque à distance + coût (à gauche)
  const rangedAttackLabelContainer = el('div', { 
    style: 'display:flex;flex-direction:column;align-items:center;' 
  });
  const rangedAttackLabel = el('span', { 
    textContent: 'Attaque à distance', 
    style: 'font-size:15px;color:#cfd6e6;margin-bottom:4px;font-weight:600;' 
  });
  const rangedAttackCost = el('span', { 
    textContent: '100', 
    style: 'color:#ffd54a;font-size:14px;font-weight:800;' 
  });
  rangedAttackLabelContainer.append(rangedAttackLabel, rangedAttackCost);
  
  // Container pour les contrôles (à droite)
  const rangedAttackControlsContainer = el('div', { 
    style: 'display:flex;align-items:center;gap:6px;' 
  });
  
  const rangedAttackCount = el('div', { 
    id: 'rangedAttackCount',
    textContent: '0', 
    style: 'background:#6b7280;color:#fff;border-radius:4px;padding:3px 6px;font-size:11px;min-width:20px;text-align:center;font-weight:600;' 
  });
  const rangedAttackMinus = el('button', { 
    textContent: '−',
    style: 'width:20px;height:20px;border-radius:4px;border:1px solid #4b5563;background:#374151;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;' 
  });
  const rangedAttackPlus = el('button', { 
    textContent: '+',
    style: 'width:20px;height:20px;border-radius:4px;border:1px solid #4b5563;background:#374151;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;' 
  });
  
  rangedAttackControlsContainer.append(rangedAttackCount, rangedAttackMinus, rangedAttackPlus);
  rangedAttackLine.append(rangedAttackLabelContainer, rangedAttackControlsContainer);
  
  // Event listeners pour Attaque à distance
  rangedAttackPlus.addEventListener('click', () => {
    const total = getTotalModules();
    if (total < 10 && state.selectedModules.attack === 0) {
      state.selectedModules.ranged_attack++;
      updateModuleDisplay();
      updateEnergyCost();
      updateAttackButtonsState();
    }
  });
  
  rangedAttackMinus.addEventListener('click', () => {
    if (state.selectedModules.ranged_attack > 0) {
      state.selectedModules.ranged_attack--;
      updateModuleDisplay();
      updateEnergyCost();
      updateAttackButtonsState();
    }
  });

  rangedAttackBox.append(rangedAttackLine);
  
  const list = el('div', { className: 'unit-list' });
  list.append(creationBox, moduleTitle, movementBox, armorBox, attackBox, rangedAttackBox);
  panel.append(hpDisplayLine, energyDisplayLine, separator, mainTitle, list);
  // init texte PV et coût énergie
  updateHqHpLine();
  updateEnergyCost();
  updateCreateButtonState(); // État initial du bouton
  return panel;
}

function getTotalModules() {
  return Object.values(state.selectedModules).reduce((sum, count) => sum + count, 0);
}

// Vérifie si une unité a au moins un module de mouvement fonctionnel (HP > 0)
function hasWorkingMovementModule(unit) {
  if (!unit.modules || unit.modules.length === 0) return false;
  return unit.modules.some(module => module.type === 'movement' && module.hp > 0);
}

// Vérifie si une unité a au moins un module fonctionnel (tous types confondus)
function hasAnyWorkingModule(unit) {
  if (!unit.modules || unit.modules.length === 0) return false;
  return unit.modules.some(module => module.hp > 0);
}

// Crée une animation d'explosion à la position donnée
function createExplosion(tileX, tileY) {
  const now = performance.now();
  const duration = 800; // 800ms d'animation
  const particleCount = 12;
  const particles = [];
  
  // Créer les particules avec des directions aléatoires
  for (let i = 0; i < particleCount; i++) {
    const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.5;
    const speed = 0.5 + Math.random() * 1.0;
    particles.push({
      x: 0, // Position relative au centre
      y: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0 // 1.0 = vivant, 0.0 = mort
    });
  }
  
  state.explosions.push({
    tileX,
    tileY,
    startTime: now,
    duration,
    particles
  });
}

// Crée une animation de laser pour l'attaque à distance
function createLaserAnimation(fromX, fromY, toX, toY, playerColor) {
  const now = performance.now();
  const duration = 300; // Durée courte pour un laser
  
  // Ajouter l'animation laser à state.explosions (on réutilise le système existant)
  state.explosions.push({
    type: 'laser',
    fromX,
    fromY,
    toX,
    toY,
    playerColor,
    startTime: now,
    duration,
    particles: [] // Pas de particules pour un laser
  });
}

// Crée ou met à jour un laser continu entre deux unités
function createContinuousLaser(attacker, target, playerColor) {
  const now = performance.now();
  
  // Supprimer tout laser existant de cette unité
  state.activeLasers = state.activeLasers.filter(laser => laser.unitId !== attacker.id);
  
  // Ajouter le nouveau laser
  state.activeLasers.push({
    unitId: attacker.id,
    targetId: target.target ? target.target.id : null,
    targetType: target.type, // 'unit' ou 'hq'
    targetX: target.x,
    targetY: target.y,
    startTime: now,
    playerColor: playerColor
  });
}

// Nettoie les lasers qui ne sont plus actifs
function cleanupActiveLasers() {
  state.activeLasers = state.activeLasers.filter(laser => {
    // Trouver l'unité qui tire
    const attacker = state.units.find(u => u.id === laser.unitId);
    if (!attacker) return false; // Unité détruite
    
    // Trouver la cible
    let target = null;
    if (laser.targetType === 'unit') {
      target = state.units.find(u => u.id === laser.targetId);
      if (!target) return false; // Cible détruite
    } else if (laser.targetType === 'hq') {
      target = state.hqs.find(hq => Math.abs(hq.cx - laser.targetX) < 0.1 && Math.abs(hq.cy - laser.targetY) < 0.1);
      if (!target) return false; // QG détruit
    }
    
    // Vérifier si encore à portée (6 cases)
    const distance = Math.abs(attacker.x - laser.targetX) + Math.abs(attacker.y - laser.targetY);
    if (distance > 6) return false; // Plus à portée
    
    // Vérifier si l'unité a encore des modules d'attaque à distance
    const hasRangedAttack = attacker.modules && attacker.modules.some(m => m.type === 'ranged_attack' && m.hp > 0);
    if (!hasRangedAttack) return false; // Plus de modules d'attaque
    
    return true; // Laser toujours actif
  });
}

// Dessine les lasers actifs
function drawActiveLasers(ctx, tile, ox, oy) {
  const now = performance.now();
  
  for (const laser of state.activeLasers) {
    // Trouver l'unité qui tire
    const attacker = state.units.find(u => u.id === laser.unitId);
    if (!attacker) continue;
    
    // Position de l'attaquant (avec animation si nécessaire)
    let fromX = attacker.x;
    let fromY = attacker.y;
    if (attacker.anim && attacker.anim.endTime > now) {
      const animProgress = easeOutCubic((now - attacker.anim.startTime) / (attacker.anim.endTime - attacker.anim.startTime));
      fromX = attacker.anim.fromX + (attacker.anim.toX - attacker.anim.fromX) * animProgress;
      fromY = attacker.anim.fromY + (attacker.anim.toY - attacker.anim.fromY) * animProgress;
    }
    
    // Position de la cible (mise à jour en temps réel)
    let toX = laser.targetX;
    let toY = laser.targetY;
    
    // Si la cible est une unité, utiliser sa position actuelle avec animation
    if (laser.targetType === 'unit') {
      const targetUnit = state.units.find(u => u.id === laser.targetId);
      if (targetUnit) {
        toX = targetUnit.x;
        toY = targetUnit.y;
        
        // Prendre en compte l'animation de déplacement de la cible
        if (targetUnit.anim && targetUnit.anim.endTime > now) {
          const targetAnimProgress = easeOutCubic((now - targetUnit.anim.startTime) / (targetUnit.anim.endTime - targetUnit.anim.startTime));
          toX = targetUnit.anim.fromX + (targetUnit.anim.toX - targetUnit.anim.fromX) * targetAnimProgress;
          toY = targetUnit.anim.fromY + (targetUnit.anim.toY - targetUnit.anim.fromY) * targetAnimProgress;
        }
      }
    }
    
    // Calculer la position de départ du laser (base du trait directionnel)
    // Reproduire les calculs de drawUnit pour trouver la base du trait
    const unitCenterX = ox + (fromX + 0.5) * tile;
    const unitCenterY = oy + (fromY + 0.5) * tile;
    const r = tile * 0.46;
    const ringW = Math.max(3, Math.floor(tile * 0.22));
    const dirW = Math.max(3, Math.floor(tile * 0.14));
    const outerRing = r + ringW * 0.5;
    const startLen = outerRing + dirW * 0.5 + Math.max(1, Math.floor(tile * 0.02));
    
    // Calculer l'angle vers la cible pour orienter le laser
    const laserAngle = Math.atan2(toY - fromY, toX - fromX);
    
    // Position de départ du laser (base du trait directionnel)
    const screenFromX = unitCenterX + Math.cos(laserAngle) * startLen;
    const screenFromY = unitCenterY + Math.sin(laserAngle) * startLen;
    const screenToX = ox + (toX + 0.3) * tile; // Légèrement à gauche comme demandé
    const screenToY = oy + (toY + 0.2) * tile; // Vers le haut de l'unité cible
    
    // Couleur du laser
    const playerColor = colorFromKey(laser.playerColor);
    
    // Effet de pulsation
    const elapsed = now - laser.startTime;
    const pulseIntensity = 0.7 + 0.3 * Math.sin(elapsed / 100); // Pulsation rapide
    
    ctx.save();
    
    // Dessiner le laser principal
    ctx.strokeStyle = playerColor;
    ctx.globalAlpha = pulseIntensity;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    
    ctx.beginPath();
    ctx.moveTo(screenFromX, screenFromY);
    ctx.lineTo(screenToX, screenToY);
    ctx.stroke();
    
    // Halo lumineux externe
    ctx.strokeStyle = playerColor;
    ctx.globalAlpha = pulseIntensity * 0.3;
    ctx.lineWidth = 8;
    ctx.shadowColor = playerColor;
    ctx.shadowBlur = 12;
    
    ctx.beginPath();
    ctx.moveTo(screenFromX, screenFromY);
    ctx.lineTo(screenToX, screenToY);
    ctx.stroke();
    
    // Effet de lueur intermédiaire
    ctx.globalAlpha = pulseIntensity * 0.6;
    ctx.lineWidth = 5;
    ctx.shadowBlur = 6;
    
    ctx.beginPath();
    ctx.moveTo(screenFromX, screenFromY);
    ctx.lineTo(screenToX, screenToY);
    ctx.stroke();
    
    ctx.restore();
  }
}

// Crée une animation d'explosion réduite pour les attaques
function createAttackExplosion(tileX, tileY) {
  const now = performance.now();
  const duration = 600; // Durée plus courte pour l'attaque
  const particleCount = 8; // Moins de particules
  const particles = [];
  
  // Créer les particules avec des directions aléatoires mais vitesse réduite
  for (let i = 0; i < particleCount; i++) {
    const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.5;
    const speed = (0.5 + Math.random() * 1.0) * 0.5; // Vitesse réduite de moitié
    particles.push({
      x: 0, // Position relative au centre
      y: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0 // 1.0 = vivant, 0.0 = mort
    });
  }
  
  state.explosions.push({
    tileX,
    tileY,
    startTime: now,
    duration,
    particles
  });
}

// Crée une grosse explosion pour la destruction d'un QG
function createHQExplosion(tileX, tileY) {
  const now = performance.now();
  const duration = 2000; // Explosion plus longue
  const particleCount = 20; // Plus de particules
  const particles = [];
  
  // Créer les particules avec une vitesse plus élevée pour une grosse explosion
  for (let i = 0; i < particleCount; i++) {
    const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.5;
    const speed = 1.0 + Math.random() * 2.0; // Vitesse plus élevée
    particles.push({
      x: 0, // Position relative au centre
      y: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0 // 1.0 = vivant, 0.0 = mort
    });
  }
  
  state.explosions.push({
    tileX,
    tileY,
    startTime: now,
    duration,
    particles
  });
}

// Applique des dégâts à une unité avec ciblage aléatoire des modules
function damageUnit(unit, damage) {
  if (!unit.modules || unit.modules.length === 0) return;
  
  // Vérifier s'il y a des boucliers fonctionnels pour la réduction de dégâts
  const workingShields = unit.modules.filter(m => m.type === 'shield' && m.hp > 0);
  let actualDamage = damage;
  
  // Si il y a des boucliers fonctionnels, réduire les dégâts de 20%
  if (workingShields.length > 0) {
    actualDamage = Math.floor(damage * 0.8);
    console.log(`Dégâts réduits de 20% grâce aux boucliers: ${damage} → ${actualDamage}`);
  }
  
  let remainingDamage = actualDamage;
  
  // Phase 1: Cibler aléatoirement les boucliers d'abord
  const shields = unit.modules.filter(m => m.type === 'shield' && m.hp > 0);
  if (shields.length > 0) {
    // Mélanger aléatoirement l'ordre des boucliers
    const shuffledShields = [...shields].sort(() => Math.random() - 0.5);
    
    for (const shield of shuffledShields) {
      if (remainingDamage <= 0) break;
      
      const damageToApply = Math.min(remainingDamage, shield.hp);
      shield.hp -= damageToApply;
      remainingDamage -= damageToApply;
      
      console.log(`Bouclier ciblé aléatoirement: ${shield.hp}/100 HP restants`);
    }
  }
  
  // Phase 2: Si il reste des dégâts, cibler aléatoirement les autres modules
  if (remainingDamage > 0) {
    const otherModules = unit.modules.filter(m => m.type !== 'shield' && m.hp > 0);
    if (otherModules.length > 0) {
      // Mélanger aléatoirement l'ordre des autres modules
      const shuffledOtherModules = [...otherModules].sort(() => Math.random() - 0.5);
      
      for (const module of shuffledOtherModules) {
        if (remainingDamage <= 0) break;
        
        const damageToApply = Math.min(remainingDamage, module.hp);
        module.hp -= damageToApply;
        remainingDamage -= damageToApply;
        
        console.log(`Module ${module.type} ciblé aléatoirement: ${module.hp}/100 HP restants`);
      }
    }
  }
  
  // Vérifier si l'unité doit être détruite
  const hasWorkingModules = unit.modules.some(m => m.hp > 0);
  if (!hasWorkingModules) {
    console.log(`Unité ${unit.id} détruite par les dégâts`);
  }
}

// Calcule le modificateur de vitesse basé sur le ratio modules de mouvement / autres modules
function getSpeedModifier(unit) {
  if (!unit.modules || unit.modules.length === 0) return 1.0;
  
  const workingModules = unit.modules.filter(module => module.hp > 0);
  const movementModules = workingModules.filter(module => module.type === 'movement').length;
  const otherModules = workingModules.filter(module => module.type !== 'movement').length;
  
  // Si pas de modules de mouvement fonctionnels, pas de mouvement
  if (movementModules === 0) return 0;
  
  // Si pas d'autres modules, vitesse normale
  if (otherModules === 0) return 1.0;
  
  // Calcul du ratio: mouvement / autres
  const ratio = movementModules / otherModules;
  
  // Si ratio >= 1 (autant ou plus de mouvement que d'autres), vitesse normale
  if (ratio >= 1.0) return 1.0;
  
  // Si ratio < 1 (moins de mouvement que d'autres), ralentissement proportionnel
  return ratio;
}

function updateModuleDisplay() {
  const movementCount = q('#movementCount');
  if (movementCount) {
    movementCount.textContent = state.selectedModules.movement.toString();
  }
  const shieldCount = q('#shieldCount');
  if (shieldCount) {
    shieldCount.textContent = state.selectedModules.shield.toString();
  }
  const attackCount = q('#attackCount');
  if (attackCount) {
    attackCount.textContent = state.selectedModules.attack.toString();
  }
  const rangedAttackCount = q('#rangedAttackCount');
  if (rangedAttackCount) {
    rangedAttackCount.textContent = state.selectedModules.ranged_attack.toString();
  }
}

// Met à jour l'état des boutons d'attaque (exclusion mutuelle)
function updateAttackButtonsState() {
  const attackPlus = q('#attackPlus');
  const rangedAttackPlus = q('#rangedAttackPlus');
  
  if (attackPlus && rangedAttackPlus) {
    // Si on a des modules d'attaque à distance, griser les boutons d'attaque CAC
    if (state.selectedModules.ranged_attack > 0) {
      attackPlus.disabled = true;
      attackPlus.style.opacity = '0.5';
      attackPlus.style.cursor = 'not-allowed';
    } else {
      attackPlus.disabled = false;
      attackPlus.style.opacity = '1';
      attackPlus.style.cursor = 'pointer';
    }
    
    // Si on a des modules d'attaque CAC, griser les boutons d'attaque à distance
    if (state.selectedModules.attack > 0) {
      rangedAttackPlus.disabled = true;
      rangedAttackPlus.style.opacity = '0.5';
      rangedAttackPlus.style.cursor = 'not-allowed';
    } else {
      rangedAttackPlus.disabled = false;
      rangedAttackPlus.style.opacity = '1';
      rangedAttackPlus.style.cursor = 'pointer';
    }
  }
}

function updateEnergyCost() {
  const energyCost = q('#energyCost');
  if (energyCost) {
    const cost = calculateUnitCost();
    energyCost.textContent = `${cost} ⚡`;
  }
  updateCreateButtonState();
}

function updateCreateButtonState() {
  const btn = q('#createBtn');
  if (!btn) return;
  
  const totalModules = getTotalModules();
  const cost = calculateUnitCost();
  const key = state.playerColors[state.currentPlayerIndex];
  const hq = state.hqs && state.hqs.find(h => h.colorKey === key);
  const currentEnergy = hq ? hq.energy : 0;
  
  const canCreate = totalModules > 0 && currentEnergy >= cost;
  
  if (canCreate) {
    // État normal (vert)
    btn.style.background = 'linear-gradient(180deg, #2ec27e, #1f9e66)';
    btn.style.border = '1px solid #178a57';
    btn.style.color = '#0b0e14';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  } else {
    // État grisé
    btn.style.background = 'linear-gradient(180deg, #6b7280, #4b5563)';
    btn.style.border = '1px solid #374151';
    btn.style.color = '#9ca3af';
    btn.style.opacity = '0.7';
    btn.style.cursor = 'not-allowed';
  }
}

function calculateUnitCost() {
  return state.selectedModules.movement * 50 + state.selectedModules.shield * 150 + state.selectedModules.attack * 80 + state.selectedModules.ranged_attack * 100; // 50 énergie par module de mouvement, 150 par module de bouclier, 80 par module d'attaque, 100 par module d'attaque à distance
}

function updateHqHpLine() {
  const key = state.playerColors[state.currentPlayerIndex];
  const hq = state.hqs && state.hqs.find(h => h.colorKey === key);
  if (!hq) return;
  
  // Mettre à jour les nouveaux affichages dans le panneau de création
  const hqHpDisplay = q('#hqHpDisplay');
  if (hqHpDisplay) hqHpDisplay.textContent = `${hq.hp} / ${hq.hpMax}`;
  
  const hqEnergyDisplay = q('#hqEnergyDisplay');
  if (hqEnergyDisplay) hqEnergyDisplay.textContent = `${hq.energy} / ${hq.energyMax}`;
  
  updateCreateButtonState(); // Mettre à jour le bouton quand l'énergie change
}

function updateSpawnCreateIconColor() {
  // L'icône n'existe plus dans la nouvelle interface
  return;
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
  if (myHq && Math.abs(gx - myHq.cx) <= HQ_HALF_SPAN - 1 && Math.abs(gy - myHq.cy) <= HQ_HALF_SPAN - 1) {
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
  console.log('spawnUnit appelée');
  const activeKey = state.playerColors[state.currentPlayerIndex];
  const hq = state.hqs.find(h => h.colorKey === activeKey);
  console.log('HQ trouvé:', hq);
  if (!hq) {
    console.log('Pas de HQ trouvé!');
    return;
  }
  
  // Vérifier qu'au moins un module est sélectionné
  const totalModules = getTotalModules();
  if (totalModules === 0) {
    console.log('Aucun module sélectionné!');
    return;
  }
  
  // Vérifier si on a assez d'énergie
  const cost = calculateUnitCost();
  console.log('Coût calculé:', cost, 'Énergie HQ:', hq.energy);
  if (hq.energy < cost) {
    console.log('Pas assez d\'énergie!');
    return;
  }
  
  const created = spawnUnitFromHQ(hq, state.currentPlayerIndex, 'player'); // Marquer comme création joueur
  console.log('Unité créée:', created);
  if (!created) {
    console.log('Échec de création d\'unité');
    return;
  }
  
  // Déduire le coût en énergie du QG
  hq.energy = Math.max(0, hq.energy - cost);
  console.log('Nouvelle énergie HQ:', hq.energy);
  
  // Reset la sélection de modules après création
  state.selectedModules.movement = 0;
  state.selectedModules.shield = 0;
  state.selectedModules.attack = 0;
  state.selectedModules.ranged_attack = 0;
  updateModuleDisplay();
  updateEnergyCost();
  updateAttackButtonsState();
  updateHqHpLine(); // Mettre à jour l'affichage de l'énergie du QG
  updateCreateButtonState(); // Mettre à jour l'état du bouton après création
  const panel = q('#spawnPanel'); if (panel) panel.classList.remove('visible');
  const canvas = q('#game'); if (canvas) drawScene(canvas);
}

function spawnInitialUnitsAtHQ(hq, ownerIndex, count) {
  let i = 0;
  while (i < count) {
    if (!spawnUnitFromHQ(hq, ownerIndex, i)) break;
    i++;
  }
}

// Fait apparaître l'unité au centre du QG puis l'anime vers une sortie N/S/E/O
function spawnUnitFromHQ(hq, ownerIndex, offsetIdx = 0) {
  console.log('Recherche spot de sortie pour HQ:', hq.cx, hq.cy, 'offsetIdx:', offsetIdx);
  // Pour les créations joueur, on utilise 0 comme attempt
  const attempt = (offsetIdx === 'player') ? 0 : offsetIdx;
  const spot = findHQExitSpot(hq, attempt);
  console.log('Spot trouvé:', spot);
  if (!spot) {
    console.log('Aucun spot de sortie trouvé!');
    return false;
  }
  if (unitAt(spot.x, spot.y)) {
    console.log('Spot occupé par une unité!');
    return false;
  }
  const idNum = state.nextUnitId++;
  const now = performance.now();
  const tileDuration = 2160; // encore 2x plus lent (au total 6x)
  const headingAng = Math.atan2(spot.y - hq.cy, spot.x - hq.cx);
  // Création des modules basée sur la sélection (ou valeurs par défaut pour les unités initiales)
  const modules = [];
        if (offsetIdx === 'player') { // Création par le joueur via l'interface
        // Ajouter les modules sélectionnés
        for (let i = 0; i < state.selectedModules.movement; i++) {
          modules.push({ type: 'movement', hp: 100, maxHp: 100 });
        }
        for (let i = 0; i < state.selectedModules.shield; i++) {
          modules.push({ type: 'shield', hp: 100, maxHp: 100 });
        }
        for (let i = 0; i < state.selectedModules.attack; i++) {
          modules.push({ type: 'attack', hp: 100, maxHp: 100 });
        }
        for (let i = 0; i < state.selectedModules.ranged_attack; i++) {
          modules.push({ type: 'ranged_attack', hp: 100, maxHp: 100 });
        }
      } else { // Unités initiales (spawn automatique au début)
        // Une unité initiale basique sans module
      }
  
  const unit = {
    id: idNum,
    ownerIndex,
    x: spot.x,
    y: spot.y,
    hp: 1,
    modules: modules,
    recentTrail: [],
    lastDir: null,
    anim: { fromX: hq.cx, fromY: hq.cy, toX: spot.x, toY: spot.y, startTime: now, endTime: now + tileDuration },
    headingFrom: headingAng,
    headingTo: headingAng,
    headingStart: now,
    headingEnd: now + tileDuration,
    lastAttackTime: null,
  };
  state.units.push(unit);
  const pm = state.playerMaps[ownerIndex];
  if (pm) pm.knownFree.add(`${spot.x},${spot.y}`);
  return true;
}

// Cherche une case de sortie juste à l'extérieur du QG, en privilégiant N/E/S/O
function findHQExitSpot(hq, attempt = 0) {
  console.log('findHQExitSpot: HQ_BLOCK_HALF_SPAN =', HQ_BLOCK_HALF_SPAN, 'attempt =', attempt);
  const directions = [ [0,-1], [1,0], [0,1], [-1,0] ]; // N,E,S,O
  const startRadius = HQ_BLOCK_HALF_SPAN + 1;
  const extra = Math.min(6, attempt); // éloigne un peu pour spawns multiples
  console.log('startRadius =', startRadius, 'extra =', extra);
  
  for (const [dx, dy] of directions) {
    console.log('Testant direction:', dx, dy);
    for (let r = startRadius; r <= startRadius + 3 + extra; r++) {
      const x = hq.cx + dx * r;
      const y = hq.cy + dy * r;
      console.log('  Test position:', x, y, 'radius:', r);
      
      if (!isInBounds(x, y)) {
        console.log('    Hors limites');
        continue;
      }
      if (isBlocked(x, y)) {
        console.log('    Bloqué');
        continue;
      }
      if (unitAt(x, y)) {
        console.log('    Unité présente');
        continue;
      }
      // Vérifie qu'aucune unité ne se trouve devant sur la trajectoire
      if (!isExitPathClear(hq, dx, dy, r)) {
        console.log('    Chemin non dégagé');
        continue;
      }
      console.log('  SPOT VALIDE TROUVÉ:', x, y);
      return { x, y };
    }
  }
  console.log('Aucun spot valide trouvé dans toutes les directions');
  return null;
}

function isExitPathClear(hq, dx, dy, r) {
  const startRadius = HQ_BLOCK_HALF_SPAN + 1;
  for (let t = startRadius; t <= r; t++) {
    const px = hq.cx + dx * t;
    const py = hq.cy + dy * t;
    if (unitAt(px, py)) return false;
  }
  return true;
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
  // Anneau découpé en 10 tronçons pour les modules
  drawModuleRing(ctx, u, cx, cy, r, ringW);
  // ID centré (ID global unique)
  ctx.fillStyle = color;
  ctx.font = `${Math.floor(tile * 0.6)}px ui-monospace, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(u.id), cx, cy + 1);

  // Indicateur de direction (heading)
  const now2 = performance.now();
  const headingT = (u.headingEnd && u.headingEnd > now2)
    ? easeOutCubic((now2 - u.headingStart) / (u.headingEnd - u.headingStart)) : 1;
  let heading = (u.headingFrom ?? 0) + ((u.headingTo ?? 0) - (u.headingFrom ?? 0)) * Math.min(1, Math.max(0, headingT));
  
  // Vérifier si l'unité tire à distance et orienter le trait vers la cible
  const activeLaser = state.activeLasers.find(laser => laser.unitId === u.id);
  if (activeLaser) {
    // Calculer l'angle vers la cible
    let targetX = activeLaser.targetX;
    let targetY = activeLaser.targetY;
    
    // Si la cible est une unité, utiliser sa position actuelle
    if (activeLaser.targetType === 'unit') {
      const targetUnit = state.units.find(unit => unit.id === activeLaser.targetId);
      if (targetUnit) {
        targetX = targetUnit.x;
        targetY = targetUnit.y;
        // Prendre en compte l'animation de la cible
        if (targetUnit.anim && targetUnit.anim.endTime > now2) {
          const targetAnimProgress = easeOutCubic((now2 - targetUnit.anim.startTime) / (targetUnit.anim.endTime - targetUnit.anim.startTime));
          targetX = targetUnit.anim.fromX + (targetUnit.anim.toX - targetUnit.anim.fromX) * targetAnimProgress;
          targetY = targetUnit.anim.fromY + (targetUnit.anim.toY - targetUnit.anim.fromY) * targetAnimProgress;
        }
      }
    }
    
    // Calculer l'angle vers la cible
    heading = Math.atan2(targetY - ty, targetX - tx);
  }
  
  // Petit trait directionnel à l'extérieur du cercle:
  // démarre juste APRÈS l'extérieur de l'anneau sans chevauchement (prend en compte ringW et l'épaisseur du trait)
  const dirW = Math.max(3, Math.floor(tile * 0.14));
  const outerRing = r + ringW * 0.5; // rayon extérieur de l'anneau
  const startLen = outerRing + dirW * 0.5 + Math.max(1, Math.floor(tile * 0.02));
  // longueur réduite encore plus
  const endLen = startLen + Math.max(2, Math.floor(tile * 0.18));
  const sx = cx + Math.cos(heading) * startLen;
  const sy = cy + Math.sin(heading) * startLen;
  const hx = cx + Math.cos(heading) * endLen;
  const hy = cy + Math.sin(heading) * endLen;
  ctx.strokeStyle = color;
  ctx.lineWidth = dirW;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.restore();
}

function drawModuleRing(ctx, u, cx, cy, r, ringW) {
  const modules = u.modules || [];
  const totalSlots = 10;
  const slotAngle = (Math.PI * 2) / totalSlots;
  const innerRadius = Math.max(1, r - ringW * 0.5); // Éviter les radius négatifs
  const outerRadius = Math.max(innerRadius + 1, r + ringW * 0.5);
  
  // Dessiner chaque tronçon
  for (let i = 0; i < totalSlots; i++) {
    const startAngle = i * slotAngle - Math.PI / 2; // Commence en haut (12h)
    const endAngle = (i + 1) * slotAngle - Math.PI / 2;
    
    // Vérifier s'il y a un module dans ce slot
    const module = modules[i];
    
            if (module) {
          // Couleur basée sur le type de module
          let moduleColor = '#6b7280'; // Gris clair par défaut
          switch (module.type) {
            case 'movement':
              moduleColor = '#6b7280'; // Gris clair pour mouvement
              break;
            case 'shield':
              moduleColor = '#1e90ff'; // Bleu vif pour bouclier
              break;
            case 'attack':
              moduleColor = '#ff0000'; // Rouge pour attaque
              break;
            case 'ranged_attack':
              moduleColor = '#654321'; // Marron foncé pour attaque à distance
              break;
            default:
              moduleColor = '#6b7280';
          }
      
      // Calculer le ratio de santé pour la jauge
      const healthRatio = Math.max(0, Math.min(1, module.hp / module.maxHp));
      
      // Dessiner d'abord le fond (module endommagé/vide)
      ctx.save();
      ctx.fillStyle = '#2a2a2a'; // Fond sombre
      ctx.beginPath();
      ctx.arc(cx, cy, outerRadius, startAngle, endAngle);
      ctx.arc(cx, cy, innerRadius, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      
      // Dessiner la jauge de santé (portion restante)
      if (healthRatio > 0) {
        const healthAngle = startAngle + (endAngle - startAngle) * healthRatio;
        ctx.save();
        ctx.fillStyle = moduleColor;
        ctx.beginPath();
        ctx.arc(cx, cy, outerRadius, startAngle, healthAngle);
        ctx.arc(cx, cy, innerRadius, healthAngle, startAngle, true);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    } else {
      // Slot vide
      ctx.save();
      ctx.fillStyle = '#222222'; // Couleur par défaut (vide)
      ctx.beginPath();
      ctx.arc(cx, cy, outerRadius, startAngle, endAngle);
      ctx.arc(cx, cy, innerRadius, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    
    // Bordure entre les tronçons
    ctx.save();
    ctx.strokeStyle = '#0e0e0e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius, startAngle, endAngle);
    ctx.arc(cx, cy, innerRadius, endAngle, startAngle, true);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}

function interpolateColor(color1, color2, ratio) {
  // Simple interpolation de couleur (approximation rapide)
  if (ratio <= 0) return color1;
  if (ratio >= 1) return color2;
  // Pour cette première version, on retourne juste color2 si ratio > 0.5, sinon color1
  return ratio > 0.5 ? color2 : color1;
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
    if (Math.abs(x - h.cx) <= HQ_BLOCK_HALF_SPAN && Math.abs(y - h.cy) <= HQ_BLOCK_HALF_SPAN) return true;
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

// Version de isBlocked qui utilise seulement la connaissance du joueur
function isBlockedByPlayerKnowledge(x, y, playerIndex) {
  if (!isInBounds(x, y)) return true;
  if (isHQCell(x, y)) return true; // QG zone (connaissance globale acceptable)
  
  const pm = state.playerMaps[playerIndex];
  if (!pm) return true; // Pas de carte = tout bloqué
  
  const key = `${x},${y}`;
  // Si c'est un mur connu par le joueur, c'est bloqué
  if (pm.knownWalls && pm.knownWalls.has(key)) return true;
  
  // Si ce n'est pas une case libre connue, on considère que c'est bloqué
  if (!pm.knownFree || !pm.knownFree.has(key)) return true;
  
  return false;
}

// Version de moveTowardOrExploreInline qui utilise seulement la connaissance du joueur
function moveTowardEnemyHQWithPlayerKnowledge(u, targetX, targetY) {
  if (u.x === targetX && u.y === targetY) return false;
  
  const dirs = [ [1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1] ];
  const pm = state.playerMaps[u.ownerIndex];
  if (!pm) return false;
  
  let best = null; 
  let bestDist = Infinity;
  
  // Fonction pour vérifier si une case est accessible (connue libre OU inconnue mais pas mur connu)
  const isAccessible = (x, y) => {
    if (!isInBounds(x, y)) return false;
    if (unitAt(x, y)) return false;
    if (isHQCell(x, y)) return false; // QG zones non traversables
    
    const key = `${x},${y}`;
    // Si c'est un mur connu, pas accessible
    if (pm.knownWalls && pm.knownWalls.has(key)) return false;
    
    // Si c'est libre connu OU case inconnue, c'est accessible pour exploration
    return true;
  };
  
  // 1) D'abord vérifier si on peut avancer vers la cible sur cases connues libres (ET pas récemment visitées)
  for (const d of dirs) {
    const nx = u.x + d[0];
    const ny = u.y + d[1];
    
    if (!isAccessible(nx, ny)) continue;
    
    // Éviter de revenir sur ses pas immédiatement
    if (u.lastDir && d[0] === -u.lastDir[0] && d[1] === -u.lastDir[1]) continue;
    
    const key = `${nx},${ny}`;
    // Éviter les cases récemment visitées pour ne pas tourner en rond
    if (u.recentTrail && u.recentTrail.includes(key)) continue;
    
    // Préférer les cases connues libres qui rapprochent vraiment de la cible
    if (pm.knownFree && pm.knownFree.has(key)) {
      const newDist = Math.abs(targetX - nx) + Math.abs(targetY - ny);
      const currentDist = Math.abs(targetX - u.x) + Math.abs(targetY - u.y);
      // Seulement si ça rapproche vraiment
      if (newDist < currentDist && newDist < bestDist) {
        bestDist = newDist;
        best = d;
      }
    }
  }
  
  // 2) Si pas de progression connue, chercher des zones inexplorées dans un rayon élargi
  if (!best) {
    console.log(`Unité ${u.id}: Recherche de zones inexplorées dans un rayon élargi`);
    
    // Chercher des cases inconnues dans un rayon de 8 cases
    let bestUnknownTarget = null;
    let bestUnknownDist = Infinity;
    
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        const checkX = u.x + dx;
        const checkY = u.y + dy;
        
        if (!isInBounds(checkX, checkY)) continue;
        if (Math.abs(dx) + Math.abs(dy) > 8) continue; // Distance Manhattan max 8
        
        const key = `${checkX},${checkY}`;
        // Case vraiment inconnue
        if (!pm.knownFree || !pm.knownFree.has(key)) {
          if (!pm.knownWalls || !pm.knownWalls.has(key)) {
            if (!isHQCell(checkX, checkY)) {
              const dist = Math.abs(dx) + Math.abs(dy);
              if (dist < bestUnknownDist) {
                bestUnknownDist = dist;
                bestUnknownTarget = { x: checkX, y: checkY };
              }
            }
          }
        }
      }
    }
    
    // Si on a trouvé une zone inexplorée, aller vers elle
    if (bestUnknownTarget) {
      console.log(`Unité ${u.id}: Zone inexplorée trouvée à (${bestUnknownTarget.x}, ${bestUnknownTarget.y}), distance ${bestUnknownDist}`);
      
      // Calculer la direction générale vers cette zone
      const dirX = bestUnknownTarget.x > u.x ? 1 : (bestUnknownTarget.x < u.x ? -1 : 0);
      const dirY = bestUnknownTarget.y > u.y ? 1 : (bestUnknownTarget.y < u.y ? -1 : 0);
      
      // Essayer d'aller dans cette direction
      const idealDirs = [];
      if (dirX !== 0 && dirY !== 0) idealDirs.push([dirX, dirY]); // Diagonale
      if (dirX !== 0) idealDirs.push([dirX, 0]); // Horizontal
      if (dirY !== 0) idealDirs.push([0, dirY]); // Vertical
      
      for (const d of idealDirs) {
        const nx = u.x + d[0];
        const ny = u.y + d[1];
        
        if (!isAccessible(nx, ny)) continue;
        if (u.lastDir && d[0] === -u.lastDir[0] && d[1] === -u.lastDir[1]) continue;
        
        const key = `${nx},${ny}`;
        if (u.recentTrail && u.recentTrail.includes(key)) continue;
        
        best = d;
        console.log(`Unité ${u.id}: Direction vers zone inexplorée (${nx}, ${ny})`);
        break;
      }
    }
    
    // Si pas de zone inexplorée trouvée, essayer une case inconnue adjacente
    if (!best) {
      console.log(`Unité ${u.id}: Recherche de case inconnue adjacente`);
      for (const d of dirs) {
        const nx = u.x + d[0];
        const ny = u.y + d[1];
        
        if (!isAccessible(nx, ny)) continue;
        if (u.lastDir && d[0] === -u.lastDir[0] && d[1] === -u.lastDir[1]) continue;
        
        const key = `${nx},${ny}`;
        if (u.recentTrail && u.recentTrail.includes(key)) continue;
        
        // SEULEMENT les cases vraiment inconnues
        if (!pm.knownFree || !pm.knownFree.has(key)) {
          best = d;
          console.log(`Unité ${u.id}: Case inconnue adjacente trouvée (${nx}, ${ny})`);
          break;
        }
      }
    }
  }
  
  // Dernier fallback: mouvement aléatoire vers n'importe quelle case libre
  if (!best) {
    console.log(`Unité ${u.id}: Aucune case inconnue trouvée, mouvement aléatoire forcé`);
    for (const d of dirs) {
      const nx = u.x + d[0];
      const ny = u.y + d[1];
      
      if (!isInBounds(nx, ny)) continue;
      if (unitAt(nx, ny)) continue;
      if (u.lastDir && d[0] === -u.lastDir[0] && d[1] === -u.lastDir[1]) continue;
      
      const key = `${nx},${ny}`;
      // Éviter aussi le trail récent même dans mouvement aléatoire
      if (u.recentTrail && u.recentTrail.includes(key)) continue;
      
      // Accepter n'importe quelle case libre (connue ou non) sauf murs connus
      if (!pm.knownWalls || !pm.knownWalls.has(key)) {
        if (!isHQCell(nx, ny)) {
          best = d;
          console.log(`Unité ${u.id}: Mouvement aléatoire forcé vers (${nx}, ${ny})`);
          break;
        }
      }
    }
  }
  
  // Ultime recours: autoriser le retour sur ses pas
  if (!best) {
    console.log(`Unité ${u.id}: Dernier recours - retour sur ses pas autorisé`);
    for (const d of dirs) {
      const nx = u.x + d[0];
      const ny = u.y + d[1];
      
      if (!isInBounds(nx, ny)) continue;
      if (unitAt(nx, ny)) continue;
      
      const key = `${nx},${ny}`;
      // Accepter n'importe quelle case libre, même retour arrière
      if (!pm.knownWalls || !pm.knownWalls.has(key)) {
        if (!isHQCell(nx, ny)) {
          best = d;
          console.log(`Unité ${u.id}: Retour sur ses pas vers (${nx}, ${ny})`);
          break;
        }
      }
    }
  }
  
  if (!best) {
    console.log(`Unité ${u.id}: Complètement bloquée`);
    return false;
  }
  
  // Effectuer le mouvement
  const nx = u.x + best[0];
  const ny = u.y + best[1];
  
  // Vérifier si c'est réellement possible (pas de collision avec mur réel)
  if (isBlocked(nx, ny)) {
    console.log(`Unité ${u.id}: Case (${nx}, ${ny}) bloquée par obstacle, ajout aux murs connus`);
    // Ajouter aux murs connus et ne pas bouger
    if (pm.knownWalls) pm.knownWalls.add(`${nx},${ny}`);
    return false;
  }
  
  const now = performance.now();
  const speedModifier = getSpeedModifier(u);
  const baseDuration = 240;
  const duration = speedModifier > 0 ? Math.floor(baseDuration / speedModifier) : baseDuration * 10;
  
  u.anim = { fromX: u.x, fromY: u.y, toX: nx, toY: ny, startTime: now, endTime: now + duration };
  const ang = Math.atan2(ny - u.y, nx - u.x);
  u.headingFrom = (u.headingTo ?? ang);
  u.headingTo = ang;
  u.headingStart = now; 
  u.headingEnd = now + duration;
  
  updateRecentTrail(u, u.x, u.y);
  u.x = nx; 
  u.y = ny; 
  u.lastDir = best;
  
  // Mettre à jour la connaissance du joueur
  if (pm.knownFree) {
    pm.knownFree.add(`${u.x},${u.y}`);
  }
  
  console.log(`Unité ${u.id}: Déplacement réussi vers (${u.x}, ${u.y})`);
  return true;
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

// Désactive le zoom au double tap sur iOS/iPad
function preventZoom() {
  // Empêche le zoom au double tap
  let lastTouchEnd = 0;
  document.addEventListener('touchend', function (event) {
    const now = (new Date()).getTime();
    if (now - lastTouchEnd <= 300) {
      event.preventDefault();
    }
    lastTouchEnd = now;
  }, false);

  // Empêche le zoom par pincement
  document.addEventListener('gesturestart', function (e) {
    e.preventDefault();
  }, false);

  document.addEventListener('gesturechange', function (e) {
    e.preventDefault();
  }, false);

  document.addEventListener('gestureend', function (e) {
    e.preventDefault();
  }, false);

  // Empêche le zoom avec Ctrl+molette
  document.addEventListener('wheel', function (e) {
    if (e.ctrlKey) {
      e.preventDefault();
    }
  }, { passive: false });

  // Empêche le zoom avec Ctrl+Plus/Moins
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
      e.preventDefault();
    }
  });
}

// Lancement avec protection anti-zoom
window.addEventListener('DOMContentLoaded', () => {
  preventZoom(); // Initialise la protection anti-zoom
  mountApp();
});



