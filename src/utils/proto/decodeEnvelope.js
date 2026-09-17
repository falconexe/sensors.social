/**
 * From buf.build/airalab/connectivity-protocol.
 * Public Urban/Insight always; private[] is decrypted with the owner seed (same CPS AES-GCM as JSON).
 */

import { fromBinary } from "@bufbuild/protobuf";
import {
  SignedEnvelopeBatchSchema,
  SignedEnvelopeSchema,
} from "@buf/airalab_connectivity-protocol.bufbuild_es/crypto/v1/envelope_pb.js";
import { MessageSchema } from "@buf/airalab_connectivity-protocol.bufbuild_es/core/v1/message_pb.js";
import { EncryptedUrbanSchema } from "@buf/airalab_connectivity-protocol.bufbuild_es/device/v1/urban_pb.js";
import { EncryptedInsightSchema } from "@buf/airalab_connectivity-protocol.bufbuild_es/device/v1/insight_pb.js";
import { ed25519 } from "@noble/curves/ed25519";
import { encodeAddress } from "@polkadot/util-crypto";
import { pressureToMmHg } from "../pressureMmHg";
import { decryptCpsBinary, isEncryptedSensorValue } from "../sensorValueCrypto";

function asU8(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return Uint8Array.from(data);
}

function concatBytes(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function timestampLe64(ms) {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  const big = typeof ms === "bigint" ? ms : BigInt(ms);
  view.setUint32(0, Number(big & 0xffffffffn), true);
  view.setUint32(4, Number((big >> 32n) & 0xffffffffn), true);
  return buf;
}

function ss58(pubkey) {
  if (!pubkey || pubkey.length !== 32) {
    return "";
  }
  return encodeAddress(pubkey, 32);
}

function finite(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function applyBme(measurement, data) {
  if (!measurement) {
    return;
  }
  if (measurement.case === "temperature") {
    const n = finite(measurement.value?.celsius);
    if (n != null) data.temperature = n;
  } else if (measurement.case === "humidity") {
    const n = finite(measurement.value?.percent);
    if (n != null) data.humidity = n;
  } else if (measurement.case === "pressure") {
    const n = finite(measurement.value?.pascal);
    if (n != null) data.pressure = pressureToMmHg(n);
  }
}

function applySds(measurement, data) {
  if (!measurement) {
    return;
  }
  if (measurement.case === "pm25") {
    const n = finite(measurement.value?.ugM3);
    if (n != null) data.pm25 = n;
  } else if (measurement.case === "pm10") {
    const n = finite(measurement.value?.ugM3);
    if (n != null) data.pm10 = n;
  }
}

function applyMic(measurement, data) {
  if (!measurement) {
    return;
  }
  if (measurement.case === "noiseMax") {
    const n = finite(measurement.value?.db);
    if (n != null) data.noisemax = n;
  } else if (measurement.case === "noiseAvg") {
    const n = finite(measurement.value?.db);
    if (n != null) data.noiseavg = n;
  }
}

function applyScd(measurement, data) {
  if (!measurement) {
    return;
  }
  if (measurement.case === "co2") {
    const n = finite(measurement.value?.ppm);
    if (n != null) data.co2 = n;
  } else if (measurement.case === "temperature") {
    const n = finite(measurement.value?.celsius);
    if (n != null) data.temperature = n;
  } else if (measurement.case === "humidity") {
    const n = finite(measurement.value?.percent);
    if (n != null) data.humidity = n;
  }
}

function applyGps(gps, acc) {
  const lat = finite(gps?.lat);
  const lon = finite(gps?.lon);
  if (lat == null || lon == null) {
    return;
  }
  acc.geo = { lat, lng: lon };
}

function foldSensors(items, kind) {
  const acc = { geo: null, measurement: {} };
  for (const item of items || []) {
    const sensor = item?.sensor;
    if (!sensor?.case) {
      continue;
    }
    if (sensor.case === "gps") {
      applyGps(sensor.value, acc);
      continue;
    }
    if (kind === "urban") {
      if (sensor.case === "bme280") applyBme(sensor.value?.measurement, acc.measurement);
      if (sensor.case === "sds011") applySds(sensor.value?.measurement, acc.measurement);
      if (sensor.case === "ics43434") applyMic(sensor.value?.measurement, acc.measurement);
    } else {
      if (sensor.case === "bme680") applyBme(sensor.value?.measurement, acc.measurement);
      if (sensor.case === "scd41") applyScd(sensor.value?.measurement, acc.measurement);
    }
  }
  return acc;
}

function verifyEnvelope(env) {
  if (!env.sensorId || env.sensorId.length !== 32) return false;
  if (!env.signature || env.signature.length !== 64) return false;
  if (!env.nonce || env.nonce.length < 16 || env.nonce.length > 32) return false;
  if (!env.message || env.message.length === 0) return false;
  const ts = typeof env.timestamp === "bigint" ? Number(env.timestamp) : env.timestamp;
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const preimage = concatBytes([
    env.sensorId,
    timestampLe64(env.timestamp),
    env.nonce,
    env.message,
  ]);
  try {
    return ed25519.verify(env.signature, preimage, env.sensorId);
  } catch {
    return false;
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

const PROTO_ENCRYPTED_PLACEHOLDER = "e.proto";
const URBAN_KEYS = [
  "temperature",
  "humidity",
  "pressure",
  "pm25",
  "pm10",
  "noisemax",
  "noiseavg",
];
const INSIGHT_KEYS = ["temperature", "humidity", "pressure", "co2"];

function hasMeasurementValue(value) {
  if (isEncryptedSensorValue(value)) return true;
  return typeof value === "number" && Number.isFinite(value);
}

/** Keep chart legend + login overlay for metrics sealed in private[] (same UX as JSON `e.`). */
function fillProtoPrivatePlaceholders(data, kind) {
  const keys = kind === "insight" ? INSIGHT_KEYS : URBAN_KEYS;
  const out = { ...(data || {}) };
  for (const key of keys) {
    if (hasMeasurementValue(out[key])) continue;
    out[key] = PROTO_ENCRYPTED_PLACEHOLDER;
  }
  return out;
}

function snapshotPrivate(items) {
  return (items || [])
    .map((enc) => ({
      version: enc.version,
      algorithm: enc.algorithm,
      from: asBytes(enc.from),
      nonce: asBytes(enc.nonce),
      ciphertext: asBytes(enc.ciphertext),
    }))
    .filter((enc) => enc.from && enc.nonce && enc.ciphertext);
}

function parseEncryptedSensors(plain, kind) {
  try {
    const msg =
      kind === "insight"
        ? fromBinary(EncryptedInsightSchema, plain)
        : fromBinary(EncryptedUrbanSchema, plain);
    return foldSensors(msg.sensors, kind);
  } catch {
    return { geo: null, measurement: {} };
  }
}

/**
 * Decrypt `protoPrivate` blobs onto `point.data`. Leftover ciphertexts stay on the point.
 * @param {object} point
 * @param {object} ownerAccount
 * @returns {Promise<object>}
 */
export async function decryptProtoPrivate(point, ownerAccount) {
  if (!point || !Array.isArray(point.protoPrivate) || point.protoPrivate.length === 0) {
    return point;
  }
  const leftover = [];
  const extra = {};
  let geo = point.geo || null;
  for (const enc of point.protoPrivate) {
    const plain = await decryptCpsBinary({ ...enc, ownerAccount });
    if (!plain) {
      leftover.push(enc);
      continue;
    }
    const folded = parseEncryptedSensors(plain, point.device_model === "insight" ? "insight" : "urban");
    Object.assign(extra, folded.measurement);
    if (!geo && folded.geo) geo = folded.geo;
  }
  const kind = point.device_model === "insight" ? "insight" : "urban";
  const data = { ...(point.data || {}), ...extra };
  return {
    ...point,
    geo,
    data: leftover.length > 0 ? fillProtoPrivatePlaceholders(data, kind) : data,
    protoPrivate: leftover.length > 0 ? leftover : null,
  };
}

/**
 * @param {object} env
 * @param {{ sender?: string, verbose?: boolean, requireGeo?: boolean, verify?: boolean }} [opts]
 * @returns {object|null} map point or null if the envelope is not usable
 */
function envelopeToPoint(env, opts = {}) {
  const fail = (reason) => {
    if (opts.verbose) console.warn("[proto] decode failed:", reason);
    return null;
  };
  if (opts.verify !== false && !verifyEnvelope(env)) {
    return fail("bad-signature");
  }
  let message;
  try {
    message = fromBinary(MessageSchema, env.message);
  } catch {
    return fail("bad-message");
  }
  const kind = message.payload?.case;
  if (kind !== "urban" && kind !== "insight") {
    return fail(`payload:${kind || "none"}`);
  }
  const payload = message.payload.value;
  const folded = foldSensors(payload?.public, kind);
  if (opts.requireGeo !== false && !folded.geo) {
    return fail("no-public-gps");
  }
  const sensor_id = ss58(env.sensorId);
  const owner = ss58(message.metadata?.owner) || undefined;
  if (!sensor_id) {
    return fail("bad-sensor-id");
  }
  const protoPrivate = snapshotPrivate(payload?.private);
  if (Object.keys(folded.measurement).length === 0 && protoPrivate.length === 0) {
    return fail("no-measurements");
  }
  const tsMs = typeof env.timestamp === "bigint" ? Number(env.timestamp) : env.timestamp;
  const data =
    protoPrivate.length > 0
      ? fillProtoPrivatePlaceholders(folded.measurement, kind)
      : folded.measurement;
  return {
    sensor_id,
    sender: opts.sender,
    model: kind === "insight" ? 3 : 2,
    geo: folded.geo || undefined,
    data,
    owner,
    device_model: kind,
    timestamp: Math.floor(tsMs / 1000),
    proto: true,
    protoPrivate: protoPrivate.length > 0 ? protoPrivate : null,
  };
}

/**
 * @param {Uint8Array|ArrayBuffer} raw
 * @param {{ sender?: string, verbose?: boolean, requireGeo?: boolean, verify?: boolean }} [opts]
 * @returns {object|null} map point or null if not a valid signed envelope
 */
export function decodeSignedEnvelopeToPoint(raw, opts = {}) {
  let env;
  try {
    env = fromBinary(SignedEnvelopeSchema, asU8(raw));
  } catch {
    if (opts.verbose) console.warn("[proto] decode failed:", "not-envelope");
    return null;
  }
  return envelopeToPoint(env, opts);
}

/**
 * RoSeMAN `/api/v3/messages` body: `crypto.v1.SignedEnvelopeBatch`.
 * History points may omit public GPS; live pubsub still requires it.
 * @param {Uint8Array|ArrayBuffer} raw
 * @param {{ sender?: string, verbose?: boolean, requireGeo?: boolean, verify?: boolean }} [opts]
 * @returns {object[]}
 */
export function decodeSignedEnvelopeBatchToPoints(raw, opts = {}) {
  if (!raw || (raw.byteLength ?? raw.length) === 0) return [];
  let batch;
  try {
    batch = fromBinary(SignedEnvelopeBatchSchema, asU8(raw));
  } catch {
    if (opts.verbose) console.warn("[proto] decode failed:", "not-batch");
    return [];
  }
  const points = [];
  for (const env of batch.batch || []) {
    const point = envelopeToPoint(env, opts);
    if (point) points.push(point);
  }
  return points;
}
