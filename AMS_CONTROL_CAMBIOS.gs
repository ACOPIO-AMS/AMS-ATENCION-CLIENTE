/**
 * AMS ACOPIO V8.2 - PUENTE DE EVENTOS SUPABASE A GOOGLE SHEETS
 * Fuente: ams-drive-events (pending/ack)
 * Destino: MATRIZ, BD SALIDAS, BD SALIDAS CARGO.
 * Solo maneja registros NUEVOS emitidos después del corte V8.2.
 * Conservar histórico: NO vincula registros previos al corte.
 * Por seguridad la escritura está BLOQUEADA hasta habilitación explícita.
 */
const AMSV82 = Object.freeze({
  spreadsheetId:'1wNLHyRGZ8zXvL7w0f-rsfkPEdMLTFpoP60srEjo4Ob0',
  endpoint:'https://oxadhudyjkviidnwyzpf.supabase.co/functions/v1/ams-drive-events',
  maxPerRun:40
});

function AMS_V82_previsualizarSincronizacion() {
  return AMSV82_main_(true);
}

function AMS_V82_sincronizarRegistrosNuevos() {
  if(PropertiesService.getScriptProperties().getProperty('AMS_V82_APLICAR')!=='SI')
    throw new Error('ESCRITURA BLOQUEADA: falta AMS_V82_APLICAR=SI. Primero revisar la previsualización.');
  return AMSV82_main_(false);
}

function AMSV82_main_(dryRun) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(3000))throw new Error('Otra sincronización está en ejecución.');
  try {
    const props=PropertiesService.getScriptProperties();
    const corte=Date.parse(props.getProperty('AMS_V82_CORTE_UTC')||'');
    if(!Number.isFinite(corte))throw new Error('Falta corte de registros AMS_V82_CORTE_UTC.');
    const token=props.getProperty('AMS_DRIVE_SYNC_TOKEN');
    if(!token)throw new Error('Falta AMS_DRIVE_SYNC_TOKEN.');
    const ss=SpreadsheetApp.openById(AMSV82.spreadsheetId);
    const events=AMSV82_api_(token,{action:'pending'}).events||[];
    const summary={modo:dryRun?'SOLO LECTURA':'APLICACION',
      disponibles:events.length,procesados:0,sincronizados:0,omitidos:0,errores:[],detalle:[]};
    // No agregamos nuevas filas ni modificamos hojas durante la simulación.
    for(const ev of events.slice(0,AMSV82.maxPerRun)){
      const prev=ev.previous_payload||{}, next=ev.new_payload||{};
      const payload=ev.action==='ELIMINAR'?prev:next;
      const entidad=String(ev.entity||'');
      const doc=entidad==='cargo'?String(payload.docType||''):'';
      const hojaNombre=entidad==='people'?'MATRIZ':entidad==='cargo'?(doc==='GE'?'BD SALIDAS CARGO':['CH','PR'].includes(doc)?'BD SALIDAS':'') : '';
      const target=hojaNombre&&ss.getSheetByName(hojaNombre);
      const items=entidad==='people'?[payload]:Array.isArray(payload.lines)?payload.lines:[];
      const clave=String(ev.record_key||'');
      const existing=target&&clave?AMSV82_enlaces_(target,entidad,clave):new Map();
      const newRecord=ev.action==='CREAR' && Date.parse(ev.changed_at||'')>=corte;
      const sourceKey=entidad+'|'+clave;
      let resultado='';
      if(!target) resultado='SIN_MAPEO';
      else if(!clave)resultado='SIN_CLAVE';
      else if(!items.length)resultado='SIN_ITEMS';
      else if(!existing.size&&!newRecord)resultado='SIN_VINCULO (registro histórico o edición sin alta)';
      else if(ev.action==='CREAR'&&!newRecord&&!existing.size)resultado='ANTERIOR_AL_CORTE';
      else resultado=existing.size?'ACTUALIZAR VINCULADOS':'CREAR VINCULOS NUEVOS';
      const info={evento:ev.id,identificador:sourceKey,accion:ev.action,hoja:hojaNombre||'—',items:items.length,vinculos:existing.size,resultado};
      summary.detalle.push(info);summary.procesados++;
      if(!['ACTUALIZAR VINCULADOS','CREAR VINCULOS NUEVOS'].includes(resultado)){
        summary.omitidos++;continue;
      }
      if(dryRun)continue;
      try {
        AMSV82_escribir_(target,entidad,clave,doc,payload,items,ev,existing);
        SpreadsheetApp.flush();
        // Solo confirmar a Supabase DESPUÉS de aplicar y confirmar todas las filas.
        const ack=AMSV82_api_(token,{action:'ack',ids:[ev.id]});
        if(ack.confirmados!==1)throw new Error('La API no confirmó el evento '+ev.id);
        summary.sincronizados++;
      } catch(e) {
        summary.errores.push({evento:ev.id,error:String(e.message||e)});
        // No se ACK; la siguiente ejecución reintentará usando vínculos ya escritos.
        break;
      }
    }
    Logger.log(JSON.stringify(summary,null,2));
    return summary;
  } finally {lock.releaseLock();}
}

