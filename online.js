/* HunterDASH — own-phone online mode.
   One phone hosts the room (it holds the game); everyone else connects to it with PeerJS.
   Answers go to the Dasher's phone; votes are said out loud and tapped in by the Dasher. */
"use strict";
const OL = (() => {
  const PREFIX = "baulderdash-room-";
  const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const LS_ME = "bd_me", LS_SESS = "bd_sess";
  try{ localStorage.removeItem("bd_host"); localStorage.removeItem("bd_client"); }catch(e){}
  const ls = {
    get(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } },
    set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} },
    del(k){ try{ localStorage.removeItem(k); }catch(e){} }
  };
  let me = ls.get(LS_ME) || { id: uid() + uid(), name: "" };
  ls.set(LS_ME, me);

  let peer = null, isHost = false, code = null, O = null, V = null, conn = null;
  const conns = {};            // host: playerId -> DataConnection
  let ui = "join";             // local screen before a room view exists
  let status = "", retryTimer = null, overlay = null, editing = false, customOpen = false, flash = "";
  const drafts = {};
  const peerOpts = () => Object.assign({ debug: 0 }, window.PEER_OPTS || {});
  const genCode = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
  const peerId = (c, ep) => PREFIX + c.toLowerCase() + (ep ? "-" + ep : "");
  const inviteLink = () => location.href.split(/[?#]/)[0] + "?join=" + code;

  /* =================== HOST: game logic =================== */
  const dasherP = () => O.players[O.dasher];
  const writers = () => O.players.filter((p, i) => i !== O.dasher).map(p => p.id);
  const pname = id => (O.players.find(p => p.id === id) || {}).name || "?";

  function draw(force){
    O.used = (O.used || []).filter(x => typeof x === "string");
    if(!O.cats || !O.cats.length) O.cats = CAT_KEYS.slice();
    return drawFrom(O.used, O.cats, force);
  }
  function newRound(){
    O.round++;
    const c = draw();
    O.r = { cat: c.cat, word: c.word, def: c.def, bluffs: {}, correct: {}, options: [], voters: [], votes: {}, points: [] };
    O.phase = "dasher";
  }
  function uniqueName(n){
    n = String(n || "Player").trim().slice(0, 20) || "Player";
    let out = n, k = 2;
    while(O.players.some(p => p.name.toLowerCase() === out.toLowerCase())) out = n + " " + (k++);
    return out;
  }
  function score(){
    const r = O.r, pts = {}, lines = [];
    const add = (id, n, why) => { pts[id] = (pts[id] || 0) + n; lines.push({ id, n, why }); };
    writers().forEach(id => { if(r.correct[id]) add(id, 3, "knew the real answer"); });
    const realIdx = r.options.findIndex(o => o.owner === null);
    let anyReal = false, anyVote = false;
    r.voters.forEach(v => {
      const i = r.votes[v];
      if(i == null || i < 0) return;
      anyVote = true;
      if(i === realIdx){ anyReal = true; add(v, 2, "picked the real one"); }
      else if(r.options[i] && r.options[i].owner){ add(r.options[i].owner, 1, "fooled " + pname(v)); }
    });
    if(anyVote && !anyReal) add(dasherP().id, 3, "stumped everyone (Dasher bonus)");
    O.players.forEach(p => p.score += (pts[p.id] || 0));
    O.last = pts; r.points = lines;
  }
  function winners(){
    const max = Math.max(...O.players.map(p => p.score));
    return max >= O.target ? O.players.filter(p => p.score === max).map(p => p.id) : [];
  }

  // Next Dasher, skipping anyone who isn't connected right now.
  function advanceDasher(){
    const n = O.players.length;
    for(let k = 1; k <= n; k++){
      const i = (O.dasher + k) % n, id = O.players[i].id;
      if(id === O.hostId || (conns[id] && conns[id].open) || k === n){ O.dasher = i; return; }
    }
  }
  function hostAct(from, m){
    const r = O.r;
    const isD = r && dasherP() && dasherP().id === from;
    const host = from === me.id;
    switch(m.t){
      case "target": if(host && O.phase === "lobby") O.target = +m.v || 25; break;
      case "start":
        if(host && O.phase === "lobby" && O.players.length >= 3){
          O.players.forEach(p => p.score = 0); O.last = {}; O.round = 0; O.dasher = 0; newRound();
        } break;
      case "kick":
        if(host && O.phase === "lobby" && m.id !== me.id){
          const c = conns[m.id]; if(c){ try{ c.send({ t: "kicked" }); }catch(e){} setTimeout(() => { try{ c.close(); }catch(e){} }, 300); delete conns[m.id]; }
          O.players = O.players.filter(p => p.id !== m.id);
        } break;
      case "redraw": if(isD && O.phase === "dasher"){ const c = draw(r.cat); r.cat = c.cat; r.word = c.word; r.def = c.def; } break;
      case "pickcat": if(isD && O.phase === "dasher" && CATS[m.c]){ const c = draw(m.c); r.cat = c.cat; r.word = c.word; r.def = c.def; } break;
      case "togglecat": if(host && O.phase === "lobby" && CATS[m.c]){ if(!O.cats) O.cats = CAT_KEYS.slice(); toggleCat(O.cats, m.c); } break;
      case "custom":
        if(isD && O.phase === "dasher" && m.word && m.def){ r.word = String(m.word).trim().slice(0, 120); r.def = tidy(m.def).slice(0, 400); } break;
      case "begin":
        if(isD && O.phase === "dasher"){ if(m.def && String(m.def).trim()) r.def = tidy(m.def).slice(0, 400); O.phase = "writing"; } break;
      case "bluff":
        if(O.phase === "writing" && !isD && O.players.some(p => p.id === from)){
          const t = tidy(m.text).slice(0, 300); if(t) r.bluffs[from] = t;
        } break;
      case "correct": if(isD && O.phase === "writing"){ if(r.correct[m.id]) delete r.correct[m.id]; else r.correct[m.id] = true; } break;
      case "shuffle":
        if(isD && O.phase === "writing"){
          const ws = writers();
          const opts = [{ text: r.def, owner: null }];
          ws.forEach(id => { if(r.bluffs[id] && !r.correct[id]) opts.push({ text: r.bluffs[id], owner: id }); });
          r.options = shuffle(opts);
          r.voters = ws.filter(id => !r.correct[id]);
          r.votes = {};
          O.phase = "reading";
        } break;
      case "unshuffle": if(isD && O.phase === "reading"){ O.phase = "writing"; } break;
      case "vote":
        if(isD && O.phase === "reading" && r.voters.includes(m.voter)){
          const i = +m.idx;
          if(i === -1 || (r.options[i] && r.options[i].owner !== m.voter)) r.votes[m.voter] = i;
        } break;
      case "score":
        if(isD && O.phase === "reading" && r.voters.every(v => r.votes[v] != null)){ score(); O.phase = "reveal"; } break;
      case "next":
        if((isD || host) && O.phase === "reveal"){
          if(winners().length) O.phase = "winner";
          else { advanceDasher(); newRound(); }
        } break;
      case "skipdasher":
        if(host && ["dasher", "writing", "reading"].includes(O.phase)){ O.round--; advanceDasher(); newRound(); } break;
      case "lobby": if(host){ O.phase = "lobby"; O.r = null; O.players.forEach(p => p.score = 0); O.last = {}; } break;
      case "rematch":
        if(host && O.phase === "winner"){ O.players.forEach(p => p.score = 0); O.last = {}; O.round = 0; O.dasher = 0; newRound(); } break;
      default: return;
    }
    broadcast();
  }

  function viewFor(id){
    const r = O.r;
    const isD = !!(r && dasherP() && dasherP().id === id);
    const pub = O.phase === "reveal" || O.phase === "winner";
    const v = {
      code: O.code, me: id, hostId: O.hostId, isHost: id === O.hostId, phase: O.phase, target: O.target, round: O.round,
      players: O.players.map(p => ({ id: p.id, name: p.name, score: p.score, online: p.id === O.hostId || !!(conns[p.id] && conns[p.id].open) })),
      cats: O.cats || CAT_KEYS.slice(), cat: r ? r.cat : null,
      dasherId: r ? dasherP().id : null, isDasher: isD, last: O.last || {}, winners: O.phase === "winner" ? winners() : []
    };
    if(r){
      const ws = writers();
      v.word = (O.phase !== "dasher" || isD) ? r.word : null;
      v.def = (isD || pub) ? r.def : null;
      v.writers = ws;
      v.submitted = ws.filter(w => r.bluffs[w]);
      v.myBluff = r.bluffs[id] || null;
      if(isD && O.phase === "writing") v.bluffs = ws.map(w => ({ id: w, text: r.bluffs[w] || null, correct: !!r.correct[w] }));
      if(O.phase === "reading" || pub){
        v.options = r.options.map(o => ({ text: o.text, owner: (pub || isD) ? o.owner : undefined, mine: o.owner === id }));
      }
      if(O.phase === "reading" && isD){ v.voters = r.voters; v.votes = r.votes; }
      if(pub){
        v.voters = r.voters; v.votes = r.votes; v.points = r.points;
        v.knew = ws.filter(w => r.correct[w]).map(w => ({ id: w, text: r.bluffs[w] || "" }));
      }
    }
    return v;
  }

  /* =================== CONNECTIONS ===================
     Every phone gets a full backup copy of the game ("snap") with each update.
     If the host disappears, the next player in line takes over as host on a new
     room id (epoch + 1). Anyone who comes back (including the old host) finds the
     newest host and rejoins as a player. */
  const HEARTBEAT = 3000, CLIENT_SILENCE = 10000, HOST_SILENCE = 14000, TAKEOVER_AFTER = 8000, TAKEOVER_STEP = 6000;
  let epoch = 0, snap = null, lastMsg = 0, lostSince = 0, tryAlt = false, takingOver = false;
  let probePeer = null, probing = false, lastProbe = 0, hbTimer = null;
  const visible = () => document.visibilityState === "visible";

  function saveSess(){
    if(!code) return;
    ls.set(LS_SESS, { code, epoch, snap: isHost ? O : snap, at: Date.now() });
  }

  function broadcast(){
    if(!isHost || !O) return;
    saveSess();
    Object.keys(conns).forEach(pid => {
      const c = conns[pid];
      if(c && c.open){ try{ c.send({ t: "state", v: viewFor(pid), snap: O, ep: O.epoch }); }catch(e){} }
    });
    V = viewFor(me.id);
    render();
  }

  function hostMsg(c, m){
    if(!m || typeof m !== "object") return;
    c.lastSeen = Date.now();
    if(m.t === "pong") return;
    if(m.t === "hello"){
      if(typeof m.id !== "string" || !m.id) return;
      const old = conns[m.id];
      if(old && old !== c){ try{ old.close(); }catch(e){} }
      conns[m.id] = c; c.pid = m.id;
      if(!O.players.some(p => p.id === m.id)){
        if(m.id === me.id) return;
        O.players.push({ id: m.id, name: uniqueName(m.name), score: 0 });
      }
      broadcast();
      return;
    }
    if(m.t === "bye"){
      if(c.pid && conns[c.pid] === c){
        delete conns[c.pid];
        if(O.phase === "lobby") O.players = O.players.filter(p => p.id !== c.pid);
        broadcast();
      }
      return;
    }
    if(c.pid && conns[c.pid] === c) hostAct(c.pid, m);
  }

  function hostBeat(){
    if(!isHost || !O) return;
    const now = Date.now(); let changed = false;
    Object.keys(conns).forEach(pid => {
      const c = conns[pid];
      if(!c.open || now - (c.lastSeen || now) > HOST_SILENCE){ try{ c.close(); }catch(e){} delete conns[pid]; changed = true; }
      else { try{ c.send({ t: "ping" }); }catch(e){} }
    });
    if(changed) broadcast();
    // make sure nobody else took over while we weren't looking
    if(visible() && now - lastProbe > 15000) probeNewer();
    if(peer && !peer.destroyed && peer.disconnected){ try{ peer.reconnect(); }catch(e){} }
  }

  function clientBeat(){
    if(isHost || !code) return;
    const now = Date.now();
    if(!visible()) return;
    const live = conn && conn.open && now - lastMsg < CLIENT_SILENCE;
    if(live){ lostSince = 0; return; }
    if(!lostSince) lostSince = now;
    if(conn && conn.open && now - lastMsg >= CLIENT_SILENCE){ try{ conn.close(); }catch(e){} conn = null; }
    status = snap ? "Lost the host — reconnecting…" : status;
    render();
    // has the host been gone long enough that someone should take over?
    if(snap && !takingOver){
      const r = successorRank();
      if(r >= 0 && now - lostSince > TAKEOVER_AFTER + r * TAKEOVER_STEP) takeOver();
    }
  }

  function successorRank(){
    if(!snap || !snap.players) return -1;
    const online = id => !V || !V.players || (V.players.find(p => p.id === id) || {}).online;
    const others = snap.players.filter(p => p.id !== snap.hostId);
    const order = others.filter(p => online(p.id)).concat(others.filter(p => !online(p.id)));
    return order.findIndex(p => p.id === me.id);
  }

  function startBeat(){ clearInterval(hbTimer); hbTimer = setInterval(() => { isHost ? hostBeat() : clientBeat(); }, HEARTBEAT); }

  /* --- host side --- */
  function openHostPeer(mode, tries){
    // mode: "new" (fresh room), "resume" (reopening my own room), "takeover" (replacing a missing host)
    tries = tries || 0;
    if(peer){ try{ peer.destroy(); }catch(e){} }
    peer = null;
    status = mode === "new" ? "Creating room…" : mode === "takeover" ? "The host left — you're taking over the room…" : "Reopening room…";
    render();
    if(typeof Peer === "undefined"){ status = "Couldn't load the connection library. Check your internet and reload."; render(); return; }
    const p = new Peer(peerId(code, O.epoch), peerOpts());
    peer = p;
    p.on("open", () => {
      if(peer !== p) return;
      takingOver = false; epoch = O.epoch;
      status = mode === "takeover" ? "" : "";
      if(mode === "takeover") flash = "The host left, so your phone is running the room now. Keep this page open!";
      broadcast(); startBeat();
    });
    p.on("connection", c => {
      c.lastSeen = Date.now();
      c.on("data", m => hostMsg(c, m));
      c.on("close", () => { if(c.pid && conns[c.pid] === c){ delete conns[c.pid]; broadcast(); } });
      c.on("error", () => {});
    });
    p.on("disconnected", () => {
      if(peer !== p) return;
      setTimeout(() => { if(peer === p && !p.destroyed && p.disconnected){ try{ p.reconnect(); }catch(e){} } }, 1500);
    });
    p.on("error", e => {
      if(peer !== p) return;
      if(e.type === "unavailable-id"){
        if(mode === "new" && O.phase === "lobby" && O.round === 0){ code = genCode(); O.code = code; openHostPeer("new"); }
        else if(mode === "takeover"){ becomeClient(O.epoch, "Someone else took over the room — joining them…"); }
        else if(tries < 20){ status = "Reopening room… (the old connection is still closing)"; render(); setTimeout(() => { if(isHost) openHostPeer("resume", tries + 1); }, 3000); }
        else { status = "Couldn't reopen the room. Try again in a minute."; render(); }
      } else if(["network", "server-error", "socket-error", "socket-closed"].includes(e.type)){
        status = "Connection problem — retrying…"; render();
        setTimeout(() => { if(peer === p && !p.destroyed){ if(p.disconnected){ try{ p.reconnect(); }catch(x){} } } else if(isHost) openHostPeer("resume"); }, 3000);
      }
    });
  }

  // Look for a newer host (epoch + 1). found -> we become a player in that room.
  function probeNewer(done){
    if(probing || !code || typeof Peer === "undefined"){ if(done) done(false); return; }
    probing = true; lastProbe = Date.now();
    const target = peerId(code, (isHost ? O.epoch : epoch) + 1);
    let finished = false;
    const finish = found => {
      if(finished) return; finished = true; probing = false;
      if(found && isHost) becomeClient((O.epoch || 0) + 1, "Someone else is running the room now — rejoining as a player…");
      if(done) done(found);
    };
    const go = () => {
      const c = probePeer.connect(target, { reliable: true });
      c.on("open", () => { try{ c.close(); }catch(e){} finish(true); });
      setTimeout(() => finish(false), 5000);
    };
    if(probePeer && !probePeer.destroyed && probePeer.open) go();
    else {
      if(probePeer){ try{ probePeer.destroy(); }catch(e){} }
      probePeer = new Peer(peerOpts());
      probePeer.on("open", go);
      probePeer.on("error", e => { if(e.type === "peer-unavailable") finish(false); else finish(false); });
    }
  }

  function takeOver(){
    takingOver = true;
    O = JSON.parse(JSON.stringify(snap));
    O.epoch = (snap.epoch || 0) + 1;
    O.hostId = me.id;
    isHost = true;
    if(conn){ try{ conn.close(); }catch(e){} conn = null; }
    if(peer){ try{ peer.destroy(); }catch(e){} peer = null; }
    Object.keys(conns).forEach(k => delete conns[k]);
    openHostPeer("takeover");
  }

  function becomeClient(ep, msg){
    isHost = false; takingOver = false;
    snap = O || snap; O = null;
    Object.keys(conns).forEach(k => { try{ conns[k].close(); }catch(e){} delete conns[k]; });
    if(peer){ try{ peer.destroy(); }catch(e){} peer = null; }
    epoch = ep; lostSince = 0; status = msg || "";
    saveSess(); render();
    connectClient(); startBeat();
  }

  /* --- player side --- */
  function scheduleRetry(){
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if(!isHost && code && !(conn && conn.open)) connectClient(); }, 2500);
  }
  function connectClient(){
    if(isHost) return;
    if(typeof Peer === "undefined"){ status = "Couldn't load the connection library. Check your internet and reload."; render(); return; }
    if(peer && peer.destroyed) peer = null;
    if(!peer){
      const p = new Peer(peerOpts());
      peer = p;
      p.on("open", () => { if(peer === p) dial(); });
      p.on("disconnected", () => { setTimeout(() => { if(peer === p && !p.destroyed && p.disconnected){ try{ p.reconnect(); }catch(e){} } }, 1000); });
      p.on("error", e => {
        if(peer !== p) return;
        if(e.type === "peer-unavailable"){
          tryAlt = !tryAlt;   // alternate between the room we know and a possible newer one
          if(!snap && !V) status = `Can't find room ${code}. Check the code, and make sure the host has the game open.`;
          else status = "Lost the host — reconnecting…";
        } else status = "Connection trouble — retrying…";
        render(); scheduleRetry();
      });
    } else if(peer.open) dial();
    else if(peer.disconnected){ try{ peer.reconnect(); }catch(e){} }
  }
  function dial(){
    if(isHost) return;
    if(conn){ try{ conn.close(); }catch(e){} }
    const target = tryAlt ? epoch + 1 : epoch;
    const c = peer.connect(peerId(code, target), { reliable: true });
    conn = c;
    c.on("open", () => {
      if(conn !== c) return;
      lastMsg = Date.now(); lostSince = 0; status = "";
      if(target !== epoch){ epoch = target; }
      c.send({ t: "hello", id: me.id, name: me.name }); render();
    });
    c.on("data", m => {
      if(!m || conn !== c) return;
      lastMsg = Date.now(); lostSince = 0;
      if(m.t === "ping"){ try{ c.send({ t: "pong" }); }catch(e){} return; }
      if(m.t === "state"){
        V = m.v; if(m.snap) snap = m.snap; if(typeof m.ep === "number") epoch = m.ep;
        if(status) status = "";
        saveSess(); render();
      }
      if(m.t === "kicked"){ leave(true); flash = "You were removed from the room."; renderMain(); }
      if(m.t === "closed"){ leave(true); flash = "The host closed the room."; renderMain(); }
    });
    c.on("close", () => { if(conn === c){ conn = null; if(!lostSince) lostSince = Date.now(); status = "Lost connection — reconnecting…"; render(); scheduleRetry(); } });
    c.on("error", () => { scheduleRetry(); });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if(conn === c && !c.open){ tryAlt = !tryAlt; connectClient(); } }, 6000);
  }

  function send(m){
    if(isHost) hostAct(me.id, m);
    else if(conn && conn.open) conn.send(m);
    else { status = "Not connected — reconnecting…"; render(); connectClient(); }
  }

  function leave(silent){
    clearTimeout(retryTimer); clearInterval(hbTimer);
    if(isHost) Object.values(conns).forEach(c => { try{ c.send({ t: "closed" }); }catch(e){} });
    else if(conn && conn.open){ try{ conn.send({ t: "bye" }); }catch(e){} }
    const p = peer, pp = probePeer;
    setTimeout(() => { [p, pp].forEach(x => { if(x){ try{ x.destroy(); }catch(e){} } }); }, 400);
    peer = null; probePeer = null; conn = null; V = null; O = null; snap = null; code = null; status = ""; overlay = null; epoch = 0;
    Object.keys(conns).forEach(k => delete conns[k]);
    ls.del(LS_SESS);
    isHost = false; takingOver = false; lostSince = 0;
    S.screen = "home"; save(); render();
    if(!silent) window.scrollTo(0, 0);
  }

  // Coming back to the page: reconnect right away.
  function onReturn(){
    if(!visible() || !code) return;
    if(isHost){
      probeNewer(found => {
        if(found || !isHost) return;
        if(!peer || peer.destroyed) openHostPeer("resume");
        else if(peer.disconnected){ try{ peer.reconnect(); }catch(e){} }
      });
    } else {
      lostSince = Date.now();
      if(!(conn && conn.open && Date.now() - lastMsg < CLIENT_SILENCE)){ if(peer && peer.disconnected){ try{ peer.reconnect(); }catch(e){} } connectClient(); }
    }
  }
  document.addEventListener("visibilitychange", onReturn);
  window.addEventListener("pageshow", onReturn);
  window.addEventListener("online", onReturn);

  // Resume a saved session (after a reload, or from the home screen).
  function resume(){
    const s = ls.get(LS_SESS); if(!s || !s.code) return false;
    code = s.code; epoch = s.epoch || 0; snap = s.snap || null; V = null; status = "Reconnecting…";
    S.screen = "online"; save();
    if(snap && snap.hostId === me.id){
      // I was the host. If nobody took over while I was gone, reopen my room.
      O = snap; isHost = true; V = viewFor(me.id); render();
      probeNewer(found => { if(!found && isHost) openHostPeer("resume"); });
      startBeat();
    } else {
      isHost = false; render(); connectClient(); startBeat();
    }
    return true;
  }

  /* =================== UI =================== */
  const nmV = id => ((V && V.players.find(p => p.id === id)) || {}).name || "?";
  const banner = () => (status ? `<div class="card" style="background:#ff6b6b;color:#3a0a0a;padding:12px 14px;font-weight:600">${esc(status)}</div>` : "")
    + (code && flash && isHost && V && V.phase !== "lobby" ? `<div class="card" style="background:var(--teal);color:#06302c;padding:12px 14px;font-weight:600">${esc(flash)} <button class="link" style="display:inline;padding:0 4px;color:#06302c" data-ol="dismiss">OK</button></div>` : "");
  const bar = () => `<div class="bar"><span class="meta">Room <b>${esc(code)}</b>${V && V.round ? " · Round " + V.round : ""}</span><button class="iconbtn" data-ol="menu" aria-label="Menu">☰</button></div>`;
  const val = (id, def) => esc(drafts[id] != null ? drafts[id] : (def || ""));

  function scoreList(showDelta){
    const top = Math.max(0, ...V.players.map(p => p.score));
    return V.players.slice().sort((a, b) => b.score - a.score).map((p, i) => `<div class="score ${p.score === top && top > 0 ? "lead" : ""}">
      <span class="pos">${i + 1}</span>
      <div style="flex:1"><div class="nm">${esc(p.name)}${p.id === V.me ? " (you)" : ""}</div><div class="track"><i style="width:${Math.min(100, p.score / V.target * 100)}%"></i></div></div>
      ${showDelta ? `<span class="d">${V.last[p.id] ? "+" + V.last[p.id] : ""}</span>` : ""}
      <span class="pts">${p.score}</span></div>`).join("");
  }
  const dot = on => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${on ? "var(--teal)" : "rgba(255,255,255,.25)"};margin-right:4px"></span>`;

  const S_ = {};
  S_.hostname = () => `<div class="screen">
    <div class="bar"><button class="iconbtn" data-ol="home">‹</button><span class="meta">Host a game</span><span style="width:40px"></span></div>
    <h1>Host a game</h1>
    <p class="sub">Everyone else joins with a link or room code. If you step away, the next player's phone takes over the room and you'll rejoin when you're back.</p>
    <label class="lbl">Your name</label>
    <input type="text" id="olName" maxlength="20" autocomplete="off" value="${val("olName", me.name)}" enterkeyhint="go">
    <div style="height:12px"></div>
    <button class="btn" data-ol="create">Create room</button>
  </div>`;
  S_.join = () => `<div class="screen">
    <div class="bar"><button class="iconbtn" data-ol="home">‹</button><span class="meta">Join a game</span><span style="width:40px"></span></div>
    <h1>Join a game</h1>
    <p class="sub">Get the 4-letter room code from the host's phone.</p>
    <label class="lbl">Room code</label>
    <input type="text" id="olCode" maxlength="4" autocomplete="off" autocapitalize="characters" style="text-transform:uppercase;font-size:28px;letter-spacing:.3em;text-align:center;font-weight:800" value="${val("olCode", code || "")}">
    <label class="lbl">Your name</label>
    <input type="text" id="olName" maxlength="20" autocomplete="off" value="${val("olName", me.name)}" enterkeyhint="go">
    <div style="height:12px"></div>
    <button class="btn teal" data-ol="dojoin">Join</button>
    ${banner()}
  </div>`;
  S_.connecting = () => `<div class="screen">${bar()}
    <div class="handoff" style="padding-top:10vh"><div class="emoji">📡</div><p>${isHost ? "Opening" : "Joining"} room</p><div class="big">${esc(code)}</div></div>
    ${banner()}
    <button class="link" data-ol="leaveask">Cancel</button></div>`;

  S_.lobby = () => {
    const ok = V.players.length >= 3;
    return `<div class="screen">${bar()}${banner()}
      <div class="card" style="text-align:center">
        <div class="wordlabel">Room code</div>
        <div class="word" style="letter-spacing:.2em;font-size:52px">${esc(code)}</div>
        <div class="cardsmall">Others tap “Join a game” and enter this code — or send them the link.</div>
        <button class="btn teal" data-ol="share" style="margin-top:12px">📨 Send invite link</button>
        ${flash ? `<div class="cardsmall" style="color:#0d7d72;font-weight:700">${esc(flash)}</div>` : ""}
      </div>
      <h2>Players (${V.players.length})</h2>
      <ul class="plist">${V.players.map((p, i) => `<li><span class="num">${i + 1}</span><span class="name">${dot(p.online)}${esc(p.name)}${p.id === V.me ? " (you)" : ""}${p.id === V.hostId ? " 👑" : ""}</span>
        ${V.isHost && p.id !== V.me ? `<button data-ol="kick" data-id="${esc(p.id)}" aria-label="Remove">✕</button>` : ""}</li>`).join("")}</ul>
      ${V.isHost ? `
        <p class="hint" style="text-align:left">Order = turn order for the Dasher. Join in seating order for the classic feel.</p>
        <h2>Categories</h2>
        ${catToggles(V.cats, "data-ol", "togglecat")}
        <p class="hint" style="text-align:left;margin-top:8px">A random category each round — the Dasher can switch it.</p>
        <h2>Play to</h2>
        <div class="chips">${[15, 25, 35, 50].map(t => `<button class="chip ${V.target === t ? "on" : ""}" data-ol="target" data-v="${t}">${t} pts</button>`).join("")}</div>
        <div style="height:16px"></div>
        <button class="btn" data-ol="start" ${ok ? "" : "disabled"}>${ok ? "Start game" : `Waiting for ${3 - V.players.length} more player${3 - V.players.length === 1 ? "" : "s"}`}</button>`
      : `<h2>Categories</h2><p class="sub">${V.cats.map(k => CATS[k].emoji + " " + esc(CATS[k].name)).join(" · ")}</p><p class="hint">Waiting for ${esc(nmV(V.hostId))} to start the game…</p>`}
    </div>`;
  };

  S_.dasher = () => {
    if(!V.isDasher) return `<div class="screen">${bar()}${banner()}
      <div class="handoff" style="padding-top:8vh"><div class="emoji">🎩</div><p>This round's Dasher is</p><div class="big">${esc(nmV(V.dasherId))}</div>
      <p>They're picking a card. Get ready to bluff!</p></div></div>`;
    const ci = catInfo(V.cat);
    if(customOpen) return `<div class="screen">${bar()}${banner()}
      <h1>Make your own card</h1>
      <p class="sub">${ci.emoji} ${esc(ci.name)} — ${esc(ci.q)}</p>
      <label class="lbl">${esc(ci.label)}</label><input type="text" id="olCWord" maxlength="120" autocomplete="off" value="${val("olCWord")}">
      <label class="lbl">The ${esc(ci.real)}</label><textarea id="olCDef">${val("olCDef")}</textarea>
      <button class="btn" data-ol="customsave">Use this card</button>
      <button class="link" data-ol="customcancel">Cancel</button></div>`;
    return `<div class="screen">${bar()}${banner()}
      <h1>You're the Dasher 🎩</h1>
      <p class="sub">Only you can see the ${esc(ci.real)}. ${esc(ci.read)}</p>
      ${wordCard({ cat: V.cat, word: V.word }, true)}
      <label class="lbl">The ${esc(ci.real)} — tweak it to sound like a player wrote it</label>
      <textarea id="olDef">${val("olDef", V.def)}</textarea>
      <div class="row">
        <button class="btn ghost" data-ol="redraw">🔀 Different card</button>
        <button class="btn ghost" data-ol="custom">✏️ Make my own</button>
      </div>
      ${catPicker(V.cat, "data-ol", "pickcat")}
      <button class="btn" data-ol="begin">I read it out — let everyone write</button>
    </div>`;
  };

  S_.writing = () => {
    const n = V.submitted.length, tot = V.writers.length;
    if(V.isDasher) return `<div class="screen">${bar()}${banner()}
      <div class="card"><div class="wordlabel">${esc(V.word)} · the ${esc(catInfo(V.cat).real)}</div><div class="def" style="margin-top:6px">${esc(V.def)}</div></div>
      <h2>Answers in: ${n} of ${tot}</h2>
      <p class="sub">They show up here as people send them. If someone basically got it right, tap “Basically right” — they get 3 points and their answer is left out.</p>
      ${V.bluffs.map(b => `<div class="rv"><div class="top"><span>${b.text ? "✅" : "⏳"} ${esc(nmV(b.id))}</span>
        ${b.text ? `<button class="chip ${b.correct ? "on" : ""}" style="color:var(--ink);border-color:var(--line);padding:6px 12px;font-size:13px" data-ol="correct" data-id="${esc(b.id)}">${b.correct ? "✓ " : ""}Basically right</button>` : ""}</div>
        <div class="def" style="font-size:16px;color:${b.text ? "var(--ink)" : "var(--muted)"}">${b.text ? esc(b.text) : "Still writing…"}</div></div>`).join("")}
      <button class="btn" data-ol="shuffle" ${n ? "" : "disabled"}>${n < tot ? `Shuffle now (${tot - n} still writing)` : "Shuffle & read them out"}</button>
    </div>`;
    if(V.myBluff && !editing) return `<div class="screen">${bar()}${banner()}
      <div class="handoff" style="padding-top:4vh"><div class="emoji">✉️</div><p>Sent to ${esc(nmV(V.dasherId))}!</p></div>
      <div class="card"><div class="wordlabel">Your fake for “${esc(V.word)}”</div><div class="def" style="margin-top:6px">${esc(V.myBluff)}</div></div>
      <p class="hint">Waiting for everyone… ${n} of ${tot} in</p>
      <button class="btn ghost" data-ol="edit">Change my answer</button></div>`;
    return `<div class="screen">${bar()}${banner()}
      <p class="sub" style="margin-bottom:4px">Make up an answer that sounds real.</p>
      ${wordCard({ cat: V.cat, word: V.word }, true)}
      <textarea id="olBluff" maxlength="300" placeholder="${esc(catInfo(V.cat).ph)}">${val("olBluff", V.myBluff || "")}</textarea>
      <p class="hint">Think you know it? Write the real answer — the Dasher can give you 3 points.</p>
      <button class="btn" data-ol="sendbluff">Send to ${esc(nmV(V.dasherId))}</button>
      ${editing ? `<button class="link" data-ol="canceledit">Keep my old answer</button>` : ""}
      <p class="hint">${n} of ${tot} answers in</p></div>`;
  };

  S_.reading = () => {
    const list = V.options.map((o, i) => `<div class="opt" style="cursor:default"><span class="n">${i + 1}</span><span class="t">${esc(o.text)}${o.mine ? `<span class="who">That's yours</span>` : ""}</span></div>`).join("");
    if(!V.isDasher) return `<div class="screen">${bar()}${banner()}
      ${wordCard({ cat: V.cat, word: V.word }, true)}
      <p class="sub">${esc(nmV(V.dasherId))} is reading them aloud. When it's your turn, say the number you think is real!</p>${list}</div>`;
    const ready = V.voters.every(v => V.votes[v] != null);
    return `<div class="screen">${bar()}${banner()}
      <h1>${esc(V.word)}</h1>
      <p class="sub">Read every answer aloud — straight face! Everyone sees this list on their phone.</p>${list}
      <h2>Votes</h2>
      <p class="sub">Go around the table. Tap the number each person says.</p>
      ${V.voters.length ? V.voters.map(v => `<div class="rv"><div class="top"><span>${esc(nmV(v))}</span></div><div class="chips">
        ${V.options.map((o, i) => o.owner === v ? "" : `<button class="chip ${V.votes[v] === i ? "on" : ""}" style="${V.votes[v] === i ? "" : "color:var(--ink);border-color:var(--line)"};min-width:48px" data-ol="vote" data-v="${esc(v)}" data-i="${i}">${i + 1}</button>`).join("")}
        <button class="chip ${V.votes[v] === -1 ? "on" : ""}" style="${V.votes[v] === -1 ? "" : "color:var(--muted);border-color:var(--line)"};font-size:13px" data-ol="vote" data-v="${esc(v)}" data-i="-1">No vote</button>
      </div></div>`).join("") : `<p class="hint">Everyone knew it — no votes needed.</p>`}
      <button class="btn" data-ol="score" ${ready ? "" : "disabled"}>${ready ? "Reveal the answers!" : "Tap in everyone's vote"}</button>
      <button class="link" data-ol="unshuffle">Back to the answers</button>
    </div>`;
  };

  function revealList(){
    return V.options.map((o, i) => {
      const real = o.owner === null;
      const vn = V.voters.filter(v => V.votes[v] === i).map(nmV);
      return `<div class="opt ${real ? "real" : ""}" style="cursor:default"><span class="n">${i + 1}</span><span class="t">${esc(o.text)}
        <span class="who">${real ? `<span class="badge real">The real one</span>` : `<span class="badge fake">Fake</span> by ${esc(nmV(o.owner))}`}</span>
        <span class="votes">${vn.length ? "🗳 " + vn.map(esc).join(", ") : "No votes"}</span></span></div>`;
    }).join("") + V.knew.map(k => `<div class="opt" style="cursor:default"><span class="n">★</span><span class="t">${esc(k.text)}<span class="who"><span class="badge ok">Nailed it</span> ${esc(nmV(k.id))} knew it</span></span></div>`).join("");
  }

  S_.reveal = () => {
    const canNext = V.isDasher || V.isHost;
    const nextD = V.players[(V.players.findIndex(p => p.id === V.dasherId) + 1) % V.players.length];
    return `<div class="screen">${bar()}${banner()}
      <h1>The big reveal</h1>
      <p class="sub">${catInfo(V.cat).emoji} “${esc(V.word)}” — the ${esc(catInfo(V.cat).real)}: <b>${esc(V.def)}</b></p>
      ${revealList()}
      <div class="card"><div class="wordlabel">Points this round</div>
        ${V.points.length ? `<ul class="pointlist">${V.points.map(l => `<li><span>${esc(nmV(l.id))} ${esc(l.why)}</span><b>+${l.n}</b></li>`).join("")}</ul>` : `<p>No points this round.</p>`}</div>
      <h2>Scores · first to ${V.target}</h2>
      ${scoreList(true)}
      <div style="height:10px"></div>
      ${canNext ? `<button class="btn" data-ol="next">${V.players.some(p => p.score >= V.target) ? "🏆 See who won" : `Next round — ${esc(nextD.name)} is Dasher`}</button>`
        : `<p class="hint">Waiting for ${esc(nmV(V.dasherId))} to start the next round…</p>`}
    </div>`;
  };

  S_.winner = () => {
    setTimeout(() => { if(typeof confetti === "function") confetti(); }, 50);
    return `<div class="screen" style="text-align:center">${bar()}
      <div class="trophy">🏆</div>
      <h1 style="font-size:40px;color:var(--gold)">${V.winners.map(nmV).map(esc).join(" &amp; ")}</h1>
      <p class="sub">${V.winners.length > 1 ? "It's a tie! Master bluffers, all of them." : "Champion of HunterDASH!"}</p>
      <div style="text-align:left">${scoreList(false)}</div>
      <div style="height:10px"></div>
      ${V.isHost ? `<button class="btn" data-ol="rematch">Play again</button><button class="btn ghost" data-ol="lobby">Back to the lobby</button>` : `<p class="hint">Waiting for ${esc(nmV(V.hostId))} to start another game…</p>`}
      <button class="link" data-ol="leaveask">Leave</button>
    </div>`;
  };

  function overlayHTML(){
    if(!overlay) return "";
    if(overlay.ask) return `<div class="overlay" data-ol="closeov"><div class="sheet" data-stop>
      <h2>${esc(overlay.ask)}</h2>
      <div class="row"><button class="btn ghost" data-ol="closeov">Cancel</button><button class="btn coral" data-ol="${overlay.act}" data-ok="1">Yes</button></div></div></div>`;
    if(overlay === "rules") return `<div class="overlay" data-ol="closeov"><div class="sheet" data-stop>${rulesHTML()}<button class="btn" data-ol="closeov">Close</button></div></div>`;
    const midRound = V && ["dasher", "writing", "reading"].includes(V.phase);
    return `<div class="overlay" data-ol="closeov"><div class="sheet" data-stop>
      ${V && V.phase !== "lobby" ? `<h2>Scores</h2>${scoreList(false)}` : `<h2>Room ${esc(code)}</h2>`}
      <button class="btn ghost" data-ol="share">📨 Invite someone (room ${esc(code)})</button>
      <button class="btn ghost" data-ol="rules">How to play</button>
      ${V && V.isHost && midRound ? `<button class="btn ghost" data-ol="skipask">Skip ${esc(nmV(V.dasherId))}'s turn as Dasher</button>` : ""}
      ${V && V.isHost && V.phase !== "lobby" ? `<button class="btn ghost" data-ol="lobbyask">Back to lobby (resets scores)</button>` : ""}
      <button class="btn coral" data-ol="leaveask">${isHost ? "Close the room" : "Leave the game"}</button>
      <button class="link" data-ol="closeov">Close</button></div></div>`;
  }

  function render(){
    if(S.screen !== "online") return;
    const a = document.activeElement, fid = a && a.id, sel = a && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null;
    let html;
    if(!code) html = (S_[ui] || S_.join)();
    else if(!V) html = S_.connecting();
    else html = (S_[V.phase] || S_.connecting)();
    app.innerHTML = html + overlayHTML();
    if(fid){ const el = document.getElementById(fid); if(el){ el.focus(); if(sel){ try{ el.setSelectionRange(sel[0], sel[1]); }catch(e){} } } }
  }

  async function share(){
    const link = inviteLink();
    const text = `Join my HunterDASH game! Room code ${code}`;
    try{
      if(navigator.share){ await navigator.share({ title: "HunterDASH", text, url: link }); return; }
    }catch(e){ if(e && e.name === "AbortError") return; }
    try{ await navigator.clipboard.writeText(link); flash = "Link copied — paste it in a text to your family."; }
    catch(e){ flash = link; }
    overlay = null; render();
  }

  function act(a, el){
    const okd = el && el.dataset.ok;
    switch(a){
      case "home": S.screen = "home"; save(); renderMain(); break;
      case "create": {
        const n = (document.getElementById("olName").value || "").trim();
        if(!n){ markBad("olName"); return; }
        me.name = n.slice(0, 20); ls.set(LS_ME, me);
        isHost = true; code = genCode();
        O = { code, epoch: 0, hostId: me.id, players: [{ id: me.id, name: me.name, score: 0 }], cats: (S.settings.cats || CAT_KEYS).slice(), target: 25, phase: "lobby", dasher: 0, round: 0, r: null, used: [], last: {} };
        V = viewFor(me.id);
        openHostPeer("new"); break; }
      case "dojoin": {
        const c = (document.getElementById("olCode").value || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
        const n = (document.getElementById("olName").value || "").trim();
        if(c.length !== 4){ markBad("olCode"); return; }
        if(!n){ markBad("olName"); return; }
        me.name = n.slice(0, 20); ls.set(LS_ME, me);
        isHost = false; code = c; epoch = 0; snap = null; V = null; status = ""; tryAlt = false;
        ls.set(LS_SESS, { code, epoch: 0, snap: null, at: Date.now() });
        render(); connectClient(); startBeat(); break; }
      case "share": share(); break;
      case "dismiss": flash = ""; render(); break;
      case "menu": overlay = "menu"; render(); break;
      case "rules": overlay = "rules"; render(); break;
      case "closeov": overlay = null; render(); break;
      case "target": send({ t: "target", v: +el.dataset.v }); break;
      case "start": send({ t: "start" }); break;
      case "kick": send({ t: "kick", id: el.dataset.id }); break;
      case "redraw": delete drafts.olDef; send({ t: "redraw" }); break;
      case "pickcat": delete drafts.olDef; send({ t: "pickcat", c: el.dataset.c }); break;
      case "togglecat": send({ t: "togglecat", c: el.dataset.c }); break;
      case "custom": customOpen = true; render(); break;
      case "customcancel": customOpen = false; render(); break;
      case "customsave": {
        const w = (document.getElementById("olCWord").value || "").trim(), d = (document.getElementById("olCDef").value || "").trim();
        if(!w){ markBad("olCWord"); return; } if(!d){ markBad("olCDef"); return; }
        customOpen = false; delete drafts.olCWord; delete drafts.olCDef; delete drafts.olDef;
        send({ t: "custom", word: w, def: d }); break; }
      case "begin": { const d = document.getElementById("olDef"); send({ t: "begin", def: d ? d.value : "" }); delete drafts.olDef; break; }
      case "sendbluff": {
        const t = (document.getElementById("olBluff").value || "").trim();
        if(!t){ markBad("olBluff"); return; }
        editing = false; delete drafts.olBluff; send({ t: "bluff", text: t }); break; }
      case "edit": editing = true; drafts.olBluff = V.myBluff; render(); break;
      case "canceledit": editing = false; delete drafts.olBluff; render(); break;
      case "correct": send({ t: "correct", id: el.dataset.id }); break;
      case "shuffle": send({ t: "shuffle" }); break;
      case "unshuffle": send({ t: "unshuffle" }); break;
      case "vote": send({ t: "vote", voter: el.dataset.v, idx: +el.dataset.i }); break;
      case "score": send({ t: "score" }); break;
      case "next": send({ t: "next" }); break;
      case "rematch": send({ t: "rematch" }); break;
      case "lobby": overlay = null; send({ t: "lobby" }); break;
      case "skipask": overlay = { ask: `Skip ${nmV(V.dasherId)}'s turn? This round won't count.`, act: "skip" }; render(); break;
      case "skip": overlay = null; send({ t: "skipdasher" }); break;
      case "lobbyask": overlay = { ask: "Go back to the lobby? Scores will reset.", act: "lobby" }; render(); break;
      case "leaveask":
        if(!code){ leave(); break; }
        overlay = { ask: isHost ? "Close the room? Everyone will be disconnected." : "Leave this game?", act: "leave" }; render(); break;
      case "leave": if(okd) leave(); break;
    }
  }
  function markBad(id){ const f = document.getElementById(id); if(f){ f.style.borderColor = "var(--coral)"; f.focus(); } }
  function renderMain(){ if(typeof window.render === "function") window.render(); }

  app.addEventListener("input", e => { if(S.screen === "online" && e.target.id) drafts[e.target.id] = e.target.value; });
  app.addEventListener("keydown", e => {
    if(S.screen !== "online" || e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    e.preventDefault();
    if(ui === "hostname" && !code) act("create"); else if(ui === "join" && !code) act("dojoin");
  });
  app.addEventListener("click", e => {
    if(S.screen !== "online") return;
    const el = e.target.closest("[data-ol]"); if(!el) return;
    const stop = e.target.closest("[data-stop]");
    if(stop && !stop.contains(el)) return;
    act(el.dataset.ol, el);
  });

  /* =================== public API =================== */
  return {
    render,
    openHost(){ ui = "hostname"; code = null; V = null; status = ""; S.screen = "online"; save(); render(); },
    openJoin(c){ ui = "join"; code = null; V = null; status = ""; if(c) drafts.olCode = c; S.screen = "online"; save(); render(); },
    resumeHost(){ resume(); },
    rejoin(){ resume(); },
    autoResume(){
      const s = ls.get(LS_SESS);
      if(s && s.code && Date.now() - (s.at || 0) < 6 * 3600 * 1000) return resume();
      return false;
    },
    homeButtons(){
      const s = ls.get(LS_SESS);
      return (s && s.code ? `<button class="btn teal" data-act="olrejoin">Rejoin room ${esc(s.code)}</button>` : "")
           + (flash && !code ? `<p class="hint">${esc(flash)}</p>` : "");
    },
    debug(){ return { isHost, epoch, lostSince, lastMsg, now: Date.now(), status, takingOver, rank: successorRank(), conn: !!(conn && conn.open), hasSnap: !!snap, vis: document.visibilityState, hb: !!hbTimer }; },
    get me(){ return me; }
  };
})();

/* open a join link like ?join=ABCD */
(function(){
  const q = new URLSearchParams(location.search).get("join");
  if(q){
    history.replaceState(null, "", location.pathname);
    const code = q.toUpperCase().slice(0, 4);
    let s = null; try{ s = JSON.parse(localStorage.getItem("bd_sess")); }catch(e){}
    if(s && s.code === code){ OL.autoResume() || OL.openJoin(code); }
    else OL.openJoin(code);
  } else OL.autoResume();
})();
