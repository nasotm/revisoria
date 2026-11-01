/* Background preferences are kept separately from course and quiz data. */
(() => {
  'use strict';
  const presets = {
    aurora: { name: 'Aurore', color: 'radial-gradient(ellipse at 15% 20%, #185b70, transparent 65%), radial-gradient(ellipse at 90% 80%, #624997, transparent 65%), linear-gradient(140deg, #081324, #182a44)' },
    ocean: { name: 'Océan', color: 'radial-gradient(ellipse at 75% 15%, #358f9a, transparent 60%), linear-gradient(145deg, #072c45, #0b5560 60%, #18253e)' },
    dusk: { name: 'Crépuscule', color: 'radial-gradient(ellipse at 85% 10%, #ce8a76, transparent 65%), linear-gradient(145deg, #312c56, #775477 65%, #25364b)' },
    forest: { name: 'Forêt', color: 'radial-gradient(ellipse at 20% 10%, #68836a, transparent 65%), linear-gradient(145deg, #132c2b, #315849 60%, #172d33)' },
    original: { name: 'Sobre', color: 'radial-gradient(circle at 15% 50%, var(--glow), transparent 50%), linear-gradient(var(--bg), var(--bg))' }
  };
  const defaults = { preset: 'aurora', image: '', x: 50, y: 50, zoom: 100, blur: 0, dim: 35 };
  let prefs = { ...defaults }, database = null, timer, writing = Promise.resolve(), uploadGeneration = 0;
  const layer = document.createElement('div');
  layer.id = 'qm-background'; layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<div class="qm-bg-picture"></div><div class="qm-bg-veil"></div>';
  document.body.prepend(layer);
  document.body.classList.add('qm-background-enabled');
  const launcher = document.createElement('button');
  launcher.id = 'qm-background-button'; launcher.type = 'button'; launcher.textContent = '🖼️';
  launcher.title = 'Personnaliser le fond'; launcher.setAttribute('aria-label', 'Personnaliser le fond');
  const dialog = document.createElement('dialog');
  dialog.id = 'qm-background-dialog'; dialog.setAttribute('aria-labelledby', 'qm-background-title');
  dialog.innerHTML = `
    <div class="qm-bg-heading"><div><span class="qm-bg-eyebrow">VOTRE ESPACE DE RÉVISION</span><h2 id="qm-background-title">Une ambiance à votre image</h2></div><button type="button" class="btn ghost" data-close aria-label="Fermer">✕</button></div>
    <p class="muted">Choisissez une ambiance ou ajoutez votre photo. Les réglages s'appliquent en direct à toute l'application.</p>
    <div class="qm-bg-preview" aria-label="Aperçu du fond"><div class="qm-bg-preview-image"></div><div class="qm-bg-preview-veil"></div><span>Votre espace, votre rythme.</span></div>
    <h3>Ambiances</h3><div class="qm-bg-presets">${Object.entries(presets).map(([key,p]) => `<button type="button" data-preset="${key}" aria-pressed="false"><i style="background:${p.color}"></i>${p.name}</button>`).join('')}</div>
    <h3>Votre photo</h3><div class="qm-bg-upload"><label class="btn" for="qm-background-file">Ajouter / remplacer une image</label><input id="qm-background-file" type="file" accept="image/jpeg,image/png,image/webp"><button type="button" class="btn ghost" data-remove>Retirer la photo</button></div>
    <p class="muted">JPG, PNG ou WebP · 25 Mo maximum. Votre image reste dans ce navigateur.</p>
    <div class="qm-bg-controls"></div>
    <p class="qm-bg-status" role="status" aria-live="polite"></p>
    <div class="qm-bg-footer"><button type="button" class="btn ghost" data-reset>Réinitialiser</button><button type="button" class="btn" data-close>Terminé</button></div>`;
  const specs = [['dim','Voile de lisibilité',0,85,1,'%'],['blur','Flou',0,20,1,' px'],['zoom','Zoom de la photo',100,180,1,'%'],['x','Position horizontale',0,100,1,'%'],['y','Position verticale',0,100,1,'%']];
  dialog.querySelector('.qm-bg-controls').innerHTML = specs.map(([key,label,min,max,step,unit]) => `<label class="qm-bg-control" for="qm-bg-${key}"><span>${label}<output id="qm-bg-value-${key}"></output></span><input id="qm-bg-${key}" type="range" min="${min}" max="${max}" step="${step}" data-setting="${key}" data-unit="${unit}"></label>`).join('');
  document.body.append(launcher, dialog);
  // Keep quiz keyboard shortcuts from handling keys inside the settings dialog.
  dialog.addEventListener('keydown', event => event.stopPropagation());
  const status = dialog.querySelector('.qm-bg-status');
  function apply() {
    const image = prefs.preset === 'photo' && prefs.image ? `url("${prefs.image}")` : presets[prefs.preset]?.color || presets.aurora.color;
    for (const el of [layer.querySelector('.qm-bg-picture'), dialog.querySelector('.qm-bg-preview-image')]) {
      el.style.backgroundImage = image;
      el.style.backgroundPosition = `${prefs.x}% ${prefs.y}%`;
      el.style.transform = `scale(${prefs.zoom / 100})`;
      el.style.transformOrigin = `${prefs.x}% ${prefs.y}%`;
      el.style.filter = `blur(${prefs.blur}px)`;
    }
    for (const el of [layer.querySelector('.qm-bg-veil'), dialog.querySelector('.qm-bg-preview-veil')]) el.style.opacity = prefs.dim / 100;
    dialog.querySelectorAll('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === prefs.preset)));
    dialog.querySelector('[data-remove]').disabled = !prefs.image;
    for (const input of dialog.querySelectorAll('[data-setting]')) {
      const key = input.dataset.setting;
      input.value = prefs[key];
      input.disabled = ['zoom','x','y'].includes(key) && prefs.preset !== 'photo';
      dialog.querySelector(`#qm-bg-value-${key}`).textContent = prefs[key] + input.dataset.unit;
    }
  }
  function persist() {
    clearTimeout(timer);
    const snapshot = { ...prefs };
    if (!database) { status.textContent = 'Aperçu actif. Le navigateur ne permet pas d’enregistrer ces réglages.'; return; }
    writing = writing.catch(() => {}).then(() => new Promise((resolve, reject) => {
      const tx = database.transaction('preferences', 'readwrite');
      tx.objectStore('preferences').put(snapshot, 'background');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    }));
    writing.then(() => { status.textContent = 'Réglages enregistrés dans ce navigateur.'; }, () => { status.textContent = 'Enregistrement impossible. Essayez une image plus petite ou libérez de l’espace.'; });
  }
  function change() { apply(); status.textContent = 'Enregistrement…'; clearTimeout(timer); timer = setTimeout(persist, 200); }
  launcher.addEventListener('click', () => { dialog.showModal(); });
  dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { persist(); dialog.close(); }));
  dialog.addEventListener('cancel', () => persist());
  dialog.addEventListener('close', () => launcher.focus());
  dialog.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { prefs.preset = b.dataset.preset; prefs.zoom = 100; change(); }));
  dialog.querySelectorAll('[data-setting]').forEach(input => input.addEventListener('input', () => { prefs[input.dataset.setting] = Number(input.value); change(); }));
  dialog.querySelector('[data-remove]').addEventListener('click', () => { uploadGeneration++; prefs.image = ''; prefs.preset = 'aurora'; prefs.zoom = 100; change(); });
  dialog.querySelector('[data-reset]').addEventListener('click', () => { uploadGeneration++; prefs = { ...defaults }; change(); });
  const fileInput = dialog.querySelector('input[type=file]');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]; fileInput.value = ''; if (!file) return;
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 25 * 1024 * 1024) { status.textContent = 'Choisissez un JPG, PNG ou WebP de moins de 25 Mo.'; return; }
    const generation = ++uploadGeneration;
    status.textContent = 'Préparation de la photo…';
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#182a44'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (generation !== uploadGeneration) return;
      prefs.image = canvas.toDataURL('image/jpeg', .87); prefs.preset = 'photo'; prefs.x = prefs.y = 50; prefs.zoom = 100;
      change();
    } catch (_) { status.textContent = 'Cette image ne peut pas être lue. Essayez un autre fichier.'; }
    finally { URL.revokeObjectURL(url); }
  });
  // A photo remains available after selecting a preset.
  const reuse = document.createElement('button'); reuse.type = 'button'; reuse.className = 'btn ghost'; reuse.textContent = 'Utiliser ma photo';
  reuse.addEventListener('click', () => { if (prefs.image) { prefs.preset = 'photo'; change(); } else status.textContent = 'Ajoutez d’abord une image.'; });
  dialog.querySelector('.qm-bg-upload').append(reuse);
  apply(); launcher.disabled = true;
  try {
    const request = indexedDB.open('QuizMasterAppearance', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('preferences');
    request.onblocked = request.onerror = () => { launcher.disabled = false; status.textContent = 'Enregistrement local indisponible : vos réglages restent temporaires.'; };
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => { database.close(); database = null; };
      const read = database.transaction('preferences').objectStore('preferences').get('background');
      read.onsuccess = () => {
        const saved = read.result;
        if (saved && typeof saved === 'object') {
          prefs.preset = presets[saved.preset] || saved.preset === 'photo' ? saved.preset : defaults.preset;
          if (typeof saved.image === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(saved.image)) prefs.image = saved.image;
          for (const [key,,min,max] of specs) prefs[key] = Number.isFinite(saved[key]) ? Math.min(max, Math.max(min, saved[key])) : defaults[key];
        }
        apply(); launcher.disabled = false;
      };
      read.onerror = () => { launcher.disabled = false; status.textContent = 'Les anciens réglages sont indisponibles.'; };
    };
  } catch (_) { launcher.disabled = false; }
  document.addEventListener('visibilitychange', () => { if (document.hidden && timer) persist(); });
})();
