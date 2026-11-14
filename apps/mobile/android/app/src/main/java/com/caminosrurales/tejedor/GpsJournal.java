package com.caminosrurales.tejedor;

import android.content.Context;
import android.location.Location;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Diario append-only de fixes GPS por sesion. seq empieza en 1 y es contiguo. Lectura no destructiva. */
final class GpsJournal {
    private static final ConcurrentHashMap<String, GpsJournal> OPEN = new ConcurrentHashMap<>();
    private static final int MAX_FIXES = 60_000; // ~25 h a un fix cada 1,5 s

    private final File file;
    private final ArrayList<JSONObject> fixes = new ArrayList<>();

    static GpsJournal get(Context c, String sessionId) {
        String key = sanitize(sessionId);
        return OPEN.computeIfAbsent(key, k -> new GpsJournal(c.getApplicationContext(), k));
    }

    static void forget(String sessionId) {
        OPEN.remove(sanitize(sessionId));
    }

    static void purgeOlderThan(Context c, long maxAgeMs) {
        File[] files = dir(c).listFiles();
        if (files == null) return;
        long limit = System.currentTimeMillis() - maxAgeMs;
        for (File f : files) {
            if (f.lastModified() < limit) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    private static String sanitize(String s) {
        if (s == null) return "default";
        return s.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private static File dir(Context c) {
        File d = new File(c.getFilesDir(), "gps_journal");
        if (!d.exists()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    private GpsJournal(Context c, String key) {
        file = new File(dir(c), key + ".jsonl");
        load();
    }

    private void load() {
        if (!file.exists()) return;
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                try {
                    JSONObject o = new JSONObject(line);
                    if (o.getLong("seq") == fixes.size() + 1L) {
                        fixes.add(o);
                    }
                } catch (JSONException ignored) {
                }
            }
        } catch (IOException ignored) {
        }
        try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
            long len = raf.length();
            if (len > 0) {
                raf.seek(len - 1);
                if (raf.read() != '\n') {
                    raf.seek(len);
                    raf.write('\n');
                }
            }
        } catch (IOException ignored) {
        }
    }

    synchronized long append(Location l) throws IOException {
        if (fixes.size() >= MAX_FIXES) throw new IOException("Diario lleno");
        long seq = fixes.size() + 1L;
        JSONObject o = new JSONObject();
        try {
            o.put("seq", seq);
            o.put("latitude", l.getLatitude());
            o.put("longitude", l.getLongitude());
            o.put("accuracy", l.hasAccuracy() ? (double) l.getAccuracy() : JSONObject.NULL);
            o.put("altitude", l.hasAltitude() ? l.getAltitude() : JSONObject.NULL);
            o.put("speed", l.hasSpeed() ? (double) l.getSpeed() : JSONObject.NULL);
            o.put("timestamp", l.getTime() > 0 ? l.getTime() : System.currentTimeMillis());
        } catch (JSONException e) {
            throw new IOException(e);
        }
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write((o.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        fixes.add(o);
        return seq;
    }

    synchronized JSONArray readSince(long afterSeq, int limit) {
        JSONArray out = new JSONArray();
        int start = (int) Math.max(0L, afterSeq);
        for (int i = start; i < fixes.size() && out.length() < limit; i++) {
            out.put(fixes.get(i));
        }
        return out;
    }

    synchronized long lastSeq() {
        return fixes.size();
    }

    synchronized void delete() {
        fixes.clear();
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
