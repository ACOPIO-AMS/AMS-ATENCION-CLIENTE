/**
 * AMS ACOPIO → MATRIZ PROVEEDORES (PROYECTO AUTÓNOMO)
 * Fuente: Supabase ams-api-v7 / backup_pull, SOLO LECTURA.
 * Libro de Google Sheets abierto por ID, apto para Apps Script independiente.
 * Destino visible EXCLUSIVO: BD SALIDAS (cargos CH y PR).
 * MATRIZ y PROCESOS - GUIAS NO SE ESCRIBEN.
 * Las demás entidades quedan preservadas en _AMS_EVENTOS, dentro de ESTE libro.
 * Jamás elimina registros históricos ni altera PROCESOS - GUIAS ni otros scripts.
 * Implementación por Ing. de procesos; validar primera ejecución con datos de prueba.
 * Propiedades del script: AMS2_API_URL y AMS2_BACKUP_TOKEN.
 */
const AMS2_CFG = {
  matriz: 'MATRIZ',
  salidas: 'BD SALIDAS',
  eventos: '_AMS_EVENTOS',
  cursor: 'AMS2_ULTIMA_SECUENCIA',
  maxEventos: 200,
};

function AMS2_instalar() {
  const ss = SpreadsheetApp.openById('1wNLHyRGZ8zXvL7w0f-rsfkPEdMLTFpoP60srEjo4Ob0');
  if (!ss.getSheetByName(AMS2_CFG.matriz) || !ss.getSheetByName(AMS2_CFG.salidas)) {
    throw new Error('No encuentro MATRIZ y/o BD SALIDAS. Abre Apps Script DESDE MATRIZ PROVEEDORES.');
  }
  AMS2_credenciales_();
  const sh = AMS2_eventos_(ss);
  const tareas = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'AMS2_actualizar');
  tareas.forEach(t => ScriptApp.deleteTrigger(t)); // no modifica otros triggers
  ScriptApp.newTrigger('AMS2_actualizar').timeBased().everyMinutes(10).create();
  console.log('Configurado en el MISMO libro: '+ss.getName()+'; respaldo cada 10 minutos.');
}

function AMS2_probarConexion() {
  const resultado = AMS2_pedir_(0);
  console.log('API disponible. Eventos primera página: '+(resultado.events||[]).length);
}

function AMS2_actualizar() {
  const bloqueo=LockService.getScriptLock();
  if (!bloqueo.tryLock(1000)) return; // nunca esperar a otros scripts
  try {
    const ss=SpreadsheetApp.openById('1wNLHyRGZ8zXvL7w0f-rsfkPEdMLTFpoP60srEjo4Ob0');
    const matriz=ss.getSheetByName(AMS2_CFG.matriz);
    const salidas=ss.getSheetByName(AMS2_CFG.salidas);
    if (!matriz||!salidas) throw new Error('Faltan las hojas MATRIZ y BD SALIDAS.');
    const audit=AMS2_eventos_(ss);
    const prop=PropertiesService.getScriptProperties();
    let cursor=Number(prop.getProperty(AMS2_CFG.cursor)||0);
    const primero=AMS2_pedir_(cursor);
    const eventos=(primero.events||[]).filter(e=>Number(e.seq)>cursor).slice(0,AMS2_CFG.maxEventos);
    if (!eventos.length) {console.log('AMS2: sin cambios desde '+cursor);return;}
    const indices={ salidas:AMS2_indiceNotas_(salidas) };
    const nuevos=[];
    for (const ev of eventos) {
      if (!ev.deleted && ev.entity==='cargo') AMS2_cargo_(salidas,indices.salidas,ev);
      const json=JSON.stringify(ev.payload??{});
      if (json.length>49000)throw new Error('El evento '+ev.seq+' excede 49 000 caracteres: NO se avanzó el cursor.');
      nuevos.push([Number(ev.seq),String(ev.changed_at||''),String(ev.entity||''),String(ev.record_key||''),Number(ev.version)||0,ev.deleted?'SI':'NO',AMS2_safe_(json),String(ev.changed_by||'')]);
    }
    // Registrar TODOS los módulos en la pestaña técnica del mismo archivo.
    // Evitar repetir secuencias si una ejecución anterior terminó a medias.
    const ult=AMS2_ultimoSeq_(audit);
    const porAgregar=nuevos.filter(r=>r[0]>ult);
    if(porAgregar.length) audit.getRange(audit.getLastRow()+1,1,porAgregar.length,8).setValues(porAgregar);
    SpreadsheetApp.flush();
    cursor=Number(eventos[eventos.length-1].seq);
    prop.setProperty(AMS2_CFG.cursor,String(cursor));
    console.log('AMS2: '+eventos.length+' eventos procesados, último '+cursor+'. Restan más: '+Boolean(primero.hasMore));
  }finally{bloqueo.releaseLock();}
}

