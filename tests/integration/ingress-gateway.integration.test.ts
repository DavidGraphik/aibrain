import { Duplex } from "node:stream";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const gateway=vi.hoisted(()=>({accept:null as null|((client:unknown)=>void),connect:vi.fn()}));
vi.mock("node:net",()=>({default:{
  createConnection:gateway.connect,
  createServer:(accept:(client:unknown)=>void)=>{
    gateway.accept=accept;
    const server={on:()=>server,listen:()=>server,close:(done:()=>void)=>done()};return server;
  },
}}));

const captureSignals=()=>new Map((["SIGINT","SIGTERM"] as NodeJS.Signals[]).map(signal=>[signal,process.listeners(signal)]));
let addedSignals:ReturnType<typeof captureSignals>;
beforeAll(async()=>{
  const before=captureSignals();
  await import("../../infra/hetzner/ingress/gateway.mts");
  addedSignals=new Map([...before].map(([signal,listeners])=>[signal,process.listeners(signal).filter(listener=>!listeners.includes(listener))]));
});
afterAll(()=>{for(const [signal,listeners] of addedSignals)for(const listener of listeners)process.removeListener(signal,listener);});

class TransportSocket extends Duplex {
  readonly received:Buffer[]=[];
  constructor(private readonly delay=0){super({highWaterMark:1024});}
  setNoDelay(){return this;}
  _read(){}
  _write(chunk:Buffer,_encoding:BufferEncoding,callback:(error?:Error|null)=>void){
    setTimeout(()=>{if(!this.destroyed)this.received.push(Buffer.from(chunk));callback();},this.delay);
  }
}

it("drains the complete final response after a clean upstream close with downstream backpressure",async()=>{
  const client=new TransportSocket(20),upstream=new TransportSocket();gateway.connect.mockReturnValue(upstream);
  const closed=new Promise<void>(resolve=>client.once("close",()=>resolve()));
  gateway.accept!(client);
  // Model a completed HTTP request and a large Connection: close response.
  client.push(Buffer.from("GET /api/threads/synthetic HTTP/1.1\r\n\r\n"));client.push(null);
  const response=Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: 327733\r\nConnection: close\r\n\r\n${"x".repeat(327733)}`);
  upstream.push(response);upstream.push(null);
  await closed;
  expect(Buffer.concat(client.received).equals(response)).toBe(true);
  expect(client.writableFinished).toBe(true);
  expect(gateway.connect).toHaveBeenLastCalledWith({host:"app",port:3000});
});

it("still tears down both directions on transport failure",async()=>{
  const client=new TransportSocket(),upstream=new TransportSocket();gateway.connect.mockReturnValue(upstream);
  gateway.accept!(client);
  upstream.destroy(new Error("synthetic connection reset"));
  await new Promise(resolve=>setImmediate(resolve));
  expect(client.destroyed).toBe(true);expect(upstream.destroyed).toBe(true);
});
