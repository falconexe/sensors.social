import { gcm } from "@noble/ciphers/aes.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "sensors-social-noble-curves/ed25519.js";
import { hkdf } from "sensors-social-noble-hashes/hkdf.js";
import { sha256 } from "sensors-social-noble-hashes/sha2.js";

export const AESGCM256_ALGORITHM = "aesgcm256";
export const AESGCM_NONCE_SIZE = 12;
export const AESGCM_TAG_SIZE = 16;

export const XCHACHA20POLY1305_ALGORITHM = "xchacha20poly1305";
export const XCHACHA20POLY1305_NONCE_SIZE = 24;
export const XCHACHA20POLY1305_TAG_SIZE = 16;

const HKDF_SALT = new TextEncoder().encode("robonomics-network");

function deriveSharedSecretEd25519(secretKey, receiverPublic) {
  if (secretKey.length !== 32) {
    throw new Error("Secret key must be 32 bytes");
  }
  if (receiverPublic.length !== 32) {
    throw new Error("Public key must be 32 bytes");
  }
  return x25519.getSharedSecret(
    ed25519.utils.toMontgomerySecret(secretKey),
    ed25519.utils.toMontgomery(receiverPublic)
  );
}

function deriveKeyFromECDH(localSecret, remotePublic, algorithm) {
  const infoBuffer = new TextEncoder().encode(algorithm);
  return hkdf(sha256, deriveSharedSecretEd25519(localSecret, remotePublic), HKDF_SALT, infoBuffer, 32);
}

export function decryptAesGcm256(ciphertext, nonce, senderPublicKey, receiverSecretKey) {
  if (nonce.length !== AESGCM_NONCE_SIZE) {
    throw new Error(`Nonce must be ${AESGCM_NONCE_SIZE} bytes`);
  }
  if (ciphertext.length < AESGCM_TAG_SIZE) {
    throw new Error("Ciphertext too short to contain auth tag");
  }
  return gcm(
    deriveKeyFromECDH(receiverSecretKey, senderPublicKey, AESGCM256_ALGORITHM),
    nonce
  ).decrypt(ciphertext);
}

export function decryptXChaCha20Poly1305(ciphertext, nonce, senderPublicKey, receiverSecretKey) {
  if (nonce.length !== XCHACHA20POLY1305_NONCE_SIZE) {
    throw new Error(`Nonce must be ${XCHACHA20POLY1305_NONCE_SIZE} bytes`);
  }
  if (ciphertext.length < XCHACHA20POLY1305_TAG_SIZE) {
    throw new Error("Ciphertext too short to contain auth tag");
  }
  return xchacha20poly1305(
    deriveKeyFromECDH(receiverSecretKey, senderPublicKey, XCHACHA20POLY1305_ALGORITHM),
    nonce
  ).decrypt(ciphertext);
}
