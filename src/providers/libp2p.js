import { agents } from "@config";
import converter from "../measurements";
import { createNode } from "../utils/libp2p";
import {
  decryptMeasurementBag,
  isEncryptedSensorValue,
  mergeMeasurementBags,
  measurementBagsEqual,
} from "../utils/sensorValueCrypto";
import { decodeSignedEnvelopeToPoint, decryptProtoPrivate } from "../utils/proto/decodeEnvelope";
import { useAccounts } from "@/composables/useAccounts";

const topic = "airalab.lighthouse.5.robonomics.eth";
const protoTopic = "sensors.social/v1";

function accountHasSecret(account) {
  return Boolean(
    String(account?.phrase || "").trim() ||
      String(account?.seedHex || "").trim() ||
      (account?.seed instanceof Uint8Array && account.seed.length >= 32)
  );
}

function findOwnerAccount(sensorId, owner) {
  const { accounts } = useAccounts();
  const sid = String(sensorId || "").trim();
  const ownerAddr = owner ? String(owner).trim() : "";
  const acc = accounts.value.find((a) => {
    if (!accountHasSecret(a)) return false;
    const addr = String(a?.address || "").trim();
    if (sid && addr === sid) return true;
    if (ownerAddr && addr === ownerAddr) return true;
    if (
      sid &&
      Array.isArray(a.devices) &&
      a.devices.some((deviceId) => String(deviceId).trim() === sid)
    ) {
      return true;
    }
    return false;
  });
  return acc || (owner ? { address: owner } : null);
}

class Provider {
  constructor(config) {
    this.node = null;
    this.isReady = false;
    this.whiteListAccounts = [];
    this.history = {};
    this.init(config).then(() => {
      this.isReady = true;
    });
  }

  async init(config) {
    this.node = await createNode(config);
    this.whiteListAccounts = agents;
  }

  ready() {
    return new Promise((res) => {
      const t = setInterval(() => {
        if (this.isReady) {
          res();
          clearInterval(t);
        }
      }, 100);
    });
  }

  getHistoryBySensor(sensor) {
    return Promise.resolve(this.history[sensor] || []);
  }

  getHistoryPeriod() {
    return Promise.resolve(this.history);
  }

  async redecryptHistoryForSensor(sensorId, ownerAccount) {
    const sid = String(sensorId || "");
    if (!sid || !Array.isArray(this.history[sid]) || !ownerAccount) return false;

    let changed = false;
    const next = [];
    for (const item of this.history[sid]) {
      if (!item?.data || typeof item.data !== "object") {
        next.push(item);
        continue;
      }
      let nextItem = item;
      try {
        const decryptedMeasurement = await decryptMeasurementBag(sid, item.data, ownerAccount);
        nextItem = { ...item, data: decryptedMeasurement };
      } catch (error) {
        console.warn("Failed to decrypt history measurement:", sid, error);
      }
      if (Array.isArray(nextItem.protoPrivate) && nextItem.protoPrivate.length > 0) {
        try {
          nextItem = await decryptProtoPrivate(nextItem, ownerAccount);
        } catch (error) {
          console.warn("Failed to decrypt proto private history:", sid, error);
        }
      }
      const measurementLowerCase = {};
      for (const key in nextItem.data) {
        const name = key.toLowerCase();
        const raw = nextItem.data[key];
        if (isEncryptedSensorValue(raw)) {
          measurementLowerCase[name] = raw;
          continue;
        }
        measurementLowerCase[name] = converter[name]?.calculate
          ? converter[name].calculate(raw)
          : raw;
      }
      nextItem = { ...nextItem, data: measurementLowerCase };
      if (JSON.stringify(nextItem) !== JSON.stringify(item)) {
        changed = true;
        next.push(nextItem);
      } else {
        next.push(item);
      }
    }
    if (changed) this.history[sid] = next;
    return changed;
  }

