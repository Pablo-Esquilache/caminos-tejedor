package com.caminosrurales.tejedor;

import android.content.Context;
import android.content.Intent;
import android.location.Location;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundGps")
public class BackgroundGpsPlugin extends Plugin {

    @Override
    public void load() {
        super.load();
        LocationService.setLocationCallback(new LocationService.LocationCallback() {
            @Override
            public void onLocationReceived(Location location) {
                JSObject ret = new JSObject();
                ret.put("latitude", location.getLatitude());
                ret.put("longitude", location.getLongitude());
                ret.put("accuracy", location.getAccuracy());
                ret.put("altitude", location.hasAltitude() ? location.getAltitude() : null);
                ret.put("speed", location.hasSpeed() ? location.getSpeed() : null);
                ret.put("timestamp", location.getTime());
                notifyListeners("onLocation", ret);
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, LocationService.class);
        ContextCompat.startForegroundService(context, intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, LocationService.class);
        context.stopService(intent);
        call.resolve();
    }
}