function AMSV82_api_(token,body){
  const resp=UrlFetchApp.fetch(AMSV82.endpoint,{method:'post',contentType:'application/json',
    headers:{'x-ams-drive-token':token},payload:JSON.stringify(body),muteHttpExceptions:true});
  let obj;try{obj=JSON.parse(resp.getContentText())}catch(_){throw new Error('Respuesta inválida Supabase HTTP '+resp.getResponseCode())}
  if(resp.getResponseCode()!==200||!obj.ok)throw new Error('Supabase '+resp.getResponseCode()+': '+(obj.error||'ERROR'));
  return obj;
}

function AMSV82_enlaces_(hoja,entidad,clave){
  const filas=hoja.getLastRow()-1;
  const found=new Map();
  if(filas<1)return found;
  const notes=hoja.getRange(2,1,filas,1).getNotes();
  const base='AMS2|'+entidad+'|'+clave+'|';
  for(let i=0;i<notes.length;i++){
    const note=String(notes[i][0]||'');
    if(!note.startsWith(base))continue;
    const n=note.slice(base.length).split('|')[0];
    if(!/^\d+$/.test(n))continue;
    if(found.has(Number(n)))throw new Error('Vínculo duplicado '+base+n);
    found.set(Number(n),i+2);
  }
  return found;
}

function AMSV82_parseFecha_(value){
  const s=String(value||'').trim();
  const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(.*)$/);
  if(!m)return value||'';
  let h=Number(m[4]);const suf=String(m[7]||'').toLowerCase();
  if(/p\.?\s*m/.test(suf)&&h<12)h+=12;
  if(/a\.?\s*m/.test(suf)&&h===12)h=0;
  // Perú utiliza UTC-5 durante todo el año; almacenar instante real en UTC.
  const dt=new Date(Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]),h+5,Number(m[5]),Number(m[6]||0)));
  return Number.isFinite(dt.getTime())?dt:value;
}

function AMSV82_row_(entidad,doc,payload,line,index,ev){
  const status=ev.action==='ANULAR'?'ANULADO':ev.action==='ELIMINAR'?'ELIMINADO':String(payload.status||'');
  if(entidad==='people'){
    // MATRIZ: A-Q. Los campos posteriores quedan SIN TOCAR.
    // A: identificador estable para nuevos registros, independiente del DNI.
    return ['AMS-'+ev.record_key,AMSV82_parseFecha_(payload.entry),payload.dni||'',payload.name||'',
      payload.phone||'',payload.type||'',payload.motive||'',payload.plate||'',payload.zone||'',
      payload.license||'',payload.licensecat||'',payload.lots||'',payload.load||'',payload.lotCode||'',
      payload.guard||'',payload.shift||'',payload.responsible||''];
  }
  if(doc==='GE'){
    const obs=String(line.notes||'');
    const extra=['ANULADO','ELIMINADO'].includes(status)?' [AMS: '+status+']':'';
    return [payload.number||ev.record_key,payload.materialType||line.type||'',line.description||'',
      line.reason||'',line.quantity||'',line.unit||'',obs+extra,
      AMSV82_parseFecha_(payload.date),payload.name||'',payload.driver||''];
  }
  return [payload.number||ev.record_key,line.type||'',line.code||'',
    AMSV82_parseFecha_(payload.date),payload.name||'',payload.driver||line.providerName||'',
    line.notes||'',status==='INCOMPLETO'?'PENDIENTE':status==='COMPLETO'?'ENVIADO':status||'ENVIADO'];
}

