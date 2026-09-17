/**
 * Saved Robonomics accounts (login sessions).
 *
 * IndexedDB: `Accounts` → object store `Saved` (keyPath: `address`).
 * Schema: src/config/default/idb-schemas.json
 *
 * Record: { phrase, address, type, devices, ts, persist? }
 *   phrase — encrypted in IDB (plain in memory after load)
 *
 * Legacy (migrated on load, then DB deleted):
 *   `Altruist` → `Accounts` object store
 */
import { ref } from "vue";
import {
  IDBworkflow,
  IDBgettable,
  IDBdeleteByKey,
  notifyDBChange,
  hasIndexedDB,
  migrateDB,
  encryptText,
  decryptText,
} from "../utils/idb";
import { idbschemas, settings } from "@config";
import { fetchJson } from "@/utils/utils";
import { canonicalSensorId } from "@/utils/sensorId";
import { Keyring } from "@polkadot/keyring";
import {
  cryptoWaitReady,
  ed25519PairFromSeed,
  encodeAddress,
  mnemonicToMiniSecret,
} from "@polkadot/util-crypto";

const schema = idbschemas?.Accounts || {};
const DB_NAME = schema.dbname || "Accounts";
const STORE = "Saved";
const SESSION_ACCOUNTS_KEY = "altruist_session_accounts";

/* =============================================================================
 * LEGACY MIGRATION — remove this block when Altruist DB is gone for all users
 * ============================================================================= */
const LEGACY_ACCOUNTS_DB = "Altruist";
const LEGACY_ACCOUNTS_STORE = "Accounts";
let accountsStoreMigrationPromise = null;

async function runAccountsLegacyMigrations() {
  if (!hasIndexedDB()) return;

  await migrateDB({
    fromDB: LEGACY_ACCOUNTS_DB,
    fromStore: LEGACY_ACCOUNTS_STORE,
    toDB: DB_NAME,
    toStore: STORE,
    fromLegacy: true,
    deleteSourceDB: true,
    dedupeKey: "address",
  });
}

function ensureAccountsStoreMigrated() {
  if (!accountsStoreMigrationPromise) {
    accountsStoreMigrationPromise = runAccountsLegacyMigrations().catch((error) => {
      console.warn("Accounts IDB migration failed:", error);
      accountsStoreMigrationPromise = null;
    });
  }
  return accountsStoreMigrationPromise;
}
/* ============================================================================= */

// In-memory cache for getUserSensors to prevent request storms.
const USER_SENSORS_TTL_MS = 15 * 60 * 1000; // 15 minutes
const userSensorsCache = new Map(); // owner -> { ts, data } | { promise }

function uniqueCanonicalSensorIds(ids) {
  return [
    ...new Set((Array.isArray(ids) ? ids : []).map((id) => canonicalSensorId(id)).filter(Boolean)),
  ];
}

/** Sync read of a fresh in-memory getUserSensors result (null if missing or stale). */
export function peekUserSensorsCache(owner) {
  const key = String(owner || "").trim();
  if (!key) return null;
  const cached = userSensorsCache.get(key);
  if (cached?.data && Date.now() - cached.ts < USER_SENSORS_TTL_MS) {
    return uniqueCanonicalSensorIds(cached.data);
  }
  return null;
}

async function fetchOwnerSensorsNetwork(owner) {
  const key = String(owner || "").trim();
  if (!key) return [];

  const base = String(settings.REMOTE_PROVIDER || "").replace(/\/$/, "");

  const parseSensorIds = (payload) => {
    const raw = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.sensors)
        ? payload.sensors
        : [];
    return uniqueCanonicalSensorIds(raw);
  };

  const remember = (data) => {
    userSensorsCache.set(key, { ts: Date.now(), data });
    return data;
  };

  // Roseman v2: owner → device ids
  try {
    const v2Url = `${base}/api/v2/sensor/owner/${encodeURIComponent(key)}`;
    const v2Result = await fetchJson(v2Url, { cache: "default" });
    const v2Data = parseSensorIds(v2Result);
    if (v2Data.length > 0) return remember(v2Data);
  } catch (error) {
    if (!String(error?.message || "").includes("HTTP 404")) {
      console.warn("getUserSensors v2 error:", error);
    }
  }

  // Legacy fallback (older providers)
  const legacyUrl = `${base}/api/sensor/sensors/${encodeURIComponent(key)}`;
  try {
    const legacyResult = await fetchJson(legacyUrl, { cache: "default" });
    const legacyData = parseSensorIds(legacyResult);
    return remember(legacyData);
  } catch (error) {
    if (String(error?.message || "").includes("HTTP 404")) {
      return [];
    }
    throw error;
  }
}

