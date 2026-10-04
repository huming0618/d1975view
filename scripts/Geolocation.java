package com.capacitorjs.plugins.geolocation;

import android.content.Context;
import android.location.Location;
import androidx.core.location.LocationManagerCompat;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.ArrayList;
import java.util.List;

/**
 * System LocationManager instead of Google fused location.
 * Fused getCurrentLocation was returning null or never calling back.
 */
public class Geolocation {

    private Context context;
    private LocationManager locationManager;
    private final List<LocationListener> liveListeners = new ArrayList<>();

    public Geolocation(Context context) {
        this.context = context;
        this.locationManager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
    }

    public Boolean isLocationServicesEnabled() {
        try {
            return LocationManagerCompat.isLocationEnabled(locationManager);
        } catch (Exception ex) {
            return false;
        }
    }

    @SuppressWarnings("MissingPermission")
    public void sendLocation(boolean enableHighAccuracy, final LocationResultCallback resultCallback) {
        if (!this.isLocationServicesEnabled()) {
            resultCallback.error("系统定位开关是关的");
            return;
        }

        final boolean[] done = { false };
        final List<LocationListener> oneshot = new ArrayList<>();
        Handler handler = new Handler(Looper.getMainLooper());

        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (location == null || done[0]) return;
                done[0] = true;
                remove(oneshot);
                resultCallback.success(location);
            }

            @Override
            public void onProviderDisabled(String provider) {}

            @Override
            public void onProviderEnabled(String provider) {}

            @Override
            @SuppressWarnings("deprecation")
            public void onStatusChanged(String provider, int status, Bundle extras) {}
        };

        boolean requested = false;
        StringBuilder providers = new StringBuilder();
        try {
            if (enableHighAccuracy && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0L, 0f, listener, Looper.getMainLooper());
                oneshot.add(listener);
                providers.append("GPS ");
                requested = true;
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 0L, 0f, listener, Looper.getMainLooper());
                if (!oneshot.contains(listener)) oneshot.add(listener);
                providers.append("网络 ");
                requested = true;
            }
        } catch (Exception ex) {
            remove(oneshot);
            resultCallback.error(ex.getMessage() == null ? "请求系统定位失败" : ex.getMessage());
            return;
        }

        if (!requested) {
            Location cached = getLastLocation(30 * 60 * 1000);
            if (cached != null) {
                resultCallback.success(cached);
            } else {
                resultCallback.error("没有打开 GPS 或网络定位");
            }
            return;
        }

        handler.postDelayed(
            () -> {
                if (done[0]) return;
                done[0] = true;
                remove(oneshot);
                Location cached = getLastLocation(30 * 60 * 1000);
                if (cached != null) {
                    resultCallback.success(cached);
                } else {
                    resultCallback.error("系统定位超时，已请求 " + providers.toString().trim());
                }
            },
            10000
        );
    }

    @SuppressWarnings("MissingPermission")
    public void requestLocationUpdates(
        boolean enableHighAccuracy,
        int timeout,
        int minUpdateInterval,
        final LocationResultCallback resultCallback
    ) {
        clearLocationUpdates();
        if (!this.isLocationServicesEnabled()) {
            resultCallback.error("系统定位开关是关的");
            return;
        }
        long interval = Math.max(1000, Math.min(minUpdateInterval <= 0 ? 1000 : minUpdateInterval, 2000));
        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (location != null) resultCallback.success(location);
            }

            @Override
            public void onProviderDisabled(String provider) {}

            @Override
            public void onProviderEnabled(String provider) {}

            @Override
            @SuppressWarnings("deprecation")
            public void onStatusChanged(String provider, int status, Bundle extras) {}
        };
        boolean requested = false;
        try {
            if (enableHighAccuracy && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, interval, 0f, listener, Looper.getMainLooper());
                requested = true;
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, interval, 0f, listener, Looper.getMainLooper());
                requested = true;
            }
        } catch (Exception ex) {
            resultCallback.error(ex.getMessage() == null ? "持续定位失败" : ex.getMessage());
            return;
        }
        if (!requested) {
            resultCallback.error("没有打开 GPS 或网络定位");
            return;
        }
        liveListeners.add(listener);
    }

    public void clearLocationUpdates() {
        for (LocationListener listener : liveListeners) {
            try {
                locationManager.removeUpdates(listener);
            } catch (Exception ignored) {}
        }
        liveListeners.clear();
    }

    @SuppressWarnings("MissingPermission")
    public Location getLastLocation(int maximumAge) {
        Location lastLoc = null;
        int ageLimit = maximumAge <= 0 ? 2000 : maximumAge;
        long maximumAgeNanoSec = ageLimit * 1000000L;
        List<String> providers = locationManager.getAllProviders();
        if (providers == null) return null;
        for (String provider : providers) {
            Location tmpLoc = null;
            try {
                tmpLoc = locationManager.getLastKnownLocation(provider);
            } catch (Exception ignored) {}
            if (tmpLoc == null) continue;
            long locationAge = SystemClock.elapsedRealtimeNanos() - tmpLoc.getElapsedRealtimeNanos();
            if (locationAge <= maximumAgeNanoSec && (lastLoc == null || tmpLoc.getElapsedRealtimeNanos() > lastLoc.getElapsedRealtimeNanos())) {
                lastLoc = tmpLoc;
            }
        }
        return lastLoc;
    }

    private void remove(List<LocationListener> listeners) {
        for (LocationListener listener : listeners) {
            try {
                locationManager.removeUpdates(listener);
            } catch (Exception ignored) {}
        }
        listeners.clear();
    }
}
