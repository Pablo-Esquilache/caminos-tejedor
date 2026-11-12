package com.caminosrurales.tejedor;

import android.content.Context;
import android.content.Intent;
import android.location.Location;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

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

    @PluginMethod
    public void getBufferedLocations(PluginCall call) {
        List<Location> buffer = LocationService.getAndClearBuffer();
        JSArray array = new JSArray();
        for (Location loc : buffer) {
            JSObject obj = new JSObject();
            obj.put("latitude", loc.getLatitude());
            obj.put("longitude", loc.getLongitude());
            obj.put("accuracy", loc.getAccuracy());
            obj.put("altitude", loc.hasAltitude() ? loc.getAltitude() : null);
            obj.put("speed", loc.hasSpeed() ? loc.getSpeed() : null);
            obj.put("timestamp", loc.getTime() > 0 ? loc.getTime() : System.currentTimeMillis());
            array.put(obj);
        }
        JSObject ret = new JSObject();
        ret.put("locations", array);
        call.resolve(ret);
    }
}
