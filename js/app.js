import { Chessground } from 'chessground';
import { Chess } from 'chess.js';

// ---------- state ----------
const S = {
  phase: 'setup',            // 'setup' | 'drill'
  chess: new Chess(),
  line: [],                  // SAN moves of the currently edited/selected line
  lineName: '',
  eco: { cache: {}, matches: [] },   // ECO database (lichess-org/chess-openings)
  mode: 'through',           // 'through' | 'end'
  userColor: 'white',
  db: 'lichess',
  ratings: new Set(['1600', '1800', '2000']),
  speeds: new Set(['blitz', 'rapid']),
  busy: false,
  token: '',
  wrongTries: 0,
  cache: new Map(),
  lastDist: null,            // {kind:'db', ...} | {kind:'prep', san}
};

const $ = (id) => document.getElementById(id);
const stripSan = (s) => s.replace(/[+#?!]+$/, '');

// ---------- SAN text parsing ----------
function parseMovesText(text) {
  const c = new Chess();
  const tokens = String(text || '').replace(/\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^\d+\.(\.\.)?/, ''))
    .filter(t => t && !/^\d+\.?$/.test(t) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
  let bad = null;
  for (const t of tokens) {
    try { c.move(t); } catch (e) { bad = t; break; }
  }
  return { moves: c.history(), bad };
}

function pgnOf(moves) {
  let out = '';
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) out += (i / 2 + 1) + '. ';
    out += moves[i] + ' ';
  }
  return out.trim();
}

// ---------- persistence ----------
function saveSettings() {
  try {
    localStorage.setItem('od-settings', JSON.stringify({
      line: S.line, lineName: S.lineName, mode: S.mode,
      userColor: S.userColor, db: S.db,
      ratings: [...S.ratings], speeds: [...S.speeds],
      token: S.token,
    }));
  } catch (e) { /* private mode */ }
}
function loadSettings() {
  try {
    const raw = localStorage.getItem('od-settings');
    if (raw) {
      const s = JSON.parse(raw);
      if (Array.isArray(s.line)) S.line = s.line;
      if (typeof s.lineName === 'string') S.lineName = s.lineName;
      if (s.mode === 'end' || s.mode === 'through') S.mode = s.mode;
      if (s.userColor === 'black' || s.userColor === 'white') S.userColor = s.userColor;
      if (s.db === 'masters' || s.db === 'lichess') S.db = s.db;
      if (Array.isArray(s.ratings) && s.ratings.length) S.ratings = new Set(s.ratings);
      if (Array.isArray(s.speeds) && s.speeds.length) S.speeds = new Set(s.speeds);
      if (typeof s.token === 'string') S.token = s.token;
    }
  } catch (e) { /* ignore */ }
}

const ECO_BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/';

async function loadEcoFile(letter) {
  if (S.eco.cache[letter]) return S.eco.cache[letter];
  const res = await fetch(ECO_BASE + letter + '.tsv');
  if (!res.ok) throw new Error('ECO database HTTP ' + res.status);
  const rows = (await res.text()).split('\n').slice(1)  // skip header
    .map(l => l.split('\t'))
    .filter(c => c.length >= 3)
    .map(c => ({ eco: c[0], name: c[1], pgn: c[2] }));
  S.eco.cache[letter] = rows;
  return rows;
}

