(() => {
  const $ = id => document.getElementById(id);
  let token = localStorage.getItem('cc_token') || '';
  let me = null, users = [], activePeer = null, socket = null, authMode = 'login', renderedIds = new Set();
  const initials = name => String(name || '?').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase();
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtTime = t => new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const fmtBytes = n => n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`;
  function toast(message) { const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),2800); }
  async function api(url, options={}) {
    const headers = {...(options.headers||{})};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type']='application/json';
    const res = await fetch(url,{...options,headers});
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  function showAuth() { $('authView').classList.remove('hidden'); $('mainView').classList.add('hidden'); }
  function showApp() { $('authView').classList.add('hidden'); $('mainView').classList.remove('hidden'); }
  function setMode(mode) {
    authMode=mode; const register=mode==='register';
    $('loginTab').classList.toggle('active',!register); $('registerTab').classList.toggle('active',register);
    $('nameLabel').classList.toggle('hidden',!register);
    $('authTitle').textContent=register?'Join your campus.':'Welcome back.';
    $('authHint').textContent=register?'Create an account to join the student network.':'Sign in to connect with your campus community.';
    $('authSubmit').innerHTML=register?'Create account <span>→</span>':'Sign in <span>→</span>';
    $('password').autocomplete=register?'new-password':'current-password'; $('authError').textContent='';
  }
  $('loginTab').onclick=()=>setMode('login'); $('registerTab').onclick=()=>setMode('register');
  $('authForm').addEventListener('submit',async e=>{
    e.preventDefault(); $('authError').textContent=''; $('authSubmit').disabled=true;
    try {
      const payload={username:$('username').value.trim(),password:$('password').value};
      if(authMode==='register') payload.displayName=$('displayName').value.trim();
      const data=await api(`/api/${authMode}`,{method:'POST',body:JSON.stringify(payload)});
      token=data.token; me=data.user; localStorage.setItem('cc_token',token); await enterApp();
    } catch(err) {$('authError').textContent=err.message;}
    finally {$('authSubmit').disabled=false;}
  });
  $('logoutBtn').onclick=async()=>{try{await api('/api/logout',{method:'POST'});}catch{}; if(socket)socket.disconnect(); token='';me=null;localStorage.removeItem('cc_token');activePeer=null;showAuth();};
  async function enterApp() {
    showApp(); $('myName').textContent=me.displayName; $('myAvatar').textContent=initials(me.displayName); $('topAvatar').textContent=initials(me.displayName);
    await loadUsers(); connectSocket(); showChatPage();
  }
  async function loadUsers() { const d=await api('/api/users'); users=d.users; renderUsers(); $('peopleCount').textContent=users.length; }
  function renderUsers() {
    const online=socket?.connected ? users.filter(u=>u.online).length : users.filter(u=>u.online).length;
    $('onlineCount').textContent=`${online} ONLINE`;
    $('peopleList').innerHTML=users.length?users.map(u=>`<button class="person ${activePeer?.id===u.id?'active':''}" data-id="${u.id}"><span class="avatar">${esc(initials(u.displayName))}</span><span class="person-copy"><strong>${esc(u.displayName)}</strong><small>@${esc(u.username)}</small></span><i class="person-dot ${u.online?'online':''}"></i></button>`).join(''):'<p class="muted" style="padding:10px;font-size:11px">No other students yet. Create a second test account in another browser.</p>';
    $('peopleList').querySelectorAll('.person').forEach(b=>b.onclick=()=>selectPeer(b.dataset.id));
  }
  function connectSocket() {
    if(socket)socket.disconnect();
    socket=io({auth:{token}});
    socket.on('connect',()=>{loadUsers().catch(()=>{});});
    socket.on('connect_error',err=>toast(err.message||'Live connection failed.'));
    socket.on('presence:update',data=>{users=users.map(u=>({...u,online:data.users.includes(u.id)}));renderUsers();if(activePeer)updatePeerStatus();if(data.snapshot)updateMetrics(data.snapshot);});
    socket.on('monitor:update',updateMetrics);
    socket.on('message:new',msg=>{
      if(activePeer && (msg.from===activePeer.id || msg.to===activePeer.id)) appendMessage(msg);
      if(msg.from!==me.id && (!activePeer || msg.from!==activePeer.id)) toast(`New message from ${msg.sender?.displayName||'a student'}`);
    });
  }
  async function selectPeer(id) {
    activePeer=users.find(u=>u.id===id); if(!activePeer)return;
    $('emptyState').classList.add('hidden'); $('conversation').classList.remove('hidden'); $('peerName').textContent=activePeer.displayName; $('peerAvatar').textContent=initials(activePeer.displayName);
    renderedIds.clear(); $('messages').innerHTML=''; renderUsers(); updatePeerStatus();
    try {const d=await api(`/api/messages/${encodeURIComponent(id)}`); d.messages.forEach(appendMessage);}
    catch(err){toast(err.message);}
  }
  function updatePeerStatus() { if(!activePeer)return; const u=users.find(x=>x.id===activePeer.id)||activePeer; $('peerStatus').innerHTML=`<i class="status-dot" style="background:${u.online?'var(--green)':'#65718b'}"></i> ${u.online?'Online now':'Offline'}`; }
  function appendMessage(m) {
    if(renderedIds.has(m.id))return; renderedIds.add(m.id);
    const mine=m.from===me.id, sender=m.sender||users.find(u=>u.id===m.from)||{displayName:mine?me.displayName:'Student'};
    const row=document.createElement('div'); row.className=`message-row ${mine?'mine':''}`;
    let content=esc(m.text||'');
    if(m.file) content+=`<a class="file-link" href="/api/files/${encodeURIComponent(m.file.id)}" data-file="${esc(m.file.id)}">↧ ${esc(m.file.name)} <small>(${fmtBytes(m.file.size)})</small></a>`;
    row.innerHTML=`<div class="avatar">${esc(initials(sender.displayName))}</div><div class="bubble-wrap"><div class="message-meta">${mine?'You':esc(sender.displayName)} · ${fmtTime(m.createdAt)}</div><div class="bubble">${content}</div></div>`;
    row.querySelectorAll('[data-file]').forEach(a=>a.onclick=async e=>{e.preventDefault();try{const res=await fetch(a.href,{headers:{Authorization:`Bearer ${token}`}});if(!res.ok)throw new Error('Could not download file');const blob=await res.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=a.textContent.trim().split(' (')[0].replace(/^↧\s*/,'');link.click();URL.revokeObjectURL(url);}catch(err){toast(err.message);}});
    $('messages').appendChild(row); $('messages').scrollTop=$('messages').scrollHeight;
  }
  $('messageForm').addEventListener('submit',e=>{
    e.preventDefault();const text=$('messageInput').value.trim();if(!activePeer)return toast('Choose a student first.');if(!text)return;
    if(!socket?.connected)return toast('Live connection is not ready. Try again.');
    socket.emit('message:send',{to:activePeer.id,text},res=>{if(res?.error)toast(res.error);else $('messageInput').value='';});
  });
  $('fileInput').addEventListener('change',async()=>{
    const file=$('fileInput').files[0];$('fileInput').value='';if(!file)return;if(!activePeer)return toast('Choose a student first.');
    if(file.size>20*1024*1024)return toast('File must be 20 MB or smaller.');
    const form=new FormData();form.append('file',file);
    try{await api(`/api/files/${encodeURIComponent(activePeer.id)}`,{method:'POST',body:form});toast('File shared successfully.');}
    catch(err){toast(err.message);}
  });
  function showChatPage(){ $('chatView').classList.remove('hidden');$('monitorView').classList.add('hidden');$('chatsNav').classList.add('selected');$('monitorNav').classList.remove('selected');$('pageEyebrow').textContent='MESSAGES';$('pageTitle').textContent=activePeer?activePeer.displayName:'Your conversations';}
  $('chatsNav').onclick=showChatPage;
  $('monitorNav').onclick=async()=>{ $('chatView').classList.add('hidden');$('monitorView').classList.remove('hidden');$('monitorNav').classList.add('selected');$('chatsNav').classList.remove('selected');$('pageEyebrow').textContent='TELEMETRY';$('pageTitle').textContent='Network monitor';try{updateMetrics(await api('/api/monitor'));}catch(e){toast(e.message);}};
  function updateMetrics(s){if(!s)return;$('mOnline').textContent=s.onlineUsers??0;$('mConnections').textContent=s.activeConnections??0;$('mMessages').textContent=s.messages??0;$('mFiles').textContent=s.files??0;$('mBytes').textContent=`${fmtBytes(s.bytesUploaded||0)} transferred`;}
  async function boot(){
    if(!token){showAuth();return;}
    try{const d=await api('/api/me');me=d.user;await enterApp();}
    catch{token='';localStorage.removeItem('cc_token');showAuth();}
  }
  setMode('login'); boot();
})();