/* Local playlist and audio focus player. Audio files stay in this browser. */
(() => {
  'use strict';
  const button = document.createElement('button');
  button.id = 'qm-music-button'; button.type = 'button'; button.textContent = '🎵';
  button.title = 'Musique et mode concentration'; button.setAttribute('aria-label', button.title);
  const dialog = document.createElement('dialog'); dialog.id = 'qm-music-dialog';
  dialog.setAttribute('aria-label', 'Lecteur de musique pour réviser');
  dialog.innerHTML = '<div class="qm-music-shell"><header><div><span class="qm-music-kicker">STUDIO DE CONCENTRATION</span><h2>🎧 Ma musique</h2></div><button type="button" class="qm-music-close" aria-label="Fermer">×</button></header><div class="qm-music-layout"><aside><div class="qm-music-list-head"><b>Mes playlists</b><button type="button" class="qm-music-add-playlist">＋</button></div><div class="qm-music-playlists"></div><p class="qm-music-empty">Crée une playlist pour commencer.</p></aside><main><div class="qm-music-track-head"><div><span class="qm-music-kicker">EN COURS</span><h3 class="qm-music-title">Choisis une piste</h3></div><button type="button" class="qm-music-focus">🎯 Mode concentration</button></div><div class="qm-music-add"><form class="qm-music-url"><input type="url" placeholder="https://… lien audio" aria-label="URL audio"><button class="btn">Ajouter un lien</button></form><label class="btn ghost qm-music-file-label">＋ Ajouter un fichier audio<input class="qm-music-file" type="file" accept="audio/*" hidden></label><small>MP3, M4A, WAV, OGG… Fichier local conservé dans ce navigateur.</small></div><div class="qm-music-tracks"></div><audio controls preload="metadata"></audio></main></div></div>';
  document.body.append(button, dialog);
  const filePicker=dialog.querySelector('.qm-music-file');
  filePicker.accept='audio/*,video/*';filePicker.multiple=true;
  dialog.querySelector('.qm-music-file-label').firstChild.textContent='＋ Importer plusieurs fichiers audio / vidéo';
  const urlField=dialog.querySelector('.qm-music-url input');
  const urlArea=document.createElement('textarea');urlArea.rows=3;urlArea.placeholder='Colle plusieurs liens audio directs, un par ligne';urlArea.setAttribute('aria-label','Liens audio directs, un par ligne');urlField.replaceWith(urlArea);
  let db, playlists=[], activeId=null, currentTrackId=null, objectUrl=null;
  const $ = s => dialog.querySelector(s);
  const esc = s => String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function openDB(){ return new Promise((resolve,reject)=>{
    const req=indexedDB.open('QuizMasterMusic',1);
    req.onupgradeneeded=()=>{const d=req.result;d.createObjectStore('playlists');d.createObjectStore('audio');};
    req.onsuccess=()=>{db=req.result;resolve(db);};req.onerror=()=>reject(req.error);
  }); }
  function req(store,method,...args){return new Promise((resolve,reject)=>{const tx=db.transaction(store,method==='put'||method==='delete'?'readwrite':'readonly');const r=tx.objectStore(store)[method](...args);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  const active=()=>playlists.find(p=>p.id===activeId);
  async function save(){if(db)await req('playlists','put',playlists, 'all');}
  function paint(){
    $('.qm-music-playlists').innerHTML=playlists.map(p=>`<button type="button" class="qm-music-playlist ${p.id===activeId?'active':''}" data-list="${esc(p.id)}">♫ ${esc(p.name)} <span>${p.tracks.length}</span></button>`).join('');
    $('.qm-music-empty').hidden=playlists.length>0;
    const list=active(); $('.qm-music-title').textContent=list?.name||'Choisis une piste';
    $('.qm-music-tracks').innerHTML=(list?.tracks||[]).map((t,i)=>`<div class="qm-music-track ${t.id===currentTrackId?'playing':''}"><button type="button" class="qm-music-track-play" data-track="${esc(t.id)}" aria-label="Lire ${esc(t.name)}">${t.id===currentTrackId?'▶':'▷'}</button><span>${esc(t.name)}</span><small>${t.source==='file'?'Appareil':'Lien web'}</small><button class="qm-music-track-delete" type="button" data-delete="${esc(t.id)}" aria-label="Supprimer ${esc(t.name)}">×</button></div>`).join('')||'<p class="qm-music-no-tracks">Ajoute un fichier audio ou un lien à cette playlist.</p>';
  }
  function youtubeId(value){try{const u=new URL(value);if(u.hostname==='youtu.be')return u.pathname.split('/').filter(Boolean)[0]||null;if(!/(^|\.)youtube\.com$/.test(u.hostname))return null;return u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1]||null;}catch(_){return null;}}
  async function play(track){
    try{
      if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
      const videoId=track.source==='url'?youtubeId(track.url):null;
      let src=track.url;
      if(videoId||/open\.spotify\.com/i.test(track.url||'')){alert('Ce lien ne fournit pas un fichier audio. Téléverse une vidéo locale pour en extraire uniquement le son, ou ajoute un lien direct vers un fichier audio.');return;}
      const frame=$('.qm-music-youtube');if(frame){frame.src='';frame.remove();}$('audio').hidden=false;
      if(track.source==='file'){const blob=await req('audio','get',track.id);if(!blob)throw new Error('Fichier introuvable');objectUrl=URL.createObjectURL(blob);src=objectUrl;}
      const audio=$('audio');audio.src=src;await audio.play();currentTrackId=track.id;paint();
    }catch(e){alert('Impossible de lire cette piste. Vérifie le fichier ou le lien audio.');}
  }
  async function load(){
    try{await openDB();playlists=await req('playlists','get','all')||[];activeId=playlists[0]?.id||null;paint();}
    catch(e){$('.qm-music-empty').textContent='Stockage audio indisponible dans ce navigateur.';$('.qm-music-empty').hidden=false;}
  }
  async function extractVideoAudio(file){
    if(!window.MediaRecorder||!HTMLMediaElement.prototype.captureStream)throw new Error('Extraction audio non prise en charge par ce navigateur.');
    const url=URL.createObjectURL(file),video=document.createElement('video');video.src=url;video.preload='auto';video.volume=0;video.playsInline=true;
    try {
      await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Vidéo illisible'));});
      const stream=video.captureStream();const tracks=stream.getAudioTracks();if(!tracks.length)throw new Error('Cette vidéo ne contient pas de piste audio.');
      const audioStream=new MediaStream(tracks);const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
      const recorder=new MediaRecorder(audioStream,mime?{mimeType:mime}:undefined),chunks=[];
      const result=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onerror=()=>reject(recorder.error||new Error('Extraction impossible'));recorder.onstop=()=>resolve(new Blob(chunks,{type:recorder.mimeType||'audio/webm'}));});
      recorder.start(1000);await video.play();await new Promise(resolve=>{video.onended=resolve;});recorder.stop();return await result;
    } finally {video.pause();video.removeAttribute('src');URL.revokeObjectURL(url);}
  }
  button.onclick=()=>{dialog.showModal();document.body.classList.add('qm-music-open');load();};
  const close=()=>{dialog.close();document.body.classList.remove('qm-music-open');document.body.classList.remove('qm-music-focus');};
  $('.qm-music-close').onclick=close;dialog.addEventListener('close',()=>{document.body.classList.remove('qm-music-open','qm-music-focus');button.focus();});
  dialog.addEventListener('close',()=>{const frame=$('.qm-music-youtube');if(frame)frame.src='';});
  $('.qm-music-add-playlist').onclick=()=>{
    if(!db)return;
    const panel=document.createElement('form');panel.className='qm-music-create';
    panel.innerHTML='<label>Créer une playlist</label><input maxlength="60" placeholder="Ex. Révisions de pharmacie" required><div><button type="button" class="btn ghost">Annuler</button><button class="btn">Créer</button></div>';
    dialog.querySelector('aside').insertBefore(panel,dialog.querySelector('.qm-music-playlists'));
    panel.querySelector('input').focus();
    panel.querySelector('.btn.ghost').onclick=()=>panel.remove();
    panel.onsubmit=async e=>{e.preventDefault();const name=panel.querySelector('input').value.trim();if(!name)return;const p={id:crypto.randomUUID(),name,tracks:[]};playlists.push(p);activeId=p.id;await save();panel.remove();paint();};
  };
  $('.qm-music-focus').onclick=()=>{document.body.classList.toggle('qm-music-focus');$('.qm-music-focus').textContent=document.body.classList.contains('qm-music-focus')?'✕ Quitter le mode concentration':'🎯 Mode concentration';};
  $('.qm-music-url').onsubmit=async e=>{e.preventDefault();const list=active();if(!list)return alert('Crée ou choisis une playlist.');const field=$('.qm-music-url textarea');const urls=field.value.split(/\s+/).map(s=>s.trim()).filter(Boolean);if(!urls.length)return;const unsupported=urls.find(raw=>youtubeId(raw)||/open\.spotify\.com/i.test(raw));if(unsupported)return alert('Les liens YouTube ou Spotify ne donnent pas accès à un fichier audio. Utilise un fichier audio téléchargé que tu as le droit d’utiliser, ou un lien direct vers un fichier audio (MP3, M4A, WAV, OGG).');const accepted=[];for(const raw of urls){try{const u=new URL(raw);if(!['https:','http:'].includes(u.protocol))continue;accepted.push({id:crypto.randomUUID(),name:decodeURIComponent(u.pathname.split('/').pop()||u.hostname),url:u.href,source:'url'});}catch(_){}}if(!accepted.length)return alert('Aucun lien audio direct valide détecté.');list.tracks.push(...accepted);field.value='';await save();paint();};
  $('.qm-music-file').onchange=async e=>{const files=Array.from(e.target.files||[]);e.target.value='';const list=active();if(!files.length)return;if(!list)return alert('Crée ou choisis une playlist.');const status=$('.qm-music-no-tracks');const added=[];for(let i=0;i<files.length;i++){const file=files[i];try{if(file.size>150*1024*1024)throw new Error('Fichier supérieur à 150 Mo.');let blob=file,name=file.name;if(file.type.startsWith('video/')){alert(`Extraction audio ${i+1}/${files.length} : ${file.name}. Elle se fait à la vitesse réelle de la vidéo.`);blob=await extractVideoAudio(file);name=file.name.replace(/\.[^.]+$/,'')+'.webm';}else if(!file.type.startsWith('audio/'))throw new Error('Format audio/vidéo non reconnu.');const id=crypto.randomUUID();await req('audio','put',blob,id);added.push({id,name,source:'file'});}catch(err){alert(`${file.name} : ${err.message||'import impossible'}`);}}if(added.length){list.tracks.push(...added);await save();paint();}};
  dialog.addEventListener('click',async e=>{
    const listBtn=e.target.closest('[data-list]');if(listBtn){activeId=listBtn.dataset.list;paint();return;}
    const playBtn=e.target.closest('[data-track]');if(playBtn){const t=active()?.tracks.find(t=>t.id===playBtn.dataset.track);if(t)play(t);return;}
    const del=e.target.closest('[data-delete]');if(del){const list=active(),track=list?.tracks.find(t=>t.id===del.dataset.delete);if(!track||!confirm(`Retirer « ${track.name} » de la playlist ?`))return;list.tracks=list.tracks.filter(t=>t.id!==track.id);if(track.source==='file')await req('audio','delete',track.id);if(currentTrackId===track.id){$('audio').pause();$('audio').removeAttribute('src');currentTrackId=null;}await save();paint();}
  });
  $('audio').onended=()=>{const l=active(),i=l?.tracks.findIndex(t=>t.id===currentTrackId)??-1;if(l?.tracks[i+1])play(l.tracks[i+1]);};
  window.addEventListener('beforeunload',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);});
})();
