// Crea un usuario de prueba "Vecino Común" (sin permisos de Admin) en Supabase Auth
async function main() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const testEmail = 'vecino@tejedor.test';
  const testPassword = 'vecino1234';

  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { full_name: 'Juan Pérez (Vecino Rural)' },
    }),
  });

  const data = await res.json();
  if (res.ok) {
    console.log(`✅ Usuario Vecino creado: ${testEmail} / ${testPassword} (id: ${data.id})`);
  } else {
    console.log(`ℹ️ Respuesta Auth Admin (${res.status}):`, data.msg || data.message || JSON.stringify(data));
  }
}

main().catch(console.error);
