-- =============================================================================
-- Migración 010: Despacho automático de correos con Brevo (pg_net) y resumen semanal (pg_cron)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1. Tabla privada de secretos del servidor (100% bloqueada para anon y authenticated)
CREATE TABLE IF NOT EXISTS public.private_secrets (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.private_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.private_secrets FROM PUBLIC;
REVOKE ALL ON TABLE public.private_secrets FROM anon;
REVOKE ALL ON TABLE public.private_secrets FROM authenticated;

-- 2. Trigger en public.notifications para despachar correo vía Brevo (pg_net) en tiempo real
CREATE OR REPLACE FUNCTION public.fn_dispatch_notification_email_brevo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_api_key text;
  v_sender_email text;
  v_sender_name text;
  v_recipient_email text;
  v_recipient_name text;
  v_payload jsonb;
BEGIN
  -- Si ya fue enviado, no hacer nada
  IF NEW.email_sent_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Buscar email del destinatario
  SELECT p.email, COALESCE(p.full_name, 'Vecino')
  INTO v_recipient_email, v_recipient_name
  FROM public.profiles p
  WHERE p.id = NEW.user_id;

  -- Ignorar cuentas ficticias de test (@tejedor.test) o sin email
  IF v_recipient_email IS NULL OR v_recipient_email LIKE '%@tejedor.test' THEN
    RETURN NEW;
  END IF;

  -- Obtener API Key de Brevo desde private_secrets
  SELECT value INTO v_api_key
  FROM public.private_secrets
  WHERE key = 'brevo_api_key';

  IF v_api_key IS NULL OR btrim(v_api_key) = '' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(
    (SELECT value FROM public.private_secrets WHERE key = 'brevo_sender_email'),
    'caminostejedor@gmail.com'
  ) INTO v_sender_email;

  SELECT COALESCE(
    (SELECT value FROM public.private_secrets WHERE key = 'brevo_sender_name'),
    'Caminos Rurales Carlos Tejedor'
  ) INTO v_sender_name;

  v_payload := jsonb_build_object(
    'sender', jsonb_build_object('name', v_sender_name, 'email', v_sender_email),
    'to', jsonb_build_array(jsonb_build_object('email', v_recipient_email, 'name', v_recipient_name)),
    'subject', '[Caminos Tejedor] ' || NEW.title,
    'htmlContent',
      '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:12px;">' ||
      '<h2 style="color:#1e4d38;margin-top:0;">' || NEW.title || '</h2>' ||
      '<p style="font-size:15px;color:#111827;line-height:1.5;">' || NEW.body || '</p>' ||
      '<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />' ||
      '<small style="color:#6b7280;">Sistema de Relevamiento y Gestión Vial Rural — Partido de Carlos Tejedor</small>' ||
      '</div>'
  );

  BEGIN
    PERFORM net.http_post(
      url := 'https://api.brevo.com/v3/smtp/email',
      body := v_payload,
      headers := jsonb_build_object(
        'accept', 'application/json',
        'content-type', 'application/json',
        'api-key', v_api_key
      )
    );
    NEW.email_sent_at := now();
    NEW.email_error := NULL;
  EXCEPTION WHEN OTHERS THEN
    NEW.email_error := SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dispatch_notification_email_brevo ON public.notifications;
CREATE TRIGGER trg_dispatch_notification_email_brevo
BEFORE INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.fn_dispatch_notification_email_brevo();
