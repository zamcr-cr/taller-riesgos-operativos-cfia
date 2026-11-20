'use strict';

const cloudConfig = window.TALLER_CONFIG;
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cloudConfig?.supabaseUrl || '') &&
  /^sb_publishable_[A-Za-z0-9_-]+$/.test(cloudConfig?.publishableKey || '');
const cloudUrl = configured ? cloudConfig.supabaseUrl.replace(/\/$/, '') : '';
const rawInvite = new URLSearchParams(location.hash.slice(1)).get('equipo');
const invite = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(rawInvite || '') ? rawInvite : null;
const sample = initial().teams[0];
let login = null;
let onlineRole = 'visitante';
let session = null;
let remoteTeams = [];
let remoteSignature = '';
let busy = false;
let syncInProgress = false;
let onlineMessage = '';
let forceRefresh = false;

function canEdit() {
  return onlineRole === 'equipo' && current().id !== sample.id && !forceRefresh;
}

async function requestCloud(path, payload, token) {
  if (!configured) throw new Error('Configura el servicio para activar el trabajo en línea.');
  const headers = {'apikey':cloudConfig.publishableKey, 'Content-Type':'application/json'};
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(cloudUrl + path, {
    method:'POST', headers, body:JSON.stringify(payload), cache:'no-store',
    signal:AbortSignal.timeout(12000)
  });
  const result = await response.json();
  if (!response.ok) {
    if (path.includes('/token')) throw new Error('No se pudo iniciar o renovar la sesión del facilitador. Verifica tus credenciales.');
    throw new Error('El servicio no pudo completar la solicitud. Verifica la configuración y vuelve a intentar.');
  }
  if (result.error) {
    const error = new Error(result.error);
    error.conflict = result.conflicto;
    throw error;
  }
  return result;
}
async function facilitatorToken() {
  if (Date.now() < login.deadline) return login.access_token;
  const refreshed = await requestCloud('/auth/v1/token?grant_type=refresh_token', {refresh_token:login.refresh_token});
  login = authSession(refreshed);
  return login.access_token;
}
function authSession(auth) {
  return {...auth,deadline:Date.now()+(Number(auth.expires_in)-30)*1000};
}
async function rpc(op, inputs={}, privileged=false) {
  return requestCloud('/rest/v1/rpc/taller_cfia', {operacion:op,parametros:inputs}, privileged?await facilitatorToken():null);
}
function decodeGroup(group) {
  const result = {...group.datos,id:group.id,name:group.name,revision:group.revision};
  return validImport(result) ? result : {...team(group.name,false),id:group.id,revision:group.revision};
}
function applySnapshot(result) {
  const signature = JSON.stringify(result);
  if (signature === remoteSignature) return false;
  remoteSignature = signature;
  const joiningTeam = onlineRole === 'equipo' && !session;
  const previous = joiningTeam ? result.equipo.id : data.active;
  if (onlineRole === 'facilitador') {
    session = result.sesion;
    remoteTeams = result.equipos;
    data = {active:previous,teams:[sample,...remoteTeams.map(decodeGroup)]};
  } else {
    session = {nombre:result.sesion};
    data = {active:previous,teams:[decodeGroup(result.equipo),sample]};
  }
  if (!data.teams.some(t=>t.id===data.active)) switchTeam(data.teams[0].id);
  return true;
}

