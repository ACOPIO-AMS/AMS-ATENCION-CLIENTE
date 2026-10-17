// AMS ACOPIO — catálogo DNI / RUC, SOLO CONSULTA.
// Supabase Edge Functions -> nueva función "ams-consultas".
// JWT legacy OFF; la función verifica por sí misma la sesión de usuario.
// Nunca se devuelve un padrón completo ni se publican claves privadas.
import { createClient } from 'npm:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL') || '';
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const origins = (Deno.env.get('AMS_ALLOWED_ORIGINS') || '')
  .split(',').map(x => x.trim()).filter(Boolean);
const db = createClient(url, service, {auth:{persistSession:false,autoRefreshToken:false}});
const encoder = new TextEncoder();
const hex = (a:ArrayBuffer) => Array.from(new Uint8Array(a)).map(x=>x.toString(16).padStart(2,'0')).join('');
const digest = async (v:string) => hex(await crypto.subtle.digest('SHA-256',encoder.encode(v)));

function cors(origin:string) {
  const permitted = origins.includes(origin);
  return {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Vary':'Origin',
    ...(permitted ? {
      'Access-Control-Allow-Origin':origin,
      'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'content-type, authorization'
    }: {})
  };
}
function result(body:unknown,status:number,origin:string) {
  return new Response(JSON.stringify(body),{status,headers:cors(origin)});
}
async function validSession(token:string):Promise<boolean> {
  if(!/^[a-f0-9]{64}$/.test(token))return false;
  const tokenHash=await digest(token),now=new Date().toISOString();
  const {data:admin,error:aErr}=await db.from('ams_sessions')
    .select('role').eq('token_hash',tokenHash).gt('expires_at',now).maybeSingle();
  if(aErr)throw aErr;
  if(admin)return true;
  const {data:session,error:sErr}=await db.from('ams_operator_sessions')
    .select('operator_name').eq('token_hash',tokenHash)
    .is('revoked_at',null).gt('expires_at',now).maybeSingle();
  if(sErr)throw sErr;
  if(!session)return false;
  const {data:account,error:cErr}=await db.from('ams_operator_accounts')
    .select('disabled').eq('operator_name',session.operator_name).maybeSingle();
  if(cErr)throw cErr;
  return Boolean(account && !account.disabled);
}
Deno.serve(async(req:Request)=>{
  const origin=req.headers.get('origin')||'';
  if(origin && !origins.includes(origin))return result({ok:false,error:'ORIGEN_NO_AUTORIZADO'},403,origin);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(origin)});
  if(req.method!=='POST')return result({ok:false,error:'METODO_INVALIDO'},405,origin);
  try {
    if(!url||!service||!origins.length)return result({ok:false,error:'CONFIG_INCOMPLETA'},503,origin);
    const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
    if(!await validSession(token))return result({ok:false,error:'SESION_NO_AUTORIZADA'},401,origin);
    const b=await req.json();
    const tipo=String(b.tipo||''),valor=String(b.valor||'').trim();
    if(tipo==='dni'&&/^\d{8}$/.test(valor)) {
      const {data,error}=await db.from('ams_clientes')
        .select('dni,nombres_apellidos,celular,ocupacion,licencia_conducir,categoria,fecha_vigencia,estado')
        .eq('dni',valor).maybeSingle();
      if(error)throw error;
      return result({ok:true,result:data||null},200,origin);
    }
    if(tipo==='ruc'&&/^\d{11}$/.test(valor)) {
      const {data,error}=await db.from('ams_razon_social')
        .select('ruc,razon_social').eq('ruc',valor).maybeSingle();
      if(error)throw error;
      return result({ok:true,result:data||null},200,origin);
    }
    return result({ok:false,error:'DOCUMENTO_INVALIDO'},400,origin);
  } catch(e) {
    console.error('ams-consultas:',e);
    return result({ok:false,error:'ERROR_CONSULTA'},500,origin);
  }
});