  watch(cb) {
    this.node.services.pubsub.subscribe(topic);
    this.node.services.pubsub.subscribe(protoTopic);

    const upsertHistoryPoint = (sensorId, point) => {
      const sid = String(sensorId || "");
      if (!sid) return;
      if (!this.history[sid]) this.history[sid] = [];
      const list = this.history[sid];
      const idx = list.findIndex((item) => item.timestamp === point.timestamp);
      if (idx < 0) {
        list.push(point);
        cb(point);
        return;
      }
      const prev = list[idx];
      const merged = {
        ...prev,
        ...point,
        proto: prev.proto === true || point.proto === true,
        data: mergeMeasurementBags(prev.data, point.data),
        geo: point.geo || prev.geo,
        owner: point.owner || prev.owner,
        device_model: point.device_model || prev.device_model,
        protoPrivate:
          point.protoPrivate === null
            ? null
            : Array.isArray(point.protoPrivate)
              ? point.protoPrivate
              : Array.isArray(prev.protoPrivate)
                ? prev.protoPrivate
                : null,
      };
      const privSame =
        prev.protoPrivate === merged.protoPrivate ||
        (Array.isArray(prev.protoPrivate) &&
          Array.isArray(merged.protoPrivate) &&
          prev.protoPrivate.length === merged.protoPrivate.length);
      if (
        prev.timestamp === merged.timestamp &&
        Boolean(prev.proto) === Boolean(merged.proto) &&
        privSame &&
        measurementBagsEqual(prev.data, merged.data)
      ) {
        return;
      }
      list[idx] = merged;
      cb(merged);
    };

    const handleProto = async (raw, sender = "proto", { warn = true } = {}) => {
      const point = decodeSignedEnvelopeToPoint(raw, { sender, verbose: warn });
      if (!point) return false;
      upsertHistoryPoint(point.sensor_id, point);
      const ownerAccount = findOwnerAccount(point.sensor_id, point.owner);
      const stored = this.history[point.sensor_id]?.find(
        (item) => item.timestamp === point.timestamp
      );
      if (ownerAccount && stored && Array.isArray(stored.protoPrivate) && stored.protoPrivate.length) {
        const unlocked = await decryptProtoPrivate(stored, ownerAccount);
        upsertHistoryPoint(unlocked.sensor_id, unlocked);
      }
      return true;
    };

    const onMessage = async (evt) => {
      const sender = evt.detail.from.toString();
      const raw = evt.detail.data;
      const msgTopic = String(evt.detail.topic || "");

      if (msgTopic === protoTopic || msgTopic.endsWith(protoTopic)) {
        await handleProto(raw, sender);
        return;
      }

      let json;
      try {
        json = JSON.parse(Buffer.from(raw).toString("utf8"));
      } catch {
        await handleProto(raw, sender, { warn: false });
        return;
      }

      // Legacy JSON is trusted only from the configured connectivity agents.
      if (!this.whiteListAccounts.includes(sender)) {
        return;
      }

      for (const sensor_id in json) {
        const data = json[sensor_id];
        if (Object.prototype.hasOwnProperty.call(data, "model")) {
          const { timestamp, ...measurement } = data.measurement;
          const owner = data.owner || undefined;
          let decryptedMeasurement = measurement;
          const ownerAccount = findOwnerAccount(sensor_id, owner);
          if (ownerAccount) {
            try {
              decryptedMeasurement = await decryptMeasurementBag(
                sensor_id,
                measurement,
                ownerAccount
              );
            } catch (error) {
              console.warn("Failed to decrypt pubsub measurement:", sensor_id, error);
            }
          }
          const measurementLowerCase = {};
          for (var key in decryptedMeasurement) {
            const name = key.toLowerCase();
            const rawValue = decryptedMeasurement[key];
            if (isEncryptedSensorValue(rawValue)) {
              measurementLowerCase[name] = rawValue;
              continue;
            }
            measurementLowerCase[name] = converter[name]?.calculate
              ? converter[name].calculate(rawValue)
              : rawValue;
          }
          const [latRaw, lngRaw] = String(data.geo || "").split(",");
          const donated_by = data.donated_by || undefined;
          const device_model = data.device_model || undefined;
          const point = {
            sensor_id,
            sender,
            model: data.model,
            geo: { lat: Number(latRaw), lng: Number(lngRaw) },
            data: measurementLowerCase,
            owner,
            donated_by,
            device_model,
            timestamp,
          };
          upsertHistoryPoint(sensor_id, point);
        }
      }
    };
    this.node.services.pubsub.addEventListener("message", onMessage);
    return () => {
      this.node.services.pubsub.removeEventListener("message", onMessage);
    };
  }
}

export default Provider;
