// One WebRTC audio leg (werift), for WhatsApp calls: Opus on the wire, PCM16 16 kHz
// (the call host's frames) on our side. Our audio goes out in 20 ms packets at the pace
// a phone line plays it: a mark comes back once the audio queued before it has gone out,
// and `clear` drops what's queued (barge-in) and its marks, as the test phone does.
//   A call to us:   answer(offerSdp) → answer SDP.
//   A call we make: offer() → offer SDP, then accept(answerSdp).
// Nothing goes out before start() (WhatsApp: once the call is accepted) and the
// connection is up; until then our audio waits in the queue.
// Candidates travel in the SDP (no trickle), so both wait for ICE gathering. WhatsApp's
// media servers are ICE-lite with public addresses: our checks go out first, so the
// call works behind Cloud Run's NAT without a TURN server. Cloud Run gives the container a
// link-local address (169.254.8.1), which WebRTC stacks skip by default: we use it.
// While we say nothing, the same silence goes out every 20 ms: after a few frames it's sent
// pre-encoded instead of through the encoder again (most of a call is him talking).

import { RTCPeerConnection, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import type { RTCPeerConnectionConfig, RTCRtpTransceiver } from "werift";
import OpusScript from "opusscript";
import { SAMPLE_RATE } from "../engine/audio.ts";
import type { Log } from "../types/common.ts";

const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE / 1000) * FRAME_MS; // 320
const FRAME_BYTES = FRAME_SAMPLES * 2;
const OPUS_TICKS = (48000 / 1000) * FRAME_MS; // Opus' RTP clock is 48 kHz whatever the audio's rate
const GATHER_MS = 3000;
const QUIET_FRAMES = 3; // silent frames through the encoder (it settles on silence), then the cached packet

const opusCodec = () => new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111, parameters: "minptime=10;useinbandfec=1" });
const u16 = (n: number) => n & 0xffff;
const u32 = (n: number) => n >>> 0;
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Is RTP packet `seq` new after `last` (not a late one, not the same one again)? Sequence numbers wrap at 2^16. */
export function freshSeq(last: number | null, seq: number): boolean {
  if (last === null) return true;
  const ahead = u16(seq - last);
  return ahead !== 0 && ahead <= 0x8000;
}

export interface AudioPeer {
  pc: RTCPeerConnection;
  /** A call to us: their offer → our answer (with our candidates). */
  answer(offerSdp: string): Promise<string>;
  /** A call we make: our offer (with our candidates); their answer goes to accept(). */
  offer(): Promise<string>;
  accept(answerSdp: string): Promise<void>;
  start(): void;
  play(pcm: Buffer): void;
  mark(name: string): void;
  clear(): void;
  readonly state: RTCPeerConnection["connectionState"];
  close(): Promise<void>;
}

export interface AudioPeerOptions {
  stun?: string[];
  onAudio?: (pcm: Buffer) => void;
  onMark?: (name: string) => void;
  onState?: (state: RTCPeerConnection["connectionState"]) => void;
  log?: Log;
  /** Tests: { iceLite: true } plays WhatsApp's side. */
  rtc?: RTCPeerConnectionConfig;
}

