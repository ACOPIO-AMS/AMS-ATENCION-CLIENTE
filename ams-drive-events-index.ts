// AMS ACOPIO V8.2 - SOLO EVENTOS OPERATIVOS (PERSONAS Y CARGOS)
// Sustituye el index.ts de la función YA EXISTENTE ams-drive-events.
import { createClient } from 'npm:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const expectedToken = Deno.env.get('AMS_DRIVE_SYNC_TOKEN') || '';
const db = createClient(url, serviceKey, {auth:{persistSession:false, autoRefreshToken:false}});
const reply = (data:unknown, status=200)=>new Response(JSON.stringify(data),{
  status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
});
const encoder = new TextEncoder();
async function tokenDigest(value:string){
  const h = await crypto.subtle.digest('SHA-256',encoder.encode(value));
  return Array.from(new Uint8Array(h)).map(x=>x.toString(16).padStart(2,'0')).join('');
}

Deno.serve(async (request:Request)=>{
  if(request.method!=='POST')return reply({ok:false,error:'METODO_NO_PERMITIDO'},405);
  if(!url||!serviceKey||!expectedToken)return reply({ok:false,error:'CONFIGURACION_INCOMPLETA'},503);
  const provided = request.headers.get('x-ams-drive-token')||'';
  if(!provided||await tokenDigest(provided)!==await tokenDigest(expectedToken))return reply({ok:false,error:'NO_AUTORIZADO'},401);
  try{
    const body = await request.json();
    if(body.action==='pending'){
      // No consumir ni confirmar eventos de otras entidades.
      // Resuelve bloqueo por logs/limpiezas/servicios fuera del mapeo.
      const {data,error} = await db.from('ams_drive_events')
        .select('id,entity,record_key,action,previous_payload,new_payload,version,deleted,changed_by,changed_at')
        .eq('sync_status','PENDIENTE')
        .in('entity',['people','cargo'])
        .order('id',{ascending:true}).limit(100);
      if(error)throw error;
      return reply({ok:true,total:data?.length||0,events:data||[]});
    }
    if(body.action==='ack'){
      const ids = body.ids;
      if(!Array.isArray(ids)||ids.length===0||ids.length>100||
        !ids.every((x:unknown)=>Number.isSafeInteger(x)&&x>0)||new Set(ids).size!==ids.length)
        return reply({ok:false,error:'IDS_INVALIDOS'},400);
      const {data,error}=await db.from('ams_drive_events')
        .update({sync_status:'SINCRONIZADO',synced_at:new Date().toISOString(),error_message:null})
        .in('id',ids).in('entity',['people','cargo']).eq('sync_status','PENDIENTE')
        .select('id');
      if(error)throw error;
      return reply({ok:true,confirmados:data?.length||0});
    }
    return reply({ok:false,error:'ACCION_INVALIDA'},400);
  }catch(error){
    console.error('AMS DRIVE V8.2',error);
    return reply({ok:false,error:'ERROR_INTERNO'},500);
  }
});
