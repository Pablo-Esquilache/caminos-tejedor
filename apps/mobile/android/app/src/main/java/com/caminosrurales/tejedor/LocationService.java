package com.caminosrurales.tejedor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class LocationService extends Service implements LocationListener {

    public static final String CHANNEL_ID = "caminos_gps_channel";
    public static final int NOTIFICATION_ID = 99124;
    private static final String WAKE_LOCK_TAG = "caminos:gps_wakelock";

    private LocationManager locationManager;
    private PowerManager.WakeLock wakeLock;
    private static final List<Location> locationBuffer = Collections.synchronizedList(new ArrayList<>());

    public static List<Location> getAndClearBuffer() {
        synchronized (locationBuffer) {
            List<Location> copy = new ArrayList<>(locationBuffer);
            locationBuffer.clear();
            return copy;
        }
    }

    public interface LocationCallback {
        void onLocationReceived(Location location);
    }

    private static LocationCallback locationCallback;

    public static void setLocationCallback(LocationCallback callback) {
        locationCallback = callback;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();

        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
            wakeLock.acquire(4 * 60 * 60 * 1000L); // Máximo 4 horas por seguridad
        }

        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        requestLocationUpdates();
        return START_STICKY;
    }

    private void requestLocationUpdates() {
        if (locationManager == null) return;

        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    1500L, // 1.5 segundos para alta precisión y trazado fiel de curvas
                    0f,
                    this
                );
            } else if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                // Fallback secundario únicamente si el GPS satelital está deshabilitado
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    2000L,
                    0f,
                    this
                );
            }
        } catch (SecurityException e) {
            // Permisos no otorgados
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Grabación GPS de Caminos Rurales",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Mantiene activo el GPS mientras la pantalla está bloqueada");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = null;
        if (launchIntent != null) {
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Caminos Tejedor: Grabación activa")
            .setContentText("Registrando trazado de camino con GPS de alta precisión...")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location != null) {
            // Descartar lecturas con precisión pésima (> 35m) directamente a nivel de servicio Android
            if (location.hasAccuracy() && location.getAccuracy() > 35f) {
                return;
            }

            // Acumular en buffer nativo seguro contra apagado/bloqueo de pantalla
            locationBuffer.add(location);

            if (locationCallback != null) {
                locationCallback.onLocationReceived(location);
            }
        }
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (SecurityException ignored) {}
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        stopForeground(true);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