export function createAudioPeer({ stun = ["stun:stun.cloudflare.com:3478"], onAudio = () => {}, onMark = () => {}, onState = () => {}, log = () => {}, rtc = {} }: AudioPeerOptions = {}): AudioPeer {
  const pc = new RTCPeerConnection({
    codecs: { audio: [opusCodec()] },
    iceServers: stun.map(urls => ({ urls })),
    iceUseIpv6: false, // Cloud Run has no IPv6 out
    iceUseLinkLocalAddress: true, // Cloud Run's container address is link-local (169.254.8.1)
    bundlePolicy: "max-bundle",
    ...rtc, // tests: { iceLite: true } plays WhatsApp's side
  });
  const decoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  const encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  const silence = Buffer.alloc(FRAME_BYTES);
  let transceiver: RTCRtpTransceiver | null = null;
  let closed = false;

  // ---------- in: RTP → PCM ----------
  let lastSeq: number | null = null;
  let heard = false;
  function receive(rtp: RtpPacket): void {
    if (!heard) { heard = true; log(`webrtc: first audio in (pt ${rtp.header.payloadType}, opus ${opusPt()}, ${rtp.payload.length} bytes)`); }
    if (closed || rtp.header.payloadType !== opusPt()) return; // telephone-event etc.
    const seq = rtp.header.sequenceNumber;
    if (!freshSeq(lastSeq, seq)) return; // late, or a duplicate: decoded once
    lastSeq = seq;
    let pcm: Buffer;
    try { pcm = decoder.decode(rtp.payload); } catch (err) { log("opus decode", errText(err)); return; }
    if (pcm?.length) onAudio(Buffer.from(pcm));
  }
  const opusPt = () => transceiver?.codecs?.find(c => /opus/i.test(c.mimeType))?.payloadType ?? 111;
  function watch(t: RTCRtpTransceiver): void {
    transceiver = t;
    t.setDirection("sendrecv");
    t.onTrack.subscribe(track => track.onReceiveRtp.subscribe(receive));
  }

  // ---------- out: queue → paced RTP ----------
  let queue: (Buffer | { mark: string })[] = []; // PCM, and marks between it
  let pending: Buffer = Buffer.alloc(0);
  let seq = Math.floor(Math.random() * 0xffff);
  let ts = Math.floor(Math.random() * 0xffffffff);
  let started = 0;
  let sent = 0;
  let pump: ReturnType<typeof setInterval> | null = null;
  let go = false;
  let quiet = 0; // silent frames in a row
  let silencePacket: Buffer | null = null; // the encoder's packet for silence, once it has settled

  function nextFrame(): Buffer {
    while (pending.length < FRAME_BYTES && queue.length) {
      const item = queue[0];
      if (Buffer.isBuffer(item)) { pending = pending.length ? Buffer.concat([pending, item]) : item; queue.shift(); continue; }
      if (pending.length) break; // the audio before the mark goes out first
      queue.shift();
      onMark(item.mark);
    }
    if (!pending.length) return silence;
    if (pending.length < FRAME_BYTES) { const f = Buffer.concat([pending, silence.subarray(pending.length)]); pending = Buffer.alloc(0); return f; }
    const f = pending.subarray(0, FRAME_BYTES);
    pending = pending.subarray(FRAME_BYTES);
    return f;
  }
  function encode(pcm: Buffer): Buffer | null {
    quiet = pcm === silence ? quiet + 1 : 0;
    if (quiet > QUIET_FRAMES && silencePacket) return silencePacket;
    try {
      const payload = Buffer.from(encoder.encode(pcm, FRAME_SAMPLES));
      if (quiet === QUIET_FRAMES) silencePacket ??= payload;
      return payload;
    } catch (err) { log("opus encode", errText(err)); return null; }
  }
  function sendFrame(pcm: Buffer): void {
    const sender = transceiver?.sender;
    if (!sender) return;
    const payload = encode(pcm);
    if (!payload) return;
    const header = new RtpHeader({ payloadType: opusPt(), sequenceNumber: seq, timestamp: ts, marker: false });
    seq = u16(seq + 1);
    ts = u32(ts + OPUS_TICKS);
    sender.sendRtp(new RtpPacket(header, payload)).catch(() => {});
  }
  function tick(): void {
    // Clock-driven: timers drift, the audio mustn't. Behind by more than a second? Skip ahead.
    const due = Math.floor((performance.now() - started) / FRAME_MS);
    if (due - sent > 50) sent = due - 1;
    while (sent < due) { sendFrame(nextFrame()); sent++; }
  }
  function startPump(): void {
    if (pump || closed || !go || pc.connectionState !== "connected") return;
    started = performance.now();
    sent = 0;
    pump = setInterval(tick, 10);
  }

  pc.iceConnectionStateChange.subscribe(state => log(`webrtc: ice ${state}`));
  pc.connectionStateChange.subscribe(state => {
    onState(state);
    startPump();
  });

  async function gathered(): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pc.iceGatheringStateChange.watch(s => s === "complete"), new Promise(r => { timer = setTimeout(r, GATHER_MS); })]);
    clearTimeout(timer);
  }
  function localSdp(): string {
    if (!pc.localDescription) throw new Error("webrtc: no local description");
    return pc.localDescription.sdp;
  }

  return {
    pc,
    async answer(offerSdp) {
      pc.onTransceiverAdded.subscribe(watch);
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      if (!transceiver) watch(pc.getTransceivers()[0]);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered();
      return localSdp();
    },
    async offer() {
      watch(pc.addTransceiver("audio", { direction: "sendrecv" }));
      await pc.setLocalDescription(await pc.createOffer());
      await gathered();
      return localSdp();
    },
    async accept(answerSdp) {
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    },
    start() { go = true; startPump(); },
    play(pcm) { if (!closed && pcm?.length) queue.push(pcm); },
    mark(name) { if (!closed) queue.push({ mark: name }); },
    clear() { queue = []; pending = Buffer.alloc(0); },
    get state() { return pc.connectionState; },
    async close() {
      if (closed) return;
      closed = true;
      if (pump) clearInterval(pump);
      queue = [];
      await pc.close().catch(() => {});
      for (const c of [decoder, encoder]) try { c.delete(); } catch {}
    },
  };
}
