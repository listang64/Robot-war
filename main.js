// État du jeu minimal pour le menu et HUD
const state = {
  phase: "menu", // menu | playing
  players: 2,
  currentPlayerIndex: 0, // 0..3
  playerColors: ["blue", "red", "purple", "yellow"],
  turnMs: 60_000,
  turnStart: 0,
  timerId: null,
  codeBuffer: "",
  buildingSelection: null, // { type: 'silo' } | null
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
  renderApp();
}

function renderGame() {
  const wrapper = el('div', { className: 'board' });
  const canvas = el('canvas', { id: 'game' });
  wrapper.append(canvas);
  // Canvas simple pour afficher la carte (placeholder)
  setTimeout(() => {
    resizeCanvas(canvas);
    startRenderLoop(canvas);
  });
  window.addEventListener('resize', () => resizeCanvas(canvas));
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
  updateTurnBar(1);
  if (state.timerId) cancelAnimationFrame(state.timerId);
  const tick = () => {
    const elapsed = performance.now() - state.turnStart;
    const remainRatio = Math.max(0, 1 - (elapsed / state.turnMs));
    updateTurnBar(remainRatio);
    if (remainRatio > 0) {
      state.timerId = requestAnimationFrame(tick);
    } else {
      nextPlayer();
    }
  };
  state.timerId = requestAnimationFrame(tick);
}

function updateTurnBar(ratio) {
  const bar = q('#turnBar');
  if (bar) bar.style.height = `${Math.round(ratio * 100)}%`;
}

function nextPlayer() {
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players;
  drawPlayerButton();
  startTurnTimer();
}

// Rendu simple sur canvas (placeholder labyrinthe futur)
function resizeCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.floor(c.clientWidth * dpr);
  c.height = Math.floor(c.clientHeight * dpr);
}

function startRenderLoop(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = () => Math.min(2, window.devicePixelRatio || 1);
  let raf;
  function loop() {
    raf = requestAnimationFrame(loop);
    drawBackground(ctx, canvas, dpr());
  }
  raf = requestAnimationFrame(loop);
}

function drawBackground(ctx, canvas, dpr) {
  ctx.save();
  ctx.scale(dpr, dpr);
  // grille douce
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = '#2a3244';
  const size = 32;
  ctx.beginPath();
  for (let x = 0; x < w; x += size) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = 0; y < h; y += size) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Lancement
window.addEventListener('DOMContentLoaded', mountApp);