/** Owner device ids: RAM cache (15 min) with in-flight dedup, then network. */
export async function getUserSensorsList(owner, { forceNetwork = false } = {}) {
  const key = String(owner || "").trim();
  if (!key) return [];

  if (!forceNetwork) {
    const mem = peekUserSensorsCache(key);
    if (mem) return mem;
  }

  const cached = userSensorsCache.get(key);
  if (cached?.promise) {
    return cached.promise;
  }

  const promise = fetchOwnerSensorsNetwork(key)
    .catch((error) => {
      console.warn("getUserSensorsList error:", error);
      userSensorsCache.delete(key);
      return [];
    })
    .finally(() => {
      const current = userSensorsCache.get(key);
      if (current?.promise === promise) {
        userSensorsCache.delete(key);
      }
    });

  userSensorsCache.set(key, { promise });
  return promise;
}



const ED25519_SEED_LEN = 32;

function parseSeedHex(raw) {
  const text = String(raw || "")
    .trim()
    .replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(text)) return null;
  const out = new Uint8Array(ED25519_SEED_LEN);
  for (let i = 0; i < ED25519_SEED_LEN; i += 1) {
    out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function accountHasOwnerSecret(account) {
  if (!account || typeof account !== "object") return false;
  const phrase = account.phrase;
  const seedHex = account.seedHex;
  // Encrypted IDB payloads are objects — not usable as secrets in memory.
  if (phrase && typeof phrase === "object") return false;
  if (seedHex && typeof seedHex === "object") return false;
  if (String(phrase || "").trim()) return true;
  if (String(seedHex || "").trim()) return true;
  if (account.seed instanceof Uint8Array && account.seed.length >= ED25519_SEED_LEN) return true;
  return false;
}

export { accountHasOwnerSecret };

/** 32-byte ed25519 seed from a logged-in owner account (mnemonic or imported device seed). */
export async function getOwnerEd25519Seed(address) {
  const addr = String(address || "").trim();
  if (!addr) return null;

  const acc = accounts.value.find((a) => String(a?.address || "").trim() === addr);
  if (!acc || !accountHasOwnerSecret(acc)) return null;
  if (acc.type && String(acc.type).toLowerCase() !== "ed25519") return null;

  if (acc.seed instanceof Uint8Array && acc.seed.length >= ED25519_SEED_LEN) {
    return acc.seed.slice(0, ED25519_SEED_LEN);
  }

  const fromHex = parseSeedHex(acc.seedHex);
  if (fromHex) return fromHex;

  const mnemonic = String(acc.phrase || "").trim();
  if (!mnemonic) return null;

  await cryptoWaitReady();
  const seed = mnemonicToMiniSecret(mnemonic);
  if (seed instanceof Uint8Array && seed.length >= ED25519_SEED_LEN) {
    return seed.slice(0, ED25519_SEED_LEN);
  }

  const keyring = new Keyring({ type: "ed25519", ss58Format: 32 });
  const pair = keyring.addFromMnemonic(mnemonic);
  const secret = pair?.secretKey;
  return secret instanceof Uint8Array && secret.length >= ED25519_SEED_LEN
    ? secret.slice(0, ED25519_SEED_LEN)
    : null;
}

/**
 * Import device self-owner JSON (`altruist-owner1`) or full backup (`altruist-backup1`)
 * and return account fields. Verifies that seed derives the claimed address.
 */
function extractOwnerAccessPayload(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid owner access JSON");
  }
  const isBackupFormat = data.format === "altruist-backup1";
  const looksLikeBackup =
    isBackupFormat ||
    (data.config && typeof data.config === "object" && data.owner && typeof data.owner === "object");
  if (looksLikeBackup) {
    if (data.owner && typeof data.owner === "object") {
      return data.owner;
    }
    if (data.seed && data.address) {
      return data;
    }
    throw new Error("Backup JSON has no owner section");
  }
  if (data.format && data.format !== "altruist-owner1") {
    throw new Error("Unsupported JSON format");
  }
  return data;
}

const NOT_SELF_OWNER_JSON_ERROR = "login.not_self_owner_json";

function assertSelfOwnerJson(data, owner) {
  const address = String(owner?.address || owner?.sensor || "").trim();
  const rwsOwner = String(
    owner?.rws_owner || data?.config?.rws_owner || data?.rws_owner || ""
  ).trim();
  if (rwsOwner && address && rwsOwner !== address) {
    throw new Error(NOT_SELF_OWNER_JSON_ERROR);
  }
}

