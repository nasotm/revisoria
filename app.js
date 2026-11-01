// Clé API Gemini : saisie par chaque utilisateur (bouton 🔑 Clé IA), stockée dans son navigateur.
// Ne jamais écrire de clé dans ce fichier : tout le code est visible par les visiteurs.
// La clé n'est PAS dans le code : chaque utilisateur la saisit dans l'app, elle reste dans son navigateur.
const GEMINI_KEY_STORAGE = 'quizmaster_gemini_key';
const getGeminiKey = () => { try { return (localStorage.getItem(GEMINI_KEY_STORAGE) || '').trim(); } catch (_) { return ''; } };
const hasGeminiKey = () => getGeminiKey() !== '';
// Demande la clé une fois (ou la modifie). Renvoie true si une clé est enregistrée.
function askGeminiKey(current = '') {
  const typed = prompt("Colle ta clé API Gemini (https://aistudio.google.com/apikey). Elle reste uniquement dans ce navigateur.\n\nLaisse vide pour supprimer la clé.", current);
  if (typed === null) return hasGeminiKey();
  try {
    if (typed.trim()) localStorage.setItem(GEMINI_KEY_STORAGE, typed.trim());
    else localStorage.removeItem(GEMINI_KEY_STORAGE);
  } catch (_) {}
  return hasGeminiKey();
}
// À utiliser avant chaque appel IA : demande la clé si elle manque.
const ensureGeminiKey = () => hasGeminiKey() || askGeminiKey();
window.openGeminiKeySettings = () => { askGeminiKey(getGeminiKey()); render(); };
// Modèle utilisé. `gemini-2.0-flash` a été ARRÊTÉ par Google le 1er juin 2026
// (tous les appels renvoyaient une erreur 404 « model not found »).
const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_ENDPOINT = () => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(getGeminiKey())}`;
const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const escapeAttr = (s) => escapeHtml(s);
const isPdfReady = () => typeof window.pdfjsLib !== 'undefined';

// Échappe une valeur destinée à une chaîne JS simple quote DANS un attribut HTML.
// Ex: onclick="f('${jsAttr(url)}')" reste valide même si url contient ' ou \.
const jsAttr = (s) => escapeHtml(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n'));

// Lecture localStorage tolérante : une valeur corrompue ne doit pas empêcher l'app de démarrer.
function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return (value === null || value === undefined) ? fallback : value;
  } catch (e) {
    console.warn('Révisoria : données locales illisibles, valeur par défaut utilisée.', e);
    return fallback;
  }
}

// Nettoie le HTML collé dans l'éditeur de mémorisation : on garde la mise en
// forme (span/mark/b/i/br...) mais on retire scripts, iframes et attributs on*.
// 🔧 FIX : le contenu était réinjecté tel quel via innerHTML (XSS au copier-coller).
function sanitizeMemoHtml(html) {
  if (!html) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  tpl.content.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form, input, textarea, button').forEach(n => n.remove());
  tpl.content.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') { el.removeAttribute(attr.name); return; }
      if ((name === 'href' || name === 'src') && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name);
    });
  });
  return tpl.innerHTML;
}

// 🔧 FIX : la clé "placeholder" était comparée en dur à 6 endroits différents.

// 🔧 FIX : un seul point d'appel pour l'API. Avant, chaque appel faisait
// `if (!data.candidates?.[0]...) throw "Réponse IA invalide"` et masquait le vrai
// message d'erreur (clé refusée, quota, modèle inexistant...).
async function callGemini(parts) {
  if (!ensureGeminiKey()) throw new Error("Aucune clé API Gemini : ajoute-la via le bouton 🔑 Clé IA.");
  const res = await fetch(GEMINI_ENDPOINT(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] })
  });
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error(`Réponse illisible de l'API (HTTP ${res.status}).`); }
  if (!res.ok || data.error) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`API Gemini : ${msg}`);
  }
  // On ignore les "parts" de raisonnement (thought) des modèles récents :
  // sinon la réflexion interne se retrouve mélangée à la réponse.
  const text = (data.candidates?.[0]?.content?.parts || [])
    .filter(p => p && !p.thought)
    .map(p => p.text || '')
    .join('');
  if (!text.trim()) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new Error(`Réponse vide de l'API${reason ? ` (${reason})` : ''}.`);
  }
  return text;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('Erreur SW:', err));
  });
}

// --- INDEXEDDB POUR LES PDF ---
// 🔧 FIX : `db` pouvait être encore `undefined` quand l'utilisateur cliquait
// tout de suite après le chargement (ouverture asynchrone). On attend dbReady.
let db = null;
const dbReady = new Promise((resolve, reject) => {
  try {
    const request = indexedDB.open("QuizMasterDB", 2);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains("pdfs")) database.createObjectStore("pdfs");
      if (!database.objectStoreNames.contains("backups")) database.createObjectStore("backups");
    };
    request.onsuccess = (e) => { db = e.target.result; resolve(db); };
    request.onerror = () => reject(request.error || new Error("IndexedDB indisponible"));
  } catch (e) { reject(e); }
});
dbReady.catch(() => {}); // évite une "unhandled rejection" si IndexedDB est bloqué

async function savePdfToDb(id, file) {
  await dbReady;
  const buffer = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
  return putPdfBuffer(id, buffer);
}
// Utilisé par la duplication de page : copie le blob PDF sous un nouvel identifiant.
async function putPdfBuffer(id, buffer) {
  await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").put(buffer, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction annulée"));
  });
}
async function getPdfFromDb(id) {
  await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pdfs", "readonly");
    const req = tx.objectStore("pdfs").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function deletePdfFromDb(id) {
  dbReady.then(() => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").delete(id);
  }).catch(() => {});
}

const DEFAULT_NOTEBOOKS = [
  {
    id: 'nb_1', title: '1ère année Pharmacie',
    sections: [
      {
        id: 'sec_1', title: 'Cardiologie',
        pages: [
          {
            id: 'page_1', title: 'Bases de la circulation',
            resources: [],
            questions: [
              {
                id: 'q1', type: 'qcs',
                statement: "Quelle valve sépare l'oreillette gauche du ventricule gauche ?",
                image: "https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80",
                choices: [{id:'a', text:"Valve tricuspide"}, {id:'b', text:"Valve mitrale"}],
                correct: ['b'], explanation: "La valve mitrale.",
                stats: { seen: 0, correct: 0 }
              }
            ]
          }
        ]
      }
    ]
  }
];

function normalizeQuestionType(t) {
  const v = String(t || 'qcs').toLowerCase().trim();
  if (v === 'qcm' || v === 'mcq' || v === 'multiple') return 'qcm';
  if (v === 'qroc' || v === 'open' || v === 'libre') return 'qroc';
  if (v === 'qnum' || v === 'numeric' || v === 'num' || v === 'calcul') return 'qnum';
  return 'qcs';
}

// 🔧 FIX : les questions importées n'étaient pas normalisées. Un `statement`
// numérique, des `correct` numériques ou des `choices` en chaînes faisaient
// planter le rendu ou rendaient la correction impossible (comparaison de types).
function normalizeQuestion(q, fallbackId) {
  const src = (q && typeof q === 'object') ? q : {};
  const choices = (Array.isArray(src.choices) ? src.choices : [])
    .map((c, i) => (c && typeof c === 'object')
      ? { id: String(c.id ?? i), text: String(c.text ?? c.label ?? '') }
      : { id: String(i), text: String(c ?? '') })
    .filter(c => c.text !== '');
  const idSet = new Set(choices.map(c => c.id));
  return {
    id: fallbackId,
    type: normalizeQuestionType(src.type),
    statement: String(src.statement ?? src.question ?? 'Question sans énoncé'),
    image: typeof src.image === 'string' ? src.image : '',
    choices,
    correct: (Array.isArray(src.correct) ? src.correct : []).map(c => String(c)).filter(c => idSet.has(c)),
    answers: (Array.isArray(src.answers) ? src.answers : []).map(a => String(a)).filter(a => a.trim() !== ''),
    // 🏷️ étiquettes transverses + favori + réponse numérique
    tags: (Array.isArray(src.tags) ? src.tags : [])
      .map(t => String(t).trim()).filter(Boolean).slice(0, 8),
    flag: src.flag === true,
    numeric: Number.isFinite(Number(src.numeric)) ? Number(src.numeric) : null,
    tolerance: Number.isFinite(Number(src.tolerance)) && Number(src.tolerance) >= 0 ? Number(src.tolerance) : 0,
    unit: typeof src.unit === 'string' ? src.unit : '',
    explanation: String(src.explanation ?? ''),
    srsData: (src.srsData && typeof src.srsData === 'object')
      ? { interval: Number(src.srsData.interval) || 0, nextDate: String(src.srsData.nextDate || localDateStr()) }
      : { interval: 0, nextDate: localDateStr() },
    stats: (src.stats && typeof src.stats === 'object')
      ? { seen: Number(src.stats.seen) || 0, correct: Number(src.stats.correct) || 0 }
      : { seen: 0, correct: 0 }
  };
}

function sanitizeImportedData(data) {
  const inputArray = Array.isArray(data) ? data : [data];
  return inputArray.filter(nb => nb && typeof nb === 'object').map((nb, i) => {
    let sections = Array.isArray(nb.sections) ? nb.sections : [];
    if (sections.length === 0 && Array.isArray(nb.questions) && nb.questions.length > 0) {
        sections = [{ title: 'Général', pages: [{ title: 'Questions importées', questions: nb.questions }] }];
    }
    return {
      id: nb.id ? (String(nb.id).replace(/[^a-zA-Z0-9_]/g, '') || 'nb_' + Date.now() + i) : 'nb_' + Date.now() + i,
      title: String(nb.title || nb.name || 'Nouveau bloc-notes'),
      sections: sections.filter(sec => sec && typeof sec === 'object').map((sec, j) => {
        let pages = Array.isArray(sec.pages) ? sec.pages : [];
        if (pages.length === 0 && Array.isArray(sec.questions) && sec.questions.length > 0) {
            pages = [{ title: 'Questions importées', questions: sec.questions }];
        }
        return {
          id: sec.id ? (String(sec.id).replace(/[^a-zA-Z0-9_]/g, '') || 'sec_' + Date.now() + i + j) : 'sec_' + Date.now() + i + j,
          title: String(sec.title || sec.name || 'Nouvelle section'),
          pages: pages.filter(page => page && typeof page === 'object').map((page, k) => {
            const questions = Array.isArray(page.questions) ? page.questions : [];
            return {
              id: page.id ? (String(page.id).replace(/[^a-zA-Z0-9_]/g, '') || 'page_' + Date.now() + i + j + k) : 'page_' + Date.now() + i + j + k,
              title: String(page.title || page.name || 'Nouvelle page'),
              resources: Array.isArray(page.resources) ? page.resources.filter(r => r && typeof r === 'object') : [],
              questions: questions.map((q, l) => {
                const fallback = 'q_' + Date.now() + i + j + k + l;
                const id = q && q.id ? (String(q.id).replace(/[^a-zA-Z0-9_]/g, '') || fallback) : fallback;
                return normalizeQuestion(q, id);
              })
            };
          })
        };
      })
    };
  });
}

let NOTEBOOKS = DEFAULT_NOTEBOOKS;
try {
  const saved = safeJsonParse(lsGet('quizmaster_notebooks_v32'), null);
  if (saved) NOTEBOOKS = sanitizeImportedData(saved);
} catch(e) {
  console.warn('Révisoria : cours sauvegardés illisibles, chargement des données par défaut.', e);
  NOTEBOOKS = DEFAULT_NOTEBOOKS;
}

let HISTORY = [];
try {
  const savedH = safeJsonParse(lsGet('quizmaster_history_v32'), []);
  // 🔧 FIX : une entrée incomplète affichait « undefined% » et cassait la hauteur
  // des barres du graphique (height: NaN%).
  HISTORY = Array.isArray(savedH) ? savedH.filter(h => h && typeof h === 'object').map(h => ({
    date: String(h.date || ''),
    mode: String(h.mode || ''),
    score: Number(h.score) || 0,
    total: Number(h.total) || 0,
    pct: Number(h.pct) || 0
  })) : [];
} catch(e) { HISTORY = []; }

// 🔧 FIX : ces deux `JSON.parse` n'étaient pas protégés. Une entrée corrompue
// dans localStorage levait une exception AVANT le premier render => page blanche.
const storedGame = safeJsonParse(lsGet('quizmaster_gamification_v32'), null);
let GAME_DATA = {
  xp: Number(storedGame?.xp) || 0,
  level: Number(storedGame?.level) || 1,
  streak: Number(storedGame?.streak) || 0,
  lastPlayed: typeof storedGame?.lastPlayed === 'string' ? storedGame.lastPlayed : null,
  lastBackup: typeof storedGame?.lastBackup === 'string' ? storedGame.lastBackup : null,
  daily: (storedGame?.daily && typeof storedGame.daily === 'object') ? storedGame.daily : {}
};
// 🎁 Récompenses : débloquées par le total d'XP gagné (GAME_DATA.xp ne baisse jamais).
const REWARDS = [
  { id: 'r50', xp: 50, icon: '🌱', title: 'Premier pas', desc: 'Gagne 50 XP.' },
  { id: 'r150', xp: 150, icon: '📘', title: 'Studieux', desc: 'Gagne 150 XP.' },
  { id: 'r300', xp: 300, icon: '🔥', title: 'Assidu', desc: 'Gagne 300 XP.' },
  { id: 'r500', xp: 500, icon: '🥈', title: 'Expert', desc: 'Gagne 500 XP.' },
  { id: 'r1000', xp: 1000, icon: '🥇', title: 'Maître', desc: 'Gagne 1000 XP.' },
  { id: 'r2000', xp: 2000, icon: '👑', title: 'Légende', desc: 'Gagne 2000 XP.' }
];
const REWARDS_SEEN_KEY = 'quizmaster_rewards_seen';
// Les récompenses déjà gagnées avant l'introduction du système ne déclenchent pas de notification.
function checkRewards() {
  const stored = safeJsonParse(lsGet(REWARDS_SEEN_KEY), null);
  const known = Array.isArray(stored) ? stored : allRewards().filter(r => GAME_DATA.xp >= r.xp).map(r => r.id);
  const newly = allRewards().filter(r => GAME_DATA.xp >= r.xp && !known.includes(r.id));
  if (!newly.length && Array.isArray(stored)) return;
  lsSet(REWARDS_SEEN_KEY, JSON.stringify([...known, ...newly.map(r => r.id)]));
  if (Array.isArray(stored) && newly.length) showRewardToast(newly);
}
function showRewardToast(rewards) {
  if (!document.body) return;
  document.querySelectorAll('.reward-toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'reward-toast';
  const list = rewards.map(r => `${r.icon} ${escapeHtml(r.title)}`).join(' · ');
  toast.innerHTML = `<span class="reward-icon">🎁</span><div><b>Récompense débloquée !</b><br>${list}</div>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}
// --- Données : erreurs, résultats par jour, récompenses personnelles ---
const MISTAKES_KEY = 'quizmaster_mistakes';
const DAILY_RESULTS_KEY = 'quizmaster_daily_results';
const CUSTOM_REWARDS_KEY = 'quizmaster_custom_rewards';
const SNAPSHOT_FIELDS = ['id', 'type', 'statement', 'choices', 'correct', 'explanation', 'numeric', 'tolerance', 'unit', 'answers', 'qrocAnswers'];
// Copie légère d'une question, pour pouvoir la rejouer même si elle a été supprimée.
function questionSnapshot(q) {
  const copy = {};
  SNAPSHOT_FIELDS.forEach(f => { if (q[f] !== undefined) copy[f] = q[f]; });
  return JSON.parse(JSON.stringify(copy));
}
// Carnet d'erreurs : une question y reste tant qu'on ne l'a pas réussie.
function updateMistakes(q, isCorrect) {
  const key = q.id || q.statement;
  const list = readPlanner(MISTAKES_KEY, []).filter(m => m.key !== key);
  if (!isCorrect) list.unshift({ key, date: localDateStr(), q: questionSnapshot(q) });
  lsSet(MISTAKES_KEY, JSON.stringify(list.slice(0, 300)));
}
// Version actuelle de la question si elle existe encore, sinon la copie enregistrée.
function mistakeQuestions() {
  const all = [];
  NOTEBOOKS.forEach(nb => (nb.sections || []).forEach(sec => (sec.pages || []).forEach(p => all.push(...(p.questions || [])))));
  return readPlanner(MISTAKES_KEY, []).map(m => all.find(q => m.q.id && q.id === m.q.id) || m.q);
}
function saveDailyResults(all) {
  const kept = {};
  Object.keys(all).sort().slice(-120).forEach(k => { kept[k] = all[k]; });
  lsSet(DAILY_RESULTS_KEY, JSON.stringify(kept));
}
function updateDay(change) {
  const all = readPlanner(DAILY_RESULTS_KEY, {});
  const today = localDateStr();
  const day = all[today] || { answered: 0, correct: 0, xp: 0 };
  change(day);
  all[today] = day;
  saveDailyResults(all);
}
function recordDailyAnswer(isCorrect) {
  updateDay(day => { day.answered++; if (isCorrect) day.correct++; });
}
// Ajoute de l'XP et le note pour le jour (utilisé par le rapport hebdomadaire).
function addDailyXp(amount) {
  GAME_DATA.xp += amount;
  updateDay(day => { day.xp += amount; });
}
// Totaux sur 7 jours ; offset 0 = les 7 derniers jours, 7 = la semaine précédente.
function weekTotals(offset) {
  const all = readPlanner(DAILY_RESULTS_KEY, {});
  const totals = { answered: 0, correct: 0, xp: 0 };
  for (let i = offset; i < offset + 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = all[localDateStr(d)];
    if (day) { totals.answered += day.answered || 0; totals.correct += day.correct || 0; totals.xp += day.xp || 0; }
  }
  return totals;
}
// Récompenses définies par l'utilisateur, débloquées à un objectif d'XP.
function customRewards() {
  // Lu directement : cette fonction sert dès le chargement, avant readPlanner.
  const saved = safeJsonParse(lsGet(CUSTOM_REWARDS_KEY), []);
  return (Array.isArray(saved) ? saved : []).filter(r => r && r.title && Number(r.xp) > 0);
}
function allRewards() {
  return REWARDS.concat(customRewards().map(r => ({ id: r.id, xp: Number(r.xp), icon: '🎯', title: r.title, desc: `Gagne ${Number(r.xp)} XP.`, custom: true })));
}

// 🎯 CATÉGORIE 4.3 : Objectif quotidien (persistant dans localStorage)
const storedGoal = safeJsonParse(lsGet('quizmaster_daily_goal'), null);
let DAILY_GOAL = {
  target: Number(storedGoal?.target) > 0 ? Number(storedGoal.target) : 20,  // questions visées / jour
  today: typeof storedGoal?.today === 'string' ? storedGoal.today : null,   // date YYYY-MM-DD
  count: Number(storedGoal?.count) || 0                                     // questions répondues aujourd'hui
};

// Reset automatique si on change de jour
const _todayStr = localDateStr();
if (DAILY_GOAL.today !== _todayStr) {
  DAILY_GOAL.today = _todayStr;
  DAILY_GOAL.count = 0;
  lsSet('quizmaster_daily_goal', JSON.stringify(DAILY_GOAL));
}

function saveDailyGoal() {
  lsSet('quizmaster_daily_goal', JSON.stringify(DAILY_GOAL));
}

function incrementDailyGoal() {
  const today = localDateStr();
  if (DAILY_GOAL.today !== today) { DAILY_GOAL.today = today; DAILY_GOAL.count = 0; }
  DAILY_GOAL.count += 1;
  // 📊 Historique jour par jour pour la heatmap (persisté par saveData()).
  if (!GAME_DATA.daily || typeof GAME_DATA.daily !== 'object') GAME_DATA.daily = {};
  GAME_DATA.daily[today] = (GAME_DATA.daily[today] || 0) + 1;
  saveDailyGoal();
}

window.editDailyGoal = () => {
  showPromptModal("Objectif quotidien", "Combien de questions par jour ? (ex: 20)", (val) => {
    const n = parseInt(val, 10);
    if (!n || n < 1 || n > 500) return alert("Choisis un nombre entre 1 et 500.");
    DAILY_GOAL.target = n;
    saveDailyGoal();
    render();
  });
};

const savedTheme = lsGet('quizmaster_theme') || 'dark';
const savedColor = lsGet('quizmaster_color') || 'blue';
const savedFocus = lsGet('quizmaster_focus') === 'true';

document.documentElement.setAttribute('data-theme', savedTheme);
applyAccent(savedColor, lsGet('quizmaster_color_custom'));
// Demande au navigateur de ne pas effacer les données quand il manque de place.
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if (savedFocus) document.body.classList.add('focus-mode');

// 🔧 FIX : si le navigateur bloque le stockage (navigation privée, cookies
// interdits), `localStorage.getItem` lève une SecurityError AVANT le premier
// render => page blanche. Ces deux helpers ne lèvent jamais.
function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { console.warn('Révisoria : écriture locale impossible.', e); }
}

let storageWarned = false;
function saveData() {
  // 🔧 FIX : un localStorage plein (QuotaExceededError) faisait planter le quiz
  // en pleine réponse, sans message compréhensible.
  try {
    localStorage.setItem('quizmaster_notebooks_v32', JSON.stringify(NOTEBOOKS));
    localStorage.setItem('quizmaster_history_v32', JSON.stringify(HISTORY));
    localStorage.setItem('quizmaster_gamification_v32', JSON.stringify(GAME_DATA));
  } catch (e) {
    if (!storageWarned) {
      storageWarned = true;
      alert("⚠️ Sauvegarde impossible : l'espace de stockage du navigateur est plein.\n\nTes données restent utilisables, mais elles seront perdues si tu recharges la page. Pense à exporter ta sauvegarde (.json).");
    }
    console.warn('Révisoria : échec de sauvegarde locale.', e);
  }
  checkRewards();
}

// Keep a rolling local recovery point in IndexedDB once per week. This stays
// separate from localStorage so the backup does not double its quota usage.
async function createWeeklyAutoBackup() {
  const today = localDateStr();
  const last = lsGet('quizmaster_auto_backup_date');
  if (last) {
    const age = (new Date(today + 'T00:00:00') - new Date(last + 'T00:00:00')) / 86400000;
    if (Number.isFinite(age) && age < 7) return;
  }
  try {
    await dbReady;
    const snapshot = { createdAt: new Date().toISOString(), notebooks: NOTEBOOKS, history: HISTORY, gameData: GAME_DATA };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('backups', 'readwrite');
      tx.objectStore('backups').put(snapshot, 'latest');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    lsSet('quizmaster_auto_backup_date', today);
  } catch (e) { console.warn('Révisoria : sauvegarde automatique indisponible.', e); }
}
window.restoreAutoBackup = async () => {
  try {
    await dbReady;
    const backup = await new Promise((resolve, reject) => {
      const tx = db.transaction('backups', 'readonly');
      const req = tx.objectStore('backups').get('latest');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    if (!backup?.notebooks) return alert('Aucune sauvegarde automatique disponible.');
    if (!confirm('Restaurer la sauvegarde automatique du ' + new Date(backup.createdAt).toLocaleString('fr-FR') + ' ? Les données actuelles seront remplacées.')) return;
    NOTEBOOKS = sanitizeImportedData(backup.notebooks);
    HISTORY = Array.isArray(backup.history) ? backup.history : [];
    if (backup.gameData) GAME_DATA = backup.gameData;
    saveData(); render();
    alert('Sauvegarde restaurée.');
  } catch (e) { alert('Impossible de restaurer la sauvegarde automatique.'); }
};
window.addEventListener('load', () => { createWeeklyAutoBackup(); });

// ============================================================
// 🗃️ VERSION DU STOCKAGE + MIGRATIONS
// ============================================================
// Toute évolution du modèle de données incrémente SCHEMA_VERSION et ajoute une
// étape dans migrateStore(). Sans ça, un ancien format pouvait casser le rendu.
const SCHEMA_VERSION = 3;

function migrateStore() {
  const from = Number(lsGet('quizmaster_schema')) || 0;
  if (from >= SCHEMA_VERSION) return;

  // v0 -> v3 : normalisation des questions (étiquettes, favori, QNUM) et des
  // badges. sanitizeImportedData() conserve les identifiants existants.
  NOTEBOOKS = sanitizeImportedData(NOTEBOOKS);
  if (!Array.isArray(GAME_DATA.badges)) GAME_DATA.badges = [];
  if (!GAME_DATA.daily || typeof GAME_DATA.daily !== 'object') GAME_DATA.daily = {};

  saveData();
  lsSet('quizmaster_schema', String(SCHEMA_VERSION));
  console.info('Révisoria : données migrées depuis la version ' + from + ' vers ' + SCHEMA_VERSION + '.');
}

migrateStore();

const state = {
  screen: 'welcome',
  theme: savedTheme,
  color: savedColor,
  focusMode: savedFocus,
  activeNbId: NOTEBOOKS[0]?.id || null,
  activeSecId: NOTEBOOKS[0]?.sections[0]?.id || null,
  activePageId: null,
  mode: 'training', nbQuestions: 10,
  questions: [], answers: [], index: 0, revealed: false,
  timerId: null, timeLimit: 0, remaining: 0,
  lives: 3,
  negativePoints: false,
  searchQuery: '',
  notebooksCollapsed: window.innerWidth <= 768,
  sectionsCollapsed: window.innerWidth <= 768,
  editor: { isOpen: false, type: 'qcs', statement: '', image: '', choices: ['', '', '', ''], correct: [], qrocAnswers: '', explanation: '' },
  lastEarnedXp: 0,
  memoText: '',   // 🔧 FIX 8: HTML de l'éditeur contenteditable
  memoHtml: ''    // 🔧 FIX 8: HTML du texte à trous (cloze)
};

// --- UTILS ---
const normalize = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const fmtTime = s => `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
// 🔧 FIX : tout était daté en UTC (`toISOString`), donc à Paris le streak et
// l'objectif quotidien changeaient de jour à 1 h/2 h du matin au lieu de minuit.
// Toutes les dates « jour » passent maintenant par cette fonction locale.
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Lecture tolérante d'une réponse numérique : "2,5 mg", "2.5", "5/2", "1 200".
function parseNumeric(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const fraction = raw.match(/^(-?\d+(?:[.,]\d+)?)\s*\/\s*(-?\d+(?:[.,]\d+)?)$/);
  if (fraction) {
    const num = Number(fraction[1].replace(',', '.'));
    const den = Number(fraction[2].replace(',', '.'));
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    return num / den;
  }
  const cleaned = raw.replace(/\s/g, '').replace(',', '.').replace(/[^0-9eE+\-.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function grade(q, a) {
  if (q.type === 'qroc') {
    const user = normalize(a.text); if (!user) return false;
    const accepted = (q.answers || []).map(normalize).filter(Boolean);
    if (!accepted.length) return false; // 🔧 FIX : une réponse acceptée vide validait n'importe quoi
    return accepted.some(ans => ans === user || ans.includes(user) || user.includes(ans));
  }
  if (q.type === 'qnum') {
    const expected = Number(q.numeric);
    if (!Number.isFinite(expected)) return false;
    const user = parseNumeric(a.text);
    if (user === null) return false;
    const tol = Math.max(0, Number(q.tolerance) || 0);
    return Math.abs(user - expected) <= tol + 1e-9;
  }
  const selected = Array.isArray(a.selected) ? a.selected : [];
  const correct = Array.isArray(q.correct) ? q.correct : [];
  return selected.length > 0 && [...selected].sort().join(',') === [...correct].sort().join(',');
}
function updateQuestionStats(q, isCorrect) {
  if (!q.stats) q.stats = { seen: 0, correct: 0 };
  q.stats.seen += 1;
  if (isCorrect) q.stats.correct += 1;
  incrementDailyGoal();  // 🎯 CATÉGORIE 4.3 : compte chaque réponse du jour
  saveData();
}
// Réponse correcte lisible, quel que soit le type de question.
function correctAnswerText(q) {
  if (q.type === 'qroc') return (q.answers || []).join(' / ');
  if (q.type === 'qnum') return `${q.numeric}${q.unit ? ' ' + q.unit : ''}`;
  return (q.choices || []).filter(c => (q.correct || []).includes(c.id)).map(c => c.text).join(' · ');
}

// 🔧 FIX : centralise l'enregistrement d'une réponse. Avant, le mode SRS
// comptait chaque question DEUX fois (checkAnswer puis selfGradeSRS).
function recordAnswer(q, a, isCorrect, difficulty = null) {
  if (!q || !a || a.recorded) return;
  a.recorded = true;
  a.correct = !!isCorrect;
  updateSRS(q, !!isCorrect, difficulty);
  updateQuestionStats(q, !!isCorrect);
  updateMistakes(q, !!isCorrect);
  recordDailyAnswer(!!isCorrect);
}
function updateSRS(q, isCorrect, difficulty = null) {
  if (!q.srsData) q.srsData = { interval: 0, nextDate: '' };
  let interval = q.srsData.interval || 0;
  if (difficulty === 'easy') { interval = interval === 0 ? 4 : Math.round(interval * 2.5); }
  else if (difficulty === 'hard') { interval = 0; }
  else {
    if (isCorrect) {
      if (interval === 0) interval = 1;
      else if (interval === 1) interval = 3;
      else if (interval === 3) interval = 7;
      else if (interval === 7) interval = 14;
      else if (interval === 14) interval = 30;
      else interval = Math.round(interval * 1.5);
    } else { interval = 0; }
  }
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + interval);
  q.srsData.interval = interval;
  q.srsData.nextDate = localDateStr(nextDate);
  saveData();
}

// --- AUDIO ---
window.stopSpeaking = () => { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); };
function getBestFrenchVoice() {
  const voices = window.speechSynthesis.getVoices();
  return voices.find(v => v.lang.includes('fr') && v.name.includes('Google'))
      || voices.find(v => v.lang.includes('fr') && v.name.includes('Microsoft'))
      || voices.find(v => v.lang.includes('fr'));
}
window.readCurrentQuestion = () => {
  if (!('speechSynthesis' in window)) return alert("Ton navigateur ne supporte pas la lecture audio.");
  if (window.speechSynthesis.speaking) return window.stopSpeaking();
  const q = state.questions[state.index]; if (!q) return;
  let textToRead = q.statement + ". ";
  if (q.choices && q.choices.length > 0) q.choices.forEach((c, i) => { textToRead += `Choix ${String.fromCharCode(65 + i)} : ${c.text}. `; });
  const utterance = new SpeechSynthesisUtterance(textToRead);
  utterance.lang = 'fr-FR'; utterance.rate = 1.0;
  const voice = getBestFrenchVoice(); if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
};
window.readExplanation = () => {
  if (!('speechSynthesis' in window)) return alert("Ton navigateur ne supporte pas la lecture audio.");
  if (window.speechSynthesis.speaking) return window.stopSpeaking();
  const q = state.questions[state.index]; if (!q) return;
  let textToRead = "";
  if (state.revealed) textToRead += "La bonne réponse était : " + correctAnswerText(q) + ". ";
  textToRead += q.explanation ? q.explanation : "Pas d'explication.";
  const utterance = new SpeechSynthesisUtterance(textToRead);
  utterance.lang = 'fr-FR'; utterance.rate = 1.0;
  const voice = getBestFrenchVoice(); if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
};

// 🔧 FIX 16: endpoint centralisé + guard réponse + escapeHtml
window.explainWithAI = async (btn) => {
  if (!ensureGeminiKey()) return;
  const q = state.questions[state.index];
  const a = state.answers[state.index];
  const originalText = btn.innerHTML;
  btn.innerHTML = "⏳ Réflexion..."; btn.disabled = true;
  const expectedAnswer = correctAnswerText(q);
  const userAnswerText = (q.type === 'qroc' || q.type === 'qnum') ? a.text : q.choices.filter(c => a.selected.includes(c.id)).map(c => c.text).join(', ');
  const prompt = `Tu es un professeur pédagogue. L'élève a répondu faux à cette question :
Question : "${q.statement}"
Sa réponse : "${userAnswerText || 'Aucune'}"
La bonne réponse : "${expectedAnswer}"
Explication originale : "${q.explanation || 'Aucune'}"

Réponds en 3 parties courtes :
1. Pourquoi sa réponse est incorrecte.
2. Une explication simple de la bonne réponse.
3. Une astuce mnémotechnique pour s'en souvenir.`;
  try {
    const text = await callGemini([{ text: prompt }]);
    const aiBlock = document.createElement('div');
    aiBlock.className = 'fb';
    aiBlock.style.background = 'rgba(139, 92, 246, 0.1)';
    aiBlock.style.borderLeft = '4px solid var(--accent)';
    aiBlock.style.marginTop = '15px';
    aiBlock.innerHTML = `<b>🤖 Explication de l'IA :</b><br>${escapeHtml(text).replace(/\n/g, '<br>')}`;
    btn.parentNode.appendChild(aiBlock);
    btn.remove();
  } catch (e) {
    alert("Erreur IA : " + e.message);
    btn.innerHTML = originalText; btn.disabled = false;
  }
};
window.toggleTheme = () => {
  const newTheme = state.theme === 'dark' ? 'light' : 'dark';
  state.theme = newTheme;
  document.documentElement.setAttribute('data-theme', newTheme);
  lsSet('quizmaster_theme', newTheme);
  render();
};
// Couleurs d'accent prédéfinies (nom, libellé, couleur principale).
function accentPresets() {
  return [
    ['blue', 'Bleu', '#3b82f6'], ['green', 'Vert', '#22c55e'], ['rose', 'Rose', '#f43f5e'], ['orange', 'Orange', '#f97316'],
    ['violet', 'Violet', '#8b5cf6'], ['teal', 'Turquoise', '#14b8a6'], ['sky', 'Ciel', '#0ea5e9'], ['indigo', 'Indigo', '#6366f1'],
    ['red', 'Rouge', '#ef4444'], ['amber', 'Jaune', '#eab308']
  ];
}
// Applique l'accent : un nom prédéfini, ou une couleur personnalisée (hex) qui remplace les variables du thème.
function applyAccent(name, hex) {
  const body = document.body;
  ['--primary', '--primary-hover', '--accent', '--glow'].forEach(p => body.style.removeProperty(p));
  if (name === 'custom' && /^#[0-9a-f]{6}$/i.test(hex || '')) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const darker = '#' + [r, g, b].map(c => Math.round(c * 0.85).toString(16).padStart(2, '0')).join('');
    body.style.setProperty('--primary', hex);
    body.style.setProperty('--primary-hover', darker);
    body.style.setProperty('--accent', hex);
    body.style.setProperty('--glow', `rgba(${r}, ${g}, ${b}, 0.15)`);
  }
  body.setAttribute('data-color', name);
}
function accentSwatchesHTML() {
  const custom = lsGet('quizmaster_color_custom') || '#14b8a6';
  const swatches = accentPresets().map(([id, label, hex]) => `<button class="accent-swatch ${state.color === id ? 'active' : ''}" style="background: ${hex};" onclick="changeColor('${id}')" title="${label}" aria-label="${label}"></button>`).join('');
  const customBg = state.color === 'custom' ? custom : 'conic-gradient(#ef4444, #eab308, #22c55e, #0ea5e9, #6366f1, #ef4444)';
  return `${swatches}<label class="accent-swatch accent-custom ${state.color === 'custom' ? 'active' : ''}" style="background: ${customBg};" title="Couleur personnalisée"><input type="color" value="${escapeAttr(custom)}" onchange="changeCustomColor(this.value)" aria-label="Couleur personnalisée"></label>`;
}
window.changeCustomColor = (hex) => {
  lsSet('quizmaster_color_custom', hex);
  state.color = 'custom';
  applyAccent('custom', hex);
  lsSet('quizmaster_color', 'custom');
  render();
};
window.changeColor = (color) => {
  state.color = color;
  applyAccent(color);
  lsSet('quizmaster_color', color);
  render();
};
window.toggleFocus = () => {
  state.focusMode = !state.focusMode;
  if (state.focusMode) document.body.classList.add('focus-mode');
  else document.body.classList.remove('focus-mode');
  lsSet('quizmaster_focus', state.focusMode);
  render();
};
window.toggleNotebooks = () => { state.notebooksCollapsed = !state.notebooksCollapsed; render(); };
window.toggleSections = () => { state.sectionsCollapsed = !state.sectionsCollapsed; render(); };
window.closeSidebar = () => { if (window.innerWidth <= 768) { state.notebooksCollapsed = true; state.sectionsCollapsed = true; render(); } };
window.updateSearch = (val) => {
  state.searchQuery = val; render();
  const input = document.querySelector('.search-bar input');
  if (input) { input.focus(); input.setSelectionRange(val.length, val.length); }
};
// Recherche élargie : énoncé, explication, réponses acceptées et étiquettes.
function questionMatches(q, needle) {
  const fields = [q.statement, q.explanation, ...(q.answers || []), ...(q.tags || [])];
  return fields.some(f => String(f || '').toLowerCase().includes(needle));
}

function getSearchResults(query) {
  if (!query || query.length < 1) return [];
  const q = query.toLowerCase(); const results = [];
  NOTEBOOKS.forEach(nb => {
    (nb.sections || []).forEach(sec => {
      (sec.pages || []).forEach(page => {
        const matchPage = String(page.title || '').toLowerCase().includes(q);
        const matchingQuestions = (page.questions || []).filter(question => questionMatches(question, q));
        if (matchPage || matchingQuestions.length > 0) results.push({ nb, sec, page, matchingQuestions });
      });
    });
  });
  return results;
}
function updateGamification(score, total) {
  const earnedXp = (score * 10) + (total * 5);
  state.lastEarnedXp = earnedXp;
  addDailyXp(earnedXp);
  GAME_DATA.level = Math.floor(GAME_DATA.xp / 100) + 1;
  const today = localDateStr();
  if (GAME_DATA.lastPlayed !== today) {
    const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = localDateStr(yesterdayDate);
    if (GAME_DATA.lastPlayed === yesterday) GAME_DATA.streak++;
    else if (GAME_DATA.lastPlayed === null) GAME_DATA.streak = 1;
    else GAME_DATA.streak = 1;
    GAME_DATA.lastPlayed = today;
  }
  saveData();
}
window.exportData = () => {
  const backup = { notebooks: NOTEBOOKS, history: HISTORY, gameData: GAME_DATA };
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", "revisoria_sauvegarde_" + localDateStr() + ".json");
  document.body.appendChild(downloadAnchorNode); downloadAnchorNode.click(); downloadAnchorNode.remove();
  // 🔔 Sert au rappel de sauvegarde du tableau de bord.
  GAME_DATA.lastBackup = localDateStr();
  saveData();
};

// 🤝 Decks partagés : une matière exportée dans un fichier que d'autres peuvent importer.
// Les données personnelles (SRS, favoris) ne sont pas incluses.
function deckCardHTML() {
  const options = NOTEBOOKS.map(nb => `<option value="${escapeAttr(nb.id)}">${escapeHtml(nb.title)}</option>`).join('');
  return `<div class="card deck-card"><h3>🤝 Partager une matière</h3><p class="muted">Exporte une matière dans un fichier .json qu'un ami peut importer dans son Révisoria.</p><div class="row" style="flex-wrap: wrap; gap: 10px;">${NOTEBOOKS.length ? `<select id="deckExportSelect" aria-label="Matière à exporter" style="max-width: 260px; margin-bottom: 0;">${options}</select><button class="btn" onclick="exportDeck()">📤 Exporter</button>` : '<span class="muted">Aucune matière à exporter.</span>'}<label class="btn ghost" style="cursor: pointer;">📥 Importer un deck<input type="file" id="deckFile" accept=".json,application/json" hidden></label></div></div>`;
}
window.exportDeck = () => {
  const select = document.getElementById('deckExportSelect');
  const nb = NOTEBOOKS.find(n => n.id === select?.value);
  if (!nb) return alert("Choisis une matière à exporter.");
  const notebook = JSON.parse(JSON.stringify(nb, (key, value) => ['srsData', 'flag'].includes(key) ? undefined : value));
  const deck = { format: 'quizmaster-deck', version: 1, exportedAt: localDateStr(), notebook };
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(deck, null, 2));
  const link = document.createElement('a');
  link.setAttribute('href', dataStr);
  link.setAttribute('download', 'deck_' + nb.title.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.json');
  document.body.appendChild(link); link.click(); link.remove();
};
// Nombre de jours depuis la dernière sauvegarde (null si jamais sauvegardé).
function daysSinceBackup() {
  if (!GAME_DATA.lastBackup) return null;
  const last = new Date(GAME_DATA.lastBackup + 'T00:00:00');
  if (Number.isNaN(last.getTime())) return null;
  const today = new Date(localDateStr() + 'T00:00:00');
  return Math.max(0, Math.round((today - last) / 86400000));
}

// --- GESTION DES RESSOURCES ---
window.addResourceUrl = (pageId, type) => {
  const labels = { image: "URL de l'image (JPG, PNG...)", video: "URL de la vidéo (YouTube...)", link: "URL du site web" };
  showPromptModal(`Ajouter ${type}`, labels[type], (url) => {
    if (!url.startsWith('http')) url = 'https://' + url;
    const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
    const sec = nb?.sections.find(s=>s.id===state.activeSecId);
    const page = sec?.pages.find(p=>p.id===pageId);
    if(page) {
      if (!page.resources) page.resources = [];
      page.resources.push({ id: 'res_'+Date.now(), type, name: `Ressource ${type}`, url: url });
      saveData(); render();
    }
  });
};
window.uploadPdf = async (event, pageId) => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const resId = 'pdf_' + Date.now();
    await savePdfToDb(resId, file);
    const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
    const sec = nb?.sections.find(s=>s.id===state.activeSecId);
    const page = sec?.pages.find(p=>p.id===pageId);
    if(page) {
      if (!page.resources) page.resources = [];
      page.resources.push({ id: resId, type: 'pdf', name: file.name });
      saveData(); render();
    }
  } catch(e) { alert("Erreur lors de la sauvegarde du PDF."); }
};
// 🔧 FIX 19: guard pdf
window.deleteResource = async (pageId, resId, type) => {
  if(!confirm("Supprimer cette ressource ?")) return;
  if (type === 'pdf') { try { deletePdfFromDb(resId); } catch(e) {} }
  const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
  const sec = nb?.sections.find(s=>s.id===state.activeSecId);
  const page = sec?.pages.find(p=>p.id===pageId);
  if(page) {
    page.resources = page.resources.filter(r => r.id !== resId);
    saveData(); render();
  }
};
window.openResource = async (resId, type, url) => {
  if (type === 'pdf') {
    try {
      const arrayBuffer = await getPdfFromDb(resId);
      if (!arrayBuffer) return alert("Fichier PDF introuvable.");
      const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000 * 60);
    } catch (e) {
      // 🔧 FIX : une erreur IndexedDB remontait en « unhandled promise rejection »
      // et le bouton semblait ne rien faire.
      alert("Impossible d'ouvrir le PDF : " + e.message);
    }
  } else if (url) { window.open(url, '_blank'); }
  else { alert("Cette ressource n'a pas d'URL."); }
};