function AMSV82_escribir_(hoja,entity,clave,doc,payload,items,ev,linked){
  const oldCount=linked.size;
  if(oldCount && linked.size!==items.length) {
    throw new Error('Cambio del número de ítems requiere revisión manual. No se eliminan filas automáticamente.');
  }
  for(let idx=0;idx<items.length;idx++){
    const row=AMSV82_row_(entity,doc,payload,items[idx],idx,ev);
    let destination=linked.get(idx);
    if(!destination){
      if(ev.action!=='CREAR')throw new Error('Falta vínculo ítem '+idx+' del registro '+clave);
      // ÚNICAMENTE agrega filas NUEVAS a la hoja de destino.
      destination=hoja.getLastRow()+1;
      hoja.getRange(destination,1,1,row.length).setValues([row]);
      hoja.getRange(destination,1).setNote('AMS2|'+entity+'|'+clave+'|'+idx+'|ACTIVO');
    } else {
      // Verificar marcador ANTES de editar una fila existente.
      const note=hoja.getRange(destination,1).getNote();
      if(!note.startsWith('AMS2|'+entity+'|'+clave+'|'+idx+'|'))throw new Error('Vínculo alterado en la fila '+destination);
      // CH/PR: conservar columnas I y J (recepción y responsable).
      // MATRIZ: conservar columnas R en adelante y celdas externas.
      hoja.getRange(destination,1,1,row.length).setValues([row]);
      if(['ANULAR','ELIMINAR'].includes(ev.action)){
        hoja.getRange(destination,1,1,row.length).setBackground(ev.action==='ANULAR'?'#FFF1CC':'#E5E7EB');
        hoja.getRange(destination,1).setNote('AMS2|'+entity+'|'+clave+'|'+idx+'|'+ev.action);
      } else {
        hoja.getRange(destination,1).setNote('AMS2|'+entity+'|'+clave+'|'+idx+'|ACTIVO');
      }
    }
    if(['ANULAR','ELIMINAR'].includes(ev.action) && !linked.has(idx)) {
      hoja.getRange(destination,1,1,row.length).setBackground(ev.action==='ANULAR'?'#FFF1CC':'#E5E7EB');
    }
    const dateColumn=entity==='people'?2:doc==='GE'?8:4;
    if(row[dateColumn-1] instanceof Date)
      hoja.getRange(destination,dateColumn).setNumberFormat('dd/MM/yyyy HH:mm:ss');
  }
}


/**
 * ACTIVACIÓN ÚNICA, sin añadir nuevos activadores ni archivos.
 * Antes de usar, ejecutar AMS_V82_previsualizarSincronizacion.
 * No habilitar sin aprobar prueba real en un registro de ensayo.
 */
function AMS_V82_habilitarEscritura() {
  const p=PropertiesService.getScriptProperties();
  if (!p.getProperty('AMS_DRIVE_SYNC_TOKEN')) throw new Error('Falta AMS_DRIVE_SYNC_TOKEN');
  if (!p.getProperty('AMS_V82_CORTE_UTC')) throw new Error('Falta AMS_V82_CORTE_UTC');
  if (typeof AMS_sincronizarCatalogos!=='function') throw new Error('No se encuentra la sincronización de catálogos original.');
  const preview=AMS_V82_previsualizarSincronizacion();
  if(preview.errores?.length||preview.detalle?.some(x=>x.resultado==='SIN_CLAVE'))
    throw new Error('Hay errores de diagnóstico; no se habilita escritura.');
  p.setProperty('AMS_V82_APLICAR','SI');
  Logger.log('AMS V8.2 habilitada. Sincronización operativa pendiente de prueba real.');
}

/** Una sola función para la programación cada 10 minutos. */
function AMS_V82_cicloUnico() {
  let rDrive=null, errorDrive=null, rCatalog=null;
  try { rDrive=AMS_V82_sincronizarRegistrosNuevos(); }
  catch(e) { errorDrive=String(e.message||e); }
  // Siempre mantener los catálogos, incluso si hay errores en eventos.
  rCatalog=AMS_sincronizarCatalogos();
  const resumen={drive:rDrive,catalogos:rCatalog,errorDrive};
  Logger.log(JSON.stringify(resumen));
  if(errorDrive)throw new Error('Eventos Drive pendientes: '+errorDrive);
  return resumen;
}

/** Instala solo un trigger para catálogos + correcciones, preservando los ajenos. */
function AMS_V82_instalarActivadorUnico() {
  const p=PropertiesService.getScriptProperties();
  if(p.getProperty('AMS_V82_APLICAR')!=='SI') throw new Error('Prueba y habilita AMS_V82_APLICAR antes de programar.');
  const manejadas=['AMS_sincronizarCatalogos','AMS_V82_cicloUnico','AMS_V82_sincronizarRegistrosNuevos'];
  ScriptApp.getProjectTriggers().filter(t=>manejadas.includes(t.getHandlerFunction()))
    .forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('AMS_V82_cicloUnico').timeBased().everyMinutes(10).create();
  Logger.log('Un único activador cada 10 minutos: AMS_V82_cicloUnico.');
}