function AMS2_credenciales_() {
  const props=PropertiesService.getScriptProperties();
  const url=String(props.getProperty('AMS2_API_URL')||'');
  const token=String(props.getProperty('AMS2_BACKUP_TOKEN')||'');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/ams-api-v7\/?$/.test(url))
    throw new Error('Configura AMS2_API_URL con la URL pública de ams-api-v7.');
  if(token.length<32) throw new Error('Configura AMS2_BACKUP_TOKEN, igual a AMS_BACKUP_TOKEN en Supabase (mínimo 32 caracteres).');
  return {url,token};
}
function AMS2_pedir_(cursor) {
  const {url,token}=AMS2_credenciales_();
  const res=UrlFetchApp.fetch(url,{
    method:'post',contentType:'application/json',
    headers:{'x-backup-token':token},
    payload:JSON.stringify({action:'backup_pull',cursor}),
    muteHttpExceptions:true,
  });
  if(res.getResponseCode()!==200)throw new Error('Supabase HTTP '+res.getResponseCode()+': '+res.getContentText().slice(0,160));
  const data=JSON.parse(res.getContentText());
  if(!data.ok||!Array.isArray(data.events))throw new Error(data.error||'Respuesta inesperada de backup_pull');
  return data;
}
function AMS2_eventos_(ss) {
  let sh=ss.getSheetByName(AMS2_CFG.eventos);
  if(!sh){
    sh=ss.insertSheet(AMS2_CFG.eventos);
    sh.getRange(1,1,1,8).setValues([['SEQ','FECHA SERVIDOR','ENTIDAD','ID ORIGEN','VERSIÓN','ELIMINADO','JSON COMPLETO','RESPONSABLE']]);
    sh.getRange('A1:H1').setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideSheet(); // solo metadatos en la MISMA hoja de cálculo
  }
  return sh;
}
function AMS2_ultimoSeq_(sh) {
  if(sh.getLastRow()<2)return 0;
  return Number(sh.getRange(sh.getLastRow(),1).getValue())||0;
}
function AMS2_safe_(v) {
  const s=String(v??'');
  return /^[=+@\t\r]/.test(s)?"'"+s:s; // evita inyección de fórmulas en Sheets
}
function AMS2_indiceNotas_(sh) {
  const max=sh.getLastRow();
  const mapa=new Map();
  if(max<2)return mapa;
  const notes=sh.getRange(2,1,max-1,1).getNotes();
  notes.forEach((arr,i)=>{const txt=String(arr[0]||'');if(txt.startsWith('AMS2|'))mapa.set(txt,2+i)});
  return mapa;
}
function AMS2_siguiente_(sh,indices) {
  // Fila posterior al último ID real de la columna A.
  const hasta=Math.max(sh.getLastRow(),1);
  const vals=sh.getRange(1,1,hasta,1).getDisplayValues();
  for(let i=vals.length-1;i>=0;i--)if(String(vals[i][0]).trim())return i+2;
  return 2;
}
function AMS2_colocar_(sh,mapa,key,values,ancho) {
  const marca='AMS2|'+key;
  let row=mapa.get(marca);
  if(!row){
    row=AMS2_siguiente_(sh,mapa);
    if(row>sh.getMaxRows())sh.insertRowsAfter(sh.getMaxRows(),Math.max(50,row-sh.getMaxRows()));
    // Guardar marca en nota para no duplicar en futuras sincronizaciones.
    sh.getRange(row,1).setNote(marca);
    mapa.set(marca,row);
  }
  const ran=sh.getRange(row,1,1,ancho);
  const prev=ran.getValues()[0], formul=ran.getFormulas()[0];
  const changed=new Set();
  for(const [i,val] of Object.entries(values)){
    const n=Number(i);
    // Nunca borrar un valor previo por un vacío de Supabase.
    if(n>=0&&n<ancho&&val!==undefined&&val!==null&&val!==''){prev[n]=typeof val==='number'?val:AMS2_safe_(val);changed.add(n);}
  }
  for(let i=0;i<ancho;i++)if(formul[i]&&!changed.has(i))prev[i]=formul[i];
  ran.setValues([prev]);
  return row;
}
function AMS2_cargo_(sh,mapa,ev) {
  const c=ev.payload||{};if(!['CH','PR'].includes(c.docType))return;
  const lines=Array.isArray(c.lines)?c.lines:[];
  lines.forEach((l,i)=>{
    const vals={
      0:c.number||ev.record_key,1:l.type,2:l.code,3:c.date,4:c.name,
      5:c.driver||c.providerName,6:l.notes,
    };
    // Solo poner estado en filas NUEVAS. Si la oficina ya marcó RECIBIDO, no tocar.
    const key='cargo|'+ev.record_key+'|'+i;
    if(!mapa.has('AMS2|'+key))vals[7]=(c.status==='COMPLETO'?'ENVIADO':'INCOMPLETO');
    AMS2_colocar_(sh,mapa,key,vals,10);
  });
}