// 🔧 FIX 2: guard pdf.js
window.listenResource = async (resId, type, url) => {
  if (!('speechSynthesis' in window)) return alert("Ton navigateur ne supporte pas la lecture audio.");
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    document.querySelectorAll('.listen-btn').forEach(b => b.classList.remove('playing'));
    return;
  }
  const btn = document.getElementById(`btn-listen-${resId}`);
  if(btn) btn.classList.add('playing');
  try {
    let text = "";
    if (type === 'pdf') {
      if (!isPdfReady()) throw new Error("La librairie PDF.js n'est pas chargée (vérifie ta connexion).");
      const arrayBuffer = await getPdfFromDb(resId);
      if (!arrayBuffer) throw new Error("PDF introuvable en base.");
      const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        text += textContent.items.map(item => item.str).join(' ') + "\n";
      }
    } else if (type === 'image') {
      const res = await fetch(url);
      const blob = await res.blob();
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
      const prompt = "Extrais tout le texte de cette image. Renvoie UNIQUEMENT le texte.";
      text = await callGemini([
        { text: prompt },
        { inline_data: { mime_type: blob.type, data: base64 } }
      ]);
    } else { text = "L'écoute automatique de ce type de ressource n'est pas encore disponible. Veuillez ouvrir le lien."; }
    if (!text.trim()) throw new Error("Texte vide.");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'fr-FR'; utterance.rate = 1.0;
    const voice = getBestFrenchVoice(); if (voice) utterance.voice = voice;
    utterance.onend = () => { if(btn) btn.classList.remove('playing'); };
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    if(btn) btn.classList.remove('playing');
    alert("Impossible de lire la ressource : " + e.message);
  }
};

// 🔧 FIX 3 + FIX 9: guard pdf.js + escapeHtml du texte
window.startMemorizeFromResource = async (resId, type, url, pageTitle) => {
  state.screen = 'memorize';
  state.memoText = "<div style='text-align:center; padding: 50px;'><b>⏳ Extraction du texte en cours...</b><br><br><small>Veuillez patienter...</small></div>";
  state.memoHtml = '';
  render();
  try {
    let text = "";
    if (type === 'pdf') {
      if (!isPdfReady()) throw new Error("La librairie PDF.js n'est pas chargée.");
      const arrayBuffer = await getPdfFromDb(resId);
      if (!arrayBuffer) throw new Error("PDF introuvable.");
      const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        text += textContent.items.map(item => item.str).join(' ') + "\n\n";
      }
    } else if (type === 'image' || type === 'link' || type === 'video') {
      const prompt = `Extrais tout le texte lisible de cette ressource (${type}). URL: ${url}. Si c'est une image, fais de l'OCR. Si c'est un lien, extrais le texte principal. Renvoie UNIQUEMENT le texte brut, sans commentaire.`;
      let parts = [{ text: prompt }];
      if (type === 'image') {
        const res = await fetch(url);
        const blob = await res.blob();
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        parts.push({ inline_data: { mime_type: blob.type, data: base64 } });
      }
      text = await callGemini(parts);
    }
    // 🔧 FIX : split('\n') ne servait à rien après replace(/\s+/g, ' ').
    const cleaned = text.replace(/\s+/g, ' ').trim();
    state.memoText = escapeHtml(cleaned);
    state.memoHtml = '';
    render();
  } catch (e) {
    state.memoText = "";
    alert("Erreur d'extraction : " + e.message);
    render();
  }
};

// 🔧 FIX 4: summarizeResource et generateQuizFromResource séparées (accolades corrigées)
window.summarizeResource = async (resId, type) => {
  if (!ensureGeminiKey()) return;
  showPromptModal("Résumé en cours...", "L'IA analyse ton document...", () => {});
  const modal = document.getElementById('custom-modal');
  if (modal) modal.innerHTML = `<div class="custom-modal-card"><h3>⏳ Analyse du cours en cours...</h3><p class="muted">L'IA lit ton document et prépare un résumé...</p></div>`;
  try {
    let parts = [];
    if (type === 'pdf') {
      if (!isPdfReady()) throw new Error("PDF.js non chargé.");
      const arrayBuffer = await getPdfFromDb(resId);
      if (!arrayBuffer) throw new Error("PDF introuvable.");
      const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map(item => item.str).join(' ') + "\n";
      }
      parts = [{ text: `Fais un résumé clair et structuré en 5 points clés de ce cours :\n\n${fullText.substring(0, 25000)}` }];
    } else { throw new Error("Le résumé n'est disponible que pour les PDF."); }
    const text = await callGemini(parts);
    const modalNow = document.getElementById('custom-modal');
    if (modalNow) {
      modalNow.innerHTML = `
        <div class="custom-modal-card" style="max-width: 650px;">
          <div class="flex-between" style="margin-bottom: 15px;">
            <h3 style="margin:0;">📝 Résumé du cours</h3>
            <button class="btn ghost" onclick="document.getElementById('custom-modal').remove()" aria-label="Fermer">✖</button>
          </div>
          <div style="line-height: 1.7; font-size: 1rem;">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
        </div>
      `;
    }
  } catch (e) {
    const modalNow = document.getElementById('custom-modal');
    if (modalNow) {
      modalNow.innerHTML = `<div class="custom-modal-card"><h3>❌ Erreur</h3><p>${escapeHtml(e.message)}</p><button class="btn" onclick="document.getElementById('custom-modal').remove()">Fermer</button></div>`;
    } else { alert("Erreur : " + e.message); }
  }
};

window.generateQuizFromResource = async (resId, type, url, pageId) => {
  if (!ensureGeminiKey()) return;
  const btn = document.getElementById(`btn-gen-${resId}`);
  if (!btn) return;
  const originalText = btn.innerHTML;
  btn.innerHTML = "⏳..."; btn.disabled = true;
  try {
    let parts = [];
    const prompt = `Analyse cette ressource (${type}) et génère un quiz de 5 à 10 questions. Format STRICT JSON (pas de markdown): [{"type":"qcs","statement":"Q?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correct":["a"],"explanation":"Expl"}]`;
    if (type === 'pdf') {
      if (!isPdfReady()) throw new Error("PDF.js non chargé.");
      const arrayBuffer = await getPdfFromDb(resId);
      if (!arrayBuffer) throw new Error("PDF introuvable.");
      const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map(item => item.str).join(' ') + "\n";
      }
      parts = [{ text: prompt + "\n\nTexte du cours :\n" + fullText.substring(0, 20000) }];
    } else if (type === 'image') {
      const resImg = await fetch(url);
      const blob = await resImg.blob();
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
      parts = [{ text: prompt }, { inline_data: { mime_type: blob.type, data: base64 } }];
    } else { parts = [{ text: prompt + "\n\nRessource à analyser : " + url }]; }
    let text = (await callGemini(parts)).replace(/```json/gi, '').replace(/```/g, '').trim();
    text = text.substring(text.indexOf('['), text.lastIndexOf(']') + 1);
    let newQuestions;
    try { newQuestions = JSON.parse(text); }
    catch (parseErr) { throw new Error("L'IA a renvoyé un format invalide. Réessaie."); }
    if (!Array.isArray(newQuestions)) throw new Error("L'IA n'a pas renvoyé une liste de questions.");
    const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
    const sec = nb?.sections.find(s=>s.id===state.activeSecId);
    const page = sec?.pages.find(p=>p.id===pageId);
    if (page) {
      newQuestions.forEach((q, idx) => {
        page.questions.push(normalizeQuestion(q, 'q_ia_' + Date.now() + '_' + idx));
      });
      saveData();
      alert(`✅ ${newQuestions.length} questions générées !`);
      render();
    }
  } catch (err) {
    alert("Erreur : " + err.message);
  } finally {
    const btnNow = document.getElementById(`btn-gen-${resId}`);
    if (btnNow) { btnNow.innerHTML = originalText; btnNow.disabled = false; }
  }
};
window.showBulkGenerateModal = (pageId) => {
  if (!ensureGeminiKey()) return;
  const modalHTML = `
    <div class="custom-modal-overlay" id="bulk-modal">
      <div class="custom-modal-card" style="max-width: 600px;">
        <h3 style="margin-top:0; margin-bottom:15px; font-size:1.2rem;">🤖 Générer des questions par IA</h3>
        <p class="muted" style="margin-bottom: 15px;">Colle ton cours, un paragraphe ou un texte entier ici. L'IA va générer jusqu'à 50 questions automatiquement !</p>
        <textarea id="bulk-text" style="min-height: 150px; margin-bottom: 15px; font-size: 0.95rem;" placeholder="Colle ton texte ici..."></textarea>
        <div class="row" style="margin-bottom: 15px;">
          <label style="flex:1; font-weight: bold;">Nombre de questions :</label>
          <select id="bulk-count" style="width: auto; margin-bottom: 0;">
            <option value="10">10 questions</option>
            <option value="20">20 questions</option>
            <option value="50">50 questions</option>
          </select>
        </div>
        <div class="row" style="justify-content: flex-end; gap: 10px;">
          <button class="btn ghost" onclick="document.getElementById('bulk-modal').remove()">Annuler</button>
          <button class="btn" id="btn-bulk-gen" onclick="executeBulkGenerate('${pageId}')">Générer</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
};

// 🔧 FIX 5 + FIX 7: guards + JSON.parse protégé + bouton null-safe
window.executeBulkGenerate = async (pageId) => {
  const textEl = document.getElementById('bulk-text');
  const countEl = document.getElementById('bulk-count');
  const btn = document.getElementById('btn-bulk-gen');
  if (!textEl || !countEl) return alert("Modale introuvable.");
  const text = textEl.value.trim();
  const count = countEl.value;
  if (!text) return alert("Colle du texte d'abord !");
  if (btn) { btn.innerHTML = "⏳ Génération..."; btn.disabled = true; }
  try {
    const prompt = `Analyse ce texte et génère exactement ${count} questions. Format STRICT JSON: [{"type":"qcs","statement":"Q?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correct":["a"],"explanation":"Expl"}] Texte: ${text.substring(0, 20000)}`;
    let result = (await callGemini([{ text: prompt }])).replace(/```json/gi, '').replace(/```/g, '').trim();
    result = result.substring(result.indexOf('['), result.lastIndexOf(']') + 1);
    let newQuestions;
    try { newQuestions = JSON.parse(result); }
    catch (parseErr) { throw new Error("L'IA a renvoyé un format invalide."); }
    if (!Array.isArray(newQuestions)) throw new Error("L'IA n'a pas renvoyé une liste de questions.");
    const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
    const sec = nb?.sections.find(s=>s.id===state.activeSecId);
    const page = sec?.pages.find(p=>p.id===pageId);
    if (page) {
      newQuestions.forEach((q, idx) => {
        page.questions.push(normalizeQuestion(q, 'q_bulk_' + Date.now() + '_' + idx));
      });
      saveData();
      const modal = document.getElementById('bulk-modal');
      if (modal) modal.remove();
      alert(`✅ ${newQuestions.length} questions générées !`);
      render();
    }
  } catch (err) {
    alert("Erreur : " + err.message);
  } finally {
    const btnNow = document.getElementById('btn-bulk-gen');
    if (btnNow) { btnNow.innerHTML = "Générer"; btnNow.disabled = false; }
  }
};
// ============================================================
// 📥 CATÉGORIE 5.1 : IMPORT EN MASSE (TEXTE / CSV / JSON)
// ============================================================

window._currentBulkTab = 'text';

window.showMassImportModal = (pageId) => {
  // 🔧 FIX : l'onglet actif restait celui de la dernière ouverture (ex: CSV)
  // alors que la modale réaffichait toujours l'onglet « Texte » => parsing erroné.
  window._currentBulkTab = 'text';
  const modalHTML = `
    <div class="custom-modal-overlay" id="mass-import-modal">
      <div class="custom-modal-card" style="max-width: 720px;">
        <div class="flex-between" style="margin-bottom: 20px;">
          <h3 style="margin:0; font-size:1.3rem;">📥 Import en masse</h3>
          <button class="btn ghost" onclick="document.getElementById('mass-import-modal').remove()" style="padding: 6px 12px;" aria-label="Fermer">✖</button>
        </div>
        <div class="bulk-import-tabs">
          <button class="bulk-tab active" id="tab-text" onclick="switchBulkTab('text')">📝 Texte simple</button>
          <button class="bulk-tab" id="tab-csv" onclick="switchBulkTab('csv')">📊 CSV</button>
          <button class="bulk-tab" id="tab-json" onclick="switchBulkTab('json')">🔧 JSON</button>
        </div>
        <div id="bulk-help-text" class="bulk-help">
          <b>Format texte simple :</b> une question par bloc, sépare les blocs par une ligne vide.<br>
          <code>Q: Énoncé de la question</code><br>
          <code>A) Choix 1</code><br>
          <code>B) Choix 2</code><br>
          <code>*B</code> ← la lettre correcte (précédée de *)<br>
          <code>E: Explication (optionnel)</code>
        </div>
        <div id="bulk-help-csv" class="bulk-help" style="display:none;">
          <b>Format CSV :</b> une ligne = une question. Séparateur <code>;</code> ou <code>,</code>.<br>
          <code>type;énoncé;choixA;choixB;choixC;bonne lettre;explication</code><br>
          Ex : <code>qcs;2+2=?;3;4;5;B;Deux plus deux font quatre</code>
        </div>
        <div id="bulk-help-json" class="bulk-help" style="display:none;">
          <b>Format JSON :</b> tableau d'objets questions.<br>
          <code>[{"type":"qcs","statement":"...","choices":[{"id":"a","text":"A"}],"correct":["a"],"explanation":"..."}]</code>
        </div>
        <textarea id="mass-import-text" class="bulk-textarea" placeholder="Colle ton contenu ici..."></textarea>
        <div class="row" style="justify-content: space-between; margin-bottom: 15px;">
          <button class="btn ghost" onclick="previewMassImport('${pageId}')" style="padding: 10px 20px;">👁️ Aperçu</button>
          <div class="row" style="gap: 10px;">
            <button class="btn ghost" onclick="document.getElementById('mass-import-modal').remove()">Annuler</button>
            <button class="btn" onclick="executeMassImport('${pageId}')" style="padding: 10px 25px;">✅ Importer</button>
          </div>
        </div>
        <div id="mass-import-preview"></div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
};

window.switchBulkTab = (tab) => {
  window._currentBulkTab = tab;
  document.querySelectorAll('.bulk-tab').forEach(t => t.classList.remove('active'));
  const activeTab = document.getElementById('tab-' + tab);
  if (activeTab) activeTab.classList.add('active');
  document.getElementById('bulk-help-text').style.display = tab === 'text' ? 'block' : 'none';
  document.getElementById('bulk-help-csv').style.display = tab === 'csv' ? 'block' : 'none';
  document.getElementById('bulk-help-json').style.display = tab === 'json' ? 'block' : 'none';
};

function parseTextFormat(text) {
  const questions = [];
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(l => l);
    if (!lines.length) continue;
    const q = { type: 'qcs', statement: '', choices: [], correct: [], explanation: '' };
    let choices = [];
    let correctLetters = [];
    for (const line of lines) {
      if (line.match(/^Q\s*[:：]/i)) {
        q.statement = line.replace(/^Q\s*[:：]\s*/i, '');
      } else if (line.match(/^E\s*[:：]/i)) {
        q.explanation = line.replace(/^E\s*[:：]\s*/i, '');
      } else if (line.match(/^\*?[A-Za-z]\)/)) {
        const isCorrect = line.startsWith('*');
        const cleaned = line.replace(/^\*/, '');
        const letter = cleaned.match(/^([A-Za-z])\)/)[1].toUpperCase();
        const text = cleaned.replace(/^[A-Za-z]\)\s*/, '');
        choices.push({ letter, text });
        if (isCorrect) correctLetters.push(letter);
      } else if (line.match(/^\*[A-Za-z]+$/)) {
        const letters = line.replace(/^\*/, '').toUpperCase().split('');
        correctLetters.push(...letters);
      }
    }
    if (!q.statement || choices.length === 0) continue;
    q.choices = choices.map((c, i) => ({ id: i.toString(), text: c.text }));
    const letterMap = {};
    choices.forEach((c, i) => { letterMap[c.letter] = i.toString(); });
    q.correct = correctLetters.map(l => letterMap[l]).filter(x => x !== undefined);
    if (q.correct.length === 0) continue;
    q.type = q.correct.length > 1 ? 'qcm' : 'qcs';
    questions.push(q);
  }
  return questions;
}

