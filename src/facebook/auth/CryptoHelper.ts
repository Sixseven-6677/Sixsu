import crypto from "crypto";

const ALGORITHM    = "aes-256-gcm";
const IV_LENGTH    = 12;
const TAG_LENGTH   = 16;
const SALT_LENGTH  = 32;
const KEY_LENGTH   = 32;
const SCRYPT_N     = 16384;
const SCRYPT_R     = 8;
const SCRYPT_P     = 1;

export class CryptoHelper {
  static deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.scrypt(
        password,
        salt,
        KEY_LENGTH,
        { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
        (err, key) => (err ? reject(err) : resolve(key))
      );
    });
  }

  static async encrypt(plaintext: string, password: string): Promise<string> {
    const salt      = crypto.randomBytes(SALT_LENGTH);
    const iv        = crypto.randomBytes(IV_LENGTH);
    const key       = await CryptoHelper.deriveKey(password, salt);
    const cipher    = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag       = cipher.getAuthTag();

    // Layout: salt(32) | iv(12) | tag(16) | ciphertext
    return Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
  }

  static async decrypt(ciphertext: string, password: string): Promise<string> {
    const buf       = Buffer.from(ciphertext, "base64");
    const salt      = buf.subarray(0, SALT_LENGTH);
    const iv        = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag       = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    const key      = await CryptoHelper.deriveKey(password, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  static hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
}
