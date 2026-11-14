package com.caminosrurales.tejedor;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONException;

@CapacitorPlugin(name = "BackgroundGps")
public class BackgroundGpsPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String sid = call.getString("sessionId");
        if (sid == null || sid.trim().isEmpty()) {
            call.reject("sessionId requerido");
            return;
        }
        Context ctx = getContext();
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("PERMISSION_DENIED");
            return;
        }
        GpsJournal.purgeOlderThan(ctx, 7L * 24 * 60 * 60 * 1000);
        Intent i = new Intent(ctx, LocationService.class)
                .setAction(LocationService.ACTION_START)
                .putExtra(LocationService.EXTRA_SESSION_ID, sid);
        try {
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("No se pudo iniciar el servicio: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.getSharedPreferences(LocationService.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(LocationService.KEY_ACTIVE, false)
                .apply();
        ctx.stopService(new Intent(ctx, LocationService.class));
        call.resolve();
    }

    /** Lectura NO destructiva: devuelve los fixes con seq > afterSeq. */
    @PluginMethod
    public void getSince(PluginCall call) {
        String sid = call.getString("sessionId");
        if (sid == null) {
            call.reject("sessionId requerido");
            return;
        }
        Integer afterInt = call.getInt("afterSeq", 0);
        long after = afterInt != null ? afterInt.longValue() : 0L;
        Integer limitInt = call.getInt("limit", 500);
        int limit = limitInt != null ? limitInt : 500;
        GpsJournal j = GpsJournal.get(getContext(), sid);
        JSONArray raw = j.readSince(after, Math.max(1, Math.min(limit, 2000)));
        JSArray fixes = new JSArray();
        for (int k = 0; k < raw.length(); k++) {
            try {
                fixes.put(raw.getJSONObject(k));
            } catch (JSONException ignored) {
            }
        }
        JSObject ret = new JSObject();
        ret.put("fixes", fixes);
        ret.put("lastSeq", j.lastSeq());
        call.resolve(ret);
    }

    /** Compatibilidad hacia atras en caso de llamada directa */
    @PluginMethod
    public void getBufferedLocations(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(LocationService.PREFS, Context.MODE_PRIVATE);
        String sid = call.getString("sessionId", p.getString(LocationService.KEY_SESSION, null));
        JSArray locations = new JSArray();
        if (sid != null) {
            GpsJournal j = GpsJournal.get(getContext(), sid);
            JSONArray raw = j.readSince(0L, 2000);
            for (int k = 0; k < raw.length(); k++) {
                try {
                    locations.put(raw.getJSONObject(k));
                } catch (JSONException ignored) {
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("locations", locations);
        call.resolve(ret);
    }

    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(LocationService.PREFS, Context.MODE_PRIVATE);
        String sid = p.getString(LocationService.KEY_SESSION, null);
        JSObject ret = new JSObject();
        ret.put("running", p.getBoolean(LocationService.KEY_ACTIVE, false));
        ret.put("sessionId", sid);
        ret.put("lastSeq", sid != null ? GpsJournal.get(getContext(), sid).lastSeq() : 0);
        long last = LocationService.lastFixAtMs;
        ret.put("lastFixAt", last > 0 ? last : null);
        call.resolve(ret);
    }

    /** Borrar solo despues de que el recorrido o trabajo quedo guardado en la cola offline. */
    @PluginMethod
    public void clear(PluginCall call) {
        String sid = call.getString("sessionId");
        if (sid == null) {
            call.reject("sessionId requerido");
            return;
        }
        GpsJournal.get(getContext(), sid).delete();
        GpsJournal.forget(sid);
        call.resolve();
    }
}