function parseCsvFormat(text) {
  const questions = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines[0] && lines[0].toLowerCase().includes('type')) lines.shift();
  for (const line of lines) {
    const sep = line.includes(';') ? ';' : ',';
    const parts = line.split(sep).map(p => p.trim());
    if (parts.length < 4) continue;
    const type = parts[0].toLowerCase();
    const statement = parts[1];
    if (!statement) continue;
    const q = {
      type: type === 'qcm' ? 'qcm' : type === 'qroc' ? 'qroc' : 'qcs',
      statement, choices: [], correct: [], explanation: ''
    };
    if (q.type === 'qroc') {
      q.answers = parts.slice(2).filter(p => p);
    } else {
      const correctLetters = parts[parts.length - 2] || '';
      const explanation = parts.length > 3 ? parts[parts.length - 1] : '';
      const choiceTexts = parts.slice(2, parts.length - 2);
      q.choices = choiceTexts.filter(c => c).map((t, i) => ({ id: i.toString(), text: t }));
      q.explanation = explanation;
      const letters = correctLetters.toUpperCase().split(/[\s,]+/).filter(l => l);
      const letterMap = {};
      q.choices.forEach((c, i) => { letterMap[String.fromCharCode(65 + i)] = i.toString(); });
      q.correct = letters.map(l => letterMap[l]).filter(x => x !== undefined);
      if (q.correct.length === 0) continue;
      if (q.type === 'qcs' && q.correct.length > 1) q.type = 'qcm';
    }
    questions.push(q);
  }
  return questions;
}

function parseJsonFormat(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.map(q => ({
      type: q.type || 'qcs',
      statement: q.statement || q.question || '',
      choices: Array.isArray(q.choices) ? q.choices : [],
      correct: Array.isArray(q.correct) ? q.correct : [],
      answers: Array.isArray(q.answers) ? q.answers : [],
      explanation: q.explanation || ''
    })).filter(q => q.statement);
  } catch(e) { return []; }
}

function parseMassImport(text, tab) {
  if (tab === 'csv') return parseCsvFormat(text);
  if (tab === 'json') return parseJsonFormat(text);
  return parseTextFormat(text);
}

window.previewMassImport = (pageId) => {
  const textEl = document.getElementById('mass-import-text');
  if (!textEl) return;
  const text = textEl.value.trim();
  if (!text) return alert("Colle du contenu d'abord !");
  const questions = parseMassImport(text, window._currentBulkTab);
  const previewEl = document.getElementById('mass-import-preview');
  if (questions.length === 0) {
    previewEl.innerHTML = `<div class="bulk-preview"><div class="bulk-preview-item error">❌ Aucune question valide détectée. Vérifie le format.</div></div>`;
    return;
  }
  const html = questions.slice(0, 10).map((q, i) => `
    <div class="bulk-preview-item">
      <b>${i+1}. [${q.type.toUpperCase()}]</b> ${escapeHtml(q.statement.substring(0, 100))}
      ${q.choices.length ? `<br><span class="muted" style="font-size:0.8rem;">${q.choices.length} choix · ${q.correct.length} correcte(s)</span>` : ''}
      ${q.type === 'qroc' ? `<br><span class="muted" style="font-size:0.8rem;">Réponses : ${escapeHtml((q.answers||[]).join(' / '))}</span>` : ''}
    </div>
  `).join('');
  const more = questions.length > 10 ? `<div class="muted" style="text-align:center; padding: 8px;">... et ${questions.length - 10} autre(s)</div>` : '';
  previewEl.innerHTML = `<div class="bulk-preview">${html}${more}</div>`;
};

window.executeMassImport = (pageId) => {
  const textEl = document.getElementById('mass-import-text');
  if (!textEl) return;
  const text = textEl.value.trim();
  if (!text) return alert("Colle du contenu d'abord !");
  const questions = parseMassImport(text, window._currentBulkTab);
  if (questions.length === 0) return alert("❌ Aucune question valide détectée.");
  const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
  const sec = nb?.sections.find(s=>s.id===state.activeSecId);
  const page = sec?.pages.find(p=>p.id===pageId);
  if (!page) return alert("Page introuvable.");
  // 🧹 Détection de doublons : même énoncé (normalisé) déjà présent ou répété
  // dans le lot importé. Évite de tripler les questions après 3 imports.
  const seen = new Set((page.questions || []).map(q => normalize(q.statement)));
  let imported = 0;
  let skipped = 0;
  questions.forEach((q, idx) => {
    const nq = normalizeQuestion(q, 'q_import_' + Date.now() + '_' + idx);
    const key = normalize(nq.statement);
    if (!key || seen.has(key)) { skipped++; return; }
    seen.add(key);
    page.questions.push(nq);
    imported++;
  });
  saveData();
  const modal = document.getElementById('mass-import-modal');
  if (modal) modal.remove();
  if (imported === 0) {
    alert(`ℹ️ Aucune nouvelle question : les ${skipped} question(s) existent déjà sur cette page.`);
  } else {
    alert(`✅ ${imported} question(s) importée(s)${skipped ? `\n${skipped} doublon(s) ignoré(s)` : ''} !`);
  }
  render();
};
// ============================================================
// 📤 CATÉGORIE 5.2 : EXPORT PDF (via impression navigateur)
// ============================================================

