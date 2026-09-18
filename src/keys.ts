/** Build and parse DataStore keys from a template containing {userId}. */
export class KeyTemplate {
  private readonly regex: RegExp;

  constructor(public readonly template: string) {
    if (!template.includes('{userId}')) throw new Error('key template must contain {userId}');
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{userId\\}', '(-?\\d+)');
    this.regex = new RegExp(`^${escaped}$`);
  }

  build(userId: number | string): string {
    return this.template.replace('{userId}', String(userId));
  }

  /** Returns the user id (negative for Studio test players), or undefined if the key does not match. */
  parse(key: string): number | undefined {
    const m = this.regex.exec(key);
    if (!m || m[1] === undefined) return undefined;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) ? n : undefined;
  }

  /** Literal prefix before {userId}; useful as a list-entries filter. */
  get prefix(): string {
    return this.template.slice(0, this.template.indexOf('{userId}'));
  }
}