async function ecoSearch(codeRaw) {
  const code = codeRaw.trim().toUpperCase();
  if (!/^[A-E]\d{0,2}$/.test(code)) {
    setStatus('ECO codes are a letter A–E plus up to two digits, e.g. C65 (or C6 for the whole group).', 'warn');
    return;
  }
  const sel = $('eco-variant');
  sel.innerHTML = '<option value="">loading…</option>';
  let rows;
  try { rows = await loadEcoFile(code[0].toLowerCase()); }
  catch (e) {
    sel.innerHTML = '<option value="">— no variants —</option>';
    setStatus('Could not load the ECO database from GitHub (' + e.message + '). Check connection and try again.', 'warn');
    return;
  }
  const all = rows.filter(r => r.eco.startsWith(code));
  if (!all.length) {
    S.eco.matches = [];
    sel.innerHTML = '<option value="">— no variants —</option>';
    setStatus('No openings found for ECO ' + code + '.', 'warn');
    return;
  }
  const maxMoves = parseInt($('eco-max').value, 10);
  const limited = Number.isInteger(maxMoves) && maxMoves >= 1;
  S.eco.matches = limited ? all.filter(r => fullMoveCount(r.pgn) <= maxMoves) : all;
  if (!S.eco.matches.length) {
    sel.innerHTML = '<option value="">— no variants —</option>';
    setStatus('All ' + all.length + ' variants for ECO ' + code + ' are longer than ' + maxMoves +
      (maxMoves === 1 ? ' move.' : ' moves.'), 'warn');
    return;
  }
  sel.innerHTML = '<option value="">— ' + S.eco.matches.length +
    (limited ? ' of ' + all.length : '') + ' variants, choose one —</option>' +
    S.eco.matches.map((r, i) =>
      `<option value="${i}">${r.eco} · ${r.name} (${fullMoveCount(r.pgn)})</option>`).join('');
  setStatus(S.eco.matches.length + ' variant(s) for ECO ' + code +
    (limited ? ' within ' + maxMoves + ' moves' : '') + ' — pick one to load it as your line.', '');
}

function fullMoveCount(pgn) {
  const plies = String(pgn).split(/\s+/).filter(t => t && !/^\d+\.(\.\.)?$/.test(t)).length;
  return Math.ceil(plies / 2);
}

function ecoSelect(idx) {
  const r = S.eco.matches[idx];
  if (!r) return;
  const { moves, bad } = parseMovesText(r.pgn);
  S.chess = new Chess();
  for (const san of moves) S.chess.move(san);
  S.line = moves;
  S.lineName = r.eco + ' ' + r.name;
  saveSettings();
  renderAll();
  setStatus('Loaded ' + r.eco + ' ' + r.name + ' (' + moves.length + ' plies).' +
    (bad ? ' Warning: could not parse "' + bad + '".' : ''), 'done');
}
// ---------- board ----------
let ground;

