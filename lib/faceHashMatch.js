
function normalizeClockinIdField(cid) {
  if (cid == null || cid === '') return null;
  const trimmed = String(cid).trim();
  if (trimmed.length === 6) return trimmed;

  const digitOnly = trimmed.replace(/\D/g, '');
  if (digitOnly.length > 0 && digitOnly.length <= 6 && /^\d+$/.test(digitOnly)) {
    return digitOnly.padStart(6, '0');
  }
  const lastSixDigits = digitOnly.slice(-6);
  if (lastSixDigits.length === 6) return lastSixDigits;
  return null;
}

export function deriveClockinCode(row) {
  const fromClockinId = normalizeClockinIdField(row?.clockin_id);
  const usernameDigits = String(row?.username || '')
    .replace(/\D/g, '')
    .slice(-6);
  const fromUsername = usernameDigits.length === 6 ? usernameDigits : null;

  if (fromUsername && fromClockinId && fromUsername !== fromClockinId) {
    return fromUsername;
  }
  if (fromClockinId) return fromClockinId;
  if (fromUsername) return fromUsername;
  return null;
}

export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

export function maxAcceptableHammingDistance(incomingLength) {
  return Math.max(10, Math.floor(incomingLength * 0.28));
}

export function maxAcceptableHammingDistanceIdentify(incomingLength) {
  return Math.max(8, Math.floor(incomingLength * 0.2));
}

function minSecondBestGap(incomingLength) {
  return Math.max(6, Math.floor(incomingLength * 0.016));
}

/** First + last for kiosk display (staff.name + staff.lastname). */
export function formatStaffDisplayName(staffName, lastName) {
  const first = String(staffName ?? '').trim();
  const last = String(lastName ?? '').trim();
  if (first && last) return `${first} ${last}`;
  return first || last || '';
}

export function splitStaffFirstLast(staffNameRaw, lastNameFromDb) {
  const lastDb = String(lastNameFromDb ?? '').trim();
  const nameRaw = String(staffNameRaw ?? '').trim();
  if (lastDb) {
    return {
      first: nameRaw,
      last: lastDb,
      full: formatStaffDisplayName(staffNameRaw, lastNameFromDb),
    };
  }
  const space = nameRaw.indexOf(' ');
  if (space > 0) {
    const first = nameRaw.slice(0, space).trim();
    const last = nameRaw.slice(space + 1).trim();
    return { first, last, full: nameRaw };
  }
  return { first: nameRaw, last: '', full: nameRaw };
}

export function verifyFaceHashAgainstHashes(faceHash, faceHashes) {
  if (!faceHash || typeof faceHash !== 'string' || faceHash.length < 32) {
    return { ok: false, reason: 'FACE_REQUIRED' };
  }
  const hashes = Array.isArray(faceHashes) ? faceHashes : [];
  if (hashes.length === 0) return { ok: false, reason: 'FACE_NOT_ENROLLED' };

  const incoming = String(faceHash);
  const comparable = hashes.map((h) => String(h || '')).filter((h) => h.length === incoming.length);
  if (comparable.length === 0) return { ok: false, reason: 'FACE_REENROLL_REQUIRED' };

  const best = comparable.reduce(
    (min, h) => Math.min(min, hammingDistance(h, incoming)),
    Number.MAX_SAFE_INTEGER
  );
  const maxDistance = maxAcceptableHammingDistance(incoming.length);
  return {
    ok: best <= maxDistance,
    bestDistance: best,
    reason: best <= maxDistance ? null : 'FACE_MISMATCH',
  };
}

export function findBestFaceMatchAmongStaff(faceHash, rows) {
  const incoming = String(faceHash || '');
  if (!incoming || incoming.length < 32) return null;
  if (!rows || rows.length === 0) return null;

  const maxIdent = maxAcceptableHammingDistanceIdentify(incoming.length);
  const gapRequired = minSecondBestGap(incoming.length);

  const ranked = [];
  for (const row of rows) {
    const hashes = Array.isArray(row.face_hashes) ? row.face_hashes : [];
    const comparable = hashes
      .map((h) => String(h || ''))
      .filter((h) => h.length === incoming.length);
    if (comparable.length === 0) continue;
    const bestDistanceForStaff = comparable.reduce(
      (min, h) => Math.min(min, hammingDistance(h, incoming)),
      Number.MAX_SAFE_INTEGER
    );
    const parts = splitStaffFirstLast(row.staff_name, row.last_name);
    ranked.push({
      staffId: row.staff_id,
      staffName: parts.full,
      staffFirstName: parts.first,
      staffLastName: parts.last,
      clockinCode: deriveClockinCode(row),
      distance: bestDistanceForStaff,
    });
  }

  ranked.sort((a, b) => a.distance - b.distance);
  const eligible = ranked.filter((c) => c.distance <= maxIdent);
  if (eligible.length === 0) return null;
  if (eligible.length >= 2 && eligible[1].distance - eligible[0].distance < gapRequired) {
    return null;
  }

  const best = eligible[0];
  return {
    staffId: best.staffId,
    staffName: best.staffName,
    staffFirstName: best.staffFirstName,
    staffLastName: best.staffLastName,
    clockinCode: best.clockinCode || null,
  };
}
