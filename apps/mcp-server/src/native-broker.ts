import net from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { NativeChannel } from "./native-wire.ts";

/** Chrome-launched, port-owned private IPC. It is never installed as a daemon. */
export async function startNativeBroker(directory: string, input: Readable, output: Writable) {
  const root = await fs.realpath(directory);
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("native_directory_invalid");
  // Installer restricts this directory to the current OS user. The capability is never sent to Chrome or the model.
  const token = randomBytes(32).toString("hex"); const epoch = randomUUID();
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\newton-browser-${epoch}` : path.join(root, `socket-${epoch}`);
  const connections = new Map<string, NativeChannel>();
  const requests=new Map<string,Set<number>>();
  let disposed = false;
  let advertised=false;
  const advertisement = path.join(root, `connection-${epoch}.json`);
  const stagedAdvertisement=advertisement+'.stage';
  let hello: Record<string, unknown> | undefined;
  let acceptHello!:()=>void,rejectHello!:(error:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{acceptHello=resolve;rejectHello=reject;});
  void ready.catch(()=>{});
  let rejectClosed!:(error:Error)=>void;
  const closed=new Promise<never>((_resolve,reject)=>{rejectClosed=reject;});void closed.catch(()=>{});
  const startupTimer=setTimeout(()=>{void close(new Error('native_handshake_timeout'));},5000);
  let server:net.Server|undefined;
  const native = new NativeChannel(input, output, raw => {
    const message = raw as Record<string, unknown>;
    if (message.type === "hello") {
      if(hello||message.protocolMajor!==1||typeof message.epoch!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(message.epoch)||typeof message.digest!=='string'||!/^[a-f0-9]{64}$/.test(message.digest)){
        void close(new Error('native_protocol_mismatch'));return;
      }
      hello = message;acceptHello();return;
    }
    if (typeof message.connectionId !== "string") return;
    const client = connections.get(message.connectionId);
    if(client){
      const payload=message.payload as Record<string,unknown>|undefined;
      if(payload?.type==='response'&&(!Number.isSafeInteger(payload.id)||!requests.get(message.connectionId)?.delete(Number(payload.id)))){client.close();return;}
      void client.send(message.payload).catch(()=>client.close());
    }
  }, () => { void close(); });
  server = net.createServer(socket => {
    if (disposed || connections.size >= 16) { socket.destroy(); return; }
    const connectionId = randomUUID(); let authenticated = false; let opened = false;const inFlight=new Set<number>();requests.set(connectionId,inFlight);
    const releaseOwner=()=>{
      clearTimeout(timer);connections.delete(connectionId);requests.delete(connectionId);
      if(opened){opened=false;void native.send({type:'close',connectionId}).catch(()=>{});}
    };
    const timer = setTimeout(() => socket.destroy(), 3000);
    const client = new NativeChannel(socket, socket, raw => {
      const message = raw as Record<string, unknown>;
      if (!authenticated) {
        if (message.type !== "connect" || message.protocolMajor !== 1 || typeof message.token !== "string"
          || message.token.length !== token.length || !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))) { client.close(); return; }
        authenticated = true; clearTimeout(timer);
        if (!hello || hello.protocolMajor !== 1) { client.close(); return; }
        opened = true;
        void native.send({ type: "open", connectionId }).then(() => client.send({ type: "connected", ...hello, brokerEpoch: epoch })).catch(() => client.close());
        return;
      }
      // Caller cannot select another owner, native destination or authority operation.
      if (message.type !== "request" || !Number.isSafeInteger(message.id) || Number(message.id) <= 0 || inFlight.size >= 64||inFlight.has(Number(message.id))) { client.close(); return; }
      inFlight.add(Number(message.id));
      void native.send({ type: "request", connectionId, request: message }).catch(() => client.close());
    }, releaseOwner);
    connections.set(connectionId, client);
    socket.on("close",releaseOwner);
  });
  try{
    await Promise.race([new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(endpoint, resolve); }),closed]);
    await ready;
    if(disposed)throw new Error('connection_lost');
    await fs.writeFile(stagedAdvertisement, JSON.stringify({ version: 1, endpoint, token, epoch, pid: process.pid }), { flag: "wx", mode: 0o600 });
    if(disposed){await fs.unlink(stagedAdvertisement).catch(()=>{});throw new Error('connection_lost');}
    await fs.rename(stagedAdvertisement,advertisement);
    advertised=true;
    if(disposed){await fs.unlink(advertisement).catch(()=>{});throw new Error('connection_lost');}
    await native.send({ type: "broker_ready" });
  }catch(error){await close();await fs.unlink(stagedAdvertisement).catch(()=>{});throw error;}finally{clearTimeout(startupTimer);}
  async function close(reason=new Error('connection_lost')): Promise<void> {
    if (disposed) {server?.close();return;} disposed = true;
    clearTimeout(startupTimer);rejectHello(reason);rejectClosed(reason);
    connections.forEach(client => client.close()); connections.clear();requests.clear(); native.close(); server?.close();
    if(advertised)await fs.unlink(advertisement).catch(() => undefined);
  }
  return { advertisement, close };
}