function displayOnline() {
  const target = $('collaboration');
  target.hidden = false;
  let content = '';
  if (!configured) {
    content = '<p>Configura el servicio para habilitar sesiones y equipos en línea. Puedes explorar el caso de práctica.</p>';
  } else if (rawInvite !== null) {
    content = '<div class="row"><strong>'+esc(session?.nombre || 'Acceso de equipo')+'</strong>'+button('Actualizar ejercicio','syncOnline')+'</div>';
  } else if (onlineRole === 'facilitador') {
    content = '<div class="row"><strong>Panel del facilitador</strong><div>'+button('Actualizar','syncOnline')+' '+button('Cerrar acceso','logoutOnline')+'</div></div>';
    if (!session) {
      content += '<form id="startOnline" class="online-form"><label>Nombre de la capacitación<input name="name" maxlength="100" required></label><button class="primary">Iniciar sesión de taller</button></form>';
    } else {
      content += '<p>Sesión activa · <strong>'+esc(session.nombre)+'</strong></p>'+
        '<form id="createOnline" class="online-form"><label>Nombre del grupo<input name="name" maxlength="100" required></label><button class="primary">Crear equipo</button></form>'+
        '<div class="online-teams">'+remoteTeams.map(g=>'<div class="row preview"><strong>'+esc(g.name)+'</strong><div>'+button('Ver ejercicio','seeOnline',attr('id',g.id))+' '+button('Copiar enlace','inviteOnline',attr('id',g.id))+'</div></div>').join('')+'</div>'+
        '<div class="row">'+button('Finalizar y borrar ejercicios','resetOnline','','danger')+'</div>';
    }
  } else {
    content = '<details id="facilitatorLogin"><summary>Acceso del facilitador</summary>'+
      '<form id="authOnline" class="online-form"><label>Correo<input name="email" type="email" autocomplete="username" required></label>'+
      '<label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Entrar</button></form></details>';
  }
  target.innerHTML = content + '<div id="onlineStatus" role="status" class="muted">'+esc(onlineMessage)+'</div>';
  $('main').querySelectorAll('[data-action]').forEach(b=>{
    if (!canEdit()&&['addProcess','addRisk','criteria'].includes(b.dataset.action)) b.hidden=true;
  });
  const panelCopy = $('main').querySelector('[data-online-copy]');
  if (panelCopy) panelCopy.textContent = onlineRole==='facilitador'
    ? 'Selecciona un grupo para revisar su ejercicio y mapa de calor.'
    : 'Los cambios guardados del equipo estarán disponibles en el panel del facilitador.';

}
function messageOnline(message) {
  onlineMessage=message;
  if ($('onlineStatus')) $('onlineStatus').textContent=message;
}
async function refreshOnline(manual=false) {
  if (busy||syncInProgress||$('dialog').open||(!invite&&onlineRole!=='facilitador')) return;
  syncInProgress=true;
  try {
    if (invite) onlineRole='equipo';
    const result = invite ? await rpc('equipo',{token:invite}) : await rpc('panel',{},true);
    if ($('dialog').open) return;
    const changed=applySnapshot(result);
    if (manual) {
      forceRefresh=false;
      messageOnline('Datos actualizados.');
    }
    const typing=$('collaboration').contains(document.activeElement)&&document.activeElement.matches('input');
    if ((changed||manual)&&!typing) render();
    if (changed&&typing) remoteSignature='';
  } catch(error) {
    if (invite && error.message.includes('finalizada')) {
      session=null;
      remoteSignature='';
      onlineRole='visitante';
      data={active:sample.id,teams:[sample]};
      switchTeam(sample.id);
      render();
    }
    messageOnline(error.message);
  } finally {syncInProgress=false;}
}
async function saveOnline(candidate) {
  if (!canEdit()||busy) return false;
  busy=true;
  // Mantener abierto el formulario hasta confirmar el guardado.
  $('submit').disabled=true;
  $('remove').disabled=true;
  $('dialog').querySelectorAll('#cancel,#close').forEach(b=>b.disabled=true);
  clearEditorError();
  try {
    const result=await rpc('guardar',{token:invite,revision:candidate.revision,datos:candidate});
    data.teams[data.teams.findIndex(t=>t.id===candidate.id)]=decodeGroup(result.equipo);
    messageOnline('Cambios guardados en línea.');
    return true;
  } catch(error) {
    if (error.conflict||error.message.includes('finalizada')) {
      forceRefresh=true;
      $('submit').disabled=true;
    }
    messageOnline(error.message);
    $('editorError').textContent=error.message;
    return false;
  } finally {
    busy=false;
    $('submit').disabled=forceRefresh;
    $('remove').disabled=false;
    $('dialog').querySelectorAll('#cancel,#close').forEach(b=>b.disabled=false);
  }
}
function clearEditorError(){ $('editorError').textContent=''; }
function inviteLink(group) {
  const url=new URL(location.href);
  url.search='';
  url.hash='equipo='+group.token;
  return url.href;
}
$('collaboration').addEventListener('submit',async e=>{
  e.preventDefault();
  if (busy||syncInProgress) return;
  const form=e.target;
  const fields=new FormData(form);
  busy=true;
  try {
    if (form.id==='authOnline') {
      login=authSession(await requestCloud('/auth/v1/token?grant_type=password',{
        email:String(fields.get('email')).trim(),
        password:String(fields.get('password'))
      }));
      const result=await rpc('panel',{},true);
      onlineRole='facilitador';
      remoteSignature='';
      applySnapshot(result);
    } else {
      const nombre=String(fields.get('name')).trim();
      const creating=form.id==='createOnline';
      applySnapshot(await rpc(creating?'crear':'iniciar',{nombre,sesion:session?.id},true));
    }
    messageOnline('Cambios guardados en línea.');
    render();
  } catch(error) {
    if (form.id==='authOnline') login=null;
    messageOnline(error.message);
  } finally {busy=false;}
});
$('collaboration').addEventListener('click',async e=>{
  const a=e.target.closest('[data-action]')?.dataset;
  if (!a||busy||syncInProgress) return;
  if (a.action==='syncOnline') return refreshOnline(true);
  if (a.action==='seeOnline') {
    switchTeam(a.id);render();$('main').scrollIntoView({block:'start'});return;
  }
  if (a.action==='inviteOnline') {
    const group=remoteTeams.find(g=>g.id===a.id);
    if (!group) return;
    const url=inviteLink(group);
    try {await navigator.clipboard.writeText(url);messageOnline('Enlace copiado para '+group.name+'.');}
    catch {window.prompt('Copia el enlace del equipo',url);}
    return;
  }
  if (a.action==='logoutOnline') {
    login=null;onlineRole='visitante';session=null;remoteTeams=[];remoteSignature='';
    data={active:sample.id,teams:[sample]};switchTeam(sample.id);messageOnline('Acceso cerrado.');render();
    return;
  }
  if (a.action!=='resetOnline'||!session) return;
  const confirmation=window.prompt('Se eliminarán los ejercicios de todos los equipos y sus enlaces dejarán de funcionar. Escribe BORRAR para confirmar.');
  if (confirmation!=='BORRAR') return;
  busy=true;
  try {
    applySnapshot(await rpc('cerrar',{sesion:session.id},true));
    switchTeam(sample.id);messageOnline('Capacitación finalizada. Los ejercicios fueron eliminados.');render();
  } catch(error) {messageOnline(error.message);}
  finally {busy=false;}
});
$('dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
if (rawInvite!==null&&!invite) onlineMessage='El enlace del equipo es inválido.';
