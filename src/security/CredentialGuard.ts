export class CredentialGuard {
  private static readonly PLACEHOLDER_PATTERNS: RegExp[] = [
    /^your[-_]/i,
    /^placeholder/i,
    /^change[-_]?me/i,
    /^x{3,}$/i,
    /^<.+>$/,
    /^\${.+}$/,
    /^test$/i,
    /^fake$/i,
    /^dummy/i,
    /^example/i,
    /^todo$/i,
    /^replace/i,
    /^insert/i,
    /^n\/a$/i,
    /^none$/i,
  ];

  static validate(key: string, value: string): { valid: boolean; reason?: string } {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return { valid: false, reason: `"${key}" is empty.` };
    for (const pattern of this.PLACEHOLDER_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { valid: false, reason: `"${key}" appears to be a placeholder: "${trimmed}".` };
      }
    }
    return { valid: true };
  }
}