function openPrintWindow(title, htmlBody) {
  const win = window.open('', '_blank');
  if (!win) return alert("Autorise les pop-ups pour exporter en PDF.");
  
  win.document.write(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(title)}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #0f172a; background: #fff; padding: 40px; line-height: 1.6; max-width: 900px; margin: 0 auto; }
        h1 { font-size: 1.8rem; margin: 0 0 8px 0; color: #1e40af; }
        h2 { font-size: 1.2rem; margin: 25px 0 10px 0; color: #1e293b; border-bottom: 2px solid #3b82f6; padding-bottom: 5px; }
        .meta { color: #64748b; font-size: 0.9rem; margin-bottom: 30px; }
        .stat-box { background: #f1f5f9; border-left: 4px solid #3b82f6; padding: 15px 20px; margin: 15px 0; border-radius: 8px; }
        .score-big { font-size: 3rem; font-weight: 800; color: #1e40af; text-align: center; margin: 20px 0; }
        .question-item { margin-bottom: 20px; padding: 15px; border: 1px solid #e2e8f0; border-radius: 8px; page-break-inside: avoid; }
        .question-item.correct { border-left: 4px solid #10b981; }
        .question-item.wrong { border-left: 4px solid #ef4444; }
        .q-statement { font-weight: bold; margin-bottom: 10px; font-size: 1.05rem; }
        .q-choice { padding: 4px 0; color: #475569; }
        .q-choice.correct-answer { color: #047857; font-weight: bold; }
        .q-choice.user-wrong { color: #dc2626; text-decoration: line-through; }
        .q-explanation { margin-top: 10px; padding: 10px; background: #f8fafc; border-radius: 6px; font-size: 0.9rem; color: #334155; }
        .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; }
        .badge.ok { background: #d1fae5; color: #047857; }
        .badge.bad { background: #fee2e2; color: #b91c1c; }
        .footer { margin-top: 40px; text-align: center; color: #94a3b8; font-size: 0.8rem; border-top: 1px solid #e2e8f0; padding-top: 20px; }
        @media print { body { padding: 0; } .no-print { display: none; } }
        .no-print { text-align: center; padding: 20px; background: #f1f5f9; margin-bottom: 30px; border-radius: 8px; }
        .no-print button { padding: 12px 24px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1rem; margin: 0 5px; }
      </style>
    </head>
    <body>
      <div class="no-print">
        <button onclick="window.print()">🖨️ Imprimer / Enregistrer en PDF</button>
        <button onclick="window.close()" style="background:#64748b;">✖ Fermer</button>
      </div>
      ${htmlBody}
      <div class="footer">Généré par Révisoria · ${new Date().toLocaleDateString('fr-FR')}</div>
    </body>
    </html>
  `);
  win.document.close();
}

// Export des résultats d'un quiz
window.exportResultsPDF = () => {
  if (!state.questions || !state.answers.length) return alert("Aucun résultat à exporter.");
  const score = state.answers.filter(a => a.correct).length;
  const total = state.questions.length;
  const pct = Math.round((score / total) * 100);
  const modeLabel = { training:'Entraînement', exam:'Examen', exam_blanc:'Examen Blanc', survival:'Survie', srs:'SRS', sprint:'Sprint', flashcard:'Flashcards' }[state.mode] || state.mode;
  
  const questionsHTML = state.questions.map((q, i) => {
    const a = state.answers[i];
    const cls = a.correct ? 'correct' : 'wrong';
    const badge = a.correct ? '<span class="badge ok">✓ Correct</span>' : '<span class="badge bad">✗ Incorrect</span>';
    let choicesHTML = '';
    if (q.type === 'qroc' || q.type === 'qnum') {
      const userText = escapeHtml(a.text || '(aucune réponse)');
      const correctText = escapeHtml(correctAnswerText(q));
      choicesHTML = `
        <div class="q-choice user-wrong">Ta réponse : ${userText}</div>
        <div class="q-choice correct-answer">Bonne réponse : ${correctText}</div>
      `;
    } else {
      choicesHTML = q.choices.map((c, idx) => {
        const isCorrect = q.correct.includes(c.id);
        const isSelected = a.selected.includes(c.id);
        let cls2 = 'q-choice';
        if (isCorrect) cls2 += ' correct-answer';
        else if (isSelected) cls2 += ' user-wrong';
        const letter = String.fromCharCode(65 + idx);
        const mark = isCorrect ? '✓' : (isSelected ? '✗' : '·');
        return `<div class="${cls2}">${mark} ${letter}) ${escapeHtml(c.text)}</div>`;
      }).join('');
    }
    return `
      <div class="question-item ${cls}">
        <div class="q-statement">Question ${i+1} ${badge}</div>
        <div style="margin-bottom:10px;">${escapeHtml(q.statement)}</div>
        ${choicesHTML}
        ${q.explanation ? `<div class="q-explanation"><b>Explication :</b> ${escapeHtml(q.explanation)}</div>` : ''}
      </div>
    `;
  }).join('');
  
  const html = `
    <h1>Résultats du quiz</h1>
    <div class="meta">Mode : ${modeLabel} · ${new Date().toLocaleString('fr-FR')}</div>
    <div class="score-big">${pct}%</div>
    <div class="stat-box" style="text-align:center;"><b>${score} / ${total}</b> bonnes réponses</div>
    <h2>Détail des questions</h2>
    ${questionsHTML}
  `;
  openPrintWindow('Résultats du quiz — Révisoria', html);
};

// Export de la fiche de révision d'une page
window.exportPagePDF = (pageId) => {
  const nb = NOTEBOOKS.find(n => n.id === state.activeNbId);
  const sec = nb?.sections.find(s => s.id === state.activeSecId);
  const page = sec?.pages.find(p => p.id === pageId);
  if (!page) return alert("Page introuvable.");
  
  const questionsHTML = page.questions.map((q, i) => {
    let choicesHTML = '';
    if (q.type === 'qroc' || q.type === 'qnum') {
      choicesHTML = `<div class="q-choice correct-answer">${q.type === 'qnum' ? 'Réponse attendue' : 'Réponses acceptées'} : ${escapeHtml(correctAnswerText(q))}</div>`;
    } else {
      choicesHTML = q.choices.map((c, idx) => {
        const isCorrect = q.correct.includes(c.id);
        const letter = String.fromCharCode(65 + idx);
        return `<div class="q-choice ${isCorrect ? 'correct-answer' : ''}">${isCorrect ? '✓' : '·'} ${letter}) ${escapeHtml(c.text)}</div>`;
      }).join('');
    }
    return `
      <div class="question-item">
        <div class="q-statement">${i+1}. ${escapeHtml(q.statement)}</div>
        ${choicesHTML}
        ${q.explanation ? `<div class="q-explanation"><b>Explication :</b> ${escapeHtml(q.explanation)}</div>` : ''}
      </div>
    `;
  }).join('');
  
  const html = `
    <h1>${escapeHtml(page.title)}</h1>
    <div class="meta">${escapeHtml(nb.title)} · ${escapeHtml(sec.title)} · ${page.questions.length} question(s)</div>
    <h2>Questions</h2>
    ${questionsHTML || '<p>Aucune question sur cette page.</p>'}
  `;
  openPrintWindow(`Fiche de révision — ${page.title}`, html);
};

window.highlightText = () => { document.execCommand('hiliteColor', false, 'yellow') || document.execCommand('backColor', false, 'yellow'); };

// Import a PDF course into the memorization editor using the existing PDF.js CDN.
window.loadMemoPdf = async (input) => {
  const file = input.files?.[0]; if (!file) return;
  if (!isPdfReady()) return alert('Le lecteur PDF est indisponible. Vérifie ta connexion puis réessaie.');
  try {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' '));
    }
    state.memoText = `<h3>${escapeHtml(file.name)}</h3>` + pages.map((t,i) => `<p><b>Page ${i+1}</b><br>${escapeHtml(t)}</p>`).join('');
    render();
  } catch (e) { alert('Impossible de lire ce PDF.'); }
};

window.startMemoQcs = () => {
  const root = document.getElementById('memo-output'); if (!root) return;
  const blanks = [...root.querySelectorAll('.blank')];
  if (!blanks.length) return alert('Génère d’abord un texte à trous.');
  const target = blanks.find(el => !el.dataset.answered) || blanks[0];
  const answer = target.textContent.trim();
  const words = [...root.querySelectorAll('.blank')].map(el => el.textContent.trim()).filter(w => w && w !== answer);
  const choices = [answer, ...[...new Set(words)].slice(0,3)];
  while (choices.length < 4) choices.push(['la circulation','le traitement','la cellule'][choices.length-1]);
  choices.sort(() => Math.random() - .5);
  const host = document.getElementById('memo-qcs');
  host.innerHTML = `<b>Quel mot complète le texte ?</b><div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">${choices.map(w=>`<button class="btn ghost" onclick="answerMemoQcs(this,${JSON.stringify(w === answer)})">${escapeHtml(w)}</button>`).join('')}</div>`;
  target.classList.add('memo-current'); target.scrollIntoView({behavior:'smooth',block:'center'});
  state.memoQcsTarget = blanks.indexOf(target);
};
window.answerMemoQcs = (button, correct) => {
  const blank = document.querySelectorAll('#memo-output .blank')[state.memoQcsTarget];
  if (!blank) return;
  if (correct) { blank.classList.add('revealed'); blank.dataset.answered='1'; blank.classList.remove('memo-current'); document.getElementById('memo-qcs').innerHTML='<b>✅ Bonne réponse !</b>'; }
  else { button.disabled=true; button.textContent += ' ✖'; }
};

// 🔧 FIX 11: guard editor
window.generateMemoText = () => {
  const editor = document.getElementById('memo-input');
  if (!editor) return;
  let html = editor.innerHTML;
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  const highlights = tempDiv.querySelectorAll('mark, span[style*="background-color: yellow"], span[style*="background-color: rgb(255, 255, 0)"]');
  if (highlights.length > 0) {
    highlights.forEach(el => {
      const blank = document.createElement('span');
      blank.className = 'blank';
      blank.innerHTML = el.innerHTML;
      el.parentNode.replaceChild(blank, el);
    });
    state.memoHtml = tempDiv.innerHTML;
    state.memoText = editor.innerHTML;
    state.memoryMode = 'cloze';
    render();
  } else {
    if (confirm("Aucun mot n'a été surligné. Masquer les mots longs à la place ?")) {
      const text = editor.innerText;
      const words = text.split(/(\s+)/);
      let newHtml = words.map(word => {
        if (word.trim().length <= 4 || !/[a-zA-ZÀ-ÿ]/.test(word)) return word;
        return `<span class="blank">${escapeHtml(word)}</span>`;
      }).join('');
      state.memoHtml = newHtml;
      state.memoText = editor.innerHTML;
      state.memoryMode = 'cloze';
      render();
    }
  }
};

// 🔧 FIX 1: une seule déclaration (la double déclaration `let` était une SyntaxError fatale)
let currentModalCallback = null;

window.showPromptModal = (title, placeholder, callback, defaultValue = '') => {
  currentModalCallback = callback;
  // 🔧 FIX : `title` et `placeholder` étaient concaténés sans échappement dans du
  // HTML (le commentaire « FIX 6 » annonçait l'inverse) : un guillemet cassait le
  // champ, et du HTML injecté s'exécutait. On construit le DOM proprement.
  const overlay = document.createElement('div');
  overlay.className = 'custom-modal-overlay';
  overlay.id = 'custom-modal';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePromptModal(); });

  const card = document.createElement('div');
  card.className = 'custom-modal-card';

  const heading = document.createElement('h3');
  heading.style.cssText = 'margin-top:0; margin-bottom:15px; font-size:1.2rem;';
  heading.textContent = String(title ?? '');

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'custom-prompt-input';
  input.placeholder = String(placeholder ?? '');
  input.value = String(defaultValue ?? '');
  input.style.cssText = 'margin-bottom:20px; font-size:1rem; padding:12px;';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPromptModal(); });

  const row = document.createElement('div');
  row.className = 'row';
  row.style.cssText = 'justify-content: flex-end; gap: 10px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Annuler';
  cancelBtn.addEventListener('click', closePromptModal);
  const okBtn = document.createElement('button');
  okBtn.className = 'btn';
  okBtn.textContent = 'Valider';
  okBtn.addEventListener('click', submitPromptModal);

  row.append(cancelBtn, okBtn);
  card.append(heading, input, row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(function() { input.focus(); input.select(); }, 100);
};

window.closePromptModal = function() { 
  var modal = document.getElementById('custom-modal');
  if (modal) modal.remove(); 
  currentModalCallback = null; 
};

window.submitPromptModal = function() { 
  var input = document.getElementById('custom-prompt-input');
  if (input) {
    var val = input.value.trim(); 
    if (val && currentModalCallback) currentModalCallback(val); 
    closePromptModal(); 
  }
};

window.fireConfetti = () => {
  const colors = ['#f43f5e', '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#facc15'];
  for (let i = 0; i < 150; i++) {
    const conf = document.createElement('div');
    conf.style.position = 'fixed';
    conf.style.width = Math.random() * 10 + 5 + 'px';
    conf.style.height = conf.style.width;
    conf.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    conf.style.left = Math.random() * 100 + 'vw';
    conf.style.top = '-20px';
    conf.style.borderRadius = Math.random() > 0.5 ? '50%' : '0';
    conf.style.zIndex = '9999';
    conf.style.pointerEvents = 'none';
    const duration = Math.random() * 2 + 2;
    conf.style.transition = `transform ${duration}s ease-out, opacity ${duration}s ease-out`;
    document.body.appendChild(conf);
    setTimeout(() => {
      conf.style.transform = `translateY(${window.innerHeight + 50}px) rotate(${Math.random() * 720}deg)`;
      conf.style.opacity = '0';
    }, 10);
    setTimeout(() => conf.remove(), duration * 1000 + 100);
  }
};
// --- RENDU PRINCIPAL ---
// 🔧 FIX 15: fermer l'éditeur dès qu'on change d'écran
function render() {
  if (state.screen !== 'quiz') { clearInterval(state.timerId); window.stopSpeaking(); }
  // 🔧 FIX : le thème clair « examen » restait appliqué après avoir quitté
  // l'examen blanc (la classe n'était retirée que par renderQuiz/finishQuiz).
  if (state.screen !== 'quiz') document.body.classList.remove('exam-mode-body');
  if (state.editor && state.editor.isOpen && state.screen !== 'lesson') {
    state.editor.isOpen = false;
  }
  const appDiv = document.getElementById('app');
  const themeIcon = state.theme === 'dark' ? '☀️' : '🌙';
  const nbClass = state.notebooksCollapsed ? 'sidebar-collapsed' : '';
  const hasSectionsToShow = state.screen !== 'dashboard' && state.screen !== 'stats' && state.screen !== 'welcome' && state.screen !== 'memorize' && state.screen !== 'review' && state.screen !== 'flagged' && state.screen !== 'library' && state.screen !== 'calendar' && state.screen !== 'studyplan' && state.screen !== 'revisiontable' && state.screen !== 'pomodoro' && state.screen !== 'rewards' && state.screen !== 'mistakes';
  const secClass = (state.sectionsCollapsed || !hasSectionsToShow) ? 'sidebar-collapsed' : '';
  const wideScreens = ['library','calendar','studyplan','revisiontable','pomodoro'].includes(state.screen);
  const containerClass = `app-container${(state.notebooksCollapsed && (state.sectionsCollapsed || !hasSectionsToShow)) ? ' menu-closed' : ''}${wideScreens ? ' full-workspace' : ''}`;
  const mainContent = document.querySelector('.main-content');
  const scrollPos = mainContent ? mainContent.scrollTop : 0;
  if (state.screen === 'welcome') {
    appDiv.innerHTML = `
      <div class="welcome-screen">
        <button class="theme-toggle-fixed" onclick="toggleTheme()">${themeIcon}</button>
        <div class="welcome-content">
          <div class="welcome-logo">🧠</div>
          <h1>Révisoria</h1>
          <p>Ton espace de révision intelligent.<br>Organise tes cours, génère des quiz avec l'IA et réussis tes examens.</p>
          <button class="btn-start" onclick="enterApp()">Commencer 🚀</button>
        </div>
      </div>
    `;
    return;
  }
  appDiv.innerHTML = `
    <div class="${containerClass}">
      <div class="mobile-backdrop" onclick="closeSidebar()"></div>
      <div class="col-notebooks ${nbClass}">${renderNotebooks()}</div>
      <div class="col-sections ${secClass}">${renderSections()}</div>
      <div class="col-main">${renderMainContent()}</div>
      ${state.editor.isOpen ? renderEditor() : ''}
    </div>
    <button class="focus-toggle-fixed" onclick="toggleFocus()" title="Mode Focus">🎯</button>
    <button class="theme-toggle-fixed" onclick="toggleTheme()">${themeIcon}</button>
  `;
  const newMainContent = document.querySelector('.main-content');
  if (newMainContent) newMainContent.scrollTop = scrollPos;
  if (state.screen === 'memorize') {
    const cloze=document.getElementById('memory-cloze')||document.querySelector('.memory-exercise');
    if(cloze)cloze.addEventListener('click',e=>{const blank=e.target.closest('.memory-blank');if(!blank||blank.disabled)return;blank.textContent=blank.dataset.answer||'';blank.disabled=true;blank.classList.add('revealed');window.scoreMemory(true);});
    if (state.memoryMode === 'audio') {
      window.updateMemoryVoices();
      if (window.speechSynthesis && !window._memoryVoiceEventsBound) {
        window._memoryVoiceEventsBound = true;
        window.speechSynthesis.addEventListener('voiceschanged', window.updateMemoryVoices);
      }
    }
    const memoInput = document.getElementById('memo-input');
    if (memoInput) memoInput.addEventListener('input', (e) => { state.memoText = e.target.innerHTML; });
    // 🔧 FIX : révélation des trous par délégation (plus de onclick inline dans
    // du HTML issu d'un copier-coller, donc plus de XSS possible par ce chemin).
    const memoOutput = document.getElementById('memo-output');
    if (memoOutput) memoOutput.addEventListener('click', (e) => {
      const blank = e.target.closest('.blank');
      if (blank) blank.classList.add('revealed');
    });
  }
}

window.enterApp = () => {
  state.screen = 'dashboard';
  if (window.innerWidth <= 768) { state.notebooksCollapsed = true; state.sectionsCollapsed = true; }
  render();
};

function renderNotebooks() {
  const xpPercent = GAME_DATA.xp % 100;
  const dueCount = getDueQuestions().length;
  const flagCount = getFlaggedQuestions().length;
  const mistakeCount = readPlanner(MISTAKES_KEY, []).length;
  return `
    <div class="nb-header"><span>🧠 Révisoria</span></div>
    <div class="main-nav">
      <button class="btn-main-nav ${state.screen==='dashboard'?'active':''}" onclick="state.screen='dashboard'; state.activePageId=null; state.searchQuery=''; if(window.innerWidth <= 768) { state.notebooksCollapsed=true; state.sectionsCollapsed=true; } render()">🏠 Tableau de bord</button>
      <button class="btn-main-nav ${state.screen==='review'?'active':''}" onclick="state.screen='review'; state.activePageId=null; state.searchQuery=''; if(window.innerWidth <= 768) { state.notebooksCollapsed=true; state.sectionsCollapsed=true; } render()">📅 Révisions du jour${dueCount ? `<span class="nav-badge">${dueCount > 99 ? '99+' : dueCount}</span>` : ''}</button>
      <button class="btn-main-nav ${state.screen==='flagged'?'active':''}" onclick="state.screen='flagged'; state.activePageId=null; state.searchQuery=''; if(window.innerWidth <= 768) { state.notebooksCollapsed=true; state.sectionsCollapsed=true; } render()">🚩 Favoris${flagCount ? `<span class="nav-badge">${flagCount > 99 ? '99+' : flagCount}</span>` : ''}</button>
      <button class="btn-main-nav ${state.screen==='mistakes'?'active':''}" onclick="state.screen='mistakes'; state.activePageId=null; state.searchQuery=''; if(window.innerWidth <= 768) { state.notebooksCollapsed=true; state.sectionsCollapsed=true; } render()">❌ Mes erreurs${mistakeCount ? `<span class="nav-badge">${mistakeCount > 99 ? '99+' : mistakeCount}</span>` : ''}</button>
      <button class="btn-main-nav ${state.screen==='stats'?'active':''}" onclick="state.screen='stats'; state.activePageId=null; state.searchQuery=''; if(window.innerWidth <= 768) { state.notebooksCollapsed=true; state.sectionsCollapsed=true; } render()">📈 Statistiques</button>
      <button class="btn-main-nav ${state.screen==='rewards'?'active':''}" onclick="state.screen='rewards'; state.activePageId=null; state.searchQuery=''; if(window.innerWidth <= 768) { state.notebooksCollapsed=true; state.sectionsCollapsed=true; } render()">🎁 Récompenses</button>
      <button class="btn-main-nav ${state.screen==='memorize'?'active':''}" onclick="state.screen='memorize'; state.activePageId=null; if(window.innerWidth <= 768) { state.notebooksCollapsed=true; state.sectionsCollapsed=true; } render()">🧠 Mémoriser un texte</button>
      <button class="btn-main-nav ${state.screen==='library'?'active':''}" onclick="state.screen='library'; state.sectionsCollapsed=true; render()">📚 Bibliothèque</button>
      <button class="btn-main-nav ${state.screen==='calendar'?'active':''}" onclick="state.screen='calendar'; state.sectionsCollapsed=true; render()">📅 Calendrier</button>
      <button class="btn-main-nav ${state.screen==='studyplan'?'active':''}" onclick="state.screen='studyplan'; state.sectionsCollapsed=true; render()">📊 Programme d’étude</button>
      <button class="btn-main-nav ${state.screen==='revisiontable'?'active':''}" onclick="state.screen='revisiontable'; state.activePageId=null; state.sectionsCollapsed=true; render()">✅ Tableau de révision</button>
      <button class="btn-main-nav ${state.screen==='pomodoro'?'active':''}" onclick="state.screen='pomodoro'; state.activePageId=null; state.sectionsCollapsed=true; render()">🍅 Pomodoro</button>
    </div>
    <div class="xp-widget">
      <div class="flex-between" style="font-size: 0.9rem; font-weight: bold; margin-bottom: 5px;">
        <span>🏆 Niveau ${GAME_DATA.level}</span>
        <span title="Série actuelle">🔥 ${GAME_DATA.streak} j</span>
      </div>
      <div class="xp-bar-bg"><div class="xp-bar-fill" style="width: ${xpPercent}%;"></div></div>
      <div class="muted" style="font-size: 0.75rem; text-align: right; margin-top: 5px;">${xpPercent} / 100 XP</div>
    </div>
    <div class="nb-list-title" style="border-bottom: none; padding-bottom: 0;">
      <span>COULEUR D'ACCENT</span>
    </div>
    <div class="accent-row">${accentSwatchesHTML()}</div>
    <div class="nb-list-title"><span>CLÉ IA (GEMINI)</span></div>
    <div class="row" style="padding: 0 15px 15px 15px;"><button class="btn ghost" onclick="openGeminiKeySettings()">🔑 ${hasGeminiKey() ? 'Modifier ma clé' : 'Ajouter ma clé'}</button></div>
    <div class="nb-list-title">
      <span>MES MATIÈRES</span>
      <button class="btn-icon" onclick="addNotebook()" title="Ajouter une matière">➕</button>
    </div>
    <div class="nb-list">
      ${NOTEBOOKS.map(nb => `
        <div class="nb-item ${state.activeNbId === nb.id && state.screen!=='dashboard' && state.screen!=='stats' && state.screen!=='memorize' && state.screen!=='review' ? 'active' : ''}" onclick='selectNotebook(${JSON.stringify(nb.id)})'>
          <span>📘 ${escapeHtml(nb.title)}</span>
          <span class="item-actions">
            <button class="btn-icon" title="Renommer" onclick='event.stopPropagation(); renameNotebook(${JSON.stringify(nb.id)})'>✏️</button>
            <button class="btn-icon" title="Supprimer" onclick='event.stopPropagation(); deleteNotebook(${JSON.stringify(nb.id)})'>🗑️</button>
          </span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderSections() {
  const activeNb = NOTEBOOKS.find(n => n.id === state.activeNbId);
  if (!activeNb) return '';
  if (state.screen === 'dashboard' || state.screen === 'stats' || state.screen === 'memorize' || state.screen === 'review' || state.screen === 'flagged' || state.screen === 'library' || state.screen === 'calendar' || state.screen === 'studyplan' || state.screen === 'revisiontable' || state.screen === 'pomodoro' || state.screen === 'rewards' || state.screen === 'mistakes') return '';
  return `
    <div class="sec-header"><span>Sections</span><button class="btn-icon" onclick="addSection()" title="Ajouter une section">➕</button></div>
    <div class="sec-list">
      ${activeNb.sections.map(sec => `
        <div class="sec-item ${state.activeSecId === sec.id ? 'active' : ''}" onclick='selectSection(${JSON.stringify(sec.id)})'>
          <span>📂 ${escapeHtml(sec.title)}</span>
          <span class="item-actions">
            <button class="btn-icon" title="Renommer" onclick='event.stopPropagation(); renameSection(${JSON.stringify(sec.id)})'>✏️</button>
            <button class="btn-icon" title="Supprimer" onclick='event.stopPropagation(); deleteSection(${JSON.stringify(sec.id)})'>🗑️</button>
          </span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderRewards() {
  const xp = GAME_DATA.xp;
  const rewards = allRewards();
  const next = rewards.filter(r => xp < r.xp).sort((a, b) => a.xp - b.xp)[0];
  const cards = rewards.map(r => {
    const earned = xp >= r.xp;
    const pct = Math.min(100, Math.round((xp / r.xp) * 100));
    const removeBtn = r.custom ? `<button class="btn ghost" onclick="removeCustomReward('${escapeAttr(r.id)}')" aria-label="Supprimer la récompense ${escapeAttr(r.title)}" style="padding:4px 10px; font-size:0.8rem;">Supprimer</button>` : '';
    return `<div class="reward-card ${earned ? 'earned' : ''}"><div class="reward-icon">${earned ? r.icon : '🔒'}</div><div class="reward-body"><h3>${escapeHtml(r.title)}</h3><p class="muted">${escapeHtml(r.desc)}</p>${earned ? '<span class="reward-status">✅ Débloquée</span>' : `<div class="chart-bar-container"><div class="chart-bar-fill" style="width: ${pct}%; background: var(--primary);"></div></div><small class="muted">${xp} / ${r.xp} XP</small>`}${removeBtn}</div></div>`;
  }).join('');
  return `<div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal" aria-label="Menu principal">☰</button><h2>🎁 Récompenses</h2></div></div><div class="main-content"><div class="card"><p>Gagne de l'XP en répondant aux quiz et en révisant. Chaque palier débloque une récompense.</p>${next ? `<p><b>Prochaine :</b> ${next.icon} ${escapeHtml(next.title)}, encore ${next.xp - xp} XP</p>` : '<p><b>Toutes les récompenses sont débloquées !</b> 🎉</p>'}</div>
    <div class="card custom-reward-form"><h3>🎯 Mes récompenses</h3><p class="muted">Crée tes propres récompenses et choisis l'objectif d'XP à atteindre.</p><div class="row" style="flex-wrap: wrap; gap: 10px;"><input id="custom-reward-title" type="text" maxlength="60" placeholder="Ex. Un café" aria-label="Nom de la récompense" style="flex: 2; min-width: 180px; margin-bottom: 0;"><input id="custom-reward-xp" type="number" min="1" max="100000" placeholder="XP" aria-label="Objectif d'XP" style="flex: 1; min-width: 110px; margin-bottom: 0;"><button class="btn" onclick="addCustomReward()">＋ Ajouter</button></div></div>
    <div class="reward-grid">${cards}</div></div>`;
}
window.addCustomReward = () => {
  const title = document.getElementById('custom-reward-title')?.value.trim();
  const xp = Math.round(Number(document.getElementById('custom-reward-xp')?.value));
  if (!title) return alert('Donne un nom à ta récompense.');
  if (!(xp >= 1 && xp <= 100000)) return alert("Entre un objectif d'XP entre 1 et 100 000.");
  const id = 'c' + uniqueSuffix();
  const list = readPlanner(CUSTOM_REWARDS_KEY, []);
  list.push({ id, title: title.slice(0, 60), xp });
  lsSet(CUSTOM_REWARDS_KEY, JSON.stringify(list.slice(0, 50)));
  // Déjà atteint : on ne notifie pas, la récompense est considérée comme vue.
  if (GAME_DATA.xp >= xp) {
    const seen = readPlanner(REWARDS_SEEN_KEY, []);
    lsSet(REWARDS_SEEN_KEY, JSON.stringify([...seen, id]));
  }
  render();
};
window.removeCustomReward = (id) => {
  if (!confirm('Supprimer cette récompense ?')) return;
  lsSet(CUSTOM_REWARDS_KEY, JSON.stringify(readPlanner(CUSTOM_REWARDS_KEY, []).filter(r => r.id !== id)));
  render();
};

// --- Carnet d'erreurs ---
window.startMistakeQuiz = () => {
  const questions = mistakeQuestions();
  if (!questions.length) return alert('Aucune erreur à retenter.');
  state.mode = 'training';
  state.activePageId = null;
  startQuizLogic(questions.slice(0, 50));
};
window.removeMistakeAt = (index) => {
  const list = readPlanner(MISTAKES_KEY, []);
  if (!list[index]) return;
  list.splice(index, 1);
  lsSet(MISTAKES_KEY, JSON.stringify(list));
  render();
};
window.clearMistakes = () => {
  if (!confirm('Vider le carnet d’erreurs ?')) return;
  lsSet(MISTAKES_KEY, JSON.stringify([]));
  render();
};
function renderMistakes() {
  const list = readPlanner(MISTAKES_KEY, []);
  const retry = list.length ? `<button class="btn" onclick="startMistakeQuiz()">🔁 Retenter ces erreurs (${Math.min(50, list.length)})</button>` : '';
  const items = list.length
    ? list.map((m, i) => `<div class="card mistake-card"><div class="mistake-text"><span class="muted">${escapeHtml(m.date)}</span><h3>${escapeHtml(m.q.statement || '')}</h3><p class="muted" style="margin: 0;">Bonne réponse : ${escapeHtml(correctAnswerText(m.q))}</p></div><button class="btn ghost" onclick="removeMistakeAt(${i})" aria-label="Retirer cette erreur">Retirer</button></div>`).join('')
    : '<div class="card muted">Aucune erreur enregistrée. Bravo ! 🎉</div>';
  return `<div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal" aria-label="Menu principal">☰</button><h2>❌ Mes erreurs</h2></div><div class="row" style="gap: 10px;">${list.length ? '<button class="btn ghost" onclick="clearMistakes()">Vider</button>' : ''}${retry}</div></div><div class="main-content"><p class="muted" style="margin-top: 0;">Chaque question ratée arrive ici, et en sort quand tu la réussis.</p>${items}</div>`;
}

// --- Rapport de la semaine ---
function weeklyReportHTML() {
  const cur = weekTotals(0), prev = weekTotals(7);
  const accuracy = t => (t.answered ? Math.round(t.correct / t.answered * 100) : null);
  const diff = (a, b) => (a - b === 0 ? '= semaine passée' : (a > b ? '▲ +' + (a - b) : '▼ ' + (a - b)) + ' vs semaine passée');
  const accNow = accuracy(cur), accPrev = accuracy(prev);
  const accText = accNow === null ? '—' : accNow + '%';
  const accDelta = accNow === null || accPrev === null ? 'Pas assez de données la semaine passée' : (accNow - accPrev === 0 ? '= semaine passée' : (accNow > accPrev ? '▲ +' : '▼ ') + (accNow - accPrev) + ' pts vs semaine passée');
  return `<div class="card report-card"><div class="dash-card-head"><h3>📆 Rapport de la semaine</h3><span class="muted">7 derniers jours</span></div>
    <div class="report-grid">
      <div><span class="muted">Questions</span><b>${cur.answered}</b><small>${diff(cur.answered, prev.answered)}</small></div>
      <div><span class="muted">Précision</span><b>${accText}</b><small>${accDelta}</small></div>
      <div><span class="muted">XP</span><b>${cur.xp}</b><small>${diff(cur.xp, prev.xp)}</small></div>
    </div></div>`;
}
function renderMainContent() {
  if (state.screen === 'mistakes') return renderMistakes();
  if (state.screen === 'rewards') return renderRewards();
  if (state.screen === 'pomodoro') return renderPomodoro();
  if (state.screen === 'revisiontable') return renderRevisionOverview();
  if (state.screen === 'library') return renderLibrary();
  if (state.screen === 'calendar') return renderCalendar();
  if (state.screen === 'studyplan') return renderStudyPlan();
  if (state.screen === 'quiz') return renderQuiz();
  if (state.screen === 'results') return renderResults();
  if (state.screen === 'dashboard') return renderDashboard();
  if (state.screen === 'stats') return renderStats();
  if (state.screen === 'memorize') return renderMemorize();
  if (state.screen === 'review') return renderReview();
  if (state.screen === 'flagged') return renderFlagged();
  const activeNb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
  const activeSec = activeNb?.sections.find(s=>s.id===state.activeSecId);
  if (!activeSec) {
    // 🔧 FIX : sans section, l'écran n'avait ni en-tête ni bouton pour en créer une.
    const emptyAction = activeNb
      ? `<button class="btn ghost" onclick="addSection()">➕ Section</button>`
      : `<button class="btn ghost" onclick="addNotebook()">➕ Matière</button>`;
    const emptyText = activeNb
      ? 'Aucune section pour cette matière. Clique sur « ➕ Section » pour commencer.'
      : 'Aucune matière. Clique sur « ➕ Matière » pour commencer.';
    return `
      <div class="main-header">
        <div class="row">
          <button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button>
          <h2>${escapeHtml(activeNb?.title || 'Révisoria')}</h2>
        </div>
        ${emptyAction}
      </div>
      <div class="main-content">
        <p class="muted">${emptyText}</p>
      </div>
    `;
  }
  if (state.activePageId) {
    const page = activeSec.pages.find(p => p.id === state.activePageId);
  if (page) return renderPageContent(page, activeSec);
  }
  return `
    <div class="main-header">
      <div class="row">
        <button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button>
        <button class="btn ghost" onclick="toggleSections()" title="Menu des sections" style="font-size: 0.9rem; padding: 8px 12px;">📂 Sections</button>
        <h2>${escapeHtml(activeSec.title)}</h2>
      </div>
      <button class="btn ghost" onclick="addPage()">➕ Page</button>
    </div>
    <div class="main-content">
      <div class="pages-grid">
        ${activeSec.pages.map(p => `
          <div class="page-card" onclick='selectPage(${JSON.stringify(p.id)})'>
            <span class="delete-btn" onclick="event.stopPropagation(); deletePage('${jsAttr(p.id)}')">🗑️</span>
            <h3>📄 ${escapeHtml(p.title)}</h3>
            <div class="meta">${p.questions.length} question(s)</div>
            ${p.resources && p.resources.length > 0 ? `<div class="meta" style="color: var(--primary); margin-top: 5px; font-weight: bold;">📎 ${p.resources.length} ressource(s)</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}
window.scoreMemory = (correct) => {
  const m = safeJsonParse(lsGet('quizmaster_memory_modes'), {runs:0,correct:0,reviews:[],cards:[]});
  m.runs++; if(correct) m.correct++;
  const day=localDateStr(); m.reviews=[...(m.reviews||[]),{day,mode:state.memoryMode||'cloze',correct:!!correct}].slice(-200);
  lsSet('quizmaster_memory_modes',JSON.stringify(m));
  addDailyXp(correct ? 10 : 3); GAME_DATA.level=Math.floor(GAME_DATA.xp/100)+1; saveData();
  document.querySelectorAll('.memory-grade button').forEach(b=>b.disabled=true);const status=document.getElementById('memory-card-status');if(status)status.textContent=correct?'✅ Bravo, tu as retenu cette carte.':'📌 Cette carte sera à revoir.';
  const next=document.getElementById('memory-card-next');if(next)next.hidden=false;
};
window.memoryCard = () => {
  const text=(state.memoText||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const sentences=text.split(/(?<=[.!?])\s+/).filter(s=>s.length>20);
  if(!sentences.length)return alert('Ajoute des phrases au texte.');
  let i=Number(lsGet('quizmaster_card_index'))||0; const s=sentences[i%sentences.length];
  const sw=s.split(/\s+/),cut=Math.max(1,Math.ceil(sw.length/2));
  const el=document.getElementById('memory-card'); if(el)el.innerHTML=`<article class="memory-flashcard"><span class="memory-card-label">CARTE ${i%sentences.length+1} / ${sentences.length}</span><p class="memory-card-front">${escapeHtml(sw.slice(0,cut).join(' '))} <span>…</span></p><div class="memory-card-back" hidden>${escapeHtml(sw.slice(cut).join(' '))}</div><button class="btn ghost" onclick="this.previousElementSibling.hidden=false;this.hidden=true;this.nextElementSibling.hidden=false">Afficher la réponse</button><div class="row memory-grade" hidden><button class="btn ghost" onclick="scoreMemory(false)">À revoir</button><button class="btn" onclick="scoreMemory(true)">Je savais</button></div><p id="memory-card-status" aria-live="polite"></p><button id="memory-card-next" class="btn" hidden onclick="nextMemoryCard()">Carte suivante →</button></article>`;
};
window.nextMemoryCard=()=>{const i=(Number(lsGet('quizmaster_card_index'))||0)+1;lsSet('quizmaster_card_index',String(i));window.memoryCard();};
window.checkMemoryQuiz=mode=>{const inputs=[...document.querySelectorAll('.memory-quiz-options input')];const chosen=inputs.filter(x=>x.checked).map(x=>x.value).sort();const answer=inputs.filter(x=>x.dataset.correct==='true').map(x=>x.value).sort();const correct=chosen.length===answer.length&&chosen.every((x,i)=>x===answer[i]);inputs.forEach(x=>{x.disabled=true;if(x.dataset.correct==='true')x.closest('label')?.classList.add('correct');else if(x.checked)x.closest('label')?.classList.add('incorrect');});const fb=document.getElementById('memory-quiz-feedback');if(fb)fb.textContent=correct?'✅ Bonne réponse !':'❌ À revoir : '+answer.join(', ');scoreMemory(correct);const next=document.getElementById('memory-quiz-next');if(next)next.hidden=false;};
window.nextMemoryQuiz=()=>{state.memoryQuizIndex=(Number(state.memoryQuizIndex)||0)+1;render();};
window.updateMemoryVoices = () => {
  const select=document.getElementById('memory-voice'); if(!select||!('speechSynthesis'in window))return;
  const lang=document.getElementById('memory-language')?.value||'fr-FR';
  const voices=speechSynthesis.getVoices().filter(v=>v.lang.toLowerCase().startsWith(lang.slice(0,2).toLowerCase()));
  const saved=lsGet('quizmaster_memory_voice')||'';
  select.innerHTML='<option value="">Voix par défaut</option>'+voices.map(v=>`<option value="${escapeAttr(v.name)}">${escapeHtml(v.name)}${v.localService?' · locale':''}</option>`).join('');
  select.value=voices.some(v=>v.name===saved)?saved:'';
};
window.speakMemory = () => {
  if(!('speechSynthesis'in window))return alert('Synthèse vocale indisponible dans ce navigateur.');
  speechSynthesis.cancel();const u=new SpeechSynthesisUtterance((state.memoText||'').replace(/<[^>]+>/g,' '));
  u.lang=document.getElementById('memory-language')?.value||'fr-FR';u.rate=Number(document.getElementById('memory-speed')?.value)||1;
  const name=document.getElementById('memory-voice')?.value;u.voice=speechSynthesis.getVoices().find(v=>v.name===name)||null;speechSynthesis.speak(u);
};
window.reciteMemory = () => {
  const Rec=window.SpeechRecognition||window.webkitSpeechRecognition;const out=document.getElementById('memory-recite');
  if(!Rec)return out.textContent='Reconnaissance vocale indisponible. Utilise le mode initiales pour le rappel actif.';
  const r=new Rec();r.lang='fr-FR';r.interimResults=false;r.onresult=e=>{const said=e.results[0][0].transcript.toLowerCase().split(/\W+/),original=(state.memoText||'').replace(/<[^>]+>/g,' ').toLowerCase().split(/\W+/).filter(Boolean);let ok=0;const set=new Set(said);original.forEach(w=>{if(set.has(w))ok++});const pct=original.length?Math.round(100*ok/original.length):0;out.innerHTML=`Rappel : ${pct}%<p>${escapeHtml(e.results[0][0].transcript)}</p>`;window.scoreMemory(pct>=70);};r.onerror=()=>{out.textContent='Micro indisponible ou autorisation refusée.'};r.start();out.textContent='Écoute en cours…';
};
window.addEventListener('load',()=>{const d=localDateStr();if(lsGet('quizmaster_memory_login')!==d){addDailyXp(5);GAME_DATA.level=Math.floor(GAME_DATA.xp/100)+1;GAME_DATA.streak=GAME_DATA.lastPlayed===d?GAME_DATA.streak:GAME_DATA.streak+1;GAME_DATA.lastPlayed=d;lsSet('quizmaster_memory_login',d);saveData();}});
function renderMemorize() {
  const plainNode=document.createElement('div');plainNode.innerHTML=sanitizeMemoHtml(state.memoText||'');
  const plain = String(plainNode.innerText||plainNode.textContent||'').replace(/\s+/g, ' ').trim();
  const words = plain.split(/\s+/).filter(Boolean);
  const mm = JSON.parse(localStorage.getItem('quizmaster_memory_modes') || '{"runs":0,"correct":0,"reviews":[],"cards":[]}');
  const pct = mm.runs ? Math.round(100 * mm.correct / mm.runs) : 0;
  const nextMode = pct >= 80 ? 'recite' : 'cloze';
  const plan = [{d:0,m:'Cloze'},{d:1,m:'Flashcards'},{d:3,m:'Initiales'},{d:6,m:'Réciter'}];
  const mode = state.memoryMode || 'cloze';
  let exercise = '';
  if (mode === 'cloze' && words.length) {
    if(state.memoHtml){const memo=document.createElement('div');memo.innerHTML=sanitizeMemoHtml(state.memoHtml);memo.querySelectorAll('.blank').forEach(el=>{const b=document.createElement('button');b.className='memory-blank';b.type='button';b.textContent='______';b.dataset.answer=el.textContent||'';el.replaceWith(b);});exercise=`<div class="memory-cloze-text" id="memory-cloze">${sanitizeMemoHtml(memo.innerHTML)}</div><p class="muted">Clique sur un blanc pour révéler le mot.</p>`;}
    else {
    const hide = Math.max(1, Math.round(words.length * ((state.memoDifficulty || 30)/100)));
    let seen=0; exercise=`<div class="memory-exercise">${words.map((w,i)=> {const hideThis=/[\p{L}\p{N}]/u.test(w) && ((i*2654435761>>>0)%words.length)<hide && seen++<hide; return hideThis?`<button class="memory-blank" type="button" data-answer="${escapeAttr(w)}">______</button>`:escapeHtml(w);}).join(' ')}</div><label>Trous : ${state.memoDifficulty||30}% <input type="range" min="10" max="80" step="10" value="${state.memoDifficulty||30}" oninput="state.memoDifficulty=+this.value;render()"></label>`;
    }
  } else if ((mode === 'qcs' || mode === 'qcm') && words.length) {
    const vocab=[...new Set(words.map(w=>w.replace(/[^\p{L}\p{N}'’-]/gu,'')).filter(w=>w.length>4))];
    if(vocab.length){const ix=(Number(state.memoryQuizIndex)||0)%vocab.length;const selected=mode==='qcm'?vocab.slice(ix,ix+2).length?vocab.slice(ix,ix+2):[vocab[ix]]:[vocab[ix]];const decoyPool=['système','énergie','mémoire','organe','cellule','réaction','fonction','processus','structure','signal','molécule','mouvement','matière','résultat'].filter(w=>!vocab.includes(w)&&!selected.includes(w));const options=[...selected,...decoyPool.slice(0,Math.max(3,5-selected.length))].sort((a,b)=>a.localeCompare(b));exercise=`<div class="memory-quiz-card"><span class="memory-card-label">QUESTION ${(Number(state.memoryQuizIndex)||0)+1}</span><h4>${mode==='qcs'?'Choisis le mot présent dans ton texte':'Choisis les mots présents dans ton texte'}</h4><p class="memory-quiz-context">${escapeHtml(plain.slice(0,180))}${plain.length>180?'…':''}</p><div class="memory-quiz-options">${options.map(w=>`<label><input type="${mode==='qcs'?'radio':'checkbox'}" name="memory-answer" value="${escapeAttr(w)}" data-correct="${selected.includes(w)}"><span>${escapeHtml(w)}</span></label>`).join('')}</div><div class="row"><button class="btn" onclick="checkMemoryQuiz('${mode}')">Vérifier</button><button id="memory-quiz-next" class="btn ghost" hidden onclick="nextMemoryQuiz()">Suivant →</button></div><p id="memory-quiz-feedback" aria-live="polite"></p></div>`;}
  } else if (mode === 'cloze' && words.length) {
  } else if (mode === 'first' && words.length) exercise=`<div class="memory-exercise">${words.map(w=>escapeHtml(w[0]||'')+'…').join(' ')}</div><button class="btn ghost" onclick="this.nextElementSibling.hidden=false">👁️ Afficher le texte</button><div hidden>${escapeHtml(plain)}</div>`;
  else if (mode === 'cards') exercise=`<p>${mm.cards?.length||Math.max(1,plain.split(/[.!?]/).filter(Boolean).length)} cartes générées depuis les phrases du cours.</p><button class="btn" onclick="memoryCard()">Réviser une carte</button><div id="memory-card"></div>`;
  else if (mode === 'audio') exercise=`<div class="row"><label>Langue <select id="memory-language" onchange="updateMemoryVoices();localStorage.setItem('quizmaster_memory_language',this.value)">${[['fr-FR','Français'],['en-US','English (US)'],['en-GB','English (UK)'],['es-ES','Español'],['de-DE','Deutsch'],['it-IT','Italiano'],['ar-SA','العربية']].map(([v,n])=>`<option value="${v}" ${((lsGet('quizmaster_memory_language')||'fr-FR')===v)?'selected':''}>${n}</option>`).join('')}</select></label><label>Voix <select id="memory-voice" onchange="localStorage.setItem('quizmaster_memory_voice',this.value)"><option>Chargement des voix…</option></select></label></div><label>Vitesse <output id="memory-speed-value">1.0×</output><input id="memory-speed" type="range" min="0.5" max="2" step="0.1" value="${lsGet('quizmaster_memory_speed')||'1'}" oninput="document.getElementById('memory-speed-value').textContent=Number(this.value).toFixed(1)+'×';localStorage.setItem('quizmaster_memory_speed',this.value)"></label><div class="row"><button class="btn" onclick="speakMemory()">🔊 Lire le texte</button><button class="btn ghost" onclick="speechSynthesis.cancel()">⏹ Arrêter</button></div>`;
  else if (mode === 'recite') exercise=`<p>Récite le texte. La reconnaissance vocale compare les mots quand elle est disponible.</p><button class="btn" onclick="reciteMemory()">🎙️ Commencer</button><div id="memory-recite"></div>`;
  else if (mode === 'chunks' && words.length) {const chunks=plain.split(/(?<=[.!?])\s+/).filter(Boolean); exercise=`<p>Remets les idées dans l’ordre en appuyant sur les blocs :</p><div class="memory-chunks">${chunks.map((c,i)=>`<button class="btn ghost" draggable="true" data-chunk="${i}">${escapeHtml(c)}</button>`).join('')}</div><button class="btn" onclick="scoreMemory(true)">Valider mon rappel</button>`;}
  return `<div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" aria-label="Menu principal">☰</button><h2>🧠 Mémoriser un texte</h2></div></div><div class="main-content"><div class="card"><h3>Ton cours</h3><label class="btn ghost">📄 Importer un PDF<input type="file" accept="application/pdf,.pdf" onchange="loadMemoPdf(this)" hidden></label><div class="row"><button class="btn ghost" onclick="highlightText()">🖍️ Surligner des mots à cacher</button><button class="btn" onclick="generateMemoText()">Générer les exercices</button></div><div id="memo-input" class="rich-textarea" contenteditable="true">${sanitizeMemoHtml(state.memoText||'')}</div></div><div class="memory-tabs">${[['cloze','🧩 Trous'],['cards','🔁 Cartes'],['qcs','📝 QCS'],['qcm','☑️ QCM'],['recite','🎙️ Réciter'],['first','📝 Initiales'],['chunks','🗺️ Découper'],['audio','🎧 Audio']].map(([m,n])=>`<button class="btn ${mode===m?'':'ghost'}" onclick="state.memoryMode='${m}';render()">${n}</button>`).join('')}</div><div class="card"><h3>${mode==='cloze'?'Complète le texte':mode==='cards'?'Répétition espacée':mode==='qcs'?'QCS · une bonne réponse':mode==='qcm'?'QCM · plusieurs réponses':mode==='recite'?'Réciter et comparer':mode==='first'?'Premières lettres':mode==='chunks'?'Blocs de mémoire':'Écoute en boucle'}</h3>${exercise||'<p>Colle ou importe d’abord un texte, puis clique sur « Générer les exercices ».</p>'}</div><div class="card"><h3>🌱 Progression mémoire</h3><p>Score de rappel : ${pct}% · ${mm.runs} exercices · niveau ${GAME_DATA.level} · ${GAME_DATA.xp} XP · série ${GAME_DATA.streak} jours</p><p>Prochaine suggestion : ${nextMode==='recite'?'réciter le texte':'faire un exercice à trous'}</p><p>Plan : ${plan.map(x=>`J+${x.d} ${x.m}`).join(' · ')}</p></div></div>`;
  /* legacy renderer retained below for migrations */
  return `
    <div class="main-header">
      <div class="row">
        <button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button>
        <h2>🧠 Mémoriser un texte</h2>
      </div>
    </div>
    <div class="main-content">
      <div class="card" style="background: rgba(59,130,246,0.05); border-color: rgba(59,130,246,0.2);">
        <h3>Comment ça marche ?</h3>
        <p class="muted">Colle ton cours ci-dessous. <b>Sur ligne les mots-clés en jaune</b> (tu peux utiliser le bouton ci-dessous), puis clique sur "Générer". L'outil ne masquera <b>que les mots surlignés</b> !</p>
      </div>
      <div class="row" style="align-items: flex-start; gap: 25px;">
        <div class="card" style="flex: 1;">
          <h3>1. Ton cours</h3>
          <label class="btn ghost" style="display:inline-block;cursor:pointer;margin-bottom:10px;">📄 Importer un PDF<input type="file" accept="application/pdf,.pdf" onchange="loadMemoPdf(this)" style="display:none"></label>
          <div style="margin-bottom: 10px;">
            <button class="btn ghost" onclick="highlightText()" style="padding: 8px 12px; font-size: 0.9rem;">🖍️ Surligner la sélection en jaune</button>
          </div>
          <!-- 🔧 FIX 10: on n'injecte que du HTML échappé -->
          <div id="memo-input" class="rich-textarea" contenteditable="true" placeholder="Colle ton texte ici...">${sanitizeMemoHtml(state.memoText || '')}</div>
          <button class="btn" onclick="generateMemoText()" style="width: 100%; margin-top: 10px;">Générer le texte à trous</button>
        </div>
        <div class="card" style="flex: 1;">
          <h3>2. À toi de jouer</h3>
          ${state.memoHtml ? `
            <div class="memorize-text" id="memo-output">${sanitizeMemoHtml(state.memoHtml)}</div>
            <div id="memo-qcs" class="card" style="margin-top:15px;"><button class="btn" onclick="startMemoQcs()">❓ Quiz QCS sur un mot caché</button></div>
            <button class="btn ghost" style="margin-top:10px;" onclick="document.querySelectorAll('#memo-output .blank').forEach(b=>{b.classList.add('revealed');b.dataset.answered='1'})">👁️ Tout révéler</button>
            <button class="btn ghost" style="margin-top: 30px; width: 100%;" onclick="state.memoHtml = ''; render()">Recommencer</button>
          ` : `
            <p class="muted" style="text-align: center; margin-top: 50px;">Le texte à trous apparaîtra ici.</p>
          `}
        </div>
      </div>
    </div>
  `;
}

// Personal resource library, exam calendar and weekly study planner.
const readPlanner = (key, fallback) => safeJsonParse(lsGet(key), fallback);
window.openLibraryItem = (url) => { try { window.open(new URL(url).href, '_blank', 'noopener'); } catch (_) { alert('Lien invalide'); } };
window.openPlannerForm = (kind) => {
  const configs={library:{title:'Ajouter à ma bibliothèque',fields:[['title','Nom du cours ou de la ressource','text','Ex. Cours de cardiologie'],['url','Lien Google Drive ou URL','url','https://drive.google.com/...']],button:'Enregistrer la ressource'},calendar:{title:'Ajouter une date importante',fields:[['title','Nom de l’événement ou de l’examen','text','Ex. Examen de pharmacologie'],['date','Date','date','']],button:'Ajouter au calendrier'},study:{title:'Planifier une séance',fields:[['day','Jour de la semaine','select','Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche'],['subject','Matière / activité','text','Ex. Révision cardio'],['start','Heure de début','time','09:00'],['hours','Durée en heures','number','1']]}};
  const c=configs[kind];if(!c)return;
  document.getElementById('planner-form')?.remove();
  const d=document.createElement('dialog');d.id='planner-form';d.className='planner-dialog';
  d.innerHTML=`<form method="dialog" class="planner-form"><div class="planner-form-head"><span class="planner-icon">${kind==='library'?'📚':kind==='calendar'?'📅':'📊'}</span><button type="button" class="planner-close" aria-label="Fermer">×</button></div><h2>${c.title}</h2><p class="muted">Tes informations seront enregistrées dans ce navigateur.</p>${c.fields.map(([id,label,type,placeholder])=>`<label class="planner-field">${label}${type==='select'?`<select name="${id}" required>${placeholder.split('|').map(v=>`<option>${v}</option>`).join('')}</select>`:`<input name="${id}" type="${type}" ${id==='hours'?'min="0.25" max="12" step="0.25"':''} placeholder="${placeholder}" ${id==='url'||id==='date'?'required':''} required>`}</label>`).join('')}<div class="planner-actions"><button type="button" class="btn ghost planner-cancel">Annuler</button><button class="btn" type="submit">${c.button}</button></div></form>`;
  document.body.append(d);const close=()=>d.close();d.querySelectorAll('.planner-close,.planner-cancel').forEach(b=>b.onclick=close);
  d.onsubmit=e=>{e.preventDefault();const f=new FormData(d.querySelector('form'));let key,entry;
    if(kind==='library'){key='quizmaster_library';const raw=String(f.get('url')).trim();try{const u=new URL(raw);if(!['http:','https:'].includes(u.protocol))throw 0;entry={id:Date.now(),title:String(f.get('title')).trim(),url:u.href,date:localDateStr()}}catch(_){d.querySelector('[name=url]').setCustomValidity('Entre un lien qui commence par https://');d.querySelector('[name=url]').reportValidity();return}}
    else if(kind==='calendar'){key='quizmaster_calendar';entry={id:Date.now(),title:String(f.get('title')).trim(),date:String(f.get('date'))}}
    else {key='quizmaster_study_plan';const hours=Number(f.get('hours'));if(!hours||hours>12)return;entry={id:Date.now(),day:String(f.get('day')),subject:String(f.get('subject')).trim(),start:String(f.get('start')||'09:00'),hours,completed:false}}
    const rows=readPlanner(key,[]);rows.push(entry);lsSet(key,JSON.stringify(rows));d.close();render();};
  d.showModal();d.querySelector('input')?.focus();
};
window.addLibraryItem = () => openPlannerForm('library');
window.removeLibraryItem = (id) => { if(!confirm('Retirer cette ressource de la bibliothèque ?'))return;lsSet('quizmaster_library',JSON.stringify(readPlanner('quizmaster_library',[]).filter(x=>x.id!==id)));render(); };
window.addCalendarEvent = () => openPlannerForm('calendar');
window.removeCalendarEvent = id => {lsSet('quizmaster_calendar',JSON.stringify(readPlanner('quizmaster_calendar',[]).filter(e=>e.id!==id)));render();};
window.addStudyBlock = () => openPlannerForm('study');
window.removeStudyBlock=id=>{lsSet('quizmaster_study_plan',JSON.stringify(readPlanner('quizmaster_study_plan',[]).filter(x=>x.id!==id)));render();};
function renderLibrary() {
  const items=readPlanner('quizmaster_library',[]);
  return `<div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button><h2>📚 Bibliothèque et ressources</h2></div><button class="btn" onclick="addLibraryItem()">＋ Ajouter un lien</button></div><div class="main-content">${deckCardHTML()}<div class="card"><p>Ajoute tes cours, documents et dossiers Google Drive. Les fichiers restent dans ton Drive ; Révisoria garde leurs liens ici.</p><button class="btn ghost" onclick="openLibraryItem('https://drive.google.com')">Ouvrir Google Drive</button></div>${items.length?items.map(x=>`<div class="card flex-between"><div><h3>${escapeHtml(x.title)}</h3><span class="muted">Ajouté le ${escapeHtml(x.date)}</span></div><div class="row"><button class="btn" onclick='openLibraryItem(${JSON.stringify(x.url)})'>Ouvrir</button><button class="btn ghost" onclick="removeLibraryItem(${x.id})">Retirer</button></div></div>`).join(''):'<div class="card muted">Ta bibliothèque est vide. Ajoute un lien de cours ou un dossier Drive.</div>'}</div>`;
}
function renderCalendar() {
  const events=readPlanner('quizmaster_calendar',[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  return `<div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button><h2>📅 Calendrier et examens</h2></div><button class="btn" onclick="addCalendarEvent()">＋ Ajouter une date</button></div><div class="main-content"><div class="card"><p>Note tes examens et événements pour voir le compte à rebours.</p></div>${events.length?events.map(e=>{const days=Math.ceil((new Date(e.date+'T00:00:00')-new Date(localDateStr()+'T00:00:00'))/86400000);return `<div class="card flex-between"><div><h3>${escapeHtml(e.title)}</h3><span class="muted">${escapeHtml(e.date)}</span></div><b>${days<0?'Passé':days===0?'Aujourd’hui':`${days} jour(s) restant(s)`}</b><button class="btn ghost" onclick="removeCalendarEvent(${e.id})">Supprimer</button></div>`}).join(''):'<div class="card muted">Aucun événement planifié.</div>'}</div>`;
}
const STUDY_DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const STUDY_START_HOUR = 7;
const STUDY_SLOTS = 32; // créneaux de 30 minutes, de 07:00 à 23:00
// Heure « HH:MM » du créneau n, et numéro de créneau d'une heure donnée.
function studySlotTime(slot) { return `${String(STUDY_START_HOUR + Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`; }
function studySlotOf(time) {
  const [hh, mm] = String(time || '09:00').split(':').map(Number);
  return Math.max(0, Math.min(STUDY_SLOTS - 1, (hh - STUDY_START_HOUR) * 2 + Math.floor((mm || 0) / 30)));
}
window.moveStudySession = (id, changes) => {
  const plan = readPlanner('quizmaster_study_plan', []);
  const item = plan.find(x => x.id === id);
  if (!item) return;
  Object.assign(item, changes);
  lsSet('quizmaster_study_plan', JSON.stringify(plan));
  render();
};
// Déposer une séance sur une ligne de jour : le créneau suit la position horizontale du curseur.
window.dropStudySession = (event, day) => {
  event.preventDefault();
  const id = Number(event.dataTransfer.getData('text/plain'));
  const item = readPlanner('quizmaster_study_plan', []).find(x => x.id === id);
  if (!item) return;
  const span = Math.max(1, Math.round(Number(item.hours || 1) * 2));
  const rect = event.currentTarget.getBoundingClientRect();
  const slot = Math.max(0, Math.min(STUDY_SLOTS - span, Math.floor((event.clientX - rect.left) / rect.width * STUDY_SLOTS)));
  moveStudySession(id, { day, start: studySlotTime(slot) });
};
function renderStudyPlan() {
  const plan = readPlanner('quizmaster_study_plan', []);
  const hourHead = Array.from({ length: 16 }, (_, i) => `<span style="grid-column:${i * 2 + 1}/span 2">${String(i + STUDY_START_HOUR).padStart(2, '0')}:00</span>`).join('');
  const dayRows = STUDY_DAYS.map(day => {
    const placed = plan
      .filter(x => String(x.day).toLowerCase() === day.toLowerCase())
      .map(x => {
        const first = studySlotOf(x.start);
        const span = Math.max(1, Math.min(STUDY_SLOTS - first, Math.round(Number(x.hours || 1) * 2)));
        return { x, first, span };
      })
      .sort((a, b) => a.first - b.first);
    // Les séances qui se chevauchent occupent des lignes différentes au lieu de se masquer.
    const laneEnds = [];
    placed.forEach(p => {
      let lane = laneEnds.findIndex(end => end <= p.first);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = p.first + p.span;
      p.lane = lane;
    });
    const lanes = Math.max(1, laneEnds.length);
    const blocks = placed.map(({ x, first, span, lane }) => `<div class="study-session ${x.completed ? 'completed' : ''}" draggable="true" ondragstart="event.dataTransfer.setData('text/plain', '${x.id}')" style="grid-column:${first + 1}/span ${span};grid-row:${lane + 1}" title="${escapeAttr(x.subject)} · ${escapeAttr(x.start || '09:00')} · ${x.hours} h"><label><input type="checkbox" ${x.completed ? 'checked' : ''} onchange="markStudyComplete(${x.id},this.checked)"><span>${escapeHtml(x.subject)}</span></label><small>${escapeHtml(x.start || '09:00')} · ${x.hours} h</small><button type="button" onclick="removeStudyBlock(${x.id})" aria-label="Supprimer la séance">×</button></div>`).join('');
    return `<div class="study-day-row" style="height:${lanes * 52}px"><b class="study-day-name">${day}</b><div class="study-timeline" style="grid-template-rows:repeat(${lanes},1fr)" ondragover="event.preventDefault()" ondrop="dropStudySession(event,'${day}')">${blocks || '<span class="study-empty-day">Glisse une séance ici</span>'}</div></div>`;
  }).join('');
  const dayOptions = day => STUDY_DAYS.map(d => `<option ${d === day ? 'selected' : ''}>${d}</option>`).join('');
  const timeOptions = start => Array.from({ length: STUDY_SLOTS }, (_, i) => studySlotTime(i)).map(t => `<option ${t === start ? 'selected' : ''}>${t}</option>`).join('');
  const sessionDetails = plan.length ? `<div class="study-session-list"><h3>📚 Détail des séances</h3>${plan.map(x => `<div class="study-session-detail ${x.completed ? 'completed' : ''}"><label><input type="checkbox" ${x.completed ? 'checked' : ''} onchange="markStudyComplete(${x.id},this.checked)"><span><b>${escapeHtml(x.subject || 'Séance')}</b><small>${escapeHtml(x.hours || 1)} h</small></span></label><div class="study-move"><select aria-label="Jour de la séance" onchange="moveStudySession(${x.id},{day:this.value})">${dayOptions(x.day)}</select><select aria-label="Heure de début" onchange="moveStudySession(${x.id},{start:this.value})">${timeOptions(studySlotTime(studySlotOf(x.start)))}</select><button type="button" onclick="removeStudyBlock(${x.id})" aria-label="Supprimer la séance">Supprimer</button></div></div>`).join('')}</div>` : '';
  return `<div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button><h2>📊 Programme d’étude</h2></div><button class="btn" onclick="addStudyBlock()">＋ Ajouter une séance</button></div><div class="main-content"><div class="card study-planner-card"><p>Glisse une séance vers un autre jour ou une autre heure, ou change-la dans la liste ci-dessous. Coche-la pour la marquer comme terminée.</p><div class="study-grid-scroll"><div class="study-hour-head"><span>Jour</span><div class="study-hour-labels">${hourHead}</div></div>${dayRows}</div><div class="study-legend"><span><i></i> Séance prévue</span><span>☑ Terminée</span><small>Affichage de 07 h à 23 h · pas de 30 minutes</small></div>${sessionDetails}</div>${plan.length ? `<p class="muted">${plan.filter(x => x.completed).length} / ${plan.length} séances terminées</p>` : '<div class="card muted">Aucune séance prévue. Ajoute une séance pour commencer.</div>'}</div>`;
}
window.markStudyComplete=(id,checked)=>{const plan=readPlanner('quizmaster_study_plan',[]);const item=plan.find(x=>x.id===id);if(item)item.completed=!!checked;lsSet('quizmaster_study_plan',JSON.stringify(plan));render();};
const DEFAULT_REVISION_STEPS = [
  { key: 'c1', label: 'Couche 1' }, { key: 'c2', label: 'Couche 2' }, { key: 'c3', label: 'Couche 3' },
  { key: 'qcm1', label: 'QCM 1' }, { key: 'qcm2', label: 'QCM 2' }, { key: 'td', label: 'TD' }, { key: 'tp', label: 'TP' }
];
// Étapes personnalisables (nom et nombre). Les cases restent liées à leur clé, donc renommer une étape garde son historique.
function getRevisionSteps() {
  const saved = readPlanner('quizmaster_revision_steps', null);
  return Array.isArray(saved) && saved.length ? saved : DEFAULT_REVISION_STEPS;
}
function saveRevisionSteps(steps) { lsSet('quizmaster_revision_steps', JSON.stringify(steps)); render(); }
window.toggleRevisionEditor = () => { state.revisionEditing = !state.revisionEditing; render(); };
window.renameRevisionStep = (key, label) => {
  const text = String(label).trim();
  saveRevisionSteps(getRevisionSteps().map(s => s.key === key ? { ...s, label: text || s.label } : s));
};
window.addRevisionStep = () => saveRevisionSteps([...getRevisionSteps(), { key: 'st' + uniqueSuffix(), label: 'Nouvelle étape' }]);
window.removeRevisionStep = (key) => {
  const steps = getRevisionSteps();
  if (steps.length <= 1) return;
  saveRevisionSteps(steps.filter(s => s.key !== key));
};
window.resetRevisionSteps = () => {
  if (!confirm('Revenir aux étapes par défaut ?')) return;
  lsSet('quizmaster_revision_steps', 'null');
  render();
};
function revisionEditorHTML() {
  const steps = getRevisionSteps();
  return `<div class="card revision-editor">
    <div class="flex-between"><h3 style="margin: 0;">Étapes de révision</h3><button class="btn ghost" onclick="resetRevisionSteps()">Réinitialiser</button></div>
    <p class="muted" style="margin: 0;">Renomme, ajoute ou supprime des étapes. Elles s'appliquent à toutes tes pages.</p>
    ${steps.map((s, i) => `<div class="revision-editor-row"><span class="muted">${i + 1}</span><input value="${escapeAttr(s.label)}" aria-label="Nom de l'étape ${i + 1}" onchange='renameRevisionStep(${JSON.stringify(s.key)},this.value)'><button class="btn ghost" onclick='removeRevisionStep(${JSON.stringify(s.key)})' ${steps.length <= 1 ? 'disabled' : ''} aria-label="Supprimer l'étape">✕</button></div>`).join('')}
    <div><button class="btn" onclick="addRevisionStep()">＋ Ajouter une étape</button></div>
  </div>`;
}
// Une ligne par page, une colonne par étape (comme une table Notion).
// Une ligne par page, une colonne par étape (comme une table Notion).
// Étapes en lignes (de haut en bas), pages en colonnes : tableau compact.
// Chaque étape se renomme et se supprime directement sur sa ligne ; « ＋ Étape » ajoute une ligne.
function renderRevisionSection(nb, sec, steps, all) {
  const pages = sec.pages || [];
  const doneOf = page => steps.filter(s => all[page.id]?.[s.key]?.done).length;
  const head = `<tr><th scope="col" class="revision-corner">Étape</th>${pages.map(page => `<th scope="col" class="revision-page-col"><div class="revision-page-cell"><span class="revision-page-name" title="${escapeAttr(page.title)}">📄 ${escapeHtml(page.title)}</span><button class="btn ghost revision-open" onclick='state.activeNbId=${JSON.stringify(nb.id)};state.activeSecId=${JSON.stringify(sec.id)};selectPage(${JSON.stringify(page.id)})'>Ouvrir</button></div></th>`).join('')}</tr>`;
  const rows = steps.map(s => `<tr>
      <th scope="row" class="revision-step-cell"><div class="revision-step-line">
        <input class="revision-head-input" value="${escapeAttr(s.label)}" aria-label="Nom de l'étape" onchange='renameRevisionStep(${JSON.stringify(s.key)},this.value)'>
        <button class="revision-head-remove" onclick='removeRevisionStep(${JSON.stringify(s.key)})' ${steps.length <= 1 ? 'disabled' : ''} title="Supprimer cette étape" aria-label="Supprimer cette étape">✕</button>
      </div></th>
      ${pages.map(page => {
        const item = all[page.id]?.[s.key] || {};
        return `<td><div class="revision-cell ${item.done ? 'is-done' : ''}">
          <input type="checkbox" aria-label="${escapeAttr(s.label)} faite pour ${escapeAttr(page.title)}" ${item.done ? 'checked' : ''} onchange='setRevisionStep(${JSON.stringify(page.id)},${JSON.stringify(s.key)},this.checked)'>
          <input class="revision-date" type="date" aria-label="Date de ${escapeAttr(s.label)} pour ${escapeAttr(page.title)}" value="${escapeAttr(item.date || '')}" onchange='setRevisionDate(${JSON.stringify(page.id)},${JSON.stringify(s.key)},this.value)'>
        </div></td>`;
      }).join('')}
    </tr>`).join('');
  const addRow = `<tr class="revision-add-row"><th scope="row" class="revision-step-cell"><button class="revision-add" onclick="addRevisionStep()" title="Ajouter une étape">＋ Étape</button></th>${pages.map(() => '<td></td>').join('')}</tr>`;
  const totals = `<tr><th scope="row" class="revision-step-cell revision-total-label">Total</th>${pages.map(page => {
    const done = doneOf(page), pct = steps.length ? Math.round(done / steps.length * 100) : 0;
    return `<td class="revision-total"><div class="revision-mini"><i style="width: ${pct}%;"></i></div><span>${done}/${steps.length}</span></td>`;
  }).join('')}</tr>`;
  return `<section class="revision-section-group">
    <div class="revision-section-heading"><div><span>📘 ${escapeHtml(nb.title)}</span><h3>📂 ${escapeHtml(sec.title)}</h3></div><span class="revision-progress">${pages.length} page(s)</span></div>
    <div class="revision-table-wrap"><table class="revision-matrix">
      <thead>${head}</thead>
      <tbody>${rows}${addRow}</tbody>
      <tfoot>${totals}</tfoot>
    </table></div>
  </section>`;
}
function renderRevisionOverview() {
  const steps = getRevisionSteps();
  const all = readPlanner('quizmaster_revision_tracker', {});
  const sections = [];
  NOTEBOOKS.forEach(nb => (nb.sections || []).forEach(sec => sections.push({ nb, sec, pages: sec.pages || [] })));
  const pageCount = sections.reduce((sum, s) => sum + s.pages.length, 0);
  const totalSteps = pageCount * steps.length;
  const totalDone = sections.reduce((sum, s) => sum + s.pages.reduce((acc, page) => acc + steps.filter(st => all[page.id]?.[st.key]?.done).length, 0), 0);
  const pct = totalSteps ? Math.round(totalDone / totalSteps * 100) : 0;
  const summary = pageCount ? `<div class="card revision-summary">
      <div><b>${totalDone} / ${totalSteps}</b> <span class="muted">étapes validées</span></div>
      <div class="revision-bar"><i style="width: ${pct}%;"></i></div>
      <small class="muted">${pct}% de tes pages sont revues · ${pageCount} page(s) · ${steps.length} étape(s) par page</small>
    </div>` : '';
  const body = pageCount
    ? sections.filter(s => s.pages.length).map(({ nb, sec }) => renderRevisionSection(nb, sec, steps, all)).join('')
    : '<div class="card muted">Crée une page de cours pour commencer le suivi.</div>';
  return `<div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button><h2>✅ Tableau de révision</h2></div><button class="btn ghost" onclick="toggleRevisionEditor()">${state.revisionEditing ? '✓ Terminé' : '⚙ Étapes'}</button></div>
    <div class="main-content">${summary}${state.revisionEditing ? revisionEditorHTML() : ''}${body}</div>`;
}
const POMO_KEY='quizmaster_pomodoro_v1';
let pomoTick=null,pomoAudio=null;
const STUDY_TIME_KEY = 'quizmaster_study_time';
function pomoRead(){const d={mode:'pomodoro',study:25,rest:5,target:60,elapsed:0,startedAt:null,phase:'study',running:false,deadline:null,remaining:1500,cycles:0};const p={...d,...readPlanner(POMO_KEY,{})};p.mode=p.mode==='stopwatch'?'stopwatch':'pomodoro';p.target=Number(p.target)||60;p.study=Number(p.study)||25;p.rest=Number(p.rest)||5;p.remaining=Number.isFinite(Number(p.remaining))?Number(p.remaining):p.study*60;return p;}
function pomoSave(p){lsSet(POMO_KEY,JSON.stringify(p));}
// Enregistre le temps d'étude écoulé depuis le dernier calcul, pour la matière choisie.
// Appeler avant tout arrêt, changement de phase ou de mode ; p.runStart repart si stillRunning.
function pomoSettle(p, stillRunning) {
  const countsAsStudy = p.mode === 'stopwatch' || p.phase === 'study';
  if (p.runStart && countsAsStudy && p.subject) {
    const minutes = (Date.now() - p.runStart) / 60000;
    if (minutes > 0) {
      const log = readPlanner(STUDY_TIME_KEY, []);
      log.push({ day: localDateStr(), subject: p.subject, minutes: Math.round(minutes * 10) / 10 });
      lsSet(STUDY_TIME_KEY, JSON.stringify(log.slice(-2000)));
    }
  }
  p.runStart = stillRunning ? Date.now() : null;
}
function pomoFormat(s){s=Math.max(0,Math.ceil(s));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
function pomoBeep(){try{pomoAudio=pomoAudio||new(window.AudioContext||window.webkitAudioContext)();pomoAudio.resume();for(let i=0;i<3;i++){const o=pomoAudio.createOscillator(),g=pomoAudio.createGain();o.frequency.value=i===1?880:660;g.gain.value=.16;o.connect(g);g.connect(pomoAudio.destination);o.start(pomoAudio.currentTime+i*.42);o.stop(pomoAudio.currentTime+i*.42+.22);}}catch(_){}}
function pomoNotify(message){pomoBeep();if(navigator.vibrate)navigator.vibrate([250,120,250]);if('Notification'in window&&Notification.permission==='granted'){const n=new Notification('Révisoria · Pomodoro',{body:message,icon:'./icons/icon-192.png'});n.onclick=()=>{window.focus();n.close();};}}
function pomoTickNow(){const p=pomoRead();if(!p.running)return;if(p.mode==='stopwatch'){p.elapsed=Math.max(0,Math.floor((Date.now()-p.startedAt)/1000));if(p.elapsed>=p.target*60){p.elapsed=p.target*60;pomoSettle(p,false);p.running=false;p.startedAt=null;pomoNotify('Temps d’étude prévu atteint : '+p.target+' min.');}pomoSave(p);const display=document.getElementById('pomo-clock');if(display)display.textContent=pomoFormat(p.elapsed);const phase=document.getElementById('pomo-phase');if(phase)phase.textContent=p.running?'Chronomètre en cours':`Objectif de ${p.target} min atteint`;return;}if(!p.deadline)return;if(Date.now()<p.deadline){p.remaining=Math.ceil((p.deadline-Date.now())/1000);pomoSave(p);}else{const finished=p.phase;pomoSettle(p,true);p.phase=finished==='study'?'rest':'study';if(finished==='study')p.cycles=(p.cycles||0)+1;p.remaining=(p.phase==='study'?p.study:p.rest)*60;p.deadline=Date.now()+p.remaining*1000;p.running=true;pomoSave(p);pomoNotify(finished==='study'?'Temps de repos ! Fais une pause de '+p.rest+' min.':'Pause terminée ! Reprends pendant '+p.study+' min.');}const display=document.getElementById('pomo-clock');if(display)display.textContent=pomoFormat(p.remaining);const phase=document.getElementById('pomo-phase');if(phase)phase.textContent=p.phase==='study'?'Temps de concentration':'Temps de repos';}
function pomoEnsure(){if(pomoTick)clearInterval(pomoTick);pomoTick=setInterval(pomoTickNow,500);pomoTickNow();}
window.pomoStart=async()=>{const p=pomoRead();try{pomoAudio=pomoAudio||new(window.AudioContext||window.webkitAudioContext)();await pomoAudio.resume();}catch(_){}if('Notification'in window&&Notification.permission==='default'){try{await Notification.requestPermission();}catch(_){}}p.running=true;p.runStart=Date.now();if(p.mode==='stopwatch')p.startedAt=Date.now()-(p.elapsed||0)*1000;else p.deadline=Date.now()+Math.max(1,p.remaining)*1000;pomoSave(p);pomoEnsure();render();};
window.pomoPause=()=>{const p=pomoRead();pomoSettle(p,false);if(p.mode==='stopwatch'&&p.running)p.elapsed=Math.max(0,Math.floor((Date.now()-p.startedAt)/1000));else if(p.running&&p.deadline)p.remaining=Math.max(0,Math.ceil((p.deadline-Date.now())/1000));p.running=false;p.deadline=null;p.startedAt=null;pomoSave(p);pomoEnsure();render();};
window.pomoReset=()=>{const p=pomoRead();pomoSettle(p,false);p.running=false;p.deadline=null;p.startedAt=null;if(p.mode==='stopwatch')p.elapsed=0;else p.remaining=(p.phase==='study'?p.study:p.rest)*60;pomoSave(p);pomoEnsure();render();};
window.pomoStop=()=>{const p=pomoRead();pomoSettle(p,false);p.running=false;p.deadline=null;p.startedAt=null;p.phase='study';p.remaining=p.study*60;p.elapsed=0;pomoSave(p);pomoEnsure();render();};
window.pomoSelectMode=mode=>{const p=pomoRead();pomoSettle(p,false);p.running=false;p.deadline=null;p.startedAt=null;p.mode=mode;if(mode==='stopwatch')p.elapsed=0;else{p.phase='study';p.remaining=p.study*60;}pomoSave(p);render();};
window.pomoSetDuration=(field,value)=>{const p=pomoRead();p[field]=Math.max(1,Math.min(180,Number(value)||1));if(field==='study'&&!p.running&&p.mode==='pomodoro'&&p.phase==='study')p.remaining=p.study*60;if(field==='rest'&&!p.running&&p.mode==='pomodoro'&&p.phase==='rest')p.remaining=p.rest*60;pomoSave(p);pomoEnsure();render();};
window.pomoSetSubject = (id) => { const p = pomoRead(); pomoSettle(p, p.running); p.subject = id || null; pomoSave(p); render(); };
function fmtStudyMinutes(m) {
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? `${h} h ${String(r).padStart(2, '0')} min` : `${r} min`;
}
// Temps d'étude par matière, alimenté par le Pomodoro et le chronomètre.
function studyTimeHTML() {
  const log = readPlanner(STUDY_TIME_KEY, []);
  if (!log.length) return '<div class="card"><h3>⏱ Temps d\'étude par matière</h3><p class="muted">Choisis une matière dans le Pomodoro ou le chronomètre pour voir ton temps d’étude ici.</p></div>';
  const totals = {};
  log.forEach(x => { totals[x.subject] = (totals[x.subject] || 0) + (Number(x.minutes) || 0); });
  const all = Object.values(totals).reduce((sum, v) => sum + v, 0);
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([id, min]) => {
    const nb = NOTEBOOKS.find(n => n.id === id);
    const pct = all ? Math.round((min / all) * 100) : 0;
    return `<div class="chart-row"><div class="chart-header"><span>${escapeHtml(nb ? nb.title : 'Matière supprimée')}</span><span>${fmtStudyMinutes(min)} (${pct}%)</span></div><div class="chart-bar-container"><div class="chart-bar-fill" style="width: ${pct}%; background: var(--primary);"></div></div></div>`;
  }).join('');
  return `<div class="card"><h3>⏱ Temps d'étude par matière</h3><p class="muted">Total : ${fmtStudyMinutes(all)}</p>${rows}</div>`;
}
// Prochain examen du calendrier, avec les heures de séances encore prévues avant lui.
function examCountdownHTML() {
  const today = localDateStr();
  const next = readPlanner('quizmaster_calendar', []).filter(e => e && e.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!next) return '';
  const days = Math.round((new Date(next.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const planned = readPlanner('quizmaster_study_plan', []).filter(x => !x.completed);
  let hours = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(today + 'T00:00:00');
    d.setDate(d.getDate() + i);
    const name = dayNames[d.getDay()].toLowerCase();
    hours += planned.filter(x => String(x.day).toLowerCase() === name).reduce((sum, x) => sum + (Number(x.hours) || 0), 0);
  }
  const when = days === 0 ? "C'est aujourd'hui !" : `dans ${days} jour(s)`;
  return `<div class="card exam-countdown" style="margin-bottom: 25px;"><h3 style="margin: 0 0 4px 0;">📝 ${escapeHtml(next.title)}</h3><p class="muted" style="margin: 0;">${escapeHtml(next.date)} · ${when}</p><p style="margin: 10px 0 0 0;"><b>${fmtStudyMinutes(hours * 60)}</b> de séances prévues avant l'examen</p>${hours === 0 && days > 0 ? '<p class="muted" style="margin: 6px 0 0 0;">Aucune séance planifiée : ajoute-en dans le Programme d’étude.</p>' : ''}</div>`;
}
function renderPomodoro(){const p=pomoRead(),watch=p.mode==='stopwatch',shown=watch?(p.running?Math.floor((Date.now()-p.startedAt)/1000):p.elapsed):(p.running&&p.deadline?Math.max(0,(p.deadline-Date.now())/1000):p.remaining);const progress=watch?Math.min(100,Math.round(shown/(p.target*60)*100)):0;return `<div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" aria-label="Menu principal">☰</button><h2>🍅 Pomodoro</h2></div></div><div class="main-content pomo-screen"><div class="pomo-card"><div class="pomo-kicker">FOCUS • PAUSE • PROGRES</div><div class="pomo-tabs"><button class="${!watch?'active':''}" onclick="pomoSelectMode('pomodoro')">🍅 Pomodoro</button><button class="${watch?'active':''}" onclick="pomoSelectMode('stopwatch')">⏱ Chronomètre</button></div><label class="pomo-subject">Matière<select onchange="pomoSetSubject(this.value)"><option value="">— Aucune —</option>${NOTEBOOKS.map(nb => `<option value="${escapeAttr(nb.id)}" ${p.subject === nb.id ? 'selected' : ''}>${escapeHtml(nb.title)}</option>`).join('')}</select></label>${!watch?`<div class="pomo-tabs"><button class="${p.phase==='study'?'active':''}" onclick="const p=pomoRead();pomoSettle(p,false);p.phase='study';p.remaining=p.study*60;p.running=false;p.deadline=null;pomoSave(p);render()">📚 Étude</button><button class="${p.phase==='rest'?'active':''}" onclick="const p=pomoRead();pomoSettle(p,false);p.phase='rest';p.remaining=p.rest*60;p.running=false;p.deadline=null;pomoSave(p);render()">☕ Repos</button></div>`:''}<div class="pomo-ring ${watch?'study':p.phase}"><span id="pomo-phase">${watch?(p.running?'Chronomètre en cours':`Objectif : ${p.target} min`):(p.phase==='study'?'Temps de concentration':'Temps de repos')}</span><strong id="pomo-clock">${pomoFormat(shown)}</strong>${watch?`<div class="pomo-progress"><i style="width:${progress}%"></i></div><small>${progress}% de l’objectif · ${p.cycles||0} cycle(s) terminé(s)</small>`:`<small>${p.cycles||0} cycle(s) terminé(s)</small>`}</div><div class="pomo-controls">${p.running?'<button class="btn ghost" onclick="pomoPause()">Ⅱ Pause</button>':'<button class="btn" onclick="pomoStart()">▶ Démarrer</button>'}<button class="btn ghost" onclick="pomoReset()">↺ Réinitialiser</button><button class="btn pomo-stop" onclick="pomoStop()">■ Stop</button></div><div class="pomo-settings">${watch?`<label>Objectif d’étude (minutes)<input type="number" min="1" max="180" value="${p.target}" onchange="pomoSetDuration('target',this.value)"></label>`:`<label>Étude (minutes)<input type="number" min="1" max="180" value="${p.study}" onchange="pomoSetDuration('study',this.value)"></label><label>Repos (minutes)<input type="number" min="1" max="180" value="${p.rest}" onchange="pomoSetDuration('rest',this.value)"></label>`}</div><p class="pomo-note">${watch?'Le chronomètre compte le temps écoulé et sonne à la fin de ton objectif.':'À la fin de chaque période, une alarme sonne et le minuteur passe automatiquement à l’étape suivante.'} Autorise les notifications pour recevoir une alerte si Révisoria est en arrière-plan.</p></div></div>`;}
window.addEventListener('load',()=>{const p=pomoRead();if(p.running)pomoEnsure();});
window.setRevisionStep=(sectionId,key,done)=>{const all=readPlanner('quizmaster_revision_tracker',{});all[sectionId]=all[sectionId]||{};all[sectionId][key]={...(all[sectionId][key]||{}),done,date:done?(all[sectionId][key]?.date||localDateStr()):(all[sectionId][key]?.date||'')};lsSet('quizmaster_revision_tracker',JSON.stringify(all));render();};
window.setRevisionDate=(sectionId,key,date)=>{const all=readPlanner('quizmaster_revision_tracker',{});all[sectionId]=all[sectionId]||{};all[sectionId][key]={...(all[sectionId][key]||{}),date,done:all[sectionId][key]?.done||false};lsSet('quizmaster_revision_tracker',JSON.stringify(all));render();};

// 🥧 CATÉGORIE 4.1 : Stats avec camembert QCM/QCS/QROC
function renderStats() {
  let totalQuestions = 0; let totalSeen = 0; let totalCorrect = 0;

  // 🥧 Compteur par type de question
  const typeStats = { qcm: 0, qcs: 0, qroc: 0 };

  const notebooksStats = NOTEBOOKS.map(nb => {
    let nbSeen = 0; let nbCorrect = 0; let nbQuestions = 0; let nbTouched = 0;
    nb.sections.forEach(sec => { sec.pages.forEach(page => { page.questions.forEach(q => {
      nbQuestions++; totalQuestions++;
      if (q.stats) {
        nbSeen += q.stats.seen; nbCorrect += q.stats.correct;
        totalSeen += q.stats.seen; totalCorrect += q.stats.correct;
        if (q.stats.seen > 0) nbTouched++;
        if (typeStats[q.type] !== undefined) typeStats[q.type] += q.stats.seen;
      }
    }); }); });
    const successRate = nbSeen > 0 ? Math.round((nbCorrect / nbSeen) * 100) : 0;
    // 📊 « Prêt pour l'examen » = couverture (questions déjà vues) × précision.
    const coverage = nbQuestions > 0 ? nbTouched / nbQuestions : 0;
    const accuracy = nbSeen > 0 ? nbCorrect / nbSeen : 0;
    return { title: nb.title, seen: nbSeen, correct: nbCorrect, totalQ: nbQuestions, rate: successRate, touched: nbTouched, readiness: Math.round(coverage * accuracy * 100) };
  });

  const globalRate = totalSeen > 0 ? Math.round((totalCorrect / totalSeen) * 100) : 0;
    // 🥇 CATÉGORIE 4.2 : Matière la plus difficile (≥ 3 réponses pour être fiable)
  const ratedNotebooks = notebooksStats.filter(nb => nb.seen >= 3);
  let hardestSubjectHTML = '';
  if (ratedNotebooks.length > 0) {
    const hardest = ratedNotebooks.reduce((min, nb) => nb.rate < min.rate ? nb : min, ratedNotebooks[0]);
    const color = hardest.rate >= 70 ? 'var(--ok)' : hardest.rate >= 40 ? 'var(--warn)' : 'var(--bad)';
    const bgColor = hardest.rate >= 70 ? 'rgba(16,185,129,0.2)' : hardest.rate >= 40 ? 'rgba(245,158,11,0.2)' : 'rgba(239,68,68,0.2)';
    hardestSubjectHTML = `
      <div class="hardest-subject-box">
        <div class="hdr-icon">⚠️</div>
        <div class="hdr-content">
          <h4>Ta matière la plus difficile</h4>
          <p>${escapeHtml(hardest.title)}</p>
        </div>
        <div class="badge-rate" style="background:${bgColor}; color:${color};">
          ${hardest.rate}% de réussite
        </div>
      </div>
    `;
  }

  // 🥧 Construction du camembert
  let pieChartHTML = '';
  const totalByType = typeStats.qcm + typeStats.qcs + typeStats.qroc;
  if (totalByType > 0) {
    const pQcm = Math.round((typeStats.qcm / totalByType) * 100);
    const pQcs = Math.round((typeStats.qcs / totalByType) * 100);
    // 🔧 FIX : les arrondis pouvaient faire dépasser 100 % (pQroc négatif,
    // dégradé conique invalide). On borne les cumuls.
    const pQroc = Math.max(0, 100 - pQcm - pQcs);
    const cumQcm = Math.min(100, pQcm);
    const cumQcs = Math.min(100, pQcm + pQcs);
    const pieGradient = `conic-gradient(
      var(--primary) 0% ${cumQcm}%,
      var(--accent) ${cumQcm}% ${cumQcs}%,
      var(--warn) ${cumQcs}% 100%
    )`;
    pieChartHTML = `
      <div class="pie-chart-container">
        <div class="pie-chart" style="background: ${pieGradient};"></div>
        <div class="pie-legend">
          <div class="legend-item">
            <div class="legend-color" style="background: var(--primary);"></div>
            <span>QCM</span>
            <span class="legend-count">(${pQcm}% · ${typeStats.qcm} rép.)</span>
          </div>
          <div class="legend-item">
            <div class="legend-color" style="background: var(--accent);"></div>
            <span>QCS</span>
            <span class="legend-count">(${pQcs}% · ${typeStats.qcs} rép.)</span>
          </div>
          <div class="legend-item">
            <div class="legend-color" style="background: var(--warn);"></div>
            <span>QROC</span>
            <span class="legend-count">(${pQroc}% · ${typeStats.qroc} rép.)</span>
          </div>
        </div>
      </div>
    `;
  } else {
    pieChartHTML = '<p class="muted">Réponds à quelques questions pour voir la répartition par type.</p>';
  }

    // 🎯 CATÉGORIE 4.3 : Objectif quotidien
  const goalPct = Math.min(100, Math.round((DAILY_GOAL.count / DAILY_GOAL.target) * 100));
  const goalDone = DAILY_GOAL.count >= DAILY_GOAL.target;
  const dailyGoalHTML = `
    <div class="daily-goal-card">
      <div class="daily-goal-header">
        <h4>🎯 Objectif quotidien</h4>
        <div class="row" style="gap: 10px;">
          <span class="goal-value">${DAILY_GOAL.count} / ${DAILY_GOAL.target}</span>
          <button class="goal-edit-btn" onclick="editDailyGoal()">✏️ Modifier</button>
        </div>
      </div>
      <div class="goal-bar-bg">
        <div class="goal-bar-fill ${goalDone ? 'done' : ''}" style="width: ${goalPct}%;"></div>
      </div>
      <div class="goal-subtitle">
        ${goalDone
          ? `🎉 Objectif atteint ! Bravo, tu as révisé ${DAILY_GOAL.count} questions aujourd'hui.`
          : `Encore ${DAILY_GOAL.target - DAILY_GOAL.count} question(s) pour atteindre ton objectif du jour.`}
      </div>
    </div>
  `;

  // Historique (inchangé)
  const recentHistory = HISTORY.slice(0, 7).reverse();
  const historyHTML = recentHistory.length ? `
    <div class="history-chart">
      ${recentHistory.map(h => `<div class="history-bar" style="height: ${Math.max(2, h.pct)}%;" title="${h.pct}%"><span class="history-label">${h.pct}%</span></div>`).join('')}
    </div>
  ` : '<p class="muted">Pas encore assez de données pour afficher un graphique.</p>';

  // 🔥 Heatmap des 12 dernières semaines (activité quotidienne).
  const heatCells = [];
  const todayDate = new Date(localDateStr() + 'T00:00:00');
  const startDate = new Date(todayDate);
  startDate.setDate(startDate.getDate() - 83);
  startDate.setDate(startDate.getDate() - ((startDate.getDay() + 6) % 7)); // lundi
  for (const day = new Date(startDate); day <= todayDate; day.setDate(day.getDate() + 1)) {
    const key = localDateStr(day);
    const count = Number(GAME_DATA.daily?.[key]) || 0;
    const level = count === 0 ? 0 : count < 5 ? 1 : count < 15 ? 2 : count < 30 ? 3 : 4;
    heatCells.push(`<span class="heat-cell l${level}" title="${key} · ${count} question(s)"></span>`);
  }

  // 🏅 Badges (calculés à partir des données, pas stockés).
  const badgeDefs = [
    { icon: '🎓', label: 'Premier quiz', test: () => HISTORY.length >= 1 },
    { icon: '💯', label: '100 questions répondues', test: () => totalSeen >= 100 },
    { icon: '🔥', label: '7 jours de suite', test: () => (GAME_DATA.streak || 0) >= 7 },
    { icon: '🏆', label: '100 % à un quiz', test: () => HISTORY.some(h => h.pct === 100) },
    { icon: '⭐', label: 'Niveau 5', test: () => (GAME_DATA.level || 1) >= 5 },
    { icon: '📚', label: '100 questions créées', test: () => totalQuestions >= 100 }
  ];
  const badgesHTML = badgeDefs.map(b => {
    const earned = b.test();
    return `<span class="badge-pill ${earned ? 'earned' : ''}" title="${earned ? 'Débloqué' : 'À débloquer'}">${b.icon} ${b.label}</span>`;
  }).join('');

  const readinessHTML = notebooksStats.filter(nb => nb.totalQ > 0).map(nb => `
    <div class="chart-row">
      <div class="chart-header"><span>${escapeHtml(nb.title)}</span><span>${nb.readiness}% prêt · ${nb.touched}/${nb.totalQ} vues</span></div>
      <div class="chart-bar-container"><div class="chart-bar-fill" style="width: ${nb.readiness}%; background: ${nb.readiness >= 70 ? 'var(--ok)' : nb.readiness >= 40 ? 'var(--warn)' : 'var(--bad)'};"></div></div>
    </div>
  `).join('');

  return `
    <div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button><h2>Mes Statistiques</h2></div></div>
            <div class="main-content">
             ${dailyGoalHTML}
             ${hardestSubjectHTML}
         
          <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Taux de réussite</div><div class="stat-value">${globalRate}%</div></div>
        <div class="stat-card"><div class="stat-label">Questions répondues</div><div class="stat-value">${totalSeen}</div></div>
        <div class="stat-card"><div class="stat-label">Bonnes réponses</div><div class="stat-value" style="color: var(--ok);">${totalCorrect}</div></div>
        <div class="stat-card"><div class="stat-label">Total questions</div><div class="stat-value">${totalQuestions}</div></div>
      </div>

      <div class="card">
        <h3>🎯 Prêt pour l'examen ?</h3>
        <p class="muted" style="margin-top:-5px;">Couverture × précision. Monte les deux pour progresser.</p>
        ${readinessHTML || '<p class="muted">Aucune question pour le moment.</p>'}
      </div>

      <div class="card">
        <h3>🔥 Activité des 12 dernières semaines</h3>
        <div class="heatmap">${heatCells.join('')}</div>
        <div class="heatmap-legend"><span>Moins</span><i class="heat-cell l0"></i><i class="heat-cell l1"></i><i class="heat-cell l2"></i><i class="heat-cell l3"></i><i class="heat-cell l4"></i><span>Plus</span></div>
      </div>

      ${weeklyReportHTML()}
      ${studyTimeHTML()}

      <div class="card">
        <h3>🏅 Badges</h3>
        <div class="row" style="gap:8px;">${badgesHTML}</div>
      </div>

      <div class="card">
        <h3>📊 Réussite par matière</h3>
        ${notebooksStats.length ? notebooksStats.map(nb => `
          <div class="chart-row">
            <div class="chart-header"><span>${escapeHtml(nb.title)}</span><span>${nb.rate}% (${nb.correct}/${nb.seen})</span></div>
            <div class="chart-bar-container"><div class="chart-bar-fill" style="width: ${nb.rate}%; background: ${nb.rate >= 70 ? 'var(--ok)' : nb.rate >= 40 ? 'var(--warn)' : 'var(--bad)'};"></div></div>
          </div>
        `).join('') : '<p class="muted">Aucune matière pour le moment.</p>'}
      </div>

      <div class="card">
        <h3>🥧 Répartition des types de questions</h3>
        ${pieChartHTML}
      </div>

      <div class="card"><h3>📈 Progression récente (7 derniers quiz)</h3>${historyHTML}</div>
    </div>
  `;
}

// ============================================================
// 📅 RÉVISIONS DU JOUR (file d'attente SRS)
// ============================================================

// Toutes les questions dont la prochaine révision est aujourd'hui ou passée.
// Une question jamais vue (stats.seen === 0) est considérée comme nouvelle.
function getDueQuestions() {
  const today = localDateStr();
  const due = [];
  NOTEBOOKS.forEach(nb => (nb.sections || []).forEach(sec => (sec.pages || []).forEach(page => {
    (page.questions || []).forEach(q => {
      if (!q.srsData || !q.srsData.nextDate || q.srsData.nextDate <= today) {
        due.push({ nb, sec, page, q });
      }
    });
  })));
  return due;
}

function renderReview() {
  const due = getDueQuestions();
  const total = due.length;
  const newCount = due.filter(d => !d.q.stats || d.q.stats.seen === 0).length;
  const sessionSize = Math.min(total, Math.max(1, state.nbQuestions));

  // Regroupement matière > section > page pour un affichage lisible.
  const groups = new Map();
  due.forEach(d => {
    if (!groups.has(d.nb.id)) groups.set(d.nb.id, { nb: d.nb, secs: new Map(), count: 0 });
    const g = groups.get(d.nb.id); g.count++;
    if (!g.secs.has(d.sec.id)) g.secs.set(d.sec.id, { sec: d.sec, pages: new Map(), count: 0 });
    const s = g.secs.get(d.sec.id); s.count++;
    if (!s.pages.has(d.page.id)) s.pages.set(d.page.id, { page: d.page, count: 0 });
    s.pages.get(d.page.id).count++;
  });

  const groupsHTML = [...groups.values()].map(g => `
    <div class="card">
      <div class="flex-between" style="margin-bottom: 10px;">
        <h3 style="margin:0; font-size:1.05rem;">📘 ${escapeHtml(g.nb.title)}</h3>
        <span class="count" style="color:var(--primary); font-weight:700;">${g.count}</span>
      </div>
      ${[...g.secs.values()].map(s => `
        <div class="muted" style="font-size:0.8rem; text-transform:uppercase; letter-spacing:1px; margin:12px 0 4px;">📂 ${escapeHtml(s.sec.title)} · ${s.count}</div>
        ${[...s.pages.values()].map(p => `
          <div class="review-row clickable" onclick='goToPageFromSearch(${JSON.stringify(g.nb.id)}, ${JSON.stringify(s.sec.id)}, ${JSON.stringify(p.page.id)})'>
            <span>📄 ${escapeHtml(p.page.title)}</span>
            <span class="count">${p.count}</span>
          </div>
        `).join('')}
      `).join('')}
    </div>
  `).join('');

  return `
    <div class="main-header">
      <div class="row">
        <button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button>
        <h2>📅 Révisions du jour</h2>
      </div>
      ${total ? `<button class="btn" onclick="startDueReview()">▶ Réviser ${sessionSize}</button>` : ''}
    </div>
    <div class="main-content">
      ${total === 0 ? `
        <div class="card" style="text-align:center; padding: 50px 30px;">
          <div style="font-size: 3rem;">🎉</div>
          <h3>Tu es à jour !</h3>
          <p class="muted">Aucune question à réviser aujourd'hui. Les prochaines reviendront à leur date prévue.</p>
        </div>
      ` : `
        <div class="card" style="background: linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.1)); border-color: rgba(59,130,246,0.3);">
          <h3 style="margin-top:0;">${total} question(s) à réviser</h3>
          <p class="muted" style="margin-bottom: 20px;">${newCount} nouvelle(s) · ${total - newCount} à revoir</p>
          <div class="row">
            <button class="btn" onclick="startDueReview()" style="padding: 14px 26px;">▶ Session de ${sessionSize}</button>
            ${total > sessionSize ? `<button class="btn ghost" onclick="startDueReview(true)" style="padding: 14px 26px;">Tout réviser (${total})</button>` : ''}
          </div>
        </div>
        ${groupsHTML}
      `}
    </div>
  `;
}

window.startDueReview = (all = false) => {
  const due = getDueQuestions();
  if (!due.length) return alert("Rien à réviser aujourd'hui 🎉");
  let questions = due.map(d => d.q);
  questions.sort(() => 0.5 - Math.random());
  if (!all) questions = questions.slice(0, Math.max(1, state.nbQuestions));
  state.mode = 'srs';
  state.activePageId = null; // session potentiellement multi-pages : pas de ressources
  startQuizLogic(questions);
};

// ============================================================
// 🚩 FAVORIS, 🏷️ ÉTIQUETTES ET MODE FAIBLESSES
// ============================================================
function allQuestions() {
  const rows = [];
  NOTEBOOKS.forEach(nb => (nb.sections || []).forEach(sec => (sec.pages || []).forEach(page => {
    (page.questions || []).forEach(q => rows.push({ nb, sec, page, q }));
  })));
  return rows;
}
function getFlaggedQuestions() { return allQuestions().filter(r => r.q.flag === true); }
function getAllTags() {
  const counts = new Map();
  allQuestions().forEach(({ q }) => (q.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
// Une question est « faible » après 3 essais et moins de 60 % de réussite.
function isWeakQuestion(q) {
  return !!(q && q.stats && q.stats.seen >= 3 && (q.stats.correct / q.stats.seen) < 0.6);
}
function weaknessScore(q) {
  const seen = q?.stats?.seen || 0;
  return seen > 0 ? 1 - (q.stats.correct / seen) : 0;
}

window.toggleFlag = () => {
  const q = state.questions[state.index];
  if (!q) return;
  q.flag = !q.flag;
  saveData();
  render();
};

window.startFlaggedQuiz = () => {
  const list = getFlaggedQuestions().map(r => r.q);
  if (!list.length) return alert("Aucun favori pour le moment. Clique sur le drapeau pendant un quiz.");
  list.sort(() => 0.5 - Math.random());
  state.activePageId = null;
  startQuizLogic(list.slice(0, Math.max(1, state.nbQuestions)));
};

window.startTagQuiz = (tag) => {
  const list = allQuestions().filter(r => (r.q.tags || []).includes(tag)).map(r => r.q);
  if (!list.length) return alert("Aucune question avec cette étiquette.");
  list.sort(() => 0.5 - Math.random());
  state.activePageId = null;
  startQuizLogic(list.slice(0, Math.max(1, state.nbQuestions)));
};

function renderFlagged() {
  const rows = getFlaggedQuestions();
  const groups = new Map();
  rows.forEach(r => {
    if (!groups.has(r.page.id)) groups.set(r.page.id, { nb: r.nb, sec: r.sec, page: r.page, count: 0 });
    groups.get(r.page.id).count++;
  });

  return `
    <div class="main-header">
      <div class="row">
        <button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button>
        <h2>🚩 Favoris</h2>
      </div>
      ${rows.length ? `<button class="btn" onclick="startFlaggedQuiz()">▶ Réviser ${Math.min(rows.length, state.nbQuestions)}</button>` : ''}
    </div>
    <div class="main-content">
      ${rows.length === 0 ? `
        <div class="card" style="text-align:center; padding: 50px 30px;">
          <div style="font-size: 3rem;">🏳️</div>
          <h3>Aucun favori</h3>
          <p class="muted">Pendant un quiz, clique sur le drapeau pour garder une question de côté.</p>
        </div>
      ` : `
        <div class="card">
          <h3 style="margin-top:0;">${rows.length} question(s) favorite(s)</h3>
          <p class="muted" style="margin-bottom:0;">Réparties sur ${groups.size} page(s).</p>
        </div>
        <div class="card">
          ${[...groups.values()].map(g => `
            <div class="review-row clickable" onclick='goToPageFromSearch(${JSON.stringify(g.nb.id)}, ${JSON.stringify(g.sec.id)}, ${JSON.stringify(g.page.id)})'>
              <span>📄 ${escapeHtml(g.page.title)} <span class="muted" style="font-size:0.8rem;">· ${escapeHtml(g.nb.title)}</span></span>
              <span class="count">${g.count}</span>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

// Tableau de bord en cartes claires (inspiré du modèle « Donezo »). Mêmes sources de données qu'avant.
const DASH_DAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
function dashboardProgress() {
  return NOTEBOOKS.map(nb => {
    let total = 0, seen = 0;
    (nb.sections || []).forEach(sec => (sec.pages || []).forEach(page => (page.questions || []).forEach(q => { total++; if (q.srsData) seen++; })));
    return { nb, total, seen, pct: total ? Math.round(seen / total * 100) : 0 };
  });
}
function dashboardWeek() {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = localDateStr(d);
    return { key, label: DASH_DAYS[d.getDay()], count: Number(GAME_DATA.daily?.[key]) || 0, today: i === 6 };
  });
}
function dashboardSearchHTML() {
  const searchResults = getSearchResults(state.searchQuery);
  if (searchResults.length === 0) return `<div class="dash-card"><p class="muted">Aucun résultat trouvé pour "${escapeHtml(state.searchQuery)}".</p></div>`;
  return `<h3 class="dash-subtitle">Résultats de recherche (${searchResults.length})</h3>` + searchResults.map(res => `
    <div class="search-result-card" onclick='goToPageFromSearch(${JSON.stringify(res.nb.id)}, ${JSON.stringify(res.sec.id)}, ${JSON.stringify(res.page.id)})'>
      <span class="muted" style="font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px;">${escapeHtml(res.nb.title)} > ${escapeHtml(res.sec.title)}</span>
      <h4 style="margin:8px 0; font-size: 1.1rem;">📄 ${escapeHtml(res.page.title)}</h4>
      ${res.matchingQuestions.map(q => `<div class="muted" style="font-size:0.9rem; margin-top:4px;">• ${escapeHtml(q.statement.substring(0, 80))}...</div>`).join('')}
    </div>
  `).join('');
}
function renderDashboard() {
  const progress = dashboardProgress();
  const totalQ = progress.reduce((s, p) => s + p.total, 0);
  const seenQ = progress.reduce((s, p) => s + p.seen, 0);
  const globalPct = totalQ ? Math.round(seenQ / totalQ * 100) : 0;
  const avgPct = HISTORY.length ? Math.round(HISTORY.reduce((s, h) => s + h.pct, 0) / HISTORY.length) : 0;
  const dueCount = getDueQuestions().length;
  const week = dashboardWeek();
  const weekMax = Math.max(1, ...week.map(w => w.count));
  const weekTotal = week.reduce((s, w) => s + w.count, 0);
  const sinceBackup = daysSinceBackup();
  const backupDue = NOTEBOOKS.length > 0 && (sinceBackup === null || sinceBackup >= 7);
  const topTags = getAllTags().slice(0, 12);
  const today = localDateStr();
  const dayName = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'][new Date().getDay()];
  const todaySessions = readPlanner('quizmaster_study_plan', [])
    .filter(x => String(x.day).toLowerCase() === dayName.toLowerCase() && !x.completed)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const historyHTML = HISTORY.length
    ? HISTORY.slice(0, 3).map(h => `<div class="history-item"><span class="muted">${h.date}</span><span><b>${h.pct}%</b> (${h.score}/${h.total})</span></div>`).join('')
    : '<div class="muted">Aucun quiz terminé.</div>';

  if (state.searchQuery.length >= 1) {
    return `
      <div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button><h2>Tableau de bord</h2></div></div>
      <div class="main-content dash"><div class="search-bar"><input type="text" placeholder="Rechercher une question, un cours..." value="${escapeAttr(state.searchQuery)}" oninput="updateSearch(this.value)" autocomplete="off"></div>${dashboardSearchHTML()}</div>`;
  }

  return `
    <div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button><h2>Tableau de bord</h2></div></div>
    <div class="main-content dash">
      <div class="dash-head">
        <div class="dash-title"><h1>Tableau de bord</h1><p>Planifie, priorise et réussis tes révisions avec simplicité.</p></div>
        <div class="dash-actions">
          <button class="dash-btn dash-btn-ghost" onclick="state.screen='memorize'; render()">🧠 Mémoriser un cours</button>
          <button class="dash-btn" onclick="startGlobalQuiz()">▶ Lancer un quiz global</button>
        </div>
      </div>
      <div class="search-bar"><input type="text" placeholder="Rechercher une question, un cours..." value="${escapeAttr(state.searchQuery)}" oninput="updateSearch(this.value)" autocomplete="off"></div>

      ${dueCount ? `<div class="dash-card dash-banner"><div><h3>📅 Révisions du jour</h3><p class="muted">${dueCount} question(s) t'attendent aujourd'hui.</p></div><button class="dash-btn" onclick="state.screen='review'; state.activePageId=null; render()">Réviser (${dueCount})</button></div>` : ''}
      ${backupDue ? `<div class="dash-card dash-banner dash-warn"><div><h3>💾 Sauvegarde recommandée</h3><p class="muted">${sinceBackup === null ? "Tu n'as encore jamais exporté tes données." : `Dernière sauvegarde il y a ${sinceBackup} jour(s).`}</p></div><button class="dash-btn" onclick="exportData()">Exporter maintenant</button></div>` : ''}

      <div class="dash-grid">
        <div class="dash-card dash-stat dash-stat-hero">
          <div class="dash-stat-top"><span>Questions</span><button class="dash-arrow dash-arrow-light" onclick="state.screen='stats'; render()" aria-label="Voir les statistiques">↗</button></div>
          <b>${totalQ}</b><small class="dash-chip">${progress.length} matière(s)</small>
        </div>
        <div class="dash-card dash-stat">
          <div class="dash-stat-top"><span>Quiz terminés</span><button class="dash-arrow" onclick="state.screen='stats'; render()" aria-label="Voir l'historique">↗</button></div>
          <b>${HISTORY.length}</b><small class="dash-chip">Moyenne ${avgPct}%</small>
        </div>
        <div class="dash-card dash-stat">
          <div class="dash-stat-top"><span>Questions vues</span><button class="dash-arrow" onclick="state.screen='stats'; render()" aria-label="Voir les statistiques">↗</button></div>
          <b>${seenQ}</b><small class="dash-chip">${globalPct}% couvert</small>
        </div>
        <div class="dash-card dash-stat">
          <div class="dash-stat-top"><span>À réviser</span><button class="dash-arrow" onclick="state.screen='review'; render()" aria-label="Ouvrir les révisions">↗</button></div>
          <b>${dueCount}</b><small class="muted">${dueCount ? "aujourd'hui" : 'Tu es à jour'}</small>
        </div>

        <div class="dash-card dash-span-2">
          <div class="dash-card-head"><h3>Activité de la semaine</h3><span class="muted">${weekTotal} question(s)</span></div>
          <div class="dash-bars">${week.map(w => `<div class="dash-bar-col"><div class="dash-bar ${w.today ? 'today' : ''}" style="height: ${Math.max(8, Math.round(w.count / weekMax * 100))}%;" title="${w.key} · ${w.count} question(s)"><span>${w.count}</span></div><small>${w.label}</small></div>`).join('')}</div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Progression</h3></div>
          <div class="dash-donut" style="background: conic-gradient(var(--primary) 0 ${globalPct}%, rgba(148,163,184,.2) ${globalPct}% 100%);"><div class="dash-donut-hole"><div>${globalPct}%<small>vues</small></div></div></div>
          <p class="muted dash-center">${seenQ} sur ${totalQ} questions vues</p>
        </div>

        <div class="dash-card dash-span-2">
          <div class="dash-card-head"><h3>Mes matières</h3><button class="dash-btn dash-btn-ghost dash-btn-small" onclick="addNotebook()">＋ Matière</button></div>
          ${progress.length ? progress.map(p => `<div class="dash-progress-row"><div class="dash-progress-top"><span>${escapeHtml(p.nb.title)}</span><span class="muted">${p.seen}/${p.total} · ${p.pct}%</span></div><div class="dash-progress-bar"><i style="width: ${p.pct}%;"></i></div></div>`).join('') : '<p class="muted">Aucune matière pour le moment.</p>'}
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>Rappels</h3></div>
          <div class="dash-embed">${examCountdownHTML() || '<p class="muted">Aucun examen planifié. Ajoute une date dans le calendrier.</p>'}</div>
          <h4 class="dash-subtitle">Séances d'aujourd'hui</h4>
          ${todaySessions.length ? todaySessions.map(x => `<div class="dash-list-item"><span>${escapeHtml(x.subject || 'Séance')}</span><small>${escapeHtml(x.start || '09:00')} · ${escapeHtml(x.hours || 1)} h</small></div>`).join('') : '<p class="muted">Aucune séance prévue aujourd’hui.</p>'}
        </div>

        <div class="dash-card dash-span-2">
          <div class="dash-card-head"><h3>Derniers résultats</h3><button class="dash-btn dash-btn-ghost dash-btn-small" onclick="state.screen='stats'; render()">Tout voir</button></div>
          ${historyHTML}
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>📁 Ajouter du contenu</h3></div>
          <p class="muted">Génère des questions depuis un PDF de cours, ou importe un fichier JSON.</p>
          <div class="dash-actions">
            <input type="file" id="fileJson" accept=".json" style="display:none">
            <button class="dash-btn dash-btn-ghost dash-btn-small" onclick="document.getElementById('fileJson').click()">Importer .json</button>
            <input type="file" id="filePdf" accept=".pdf" style="display:none">
            <button class="dash-btn dash-btn-small" id="btn-ia" onclick="document.getElementById('filePdf').click()">🤖 Depuis un PDF</button>
          </div>
        </div>

        ${topTags.length ? `<div class="dash-card dash-span-4"><div class="dash-card-head"><h3>🏷️ Étiquettes</h3><span class="muted">Clique pour lancer un quiz sur ce thème.</span></div><div class="dash-actions">${topTags.map(([tag, n]) => `<button class="tag-chip" onclick='startTagQuiz(${JSON.stringify(tag)})'>${escapeHtml(tag)} <span>${n}</span></button>`).join('')}</div></div>` : ''}

        <div class="dash-card dash-span-4 dash-save">
          <div><h3>💾 Sauvegarde</h3><p class="muted">Télécharge tes cours, scores et XP pour ne jamais rien perdre.</p></div>
          <div class="dash-actions">
            <button class="dash-btn dash-btn-ghost dash-btn-small" onclick="exportData()">Exporter (.json)</button>
            <button class="dash-btn dash-btn-ghost dash-btn-small" onclick="restoreAutoBackup()">Restaurer la sauvegarde auto</button>
          </div>
        </div>
      </div>
    </div>`;
}

window.goToPageFromSearch = (nbId, secId, pageId) => {
  const nb = NOTEBOOKS.find(n => n.id === nbId); if (!nb) return;
  const sec = nb.sections.find(s => s.id === secId); if (!sec) return;
  const pg = sec.pages.find(p => p.id === pageId); if (!pg) return;
  state.activeNbId = nbId; state.activeSecId = secId; state.activePageId = pageId; state.screen = 'lesson'; state.searchQuery = '';
  if (window.innerWidth <= 768) { state.notebooksCollapsed = true; state.sectionsCollapsed = true; }
  render();
};

// 🔧 FIX 12: slider re-render + escapeHtml
function renderPageContent(page, section) {
  const todayStr = localDateStr();
  const questionsHTML = page.questions.map((q, i) => {
    let srsBadge = '';
    if (q.srsData) {
      if (q.srsData.nextDate <= todayStr) srsBadge = `<span class="srs-badge srs-due">À réviser</span>`;
      else srsBadge = `<span class="srs-badge srs-scheduled">Dans ${Math.max(1, Math.round((new Date(q.srsData.nextDate) - new Date(todayStr)) / (1000*60*60*24)))} j</span>`;
    } else { srsBadge = `<span class="srs-badge srs-new">Nouveau</span>`; }
    return `
    <div class="card" style="padding:20px; margin-bottom:15px; display: flex; flex-direction: column; gap: 10px;">
      <div class="flex-between">
        <span class="muted" style="font-size:0.75rem; font-weight: bold; background:var(--line); padding:4px 10px; border-radius:20px;">${q.flag ? '🚩 ' : ''}${q.type.toUpperCase()}</span>
        ${srsBadge}
      </div>
      <p style="margin:5px 0; font-size: 1.05rem;"><b>${i+1}. ${escapeHtml(q.statement)}</b></p>
      ${(q.tags || []).length ? `<div class="row" style="gap:6px;">${q.tags.map(t => `<span class="tag-chip small">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${q.image ? `<img src="${escapeAttr(q.image)}" class="question-image" alt="Illustration" onerror="this.style.display='none'">` : ''}
      <div class="row" style="margin-top: 5px;">
        <button class="btn ghost" style="padding:5px 10px; font-size:0.8rem; border-color: transparent;" onclick='editQuestion(${JSON.stringify(q.id)})'>✏️ Modifier</button>
        <button class="btn ghost" style="padding:5px 10px; font-size:0.8rem; color:var(--bad); border-color: transparent;" onclick='deleteQuestion(${JSON.stringify(q.id)})'>🗑️ Supprimer</button>
      </div>
    </div>
  `}).join('') || '<p class="muted">Cette page est vide.</p>';

  let resourcesHTML = '';
  if (page.resources && page.resources.length > 0) {
    resourcesHTML = page.resources.map(r => {
      let icon = '📎';
      if (r.type === 'pdf') icon = '📄';
      if (r.type === 'image') icon = '🖼️';
      if (r.type === 'video') icon = '🎥';
      if (r.type === 'link') icon = '🌐';
      return `
        <div class="resource-item">
          <div class="resource-icon">${icon}</div>
          <div class="resource-info">
            <div class="resource-name">${escapeHtml(r.name)}</div>
            <div class="resource-type">${r.type}</div>
          </div>
          <div class="resource-actions">
            <button class="btn ghost" style="padding:5px 10px; font-size:0.8rem;" onclick="openResource('${r.id}', '${r.type}', '${jsAttr(r.url || '')}')">Ouvrir</button>
            <button class="btn ghost" style="padding:5px 10px; font-size:0.8rem; background:var(--primary); color:#fff; border:none;" id="btn-gen-${r.id}" onclick="generateQuizFromResource('${r.id}', '${r.type}', '${jsAttr(r.url || '')}', '${page.id}')">🤖 Quiz</button>
            <button class="btn ghost" style="padding:5px 10px; font-size:0.8rem; background:var(--accent); color:#fff; border:none;" onclick="startMemorizeFromResource('${r.id}', '${r.type}', '${jsAttr(r.url || '')}', '${escapeAttr(page.title)}')">🧠 Mémoriser</button>
            <button class="btn ghost" style="padding:5px 10px; font-size:0.8rem; border-color:var(--primary); color:var(--primary);" id="btn-listen-${r.id}" onclick="listenResource('${r.id}', '${r.type}', '${jsAttr(r.url || '')}')">🔊 Écouter</button>
${r.type === 'pdf' ? `<button class="btn ghost" style="padding:5px 10px; font-size:0.8rem; border-color:var(--accent); color:var(--accent);" onclick="summarizeResource('${r.id}', '${r.type}')">📝 Résumer (IA)</button>` : ''}
            <button class="btn ghost" style="padding:5px 10px; font-size:0.8rem; color:var(--bad); border-color:transparent;" onclick="deleteResource('${page.id}', '${r.id}', '${r.type}')" aria-label="Supprimer">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
  } else {
    resourcesHTML = '<p class="muted" style="margin-bottom: 15px;">Aucune ressource attachée. Ajoutez-en ci-dessous.</p>';
  }

  const addResourceButtons = `
    <div class="row" style="margin-bottom: 20px;">
      <input type="file" id="pdfUpload_${page.id}" accept=".pdf" style="display:none" onchange="uploadPdf(event, '${page.id}')">
      <button class="btn ghost" onclick="document.getElementById('pdfUpload_${page.id}').click()">📄 Ajouter un PDF</button>
      <button class="btn ghost" onclick="addResourceUrl('${page.id}', 'image')">🖼️ Ajouter une Image</button>
      <button class="btn ghost" onclick="addResourceUrl('${page.id}', 'video')">🎥 Ajouter une Vidéo</button>
      <button class="btn ghost" onclick="addResourceUrl('${page.id}', 'link')">🌐 Ajouter un Lien</button>
    </div>
  `;

  const maxQ = Math.max(1, page.questions.length);
  const currentQ = Math.min(state.nbQuestions, maxQ);

  return `
    <div class="main-header">
      <div class="row">
        <button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button>
        <button class="btn ghost" onclick="toggleSections()" title="Menu des sections" style="font-size: 0.9rem; padding: 8px 12px;">📂 Sections</button>
        <div><span class="muted" style="font-size:0.8rem">${escapeHtml(section.title)} ></span><h2 style="margin:0;">${escapeHtml(page.title)}</h2></div>
      </div>
      <button class="btn ghost" onclick="state.activePageId=null; render()">← Retour</button>
    </div>
    <div class="main-content">
      <div class="card" style="border-color: var(--primary);">
        <h3 style="margin-top:0;">📎 Ressources du cours</h3>
        <div style="margin-bottom: 20px;">${resourcesHTML}</div>
        ${addResourceButtons}
      </div>
      <div class="card" style="border-color: rgba(59,130,246,0.4); background: linear-gradient(180deg, rgba(59,130,246,0.05), transparent); margin-top: 20px;">
        <h3 style="margin-top:0;">Lancer le quiz</h3>
        <div class="modes">${renderModeBtns()}</div>
        <div class="row flex-between" style="margin-top:25px;">
          <div style="flex:1; margin-right:30px;">
             <label class="muted" style="font-weight: bold; display: block; margin-bottom: 10px;">Questions : <span id="qcount-label">${currentQ}</span> (sur ${page.questions.length})</label>
             <input type="range" min="1" max="${maxQ}" step="1" value="${currentQ}"
                    oninput="const v=Number(this.value); state.nbQuestions=v; const lbl=document.getElementById('qcount-label'); if(lbl) lbl.textContent=Math.min(v, ${page.questions.length});">
          </div>
          <button class="btn" onclick='startPageQuiz(${JSON.stringify(page.id)})' ${page.questions.length===0?'disabled':''} style="padding: 15px 30px; font-size: 1.1rem;">▶ Démarrer</button>
        </div>
      </div>
      <div class="flex-between" style="margin-bottom:20px; margin-top: 40px;">
        <h3 style="margin:0; font-size: 1.3rem;">Questions (${page.questions.length})</h3>
        <div class="row">
          <button class="btn ghost" onclick="exportPagePDF('${page.id}')" style="border-color: var(--ok); color: var(--ok);">📤 Exporter en PDF</button>
          <button class="btn ghost" onclick="duplicatePage('${page.id}')">📑 Dupliquer</button>
          <button class="btn ghost" onclick="showMassImportModal('${page.id}')" style="border-color: var(--primary); color: var(--primary);">📥 Import en masse</button>
          <button class="btn ghost" onclick="showBulkGenerateModal('${page.id}')" style="border-color: var(--accent); color: var(--accent);">🤖 Générer en masse (IA)</button>
          <button class="btn ghost" onclick="openEditor()">➕ Ajouter manuellement</button>
        </div>
      </div>
      ${questionsHTML}
    </div>
  `;
}
function renderModeBtns() {
  const modes = [
    {id:'training', name:'Entraînement', desc:"Correction immédiate."},
    {id:'exam',     name:'Examen',       desc:"Correction à la fin."},
    {id:'exam_blanc',name:'Examen Blanc',desc:"Chrono global, pas de correction."},
    {id:'survival', name:'Survie',       desc:"3 vies. Tente de survivre !"},
    {id:'srs',      name:'SRS (Anki)',   desc:"Révision espacée."},
    {id:'sprint',   name:'Sprint',       desc:"30 s / question."},
    {id:'flashcard',name:'Flashcards',   desc:"Auto-évaluation."},
    {id:'weak',     name:'Faiblesses',   desc:"Questions le plus souvent ratées."}
  ];
  return modes.map(m => `<button class="mode ${state.mode === m.id ? 'active' : ''}" onclick="state.mode='${m.id}'; render()"><b>${m.name}</b><span>${m.desc}</span></button>`).join('');
}

window.selectNotebook = (id) => {
  const nb = NOTEBOOKS.find(n => n.id === id); if (!nb) return;
  if (state.activeNbId === id && state.screen === 'lesson') { state.sectionsCollapsed = !state.sectionsCollapsed; }
  else {
    state.activeNbId = id;
    state.activeSecId = (nb.sections && nb.sections.length > 0) ? nb.sections[0].id : null;
    state.activePageId = null; state.screen='lesson';
    if (window.innerWidth <= 768) { state.notebooksCollapsed = true; state.sectionsCollapsed = false; }
    else { state.sectionsCollapsed = false; }
  }
  render();
};
window.selectSection = (id) => {
  const nb = NOTEBOOKS.find(n => n.id === state.activeNbId); if (!nb) return;
  const sec = nb.sections.find(s => s.id === id); if (!sec) return;
  state.activeSecId = id; state.activePageId = null;
  if (window.innerWidth <= 768) state.sectionsCollapsed = true;
  render();
};
window.selectPage = (id) => {
  const nb = NOTEBOOKS.find(n => n.id === state.activeNbId); if (!nb) return;
  const sec = nb.sections.find(s => s.id === state.activeSecId); if (!sec) return;
  const pg = sec.pages.find(p => p.id === id); if (!pg) return;
  state.activePageId = id; render();
};

window.addNotebook = () => {
  showPromptModal("Nom de la matière", "Ex: Anatomie", (t) => {
    const id='nb_'+Date.now();
    NOTEBOOKS.push({id, title:t, sections:[]});
    state.activeNbId=id; state.activeSecId=null; state.screen='lesson'; state.sectionsCollapsed = false;
    saveData(); render();
  });
};
window.addSection = () => {
  showPromptModal("Nom de la section", "Ex: Chapitre 1", (t) => {
    const id='sec_'+Date.now(); const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
    if(nb) { nb.sections.push({id, title:t, pages:[]}); state.activeSecId=id; state.activePageId=null; saveData(); render(); }
  });
};
window.addPage = () => {
  showPromptModal("Nom de la page", "Ex: Introduction", (t) => {
    const id='page_'+Date.now(); const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId); const sec = nb?.sections.find(s=>s.id===state.activeSecId);
    if(sec) { sec.pages.push({id, title:t, questions:[], resources: []}); saveData(); render(); }
  });
};

// ============================================================
// ✏️ GESTION DU CONTENU : renommer / supprimer / dupliquer
// ============================================================

function countQuestions(nb) {
  return (nb.sections || []).reduce((total, sec) =>
    total + (sec.pages || []).reduce((n, p) => n + (p.questions || []).length, 0), 0);
}
function deletePdfsOfPages(pages) {
  (pages || []).forEach(p => {
    (p.resources || []).filter(r => r.type === 'pdf').forEach(r => {
      try { deletePdfFromDb(r.id); } catch (e) {}
    });
  });
}
function uniqueSuffix() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ============================================================
// ↩️ ANNULATION DES SUPPRESSIONS
// ============================================================
function snapshotBooks() { return JSON.parse(JSON.stringify(NOTEBOOKS)); }

function offerUndo(message, snapshot) {
  const previous = document.getElementById('undo-toast');
  if (previous) previous.remove();
  const toast = document.createElement('div');
  toast.id = 'undo-toast';
  toast.className = 'undo-toast';
  const label = document.createElement('span');
  label.textContent = message;
  const button = document.createElement('button');
  button.className = 'btn';
  button.textContent = 'Annuler';
  button.addEventListener('click', () => {
    NOTEBOOKS = snapshot;
    saveData();
    toast.remove();
    render();
  });
  toast.append(label, button);
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, 10000);
}
window.offerUndo = offerUndo;

window.renameNotebook = (id) => {
  const nb = NOTEBOOKS.find(n => n.id === id);
  if (!nb) return;
  showPromptModal("Renommer la matière", "Ex: Anatomie", (t) => {
    const title = String(t || '').trim();
    if (!title) return;
    nb.title = title; saveData(); render();
  }, nb.title);
};

window.deleteNotebook = (id) => {
  const nb = NOTEBOOKS.find(n => n.id === id);
  if (!nb) return;
  const total = countQuestions(nb);
  if (!confirm(`Supprimer « ${nb.title} » et ses ${total} question(s) ?\n\nTu pourras annuler pendant 10 secondes.`)) return;
  const snapshot = snapshotBooks();
  (nb.sections || []).forEach(sec => deletePdfsOfPages(sec.pages));
  NOTEBOOKS = NOTEBOOKS.filter(n => n.id !== id);
  if (state.activeNbId === id) {
    state.activeNbId = NOTEBOOKS[0]?.id || null;
    state.activeSecId = NOTEBOOKS[0]?.sections[0]?.id || null;
    state.activePageId = null;
    if (!NOTEBOOKS.length) state.screen = 'dashboard';
  }
  saveData(); render();
  offerUndo(`« ${nb.title} » supprimé.`, snapshot);
};

window.renameSection = (id) => {
  const nb = NOTEBOOKS.find(n => n.id === state.activeNbId);
  const sec = nb?.sections.find(s => s.id === id);
  if (!sec) return;
  showPromptModal("Renommer la section", "Ex: Chapitre 2", (t) => {
    const title = String(t || '').trim();
    if (!title) return;
    sec.title = title; saveData(); render();
  }, sec.title);
};

window.deleteSection = (id) => {
  const nb = NOTEBOOKS.find(n => n.id === state.activeNbId);
  const sec = nb?.sections.find(s => s.id === id);
  if (!sec) return;
  const total = (sec.pages || []).reduce((n, p) => n + (p.questions || []).length, 0);
  if (!confirm(`Supprimer la section « ${sec.title} » et ses ${total} question(s) ?\n\nTu pourras annuler pendant 10 secondes.`)) return;
  const snapshot = snapshotBooks();
  deletePdfsOfPages(sec.pages);
  nb.sections = nb.sections.filter(s => s.id !== id);
  if (state.activeSecId === id) {
    state.activeSecId = nb.sections[0]?.id || null;
    state.activePageId = null;
  }
  saveData(); render();
  offerUndo(`Section « ${sec.title} » supprimée.`, snapshot);
};

// Duplique une page : nouvelles questions, stats et révisions remises à zéro,
// ressources copiées (y compris les PDF, stockés sous un nouvel identifiant).
window.duplicatePage = async (pageId) => {
  const nb = NOTEBOOKS.find(n => n.id === state.activeNbId);
  const sec = nb?.sections.find(s => s.id === state.activeSecId);
  const page = sec?.pages.find(p => p.id === pageId);
  if (!page) return;

  const stamp = uniqueSuffix();
  const copy = {
    id: 'page_' + stamp,
    title: page.title + ' (copie)',
    resources: [],
    questions: (page.questions || []).map((q, i) => ({
      ...q,
      id: 'q_' + stamp + '_' + i,
      choices: (q.choices || []).map(c => ({ ...c })),
      correct: [...(q.correct || [])],
      answers: [...(q.answers || [])],
      srsData: { interval: 0, nextDate: localDateStr() },
      stats: { seen: 0, correct: 0 }
    }))
  };

  for (const r of (page.resources || [])) {
    try {
      if (r.type === 'pdf') {
        const buffer = await getPdfFromDb(r.id);
        if (!buffer) continue;
        const newId = 'pdf_' + stamp + '_' + Math.random().toString(36).slice(2, 6);
        await putPdfBuffer(newId, buffer);
        copy.resources.push({ ...r, id: newId });
      } else {
        copy.resources.push({ ...r, id: 'res_' + stamp + '_' + Math.random().toString(36).slice(2, 6) });
      }
    } catch (e) {
      console.warn('Ressource non dupliquée :', r, e);
    }
  }

  sec.pages.push(copy);
  saveData(); render();
};

// 🔧 FIX 7: supprime les PDF liés à la page
window.deletePage = (pageId) => {
  if (!confirm("Supprimer cette page ?\n\nTu pourras annuler pendant 10 secondes.")) return;
  const snapshot = snapshotBooks();
  const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
  const sec = nb?.sections.find(s=>s.id===state.activeSecId);
  const page = sec?.pages.find(p=>p.id===pageId);
  if (page?.resources) {
    page.resources.filter(r => r.type === 'pdf').forEach(r => {
      try { deletePdfFromDb(r.id); } catch(e) {}
    });
  }
  if (sec) {
    sec.pages = sec.pages.filter(p=>p.id!==pageId);
    if (state.activePageId === pageId) state.activePageId = null;
    saveData(); render();
    offerUndo('Page supprimée.', snapshot);
  }
};
window.deleteQuestion = (qId) => {
  if(!confirm("Supprimer cette question ?\n\nTu pourras annuler pendant 10 secondes.")) return;
  const snapshot = snapshotBooks();
  const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
  const sec = nb?.sections.find(s=>s.id===state.activeSecId);
  const page = sec?.pages.find(p=>p.id===state.activePageId);
  if(page) {
    page.questions = page.questions.filter(q=>q.id!==qId);
    saveData(); render();
    offerUndo('Question supprimée.', snapshot);
  }
};

// 🔧 FIX 13: clamp du nombre de questions
window.startPageQuiz = (pageId) => {
  const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
  const sec = nb?.sections.find(s=>s.id===state.activeSecId);
  const page = sec?.pages.find(p=>p.id===pageId);
  if (!page || !page.questions) return;
  let pool = [...page.questions];
  if (state.mode === 'srs') {
    const todayStr = localDateStr();
    pool = pool.filter(q => !q.srsData || q.srsData.nextDate <= todayStr);
    if (!pool.length) return alert("🎉 Tu es à jour pour cette page ! Aucune question à réviser aujourd'hui.");
  } else if (state.mode === 'weak') {
    pool = pool.filter(isWeakQuestion);
    if (!pool.length) return alert("Pas encore assez de données : réponds au moins 3 fois à des questions pour débloquer le mode Faiblesses.");
    pool.sort((a, b) => weaknessScore(b) - weaknessScore(a));
  } else { pool.sort(()=>0.5-Math.random()); }
  const limit = Math.max(1, Math.min(state.nbQuestions, pool.length));
  pool = pool.slice(0, limit);
  if (!pool.length) return alert("Aucune question disponible pour ce mode.");
  startQuizLogic(pool);
};

// 🔧 FIX 14: clamp aussi
window.startGlobalQuiz = () => {
  let all = [];
  NOTEBOOKS.forEach(nb => nb.sections.forEach(s => s.pages.forEach(p => all = all.concat(p.questions))));
  if(!all.length) return alert("Aucune question dans l'application.");
  let pool = all;
  if (state.mode === 'srs') {
    const todayStr = localDateStr();
    pool = pool.filter(q => !q.srsData || q.srsData.nextDate <= todayStr);
    if (!pool.length) return alert("🎉 Félicitations ! Tu es à jour. Toutes tes révisions sont faites pour aujourd'hui.");
  } else if (state.mode === 'weak') {
    pool = pool.filter(isWeakQuestion);
    if (!pool.length) return alert("Pas encore assez de données : réponds au moins 3 fois à des questions pour débloquer le mode Faiblesses.");
    pool.sort((a, b) => weaknessScore(b) - weaknessScore(a));
  } else { pool.sort(()=>0.5-Math.random()); }
  const limit = Math.max(1, Math.min(state.nbQuestions, pool.length));
  pool = pool.slice(0, limit);
  if (!pool.length) return alert("Aucune question disponible.");
  // Quiz global : les questions viennent de plusieurs pages, donc pas de panneau
  // de ressources lié à la page courante.
  state.activePageId = null;
  startQuizLogic(pool);
};

function startQuizLogic(questions) {
  if(!questions.length) return;
  state.questions = questions;
  state.answers = questions.map(()=>({selected:[], text:'', correct:null, recorded:false}));
  state.index = 0; state.screen = 'quiz'; state.revealed = false;
  state.lives = 3;
  state.timeLimit = 0;
  state.remaining = 0;
  state.negativePoints = (state.mode === 'exam_blanc');
  clearInterval(state.timerId);
  if (state.mode === 'sprint') {
    state.timeLimit = questions.length * 30;
    state.remaining = state.timeLimit;
    state.timerId = setInterval(() => {
      state.remaining--;
      if(state.remaining <= 0) { clearInterval(state.timerId); finishQuiz(); }
      const el = document.getElementById('timer'); if(el) el.textContent = fmtTime(state.remaining);
    }, 1000);
  }
  else if (state.mode === 'exam_blanc') {
    state.timeLimit = questions.length * 60;
    state.remaining = state.timeLimit;
    state.timerId = setInterval(() => {
      state.remaining--;
      if(state.remaining <= 0) { clearInterval(state.timerId); finishQuiz(); }
      const el = document.getElementById('timer'); if(el) el.textContent = fmtTime(state.remaining);
    }, 1000);
  }
  render();
}

window.flipCard = () => { window.stopSpeaking(); state.revealed = !state.revealed; render(); };

// 🔧 FIX : appelée par 3 boutons mais jamais définie (ReferenceError au clic) :
// le panneau de ressources du quiz ne pouvait pas s'ouvrir.
window.toggleQuizResources = () => {
  const panel = document.getElementById('quiz-resources');
  const backdrop = document.getElementById('quiz-backdrop');
  if (!panel) return;
  const isOpen = !panel.classList.contains('open');
  panel.classList.toggle('open', isOpen);
  if (backdrop) backdrop.classList.toggle('open', isOpen);
};
function renderQuiz() {
  const q = state.questions[state.index]; const a = state.answers[state.index]; const isLast = state.index === state.questions.length - 1;
  const frozen = state.revealed;
  if (state.mode === 'exam_blanc') document.body.classList.add('exam-mode-body');
  else document.body.classList.remove('exam-mode-body');

  const activeNb = NOTEBOOKS.find(n=>n.id===state.activeNbId);
  const activeSec = activeNb?.sections.find(s=>s.id===state.activeSecId);
  const currentPage = activeSec?.pages.find(p=>p.id===state.activePageId);
  const hasResources = currentPage && currentPage.resources && currentPage.resources.length > 0;

  let resourcesSidebar = '';
  if (hasResources) {
    const resList = currentPage.resources.map(r => {
      let icon = r.type === 'pdf' ? '📄' : r.type === 'image' ? '🖼️' : r.type === 'video' ? '🎥' : '🌐';
      return `
        <div class="resource-item" style="margin-bottom: 10px;">
          <div class="resource-icon">${icon}</div>
          <div class="resource-info"><div class="resource-name">${escapeHtml(r.name)}</div></div>
          <button class="btn ghost" style="padding:5px 10px; font-size:0.8rem;" onclick="openResource('${r.id}', '${r.type}', '${jsAttr(r.url || '')}')">Ouvrir</button>
        </div>
      `;
    }).join('');
    resourcesSidebar = `
      <div class="quiz-sidebar-backdrop" id="quiz-backdrop" onclick="toggleQuizResources()"></div>
      <div class="quiz-sidebar-modal" id="quiz-resources">
        <div class="quiz-sidebar-header"><h3 style="margin:0;">📎 Ressources du cours</h3><button class="btn ghost" onclick="toggleQuizResources()" aria-label="Fermer">✖</button></div>
        <div class="quiz-sidebar-content"><p class="muted" style="margin-bottom: 20px;">Utilise ces ressources pour t'aider.</p>${resList}</div>
      </div>
    `;
  }

  let headerHTML = '';
  if (state.mode === 'survival') {
    let hearts = '';
    for(let i=0; i<3; i++) {
      hearts += `<span class="heart ${i >= state.lives ? 'lost' : ''}">${i < state.lives ? '❤️' : '🖤'}</span>`;
    }
    headerHTML = `
      <div class="main-header">
        <div class="row">
          <button class="btn ghost" onclick="toggleNotebooks()" aria-label="Menu principal">☰</button>
          <h2>Mode Survie</h2>
        </div>
        <div class="hearts-container">${hearts}</div>
      </div>
    `;
  } else if (state.mode === 'exam_blanc') {
    headerHTML = `
      <div class="main-header">
        <div class="row">
          <button class="btn ghost" onclick="toggleNotebooks()" aria-label="Menu principal">☰</button>
          <h2>Examen Blanc</h2>
        </div>
        <div class="timer" id="timer">${fmtTime(state.remaining)}</div>
      </div>
    `;
  } else {
    headerHTML = `
      <div class="main-header">
        <div class="row">
          <button class="btn ghost" onclick="toggleNotebooks()" aria-label="Menu principal">☰</button>
          <h2>Quiz en cours (${state.mode === 'srs' ? 'SRS' : state.mode === 'weak' ? 'Faiblesses' : state.mode === 'exam_blanc' ? 'Examen Blanc' : state.mode})</h2>
          ${hasResources ? `<button class="btn ghost" onclick="toggleQuizResources()" style="margin-left: 15px; font-size: 0.85rem; padding: 5px 10px; border-color: var(--primary); color: var(--primary);">📎 Voir les ressources (${currentPage.resources.length})</button>` : ''}
        </div>
        ${state.mode==='sprint'?`<div class="timer" id="timer">${fmtTime(state.remaining)}</div>`:''}
      </div>
    `;
  }

  if (state.mode === 'flashcard') {
    const expected = correctAnswerText(q);
    return `
      ${resourcesSidebar}
      ${headerHTML}
      <div class="main-content" style="display:flex; flex-direction:column; justify-content:center; align-items:center;">
        <div class="flashcard-scene" onclick="flipCard()">
          <div class="flashcard-card ${state.revealed ? 'is-flipped' : ''}">
            <div class="flashcard-front">
              <h2>${escapeHtml(q.statement)} <button class="speak-btn" onclick="event.stopPropagation(); readCurrentQuestion()" aria-label="Écouter">🔊</button></h2>
              ${q.image ? `<img src="${escapeAttr(q.image)}" class="flashcard-image" alt="Illustration" onerror="this.style.display='none'">` : ''}
              <p class="muted" style="margin-top:30px; font-size: 0.9rem;">(Cliquez sur la carte pour révéler)</p>
            </div>
            <div class="flashcard-back">
              <h3>Réponse</h3><p class="answer">${escapeHtml(expected)}</p>
              ${q.explanation ? `<p class="muted" style="font-size:1rem; margin-top: 20px;">${escapeHtml(q.explanation)} <button class="speak-btn" onclick="event.stopPropagation(); readExplanation()" aria-label="Écouter">🔊</button></p>` : ''}
            </div>
          </div>
        </div>
        <div class="row" style="justify-content:center; margin-top:30px; width: 100%; max-width: 600px;">
          ${state.revealed ? `<button class="btn ghost" style="flex:1; padding: 18px; font-size: 1.1rem;" onclick="selfGrade(false)">❌ Je ne savais pas</button><button class="btn" style="flex:1; padding: 18px; font-size: 1.1rem;" onclick="selfGrade(true)">✅ Je savais</button>` : `<button class="btn" style="width:100%; padding: 18px; font-size: 1.2rem;" onclick="flipCard()">Afficher la réponse</button>`}
        </div>
      </div>
    `;
  }

  let body = '';
  if (q.type === 'qcm' || q.type === 'qcs') {
    body = q.choices.map((c, i) => {
      let cls = 'choice';
      if (a.selected.includes(c.id)) cls += ' sel';
      if (state.revealed && state.mode !== 'exam_blanc') {
        if (q.correct.includes(c.id)) cls += ' ok';
        else if (a.selected.includes(c.id)) cls += ' bad';
      }
      const letter = String.fromCharCode(65 + i);
      return `<button class="${cls}" onclick="toggleChoice('${c.id}', '${q.type}')" ${frozen?'disabled':''}><span class="kbd-hint">${letter}</span> ${escapeHtml(c.text)}</button>`;
    }).join('');
  } else if (q.type === 'qnum') {
    body = `<div class="row" style="gap:10px; flex-wrap:nowrap; align-items:center;">
      <input type="text" inputmode="decimal" value="${escapeAttr(a.text)}" oninput="state.answers[state.index].text=this.value" ${frozen?'disabled':''} placeholder="Votre réponse..." style="font-size: 1.1rem; padding: 18px; margin-bottom:0; flex:1;">
      ${q.unit ? `<span class="muted" style="font-weight:700; font-size:1.1rem; white-space:nowrap;">${escapeHtml(q.unit)}</span>` : ''}
    </div>`;
  } else {
    body = `<input type="text" value="${escapeAttr(a.text)}" oninput="state.answers[state.index].text=this.value" ${frozen?'disabled':''} placeholder="Votre réponse..." style="font-size: 1.1rem; padding: 18px;">`;
  }

  const usesConfidence = ['training', 'srs', 'survival', 'weak'].includes(state.mode) && !state.revealed;
  const confidenceHTML = usesConfidence ? `<div class="confidence-row"><span class="muted">Ta confiance :</span>${[['low', '🤷 Pas sûr'], ['mid', '🤔 Moyen'], ['high', '💪 Sûr']].map(([level, label]) => `<button class="conf-btn ${a.confidence === level ? 'active' : ''}" onclick="setConfidence('${level}')">${label}</button>`).join('')}</div>` : '';
  const confidenceNote = !state.revealed || state.mode === 'exam_blanc' ? '' :
    (a.correct && a.confidence === 'low') ? `<div class="conf-note lucky">🍀 Bonne réponse, mais tu n'étais pas sûr : c'était peut-être un coup de chance.</div>` :
    (!a.correct && a.confidence === 'high') ? `<div class="conf-note overconfident">⚠️ Tu étais sûr de toi, et c'était faux : ce point mérite une révision.</div>` : '';
  let feedback = '';
  if (state.revealed && state.mode !== 'exam_blanc') {
    const aiBtnHTML = !a.correct
      ? `<br><button class="btn-ai-explain" onclick="explainWithAI(this)">🤖 Explique-moi (IA)</button>`
      : '';
    const expectedHTML = q.type === 'qnum'
      ? `<div style="margin-top:8px;"><b>Réponse attendue : ${escapeHtml(String(q.numeric))}${q.unit ? ' ' + escapeHtml(q.unit) : ''}</b>${q.tolerance ? ` <span class="muted">(± ${escapeHtml(String(q.tolerance))})</span>` : ''}</div>`
      : '';
    feedback = `<div class="fb ${a.correct?'ok':'bad'}">
      <b>${a.correct?'✅ Correct':'❌ Incorrect'}</b><br>${escapeHtml(q.explanation||'')}
      ${expectedHTML}
      ${confidenceNote}
      <button class="speak-btn" style="font-size:1.2rem; margin-left:10px;" onclick="readExplanation()" title="Écouter l'explication">🔊</button>
      ${aiBtnHTML}
    </div>`;
  }

  let srsButtons = '';
  if (state.mode === 'srs' && state.revealed) {
    srsButtons = `
      <div class="srs-feedback-buttons">
        <button class="btn-srs hard" onclick="selfGradeSRS('hard')">😰 Difficile</button>
        <button class="btn-srs medium" onclick="selfGradeSRS('medium')">🤔 Moyen</button>
        <button class="btn-srs easy" onclick="selfGradeSRS('easy')">😎 Facile</button>
      </div>
    `;
  }

  const isExamMode = state.mode === 'exam' || state.mode === 'exam_blanc';
  const isAnswered = (i) => {
    const ans = state.answers[i];
    return !!(ans && (((ans.selected || []).length) || String(ans.text || '').trim()));
  };

  let controls = '';
  const isTrainingOrSurvival = state.mode === 'training' || state.mode === 'srs' || state.mode === 'survival' || state.mode === 'weak';
  if (state.mode === 'srs' && state.revealed) {
    controls = '';
  } else if (isExamMode) {
    // Mode examen : on peut revenir en arrière et changer ses réponses.
    controls = `
      <button class="btn ghost" onclick="prevQ()" ${state.index === 0 ? 'disabled' : ''} style="padding: 15px 25px; font-size: 1.1rem;">← Précédent</button>
      <button class="btn" onclick="${isLast ? 'finishExam()' : 'nextQ()'}" style="padding: 15px 30px; font-size: 1.1rem;">${isLast?'Terminer':'Suivant →'}</button>`;
  } else if (isTrainingOrSurvival) {
    controls = state.revealed ?
      `<button class="btn" onclick="nextQ()" style="padding: 15px 30px; font-size: 1.1rem;">${isLast?'Terminer':'Suivant →'}</button>` :
      `<button class="btn" onclick="checkAnswer()" style="padding: 15px 30px; font-size: 1.1rem;">Valider</button>`;
  } else {
    controls = `<button class="btn" onclick="nextQ()" style="padding: 15px 30px; font-size: 1.1rem;">${isLast?'Terminer':'Suivant →'}</button>`;
  }

  const navigatorHTML = isExamMode ? `
    <div class="qnav">
      ${state.questions.map((_, i) => `<button class="qnav-btn ${i === state.index ? 'current' : ''} ${isAnswered(i) ? 'answered' : ''}" onclick="goToQuestion(${i})" title="Question ${i+1}">${i+1}</button>`).join('')}
      <button class="btn ghost qnav-finish" onclick="finishExam()">Terminer l'examen</button>
    </div>
    <div class="qnav-legend">
      <span><i class="dot current"></i>actuelle</span>
      <span><i class="dot answered"></i>répondue</span>
      <span><i class="dot"></i>sans réponse</span>
    </div>` : '';

  return `
    ${resourcesSidebar}
    ${headerHTML}
    <div class="main-content" style="align-items: flex-start; justify-content: flex-start; padding-top: 20px;">
      ${navigatorHTML}
      <div class="card" style="max-width: 900px; margin: 0 auto; width: 100%; padding: 40px;">
        <div class="flex-between" style="gap:10px;">
          <p class="muted" style="font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; margin:0;">Question ${state.index+1} / ${state.questions.length}</p>
          <button class="btn ghost" style="padding:4px 10px; font-size:0.8rem; ${q.flag ? 'border-color: var(--warn); color: var(--warn);' : ''}" onclick="toggleFlag()" title="Marquer comme favori">${q.flag ? '🚩 Favori' : '🏳️ Favori'}</button>
        </div>
        <h3 style="font-size: 1.5rem; margin-bottom: 30px; line-height: 1.4; display: flex; align-items: center; flex-wrap: wrap;">
          ${escapeHtml(q.statement)} <button class="speak-btn" onclick="readCurrentQuestion()" title="Écouter la question">🔊</button>
        </h3>
        ${q.image ? `<img src="${escapeAttr(q.image)}" class="question-image" alt="Illustration" onerror="this.style.display='none'">` : ''}
        ${body}
        ${confidenceHTML}
        ${feedback}
        ${srsButtons}
      </div>
      <div class="row" style="justify-content:flex-end; max-width: 900px; margin: 0 auto; width: 100%; margin-top: 20px;">${controls}</div>
    </div>
  `;
}

// Confiance avant validation : sert à repérer les bonnes réponses dues au hasard.
window.setConfidence = (level) => { const a = state.answers[state.index]; a.confidence = a.confidence === level ? null : level; render(); };
window.toggleChoice = (id, type) => { window.stopSpeaking(); const a=state.answers[state.index]; if(type==='qcs') a.selected=[id]; else a.selected=a.selected.includes(id)?a.selected.filter(x=>x!==id):[...a.selected,id]; render(); };

// --- Navigation libre (modes examen) ---
window.goToQuestion = (i) => {
  if (!Number.isInteger(i) || i < 0 || i >= state.questions.length) return;
  window.stopSpeaking();
  state.index = i;
  state.revealed = false;
  render();
};
window.prevQ = () => window.goToQuestion(state.index - 1);
window.finishExam = () => {
  const unanswered = state.answers.filter(a =>
    !a || (!(a.selected || []).length && !String(a.text || '').trim())
  ).length;
  if (unanswered > 0 && !confirm(`Il reste ${unanswered} question(s) sans réponse. Terminer quand même ?`)) return;
  finishQuiz();
};

window.checkAnswer = () => {
  window.stopSpeaking();
  const q = state.questions[state.index];
  const a = state.answers[state.index];
  a.correct = grade(q, a);
  // En mode SRS, la note finale vient des boutons Difficile/Moyen/Facile :
  // on n'enregistre pas ici pour ne pas compter la question deux fois.
  if (state.mode !== 'srs') recordAnswer(q, a, a.correct);
  if (state.mode === 'survival') {
    if (!a.correct) {
      state.lives--;
      if (state.lives <= 0) {
        a.correct = false;
        state.revealed = true;
        render();
        setTimeout(() => { alert("💀 Tu as perdu toutes tes vies ! Partie terminée."); finishQuiz(); }, 500);
        return;
      }
    }
  }
  state.revealed=true;
  render();
};

window.nextQ = () => {
  window.stopSpeaking();
  const q = state.questions[state.index];
  const a = state.answers[state.index];
  const isExamMode = state.mode === 'exam' || state.mode === 'exam_blanc';
  // En mode examen, on ne corrige qu'à la fin : l'utilisateur peut revenir en
  // arrière et changer sa réponse. Sinon on enregistre en quittant la question.
  if (!isExamMode && q && a && !a.recorded) recordAnswer(q, a, grade(q, a));
  if(state.index===state.questions.length-1) finishQuiz();
  else { state.index++; state.revealed=false; render(); }
};

window.selfGrade = (isKnown) => {
  window.stopSpeaking();
  recordAnswer(state.questions[state.index], state.answers[state.index], isKnown);
  if(state.index===state.questions.length-1) finishQuiz(); else { state.index++; state.revealed=false; render(); }
};

window.selfGradeSRS = (difficulty) => {
  window.stopSpeaking();
  const q = state.questions[state.index];
  const a = state.answers[state.index];
  recordAnswer(q, a, difficulty !== 'hard', difficulty);
  if (state.index === state.questions.length - 1) finishQuiz();
  else { state.index++; state.revealed = false; render(); }
};

function finishQuiz() {
  window.stopSpeaking(); clearInterval(state.timerId);
  document.body.classList.remove('exam-mode-body');
  // Correction des modes sans feedback immédiat : une seule fois, à la fin.
  if (state.mode === 'exam' || state.mode === 'exam_blanc') {
    state.questions.forEach((q, i) => {
      const a = state.answers[i];
      if (a && !a.recorded) recordAnswer(q, a, grade(q, a));
    });
  }
  let finalScore = 0;
  if (state.negativePoints) {
    const corrects = state.answers.filter(a=>a.correct).length;
    const wrongs = state.answers.length - corrects;
    finalScore = Math.max(0, corrects - (wrongs * 0.5));
  } else {
    finalScore = state.answers.filter(a=>a.correct).length;
  }
  const pct = Math.round((finalScore/state.questions.length)*100);
  if (pct === 100 && state.mode !== 'exam') fireConfetti();
  updateGamification(Math.round(finalScore), state.questions.length);
  HISTORY.unshift({ date: new Date().toLocaleDateString('fr-FR'), mode: state.mode, score: Math.round(finalScore), total: state.questions.length, pct: pct });
  if(HISTORY.length>20) HISTORY.pop();
  saveData(); state.screen='results'; render();
}

function renderResults() {
  const score = state.answers.filter(a=>a.correct).length;
  const pct = Math.round((score/state.questions.length)*100);
  const wrongCount = state.questions.filter((q,i) => !state.answers[i].correct).length;
  const luckyNums = state.questions.map((q, i) => i + 1).filter(n => state.answers[n - 1].correct && state.answers[n - 1].confidence === 'low');
  const overconfidentNums = state.questions.map((q, i) => i + 1).filter(n => !state.answers[n - 1].correct && state.answers[n - 1].confidence === 'high');
  const luckyHTML = (luckyNums.length || overconfidentNums.length) ? `<div class="conf-summary">${luckyNums.length ? `<p>🍀 Coups de chance : question ${luckyNums.join(', ')}</p>` : ''}${overconfidentNums.length ? `<p>⚠️ Trop sûr de toi : question ${overconfidentNums.join(', ')}</p>` : ''}</div>` : '';
  const xpHTML = `
    <div style="margin-top: 30px; padding: 20px; background: rgba(59, 130, 246, 0.1); border-radius: 16px; border: 1px solid rgba(59,130,246,0.3);">
      <p style="margin: 0; font-size: 1.3rem; color: var(--primary); font-weight: 800;">+ ${state.lastEarnedXp} XP gagnés !</p>
      <p class="muted" style="margin: 8px 0 0 0; font-size: 1rem;">Série actuelle : 🔥 ${GAME_DATA.streak} jour(s)</p>
    </div>
  `;
  return `
    <div class="main-header"><div class="row"><button class="btn ghost" onclick="toggleNotebooks()" title="Menu principal">☰</button><h2>Résultats</h2></div></div>
    <div class="main-content" style="justify-content:center; align-items:center;">
      <div class="card" style="text-align:center; max-width: 600px; width: 100%; padding: 50px 30px;">
        <h1 class="score">${pct>=80?'🏆':pct>=50?'👍':'💪'} ${pct}%</h1>
        <p class="muted" style="font-size: 1.2rem; font-weight: 500;">${score} / ${state.questions.length} bonnes réponses</p>
        ${xpHTML}
        ${luckyHTML}
        <div class="row" style="justify-content:center; margin-top:40px; flex-direction: column; gap: 15px;">
          ${wrongCount > 0 ? `<button class="btn" style="padding: 16px; width: 100%; font-size: 1.1rem;" onclick="redoErrors()">🔁 Refaire les erreurs (${wrongCount})</button>` : ''}
          <button class="btn ghost" style="padding: 16px; width: 100%; font-size: 1.1rem; border-color: var(--ok); color: var(--ok);" onclick="exportResultsPDF()">📤 Exporter les résultats en PDF</button>
          <button class="btn ghost" style="padding: 16px; width: 100%; font-size: 1.1rem;" onclick="state.screen='dashboard'; state.activePageId=null; render()">🏠 Retour au tableau de bord</button>
        </div>
      </div>
    </div>
  `;
}

window.redoErrors = () => { const wrongQuestions = state.questions.filter((q, i) => !state.answers[i].correct); startQuizLogic(wrongQuestions); };

// Ouvre l'éditeur : vierge, ou pré-rempli pour modifier une question existante.
window.openEditor = (questionId = null) => {
  const editor = {
    isOpen: true, editId: null, type: 'qcs', statement: '', image: '',
    choices: ['', '', '', ''], correct: [], qrocAnswers: '', explanation: '',
    tagsText: '', numeric: '', tolerance: '0', unit: ''
  };
  if (questionId) {
    const nb = NOTEBOOKS.find(n => n.id === state.activeNbId);
    const sec = nb?.sections.find(s => s.id === state.activeSecId);
    const page = sec?.pages.find(p => p.id === state.activePageId);
    const q = page?.questions.find(x => x.id === questionId);
    if (q) {
      const baseChoices = (q.choices || []).map(c => c.text);
      editor.editId = q.id;
      editor.type = q.type || 'qcs';
      editor.statement = q.statement || '';
      editor.image = q.image || '';
      editor.explanation = q.explanation || '';
      editor.choices = baseChoices.concat(['', '', '', '']).slice(0, Math.max(4, baseChoices.length));
      editor.correct = (q.choices || [])
        .map((c, i) => (q.correct || []).includes(c.id) ? String(i) : null)
        .filter(x => x !== null);
      editor.qrocAnswers = (q.answers || []).join(', ');
      editor.tagsText = (q.tags || []).join(', ');
      editor.numeric = (q.numeric === null || q.numeric === undefined) ? '' : String(q.numeric);
      editor.tolerance = String(q.tolerance ?? 0);
      editor.unit = q.unit || '';
    }
  }
  state.editor = editor;
  render();
};
window.editQuestion = (id) => window.openEditor(id);

function renderEditor() {
  const ed = state.editor;
  let fields;
  if (ed.type === 'qroc') {
    fields = `<label>Réponses (virgule)</label><input type="text" value="${escapeAttr(ed.qrocAnswers)}" oninput="state.editor.qrocAnswers=this.value">`;
  } else if (ed.type === 'qnum') {
    fields = `
      <label>Réponse attendue (nombre)</label>
      <input type="text" inputmode="decimal" value="${escapeAttr(ed.numeric)}" oninput="state.editor.numeric=this.value" placeholder="Ex: 2.5">
      <div class="row" style="gap:15px; align-items:flex-start;">
        <div style="flex:1; min-width:120px;">
          <label>Tolérance (±)</label>
          <input type="text" inputmode="decimal" value="${escapeAttr(ed.tolerance)}" oninput="state.editor.tolerance=this.value" placeholder="0">
        </div>
        <div style="flex:1; min-width:120px;">
          <label>Unité</label>
          <input type="text" value="${escapeAttr(ed.unit)}" oninput="state.editor.unit=this.value" placeholder="mg, mL, %...">
        </div>
      </div>`;
  } else {
    fields = `<label>Choix</label>` + ed.choices.map((c, i) => `
        <div class="row" style="margin-bottom:10px; flex-wrap: nowrap;">
          <input type="checkbox" ${ed.correct.includes(i.toString())?'checked':''} onchange="toggleCorrect('${i}')" style="width:24px; height: 24px; flex-shrink:0; accent-color: var(--primary); cursor: pointer;">
          <input type="text" value="${escapeAttr(c)}" oninput="state.editor.choices[${i}]=this.value" placeholder="Choix ${i+1}" style="margin-bottom:0;">
        </div>`).join('');
  }
  return `
    <div class="overlay">
      <div class="overlay-content">
        <div class="flex-between" style="margin-bottom:30px;"><h2 style="font-size: 1.5rem; margin: 0;">${ed.editId ? 'Modifier la question' : 'Ajouter une question'}</h2><button class="btn ghost" onclick="state.editor.isOpen=false; render()" style="padding: 8px 15px;" aria-label="Fermer">✖</button></div>
        <label style="font-weight: bold; margin-bottom: 8px; display: block;">Type de question</label>
        <select onchange="state.editor.type=this.value; render()" style="margin-bottom: 25px;">
          <option value="qcs" ${ed.type==='qcs'?'selected':''}>QCS (Une seule réponse)</option>
          <option value="qcm" ${ed.type==='qcm'?'selected':''}>QCM (Plusieurs réponses)</option>
          <option value="qroc" ${ed.type==='qroc'?'selected':''}>QROC (Réponse libre)</option>
          <option value="qnum" ${ed.type==='qnum'?'selected':''}>QNUM (Réponse numérique)</option>
        </select>
        <label style="font-weight: bold; margin-bottom: 8px; display: block;">Énoncé</label>
        <textarea oninput="state.editor.statement=this.value" placeholder="Tapez votre question ici..." style="min-height: 100px; margin-bottom: 25px;">${escapeHtml(ed.statement)}</textarea>
        <label style="font-weight: bold; margin-bottom: 8px; display: block;">Lien de l'image (Optionnel)</label>
        <input type="text" value="${escapeAttr(ed.image)}" oninput="state.editor.image=this.value" placeholder="https://..." style="margin-bottom: 20px;">
        ${ed.image ? `<img src="${escapeAttr(ed.image)}" style="max-height: 120px; margin-bottom: 25px; border-radius: 8px; border: 1px solid var(--line);" alt="Aperçu" onerror="this.style.display='none'">` : ''}
        ${fields}
        <label style="font-weight: bold; margin-bottom: 8px; display: block; margin-top: 25px;">Étiquettes (optionnel)</label>
        <input type="text" value="${escapeAttr(ed.tagsText)}" oninput="state.editor.tagsText=this.value" placeholder="posologie, calcul, cardio" style="margin-bottom: 10px;">
        <p class="muted" style="font-size: 0.8rem; margin-top:0;">Séparées par des virgules. Elles servent à filtrer et lancer des quiz ciblés.</p>
        <label style="font-weight: bold; margin-bottom: 8px; display: block; margin-top: 25px;">Explication</label>
        <textarea oninput="state.editor.explanation=this.value" placeholder="Pourquoi cette réponse est-elle correcte ?" style="min-height: 80px;">${escapeHtml(ed.explanation)}</textarea>
        <button class="btn" style="width:100%; padding: 18px; font-size: 1.1rem; margin-top: 15px;" onclick="saveQuestion()">💾 Enregistrer la question</button>
      </div>
    </div>`;
}

window.toggleCorrect = (id) => { if(state.editor.type==='qcs') state.editor.correct=[id]; else state.editor.correct = state.editor.correct.includes(id)?state.editor.correct.filter(x=>x!==id):[...state.editor.correct, id]; render(); };
window.saveQuestion = () => {
  const ed = state.editor; if(!ed.statement) return alert("Énoncé vide");
  const newQ = {
    id:'q_'+Date.now(), type:ed.type, statement:ed.statement, image: ed.image,
    explanation:ed.explanation,
    tags: String(ed.tagsText || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8),
    flag: false,
    srsData: { interval: 0, nextDate: localDateStr() },
    stats: { seen: 0, correct: 0 }
  };
  if (ed.type === 'qroc') {
    newQ.answers = ed.qrocAnswers.split(',').map(s=>s.trim()).filter(s=>s);
    if(!newQ.answers.length) return alert("Réponses vides");
  } else if (ed.type === 'qnum') {
    const expected = parseNumeric(ed.numeric);
    if (expected === null) return alert("Réponse numérique invalide");
    newQ.numeric = expected;
    newQ.tolerance = Math.max(0, parseNumeric(ed.tolerance) ?? 0);
    newQ.unit = String(ed.unit || '').trim();
  } else {
    newQ.choices = ed.choices.map((t,i)=>({id:i.toString(), text:t})).filter(c=>c.text);
    newQ.correct = ed.correct.filter(id=>newQ.choices.find(c=>c.id===id));
    if(!newQ.correct.length) return alert("Cochez une réponse");
  }
  const nb = NOTEBOOKS.find(n=>n.id===state.activeNbId); const sec = nb?.sections.find(s=>s.id===state.activeSecId); const page = sec?.pages.find(p=>p.id===state.activePageId);
  if (!page) return;

  if (ed.editId) {
    const idx = page.questions.findIndex(q => q.id === ed.editId);
    if (idx >= 0) {
      const old = page.questions[idx];
      // On conserve l'identifiant, les statistiques, l'étiquette et la planification SRS.
      newQ.id = old.id;
      newQ.stats = old.stats || { seen: 0, correct: 0 };
      newQ.srsData = old.srsData || newQ.srsData;
      newQ.flag = old.flag === true;
      page.questions[idx] = newQ;
    } else {
      page.questions.push(newQ);
    }
  } else {
    page.questions.push(newQ);
  }

  saveData(); state.editor.isOpen=false; render();
};
// 🔧 FIX: guard pdf.js + endpoint centralisé
document.addEventListener('keydown', (e) => {
  if (state.screen === 'quiz') {
    const key = e.key.toUpperCase();
    const choiceMap = { '1': 0, '2': 1, '3': 2, '4': 3, 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
    if (choiceMap[key] !== undefined && !state.revealed && state.mode !== 'flashcard') {
      const q = state.questions[state.index];
      if (q.choices && q.choices[choiceMap[key]]) { e.preventDefault(); window.toggleChoice(q.choices[choiceMap[key]].id, q.type); }
    }
    // Espace : valider la réponse (ou révéler la carte) sans quitter le clavier.
    const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
    if (e.key === ' ' && !typing && !state.revealed) {
      if (state.mode === 'flashcard') { e.preventDefault(); window.flipCard(); }
      else if (['training', 'srs', 'survival', 'weak'].includes(state.mode)) { e.preventDefault(); window.checkAnswer(); }
    }
    if (e.key === 'Enter') {
      if (state.mode === 'flashcard') { if (!state.revealed) { e.preventDefault(); window.flipCard(); } }
      else if (!state.revealed && (state.mode === 'training' || state.mode === 'srs')) { e.preventDefault(); window.checkAnswer(); }
      else if (state.revealed || state.mode !== 'training') { e.preventDefault(); window.nextQ(); }
    }
    // Flèches gauche/droite : navigation dans les modes examen.
    if (state.mode === 'exam' || state.mode === 'exam_blanc') {
      if (e.key === 'ArrowLeft') { e.preventDefault(); window.prevQ(); }
      else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (state.index === state.questions.length - 1) window.finishExam();
        else window.nextQ();
      }
    }
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'deckFile') {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let deck = null;
    try { deck = JSON.parse(await file.text()); } catch (_) { deck = null; }
    if (!deck || deck.format !== 'quizmaster-deck' || !deck.notebook || typeof deck.notebook !== 'object') {
      return alert("Ce fichier n'est pas un deck Révisoria valide.");
    }
    const [nb] = sanitizeImportedData(deck.notebook);
    // Nouveaux identifiants : importer deux fois la même matière ne doit pas écraser la première.
    const suffix = uniqueSuffix();
    nb.id = 'nb_' + suffix;
    nb.sections.forEach((sec, i) => {
      sec.id = 'sec_' + suffix + i;
      sec.pages.forEach((page, j) => {
        page.id = 'page_' + suffix + i + '_' + j;
        page.questions.forEach((q, k) => { q.id = 'q_' + suffix + i + j + k; });
      });
    });
    NOTEBOOKS = NOTEBOOKS.concat([nb]);
    saveData(); render();
    alert(`Matière « ${nb.title} » importée (${nb.sections.length} section(s)).`);
    return;
  }
  if(e.target.id === 'fileJson') {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data && data.notebooks && data.gameData) {
          if(confirm("⚠️ Ceci est une sauvegarde complète. Elle va remplacer TOUS tes cours actuels. Continuer ?")) {
            NOTEBOOKS = sanitizeImportedData(data.notebooks);
            HISTORY = Array.isArray(data.history) ? data.history.filter(h => h && typeof h === 'object') : [];
            // 🔧 FIX : gameData importé pouvait être incomplet (xp/streak -> NaN).
            GAME_DATA = {
              xp: Number(data.gameData?.xp) || 0,
              level: Number(data.gameData?.level) || 1,
              streak: Number(data.gameData?.streak) || 0,
              lastPlayed: typeof data.gameData?.lastPlayed === 'string' ? data.gameData.lastPlayed : null,
              lastBackup: typeof data.gameData?.lastBackup === 'string' ? data.gameData.lastBackup : null,
              badges: Array.isArray(data.gameData?.badges) ? data.gameData.badges : []
            };
            saveData();
            state.activeNbId = NOTEBOOKS[0]?.id || null; state.activeSecId = NOTEBOOKS[0]?.sections[0]?.id || null; state.activePageId = null; state.screen = 'dashboard';
            alert("✅ Sauvegarde restaurée avec succès !"); render();
          }
        }
        else if (Array.isArray(data) && data.length > 0) {
          const sanitized = sanitizeImportedData(data); NOTEBOOKS = NOTEBOOKS.concat(sanitized); saveData();
          state.activeNbId = sanitized[0].id; state.activeSecId = sanitized[0].sections[0]?.id || null; state.activePageId = null; state.screen = 'lesson';
          alert(`✅ ${sanitized.length} bloc-notes importé(s) avec succès !`); render();
        }
        else alert("Format invalide.");
      } catch(err) { alert("Fichier JSON invalide ou mal formé."); }
    };
    reader.readAsText(file);
    // 🔧 FIX : sans reset, réimporter le même fichier ne déclenchait aucun `change`.
    e.target.value = '';
  }

  if(e.target.id === 'filePdf') {
    const file = e.target.files[0]; if(!file) return;
    if(!ensureGeminiKey()) return;
    if (!isPdfReady()) return alert("PDF.js non chargé (vérifie ta connexion).");
    const btn = document.getElementById('btn-ia'); btn.textContent="⏳ Analyse..."; btn.disabled=true;
    try {
      const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.readAsDataURL(file); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; });
      const prompt = `Analyse ce PDF et génère un quiz. Format STRICT: [{"id":"nb_ia","title":"Cours IA","sections":[{"id":"sec_ia","title":"Généré","pages":[{"id":"page_ia","title":"Questions","questions":[{"id":"q1","type":"qcs","statement":"Q?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correct":["a"],"explanation":"Expl"}]}]}]}]`;
      let text = (await callGemini([
        { text: prompt },
        { inline_data: { mime_type: "application/pdf", data: base64 } }
      ])).replace(/```json/gi,'').replace(/```/g,'').trim();
      text = text.substring(text.indexOf('['), text.lastIndexOf(']')+1);
      let parsed;
      try { parsed = JSON.parse(text); } catch(pe) { throw new Error("Format JSON invalide retourné par l'IA."); }
      const sanitized = sanitizeImportedData(parsed);
      if (!sanitized.length) throw new Error("L'IA n'a renvoyé aucun bloc-notes exploitable.");
      NOTEBOOKS = NOTEBOOKS.concat(sanitized); saveData();
      state.activeNbId = sanitized[0].id; state.activeSecId = sanitized[0].sections[0]?.id || null; state.activePageId = null; state.screen = 'lesson';
      alert("✅ Quiz importé depuis le PDF !"); render();
    } catch(err) { alert("Erreur : " + err.message); } finally { const btn = document.getElementById('btn-ia'); if(btn){ btn.textContent="🤖 Depuis un PDF"; btn.disabled = false; } e.target.value = ''; }
  }
});

// 🔧 FIX 20: avertissement clé API
if (!hasGeminiKey()) {
  console.info('Clé Gemini non configurée : elle sera demandée au premier usage d’une fonction IA.');
}

// LANCEMENT
render();
