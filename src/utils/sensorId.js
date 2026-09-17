import { decodeAddress, encodeAddress, cryptoWaitReady } from "@polkadot/util-crypto";
import { hexToU8a, u8aToHex } from "@polkadot/util";

void cryptoWaitReady().catch(() => {});

/** Pubkey hex, whether the id is 64-char hex or any SS58 prefix. */
export function sensorIdToHex(sensorId) {
  const raw = String(sensorId || "")
    .trim()
    .replace(/^0x/i, "");
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  try {
    const bytes = decodeAddress(raw);
    if (!bytes || bytes.length !== 32) return "";
    return String(u8aToHex(bytes)).replace(/^0x/i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Robonomics SS58 (prefix 32). Re-encodes prefix 42/`5…` ids to `4…`. */
export function sensorIdToSs58(sensorId) {
  const hex = sensorIdToHex(sensorId);
  if (!hex) return "";
  try {
    return encodeAddress(hexToU8a(`0x${hex}`), 32);
  } catch {
    return "";
  }
}

/** Map/UI id: Robonomics SS58 prefix 32. Hex and `5…` become `4…`; other ids stay as-is. */
export function canonicalSensorId(sensorId) {
  const raw = String(sensorId || "").trim();
  if (!raw) return "";
  return sensorIdToSs58(raw) || raw;
}