export async function accountFromOwnerAccessJson(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const owner = extractOwnerAccessPayload(data);
  assertSelfOwnerJson(data, owner);
  const seedHex = String(owner.seed || owner.seedHex || "").trim();
  const claimedAddress = String(owner.address || owner.sensor || "").trim();
  const type = String(owner.type || "ed25519").toLowerCase();
  if (type !== "ed25519") {
    throw new Error("Only ed25519 owner access is supported");
  }
  const seed = parseSeedHex(seedHex);
  if (!seed) {
    throw new Error("Invalid seed in owner access JSON");
  }

  await cryptoWaitReady();
  const pair = ed25519PairFromSeed(seed);
  const address = encodeAddress(pair.publicKey, 32);
  if (claimedAddress && claimedAddress !== address) {
    throw new Error("Seed does not match address in JSON");
  }

  const sensorId = String(
    owner.sensor || owner.address || data?.device?.address || address
  ).trim();

  return {
    phrase: "",
    seedHex: seedHex.replace(/^0x/i, "").toLowerCase(),
    address,
    type: "ed25519",
    devices: sensorId ? [sensorId] : [],
    ts: Date.now(),
  };
}

// Глобальное состояние аккаунтов (разделяется между всеми экземплярами composable)
const accounts = ref([]); // [{ phrase, address, type, devices, ts }]

