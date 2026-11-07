// Script de diagnóstico para verificar que todas las claves API y proveedores de Supabase funcionan
async function main() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const secretKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('🔍 Verificando conexión y claves API de Supabase...\n');

  // 1. Probar clave pública (Publishable / Anon Key) en Auth Settings
  const authRes = await fetch(`${url}/auth/v1/settings`, {
    headers: { apikey: anonKey },
  });

  if (!authRes.ok) {
    console.error(`❌ Clave Pública (Anon Key): FALLÓ (${authRes.status} ${authRes.statusText})`);
  } else {
    const authSettings = await authRes.json();
    console.log('✅ 1. Clave Pública (SUPABASE_ANON_KEY): FUNCIONANDO');
    console.log(`   - Registro de nuevos usuarios (allow_signup): ${!authSettings.disable_signup ? '🟢 ACTIVADO' : '🔴 DESACTIVADO (¡Ojo! Activalo para que entre Google)'}`);
    console.log(`   - Proveedor Email/Contraseña: ${authSettings.external?.email ? '🟢 ACTIVADO' : '🔴 DESACTIVADO'}`);
    console.log(`   - Proveedor Google OAuth: ${authSettings.external?.google ? '🟢 ACTIVADO Y CONFIGURADO' : '🟡 AÚN NO ACTIVADO EN SUPABASE'}`);
  }

  // 2. Probar clave secreta (Secret / Service Role Key) leyendo tabla protegida settings
  const secretRes = await fetch(`${url}/rest/v1/settings?select=key`, {
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    },
  });

  if (!secretRes.ok) {
    console.error(`❌ 2. Clave Secreta (SUPABASE_SERVICE_ROLE_KEY): FALLÓ (${secretRes.status})`);
  } else {
    const rows = await secretRes.json();
    console.log(`✅ 2. Clave Secreta (SUPABASE_SERVICE_ROLE_KEY): FUNCIONANDO (${rows.length} parámetros leídos en settings)`);
  }

  // 3. Si Google está activo, verificar que la redirección a Google OAuth tenga un Client ID válido
  const googleRedirect = await fetch(`${url}/auth/v1/authorize?provider=google`, {
    redirect: 'manual',
  });
  const location = googleRedirect.headers.get('location') || '';
  if (location.includes('accounts.google.com') && location.includes('client_id=')) {
    console.log('✅ 3. Redirección a Google OAuth: FUNCIONANDO (redirige correctamente a accounts.google.com)');
  } else {
    console.log('🟡 3. Redirección a Google OAuth: Todavía falta guardar el Client ID y Secret de Google en Supabase.');
  }
}

main().catch((err) => {
  console.error('❌ Error ejecutando diagnóstico:', err.message);
  process.exit(1);
});
