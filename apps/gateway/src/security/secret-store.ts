import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { registerSecret } from "./secret-redaction.js";

interface Envelope {
  version: 1;
  iv: string;
  ciphertext: string;
  tag: string;
}

const AAD = Buffer.from("everroom-secret-store:v1");

function parseKey(raw: string | undefined): Buffer | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  const key = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("secret_store_master_key_invalid");
  return key;
}

export class SecretStore {
  private readonly key: Buffer | null;
  private readonly values: Record<string, string>;

  constructor(private readonly filePath: string, masterKey = process.env.NXCORE_SECRET_STORE_KEY) {
    this.key = parseKey(masterKey);
    if (!existsSync(filePath)) {
      this.values = {};
      return;
    }
    if (!this.key) {
      // Keep existing ciphertext untouched until secure storage is available again.
      this.values = {};
      return;
    }
    try {
      const envelope = JSON.parse(readFileSync(filePath, "utf8")) as Envelope;
      if (envelope.version !== 1) throw new Error("unsupported version");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      this.values = JSON.parse(plaintext) as Record<string, string>;
      for (const value of Object.values(this.values)) registerSecret(value);
    } catch (error) {
      throw new Error("secret_store_decryption_failed", { cause: error });
    }
  }

  get(name: string): string | undefined {
    return this.values[name];
  }

  isAvailable(): boolean {
    return this.key !== null;
  }

  set(name: string, value: string): void {
    this.update({ [name]: value });
  }

  delete(name: string): void {
    this.update({ [name]: undefined });
  }

  update(changes: Record<string, string | undefined>): void {
    const entries = Object.entries(changes).filter(([name, value]) =>
      value === undefined ? name in this.values : this.values[name] !== value);
    if (entries.length === 0) return;
    if (!this.key) throw new Error("secret_store_unavailable");
    const key = this.key;
    const previous = { ...this.values };
    for (const [name, value] of entries) {
      if (value === undefined) delete this.values[name];
      else {
        this.values[name] = value;
        registerSecret(value);
      }
    }
    try {
      this.persist(key);
    } catch (error) {
      for (const name of Object.keys(this.values)) delete this.values[name];
      Object.assign(this.values, previous);
      throw error;
    }
  }

  private persist(key: Buffer): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.values), "utf8"), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
