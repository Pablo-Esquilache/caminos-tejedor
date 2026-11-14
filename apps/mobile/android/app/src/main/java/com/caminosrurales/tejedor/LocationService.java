package com.caminosrurales.tejedor;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.io.IOException;

public class LocationService extends Service implements LocationListener {

    public static final String ACTION_START = "com.caminosrurales.tejedor.GPS_START";
    public static final String EXTRA_SESSION_ID = "session_id";
    static final String PREFS = "gps_service";
    static final String KEY_SESSION = "session_id";
    static final String KEY_ACTIVE = "active";

    public static final String CHANNEL_ID = "caminos_gps_channel";
    public static final int NOTIFICATION_ID = 99124;
    private static final String WAKE_LOCK_TAG = "caminos:gps_wakelock";
    private static final long MIN_INTERVAL_MS = 1500L;
    private static final long HEARTBEAT_MS = 30_000L;
    private static final long SIGNAL_LOST_MS = 60_000L;
    private static final float MAX_ACCURACY_M = 22f;
    private static final long MAX_FIX_AGE_NS = 10_000_000_000L; // 10 s
    private static final double MAX_PLAUSIBLE_SPEED_MPS = 45.0; // ~162 km/h

    static volatile long lastFixAtMs = 0L;

    private LocationManager locationManager;
    private PowerManager.WakeLock wakeLock;
    private HandlerThread ioThread;
    private Handler ioHandler;
    private GpsJournal journal;
    private long startedAtMs;
    private boolean signalLost = false;
    private Location lastAcceptedLocation = null;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        ioThread = new HandlerThread("caminos-gps-io");
        ioThread.start();
        ioHandler = new Handler(ioThread.getLooper());
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String sid = intent != null ? intent.getStringExtra(EXTRA_SESSION_ID) : null;
        if (sid == null && prefs.getBoolean(KEY_ACTIVE, false)) {
            sid = prefs.getString(KEY_SESSION, null);
        }
        if (sid == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean permitted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        try {
            if (!permitted) throw new SecurityException("Sin permiso de ubicacion");
            startForegroundCompat(buildNotification("Registrando trazado con GPS..."));
        } catch (RuntimeException e) {
            prefs.edit().putBoolean(KEY_ACTIVE, false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }

        prefs.edit().putString(KEY_SESSION, sid).putBoolean(KEY_ACTIVE, true).apply();
        journal = GpsJournal.get(this, sid);
        startedAtMs = System.currentTimeMillis();
        lastFixAtMs = 0L;
        signalLost = false;
        lastAcceptedLocation = null;

        renewWakeLock();
        requestLocationUpdates();
        ioHandler.removeCallbacks(heartbeat);
        ioHandler.postDelayed(heartbeat, HEARTBEAT_MS);
        return START_STICKY;
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    private void renewWakeLock() {
        if (wakeLock == null) return;
        if (wakeLock.isHeld()) wakeLock.release();
        wakeLock.acquire(5 * 60 * 1000L);
    }

    private void requestLocationUpdates() {
        if (locationManager == null) return;
        try {
            locationManager.removeUpdates(this);
            // Solo GPS_PROVIDER satelital (sin NETWORK_PROVIDER para evitar saltos a antenas/Wi-Fi)
            locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER, MIN_INTERVAL_MS, 0f, this, ioThread.getLooper());
        } catch (SecurityException | IllegalArgumentException e) {
            updateNotification("Sin permiso de ubicacion: abri la app");
        }
    }

    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            renewWakeLock();
            long ref = Math.max(lastFixAtMs, startedAtMs);
            if (System.currentTimeMillis() - ref > SIGNAL_LOST_MS) {
                signalLost = true;
                updateNotification("Sin senal GPS: sali a cielo abierto");
                requestLocationUpdates();
            }
            ioHandler.postDelayed(this, HEARTBEAT_MS);
        }
    };

    @Override
    public void onLocationChanged(@NonNull Location l) {
        if (!l.hasAccuracy() || l.getAccuracy() > MAX_ACCURACY_M) return;
        if (isMock(l)) return;
        if (SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos() > MAX_FIX_AGE_NS) return;

        if (lastAcceptedLocation != null) {
            long dtMs = l.getTime() - lastAcceptedLocation.getTime();
            if (dtMs <= 0) return;
            if (dtMs < 60_000L) {
                float distM = l.distanceTo(lastAcceptedLocation);
                double speedMps = distM / (dtMs / 1000.0);
                if (speedMps > MAX_PLAUSIBLE_SPEED_MPS) {
                    return; // Descarta salto fisico imposible / rebote de antena
                }
            }
        }

        try {
            journal.append(l);
            lastAcceptedLocation = l;
            lastFixAtMs = System.currentTimeMillis();
            if (signalLost) {
                signalLost = false;
                updateNotification("Registrando trazado con GPS...");
            }
        } catch (IOException e) {
            updateNotification("Error al guardar el trazado");
        }
    }

    @SuppressWarnings("deprecation")
    private static boolean isMock(Location l) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? l.isMock() : l.isFromMockProvider();
    }

    @Override
    public void onProviderDisabled(@NonNull String provider) {
        if (LocationManager.GPS_PROVIDER.equals(provider)) {
            updateNotification("GPS desactivado: activalo para seguir grabando");
        }
    }

    @Override
    public void onProviderEnabled(@NonNull String provider) {
        if (LocationManager.GPS_PROVIDER.equals(provider)) {
            requestLocationUpdates();
            updateNotification("Registrando trazado con GPS...");
        }
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Grabacion GPS de Caminos Rurales", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Mantiene activo el GPS mientras la pantalla esta bloqueada");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String text) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = null;
        if (launch != null) {
            pi = PendingIntent.getActivity(
                    this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Caminos Tejedor: grabacion activa")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text));
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (ioHandler != null) ioHandler.removeCallbacksAndMessages(null);
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (SecurityException ignored) {
            }
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (ioThread != null) ioThread.quitSafely();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
