'use strict';
/* غرفة الاجتماع — صوت وفيديو حقيقيان عبر LiveKit (WebRTC) */
let RM = null;
const LK_SRC = 'https://cdn.jsdelivr.net/npm/livekit-client@2.5.0/dist/livekit-client.umd.js';
function loadLK() {
  return new Promise((res, rej) => {
    if (window.LivekitClient) return res();
    const s = document.createElement('script'); s.src = LK_SRC; s.onload = res;
    s.onerror = () => rej(new Error('تعذر تحميل مكتبة الاتصال. تأكد من الإنترنت ثم أعد المحاولة.'));
    document.head.append(s);
  });
}
const roleOf = id => id.startsWith('supervisor:') ? 'مشرف' : id.startsWith('assistant:') ? 'مساعد' : 'طالب';
const backHash = () => S.me.role === 'student' ? '#/s' : '#/a/meetings';

async function viewRoomGate(mid) {
  const m = (await api('/meetings')).find(x => x.id === mid);
  if (!m) { toast('الاجتماع غير موجود.', true); return go(backHash()); }
  const staff = S.me.role !== 'student', canOpen = staff && canDo('meetings');
  let blocked = '';
  if (!m.isOpen && !canOpen) blocked = 'هذا الاجتماع مغلق حالياً. سيظهر لك الدخول عندما يفتحه المشرف.';
  else if (!S.pub.livekit) blocked = 'خدمة الصوت والفيديو غير مفعّلة بعد. يحتاج المسؤول إلى إضافة مفاتيح LiveKit (راجع ملف README).';
  app.innerHTML = `<div class="center"><div class="card gate ready">${LOGO()}
    <div class="badge green" style="margin-top:.8rem"><i class="dot"></i>غرفة جاهزة للدخول</div>
    <h2 style="margin-top:.6rem">${esc(m.title)}</h2><p class="muted">${esc(m.description)}</p>
    <p>${meetingBadge(m)} <span class="muted">${fmtDate(m.startsAt, { weekday: 'long', day: 'numeric', month: 'long' })} · ${fmtTime(m.startsAt)}</span></p>
    <p class="muted" style="font-size:.92rem">تدخل والمايك والكاميرا متوقفان، وتشغّلهما بنفسك عند الحاجة.</p>
    ${blocked ? `<p class="err">${blocked}</p>` : ''}
    <div class="row" style="display:flex;flex-direction:column;gap:.7rem;margin-top:1rem">
      <button class="btn block" id="rj" ${blocked ? 'disabled' : ''}>${staff && !m.isOpen ? 'بدء الاجتماع' : 'دخول الاجتماع'}</button>
      <button class="btn ghost block" onclick="go('${backHash()}')">العودة للقائمة</button></div></div></div>`;
  $('#rj').onclick = async () => { $('#rj').disabled = true; try { await startRoom(m); } catch (e) { toast(e.message, true); $('#rj').disabled = false; } };
}