function legalDests() {
  const dests = new Map();
  for (const m of S.chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

function turnColor() { return S.chess.turn() === 'w' ? 'white' : 'black'; }

function movableColor() {
  if (S.busy) return undefined;
  if (S.phase === 'setup') return turnColor();
  return S.userColor === turnColor() ? S.userColor : undefined;
}

function lastMoveSquares() {
  const h = S.chess.history({ verbose: true });
  if (!h.length) return undefined;
  const m = h[h.length - 1];
  return [m.from, m.to];
}

function syncBoard() {
  ground.set({
    fen: S.chess.fen(),
    turnColor: turnColor(),
    lastMove: lastMoveSquares(),
    check: S.chess.inCheck(),
    movable: {
      color: movableColor(),
      dests: movableColor() ? legalDests() : new Map(),
      free: false,
    },
  });
}

function ply() { return S.chess.history().length; }
function inPrep() { return S.phase === 'drill' && S.mode === 'through' && ply() < S.line.length; }

function onUserMove(from, to) {
  let mv;
  try { mv = S.chess.move({ from, to, promotion: 'q' }); }
  catch (e) { mv = null; }
  if (!mv) { syncBoard(); return; }

  if (S.phase === 'setup') {
    S.line = S.chess.history();
    saveSettings();
    renderAll();
    return;
  }

  // drill: validate against prep line while inside it
  if (S.mode === 'through' && ply() - 1 < S.line.length) {
    const expected = S.line[ply() - 1];
    if (stripSan(mv.san) !== stripSan(expected)) {
      S.chess.undo();
      S.wrongTries++;
      if (S.wrongTries >= 2) {
        setStatus('Prep says ' + expected + ' here (move ' + moveLabel(ply()) + ').', 'warn');
      } else {
        setStatus('That is not your prep move — try again. (Second miss reveals it.)', 'warn');
      }
      syncBoard();
      return;
    }
    S.wrongTries = 0;
  }

  renderAll();
  opponentTurn();
}

function moveLabel(plyIdx) {
  const n = Math.floor(plyIdx / 2) + 1;
  return plyIdx % 2 === 0 ? n + '.' : n + '...';
}

// ---------- explorer API ----------
function explorerUrl(fen) {
  const base = 'https://explorer.lichess.ovh/';
  if (S.db === 'masters') {
    return base + 'masters?fen=' + encodeURIComponent(fen) + '&moves=15&topGames=0';
  }
  return base + 'lichess?variant=standard' +
    '&fen=' + encodeURIComponent(fen) +
    '&speeds=' + [...S.speeds].join(',') +
    '&ratings=' + [...S.ratings].join(',') +
    '&moves=15&topGames=0&recentGames=0';
}

function authHeaders() {
  return S.token ? { headers: { Authorization: 'Bearer ' + S.token } } : {};
}

async function fetchExplorer(fen) {
  const key = S.db + '|' + [...S.speeds].join() + '|' + [...S.ratings].join() + '|' + fen;
  if (S.cache.has(key)) return S.cache.get(key);
  const res = await fetch(explorerUrl(fen), authHeaders());
  if (res.status === 429) {
    setStatus('Rate limited by Lichess — waiting 10 s…', 'warn');
    await new Promise(r => setTimeout(r, 10000));
    return fetchExplorer(fen);
  }
  if (!res.ok) throw new Error('Explorer HTTP ' + res.status);
  const json = await res.json();
  S.cache.set(key, json);
  return json;
}

function sampleMove(data) {
  const moves = data.moves || [];
  const weights = moves.map(m => (m.white + m.draws + m.black));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!moves.length || total === 0) return null;
  let r = Math.random() * total;
  for (let i = 0; i < moves.length; i++) {
    r -= weights[i];
    if (r < 0) return { move: moves[i], total, moves, weights };
  }
  return { move: moves[moves.length - 1], total, moves, weights };
}

// ---------- opponent ----------
async function opponentTurn() {
  if (S.phase !== 'drill') return;
  if (S.chess.isGameOver()) { endOfLine('Game over: ' + resultText()); return; }
  if (turnColor() === S.userColor) {
    if (inPrep()) setStatus('Prep phase — your move (' + prepProgress() + ').', 'prep');
    return;
  }

  // scripted reply while inside the prep line
  if (inPrep()) {
    S.busy = true;
    syncBoard();
    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    const san = S.line[ply()];
    try { S.chess.move(san); }
    catch (e) {
      S.busy = false;
      setStatus('Prep line contains an illegal move here (' + san + ') — fix the line in setup.', 'warn');
      syncBoard();
      return;
    }
    S.lastDist = { kind: 'prep', san };
    S.busy = false;
    renderAll();
    if (ply() >= S.line.length) {
      setStatus('End of prep — database opponent is live.', 'live');
    } else {
      setStatus('Prep phase — your move (' + prepProgress() + ').', 'prep');
    }
    if (S.chess.isGameOver()) endOfLine('Game over: ' + resultText());
    return;
  }

  // database reply
  S.busy = true;
  syncBoard();
  setStatus('Consulting database…', 'live');
  let data;
  try { data = await fetchExplorer(S.chess.fen()); }
  catch (e) {
    S.busy = false;
    const sandboxed = (location.protocol === 'about:' || location.hostname.includes('claude') ||
      (e instanceof TypeError));
    if (sandboxed && location.protocol !== 'file:' && location.protocol !== 'http:' && location.protocol !== 'https:') {
      setStatus('The database is unreachable from this embedded preview. Download the file and open it directly in your browser.', 'warn');
    } else if (e instanceof TypeError) {
      setStatus('Could not reach explorer.lichess.ovh (blocked or offline). If viewing inside a chat preview, download the file and open it in your browser, then Retry.', 'warn');
    } else if (e.message && e.message.includes('401')) {
      setStatus('Lichess rejected the API token (401). Update it via ⚙ Settings, then press Retry.', 'warn');
    } else {
      setStatus('Explorer request failed (' + e.message + ') — press Retry.', 'warn');
    }
    $('btn-retry').style.display = '';
    syncBoard();
    return;
  }
  $('btn-retry').style.display = 'none';

  const picked = sampleMove(data);
  const totalGames = (data.white || 0) + (data.draws || 0) + (data.black || 0);
  if (!picked || totalGames < 1) {
    S.busy = false;
    endOfLine('Out of book — no games from this position with the current filters.');
    return;
  }

  await new Promise(r => setTimeout(r, 350 + Math.random() * 350));

  S.lastDist = { kind: 'db', ...picked, totalGames };
  let applied = false;
  try { S.chess.move(picked.move.san); applied = true; } catch (e) { /* try uci */ }
  if (!applied) {
    try {
      S.chess.move({ from: picked.move.uci.slice(0, 2), to: picked.move.uci.slice(2, 4), promotion: picked.move.uci[4] || 'q' });
      applied = true;
    } catch (e) { /* give up */ }
  }
  if (!applied) {
    S.busy = false;
    setStatus('Explorer returned a move that does not fit this position (' + picked.move.san + '). Restart the drill.', 'warn');
    syncBoard();
    return;
  }

  S.busy = false;
  renderAll();
  setStatus('Database opponent — your move.', 'live');
  if (S.chess.isGameOver()) endOfLine('Game over: ' + resultText());
}

function prepProgress() {
  return 'move ' + Math.min(ply() + 1, S.line.length) + ' of ' + S.line.length + ' in line';
}

// ---------- analysis (Lichess cloud eval) ----------
async function analyzePosition() {
  if (S.phase !== 'drill' || S.busy) return;
  const fen = S.chess.fen();
  $('analysis').innerHTML = '<div class="dist-hint">Fetching cloud evaluation…</div>';
  let res;
  try {
    res = await fetch('https://lichess.org/api/cloud-eval?multiPv=3&fen=' + encodeURIComponent(fen), authHeaders());
  } catch (e) {
    $('analysis').innerHTML = '<div class="dist-hint">Could not reach lichess.org — ' + lichessLink(fen) + '</div>';
    return;
  }
  if (res.status === 404) {
    $('analysis').innerHTML = '<div class="dist-hint">Position not in the cloud cache — ' + lichessLink(fen) + '</div>';
    return;
  }
  if (!res.ok) {
    $('analysis').innerHTML = '<div class="dist-hint">Cloud eval error (HTTP ' + res.status + ') — ' + lichessLink(fen) + '</div>';
    return;
  }
  const data = await res.json();
  renderAnalysis(fen, data);
}

function lichessLink(fen) {
  const url = 'https://lichess.org/analysis/' + fen.replace(/ /g, '_');
  return '<a href="' + url + '" target="_blank" rel="noopener">open full analysis on Lichess ↗</a>';
}

function evalText(pv, sideToMove) {
  if (typeof pv.mate === 'number') return (pv.mate > 0 ? '+#' : '-#') + Math.abs(pv.mate);
  // cloud-eval cp is from the side to move's perspective; normalize to White's
  let cp = pv.cp;
  if (sideToMove === 'b') cp = -cp;
  return (cp >= 0 ? '+' : '−') + (Math.abs(cp) / 100).toFixed(2);
}

function pvToSan(fen, uciMoves, maxPlies) {
  const c = new Chess(fen);
  const out = [];
  for (const u of uciMoves.slice(0, maxPlies)) {
    try {
      const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
      out.push(mv.san);
    } catch (e) { break; }
  }
  return out;
}

function renderAnalysis(fen, data) {
  const stm = fen.split(' ')[1];
  const startMoveNo = parseInt(fen.split(' ')[5], 10) || 1;
  let html = '<div class="dist-head">Stockfish cloud · depth ' + (data.depth || '?') + '</div>';
  (data.pvs || []).forEach((pv, idx) => {
    const sans = pvToSan(fen, String(pv.moves || '').split(' '), 8);
    // number the SAN line correctly
    let lineTxt = '';
    let n = startMoveNo;
    let whiteToMove = stm === 'w';
    sans.forEach((s, i) => {
      if (whiteToMove) { lineTxt += n + '. ' + s + ' '; }
      else { lineTxt += (i === 0 ? n + '... ' : '') + s + ' '; n++; }
      whiteToMove = !whiteToMove;
    });
    html += '<div class="pv-row">' +
      '<span class="pv-eval">' + evalText(pv, stm) + '</span>' +
      '<span class="pv-line">' + lineTxt.trim() + '</span></div>';
  });
  html += '<div class="dist-hint" style="margin-top:6px">' + lichessLink(fen) + '</div>';
  $('analysis').innerHTML = html;
}

function clearAnalysis() {
  const el = $('analysis');
  if (el) el.innerHTML = '<div class="dist-hint">Press Analyze during a drill to get Stockfish cloud evaluation and the top engine lines for the current position.</div>';
}

function resultText() {
  if (S.chess.isCheckmate()) return turnColor() === S.userColor ? 'you got mated.' : 'you delivered mate.';
  if (S.chess.isDraw()) return 'draw.';
  return 'finished.';
}

function endOfLine(msg) { setStatus(msg + '  Restart to drill again.', 'done'); }

// ---------- drill control ----------
function startDrill() {
  S.phase = 'drill';
  S.wrongTries = 0;
  S.chess = new Chess();
  if (S.mode === 'end') {
    for (const san of S.line) { try { S.chess.move(san); } catch (e) { break; } }
  }
  S.lastDist = null;
  ground.set({ orientation: S.userColor });
  if (S.mode === 'through' && S.line.length) {
    setStatus('Prep phase — play your line from move 1.', 'prep');
  } else {
    setStatus('Drill running — you play ' + S.userColor + '.', 'live');
  }
  renderAll();
  opponentTurn();
}

function backToSetup() {
  S.phase = 'setup';
  S.busy = false;
  S.chess = new Chess();
  for (const san of S.line) { try { S.chess.move(san); } catch (e) { break; } }
  S.lastDist = null;
  $('gate-connect').addEventListener('click', gateConnect);
  $('gate-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') gateConnect(); });
  $('gate-cancel').addEventListener('click', hideGate);
  $('btn-settings').addEventListener('click', () =>
    showGate('Change your Lichess API token.', { cancellable: true }));

  setStatus('Setup: pick a line, play moves on the board, or paste text.', '');
  renderAll();
  startupGate();
}

