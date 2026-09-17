import {
  AESGCM256_ALGORITHM,
  decryptAesGcm256,
  decryptXChaCha20Poly1305,
  XCHACHA20POLY1305_ALGORITHM,
} from "@sensors-social/crypto";
import bs58 from "bs58";

import { cryptoWaitReady, decodeAddress, mnemonicToMiniSecret } from "@polkadot/util-crypto";
import { getOwnerEd25519Seed } from "@/composables/useAccounts";
import { MEASUREMENT_GROUPS } from "../measurements/groups";
import { pressureToMmHg } from "./pressureMmHg";

const ENCRYPTED_PREFIX = "e.";
const SUPPORTED_ALGORITHMS = new Set([AESGCM256_ALGORITHM, XCHACHA20POLY1305_ALGORITHM]);

export function isEncryptedSensorValue(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

function hasEncryptedFields(measurement) {
  if (!measurement || typeof measurement !== "object") return false;
  return Object.values(measurement).some(isEncryptedSensorValue);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function parseCpsPayload(wire) {
  try {
    const raw = base64ToBytes(wire.slice(ENCRYPTED_PREFIX.length));
    const text = new TextDecoder().decode(raw);
    if (!text.startsWith("{")) return null;
    const json = JSON.parse(text);
    if (json?.version !== 1 || !SUPPORTED_ALGORITHMS.has(String(json?.algorithm || ""))) {
      return null;
    }
    return json;
  } catch {
    return null;
  }
}

async function resolveDevicePublicKey(fromField) {
  const raw = String(fromField || "").trim();
  if (!raw) return null;
  await cryptoWaitReady();
  try {
    const pk = decodeAddress(raw, false, 32);
    if (pk instanceof Uint8Array && pk.length === 32) return pk;
  } catch {
    // legacy raw base58 pubkey in `from`
  }
  try {
    const pk = bs58.decode(raw);
    if (pk.length === 32) return pk;
  } catch {
    return null;
  }
  return null;
}

function decryptCpsBytes(ciphertext, nonce, senderPublicKey, ownerSeed, algorithm) {
  const algo = String(algorithm || AESGCM256_ALGORITHM).toLowerCase();
  if (algo === AESGCM256_ALGORITHM) {
    return decryptAesGcm256(ciphertext, nonce, senderPublicKey, ownerSeed);
  }
  if (algo === XCHACHA20POLY1305_ALGORITHM) {
    return decryptXChaCha20Poly1305(ciphertext, nonce, senderPublicKey, ownerSeed);
  }
  return null;
}

async function decryptCpsValue(wire, ownerSeed) {
  const json = parseCpsPayload(wire);
  if (!json?.from || !json?.nonce || !json?.ciphertext) return null;

  const devicePk = await resolveDevicePublicKey(json.from);
  if (!devicePk) return null;

  const nonce = base64ToBytes(json.nonce);
  const ciphertext = base64ToBytes(json.ciphertext);

  try {
    const plain = decryptCpsBytes(ciphertext, nonce, devicePk, ownerSeed, json.algorithm);
    if (!plain) return null;
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/**
 * Decrypt a proto `crypto.v1.Encrypted` blob with `@sensors-social/crypto`.
 * @returns {Promise<Uint8Array|null>} plaintext bytes or null
 */
export async function decryptCpsBinary({ from, nonce, ciphertext, algorithm, ownerAccount }) {
  const algo = String(algorithm || AESGCM256_ALGORITHM).toLowerCase();
  if (algorithm && !SUPPORTED_ALGORITHMS.has(algo)) return null;
  const ownerSeed = await resolveOwnerSeed(ownerAccount);
  if (!ownerSeed) return null;
  const devicePk =
    from instanceof Uint8Array && from.length === 32 ? from : await resolveDevicePublicKey(from);
  if (!devicePk || !(nonce instanceof Uint8Array) || nonce.length === 0) return null;
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length === 0) return null;
  try {
    return decryptCpsBytes(ciphertext, nonce, devicePk, ownerSeed, algo);
  } catch {
    return null;
  }
}

function normalizeDecryptedField(fieldName, plain) {
  const num = Number(plain);
  if (!Number.isFinite(num)) return plain;

  const field = String(fieldName || "").toLowerCase();
  if (field === "pressure") return pressureToMmHg(num);
  return num;
}

async function decryptSensorValue(wire, ownerSeed) {
  if (!isEncryptedSensorValue(wire) || wire === "e.proto") return null;
  return decryptCpsValue(wire, ownerSeed);
}

async function resolveOwnerSeed(ownerAccount) {
  if (!ownerAccount || typeof ownerAccount !== "object") return null;
  if (ownerAccount.seed instanceof Uint8Array && ownerAccount.seed.length === 32) {
    return ownerAccount.seed;
  }
  const seedHex = String(ownerAccount.seedHex || "").trim().replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  const phrase = String(ownerAccount.phrase || "").trim();
  if (phrase) {
    await cryptoWaitReady();
    const seed = mnemonicToMiniSecret(phrase);
    if (seed instanceof Uint8Array && seed.length >= 32) {
      return seed.slice(0, 32);
    }
  }
  const address = String(ownerAccount.address || "").trim();
  if (!address) return null;
  return getOwnerEd25519Seed(address);
}

/**
 * Decrypt encrypted measurement fields when the logged-in owner seed is available.
 * @param {string} sensorId
 * @param {Object} measurement
 * @param {{ address?: string, seed?: Uint8Array }} ownerAccount
 */
export async function decryptMeasurementBag(sensorId, measurement, ownerAccount) {
  if (!measurement || typeof measurement !== "object" || !hasEncryptedFields(measurement)) {
    return measurement;
  }

  const ownerSeed = await resolveOwnerSeed(ownerAccount);
  if (!ownerSeed) return measurement;

  const out = { ...measurement };
  await Promise.all(
    Object.entries(measurement).map(async ([field, value]) => {
      if (!isEncryptedSensorValue(value)) return;
      const plain = await decryptSensorValue(value, ownerSeed);
      if (plain == null) return;
      out[field] = normalizeDecryptedField(field, plain);
    })
  );
  return out;
}

export function measurementBagHasEncryptedValues(measurement) {
  return hasEncryptedFields(measurement);
}

export function hasPendingProtoPrivate(point) {
  return Array.isArray(point?.protoPrivate) && point.protoPrivate.length > 0;
}

function isPlainNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Overlay `incoming` onto `existing`. Keep public numbers; fill missing / encrypted JSON fields proto skipped. */
export function mergeMeasurementBags(existing, incoming) {
  const left = existing && typeof existing === "object" ? existing : {};
  const right = incoming && typeof incoming === "object" ? incoming : {};
  const out = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const prev = out[key];
    const prevPlain = isPlainNumber(prev);
    const nextPlain = isPlainNumber(value);
    const prevEnc = isEncryptedSensorValue(prev);
    const nextEnc = isEncryptedSensorValue(value);
    if (prevPlain && nextEnc) continue;
    if (prevEnc && nextPlain) {
      out[key] = value;
      continue;
    }
    if (prev === undefined || prev === null) {
      out[key] = value;
      continue;
    }
    if (nextPlain || (!prevPlain && nextEnc)) out[key] = value;
  }
  return out;
}

/** Same keys/values (numbers within 1e-4). Used to drop floodsub/JSON+proto duplicates. */
export function measurementBagsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return a == b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    const av = a[key];
    const bv = b[key];
    if (isPlainNumber(av) && isPlainNumber(bv)) {
      if (Math.abs(av - bv) > 1e-4) return false;
      continue;
    }
    if (av !== bv) return false;
  }
  return true;
}

function legendMemberIds(legendKey) {
  const key = String(legendKey || "").toLowerCase();
  const group = MEASUREMENT_GROUPS[key];
  if (group?.members?.length) {
    return group.members.map((m) => String(m).toLowerCase());
  }
  return key ? [key] : [];
}

function readBagValue(bag, memberId) {
  if (!bag || memberId == null) return undefined;
  const id = String(memberId).toLowerCase();
  if (bag[id] !== undefined) return bag[id];
  for (const [k, v] of Object.entries(bag)) {
    if (String(k).toLowerCase() === id) return v;
  }
  return undefined;
}

export function bagHasEncryptedForLegend(bag, legendKey) {
  if (!bag || !legendKey) return false;
  return legendMemberIds(legendKey).some((memberId) =>
    isEncryptedSensorValue(readBagValue(bag, memberId))
  );
}

export function logHasEncryptedForLegend(log, legendKey) {
  if (!Array.isArray(log) || !legendKey) return false;
  return log.some((entry) => bagHasEncryptedForLegend(entry?.data, legendKey));
}
