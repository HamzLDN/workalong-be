import { pool } from './db.js';

export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export async function checkGeofence(staffId, staffLat, staffLon) {
  const staffResult = await pool.query('SELECT s.user_id FROM staff s WHERE s.id = $1', [staffId]);
  if (staffResult.rows.length === 0) {
    return { allowed: false, error: 'Staff not found' };
  }
  const companyUserId = staffResult.rows[0].user_id;

  // Multi-location: check against locations table (if user has multi_location_enabled)
  let multiLocationEnabled = false;
  try {
    const userResult = await pool.query('SELECT multi_location_enabled FROM users WHERE id = $1', [
      companyUserId,
    ]);
    multiLocationEnabled = userResult.rows[0]?.multi_location_enabled === true;
  } catch (e) {
    if (e.code === '42703' || String(e.message || '').includes('multi_location_enabled')) {
      multiLocationEnabled = false;
    } else throw e;
  }

  if (multiLocationEnabled) {
    const locationsResult = await pool.query(
      'SELECT id, name, latitude, longitude, radius FROM locations WHERE user_id = $1',
      [companyUserId]
    );
    if (locationsResult.rows.length === 0) {
      return { allowed: true }; // No locations set = no geofence enforcement
    }
    if (!staffLat || !staffLon) {
      return {
        allowed: false,
        error: 'Location required. Please enable location services and try again.',
        requiresLocation: true,
      };
    }
    for (const loc of locationsResult.rows) {
      const radius = loc.radius || 100;
      const distance = calculateDistance(loc.latitude, loc.longitude, staffLat, staffLon);
      if (distance <= radius) {
        return { allowed: true, distance: Math.round(distance), locationId: loc.id };
      }
    }
    const nearest = locationsResult.rows.reduce((best, loc) => {
      const d = calculateDistance(loc.latitude, loc.longitude, staffLat, staffLon);
      return !best || d < best.distance ? { distance: d, radius: loc.radius || 100 } : best;
    }, null);
    return {
      allowed: false,
      error: `You are ${Math.round(nearest.distance)}m away from the nearest workplace. You must be within ${nearest.radius}m to clock in/out.`,
      distance: Math.round(nearest.distance),
      radius: nearest.radius,
    };
  }

  // Single location: check against users table
  const locationResult = await pool.query(
    'SELECT latitude, longitude, location_radius FROM users WHERE id = $1',
    [companyUserId]
  );
  if (locationResult.rows.length === 0) {
    return { allowed: true };
  }
  const company = locationResult.rows[0];
  if (!company.latitude || !company.longitude) {
    return { allowed: true };
  }
  if (!staffLat || !staffLon) {
    return {
      allowed: false,
      error: 'Location required. Please enable location services and try again.',
      requiresLocation: true,
    };
  }
  const radius = company.location_radius || 100;
  const distance = calculateDistance(company.latitude, company.longitude, staffLat, staffLon);
  if (distance > radius) {
    return {
      allowed: false,
      error: `You are ${Math.round(distance)}m away from the workplace. You must be within ${radius}m to clock in/out.`,
      distance: Math.round(distance),
      radius,
    };
  }
  return { allowed: true, distance: Math.round(distance) };
}
