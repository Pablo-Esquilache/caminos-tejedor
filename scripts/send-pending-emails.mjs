import pg from 'pg';

const { Client } = pg;

/**
 * Despachador de notificaciones por correo electrónico mediante la API HTTPS de Brevo.
 * Registra el resultado en las columnas email_sent_at y email_error de public.notifications.
 * Si falla el correo o no hay BREVO_API_KEY configurada, el aviso In-App ya quedó entregado
 * sin bloquear la operación principal.
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const brevoApiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'caminostejedor@gmail.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'Caminos Rurales Carlos Tejedor';

  if (!databaseUrl) {
    console.error('❌ Falta DATABASE_URL en .env');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    // Si tenemos BREVO_API_KEY en el entorno, sincronizarla en public.private_secrets
    // para que el trigger automático pg_net de Supabase también pueda despachar en tiempo real.
    if (brevoApiKey) {
      await client.query(
        `
        INSERT INTO public.private_secrets (key, value, updated_at)
        VALUES ('brevo_api_key', $1, now()),
               ('brevo_sender_email', $2, now()),
               ('brevo_sender_name', $3, now())
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value,
              updated_at = now();
        `,
        [brevoApiKey, senderEmail, senderName]
      ).catch(() => {});
    }

    const pendingRes = await client.query(`
      SELECT
        n.id,
        n.user_id,
        n.type,
        n.title,
        n.body,
        p.email AS recipient_email,
        COALESCE(p.full_name, 'Vecino') AS recipient_name
      FROM public.notifications n
      JOIN public.profiles p ON p.id = n.user_id
      WHERE n.email_sent_at IS NULL
        AND p.email IS NOT NULL
        AND p.email NOT LIKE '%@tejedor.test'
      ORDER BY n.created_at ASC
      LIMIT 30;
    `);

    if (pendingRes.rows.length === 0) {
      console.log('ℹ️ No hay notificaciones pendientes de envío por correo.');
      return;
    }

    if (!brevoApiKey) {
      console.log(
        `ℹ️ Hay ${pendingRes.rows.length} notificación(es) entregada(s) en la bandeja In-App. (Configurá BREVO_API_KEY en .env cuando quieras activar también el despacho por email vía Brevo).`
      );
      return;
    }

    for (const row of pendingRes.rows) {
      try {
        const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'api-key': brevoApiKey,
          },
          body: JSON.stringify({
            sender: { name: senderName, email: senderEmail },
            to: [{ email: row.recipient_email, name: row.recipient_name }],
            subject: `[Caminos Tejedor] ${row.title}`,
            htmlContent: `
              <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:12px;">
                <h2 style="color:#1e4d38;margin-top:0;">${row.title}</h2>
                <p style="font-size:15px;color:#111827;line-height:1.5;">${row.body}</p>
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
                <small style="color:#6b7280;">Sistema de Relevamiento y Gestión Vial Rural — Partido de Carlos Tejedor</small>
              </div>
            `,
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errText}`);
        }

        await client.query(
          `UPDATE public.notifications SET email_sent_at = now(), email_error = NULL WHERE id = $1`,
          [row.id]
        );
        console.log(`✅ Email enviado a ${row.recipient_email}: ${row.title}`);
      } catch (err) {
        await client.query(
          `UPDATE public.notifications SET email_error = $2 WHERE id = $1`,
          [row.id, err.message]
        );
        console.warn(`⚠️ Error enviando email para notificación ${row.id}: ${err.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error en send-pending-emails:', err);
  process.exit(1);
});
