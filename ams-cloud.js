/* AMS ACOPIO Cloud v1. No requiere librerías externas. */
(function(){
 'use strict';
 const cfg=window.AMS_CONFIG||{};
const configured=/^https:\/\/[\w.-]+\/functions\/v1\/ams-api(?:-v7)?\/?$/.test(String(cfg.apiUrl||''));
 const ARRAY_KEYS=['people','guides','requests','cargo','services','users','sacks','logs','cleanings','inventoryMoves'];
 const OBJECT_KEYS=['rooms','inventory','reservations'];
 const ALL=[...ARRAY_KEYS,...OBJECT_KEYS];
 const DB='ams-cloud-outbox-v1',JOURNAL='ams-cloud-write-journal-v1';
 const vKey='ams-cloud-versions-v1',cKey='ams-cloud-cursor-v1';
 const devKey='ams-cloud-device-token-v1',admKey='ams-cloud-admin-token-v1',opKey='ams-cloud-operator-session-v1';
 const snap=x=>JSON.parse(JSON.stringify(x));
 const uuid=()=>crypto.randomUUID();
 function tidyIds(obj){
   ARRAY_KEYS.forEach(entity=>{if(!Array.isArray(obj[entity]))obj[entity]=[];
     obj[entity].forEach(rec=>{if(entity==='people'&&rec.id!=null)return;
       if(entity==='cargo'&&rec.number)return;
       if(!rec._amsKey)rec._amsKey=uuid();
     });
   });
   OBJECT_KEYS.forEach(k=>{if(!obj[k]||typeof obj[k]!=='object'||Array.isArray(obj[k]))obj[k]={}});
 }
 function mapOf(entity,obj){
   const out=new Map();
   if(ARRAY_KEYS.includes(entity))for(const item of obj[entity]||[]){const k=entity==='people'?String(item.id):entity==='cargo'?String(item.number):String(item._amsKey);if(k&&k!=='undefined')out.set(k,item)}
   else for(const [k,item] of Object.entries(obj[entity]||{}))out.set(String(k),item&&typeof item==='object'&&!Array.isArray(item)?item:{value:item});
   return out;
 }
 function assignRecord(entity,key,payload,del){
   if(ARRAY_KEYS.includes(entity)){
     let arr=state[entity]||[];
     const pos=arr.findIndex(item=>(entity==='people'?String(item.id):entity==='cargo'?String(item.number):String(item._amsKey))===key);
     if(del){if(pos>=0)arr.splice(pos,1)}
     else {const val=snap(payload);if(entity!=='people'&&entity!=='cargo')val._amsKey=key;
       if(pos>=0)arr[pos]=val;else arr.unshift(val)}
     state[entity]=arr;
   }else {state[entity]=state[entity]||{};if(del)delete state[entity][key];else state[entity][key]=('value' in payload&&Object.keys(payload).length===1)?payload.value:snap(payload)}
 }
 function requestStore(db,mode){return db.transaction('outbox',mode).objectStore('outbox')}
 async function openDB(){return await new Promise((ok,no)=>{
   const req=indexedDB.open(DB,1);
   req.onupgradeneeded=()=>{const store=req.result.createObjectStore('outbox',{keyPath:'opId'});store.createIndex('createdAt','createdAt',{unique:false})};
   req.onsuccess=()=>ok(req.result);req.onerror=()=>no(req.error);
 })}
 async function dbPut(db,item){return await new Promise((ok,no)=>{const tx=db.transaction('outbox','readwrite');tx.objectStore('outbox').put(item);tx.oncomplete=()=>ok();tx.onerror=()=>no(tx.error)})}
 async function dbDelete(db,key){return await new Promise((ok,no)=>{const tx=db.transaction('outbox','readwrite');tx.objectStore('outbox').delete(key);tx.oncomplete=()=>ok();tx.onerror=()=>no(tx.error)})}
 async function dbAll(db){return await new Promise((ok,no)=>{const tx=db.transaction('outbox','readonly'),req=tx.objectStore('outbox').getAll();req.onsuccess=()=>ok(req.result.sort((a,b)=>a.createdAt-b.createdAt));req.onerror=()=>no(req.error)})}
 async function http(action,payload={},token,headers={}){
   if(!navigator.onLine)throw Error('SIN_CONEXION');
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
   try{
     const resp=await fetch(cfg.apiUrl,{method:'POST',headers:{'content-type':'application/json',...(token?{'authorization':'Bearer '+token}:{}),...headers},body:JSON.stringify({action,...payload}),signal:controller.signal,cache:'no-store'});
     let result;try{result=await resp.json()}catch{throw Error('RESPUESTA_INVALIDA')}
     if(!resp.ok||!result.ok)throw Error(result.error||'HTTP_'+resp.status);
     return result;
   }finally{clearTimeout(timer)}
 }
 const cloud={
   configured,db:null,ready:false,token:'',role:'',busy:false,captureChain:Promise.resolve(),
   previous:null,version:{},cursor:0,status:'Sin configurar',pending:0,blocked:0,
   boot:async function(){
     if(!configured)return;
     this.previous=snap(state);tidyIds(state);
     try{
       this.db=await openDB();
       const journal=JSON.parse(localStorage.getItem(JOURNAL)||'[]');
       for(const entry of journal)await dbPut(this.db,entry);
       if(journal.length)localStorage.removeItem(JOURNAL);
     }catch(e){this.status='ERROR: IndexedDB no disponible o registro local pendiente ilegible.';this.draw();showLoginAMS();return}
     try{this.version=JSON.parse(localStorage.getItem(vKey)||'{}')||{}}catch{this.version={}}
     this.cursor=Number(localStorage.getItem(cKey)||0)||0;
     this.previous=snap(state);this.ready=true;
     document.querySelector('header .tag')?.remove();
     this.injectUI();
     const session=currentSession();
     if(session?.role==='admin'&&session?.cloud===true){this.token=sessionStorage.getItem(admKey)||'';this.role=this.token?'admin':''}
     else if(session?.role==='operator'&&session?.cloud===true){this.token=sessionStorage.getItem(opKey)||'';this.role=this.token?'operator':''}
     if(!this.token){sessionStorage.removeItem(AMS_SESSION_KEY);showLoginAMS()}
     else {document.getElementById('amsLogin').hidden=true;updateSessionHeader();render();this.start()}
     this.status='Base Supabase configurada';this.draw();
   },
   injectUI:function(){
     const bar=document.createElement('div');bar.id='amsCloudBar';
     bar.innerHTML='<span id="amsCloudStatus">◯ Preparando conexión</span><button type="button" id="amsCloudSync">↻ Sincronizar</button><button type="button" id="amsCloudTools" hidden>⚙ Base y dispositivos</button><button type="button" id="amsCloudConflicts" hidden>⚠ Conflictos</button>';
     document.querySelector('header').append(bar);
     document.getElementById('amsCloudSync').onclick=()=>this.sync(true);
     document.getElementById('amsCloudTools').onclick=()=>this.tools();
     document.getElementById('amsCloudConflicts').onclick=()=>this.conflicts();
     let input=document.createElement('div');input.className='field';input.id='amsLoginEnrollWrap';
     input.innerHTML='<label>ACTIVACIÓN DEL DISPOSITIVO (solo primer uso)</label><input id="amsEnrollCode" autocomplete="off" maxlength="12" placeholder="Código entregado por el administrador"><small>El dispositivo se activa solo una vez; la contraseña PERSONAL siempre será obligatoria al entrar.</small>';
     document.getElementById('amsLoginPinWrap').insertAdjacentElement('afterend',input);
     const passwordWrap=document.createElement('div');passwordWrap.className='field';passwordWrap.id='amsOperatorPasswordWrap';
     passwordWrap.innerHTML='<label>CONTRASEÑA PERSONAL DEL OPERARIO *</label><input id="amsOperatorPassword" type="password" minlength="8" maxlength="64" autocomplete="current-password" placeholder="Contraseña asignada por el administrador">';
     input.insertAdjacentElement('afterend',passwordWrap);
     const old=window.updateLoginRoleAMS;
     window.updateLoginRoleAMS=function(){
       old();const admin=val('amsLoginName')==='ADMINISTRADOR';
    input.hidden=true;

document.getElementById('amsLoginGuardWrap').hidden=true;
document.getElementById('amsLoginShiftWrap').hidden=true;

document.getElementById('amsLoginGuard').required=false;
document.getElementById('amsLoginShift').required=false;
       passwordWrap.hidden=admin;
       const pw=document.getElementById('amsOperatorPassword');pw.required=!admin;
       if(admin)pw.value='';
       const help=document.getElementById('amsPinHelp'),caption=document.getElementById('amsLoginCaption');
       if(help)help.textContent=admin?'PIN del administrador verificado por Supabase.':'Cada responsable debe ingresar su contraseña personal en cada nueva sesión. Un dispositivo activado NO reemplaza la contraseña.';
       if(caption)caption.textContent=admin?'INGRESO ADMINISTRADOR · PIN DE SUPABASE':'INGRESO AL SISTEMA · USUARIO Y CONTRASEÑA';
     };
     updateLoginRoleAMS();
     this.refreshOperators();
   },
   refreshOperators:async function(){
     try{
       const r=await http('operator_catalog');
       const names=(r.names||[]).filter(x=>typeof x==='string'&&x!=='ADMINISTRADOR');
       AMS_OPERATORS.splice(0,AMS_OPERATORS.length,...names);
       const select=document.getElementById('amsLoginName');
       if(select){
         const old=select.value;
         select.innerHTML='<option value="">Seleccione responsable</option>'+names.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('')+'<option value="ADMINISTRADOR">ADMINISTRADOR</option>';
         if([...names,'ADMINISTRADOR'].includes(old))select.value=old;
         updateLoginRoleAMS();
       }
     }catch(e){console.warn('No se pudo actualizar catálogo de operarios:',e)}
   },
   draw:async function(){
     if(!configured)return;
     try{const out=await dbAll(this.db);this.pending=out.filter(x=>!x.blocked).length;this.blocked=out.filter(x=>x.blocked).length}catch{}
     const el=document.getElementById('amsCloudStatus');if(el)el.textContent=`${navigator.onLine?'●':'○'} ${this.status} · Pendientes: ${this.pending} · Conflictos: ${this.blocked}`;
     const t=document.getElementById('amsCloudTools'),c=document.getElementById('amsCloudConflicts');if(t)t.hidden=this.role!=='admin';if(c)c.hidden=!this.blocked;
   },
   stop:async function(){
     clearInterval(this.timer);
     const currentToken=this.token;
     this.token='';this.role='';
     sessionStorage.removeItem(admKey);sessionStorage.removeItem(opKey);
     this.status='Sesión cerrada';this.draw();
     if(currentToken&&navigator.onLine){try{await http('logout',{},currentToken)}catch(e){console.warn('El token expirará del lado servidor',e)}}
   },
   loginFromForm:async function(){
     if(!this.ready){document.getElementById('amsLoginError').textContent='La base todavía no está preparada.';return}
     const name=val('amsLoginName'),guard=val('amsLoginGuard'),shift=val('amsLoginShift'),pin=val('amsLoginPin');
     const err=document.getElementById('amsLoginError');err.textContent='';
     try{
       let token,role;
       if(name==='ADMINISTRADOR'){
         if(!/^[0-9]{6,8}$/.test(pin))throw Error('El PIN debe tener 6 a 8 dígitos.');
         const resp=await http('admin_login',{pin});token=resp.token;role='admin';
         sessionStorage.setItem(admKey,token);
       }else{
         if(!AMS_OPERATORS.includes(name))
  throw Error('Selecciona un usuario válido.');
         const password=document.getElementById('amsOperatorPassword')?.value||'';
         if(password.length<8||password.length>64)throw Error('La contraseña personal debe tener de 8 a 64 caracteres.');
        const login=await http('operator_login',{name,password});
         token=login.token;sessionStorage.setItem(opKey,token);
         document.getElementById('amsOperatorPassword').value='';
         role='operator';
       }
       this.token=token;this.role=role;
       sessionStorage.setItem(AMS_SESSION_KEY,JSON.stringify({name,guard:role==='admin'?'':guard,shift:role==='admin'?'':shift,role,cloud:true,started:new Date().toISOString()}));
       document.getElementById('amsLogin').hidden=true;document.getElementById('amsLoginPin').value='';
       updateSessionHeader();render();this.start();this.status='Sesión iniciada';this.draw();
     }catch(e){err.textContent=e.message||String(e)}
   },
   start:function(){
     clearInterval(this.timer);
     this.sync(true);
     this.timer=setInterval(()=>this.sync(false),Math.max(15,Number(cfg.pollSeconds)||25)*1000);
     if(!this.netListener){this.netListener=true;window.addEventListener('online',()=>this.sync(true));document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.sync(false)})}
   },
   capture:function(){
     if(!this.ready||!this.token)return;
     const base=this.previous;
     tidyIds(state);
     const newer=snap(state);this.previous=newer;
     const changes=[];
     for(const entity of ALL){
       const old=mapOf(entity,base),cur=mapOf(entity,newer);
       for(const [key,data] of cur){
         if(entity==='cargo'&&key.startsWith('TMP-'))continue;
         if(!old.has(key)||JSON.stringify(old.get(key))!==JSON.stringify(data)){
           changes.push({kind:'mutation',opId:uuid(),entity,key,data,deleted:false,actor:currentSession()?.name||'',createdAt:Date.now()+changes.length});
         }
       }
       for(const [key] of old){if(!cur.has(key)&&!(entity==='cargo'&&key.startsWith('TMP-')))changes.push({kind:'mutation',opId:uuid(),entity,key,data:{},deleted:true,actor:currentSession()?.name||'',createdAt:Date.now()+changes.length})}
     }
     if(!changes.length)return;
     // Registro síncrono previo a IndexedDB para proteger los cambios si la pestaña se cierra inmediatamente.
     const earlier=JSON.parse(localStorage.getItem(JOURNAL)||'[]');
     localStorage.setItem(JOURNAL,JSON.stringify([...earlier,...changes]));
     this.captureChain=this.captureChain.then(async()=>{
       for(const c of changes)await dbPut(this.db,c);
       const savedIds=new Set(changes.map(c=>c.opId));
       const remaining=JSON.parse(localStorage.getItem(JOURNAL)||'[]').filter(x=>!savedIds.has(x.opId));
       if(remaining.length)localStorage.setItem(JOURNAL,JSON.stringify(remaining));else localStorage.removeItem(JOURNAL);
       this.status=navigator.onLine?'Cambios guardados; enviando':'Sin internet: cambios pendientes';await this.draw();
       this.sync(false);
     }).catch(e=>{this.status='ERROR GUARDANDO EN COLA: '+e.message;this.draw()});
   },
   saveCache:function(){
     tidyIds(state);this.previous=snap(state);
     try{localStorage.setItem(key,JSON.stringify(state))}catch(e){this.status='ATENCIÓN: caché local llena ('+e.name+')'}
     localStorage.setItem(vKey,JSON.stringify(this.version));
     localStorage.setItem(cKey,String(this.cursor));
   },
   submitNewCargo:async function(status){
     if(!this.ready||!this.token)throw Error('Inicia sesión en la base de datos.');
     syncCargo();const type=cargoType,driver=type==='PR'?[...new Set(cargoLines.map(x=>x.providerName).filter(Boolean))].join(' / '):(val('cargoDriver')||'');
     const record={number:'',docType:type,name:currentSession()?.name||'',driver,providerDni:type==='PR'?cargoProviderDraft.dni:'',providerName:type==='PR'?cargoProviderDraft.name:'',date:now(),updated:now(),materialType:type==='GE'?cargoMaterialType:'',lines:cargoLines.map(x=>({...x})),guard:currentSession()?.guard||'—',shift:currentSession()?.shift||'—',status};
     const opId=uuid(),temp='TMP-'+opId.slice(0,8).toUpperCase();record.number=temp;
     await dbPut(this.db,{kind:'cargo_create',opId,tempKey:temp,payload:{...record,number:''},actor:currentSession()?.name||'',createdAt:Date.now()});
     state.cargo.unshift(record);cargoLastSaved=temp;editingCargoNumber='';cargoLines=[cargoReset()];cargoMaterialType='';cargoProviderDraft={dni:'',name:''};
     addLog('Cargo '+temp+' pendiente de numeración central · '+status);
     this.status='Cargo guardado localmente; pendiente de número oficial';this.draw();this.sync(false);
   },
   sync:async function(manual){
     if(!this.ready||!this.token||this.busy)return;
     if(!navigator.onLine){this.status='SIN CONEXIÓN · datos seguros en este dispositivo';this.draw();return}
     this.busy=true;
     try{
       await this.captureChain;
       const rows=await dbAll(this.db);
       let waitingOtherUser=0;
       for(const row of rows){
         if(row.blocked)continue;
         if(row.actor && row.actor!==currentSession()?.name){waitingOtherUser++;continue;}
         if(row.kind==='cargo_create'){
           const res=await http('cargo_create',{opId:row.opId,payload:row.payload},this.token);
           if(res?.ok){
             await dbDelete(this.db,row.opId);
             const index=state.cargo.findIndex(x=>x.number===row.tempKey);
             if(index>=0){state.cargo.splice(index,1);state.cargo.unshift(res.record)}
             this.version['cargo|'+res.key]=res.version;
             if(cargoLastSaved===row.tempKey)cargoLastSaved=res.key;
             this.saveCache();
           }
           continue;
         }
         const currentVersion=this.version[row.entity+'|'+row.key]||0;
         const resp=await http('push',{operator:currentSession()?.name||'',changes:[{opId:row.opId,entity:row.entity,key:row.key,data:row.data,deleted:row.deleted,baseVersion:currentVersion}]},this.token);
         const ack=resp.results?.[0];
         if(ack?.ok){
           this.version[row.entity+'|'+row.key]=ack.version;
           await dbDelete(this.db,row.opId);
         }else if(ack?.conflict||ack?.error==='CARGO_CERRADO'||ack?.error==='SIN_PERMISO'){
           row.blocked=true;row.reason=ack.error||'Conflicto entre dispositivos';row.server=ack.server||null;row.serverVersion=ack.version||0;
           await dbPut(this.db,row);
         }else throw Error(ack?.error||'SIN_RESPUESTA');
       }
       // Descarga incremental. No sobrescribe ítems con escrituras pendientes.
       const outstanding=await dbAll(this.db);
       const pending=new Set(outstanding.map(x=>x.entity+'|'+x.key));
       let loops=0,changed=false;
       while(loops++<12){
         const data=await http('pull',{cursor:this.cursor},this.token);
         for(const event of data.events||[]){
           const composite=event.entity+'|'+event.record_key;
           if(!pending.has(composite)){assignRecord(event.entity,event.record_key,event.payload||{},event.deleted);changed=true;this.version[composite]=event.version}
         }
         this.cursor=data.cursor;
         if(!data.hasMore)break;
       }
       if(changed){this.saveCache();if(manual&&!document.querySelector('dialog[open]')&&!document.activeElement?.matches('input,select,textarea'))render()}
       else{localStorage.setItem(vKey,JSON.stringify(this.version));localStorage.setItem(cKey,String(this.cursor))}
       this.status=waitingOtherUser?'PENDIENTES DE OTRO RESPONSABLE · inicie su sesión para enviar':'SINCRONIZADO · '+new Date().toLocaleTimeString('es-PE');
     }catch(e){this.status='PENDIENTE / ERROR: '+(e.message||String(e));if(/SESION_NO_AUTORIZADA/.test(this.status)){this.token='';this.role='';sessionStorage.removeItem(admKey);sessionStorage.removeItem(opKey);sessionStorage.removeItem(AMS_SESSION_KEY);showLoginAMS()}}
     finally{this.busy=false;this.draw()}
   },
   tools:async function(){
     if(this.role!=='admin')return;
     const option=prompt('ADMINISTRACIÓN DE BASE\n1 = Generar código para un dispositivo nuevo\n2 = Importar datos de V6 local a Supabase (solo una vez)\n3 = Ver y revocar dispositivos\n4 = Descargar copia JSON actual\n5 = USUARIOS: definir claves, bloquear o habilitar\nElige 1, 2, 3, 4 o 5:','1');
     try{
       if(option==='1'){
         const r=await http('device_issue',{},this.token);
         prompt('Código de activación por 15 minutos (cópialo al otro dispositivo):',r.code);
       }else if(option==='2')await this.importLegacy();
       else if(option==='3'){
         const r=await http('device_list',{},this.token);
         const msg=r.devices.map((x,i)=>`${i+1}. ${x.device_id} · ${x.label||''} ${x.revoked_at?'REVOCADO':'ACTIVO'}`).join('\n');
         const selected=prompt('DISPOSITIVOS:\n'+msg+'\n\nEscribe NÚMERO para revocar o cancelar:','');
         const d=r.devices[Number(selected)-1];if(d&&confirm('¿Revocar acceso del dispositivo '+d.device_id+'?'))await http('device_revoke',{deviceId:d.device_id},this.token);
       }else if(option==='5')await this.manageOperators();
       else if(option==='4'){
         const a=document.createElement('a'),blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),state},null,2)],{type:'application/json'});
         a.href=URL.createObjectURL(blob);a.download='AMS_ACOPIO_RESPALDO_LOCAL_'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2500);
       }
     }catch(e){alert('Error: '+e.message)}
   },
   manageOperators:async function(){
  if(!this.ready || !this.configured){
    alert('La conexión con Supabase V7 no está activa.');
    return;
  }

  let received;

  try {
    if(this.role==='admin' && this.token){
      try {
        received=await http('operator_list',{},this.token);
      } catch(e) {
        if(!String(e.message||e).includes('SESION_NO_AUTORIZADA')){
          throw e;
        }
      }
    }

    if(!received){
      const sesion=currentSession();

      if(sesion?.role!=='admin'){
        alert('Debes iniciar sesión como ADMINISTRADOR.');
        return;
      }

      const pin=prompt('Ingresa nuevamente tu PIN de ADMINISTRADOR:');
      if(pin===null)return;

      const login=await http('admin_login',{pin});

      this.token=login.token;
      this.role='admin';

      sessionStorage.setItem(admKey,login.token);
      sessionStorage.setItem(
        AMS_SESSION_KEY,
        JSON.stringify({...sesion,cloud:true})
      );

      received=await http('operator_list',{},this.token);
      this.draw();
    }

  } catch(e) {
    alert('ERROR DE USUARIOS: '+(e.message||String(e)));
    return;
  }

  const list=received.operators||[];
     if(!list.length)return alert('No se encontraron responsables configurados.');
     const dialog=document.createElement('dialog');dialog.style.cssText='width:min(540px,95vw);max-width:95vw;padding:24px;border:0;border-radius:12px';
     const optionHtml=list.map(x=>'<option value="'+esc(x.name)+'">'+esc(x.name)+'</option>').join('');
     dialog.innerHTML='<h3>USUARIOS · CONTRASEÑAS PERSONALES</h3><p style="font-size:12px">El administrador crea o restablece las claves. Cada responsable debe escribir su contraseña al iniciar sesión, incluso en dispositivos ya activados.</p>'+
       '<div style="border:1px solid #d8e3ed;border-radius:8px;padding:12px;margin-bottom:12px"><b>➕ Agregar nuevo usuario</b><input id="amsOpNewName" maxlength="90" placeholder="Nombres y apellidos" style="width:100%;margin:8px 0"><input id="amsOpInitialPassword" type="password" maxlength="64" placeholder="Contraseña inicial (letras y números)" style="width:100%;margin:4px 0 8px"><button type="button" class="btn" id="amsOpCreate">Crear usuario</button></div>'+
       '<label>Responsable</label><select id="amsOpName">'+optionHtml+'</select>'+
       '<p id="amsOpState" style="font-size:12px;font-weight:650"></p>'+
       '<label>Nueva contraseña (8 a 64 caracteres, letras y números)</label><input id="amsOpNewPassword" type="password" autocomplete="new-password" maxlength="64" placeholder="Nueva contraseña" style="width:100%;margin:6px 0 12px">'+
       '<div style="display:flex;flex-wrap:wrap;gap:9px"><button type="button" class="btn" id="amsOpSave">Guardar nueva clave</button><button type="button" class="btn secondary" id="amsOpToggle">Bloquear usuario</button><button type="button" class="btn secondary" id="amsOpClose">Cerrar</button></div>'+
       '<p id="amsOpFeedback" role="status" style="font-size:12px;margin-top:10px"></p>';
     document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
     const $=id=>dialog.querySelector('#'+id),current=()=>list.find(x=>x.name===$('amsOpName').value);
     const draw=()=>{const x=current();$('amsOpState').textContent=(x?.hasPassword?'CLAVE CONFIGURADA':'SIN CLAVE ASIGNADA')+' · '+(x?.disabled?'BLOQUEADO':'HABILITADO');$('amsOpToggle').textContent=x?.disabled?'Habilitar usuario':'Bloquear usuario';$('amsOpNewPassword').value='';$('amsOpFeedback').textContent=''};
     $('amsOpName').onchange=draw;draw();
     $('amsOpCreate').onclick=async()=>{
       const name=$('amsOpNewName').value.trim().toUpperCase(),password=$('amsOpInitialPassword').value;
       if(!/^[\p{L}\p{M} .'-]{5,90}$/u.test(name)||name==='ADMINISTRADOR'||password.length<8||password.length>64||!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(password)||!/\d/.test(password)){
         $('amsOpFeedback').textContent='Nombre válido y contraseña de 8 a 64 caracteres con letras y números.';return;
       }
       if(!confirm('¿Registrar '+name+' y asignar su contraseña?'))return;
       try{
         await http('operator_create',{name,password},this.token);
         list.push({name,hasPassword:true,disabled:false});
         list.sort((a,b)=>a.name.localeCompare(b.name,'es'));
         $('amsOpName').innerHTML=list.map(x=>'<option value="'+esc(x.name)+'">'+esc(x.name)+'</option>').join('');
         $('amsOpName').value=name;
         $('amsOpNewName').value='';$('amsOpInitialPassword').value='';draw();
         $('amsOpFeedback').textContent='Usuario creado y contraseña configurada en Supabase.';
       }catch(e){$('amsOpFeedback').textContent='Error: '+e.message}
     };
     $('amsOpClose').onclick=()=>dialog.close();
     $('amsOpSave').onclick=async()=>{
       const selected=current(),password=$('amsOpNewPassword').value;
       if(!selected||password.length<8||password.length>64||!/[A-Za-z]/.test(password)||!/\d/.test(password))return $('amsOpFeedback').textContent='La clave requiere 8 a 64 caracteres, al menos una letra y un número.';
       if(!confirm('¿Asignar / restablecer la contraseña de '+selected.name+'? Se cerrarán todas sus sesiones abiertas.'))return;
       try{await http('operator_set_password',{name:selected.name,password},this.token);selected.hasPassword=true;selected.disabled=false;draw();$('amsOpFeedback').textContent='Clave guardada en Supabase. Entrégala al usuario por un medio privado.'}
       catch(e){$('amsOpFeedback').textContent='Error: '+e.message}
     };
     $('amsOpToggle').onclick=async()=>{
       const selected=current(),disabled=!selected.disabled;
       if(!selected||!confirm((disabled?'¿Bloquear':'¿Habilitar')+' a '+selected.name+'?'))return;
       try{await http('operator_set_disabled',{name:selected.name,disabled},this.token);selected.disabled=disabled;draw();$('amsOpFeedback').textContent=disabled?'Usuario bloqueado y sus sesiones revocadas.':'Usuario habilitado.'}
       catch(e){$('amsOpFeedback').textContent='Error: '+e.message}
     };
   },
   importLegacy:async function(){
     const raw=localStorage.getItem('ams-demo-v4');if(!raw)return alert('No hay datos del prototipo V6 en este navegador.');
     // Conserva claves de importación para que un reintento no cree nuevos IDs.
     const preparedKey='ams-cloud-legacy-prepared-v1';
     let original=JSON.parse(localStorage.getItem(preparedKey)||raw);
     tidyIds(original);
     localStorage.setItem(preparedKey,JSON.stringify(original));
     const counts=ARRAY_KEYS.map(k=>`${k}: ${(original[k]||[]).length}`).join('\n');
     if(!confirm('IMPORTACIÓN ÚNICA DE DATOS LOCALES\n'+counts+'\nSolo se importan registros que no existan en la base. Las coincidencias generan conflictos para revisión. ¿Continuar?'))return;
     let n=0;
     for(const e of ALL){
       for(const [key,data] of mapOf(e,original)){
         if(e==='cargo'&&key.startsWith('TMP-'))continue;
         const exists=mapOf(e,state).has(key);if(exists)continue;
         assignRecord(e,key,data,false);
         await dbPut(this.db,{kind:'mutation',opId:uuid(),entity:e,key,data,deleted:false,createdAt:Date.now()+n++});
       }
     }
     this.saveCache();this.status=`Importación preparada: ${n} registros`;this.draw();this.sync(true);
     alert('Preparados '+n+' registros. Revisa el indicador Pendientes y Conflictos antes de borrar nada de V6.');
   },
   conflicts:async function(){
     const list=(await dbAll(this.db)).filter(x=>x.blocked);
     if(!list.length)return alert('No existen conflictos.');
     const msg=list.map((x,i)=>`${i+1}. ${x.entity}/${x.key} · ${x.reason}`).join('\n');
     const selected=prompt('CONFLICTOS PENDIENTES:\n'+msg+'\n\nNúmero de conflicto para revisar:','');
     const row=list[Number(selected)-1];if(!row)return;
     const action=prompt('CONFLICTO '+row.entity+'/'+row.key+'\n1 = DESCARTAR mi cambio y cargar versión servidor\n2 = REINTENTAR usando versión actual del servidor (solo administrador)\n3 = CANCELAR','3');
     if(action==='1'){
       if(!confirm('¿Descartar definitivamente la modificación LOCAL a '+row.key+'?'))return;
       await dbDelete(this.db,row.opId);
       if(row.server)assignRecord(row.entity,row.key,row.server,false);
       else assignRecord(row.entity,row.key,{},true);
       this.version[row.entity+'|'+row.key]=row.serverVersion;
       this.saveCache();render();this.draw();
     }else if(action==='2'&&this.role==='admin'){
       if(!confirm('Puede sobrescribir datos de otro dispositivo. ¿Confirmar reintento?'))return;
       row.blocked=false;this.version[row.entity+'|'+row.key]=row.serverVersion;
       await dbPut(this.db,row);this.sync(true);
     }
   }
 };
 window.AMSCloud=cloud;
 window.amsCloudPersistCargo=function(status){return cloud.submitNewCargo(status)};
 // Ejecuta después de que la interfaz original está montada.
 cloud.boot();
})();
