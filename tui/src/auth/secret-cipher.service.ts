import { Injectable, Optional } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ATLAS_PATHS } from "../domain/paths.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce, the GCM standard
const TAG_LEN = 16;

@Injectable()
export class SecretCipherService {
  private key?: Buffer;

  /**
   * The key file, defaulted rather than injected: Nest constructs this with no arguments and gets
   * `~/.atlas/key`, while a test can point it at a temp dir. `ATLAS_PATHS` is read at module load,
   * so a test that moved `HOME` would otherwise be writing to the developer's REAL key file.
   *
   * `@Optional()` is load-bearing: `emitDecoratorMetadata` records the parameter as `String`, and
   * without it Nest tries to inject a `String` provider and the whole container fails to build. A
   * default value is invisible to the injector.
   */
  constructor(@Optional() private readonly keyFile: string = ATLAS_PATHS.key) {}

  encrypt(plain: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.loadKey(), iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
  }

  decrypt(blob: string): string {
    const parts = blob.split(".");
    if (parts.length !== 3)
      throw new Error("malformed encrypted blob (expected iv.tag.ct)");
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
      throw new Error("malformed encrypted blob (bad iv/tag length)");
    }
    const decipher = createDecipheriv(ALGO, this.loadKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8",
    );
  }

  /** Read the key, creating it on first use. Cached — this is on the per-turn path. */
  private loadKey(): Buffer {
    if (this.key) return this.key;
    mkdirSync(dirname(this.keyFile), { recursive: true });
    let raw: string;
    try {
      raw = readFileSync(this.keyFile, "utf8").trim();
    } catch {
      raw = randomBytes(32).toString("hex");
      writeFileSync(this.keyFile, `${raw}\n`, { mode: 0o600 });
    }
    // Re-assert the mode: an older key, or one restored from a backup, may be world-readable.
    chmodSync(this.keyFile, 0o600);

    const key = Buffer.from(raw, "hex");
    if (key.length !== 32) {
      throw new Error(
        `${this.keyFile} must be 64 hex chars (32 bytes); got ${key.length} bytes`,
      );
    }
    this.key = key;
    return key;
  }
}
