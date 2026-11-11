-- =============================================================================
-- Migración 017: Fase 14 - Sumar Trabajos Viales Pendientes al Resumen Semanal
-- Unificado de Brevo (generate_weekly_pending_summary)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.generate_weekly_pending_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending_trips integer;
  v_pending_claims integer;
  v_pending_interventions integer;
  v_suspended_interventions integer;
  v_admin record;
  v_sent_count integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permiso denegado: solo administradores.';
  END IF;

  SELECT count(*)::int INTO v_pending_trips
  FROM public.trips
  WHERE status = 'pending';

  SELECT count(*)::int INTO v_pending_interventions
  FROM public.interventions
  WHERE status = 'pending_approval';

  IF v_pending_trips = 0 AND v_pending_interventions = 0 THEN
    RETURN jsonb_build_object(
      'sent', false,
      'pending_trips', 0,
      'pending_interventions', 0,
      'reason', 'No hay recorridos ni trabajos viales pendientes de validación; se omite el envío para evitar ruido.'
    );
  END IF;

  SELECT count(*)::int INTO v_pending_claims
  FROM public.claims
  WHERE status IN ('received', 'evaluating', 'in_progress');

  SELECT count(*)::int INTO v_suspended_interventions
  FROM public.interventions
  WHERE status IN ('suspended', 'in_progress');

  FOR v_admin IN SELECT user_id FROM public.admins LOOP
    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      body
    ) VALUES (
      v_admin.user_id,
      'weekly_pending_summary',
      'Resumen semanal: ' || v_pending_trips || ' recorrido(s) y ' || v_pending_interventions || ' trabajo(s) por validar',
      'Tenés ' || v_pending_trips || ' recorrido(s) de vecinos esperando validación, ' ||
      v_pending_interventions || ' trabajo(s) vial(es) de operarios para aprobar (' ||
      v_suspended_interventions || ' en ejecución/pausa) y ' ||
      v_pending_claims || ' reclamo(s) activo(s).'
    );
    v_sent_count := v_sent_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'sent', true,
    'pending_trips', v_pending_trips,
    'pending_interventions', v_pending_interventions,
    'suspended_interventions', v_suspended_interventions,
    'pending_claims', v_pending_claims,
    'admins_notified', v_sent_count
  );
END;
$$;
