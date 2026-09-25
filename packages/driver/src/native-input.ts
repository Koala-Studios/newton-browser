import { EngineError } from '@newton-browser/core';
import type { CommandContext } from './command-context.ts';
import type { NodeBinding } from './page-directory.ts';
import { keyDescriptor, normalizeKey } from './key-description.ts';

type Params = Record<string, unknown>;
type Held = { route: string; method: string; params: Params };
interface Transport {
  route(binding: NodeBinding): string;
  send(binding: NodeBinding, method: string, params: Params): Promise<unknown>;
  release(route: string, method: string, params: Params): Promise<unknown>;
}
const modifiers: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
/** On macOS, Chromium resolves Command shortcuts through the application menu,
 * which trusted CDP key events never reach; the renderer only performs the
 * editing command when the key event names it. Other platforms bind these
 * shortcuts in the renderer and must not receive duplicate commands. */
const macEditingCommands: Record<string, string> = { 'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste', 'Meta+z': 'undo', 'Meta+Shift+z': 'redo' };
function macEditingCommand(keys: readonly string[], platform: NodeJS.Platform): string | undefined {
  if (platform !== 'darwin') return undefined;
  const normalized = keys.map(normalizeKey), key = normalized.at(-1)!.toLowerCase();
  const held = ['Meta', 'Shift'].filter(modifier => normalized.slice(0, -1).includes(modifier));
  if (held.length !== normalized.length - 1) return undefined;
  return macEditingCommands[[...held, key].join('+')];
}
function describeChord(keys: readonly string[]) {
  const normalized = keys.map(normalizeKey);
  if (!normalized.length || normalized.length > 8 || new Set(normalized).size !== normalized.length
    || normalized.slice(0, -1).some(key => !modifiers[key])) throw new EngineError('invalid_arguments');
  let mask = 0;
  const descriptions = normalized.map(key => {
    mask |= modifiers[key] ?? 0;
    try { return keyDescriptor(key, mask); } catch { throw new EngineError('invalid_arguments'); }
  });
  return { descriptions, mask };
}

/** Action-scoped held input. Cleanup can only release primitives this scope attempted. */
export class NativeInput {
  private readonly held = new Map<string, Held>();
  private readonly context: CommandContext;
  private readonly transport: Transport;
  constructor(context: CommandContext, transport: Transport) { this.context = context; this.transport = transport; }
  get pending(): boolean { return this.held.size > 0; }
  preflight(keys: readonly string[], additionalInputs = 0): void {
    const { descriptions, mask } = describeChord(keys);
    this.context.ensureInputCapacity(additionalInputs + descriptions.length * 2 + (descriptions.at(-1)?.text && !(mask & 7) ? 1 : 0));
  }
  async chord(binding: NodeBinding, keys: readonly string[], beforeInput?: () => Promise<void>, platform: NodeJS.Platform = process.platform): Promise<void> {
    const { descriptions, mask } = describeChord(keys);
    const command = macEditingCommand(keys, platform);
    this.context.ensureInputCapacity(descriptions.length * 2 + (descriptions.at(-1)?.text && !(mask & 7) ? 1 : 0));
    const route = this.transport.route(binding);
    for (const descriptor of descriptions) {
      await beforeInput?.();
      const { text: _text, unmodifiedText: _unmodified, ...key } = descriptor;
      this.context.checkpoint();
      this.held.set(`key:${descriptor.key}`, { route, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...key, modifiers: descriptor.modifiers & ~(modifiers[descriptor.key] ?? 0) } });
      const commands = command && descriptor === descriptions.at(-1) ? { commands: [command] } : {};
      await this.context.input(() => this.transport.send(binding, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, ...commands }));
    }
    const last = descriptions.at(-1)!;
    if (last.text && !(mask & 7)) { await beforeInput?.(); await this.context.input(() => this.transport.send(binding, 'Input.dispatchKeyEvent', { type: 'char', ...last })); }
    for (const descriptor of [...descriptions].reverse()) {
      const held = this.held.get(`key:${descriptor.key}`)!;
      // Key release remains on its original CDP route even if Enter committed a document.
      await this.context.input(() => this.transport.release(held.route, held.method, held.params));
      this.held.delete(`key:${descriptor.key}`);
    }
  }
  async click(binding: NodeBinding, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', clickCount = 1, beforeRepeat?: () => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(clickCount) || clickCount < 1 || clickCount > 3 || !['left', 'right', 'middle'].includes(button)) throw new EngineError('invalid_arguments');
    this.context.ensureInputCapacity(2 * clickCount);
    const route = this.transport.route(binding);
    for (let count = 1; count <= clickCount; count++) {
      if (count > 1) await beforeRepeat?.();
      const id = `mouse:${button}`;
      this.held.set(id, { route, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: count } });
      await this.context.input(() => this.transport.send(binding, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount: count }));
      const held = this.held.get(id)!;
      await this.context.input(() => this.transport.release(held.route, held.method, held.params));
      this.held.delete(id);
    }
  }
  async selectRange(binding:NodeBinding,commands:readonly string[]):Promise<void>{
    const allowed=new Set(['selectAll','moveToBeginningOfDocument','moveToEndOfDocument','moveForward','moveBackward','moveForwardAndModifySelection','moveBackwardAndModifySelection']);
    if(!commands.length||commands.length>4096||commands.some(command=>!allowed.has(command)))throw new EngineError('invalid_arguments');
    this.context.ensureInputCapacity(2);
    const route=this.transport.route(binding),params={type:'keyUp',key:'Unidentified'};
    this.held.set('key:Unidentified',{route,method:'Input.dispatchKeyEvent',params});
    await this.context.input(()=>this.transport.send(binding,'Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Unidentified',commands}));
    await this.context.input(()=>this.transport.release(route,'Input.dispatchKeyEvent',params));
    this.held.delete('key:Unidentified');
  }
  async finish(): Promise<void> {
    if (!this.held.size) return;
    const held = [...this.held.values()].reverse(); this.held.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Start only narrowly authorized release operations; never block the session lane
      // indefinitely on a lost renderer acknowledgement.
      await Promise.race([
        Promise.all(held.map(input => this.transport.release(input.route, input.method, input.params))),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new EngineError('cleanup_uncertain')), 200); }),
      ]);
    } catch { throw new EngineError('cleanup_uncertain'); }
    finally { if (timer) clearTimeout(timer); }
  }
}
