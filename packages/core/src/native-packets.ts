const chunkCharacters = 16 * 1024;
const maxMessageBytes = 4 * 1024 * 1024;
export function* nativePackets(id: string, value: unknown): Generator<unknown> {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > maxMessageBytes) throw new Error("native_message_limit");
  const total = Math.ceil(text.length / chunkCharacters);
  for (let part = 0; part < total; part++) yield { id, part, total, text: text.slice(part * chunkCharacters, (part + 1) * chunkCharacters) };
}
export class NativeAssembly {
  private readonly assemblies = new Map<string, { parts: string[]; total: number; bytes: number; started: number }>();
  private readonly now: () => number;
  constructor(now = () => performance.now()) { this.now = now; }
  accept(raw: unknown): { value: unknown } | undefined {
    this.expire();
    if (!raw || typeof raw !== "object") throw new Error("native_packet_invalid");
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(key => !["id", "part", "total", "text"].includes(key)) || typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)
      || typeof value.text !== "string" || value.text.length > chunkCharacters || !Number.isSafeInteger(value.part) || !Number.isSafeInteger(value.total)
      || Number(value.total) < 1 || Number(value.total) > 256 || Number(value.part) < 0 || Number(value.part) >= Number(value.total)) throw new Error("native_packet_invalid");
    let record = this.assemblies.get(value.id);
    if (!record) {
      if (value.part !== 0 || this.assemblies.size >= 16) throw new Error("native_reassembly_limit");
      record = { parts: [], total: Number(value.total), bytes: 0, started: this.now() }; this.assemblies.set(value.id, record);
    }
    if (value.part !== record.parts.length || value.total !== record.total) throw new Error("native_packet_order");
    record.bytes += new TextEncoder().encode(value.text).length;
    if (record.bytes > maxMessageBytes || [...this.assemblies.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 8 * 1024 * 1024) throw new Error("native_reassembly_limit");
    record.parts.push(value.text);
    if (record.parts.length === record.total) { this.assemblies.delete(value.id); return { value: JSON.parse(record.parts.join("")) }; }
  }
  expire(): void { for (const [id, record] of this.assemblies) if (this.now() - record.started >= 10_000) this.assemblies.delete(id); }
  clear(): void { this.assemblies.clear(); }
}