async function startRoom(m) {
  await loadLK();
  const j = await api(`/meetings/${m.id}/join`, { method: 'POST', body: {} });
  const L = LivekitClient;
  const room = new L.Room({ adaptiveStream: true, dynacast: true,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  RM = { m, room, key: j.key, perms: j.perms, hb: null, left: false, state: 'connecting' };
  const redraw = () => { if (RM && !RM.left) { drawTiles(); drawSide(); drawControls(); } };
  [L.RoomEvent.ParticipantConnected, L.RoomEvent.ParticipantDisconnected, L.RoomEvent.TrackMuted, L.RoomEvent.TrackUnmuted,
   L.RoomEvent.LocalTrackPublished, L.RoomEvent.LocalTrackUnpublished, L.RoomEvent.ActiveSpeakersChanged].forEach(ev => room.on(ev, redraw));
  room.on(L.RoomEvent.TrackSubscribed, (track, pub, p) => {
    if (track.kind === 'audio') { const el = track.attach(); el.dataset.sid = track.sid; $('#audios').append(el); }
    redraw();
  });
  room.on(L.RoomEvent.TrackUnsubscribed, track => { track.detach().forEach(e => e.remove()); redraw(); });
  room.on(L.RoomEvent.ConnectionStateChanged, s => { if (RM) { RM.state = s; drawConn(); } });
  room.on(L.RoomEvent.MediaDevicesError, e => toast(mediaErr(e, ''), true));
  room.on(L.RoomEvent.Disconnected, reason => {
    if (!RM || RM.left) return;
    const removed = L.DisconnectReason && reason === L.DisconnectReason.PARTICIPANT_REMOVED;
    const closed = L.DisconnectReason && reason === L.DisconnectReason.ROOM_DELETED;
    leaveRoom(removed ? 'أُخرجت من الاجتماع.' : closed ? 'تم إغلاق الاجتماع.' : 'انقطع الاتصال بالاجتماع.');
  });
  drawRoomShell(m);
  try { await room.connect(j.url, j.token); await room.startAudio().catch(() => {}); }
  catch (e) { await leaveRoom('', false); throw new Error('تعذر الاتصال بغرفة الاجتماع. تحقق من الإنترنت وأعد المحاولة.'); }
  RM.state = 'connected';
  RM.hb = setInterval(heartbeat, 10000); heartbeat();
  window.addEventListener('pagehide', beaconLeave);
  loadSummary(); redraw(); drawConn();
}

function drawRoomShell(m) {
  const mod = canDo('moderation') && S.me.role !== 'student';
  app.innerHTML = `<div class="room"><div class="head">${LOGO()}<div><b style="font-family:var(--head);font-size:1.3rem">${esc(m.title)}</b> ${meetingBadge({ isOpen: true })}</div><span style="flex:1"></span>
    <span id="rconn" class="muted"></span><button class="btn danger sm" id="rleave">مغادرة الاجتماع</button></div>
    <div class="main"><div class="stage"><div class="tiles" id="tiles"></div><div class="controls" id="ctl"></div></div>
    <aside class="panel"><h3>المشاركون (<span id="pc">0</span>)</h3><ul class="plist" id="pl"></ul>
      ${mod ? '<button class="btn gold sm block" id="rmute" style="margin-top:.8rem">إغلاق مايكات جميع الطلاب</button>' : ''}
      <h3 style="margin-top:1.2rem">من سيحضر الأغراض</h3><ul class="plist" id="isum"></ul></aside></div>
    <div id="audios" class="hidden"></div></div>`;
  $('#rleave').onclick = () => leaveRoom('');
  if ($('#rmute')) $('#rmute').onclick = async () => { try { await api(`/meetings/${m.id}/mod`, { method: 'POST', body: { action: 'muteAll' } }); toast('تم كتم مايكات الطلاب.'); } catch (e) { toast(e.message, true); } };
}
function drawConn() {
  const el = $('#rconn'); if (!el || !RM) return;
  const s = RM.state, ok = s === 'connected', bad = s === 'disconnected';
  el.innerHTML = `<i class="dot ${ok ? '' : bad ? 'off' : 'warn'}"></i>${ok ? 'متصل' : bad ? 'غير متصل' : s === 'connecting' ? 'جارٍ الاتصال…' : 'إعادة الاتصال…'}`;
}

function drawTiles() {
  const el = $('#tiles'); if (!el || !RM) return;
  const T = LivekitClient.Track, R = RM.room;
  const ps = [R.localParticipant, ...R.remoteParticipants.values()];
  const tile = (p, screen) => {
    const d = document.createElement('div');
    d.className = 'tile' + (screen ? ' screen' : '') + (!screen && p.isSpeaking ? ' speaking' : '');
    const pub = p.getTrackPublication(screen ? T.Source.ScreenShare : T.Source.Camera);
    if (pub && pub.track && !pub.isMuted) { const v = pub.track.attach(); v.muted = true; v.playsInline = true; d.append(v); }
    else d.insertAdjacentHTML('beforeend', '<div class="nocam">الكاميرا متوقفة</div>');
    const nm = esc(p.name || p.identity);
    d.insertAdjacentHTML('beforeend', `<div class="who"><span>${screen ? 'شاشة ' : ''}${nm}${p.isLocal ? ' (أنت)' : ''}</span><span>${roleOf(p.identity)}</span>${p.isMicrophoneEnabled ? '' : '<span>المايك متوقف</span>'}</div>`);
    return d;
  };
  el.innerHTML = '';
  const share = ps.map(p => ({ p, pub: p.getTrackPublication(T.Source.ScreenShare) })).find(x => x.pub && x.pub.track);
  if (share) {
    el.classList.add('share'); el.append(tile(share.p, true));
    const strip = document.createElement('div'); strip.className = 'strip'; ps.forEach(p => strip.append(tile(p, false))); el.append(strip);
  } else { el.classList.remove('share'); ps.forEach(p => el.append(tile(p, false))); }
}
function drawSide() {
  if (!RM || !$('#pl')) return;
  const R = RM.room, ps = [R.localParticipant, ...R.remoteParticipants.values()];
  $('#pc').textContent = ps.length;
  $('#pl').innerHTML = ps.map(p => `<li><span>${esc(p.name || p.identity)}${p.isLocal ? ' (أنت)' : ''} <span class="muted">${roleOf(p.identity)}</span></span><span class="muted">${p.isMicrophoneEnabled ? 'مايك' : ''} ${p.isCameraEnabled ? 'كاميرا' : ''}</span></li>`).join('');
}
async function loadSummary() {
  try {
    const its = await api('/items/summary');
    $('#isum').innerHTML = its.length ? its.map(i => `<li><span>${esc(i.name)}</span><span class="muted">${i.studentName ? esc(i.studentName) : 'لم يحدد بعد'}</span></li>`).join('') : '<li class="muted">لا توجد أغراض.</li>';
  } catch {}
}
function drawControls() {
  const c = $('#ctl'); if (!c || !RM) return;
  const lp = RM.room.localParticipant, P = RM.perms;
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const b = (id, on, onLbl, offLbl, allowed) => `<button class="btn ${on ? '' : 'ghost'}" id="${id}" ${allowed || on ? '' : 'disabled title="أوقفها المشرف"'}>${on ? onLbl : offLbl}</button>`;
  c.innerHTML = b('cm', lp.isMicrophoneEnabled, 'إيقاف المايك', 'تشغيل المايك', P.mic) + b('cc', lp.isCameraEnabled, 'إيقاف الكاميرا', 'تشغيل الكاميرا', P.cam)
    + (canShare ? b('cs', lp.isScreenShareEnabled, 'إيقاف المشاركة', 'مشاركة الشاشة', P.screen) : '') + '<button class="btn danger" id="cl">مغادرة الاجتماع</button>';
  $('#cm').onclick = () => rmToggle('mic'); $('#cc').onclick = () => rmToggle('cam');
  if ($('#cs')) $('#cs').onclick = () => rmToggle('screen'); $('#cl').onclick = () => leaveRoom('');
}
function mediaErr(e, kind) {
  const n = (e && e.name) || '', what = { mic: 'المايك', cam: 'الكاميرا', screen: 'مشاركة الشاشة' }[kind] || 'الجهاز';
  if (n === 'NotAllowedError' || /permission|denied/i.test((e && e.message) || '')) return kind === 'screen' ? 'لم تبدأ مشاركة الشاشة (أُلغيت أو مُنعت).' : `تم رفض إذن ${what}. اسمح للمتصفح باستخدامه من إعدادات الموقع ثم أعد المحاولة.`;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `لم نجد ${what} في جهازك.`;
  if (n === 'NotReadableError') return `${what} مشغول بتطبيق آخر. أغلقه وأعد المحاولة.`;
  return `تعذر تشغيل ${what}.`;
}
async function rmToggle(kind) {
  if (!RM) return; const lp = RM.room.localParticipant, P = RM.perms;
  try {
    if (kind === 'mic') { if (!P.mic && !lp.isMicrophoneEnabled) return toast('المايك غير متاح لك الآن.', true); await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled); }
    if (kind === 'cam') { if (!P.cam && !lp.isCameraEnabled) return toast('الكاميرا غير متاحة لك الآن.', true); await lp.setCameraEnabled(!lp.isCameraEnabled); }
    if (kind === 'screen') { if (!P.screen && !lp.isScreenShareEnabled) return toast('المشرف لم يسمح بمشاركة الشاشة.', true); await lp.setScreenShareEnabled(!lp.isScreenShareEnabled); }
  } catch (e) { toast(mediaErr(e, kind), true); }
  if (RM) { drawControls(); drawTiles(); heartbeat(); }
}
async function heartbeat() {
  if (!RM || RM.left) return; const lp = RM.room.localParticipant;
  try { await api(`/meetings/${RM.m.id}/presence`, { method: 'POST', body: { mic: lp.isMicrophoneEnabled, cam: lp.isCameraEnabled, screen: lp.isScreenShareEnabled } }); }
  catch (e) { if (e.status === 404) api(`/meetings/${RM.m.id}/join`, { method: 'POST', body: {} }).catch(() => {}); }
}
async function roomSync() {
  if (!RM || RM.left) return;
  try {
    const r = await api(`/meetings/${RM.m.id}/me`);
    if (!r.isOpen) return leaveRoom('أغلق المشرف الاجتماع.');
    RM.perms = r.perms; drawControls(); loadSummary();
  } catch (e) { if (e.status === 404) leaveRoom('تم حذف الاجتماع.'); }
}
function beaconLeave() { if (RM && !RM.left) navigator.sendBeacon(`/api/meetings/${RM.m.id}/leave`, new Blob(['{}'], { type: 'application/json' })); }
function stopAll() {
  if (!RM || RM.left) return false;
  RM.left = true; clearInterval(RM.hb); window.removeEventListener('pagehide', beaconLeave);
  const { room, m } = RM;
  try { room.localParticipant.trackPublications.forEach(p => p.track && p.track.stop()); } catch {}
  try { room.disconnect(); } catch {}
  api(`/meetings/${m.id}/leave`, { method: 'POST', body: {} }).catch(() => {});
  document.querySelectorAll('#audios audio').forEach(a => a.remove());
  RM = null; return true;
}
async function leaveRoom(msg, nav = true) { const had = stopAll(); if (msg) toast(msg); if (nav && had !== false) go(backHash()); }
function leaveRoomSilently() { stopAll(); }