function readSessionAccounts() {
  try {
    const raw = sessionStorage.getItem(SESSION_ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessionAccounts(list) {
  try {
    if (!Array.isArray(list) || list.length === 0) {
      sessionStorage.removeItem(SESSION_ACCOUNTS_KEY);
      return;
    }
    sessionStorage.setItem(SESSION_ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
  }
}

function isEncryptedPhrasePayload(value) {
  return !!(
    value &&
    typeof value === "object" &&
    Array.isArray(value.ciphertext) &&
    Array.isArray(value.iv) &&
    value.key
  );
}

async function encryptPhraseForStorage(phrase) {
  const text = typeof phrase === "string" ? phrase : "";
  if (!text) return "";
  try {
    return await encryptText(text);
  } catch {
    // Fallback for environments where WebCrypto is unavailable.
    return text;
  }
}

async function decryptPhraseFromStorage(phrase) {
  if (typeof phrase === "string") return phrase;
  if (!isEncryptedPhrasePayload(phrase)) return "";
  try {
    const decrypted = await decryptText(phrase);
    return typeof decrypted === "string" ? decrypted : "";
  } catch {
    return "";
  }
}

async function normalizeAccountsFromStorage(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  return Promise.all(
    list.map(async (acc) => ({
      ...acc,
      phrase: await decryptPhraseFromStorage(acc?.phrase),
      seedHex: await decryptPhraseFromStorage(acc?.seedHex),
    }))
  );
}

function withDefaultDevices(acc) {
  if (!acc || typeof acc !== "object") return acc;
  const devices = Array.isArray(acc.devices)
    ? [...new Set(acc.devices.map((id) => canonicalSensorId(id)).filter(Boolean))]
    : [];
  if (devices.length > 0) return { ...acc, devices };
  const sid = String(acc.address || "").trim();
  const isSeedLogin =
    Boolean(String(acc.seedHex || "").trim()) && !String(acc.phrase || "").trim();
  if (sid && isSeedLogin) return { ...acc, devices: [sid] };
  return { ...acc, devices: [] };
}

export function useAccounts() {
  const addAccount = async (
    { phrase = "", address, type, devices, ts, seedHex = "" },
    { persist = true } = {}
  ) => {
    const idx = accounts.value.findIndex((a) => a.address === address);
    const prev = idx !== -1 ? accounts.value[idx] : null;
    const item = {
      phrase: phrase || prev?.phrase || "",
      seedHex: seedHex || prev?.seedHex || "",
      address,
      type: type || prev?.type,
      devices:
        Array.isArray(devices) && devices.length > 0
          ? devices
          : Array.isArray(prev?.devices)
            ? prev.devices
            : [],
      ts: ts || prev?.ts || Date.now(),
      persist,
    };
    if (idx !== -1) accounts.value[idx] = item;
    else accounts.value.push(item);

    if (persist && hasIndexedDB()) {
      await ensureAccountsStoreMigrated();
      const itemForStorage = {
        ...item,
        phrase: await encryptPhraseForStorage(item.phrase),
        seedHex: await encryptPhraseForStorage(item.seedHex),
        persist: true,
      };
      IDBworkflow(DB_NAME, STORE, "readwrite", (store) => {
        store.put(itemForStorage);
      });
      notifyDBChange(DB_NAME, STORE);
      const session = readSessionAccounts().filter((a) => a.address !== address);
      writeSessionAccounts(session);
    } else {
      const itemForStorage = {
        ...item,
        phrase: await encryptPhraseForStorage(item.phrase),
        seedHex: await encryptPhraseForStorage(item.seedHex),
        persist: false,
      };
      const session = readSessionAccounts().filter((a) => a.address !== address);
      session.push(itemForStorage);
      writeSessionAccounts(session);
    }

    void import("./useSensors").then((mod) => {
      void mod.refreshRealtimeOwnerDecrypt?.();
      queueMicrotask(() => void mod.refreshRealtimeOwnerDecrypt?.());
    });

    return item;
  };

  const removeAccounts = async (addresses) => {
    const list = Array.isArray(addresses) ? addresses : addresses ? [addresses] : [];
    if (list.length === 0) return;

    const toDelete = new Set(list);

    accounts.value = accounts.value.filter((a) => !toDelete.has(a.address));

    const session = readSessionAccounts().filter((a) => !toDelete.has(a.address));
    writeSessionAccounts(session);

    if (hasIndexedDB()) {
      await ensureAccountsStoreMigrated();
      await Promise.all(list.map((addr) => IDBdeleteByKey(DB_NAME, STORE, addr)));
      notifyDBChange(DB_NAME, STORE);
    }
  };

  const getAccounts = async () => {
    const sessionRaw = readSessionAccounts();
    const sessionAccounts = (await normalizeAccountsFromStorage(sessionRaw)).map((acc) => ({
      ...acc,
      persist: false,
    }));

    const sessionHasLegacyPlain = sessionRaw.some(
      (acc) => typeof acc?.phrase === "string" && String(acc.phrase).trim().length > 0
    );
    if (sessionHasLegacyPlain) {
      const migrated = await Promise.all(
        sessionRaw.map(async (acc) => {
          const p = acc?.phrase;
          if (typeof p === "string" && p.trim()) {
            return { ...acc, phrase: await encryptPhraseForStorage(p) };
          }
          return acc;
        })
      );
      writeSessionAccounts(migrated);
    }

    if (!hasIndexedDB()) {
      accounts.value = sessionAccounts.map(withDefaultDevices);
      void import("./useSensors").then((mod) => {
        void mod.refreshRealtimeOwnerDecrypt?.();
        queueMicrotask(() => void mod.refreshRealtimeOwnerDecrypt?.());
      });
      return accounts.value;
    }

    await ensureAccountsStoreMigrated();

    const data = await IDBgettable(DB_NAME, STORE);
    const persistentRaw = Array.isArray(data) ? data : [];
    const persistentAccounts = (await normalizeAccountsFromStorage(persistentRaw)).map((acc) => ({
      ...acc,
      persist: acc?.persist === false ? false : true,
    }));

    const legacyPlain = persistentRaw.filter(
      (acc) => typeof acc?.phrase === "string" && String(acc.phrase).trim().length > 0
    );
    if (legacyPlain.length > 0) {
      for (const acc of legacyPlain) {
        const encryptedPhrase = await encryptPhraseForStorage(acc.phrase);
        IDBworkflow(DB_NAME, STORE, "readwrite", (store) => {
          store.put({ ...acc, phrase: encryptedPhrase });
        });
      }
      notifyDBChange(DB_NAME, STORE);
    }

    const merged = new Map();
    for (const acc of persistentAccounts) merged.set(acc.address, acc);
    for (const acc of sessionAccounts) merged.set(acc.address, acc);
    accounts.value = [...merged.values()].map(withDefaultDevices);
    void import("./useSensors").then((mod) => {
      void mod.refreshRealtimeOwnerDecrypt?.();
      queueMicrotask(() => void mod.refreshRealtimeOwnerDecrypt?.());
    });
    return accounts.value;
  };

  const getUserSensors = async (owner, options) => {
    const key = String(owner || "").trim();
    const fromApi = await getUserSensorsList(key, options);
    const acc = accounts.value.find((a) => String(a?.address || "").trim() === key);
    const local = Array.isArray(acc?.devices)
      ? acc.devices.map((id) => String(id)).filter(Boolean)
      : [];
    if (!fromApi.length) return uniqueCanonicalSensorIds(local);
    return uniqueCanonicalSensorIds([...fromApi, ...local]);
  };

  return {
    accounts,
    addAccount,
    removeAccounts,
    getAccounts,
    getUserSensors,
  };
}