function undoPair() {
  if (S.phase !== 'drill' || S.busy) return;
  const floor = S.mode === 'end' ? S.line.length : 0;
  if (ply() <= floor) return;
  S.chess.undo();
  if (ply() > floor && turnColor() !== S.userColor) S.chess.undo();
  S.lastDist = null;
  setStatus('Took back — your move.', 'live');
  renderAll();
  opponentTurn();
}

// ---------- rendering ----------
function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (kind || '');
}

function renderMoveList() {
  const el = $('moves');
  const h = S.chess.history();
  let html = '';
  for (let i = 0; i < h.length; i += 2) {
    const n = i / 2 + 1;
    const cls = (j) => (j < S.line.length && (S.phase === 'setup' || stripSan(h[j] || '') === stripSan(S.line[j] || ''))) ? 'prep' : '';
    const w = h[i] ? `<span class="mv ${cls(i)}">${h[i]}</span>` : '';
    const b = h[i + 1] ? `<span class="mv ${cls(i + 1)}">${h[i + 1]}</span>` : '';
    html += `<span class="num">${n}.</span>${w}${b} `;
  }
  el.innerHTML = html || '<span class="empty">no moves yet</span>';
}

function fmtGames(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function renderDist() {
  const box = $('dist');
  if (!S.lastDist) {
    box.innerHTML = '<div class="dist-hint">While inside your prep line the opponent plays the scripted moves. After the line ends, replies are sampled from the database with real-game probabilities and the distribution appears here.</div>';
    return;
  }
  if (S.lastDist.kind === 'prep') {
    box.innerHTML = '<div class="dist-head">prep line — scripted reply <b>' + S.lastDist.san + '</b></div>' +
      '<div class="dist-hint">Database sampling starts when the line ends.</div>';
    return;
  }
  const { moves, weights, move, totalGames } = S.lastDist;
  const total = weights.reduce((a, b) => a + b, 0);
  let rows = `<div class="dist-head">${fmtGames(totalGames)} games in position · sampled reply <b>${move.san}</b></div>`;
  moves.slice(0, 8).forEach((m, i) => {
    const p = total ? (weights[i] / total * 100) : 0;
    const chosen = m.uci === move.uci;
    rows += `
      <div class="bar-row ${chosen ? 'chosen' : ''}">
        <span class="bar-san">${m.san}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${p.toFixed(1)}%"></span></span>
        <span class="bar-pct">${p.toFixed(1)}%</span>
      </div>`;
  });
  box.innerHTML = rows;
}

function renderControls() {
  $('setup-panel').style.display = S.phase === 'setup' ? '' : 'none';
  $('drill-panel').style.display = S.phase === 'drill' ? '' : 'none';
  if (S.phase === 'drill') {
    $('drill-line-info').textContent =
      (S.lineName || 'Unnamed line') + ' · ' +
      (S.mode === 'through' ? 'playing through from move 1' : 'starting at end of line') +
      ' · you are ' + S.userColor;
    const floor = S.mode === 'end' ? S.line.length : 0;
    $('btn-undo').disabled = S.busy || ply() <= floor;
  }
  $('line-input').value = pgnOf(S.line);
  document.querySelectorAll('[data-color]').forEach(b =>
    b.classList.toggle('on', b.dataset.color === S.userColor));
  document.querySelectorAll('[data-db]').forEach(b =>
    b.classList.toggle('on', b.dataset.db === S.db));
  document.querySelectorAll('[data-mode]').forEach(b =>
    b.classList.toggle('on', b.dataset.mode === S.mode));
  document.querySelectorAll('[data-rating]').forEach(b =>
    b.classList.toggle('on', S.ratings.has(b.dataset.rating)));
  document.querySelectorAll('[data-speed]').forEach(b =>
    b.classList.toggle('on', S.speeds.has(b.dataset.speed)));
  $('lichess-filters').style.display = S.db === 'lichess' ? '' : 'none';
}

function renderAll() {
  syncBoard();
  renderMoveList();
  renderDist();
  clearAnalysis();
  renderControls();
}


// ---------- connection gate ----------
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

async function validateConnection() {
  // returns 'ok' | 'auth' | 'net'
  try {
    const res = await fetch(
      'https://explorer.lichess.ovh/lichess?variant=standard&speeds=blitz&ratings=1600&moves=1&topGames=0&recentGames=0&fen=' +
      encodeURIComponent(START_FEN), authHeaders());
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'auth';
    return 'net';
  } catch (e) {
    return 'net';
  }
}

function showGate(msg, { cancellable = false } = {}) {
  $('gate-msg').textContent = msg;
  $('gate-token').value = S.token;
  $('gate-cancel').style.display = cancellable ? '' : 'none';
  $('gate-status').textContent = '';
  $('gate').style.display = '';
  $('app-main').style.display = 'none';
  $('btn-settings').style.display = 'none';
  $('btn-home').style.display = 'none';
}

function hideGate() {
  $('gate').style.display = 'none';
  $('app-main').style.display = '';
  $('btn-settings').style.display = '';
  $('btn-home').style.display = '';
}

async function gateConnect() {
  const entered = $('gate-token').value.trim();
  if (!entered) {
    $('gate-status').textContent = 'Please paste a token first.';
    $('gate-status').className = 'status warn';
    return;
  }
  if (entered !== S.token) {
    S.token = entered;
    S.cache.clear();
    saveSettings();
  }
  $('gate-status').textContent = 'Testing connection to Lichess…';
  $('gate-status').className = 'status live';
  $('gate-connect').disabled = true;
  const result = await validateConnection();
  $('gate-connect').disabled = false;
  if (result === 'ok') {
    hideGate();
    setStatus('Connected to Lichess. ' + (S.phase === 'setup' ? 'Pick a line or play moves to define one.' : ''), 'done');
  } else if (result === 'auth') {
    $('gate-status').textContent = 'Lichess rejected this token (401). Check it at lichess.org/account/oauth/token or create a new one, then try again.';
    $('gate-status').className = 'status warn';
  } else {
    $('gate-status').textContent = 'Could not reach Lichess. Check your Internet connection and press Connect again — or enter a different token.';
    $('gate-status').className = 'status warn';
  }
}

async function startupGate() {
  if (!S.token) {
    showGate('Enter your Lichess API token to begin.');
    return;
  }
  showGate('Checking connection to Lichess…');
  $('gate-status').textContent = 'Testing stored token…';
  $('gate-status').className = 'status live';
  const result = await validateConnection();
  if (result === 'ok') { hideGate(); return; }
  if (result === 'auth') {
    showGate('Your stored token was rejected by Lichess. Enter a new API token.');
  } else {
    showGate('Could not reach Lichess. Check your Internet connection and press Connect to retry — or enter a new token if the problem persists.');
  }
}

// ---------- wiring ----------
function init() {
  loadSettings();

  ground = Chessground($('board'), {
    coordinates: true,
    animation: { duration: 180 },
    movable: { free: false, showDests: true, events: { after: onUserMove } },
    draggable: { showGhost: true },
    orientation: S.userColor,
  });

  S.chess = new Chess();
  for (const san of S.line) { try { S.chess.move(san); } catch (e) { break; } }

  $('btn-start').addEventListener('click', () => { saveSettings(); startDrill(); });
  $('btn-home').addEventListener('click', backToSetup);
  $('btn-restart').addEventListener('click', startDrill);
  $('btn-undo').addEventListener('click', undoPair);
  $('btn-analyze').addEventListener('click', analyzePosition);
  $('btn-retry').addEventListener('click', () => {
    $('btn-retry').style.display = 'none';
    opponentTurn();
  });
  $('btn-clear').addEventListener('click', () => {
    S.chess = new Chess(); S.line = []; S.lineName = ''; saveSettings(); renderAll();
  });
  $('btn-take-back').addEventListener('click', () => {
    S.chess.undo(); S.line = S.chess.history(); saveSettings(); renderAll();
  });
  $('btn-load').addEventListener('click', () => {
    const { moves, bad } = parseMovesText($('line-input').value);
    S.chess = new Chess();
    for (const san of moves) S.chess.move(san);
    S.line = moves;
    saveSettings(); renderAll();
    if (bad) setStatus('Could not parse "' + bad + '" — loaded up to that point.', 'warn');
  });
  let ecoTimer = null;
  const ecoTrigger = () => {
    const digits = $('eco-num').value.trim();
    clearTimeout(ecoTimer);
    if (!/^\d{1,2}$/.test(digits)) {
      $('eco-variant').innerHTML = '<option value="">— variants appear here —</option>';
      return;
    }
    // 2 digits: search immediately; 1 digit: brief debounce in case a second is coming
    ecoTimer = setTimeout(() => ecoSearch($('eco-letter').value + digits),
      digits.length === 2 ? 0 : 350);
  };
  $('eco-num').addEventListener('input', ecoTrigger);
  $('eco-letter').addEventListener('change', ecoTrigger);
  $('eco-max').addEventListener('input', ecoTrigger);
  $('eco-variant').addEventListener('change', (e) => { if (e.target.value !== '') ecoSelect(parseInt(e.target.value, 10)); });

  document.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => {
    S.userColor = b.dataset.color;
    ground.set({ orientation: S.userColor });
    saveSettings(); renderControls();
  }));
  document.querySelectorAll('[data-db]').forEach(b => b.addEventListener('click', () => {
    S.db = b.dataset.db; saveSettings(); renderControls();
  }));
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    S.mode = b.dataset.mode; saveSettings(); renderControls();
  }));
  document.querySelectorAll('[data-rating]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.rating;
    if (S.ratings.has(v)) { if (S.ratings.size > 1) S.ratings.delete(v); }
    else S.ratings.add(v);
    saveSettings(); renderControls();
  }));
  document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.speed;
    if (S.speeds.has(v)) { if (S.speeds.size > 1) S.speeds.delete(v); }
    else S.speeds.add(v);
    saveSettings(); renderControls();
  }));

  $('gate-connect').addEventListener('click', gateConnect);
  $('gate-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') gateConnect(); });
  $('gate-cancel').addEventListener('click', hideGate);
  $('btn-settings').addEventListener('click', () =>
    showGate('Change your Lichess API token.', { cancellable: true }));

  setStatus('Setup: pick a line, play moves on the board, or paste text.', '');
  renderAll();
  startupGate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
